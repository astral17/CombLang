import {
  BlueprintImportAnalysisError,
  type BlueprintImportAnalysis,
} from '@comblang/blueprint/import-analysis';
import { DEFAULT_BLUEPRINT_CODEC_LIMITS } from '@comblang/blueprint/limits';
import {
  LosslessJsonArray,
  LosslessJsonNumber,
  LosslessJsonObject,
  type LosslessJsonValue,
} from '@comblang/blueprint/document';
import type { NetworkId, SourceSpan } from '@comblang/shared';
import { sourceFileId, sourceSpan } from '@comblang/shared';

import {
  analyzeCanonicalBlueprintImport,
  type CanonicalBlueprintImportDiagnostic,
  type CanonicalBlueprintImportEntity,
} from './blueprint-import-canonical-families.js';
import {
  createBlueprintArithmeticExpressionPrinter,
  createBlueprintDeciderExpressionPrinter,
  createBlueprintSelectorExpressionPrinter,
  printBlueprintConstantExpression,
} from './blueprint-import-source.js';
import type {
  ArithmeticProducerConfig,
  DeciderProducerConfig,
  LogicalDeciderCondition,
  SelectorProducerConfig,
} from './ir.js';
import type { BlueprintImportProfileMappingEntry } from './blueprint-import-profile-mappings.js';
import type { TrustedEntityReplayContext } from './entity-replay-context.js';

export interface GenerateCanonicalBlueprintSourceOptions {
  readonly path: string;
  readonly signal?: AbortSignal;
  readonly maxEndpoints?: number;
  readonly maxSourceBytes?: number;
}

export interface BlueprintSourceAssemblyDiagnostic {
  readonly category:
    | 'unsupported-source-field'
    | 'unsupported-source-placement'
    | 'unsupported-source-configuration';
  readonly message: string;
  readonly path: string;
  readonly entityNumber?: number;
}

export interface BlueprintSourceRetainedMetadataNotice {
  readonly path: string;
  readonly message: string;
}

export interface BlueprintSourceNetworkCorrespondence {
  readonly network: NetworkId;
  readonly name: string;
  readonly declarationSpan: SourceSpan;
}

export interface BlueprintSourceEntityCorrespondence {
  readonly entityNumber: number;
  readonly path: string;
  readonly name: string;
  readonly family: 'constant' | 'arithmetic' | 'decider' | 'selector';
  readonly constructionSpan: SourceSpan;
  readonly placementSpan: SourceSpan;
  readonly attachmentSpans: readonly SourceSpan[];
}

export interface BlueprintSourceCorrespondence {
  readonly networks: readonly BlueprintSourceNetworkCorrespondence[];
  readonly entities: readonly BlueprintSourceEntityCorrespondence[];
}

export type CanonicalBlueprintSourceDiagnostic =
  CanonicalBlueprintImportDiagnostic | BlueprintSourceAssemblyDiagnostic;

export interface CompleteCanonicalBlueprintSource {
  readonly state: 'complete';
  readonly analysis: BlueprintImportAnalysis;
  readonly source: Readonly<{ path: string; text: string }>;
  readonly correspondence: BlueprintSourceCorrespondence;
  readonly diagnostics: readonly [];
  readonly retainedMetadata: readonly BlueprintSourceRetainedMetadataNotice[];
}

export interface BlockedCanonicalBlueprintSource {
  readonly state: 'blocked';
  readonly analysis: BlueprintImportAnalysis;
  readonly source: undefined;
  readonly correspondence: undefined;
  readonly diagnostics: readonly CanonicalBlueprintSourceDiagnostic[];
  readonly retainedMetadata: readonly BlueprintSourceRetainedMetadataNotice[];
}

export type CanonicalBlueprintSourceResult =
  CompleteCanonicalBlueprintSource | BlockedCanonicalBlueprintSource;

interface ResolvedOptions {
  readonly path: string;
  readonly signal: AbortSignal | undefined;
  readonly maxEndpoints: number | undefined;
  readonly maxSourceBytes: number;
}

interface Placement {
  readonly entityNumber: number;
  readonly path: string;
  readonly x: number;
  readonly y: number;
  readonly direction: number;
}

const allowedOptionNames = new Set(['path', 'signal', 'maxEndpoints', 'maxSourceBytes']);
const allowedRootNames = new Set([
  'entities',
  'wires',
  'item',
  'version',
  'label',
  'icons',
  'description',
]);
const retainedRootNames = ['item', 'version', 'label', 'icons', 'description'] as const;
const allowedEntityNames = new Set([
  'entity_number',
  'name',
  'position',
  'direction',
  'control_behavior',
]);
const coordinateNames = ['x', 'y'] as const;
const utf8Encoder = new TextEncoder();
const identifierKeyPattern = /^[A-Za-z_$][\w$]*(?![\s\S])/;

function positiveSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function resolveOptions(options: GenerateCanonicalBlueprintSourceOptions): ResolvedOptions {
  if (
    typeof options !== 'object' ||
    options === null ||
    Array.isArray(options) ||
    (Object.getPrototypeOf(options) !== Object.prototype && Object.getPrototypeOf(options) !== null)
  ) {
    throw new TypeError('Blueprint source assembly options must be a plain object.');
  }

  let path: string | undefined;
  let signal: AbortSignal | undefined;
  let maxEndpoints: number | undefined;
  let maxSourceBytes = DEFAULT_BLUEPRINT_CODEC_LIMITS.maxEmittedBytes;
  for (const key of Reflect.ownKeys(options)) {
    if (typeof key !== 'string' || !allowedOptionNames.has(key)) {
      throw new TypeError(`Unknown blueprint source assembly option: ${String(key)}.`);
    }
    const descriptor = Object.getOwnPropertyDescriptor(options, key);
    if (descriptor === undefined || !('value' in descriptor)) {
      throw new TypeError(`Blueprint source assembly option ${key} must be a data property.`);
    }
    if (key === 'path') {
      if (
        typeof descriptor.value !== 'string' ||
        descriptor.value.length === 0 ||
        descriptor.value.includes('\0')
      ) {
        throw new TypeError('path must be a nonempty string without NUL.');
      }
      path = descriptor.value;
    } else if (key === 'maxEndpoints') {
      if (descriptor.value !== undefined && !positiveSafeInteger(descriptor.value)) {
        throw new RangeError('maxEndpoints must be a positive safe integer.');
      }
      maxEndpoints = descriptor.value as number | undefined;
    } else if (key === 'maxSourceBytes') {
      if (!positiveSafeInteger(descriptor.value)) {
        throw new RangeError('maxSourceBytes must be a positive safe integer.');
      }
      maxSourceBytes = descriptor.value;
    } else if (descriptor.value !== undefined) {
      const candidate: unknown = descriptor.value;
      if (
        typeof candidate !== 'object' ||
        candidate === null ||
        typeof (candidate as AbortSignal).aborted !== 'boolean'
      ) {
        throw new TypeError('signal must be an AbortSignal.');
      }
      signal = candidate as AbortSignal;
    }
  }
  if (path === undefined) throw new TypeError('path is required.');
  return { path, signal, maxEndpoints, maxSourceBytes };
}

function checkAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new BlueprintImportAnalysisError(
      'BPI1002',
      'Canonical blueprint source assembly was cancelled.',
    );
  }
}

function keyPath(path: string, key: string): string {
  return identifierKeyPattern.test(key) ? `${path}.${key}` : `${path}[${JSON.stringify(key)}]`;
}

function sourceDiagnostic(
  category: BlueprintSourceAssemblyDiagnostic['category'],
  path: string,
  message: string,
  entityNumber?: number,
): BlueprintSourceAssemblyDiagnostic {
  return Object.freeze({
    category,
    path,
    message,
    ...(entityNumber === undefined ? {} : { entityNumber }),
  });
}

function retainedMetadata(
  analysis: BlueprintImportAnalysis,
  signal: AbortSignal | undefined,
): readonly BlueprintSourceRetainedMetadataNotice[] {
  if (analysis.kind !== 'blueprint') return Object.freeze([]);
  const root = analysis.document.get('blueprint');
  if (!(root instanceof LosslessJsonObject)) return Object.freeze([]);
  const notices: BlueprintSourceRetainedMetadataNotice[] = [];
  for (const key of retainedRootNames) {
    checkAborted(signal);
    if (root.get(key) !== undefined) {
      notices.push(
        Object.freeze({
          path: `$.blueprint.${key}`,
          message: 'Retained in the original lossless document; not emitted as source.',
        }),
      );
    }
  }
  return Object.freeze(notices);
}

function exactFiniteNumber(value: LosslessJsonValue | undefined): number | undefined {
  if (!(value instanceof LosslessJsonNumber)) return undefined;
  const number = value.toNumberIfExact();
  return number !== undefined && Number.isFinite(number) ? number : undefined;
}

function validateOuterCoverage(
  analysis: BlueprintImportAnalysis,
  signal: AbortSignal | undefined,
): {
  readonly diagnostics: readonly BlueprintSourceAssemblyDiagnostic[];
  readonly placements: readonly Placement[];
} {
  const diagnostics: BlueprintSourceAssemblyDiagnostic[] = [];
  const placements: Placement[] = [];
  if (analysis.kind !== 'blueprint') return { diagnostics, placements };

  const rootValue = analysis.document.get('blueprint');
  if (!(rootValue instanceof LosslessJsonObject)) return { diagnostics, placements };
  const rootPath = '$.blueprint';
  for (const [key] of rootValue.entries) {
    checkAborted(signal);
    if (!allowedRootNames.has(key)) {
      diagnostics.push(
        sourceDiagnostic(
          'unsupported-source-field',
          keyPath(rootPath, key),
          `Blueprint root field ${key} is outside the literal-source subset and was retained only in the original document.`,
        ),
      );
    }
  }

  const rawEntities = rootValue.get('entities');
  if (!(rawEntities instanceof LosslessJsonArray)) return { diagnostics, placements };
  const inventoryByPath = new Map<
    string,
    NonNullable<BlueprintImportAnalysis['entities']>[number]
  >();
  for (const entity of analysis.entities ?? []) {
    checkAborted(signal);
    if (!inventoryByPath.has(entity.path)) inventoryByPath.set(entity.path, entity);
  }
  for (let index = 0; index < rawEntities.items.length; index += 1) {
    checkAborted(signal);
    const node = rawEntities.items[index];
    if (!(node instanceof LosslessJsonObject)) continue;
    const path = `${rootPath}.entities[${index}]`;
    const inventoryEntity = inventoryByPath.get(path);
    const rawEntityNumber = node.get('entity_number');
    const rawNumber =
      rawEntityNumber instanceof LosslessJsonNumber ? rawEntityNumber.toNumberIfExact() : undefined;
    const entityNumber =
      inventoryEntity?.entityNumber ??
      (rawNumber !== undefined && Number.isSafeInteger(rawNumber) && rawNumber > 0
        ? rawNumber
        : undefined);
    for (const [key] of node.entries) {
      checkAborted(signal);
      if (!allowedEntityNames.has(key)) {
        diagnostics.push(
          sourceDiagnostic(
            'unsupported-source-field',
            keyPath(path, key),
            `Entity field ${key} is outside the literal-source subset and was retained only in the original document.`,
            entityNumber,
          ),
        );
      }
    }

    const positionPath = `${path}.position`;
    const positionValue = node.get('position');
    let valid = true;
    let x: number | undefined;
    let y: number | undefined;
    if (!(positionValue instanceof LosslessJsonObject)) {
      diagnostics.push(
        sourceDiagnostic(
          'unsupported-source-placement',
          positionPath,
          'A lossless position object containing exactly x and y is required.',
          entityNumber,
        ),
      );
      valid = false;
    } else {
      for (const [key] of positionValue.entries) {
        checkAborted(signal);
        if (!(coordinateNames as readonly string[]).includes(key)) {
          diagnostics.push(
            sourceDiagnostic(
              'unsupported-source-placement',
              keyPath(positionPath, key),
              `Position field ${key} is outside the exact x/y placement subset.`,
              entityNumber,
            ),
          );
          valid = false;
        }
      }
      const coordinateValues: Record<(typeof coordinateNames)[number], number | undefined> = {
        x: undefined,
        y: undefined,
      };
      for (const coordinate of coordinateNames) {
        checkAborted(signal);
        const coordinateValue = positionValue.get(coordinate);
        const exact = exactFiniteNumber(coordinateValue);
        if (exact === undefined) {
          diagnostics.push(
            sourceDiagnostic(
              'unsupported-source-placement',
              `${positionPath}.${coordinate}`,
              `Position coordinate ${coordinate} must have a finite exactly representable numeric value.`,
              entityNumber,
            ),
          );
          valid = false;
        } else {
          coordinateValues[coordinate] = exact;
        }
      }
      x = coordinateValues.x;
      y = coordinateValues.y;
    }

    const directionValue = node.get('direction');
    const exactDirection = directionValue === undefined ? 0 : exactFiniteNumber(directionValue);
    if (
      exactDirection === undefined ||
      !Number.isInteger(exactDirection) ||
      exactDirection < 0 ||
      exactDirection > 15
    ) {
      diagnostics.push(
        sourceDiagnostic(
          'unsupported-source-placement',
          `${path}.direction`,
          'Direction must be an exactly representable integer from 0 through 15 when present.',
          entityNumber,
        ),
      );
      valid = false;
    }
    if (
      valid &&
      inventoryEntity !== undefined &&
      x !== undefined &&
      y !== undefined &&
      exactDirection !== undefined
    ) {
      placements.push(
        Object.freeze({
          entityNumber: inventoryEntity.entityNumber,
          path,
          x,
          y,
          direction: exactDirection,
        }),
      );
    }
  }
  return { diagnostics: Object.freeze(diagnostics), placements: Object.freeze(placements) };
}

function numericLiteral(value: number): string {
  return Object.is(value, -0) ? '-0' : String(value);
}

class BoundedSourceBuilder {
  readonly #parts: string[] = [];
  readonly #maxBytes: number;
  #bytes = 0;
  #offset = 0;

  constructor(maxBytes: number) {
    this.#maxBytes = maxBytes;
  }

  get offset(): number {
    return this.#offset;
  }

  append(value: string): void {
    const bytes = utf8Encoder.encode(value).byteLength;
    if (bytes > this.#maxBytes - this.#bytes) {
      throw new RangeError(`Generated source exceeds maxSourceBytes (${this.#maxBytes}).`);
    }
    this.#parts.push(value);
    this.#bytes += bytes;
    this.#offset += value.length;
  }

  appendLine(value: string): void {
    this.append(value);
    this.append('\n');
  }

  span(fileId: SourceSpan['fileId'], start: number): SourceSpan {
    return Object.freeze(sourceSpan(fileId, start, this.#offset));
  }

  finish(): string {
    return this.#parts.join('');
  }
}

function constructorExpression(
  entity: CanonicalBlueprintImportEntity,
  arithmeticPrinter: ((configuration: ArithmeticProducerConfig) => string) | undefined,
  deciderPrinter: ((configuration: DeciderProducerConfig) => string) | undefined,
  selectorPrinter: ((configuration: SelectorProducerConfig) => string) | undefined,
): string {
  if (entity.family === 'constant') return printBlueprintConstantExpression(entity.configuration);
  if (entity.family === 'arithmetic') {
    if (arithmeticPrinter === undefined) {
      throw new Error('Arithmetic source printer was not prepared for an Arithmetic entity.');
    }
    return arithmeticPrinter(entity.configuration);
  }
  if (entity.family === 'decider') {
    if (deciderPrinter === undefined) {
      throw new Error('Decider source printer was not prepared for a Decider entity.');
    }
    return deciderPrinter(entity.configuration);
  }
  if (selectorPrinter === undefined) {
    throw new Error('Selector source printer was not prepared for a Selector entity.');
  }
  return selectorPrinter(entity.configuration);
}

function selectorRepresentabilityRefusal(
  entity: Extract<CanonicalBlueprintImportEntity, { family: 'selector' }>,
): { readonly path: string; readonly message: string } | undefined {
  if (entity.configuration.operation === 'select' && Object.is(entity.configuration.index, -0)) {
    return {
      path: `${entity.path}.control_behavior.index_constant`,
      message: 'Negative zero in a Selector index cannot round-trip through source.',
    };
  }
  return undefined;
}

function deciderConditionRows(
  condition: LogicalDeciderCondition,
  rows: Extract<LogicalDeciderCondition, { kind: 'compare' }>[],
): void {
  if (condition.kind === 'compare') {
    rows.push(condition);
    return;
  }
  for (const child of condition.conditions) deciderConditionRows(child, rows);
}

function deciderRepresentabilityRefusal(
  entity: Extract<CanonicalBlueprintImportEntity, { family: 'decider' }>,
): { readonly path: string; readonly message: string } | undefined {
  const nativePath = `${entity.path}.control_behavior.decider_conditions`;
  const hasElseOutputs = Object.hasOwn(entity.configuration, 'elseOutputs');
  const elseOutputs = entity.configuration.elseOutputs;
  if (hasElseOutputs && elseOutputs?.length === 0) {
    return {
      path: `${nativePath}.else_outputs`,
      message: 'An explicitly present empty Decider else_outputs branch cannot round-trip.',
    };
  }
  if (entity.configuration.outputs.length + (elseOutputs?.length ?? 0) === 0) {
    return {
      path: `${nativePath}.outputs`,
      message: 'A Decider configuration without output rows cannot be represented in source.',
    };
  }

  const conditionRows: Extract<LogicalDeciderCondition, { kind: 'compare' }>[] = [];
  deciderConditionRows(entity.configuration.condition, conditionRows);
  for (let index = 0; index < conditionRows.length; index += 1) {
    const row = conditionRows[index]!;
    if (row.right.kind === 'constant' && Object.is(row.right.value, -0)) {
      return {
        path: `${nativePath}.conditions[${index}].constant`,
        message: 'Negative zero in a Decider condition cannot round-trip through source.',
      };
    }
  }

  for (const [branch, rows] of [
    ['outputs', entity.configuration.outputs],
    ['else_outputs', entity.configuration.elseOutputs ?? []],
  ] as const) {
    for (let index = 0; index < rows.length; index += 1) {
      const row = rows[index]!;
      const path = `${nativePath}.${branch}[${index}]`;
      if (row.mode === 'copy' && row.input === undefined) {
        return {
          path,
          message:
            'A copied-count Decider output without an explicit input mask cannot round-trip.',
        };
      }
      if (row.mode === 'constant' && row.input !== undefined) {
        return {
          path,
          message: 'A masked constant-count Decider output cannot round-trip.',
        };
      }
      if (row.mode === 'constant' && Object.is(row.value, -0)) {
        return {
          path: `${path}.constant`,
          message: 'Negative zero in a Decider output cannot round-trip through source.',
        };
      }
    }
  }
  return undefined;
}

function sourceForNetworkColor(color: 'red' | 'green'): 'R' | 'G' {
  return color === 'red' ? 'R' : 'G';
}

/** Generates one complete literal source snapshot from the reviewed canonical family bridge. */
export function generateCanonicalBlueprintSource(
  analysis: BlueprintImportAnalysis,
  selections: readonly BlueprintImportProfileMappingEntry[],
  context: TrustedEntityReplayContext,
  options: GenerateCanonicalBlueprintSourceOptions,
): CanonicalBlueprintSourceResult {
  const resolved = resolveOptions(options);
  checkAborted(resolved.signal);
  const bridgeOptions = {
    ...(resolved.maxEndpoints === undefined ? {} : { maxEndpoints: resolved.maxEndpoints }),
    ...(resolved.signal === undefined ? {} : { signal: resolved.signal }),
  };
  const bridge = analyzeCanonicalBlueprintImport(analysis, selections, context, bridgeOptions);
  const retained = retainedMetadata(analysis, resolved.signal);
  const coverage = validateOuterCoverage(analysis, resolved.signal);
  if (bridge.state === 'blocked' || coverage.diagnostics.length > 0) {
    const diagnostics: readonly CanonicalBlueprintSourceDiagnostic[] = Object.freeze([
      ...bridge.diagnostics,
      ...coverage.diagnostics,
    ]);
    return Object.freeze({
      state: 'blocked',
      analysis,
      source: undefined,
      correspondence: undefined,
      diagnostics,
      retainedMetadata: retained,
    });
  }

  const representabilityDiagnostics: BlueprintSourceAssemblyDiagnostic[] = [];
  for (const entity of bridge.entities) {
    checkAborted(resolved.signal);
    const refusal =
      entity.family === 'decider'
        ? deciderRepresentabilityRefusal(entity)
        : entity.family === 'selector'
          ? selectorRepresentabilityRefusal(entity)
          : undefined;
    if (refusal !== undefined) {
      representabilityDiagnostics.push(
        sourceDiagnostic(
          'unsupported-source-configuration',
          refusal.path,
          refusal.message,
          entity.entityNumber,
        ),
      );
    }
  }
  if (representabilityDiagnostics.length > 0) {
    return Object.freeze({
      state: 'blocked',
      analysis,
      source: undefined,
      correspondence: undefined,
      diagnostics: Object.freeze(representabilityDiagnostics),
      retainedMetadata: retained,
    });
  }

  const fileId = sourceFileId(resolved.path);
  const networkRows: BlueprintSourceNetworkCorrespondence[] = [];
  const entityRows: BlueprintSourceEntityCorrespondence[] = [];
  const networkOrder: NetworkId[] = [];
  let hasArithmetic = false;
  let hasDecider = false;
  let hasSelector = false;
  for (const network of bridge.networks) {
    checkAborted(resolved.signal);
    networkOrder.push(network.network);
  }
  for (const entity of bridge.entities) {
    checkAborted(resolved.signal);
    if (entity.family === 'arithmetic') hasArithmetic = true;
    if (entity.family === 'decider') hasDecider = true;
    if (entity.family === 'selector') hasSelector = true;
  }
  const arithmeticPrinter = hasArithmetic
    ? createBlueprintArithmeticExpressionPrinter(networkOrder)
    : undefined;
  const deciderPrinter = hasDecider
    ? createBlueprintDeciderExpressionPrinter(networkOrder)
    : undefined;
  const selectorPrinter = hasSelector
    ? createBlueprintSelectorExpressionPrinter(networkOrder)
    : undefined;

  const builder = new BoundedSourceBuilder(resolved.maxSourceBytes);
  const networkNames = new Map<NetworkId, string>();
  for (let index = 0; index < bridge.networks.length; index += 1) {
    checkAborted(resolved.signal);
    const { network, component } = bridge.networks[index]!;
    const name = `import_network_${index + 1}`;
    const start = builder.offset;
    builder.append(`const ${name} = new Network<${sourceForNetworkColor(component.color)}>();`);
    const declarationSpan = builder.span(fileId, start);
    builder.append('\n');
    networkNames.set(network, name);
    networkRows.push(
      Object.freeze({
        network,
        name,
        declarationSpan,
      }),
    );
  }

  const entityNames = new Map<number, string>();
  for (let index = 0; index < bridge.entities.length; index += 1) {
    checkAborted(resolved.signal);
    const entity = bridge.entities[index]!;
    const name = `import_entity_${index + 1}`;
    entityNames.set(entity.entityNumber, name);
    builder.append(`const ${name} = `);
    const constructionStart = builder.offset;
    let expression: string;
    try {
      expression = constructorExpression(
        entity,
        arithmeticPrinter,
        deciderPrinter,
        selectorPrinter,
      );
    } catch (error) {
      if (
        (entity.family !== 'decider' && entity.family !== 'selector') ||
        !(error instanceof TypeError)
      ) {
        throw error;
      }
      const family = entity.family === 'selector' ? 'Selector' : 'Decider';
      return Object.freeze({
        state: 'blocked',
        analysis,
        source: undefined,
        correspondence: undefined,
        diagnostics: Object.freeze([
          sourceDiagnostic(
            'unsupported-source-configuration',
            `${entity.path}.control_behavior`,
            `${family} configuration is not representable in literal source: ${error.message}`,
            entity.entityNumber,
          ),
        ]),
        retainedMetadata: retained,
      });
    }
    builder.append(expression);
    const constructionSpan = builder.span(fileId, constructionStart);
    builder.append(';\n');
    entityRows.push({
      entityNumber: entity.entityNumber,
      path: entity.path,
      name,
      family: entity.family,
      constructionSpan,
      placementSpan: sourceSpan(fileId, 0, 0),
      attachmentSpans: Object.freeze([]),
    });
  }

  const placementsByNumber = new Map(
    coverage.placements.map((placement) => [placement.entityNumber, placement] as const),
  );
  for (let index = 0; index < bridge.entities.length; index += 1) {
    checkAborted(resolved.signal);
    const entity = bridge.entities[index]!;
    const name = entityNames.get(entity.entityNumber)!;
    const placement = placementsByNumber.get(entity.entityNumber)!;
    const statement = `${name}.at(${numericLiteral(placement.x)},${numericLiteral(placement.y)},${placement.direction})`;
    const start = builder.offset;
    builder.append(statement);
    const span = builder.span(fileId, start);
    builder.append(';\n');
    const existing = entityRows[index]!;
    entityRows[index] = Object.freeze({ ...existing, placementSpan: span });
  }

  for (let index = 0; index < bridge.entities.length; index += 1) {
    checkAborted(resolved.signal);
    const entity = bridge.entities[index]!;
    const name = entityNames.get(entity.entityNumber)!;
    const outputs = entity.outputNetworks;
    const redName = outputs.red === undefined ? undefined : networkNames.get(outputs.red);
    const greenName = outputs.green === undefined ? undefined : networkNames.get(outputs.green);
    const statements: string[] = [];
    if (redName !== undefined && greenName !== undefined) {
      statements.push(`to(${redName},${greenName}) += ${name};`);
    } else if (redName !== undefined) {
      statements.push(`${redName} += ${name};`);
    } else if (greenName !== undefined) {
      statements.push(`${greenName} += ${name};`);
    }
    const spans: SourceSpan[] = [];
    for (const statement of statements) {
      checkAborted(resolved.signal);
      const start = builder.offset;
      builder.append(statement);
      spans.push(builder.span(fileId, start));
      builder.append('\n');
    }
    const existing = entityRows[index]!;
    entityRows[index] = Object.freeze({
      ...existing,
      attachmentSpans: Object.freeze(spans),
    });
  }

  const sourceText = builder.finish();
  const correspondence: BlueprintSourceCorrespondence = Object.freeze({
    networks: Object.freeze(networkRows),
    entities: Object.freeze(entityRows),
  });
  const diagnostics: readonly [] = Object.freeze([]);
  return Object.freeze({
    state: 'complete',
    analysis,
    source: Object.freeze({ path: resolved.path, text: sourceText }),
    correspondence,
    diagnostics,
    retainedMetadata: retained,
  });
}

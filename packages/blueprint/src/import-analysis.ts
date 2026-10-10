import type { BlueprintDocumentClassification } from './classification.js';
import {
  LosslessJsonArray,
  LosslessJsonNumber,
  LosslessJsonObject,
  type LosslessJsonValue,
} from './document.js';

export type BlueprintImportDiagnosticCategory =
  | 'invalid-entities'
  | 'invalid-entity'
  | 'invalid-entity-number'
  | 'invalid-entity-name'
  | 'duplicate-entity-number'
  | 'malformed-wire'
  | 'dangling-wire-reference'
  | 'unresolved-wire-reference'
  | 'ambiguous-wire-reference';

export interface BlueprintImportDiagnostic {
  readonly category: BlueprintImportDiagnosticCategory;
  readonly severity: 'error';
  readonly message: string;
  readonly path: string;
  readonly relatedPath: string | undefined;
  readonly entityNumber: number | undefined;
}

export type BlueprintImportCoverageCategory =
  'unsupported-root' | 'unsupported-wire-representation';

export interface BlueprintImportCoverageNotice {
  readonly category: BlueprintImportCoverageCategory;
  readonly message: string;
  readonly path: string;
}

export interface BlueprintImportEntity {
  readonly entityNumber: number;
  readonly name: string;
  readonly path: string;
  readonly node: LosslessJsonObject;
  readonly position: LosslessJsonValue | undefined;
  readonly direction: LosslessJsonValue | undefined;
}

export interface BlueprintImportWireEndpoint {
  readonly entityNumber: number;
  readonly entityPath: string;
  readonly connectorId: number;
  readonly connectorPath: string;
  readonly connectorInterpretation: 'unresolved';
  readonly entity: BlueprintImportEntity | undefined;
}

export interface BlueprintImportWire {
  readonly path: string;
  readonly node: LosslessJsonArray;
  /** This resolves document entity IDs only; connector IDs remain uninterpreted. */
  readonly entityReferences: 'resolved' | 'unresolved';
  readonly endpointA: BlueprintImportWireEndpoint;
  readonly endpointB: BlueprintImportWireEndpoint;
}

export interface BlueprintImportAnalysisOptions {
  readonly maxEntities?: number;
  readonly maxWires?: number;
  readonly signal?: AbortSignal;
}

export interface BlueprintImportAnalysisErrorOptions {
  readonly path?: string;
}

/** Local resource/cancellation failure; this is not a native document diagnostic. */
export class BlueprintImportAnalysisError extends Error {
  readonly code: 'BPI1001' | 'BPI1002';
  readonly path: string | undefined;

  constructor(
    code: 'BPI1001' | 'BPI1002',
    message: string,
    options: BlueprintImportAnalysisErrorOptions = {},
  ) {
    super(message);
    this.name = 'BlueprintImportAnalysisError';
    this.code = code;
    this.path = options.path;
  }
}

export interface BlueprintImportAnalysis {
  readonly kind: BlueprintDocumentClassification['kind'];
  readonly root: BlueprintDocumentClassification['root'];
  /** The original immutable document; analysis never clones or freezes it again. */
  readonly document: BlueprintDocumentClassification['document'];
  /** Undefined for opaque roots; present (possibly empty/partial) for blueprints. */
  readonly entities: readonly BlueprintImportEntity[] | undefined;
  /** Undefined for opaque roots; present (possibly empty/partial) for blueprints. */
  readonly wires: readonly BlueprintImportWire[] | undefined;
  /** True when the structural slice is partial; false never means executable readiness. */
  readonly partial: boolean;
  readonly diagnostics: readonly BlueprintImportDiagnostic[];
  readonly coverage: readonly BlueprintImportCoverageNotice[];
}

interface ResolvedOptions {
  readonly maxEntities: number;
  readonly maxWires: number;
  readonly signal: AbortSignal | undefined;
}

const defaultMaxEntities = 10_000;
const defaultMaxWires = 50_000;
const allowedOptionNames = new Set(['maxEntities', 'maxWires', 'signal']);

function positiveSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function resolveOptions(options: BlueprintImportAnalysisOptions | undefined): ResolvedOptions {
  if (options === undefined) {
    return { maxEntities: defaultMaxEntities, maxWires: defaultMaxWires, signal: undefined };
  }
  if (
    typeof options !== 'object' ||
    options === null ||
    Array.isArray(options) ||
    (Object.getPrototypeOf(options) !== Object.prototype && Object.getPrototypeOf(options) !== null)
  ) {
    throw new TypeError('Blueprint import analysis options must be a plain object.');
  }

  let maxEntities = defaultMaxEntities;
  let maxWires = defaultMaxWires;
  let signal: AbortSignal | undefined;
  for (const key of Reflect.ownKeys(options)) {
    if (typeof key !== 'string' || !allowedOptionNames.has(key)) {
      throw new TypeError(`Unknown blueprint import analysis option: ${String(key)}.`);
    }
    const descriptor = Object.getOwnPropertyDescriptor(options, key);
    if (descriptor === undefined || !('value' in descriptor)) {
      throw new TypeError(`Blueprint import analysis option ${key} must be a data property.`);
    }
    if (key === 'maxEntities') {
      if (!positiveSafeInteger(descriptor.value)) {
        throw new RangeError('maxEntities must be a positive safe integer.');
      }
      maxEntities = descriptor.value;
    } else if (key === 'maxWires') {
      if (!positiveSafeInteger(descriptor.value)) {
        throw new RangeError('maxWires must be a positive safe integer.');
      }
      maxWires = descriptor.value;
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
  return { maxEntities, maxWires, signal };
}

function checkAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new BlueprintImportAnalysisError('BPI1002', 'Blueprint import analysis was cancelled.');
  }
}

function exactInteger(value: LosslessJsonValue, minimum: number): number | undefined {
  if (!(value instanceof LosslessJsonNumber)) return undefined;
  const number = value.toNumberIfExact();
  return number !== undefined && Number.isSafeInteger(number) && number >= minimum
    ? number
    : undefined;
}

function diagnostic(
  category: BlueprintImportDiagnosticCategory,
  message: string,
  path: string,
  relatedPath?: string,
  entityNumber?: number,
): BlueprintImportDiagnostic {
  return Object.freeze({ category, severity: 'error', message, path, relatedPath, entityNumber });
}

function coverageNotice(
  category: BlueprintImportCoverageCategory,
  message: string,
  path: string,
): BlueprintImportCoverageNotice {
  return Object.freeze({ category, message, path });
}

function pathAt(path: string, index: number): string {
  return `${path}[${index}]`;
}

function rootPath(root: string): string {
  return `$.${root}`;
}

function resourceError(path: string, resource: 'entities' | 'wires', limit: number): never {
  throw new BlueprintImportAnalysisError(
    'BPI1001',
    `Blueprint ${resource} analysis limit exceeded (${limit}).`,
    { path },
  );
}

function opaqueResult(
  classification: Extract<BlueprintDocumentClassification, { kind: 'opaque' }>,
): BlueprintImportAnalysis {
  return Object.freeze({
    kind: classification.kind,
    root: classification.root,
    document: classification.document,
    entities: undefined,
    wires: undefined,
    partial: false,
    diagnostics: Object.freeze([]),
    coverage: Object.freeze([
      coverageNotice(
        'unsupported-root',
        `The ${classification.root} root is retained as a document and is not semantically inventoried.`,
        rootPath(classification.root),
      ),
    ]),
  });
}

/** Builds a finite structural inventory without granting executable circuit authority. */
export function analyzeBlueprintImport(
  classification: BlueprintDocumentClassification,
  options?: BlueprintImportAnalysisOptions,
): BlueprintImportAnalysis {
  const resolvedOptions = resolveOptions(options);
  checkAborted(resolvedOptions.signal);
  if (classification.kind === 'opaque') return opaqueResult(classification);

  const entityRootPath = '$.blueprint.entities';
  const sourceRoot = classification.document.get('blueprint');
  if (!(sourceRoot instanceof LosslessJsonObject)) {
    // Classification guarantees this; retain a defensive failure instead of empty success.
    throw new TypeError('Blueprint classification did not retain a lossless object root.');
  }

  const sourceEntities = sourceRoot.get('entities');
  const sourceWires = sourceRoot.get('wires');
  if (
    sourceEntities instanceof LosslessJsonArray &&
    sourceEntities.items.length > resolvedOptions.maxEntities
  ) {
    resourceError('$.blueprint.entities', 'entities', resolvedOptions.maxEntities);
  }
  if (
    sourceWires instanceof LosslessJsonArray &&
    sourceWires.items.length > resolvedOptions.maxWires
  ) {
    resourceError('$.blueprint.wires', 'wires', resolvedOptions.maxWires);
  }

  const diagnostics: BlueprintImportDiagnostic[] = [];
  const coverage: BlueprintImportCoverageNotice[] = [];
  const entities: BlueprintImportEntity[] = [];
  const entityByNumber = new Map<number, BlueprintImportEntity>();
  const firstEntityPath = new Map<number, string>();
  const invalidEntityNumbers = new Set<number>();
  const ambiguousEntityPaths = new Map<number, string[]>();
  if (sourceEntities !== undefined && !(sourceEntities instanceof LosslessJsonArray)) {
    diagnostics.push(
      diagnostic('invalid-entities', 'Blueprint entities must be an array.', entityRootPath),
    );
  } else if (sourceEntities instanceof LosslessJsonArray) {
    for (let index = 0; index < sourceEntities.items.length; index += 1) {
      checkAborted(resolvedOptions.signal);
      const path = pathAt(entityRootPath, index);
      const node = sourceEntities.items[index];
      if (!(node instanceof LosslessJsonObject)) {
        diagnostics.push(diagnostic('invalid-entity', 'Entity row must be an object.', path));
        continue;
      }
      if (node.get('connections') !== undefined) {
        coverage.push(
          coverageNotice(
            'unsupported-wire-representation',
            'Legacy entity connections are retained but are outside the reviewed top-level tuple representation.',
            `${path}.connections`,
          ),
        );
      }

      const rawEntityNumber = node.get('entity_number');
      const entityNumber =
        rawEntityNumber === undefined ? undefined : exactInteger(rawEntityNumber, 1);
      const rawName = node.get('name');
      const name = typeof rawName === 'string' && rawName.length > 0 ? rawName : undefined;
      if (entityNumber === undefined) {
        diagnostics.push(
          diagnostic(
            'invalid-entity-number',
            'entity_number must be an exact positive safe integer.',
            `${path}.entity_number`,
          ),
        );
      }
      if (name === undefined) {
        diagnostics.push(
          diagnostic(
            'invalid-entity-name',
            'Entity name must be a nonempty string.',
            `${path}.name`,
          ),
        );
      }
      let firstPath: string | undefined;
      if (entityNumber !== undefined) {
        firstPath = firstEntityPath.get(entityNumber);
        if (firstPath !== undefined) {
          diagnostics.push(
            diagnostic(
              'duplicate-entity-number',
              `Duplicate entity_number ${entityNumber}.`,
              `${path}.entity_number`,
              `${firstPath}.entity_number`,
              entityNumber,
            ),
          );
          const paths = ambiguousEntityPaths.get(entityNumber) ?? [firstPath];
          paths.push(path);
          ambiguousEntityPaths.set(entityNumber, paths);
          entityByNumber.delete(entityNumber);
        } else {
          firstEntityPath.set(entityNumber, path);
        }
        if (name === undefined) invalidEntityNumbers.add(entityNumber);
      }
      if (entityNumber === undefined || name === undefined) continue;

      const entity: BlueprintImportEntity = Object.freeze({
        entityNumber,
        name,
        path,
        node,
        position: node.get('position'),
        direction: node.get('direction'),
      });
      entities.push(entity);
      if (firstPath === undefined) entityByNumber.set(entityNumber, entity);
    }
  }

  const wireRootPath = '$.blueprint.wires';
  const wires: BlueprintImportWire[] = [];
  if (sourceWires !== undefined) {
    if (!(sourceWires instanceof LosslessJsonArray)) {
      coverage.push(
        coverageNotice(
          'unsupported-wire-representation',
          'Wire data is retained in the document but is not in the reviewed top-level array representation.',
          wireRootPath,
        ),
      );
    } else {
      for (let index = 0; index < sourceWires.items.length; index += 1) {
        checkAborted(resolvedOptions.signal);
        const path = pathAt(wireRootPath, index);
        const node = sourceWires.items[index];
        if (!(node instanceof LosslessJsonArray)) {
          if (node instanceof LosslessJsonObject) {
            coverage.push(
              coverageNotice(
                'unsupported-wire-representation',
                'Object-shaped wire data is retained but is outside the reviewed tuple representation.',
                path,
              ),
            );
          } else {
            diagnostics.push(
              diagnostic('malformed-wire', 'Wire row must be a four-element array.', path),
            );
          }
          continue;
        }
        if (node.items.length !== 4) {
          diagnostics.push(
            diagnostic('malformed-wire', 'Wire tuple must contain exactly four values.', path),
          );
          continue;
        }

        const entityA = exactInteger(node.items[0]!, 1);
        const connectorA = exactInteger(node.items[1]!, 0);
        const entityB = exactInteger(node.items[2]!, 1);
        const connectorB = exactInteger(node.items[3]!, 0);
        const values = [entityA, connectorA, entityB, connectorB] as const;
        for (let fieldIndex = 0; fieldIndex < values.length; fieldIndex += 1) {
          if (values[fieldIndex] === undefined) {
            diagnostics.push(
              diagnostic(
                'malformed-wire',
                fieldIndex === 0 || fieldIndex === 2
                  ? 'Wire entity reference must be an exact positive safe integer.'
                  : 'Wire connector ID must be an exact nonnegative safe integer.',
                pathAt(path, fieldIndex),
              ),
            );
          }
        }
        if (
          entityA === undefined ||
          connectorA === undefined ||
          entityB === undefined ||
          connectorB === undefined
        ) {
          continue;
        }

        const endpointAPath = pathAt(path, 0);
        const connectorAPath = pathAt(path, 1);
        const endpointBPath = pathAt(path, 2);
        const connectorBPath = pathAt(path, 3);
        const resolvedA = entityByNumber.get(entityA);
        const resolvedB = entityByNumber.get(entityB);
        const ambiguousA = ambiguousEntityPaths.get(entityA);
        const ambiguousB = ambiguousEntityPaths.get(entityB);
        if (ambiguousA !== undefined) {
          diagnostics.push(
            diagnostic(
              'ambiguous-wire-reference',
              `Wire references ambiguous entity_number ${entityA}.`,
              endpointAPath,
              ambiguousA[0],
              entityA,
            ),
          );
        } else if (resolvedA === undefined) {
          const knownPath = firstEntityPath.get(entityA);
          diagnostics.push(
            knownPath !== undefined && invalidEntityNumbers.has(entityA)
              ? diagnostic(
                  'unresolved-wire-reference',
                  `Wire references entity_number ${entityA}, whose entity row is malformed.`,
                  endpointAPath,
                  knownPath,
                  entityA,
                )
              : diagnostic(
                  'dangling-wire-reference',
                  `Wire references missing entity_number ${entityA}.`,
                  endpointAPath,
                  undefined,
                  entityA,
                ),
          );
        }
        if (ambiguousB !== undefined) {
          diagnostics.push(
            diagnostic(
              'ambiguous-wire-reference',
              `Wire references ambiguous entity_number ${entityB}.`,
              endpointBPath,
              ambiguousB[0],
              entityB,
            ),
          );
        } else if (resolvedB === undefined) {
          const knownPath = firstEntityPath.get(entityB);
          diagnostics.push(
            knownPath !== undefined && invalidEntityNumbers.has(entityB)
              ? diagnostic(
                  'unresolved-wire-reference',
                  `Wire references entity_number ${entityB}, whose entity row is malformed.`,
                  endpointBPath,
                  knownPath,
                  entityB,
                )
              : diagnostic(
                  'dangling-wire-reference',
                  `Wire references missing entity_number ${entityB}.`,
                  endpointBPath,
                  undefined,
                  entityB,
                ),
          );
        }

        const endpointA: BlueprintImportWireEndpoint = Object.freeze({
          entityNumber: entityA,
          entityPath: endpointAPath,
          connectorId: connectorA,
          connectorPath: connectorAPath,
          connectorInterpretation: 'unresolved',
          entity: resolvedA,
        });
        const endpointB: BlueprintImportWireEndpoint = Object.freeze({
          entityNumber: entityB,
          entityPath: endpointBPath,
          connectorId: connectorB,
          connectorPath: connectorBPath,
          connectorInterpretation: 'unresolved',
          entity: resolvedB,
        });
        wires.push(
          Object.freeze({
            path,
            node,
            entityReferences:
              resolvedA !== undefined && resolvedB !== undefined ? 'resolved' : 'unresolved',
            endpointA,
            endpointB,
          }),
        );
      }
    }
  }

  const frozenDiagnostics = Object.freeze(diagnostics.slice());
  const frozenCoverage = Object.freeze(coverage.slice());
  return Object.freeze({
    kind: classification.kind,
    root: classification.root,
    document: classification.document,
    entities: Object.freeze(entities.slice()),
    wires: Object.freeze(wires.slice()),
    partial: frozenDiagnostics.length > 0 || frozenCoverage.length > 0,
    diagnostics: frozenDiagnostics,
    coverage: frozenCoverage,
  });
}

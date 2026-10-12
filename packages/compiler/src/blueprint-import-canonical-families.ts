import type {
  BlueprintImportAnalysis,
  BlueprintImportCoverageNotice,
  BlueprintImportDiagnostic,
  BlueprintImportEntity,
} from '@comblang/blueprint/import-analysis';
import { BlueprintImportAnalysisError } from '@comblang/blueprint/import-analysis';
import {
  analyzeBlueprintConnectivity,
  type BlueprintConnectivityComponent,
  type BlueprintConnectivityDiagnostic,
  type BlueprintEndpointMapping,
} from '@comblang/blueprint/import-connectivity';
import type { LosslessJsonValue } from '@comblang/blueprint/document';
import type { ConstantConfiguration } from '@comblang/factorio';
import type { NetworkId } from '@comblang/shared';

import {
  decodeBlueprintArithmeticControlBehavior,
  type BlueprintArithmeticImportDiagnostic,
} from './blueprint-import-arithmetic.js';
import {
  decodeBlueprintConstantControlBehavior,
  type BlueprintConstantImportDiagnostic,
} from './blueprint-import-constant.js';
import {
  decodeBlueprintDeciderControlBehavior,
  type BlueprintDeciderImportDiagnostic,
} from './blueprint-import-decider.js';
import {
  decodeBlueprintSelectorControlBehavior,
  type BlueprintSelectorImportDiagnostic,
} from './blueprint-import-selector.js';
import type {
  BlueprintImportProfileMappingEntry,
  BlueprintImportProfileMappingOptions,
} from './blueprint-import-profile-mappings.js';
import {
  resolveEntityReplayProfile,
  type TrustedEntityReplayContext,
} from './entity-replay-context.js';
import type {
  ArithmeticProducerConfig,
  CircuitProducerNode,
  DeciderProducerConfig,
  SelectorProducerConfig,
} from './ir.js';
import { producerInputNetworkIds } from './producer-network-references.js';
import type { ProducerId } from '@comblang/shared';

export interface CanonicalBlueprintImportCoverageDiagnostic {
  readonly category:
    | 'missing-profile-selection'
    | 'unsupported-canonical-family'
    | 'canonical-family-mismatch'
    | 'ambiguous-canonical-profile'
    | 'unsupported-unread-arithmetic-input'
    | 'unsupported-unread-decider-input';
  readonly message: string;
  readonly path: string;
  readonly entityNumber: number;
  readonly relatedPath?: string;
}

export type CanonicalBlueprintImportDiagnostic =
  | BlueprintImportDiagnostic
  | BlueprintImportCoverageNotice
  | BlueprintConnectivityDiagnostic
  | BlueprintConstantImportDiagnostic
  | BlueprintArithmeticImportDiagnostic
  | BlueprintDeciderImportDiagnostic
  | BlueprintSelectorImportDiagnostic
  | CanonicalBlueprintImportCoverageDiagnostic;

export interface CanonicalBlueprintImportNetwork {
  readonly network: NetworkId;
  readonly component: BlueprintConnectivityComponent;
}

export interface CanonicalConstantBlueprintImportEntity {
  readonly entityNumber: number;
  readonly path: string;
  readonly family: 'constant';
  readonly configuration: ConstantConfiguration;
  readonly outputNetworks: Readonly<{ readonly red?: NetworkId; readonly green?: NetworkId }>;
}

export interface CanonicalArithmeticBlueprintImportEntity {
  readonly entityNumber: number;
  readonly path: string;
  readonly family: 'arithmetic';
  readonly configuration: ArithmeticProducerConfig;
  readonly inputNetworks: Readonly<{ readonly red: NetworkId; readonly green: NetworkId }>;
  readonly outputNetworks: Readonly<{ readonly red?: NetworkId; readonly green?: NetworkId }>;
}

export interface CanonicalDeciderBlueprintImportEntity {
  readonly entityNumber: number;
  readonly path: string;
  readonly family: 'decider';
  readonly configuration: DeciderProducerConfig;
  readonly inputNetworks: Readonly<{ readonly red: NetworkId; readonly green: NetworkId }>;
  readonly outputNetworks: Readonly<{ readonly red?: NetworkId; readonly green?: NetworkId }>;
}

export interface CanonicalSelectorBlueprintImportEntity {
  readonly entityNumber: number;
  readonly path: string;
  readonly family: 'selector';
  readonly configuration: SelectorProducerConfig;
  readonly inputNetworks: Readonly<{ readonly red: NetworkId; readonly green: NetworkId }>;
  readonly outputNetworks: Readonly<{ readonly red?: NetworkId; readonly green?: NetworkId }>;
}

export type CanonicalBlueprintImportEntity =
  | CanonicalConstantBlueprintImportEntity
  | CanonicalArithmeticBlueprintImportEntity
  | CanonicalDeciderBlueprintImportEntity
  | CanonicalSelectorBlueprintImportEntity;

export interface CanonicalBlueprintImportResult {
  readonly state: 'complete' | 'blocked';
  readonly analysis: BlueprintImportAnalysis;
  readonly components: readonly BlueprintConnectivityComponent[];
  readonly networks: readonly CanonicalBlueprintImportNetwork[];
  readonly entities: readonly CanonicalBlueprintImportEntity[];
  readonly diagnostics: readonly CanonicalBlueprintImportDiagnostic[];
}

interface ResolvedOptions {
  readonly maxEndpoints: number;
  readonly signal: AbortSignal | undefined;
}

interface SelectedFamily {
  readonly entity: BlueprintImportEntity;
  readonly family: 'constant' | 'arithmetic' | 'decider' | 'selector';
}

const defaultMaxEndpoints = 100_000;
const allowedOptionNames = new Set(['maxEndpoints', 'signal']);
const allowedSelectionNames = new Set(['entityNumber', 'profile']);
const emptyComponents: readonly BlueprintConnectivityComponent[] = Object.freeze([]);
const emptyNetworks: readonly CanonicalBlueprintImportNetwork[] = Object.freeze([]);
const emptyEntities: readonly CanonicalBlueprintImportEntity[] = Object.freeze([]);

function positiveSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function resolveOptions(
  options: BlueprintImportProfileMappingOptions | undefined,
): ResolvedOptions {
  if (options === undefined) return { maxEndpoints: defaultMaxEndpoints, signal: undefined };
  if (
    typeof options !== 'object' ||
    options === null ||
    Array.isArray(options) ||
    (Object.getPrototypeOf(options) !== Object.prototype && Object.getPrototypeOf(options) !== null)
  ) {
    throw new TypeError('Blueprint canonical family options must be a plain object.');
  }

  let maxEndpoints = defaultMaxEndpoints;
  let signal: AbortSignal | undefined;
  for (const key of Reflect.ownKeys(options)) {
    if (typeof key !== 'string' || !allowedOptionNames.has(key)) {
      throw new TypeError(`Unknown blueprint canonical family option: ${String(key)}.`);
    }
    const descriptor = Object.getOwnPropertyDescriptor(options, key);
    if (descriptor === undefined || !('value' in descriptor)) {
      throw new TypeError(`Blueprint canonical family option ${key} must be a data property.`);
    }
    if (key === 'maxEndpoints') {
      if (!positiveSafeInteger(descriptor.value)) {
        throw new RangeError('maxEndpoints must be a positive safe integer.');
      }
      maxEndpoints = descriptor.value;
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
  return { maxEndpoints, signal };
}

function checkAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new BlueprintImportAnalysisError(
      'BPI1002',
      'Canonical blueprint import analysis was cancelled.',
    );
  }
}

function coverage(
  category: CanonicalBlueprintImportCoverageDiagnostic['category'],
  message: string,
  path: string,
  entityNumber: number,
  relatedPath?: string,
): CanonicalBlueprintImportCoverageDiagnostic {
  return Object.freeze({
    category,
    message,
    path,
    entityNumber,
    ...(relatedPath === undefined ? {} : { relatedPath }),
  });
}

function blocked(
  analysis: BlueprintImportAnalysis,
  diagnostics: readonly CanonicalBlueprintImportDiagnostic[],
): CanonicalBlueprintImportResult {
  return Object.freeze({
    state: 'blocked',
    analysis,
    components: emptyComponents,
    networks: emptyNetworks,
    entities: emptyEntities,
    diagnostics: Object.freeze(diagnostics.slice()),
  });
}

function complete(
  analysis: BlueprintImportAnalysis,
  components: readonly BlueprintConnectivityComponent[],
  networks: readonly CanonicalBlueprintImportNetwork[],
  entities: readonly CanonicalBlueprintImportEntity[],
): CanonicalBlueprintImportResult {
  return Object.freeze({
    state: 'complete',
    analysis,
    components: Object.freeze(components.slice()),
    networks: Object.freeze(networks.slice()),
    entities: Object.freeze(entities.slice()),
    diagnostics: Object.freeze([]),
  });
}

function completeInventory(
  analysis: BlueprintImportAnalysis,
): analysis is BlueprintImportAnalysis & {
  readonly kind: 'blueprint';
  readonly entities: readonly BlueprintImportEntity[];
  readonly wires: NonNullable<BlueprintImportAnalysis['wires']>;
} {
  return (
    analysis.kind === 'blueprint' &&
    analysis.entities !== undefined &&
    analysis.wires !== undefined &&
    !analysis.partial &&
    analysis.diagnostics.length === 0 &&
    analysis.coverage.length === 0
  );
}

function validateSelections(
  selections: readonly BlueprintImportProfileMappingEntry[],
  maxEndpoints: number,
  signal: AbortSignal | undefined,
): readonly { readonly entityNumber: number; readonly profile: unknown }[] {
  if (!Array.isArray(selections)) {
    throw new TypeError('Blueprint profile mapping entries must be an array.');
  }
  if (selections.length > maxEndpoints) {
    throw new RangeError(`Blueprint profile mapping entry limit exceeded (${maxEndpoints}).`);
  }
  const seen = new Set<number>();
  const result: { entityNumber: number; profile: unknown }[] = [];
  for (let index = 0; index < selections.length; index += 1) {
    checkAborted(signal);
    const candidate: unknown = selections[index];
    if (
      typeof candidate !== 'object' ||
      candidate === null ||
      Array.isArray(candidate) ||
      (Object.getPrototypeOf(candidate) !== Object.prototype &&
        Object.getPrototypeOf(candidate) !== null)
    ) {
      throw new TypeError(`Blueprint profile mapping entry ${index} must be a plain object.`);
    }
    let entityNumber: unknown;
    let profile: unknown;
    let hasEntityNumber = false;
    let hasProfile = false;
    for (const key of Reflect.ownKeys(candidate)) {
      if (typeof key !== 'string' || !allowedSelectionNames.has(key)) {
        throw new TypeError(`Blueprint profile mapping entry ${index} has an unknown field.`);
      }
      const descriptor = Object.getOwnPropertyDescriptor(candidate, key);
      if (descriptor === undefined || !('value' in descriptor)) {
        throw new TypeError(
          `Blueprint profile mapping entry ${index}.${key} must be a data property.`,
        );
      }
      if (key === 'entityNumber') {
        entityNumber = descriptor.value;
        hasEntityNumber = true;
      } else {
        profile = descriptor.value;
        hasProfile = true;
      }
    }
    if (!hasEntityNumber || !positiveSafeInteger(entityNumber)) {
      throw new TypeError(
        `Blueprint profile mapping entry ${index}.entityNumber must be a positive safe integer.`,
      );
    }
    if (!hasProfile) {
      throw new TypeError(`Blueprint profile mapping entry ${index}.profile is required.`);
    }
    if (seen.has(entityNumber)) {
      throw new TypeError(`Duplicate blueprint entity_number ${entityNumber} in profile mappings.`);
    }
    seen.add(entityNumber);
    result.push({ entityNumber, profile });
  }
  return result;
}

function endpointKey(entityNumber: number, connectorId: number): string {
  return `${entityNumber}:${connectorId}`;
}

function networkRef(
  entityNumber: number,
  connectorId: number,
  ids: ReadonlyMap<string, NetworkId>,
): NetworkId {
  const network = ids.get(endpointKey(entityNumber, connectorId));
  if (network === undefined) {
    throw new Error('Complete connectivity result omitted an explicitly mapped endpoint.');
  }
  return network;
}

function addMapping(
  mappings: BlueprintEndpointMapping[],
  entityNumber: number,
  connectorId: number,
  color: 'red' | 'green',
  maxEndpoints: number,
): void {
  if (mappings.length >= maxEndpoints) {
    throw new BlueprintImportAnalysisError(
      'BPI1001',
      `Blueprint canonical endpoint limit exceeded (${maxEndpoints}).`,
      { path: '$.endpointMappings' },
    );
  }
  mappings.push(Object.freeze({ entityNumber, connectorId, color }));
}

function selectedEndpointMappings(
  family: SelectedFamily['family'],
  entityNumber: number,
  maxEndpoints: number,
  mappings: BlueprintEndpointMapping[],
): void {
  if (family === 'constant') {
    addMapping(mappings, entityNumber, 1, 'red', maxEndpoints);
    addMapping(mappings, entityNumber, 2, 'green', maxEndpoints);
  } else {
    addMapping(mappings, entityNumber, 1, 'red', maxEndpoints);
    addMapping(mappings, entityNumber, 2, 'green', maxEndpoints);
    addMapping(mappings, entityNumber, 3, 'red', maxEndpoints);
    addMapping(mappings, entityNumber, 4, 'green', maxEndpoints);
  }
}

function profileFamily(entity: BlueprintImportEntity):
  | {
      readonly family: SelectedFamily['family'];
      readonly prototypeKey: string;
      readonly prototypeType: string;
    }
  | undefined {
  if (entity.name === 'constant-combinator') {
    return {
      family: 'constant',
      prototypeKey: 'entity:constant-combinator',
      prototypeType: 'constant-combinator',
    };
  }
  if (entity.name === 'arithmetic-combinator') {
    return {
      family: 'arithmetic',
      prototypeKey: 'entity:arithmetic-combinator',
      prototypeType: 'arithmetic-combinator',
    };
  }
  if (entity.name === 'decider-combinator') {
    return {
      family: 'decider',
      prototypeKey: 'entity:decider-combinator',
      prototypeType: 'decider-combinator',
    };
  }
  if (entity.name === 'selector-combinator') {
    return {
      family: 'selector',
      prototypeKey: 'entity:selector-combinator',
      prototypeType: 'selector-combinator',
    };
  }
  return undefined;
}

function addNetworkReference(
  entityNumber: number,
  connectorId: number,
  ids: Map<string, NetworkId>,
  network: NetworkId,
): void {
  ids.set(endpointKey(entityNumber, connectorId), network);
}

function addWireEndpointPath(
  paths: Map<string, string>,
  entityNumber: number,
  connectorId: number,
  path: string,
): void {
  const key = endpointKey(entityNumber, connectorId);
  if (!paths.has(key)) paths.set(key, path);
}

function arithmeticOperandContains(
  configuration: ArithmeticProducerConfig,
  network: NetworkId,
): boolean {
  const operands = [configuration.left, configuration.right];
  for (const operand of operands) {
    if (operand.kind === 'constant') continue;
    if (operand.refKind === 'single') {
      if (operand.network === network) return true;
    } else if (operand.networks[0] === network || operand.networks[1] === network) {
      return true;
    }
  }
  return false;
}

function deciderInputNetworks(configuration: DeciderProducerConfig): readonly NetworkId[] {
  const producer: CircuitProducerNode = {
    id: 'producer:blueprint-import-decider-inputs' as ProducerId,
    kind: 'decider',
    config: configuration,
    destinations: [],
    provenance: { instancePath: [], expansionStack: [] },
  };
  return producerInputNetworkIds(producer);
}

function hasWiredEndpoint(
  entityNumber: number,
  connectorId: number,
  wiredEndpoints: ReadonlySet<string>,
): boolean {
  return wiredEndpoints.has(endpointKey(entityNumber, connectorId));
}

/** Bridges complete raw blueprint inventory to existing connectivity and inverse decoders only. */
export function analyzeCanonicalBlueprintImport(
  analysis: BlueprintImportAnalysis,
  selections: readonly BlueprintImportProfileMappingEntry[],
  context: TrustedEntityReplayContext,
  options?: BlueprintImportProfileMappingOptions,
): CanonicalBlueprintImportResult {
  const resolvedOptions = resolveOptions(options);
  checkAborted(resolvedOptions.signal);

  if (!completeInventory(analysis)) {
    const connectivity = analyzeBlueprintConnectivity(analysis, [], options);
    return blocked(analysis, connectivity.diagnostics);
  }

  const validatedSelections = validateSelections(
    selections,
    resolvedOptions.maxEndpoints,
    resolvedOptions.signal,
  );
  const entitiesByNumber = new Map<number, BlueprintImportEntity>();
  for (const entity of analysis.entities) {
    checkAborted(resolvedOptions.signal);
    if (entitiesByNumber.has(entity.entityNumber)) {
      return blocked(analysis, [
        coverage(
          'canonical-family-mismatch',
          `The structural inventory contains an ambiguous entity_number ${entity.entityNumber}.`,
          entity.path,
          entity.entityNumber,
        ),
      ]);
    }
    entitiesByNumber.set(entity.entityNumber, entity);
  }

  const selectedByNumber = new Map<number, { readonly profile: unknown; readonly index: number }>();
  for (let index = 0; index < validatedSelections.length; index += 1) {
    checkAborted(resolvedOptions.signal);
    const selection = validatedSelections[index]!;
    if (!entitiesByNumber.has(selection.entityNumber)) {
      throw new TypeError(
        `Blueprint profile selection references entity_number ${selection.entityNumber} absent from the inventory.`,
      );
    }
    selectedByNumber.set(selection.entityNumber, { profile: selection.profile, index });
  }

  const canonicalProfileCounts = new Map<string, number>();
  for (const profile of context.profiles) {
    checkAborted(resolvedOptions.signal);
    const prototypeKey = profile.ref.prototypeKey;
    if (
      prototypeKey === 'entity:constant-combinator' ||
      prototypeKey === 'entity:arithmetic-combinator' ||
      prototypeKey === 'entity:decider-combinator' ||
      prototypeKey === 'entity:selector-combinator'
    ) {
      canonicalProfileCounts.set(prototypeKey, (canonicalProfileCounts.get(prototypeKey) ?? 0) + 1);
    }
  }

  const diagnostics: CanonicalBlueprintImportDiagnostic[] = [];
  const selectedFamilies: SelectedFamily[] = [];
  const mappings: BlueprintEndpointMapping[] = [];
  for (const entity of analysis.entities) {
    checkAborted(resolvedOptions.signal);
    const selected = selectedByNumber.get(entity.entityNumber);
    if (selected === undefined) {
      diagnostics.push(
        coverage(
          'missing-profile-selection',
          `No trusted canonical profile was selected for entity ${entity.entityNumber}.`,
          `${entity.path}.name`,
          entity.entityNumber,
        ),
      );
      continue;
    }

    const profile = resolveEntityReplayProfile(selected.profile, context);
    const family = profileFamily(entity);
    if (family === undefined) {
      diagnostics.push(
        coverage(
          'unsupported-canonical-family',
          `Blueprint prototype ${entity.name} is outside the Constant/Arithmetic/Decider/Selector bridge.`,
          `${entity.path}.name`,
          entity.entityNumber,
          `$.entries[${selected.index}].profile.prototypeKey`,
        ),
      );
      continue;
    }

    if ((canonicalProfileCounts.get(family.prototypeKey) ?? 0) > 1) {
      diagnostics.push(
        coverage(
          'ambiguous-canonical-profile',
          `The trusted replay context contains multiple ${family.prototypeType} base profiles.`,
          `${entity.path}.name`,
          entity.entityNumber,
          `$.entries[${selected.index}].profile`,
        ),
      );
      continue;
    }

    if (
      profile.ref.prototypeKey !== family.prototypeKey ||
      profile.prototypeType !== family.prototypeType
    ) {
      diagnostics.push(
        coverage(
          'canonical-family-mismatch',
          `The selected trusted profile must be the base ${family.prototypeKey} profile with prototypeType ${family.prototypeType}.`,
          `${entity.path}.name`,
          entity.entityNumber,
          `$.entries[${selected.index}].profile`,
        ),
      );
      continue;
    }

    selectedFamilies.push({ entity, family: family.family });
    selectedEndpointMappings(
      family.family,
      entity.entityNumber,
      resolvedOptions.maxEndpoints,
      mappings,
    );
  }

  if (diagnostics.length > 0) return blocked(analysis, diagnostics);

  const connectivity = analyzeBlueprintConnectivity(analysis, mappings, options);
  if (connectivity.state === 'blocked') return blocked(analysis, connectivity.diagnostics);

  const componentNetworks: CanonicalBlueprintImportNetwork[] = [];
  const endpointNetworks = new Map<string, NetworkId>();
  for (let index = 0; index < connectivity.components.length; index += 1) {
    checkAborted(resolvedOptions.signal);
    const component = connectivity.components[index]!;
    const network = `network:blueprint-import:${index + 1}` as NetworkId;
    componentNetworks.push(Object.freeze({ network, component }));
    for (const endpoint of component.endpoints) {
      checkAborted(resolvedOptions.signal);
      addNetworkReference(endpoint.entityNumber, endpoint.connectorId, endpointNetworks, network);
    }
  }

  const wiredEndpoints = new Set<string>();
  const wireEndpointPaths = new Map<string, string>();
  for (const wire of analysis.wires) {
    checkAborted(resolvedOptions.signal);
    const endpointAKey = endpointKey(wire.endpointA.entityNumber, wire.endpointA.connectorId);
    const endpointBKey = endpointKey(wire.endpointB.entityNumber, wire.endpointB.connectorId);
    wiredEndpoints.add(endpointAKey);
    wiredEndpoints.add(endpointBKey);
    addWireEndpointPath(
      wireEndpointPaths,
      wire.endpointA.entityNumber,
      wire.endpointA.connectorId,
      wire.endpointA.connectorPath,
    );
    addWireEndpointPath(
      wireEndpointPaths,
      wire.endpointB.entityNumber,
      wire.endpointB.connectorId,
      wire.endpointB.connectorPath,
    );
  }

  const projectedEntities: CanonicalBlueprintImportEntity[] = [];
  for (const selected of selectedFamilies) {
    checkAborted(resolvedOptions.signal);
    const { entity, family } = selected;
    const controlBehavior: LosslessJsonValue | undefined = entity.node.get('control_behavior');
    const path = `${entity.path}.control_behavior`;
    const outputNetworks: { red?: NetworkId; green?: NetworkId } = {};
    const redOutputConnector = family === 'constant' ? 1 : 3;
    const greenOutputConnector = family === 'constant' ? 2 : 4;
    if (hasWiredEndpoint(entity.entityNumber, redOutputConnector, wiredEndpoints)) {
      outputNetworks.red = networkRef(entity.entityNumber, redOutputConnector, endpointNetworks);
    }
    if (hasWiredEndpoint(entity.entityNumber, greenOutputConnector, wiredEndpoints)) {
      outputNetworks.green = networkRef(
        entity.entityNumber,
        greenOutputConnector,
        endpointNetworks,
      );
    }

    if (family === 'constant') {
      const decoded = decodeBlueprintConstantControlBehavior(controlBehavior, {
        path,
        ...(resolvedOptions.signal === undefined ? {} : { signal: resolvedOptions.signal }),
      });
      if (decoded.state === 'blocked') {
        diagnostics.push(...decoded.diagnostics);
        continue;
      }
      projectedEntities.push(
        Object.freeze({
          entityNumber: entity.entityNumber,
          path: entity.path,
          family,
          configuration: decoded.configuration,
          outputNetworks: Object.freeze(outputNetworks),
        }),
      );
      continue;
    }

    const inputNetworks = Object.freeze({
      red: networkRef(entity.entityNumber, 1, endpointNetworks),
      green: networkRef(entity.entityNumber, 2, endpointNetworks),
    });
    if (family === 'decider') {
      const decoded = decodeBlueprintDeciderControlBehavior(controlBehavior, inputNetworks, {
        path,
        ...(resolvedOptions.signal === undefined ? {} : { signal: resolvedOptions.signal }),
      });
      if (decoded.state === 'blocked') {
        diagnostics.push(...decoded.diagnostics);
        continue;
      }
      const usedInputs = deciderInputNetworks(decoded.configuration);
      for (const [connectorId, network] of [
        [1, inputNetworks.red],
        [2, inputNetworks.green],
      ] as const) {
        checkAborted(resolvedOptions.signal);
        if (
          hasWiredEndpoint(entity.entityNumber, connectorId, wiredEndpoints) &&
          !usedInputs.includes(network)
        ) {
          diagnostics.push(
            coverage(
              'unsupported-unread-decider-input',
              `Physically wired Decider input connector ${connectorId} is not selected by any condition operand or output input mask.`,
              wireEndpointPaths.get(endpointKey(entity.entityNumber, connectorId)) ??
                `${entity.path}.control_behavior`,
              entity.entityNumber,
            ),
          );
        }
      }
      projectedEntities.push(
        Object.freeze({
          entityNumber: entity.entityNumber,
          path: entity.path,
          family,
          configuration: decoded.configuration,
          inputNetworks,
          outputNetworks: Object.freeze(outputNetworks),
        }),
      );
      continue;
    }
    if (family === 'selector') {
      const decoded = decodeBlueprintSelectorControlBehavior(
        controlBehavior,
        {
          refKind: 'pair',
          networks: [inputNetworks.red, inputNetworks.green],
        },
        {
          path,
          ...(resolvedOptions.signal === undefined ? {} : { signal: resolvedOptions.signal }),
        },
      );
      if (decoded.state === 'blocked') {
        diagnostics.push(...decoded.diagnostics);
        continue;
      }
      projectedEntities.push(
        Object.freeze({
          entityNumber: entity.entityNumber,
          path: entity.path,
          family,
          configuration: decoded.configuration,
          inputNetworks,
          outputNetworks: Object.freeze(outputNetworks),
        }),
      );
      continue;
    }
    const decoded = decodeBlueprintArithmeticControlBehavior(controlBehavior, inputNetworks, {
      path,
      ...(resolvedOptions.signal === undefined ? {} : { signal: resolvedOptions.signal }),
    });
    if (decoded.state === 'blocked') {
      diagnostics.push(...decoded.diagnostics);
      continue;
    }
    for (const [connectorId, network] of [
      [1, inputNetworks.red],
      [2, inputNetworks.green],
    ] as const) {
      checkAborted(resolvedOptions.signal);
      if (
        hasWiredEndpoint(entity.entityNumber, connectorId, wiredEndpoints) &&
        !arithmeticOperandContains(decoded.configuration, network)
      ) {
        diagnostics.push(
          coverage(
            'unsupported-unread-arithmetic-input',
            `Physically wired Arithmetic input connector ${connectorId} is not selected by either operand.`,
            wireEndpointPaths.get(endpointKey(entity.entityNumber, connectorId)) ??
              `${entity.path}.control_behavior`,
            entity.entityNumber,
          ),
        );
      }
    }
    projectedEntities.push(
      Object.freeze({
        entityNumber: entity.entityNumber,
        path: entity.path,
        family,
        configuration: decoded.configuration,
        inputNetworks,
        outputNetworks: Object.freeze(outputNetworks),
      }),
    );
  }

  if (diagnostics.length > 0) return blocked(analysis, diagnostics);
  return complete(analysis, connectivity.components, componentNetworks, projectedEntities);
}

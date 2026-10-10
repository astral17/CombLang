import {
  BlueprintImportAnalysisError,
  type BlueprintImportAnalysis,
  type BlueprintImportCoverageNotice,
  type BlueprintImportDiagnostic,
} from './import-analysis.js';

export interface BlueprintEndpointMapping {
  readonly entityNumber: number;
  readonly connectorId: number;
  readonly color: 'red' | 'green';
}

export interface BlueprintConnectivityOptions {
  readonly maxEndpoints?: number;
  readonly signal?: AbortSignal;
}

export interface BlueprintConnectivityEndpoint {
  readonly entityNumber: number;
  readonly connectorId: number;
}

export interface BlueprintConnectivityComponent {
  readonly color: 'red' | 'green';
  readonly endpoints: readonly BlueprintConnectivityEndpoint[];
}

export type BlueprintConnectivityDiagnosticCategory =
  | 'unresolved-endpoint'
  | 'incompatible-mapping'
  | 'unresolved-analysis-reference'
  | 'incomplete-analysis';

export interface BlueprintConnectivityDiagnostic {
  readonly category: BlueprintConnectivityDiagnosticCategory;
  readonly message: string;
  readonly path: string;
  readonly relatedPath: string | undefined;
  readonly entityNumber: number | undefined;
  readonly connectorId: number | undefined;
}

export type BlueprintConnectivityIssue =
  BlueprintImportDiagnostic | BlueprintImportCoverageNotice | BlueprintConnectivityDiagnostic;

export interface BlueprintConnectivityResult {
  readonly state: 'complete' | 'blocked';
  readonly analysis: BlueprintImportAnalysis;
  readonly components: readonly BlueprintConnectivityComponent[];
  readonly diagnostics: readonly BlueprintConnectivityIssue[];
}

interface ResolvedOptions {
  readonly maxEndpoints: number;
  readonly signal: AbortSignal | undefined;
}

interface IndexedEndpoint extends BlueprintConnectivityEndpoint {
  readonly color: 'red' | 'green';
}

const defaultMaxEndpoints = 100_000;
const allowedOptionNames = new Set(['maxEndpoints', 'signal']);
const allowedMappingNames = new Set(['entityNumber', 'connectorId', 'color']);
const emptyComponents: readonly BlueprintConnectivityComponent[] = Object.freeze([]);

function positiveSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function resolveOptions(options: BlueprintConnectivityOptions | undefined): ResolvedOptions {
  if (options === undefined) {
    return { maxEndpoints: defaultMaxEndpoints, signal: undefined };
  }
  if (
    typeof options !== 'object' ||
    options === null ||
    Array.isArray(options) ||
    (Object.getPrototypeOf(options) !== Object.prototype && Object.getPrototypeOf(options) !== null)
  ) {
    throw new TypeError('Blueprint connectivity options must be a plain object.');
  }

  let maxEndpoints = defaultMaxEndpoints;
  let signal: AbortSignal | undefined;
  for (const key of Reflect.ownKeys(options)) {
    if (typeof key !== 'string' || !allowedOptionNames.has(key)) {
      throw new TypeError(`Unknown blueprint connectivity option: ${String(key)}.`);
    }
    const descriptor = Object.getOwnPropertyDescriptor(options, key);
    if (descriptor === undefined || !('value' in descriptor)) {
      throw new TypeError(`Blueprint connectivity option ${key} must be a data property.`);
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
      'Blueprint import connectivity was cancelled.',
    );
  }
}

function mappingError(index: number, message: string): TypeError {
  return new TypeError(`Invalid endpoint mapping at index ${index}: ${message}`);
}

function validateMappings(
  endpointMappings: readonly BlueprintEndpointMapping[],
  maxEndpoints: number,
  signal: AbortSignal | undefined,
): IndexedEndpoint[] {
  if (!Array.isArray(endpointMappings)) {
    throw new TypeError('Endpoint mappings must be an array.');
  }
  if (endpointMappings.length > maxEndpoints) {
    throw new BlueprintImportAnalysisError(
      'BPI1001',
      `Blueprint endpoint mapping limit exceeded (${maxEndpoints}).`,
      { path: '$.endpointMappings' },
    );
  }

  checkAborted(signal);
  const rows: IndexedEndpoint[] = [];
  const keys = new Set<string>();
  for (let index = 0; index < endpointMappings.length; index += 1) {
    checkAborted(signal);
    const candidate: unknown = endpointMappings[index];
    if (
      typeof candidate !== 'object' ||
      candidate === null ||
      Array.isArray(candidate) ||
      (Object.getPrototypeOf(candidate) !== Object.prototype &&
        Object.getPrototypeOf(candidate) !== null)
    ) {
      throw mappingError(index, 'expected a plain data object.');
    }

    let entityNumber: unknown;
    let connectorId: unknown;
    let color: unknown;
    let hasEntityNumber = false;
    let hasConnectorId = false;
    let hasColor = false;
    for (const key of Reflect.ownKeys(candidate)) {
      if (typeof key !== 'string' || !allowedMappingNames.has(key)) {
        throw mappingError(index, `unknown property ${String(key)}.`);
      }
      const descriptor = Object.getOwnPropertyDescriptor(candidate, key);
      if (descriptor === undefined || !('value' in descriptor)) {
        throw mappingError(index, `${key} must be a data property.`);
      }
      if (key === 'entityNumber') {
        entityNumber = descriptor.value;
        hasEntityNumber = true;
      } else if (key === 'connectorId') {
        connectorId = descriptor.value;
        hasConnectorId = true;
      } else {
        color = descriptor.value;
        hasColor = true;
      }
    }

    if (!hasEntityNumber || !positiveSafeInteger(entityNumber)) {
      throw mappingError(index, 'entityNumber must be a positive safe integer.');
    }
    if (!hasConnectorId || !Number.isSafeInteger(connectorId) || (connectorId as number) < 0) {
      throw mappingError(index, 'connectorId must be a nonnegative safe integer.');
    }
    if (!hasColor || (color !== 'red' && color !== 'green')) {
      throw mappingError(index, 'color must be red or green.');
    }

    const numericConnectorId = connectorId as number;
    const key = `${entityNumber}:${numericConnectorId}`;
    if (keys.has(key)) {
      throw mappingError(index, `duplicate endpoint (${entityNumber}, ${numericConnectorId}).`);
    }
    keys.add(key);
    rows.push({ entityNumber, connectorId: numericConnectorId, color });
  }
  return rows;
}

function connectivityDiagnostic(
  category: BlueprintConnectivityDiagnosticCategory,
  message: string,
  path: string,
  relatedPath?: string,
  entityNumber?: number,
  connectorId?: number,
): BlueprintConnectivityDiagnostic {
  return Object.freeze({
    category,
    message,
    path,
    relatedPath,
    entityNumber,
    connectorId,
  });
}

function result(
  state: 'complete' | 'blocked',
  analysis: BlueprintImportAnalysis,
  components: readonly BlueprintConnectivityComponent[],
  diagnostics: readonly BlueprintConnectivityIssue[],
): BlueprintConnectivityResult {
  return Object.freeze({
    state,
    analysis,
    components: state === 'blocked' ? emptyComponents : Object.freeze(components.slice()),
    diagnostics: Object.freeze(diagnostics.slice()),
  });
}

function compareEndpoint(
  left: BlueprintConnectivityEndpoint,
  right: BlueprintConnectivityEndpoint,
): number {
  return left.entityNumber - right.entityNumber || left.connectorId - right.connectorId;
}

/** Computes only the explicitly mapped red/green endpoint graph; it grants no execution authority. */
export function analyzeBlueprintConnectivity(
  analysis: BlueprintImportAnalysis,
  endpointMappings: readonly BlueprintEndpointMapping[],
  options?: BlueprintConnectivityOptions,
): BlueprintConnectivityResult {
  const resolvedOptions = resolveOptions(options);
  const mappedRows = validateMappings(
    endpointMappings,
    resolvedOptions.maxEndpoints,
    resolvedOptions.signal,
  );

  if (
    analysis.kind !== 'blueprint' ||
    analysis.entities === undefined ||
    analysis.wires === undefined ||
    analysis.partial ||
    analysis.diagnostics.length > 0 ||
    analysis.coverage.length > 0
  ) {
    const diagnostics: BlueprintConnectivityIssue[] = [
      ...analysis.diagnostics,
      ...analysis.coverage,
    ];
    if (diagnostics.length === 0) {
      diagnostics.push(
        connectivityDiagnostic(
          'incomplete-analysis',
          'The structural inventory does not cover a complete blueprint graph slice.',
          '$.blueprint',
        ),
      );
    }
    return result('blocked', analysis, emptyComponents, diagnostics);
  }

  const entityNumbers = new Set<number>();
  for (const entity of analysis.entities) {
    checkAborted(resolvedOptions.signal);
    if (entityNumbers.has(entity.entityNumber)) {
      return result('blocked', analysis, emptyComponents, [
        connectivityDiagnostic(
          'incomplete-analysis',
          `The structural inventory contains an ambiguous entity_number ${entity.entityNumber}.`,
          entity.path,
          undefined,
          entity.entityNumber,
        ),
      ]);
    }
    entityNumbers.add(entity.entityNumber);
  }

  for (let index = 0; index < mappedRows.length; index += 1) {
    checkAborted(resolvedOptions.signal);
    const mapping = mappedRows[index]!;
    if (!entityNumbers.has(mapping.entityNumber)) {
      throw mappingError(index, `entity_number ${mapping.entityNumber} is not in the inventory.`);
    }
  }

  mappedRows.sort((left, right) => {
    checkAborted(resolvedOptions.signal);
    return compareEndpoint(left, right);
  });
  checkAborted(resolvedOptions.signal);
  const endpointIndexes = new Map<number, Map<number, number>>();
  for (let index = 0; index < mappedRows.length; index += 1) {
    checkAborted(resolvedOptions.signal);
    const mapping = mappedRows[index]!;
    let connectors = endpointIndexes.get(mapping.entityNumber);
    if (connectors === undefined) {
      connectors = new Map<number, number>();
      endpointIndexes.set(mapping.entityNumber, connectors);
    }
    connectors.set(mapping.connectorId, index);
  }

  const parent: number[] = [];
  const size: number[] = [];
  for (let index = 0; index < mappedRows.length; index += 1) {
    checkAborted(resolvedOptions.signal);
    parent.push(index);
    size.push(1);
  }
  function find(index: number): number {
    let current = index;
    while (parent[current] !== current) {
      checkAborted(resolvedOptions.signal);
      parent[current] = parent[parent[current]!]!;
      current = parent[current]!;
    }
    return current;
  }
  function union(left: number, right: number): void {
    let leftRoot = find(left);
    let rightRoot = find(right);
    if (leftRoot === rightRoot) return;
    if (size[leftRoot]! < size[rightRoot]!) {
      [leftRoot, rightRoot] = [rightRoot, leftRoot];
    }
    parent[rightRoot] = leftRoot;
    size[leftRoot] = size[leftRoot]! + size[rightRoot]!;
  }

  const wireDiagnostics: BlueprintConnectivityDiagnostic[] = [];
  for (const wire of analysis.wires) {
    checkAborted(resolvedOptions.signal);
    if (wire.entityReferences !== 'resolved') {
      wireDiagnostics.push(
        connectivityDiagnostic(
          'unresolved-analysis-reference',
          'The structural inventory retains an unresolved document entity reference.',
          wire.path,
        ),
      );
      continue;
    }

    const endpointAIndex = endpointIndexes
      .get(wire.endpointA.entityNumber)
      ?.get(wire.endpointA.connectorId);
    const endpointBIndex = endpointIndexes
      .get(wire.endpointB.entityNumber)
      ?.get(wire.endpointB.connectorId);
    if (endpointAIndex === undefined) {
      wireDiagnostics.push(
        connectivityDiagnostic(
          'unresolved-endpoint',
          `No explicit color mapping exists for connector ${wire.endpointA.connectorId} on entity ${wire.endpointA.entityNumber}.`,
          wire.endpointA.connectorPath,
          wire.endpointA.entityPath,
          wire.endpointA.entityNumber,
          wire.endpointA.connectorId,
        ),
      );
    }
    if (endpointBIndex === undefined) {
      wireDiagnostics.push(
        connectivityDiagnostic(
          'unresolved-endpoint',
          `No explicit color mapping exists for connector ${wire.endpointB.connectorId} on entity ${wire.endpointB.entityNumber}.`,
          wire.endpointB.connectorPath,
          wire.endpointB.entityPath,
          wire.endpointB.entityNumber,
          wire.endpointB.connectorId,
        ),
      );
    }
    if (endpointAIndex === undefined || endpointBIndex === undefined) continue;

    const mappingA = mappedRows[endpointAIndex]!;
    const mappingB = mappedRows[endpointBIndex]!;
    if (mappingA.color !== mappingB.color) {
      wireDiagnostics.push(
        connectivityDiagnostic(
          'incompatible-mapping',
          `The explicit endpoint mappings assign different colors to one wire (${mappingA.color} and ${mappingB.color}).`,
          wire.path,
          undefined,
          wire.endpointA.entityNumber,
          wire.endpointA.connectorId,
        ),
      );
      continue;
    }
    union(endpointAIndex, endpointBIndex);
  }

  if (wireDiagnostics.length > 0) {
    return result('blocked', analysis, emptyComponents, wireDiagnostics);
  }

  const groups = new Map<number, IndexedEndpoint[]>();
  for (let index = 0; index < mappedRows.length; index += 1) {
    checkAborted(resolvedOptions.signal);
    const root = find(index);
    const group = groups.get(root) ?? [];
    group.push(mappedRows[index]!);
    groups.set(root, group);
  }

  const sortedGroups: IndexedEndpoint[][] = [];
  for (const group of groups.values()) {
    checkAborted(resolvedOptions.signal);
    group.sort((left, right) => {
      checkAborted(resolvedOptions.signal);
      return compareEndpoint(left, right);
    });
    sortedGroups.push(group);
  }
  sortedGroups.sort((left, right) => {
    checkAborted(resolvedOptions.signal);
    const leftColor = left[0]!.color === 'red' ? 0 : 1;
    const rightColor = right[0]!.color === 'red' ? 0 : 1;
    return leftColor - rightColor || compareEndpoint(left[0]!, right[0]!);
  });
  checkAborted(resolvedOptions.signal);
  const components: BlueprintConnectivityComponent[] = [];
  for (const group of sortedGroups) {
    checkAborted(resolvedOptions.signal);
    const endpoints: BlueprintConnectivityEndpoint[] = [];
    for (const mapping of group) {
      checkAborted(resolvedOptions.signal);
      endpoints.push(
        Object.freeze({
          entityNumber: mapping.entityNumber,
          connectorId: mapping.connectorId,
        }),
      );
    }
    components.push(
      Object.freeze({
        color: group[0]!.color,
        endpoints: Object.freeze(endpoints),
      }),
    );
  }
  return result('complete', analysis, components, []);
}

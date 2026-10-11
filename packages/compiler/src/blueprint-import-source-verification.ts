import { BlueprintDocumentError } from '@comblang/blueprint/errors';
import { classifyBlueprintDocument } from '@comblang/blueprint/classification';
import {
  analyzeBlueprintImport,
  type BlueprintImportAnalysis,
  type BlueprintImportEntity,
} from '@comblang/blueprint/import-analysis';
import {
  LosslessJsonNumber,
  LosslessJsonObject,
  parseLosslessJson,
} from '@comblang/blueprint/document';
import { BlueprintJsonError } from './blueprint-native-config.js';
import { emitNativeBlueprintJson } from './native-blueprint-emitter.js';
import { buildNativeBlueprintFcir } from './native-blueprint-projector.js';
import { sameSignal, type ConstantConfiguration } from '@comblang/factorio';
import type { Diagnostic, NetworkId, ProducerId, SourceSpan } from '@comblang/shared';

import {
  analyzeCanonicalBlueprintImport,
  type CanonicalBlueprintImportDiagnostic,
  type CanonicalBlueprintImportEntity,
  type CanonicalBlueprintImportNetwork,
} from './blueprint-import-canonical-families.js';
import type {
  CanonicalBlueprintSourceDiagnostic,
  CanonicalBlueprintSourceResult,
  BlueprintSourceEntityCorrespondence,
  BlueprintSourceNetworkCorrespondence,
} from './blueprint-import-source-assembly.js';
import type { BlueprintImportProfileMappingEntry } from './blueprint-import-profile-mappings.js';
import {
  resolveEntityReplayProfile,
  type TrustedEntityReplayContext,
} from './entity-replay-context.js';
import type {
  ArithmeticProducerConfig,
  CircuitProducerNode,
  LogicalArithmeticOperand,
  LogicalArithmeticOutput,
  LogicalNetworkRef,
  NativeCircuitIr,
} from './ir.js';
import type { DirectElaborationPlan } from './direct-plan-schema.js';
import type { EntityId, EntityPhysicalRecord, EntityProfileRef } from './entity.js';
import type { ResolvedCircuit } from './resolved-circuit.js';
import {
  resolvedCircuitPlanFingerprint,
  validateResolvedCircuit,
} from './resolved-circuit-public.js';

export interface CompiledCanonicalBlueprintSource {
  readonly source: Readonly<{ readonly path: string; readonly text: string }>;
  readonly plan?: DirectElaborationPlan;
  readonly resolvedCircuit?: ResolvedCircuit;
  readonly diagnostics: readonly Diagnostic[];
}

export interface CanonicalBlueprintSourceVerificationMismatch {
  readonly category: 'source-verification-mismatch';
  readonly message: string;
  readonly path: string;
  readonly entityNumber?: number;
  readonly source?: SourceSpan;
}

export type CanonicalBlueprintSourceVerificationDiagnostic =
  | CanonicalBlueprintSourceDiagnostic
  | CanonicalBlueprintImportDiagnostic
  | Diagnostic
  | CanonicalBlueprintSourceVerificationMismatch;

export interface CanonicalBlueprintSourceEntityVerification {
  readonly entityNumber: number;
  readonly producerId: ProducerId;
  readonly entityId: EntityId;
  readonly nativeEntityNumber: number;
}

export interface CanonicalBlueprintSourceNetworkVerification {
  readonly network: NetworkId;
  readonly compiledNetwork: NetworkId;
}

export interface CanonicalBlueprintSourceVerificationResult {
  readonly state: 'verified' | 'blocked';
  readonly diagnostics: readonly CanonicalBlueprintSourceVerificationDiagnostic[];
  readonly entities: readonly CanonicalBlueprintSourceEntityVerification[];
  readonly networks: readonly CanonicalBlueprintSourceNetworkVerification[];
}

const emptyEntities: readonly CanonicalBlueprintSourceEntityVerification[] = Object.freeze([]);
const emptyNetworks: readonly CanonicalBlueprintSourceNetworkVerification[] = Object.freeze([]);

function snapshotSourceSpan(span: SourceSpan): SourceSpan {
  return Object.freeze({ fileId: span.fileId, start: span.start, end: span.end });
}

interface ExpectedEntity {
  readonly imported: CanonicalBlueprintImportEntity;
  readonly correspondence: BlueprintSourceEntityCorrespondence;
  readonly inventory: BlueprintImportEntity;
}

interface MatchedEntity extends ExpectedEntity {
  readonly producer: CircuitProducerNode;
  readonly physical: EntityPhysicalRecord;
  readonly nativeEntityNumber: number;
}

function snapshotDiagnostic<T extends object>(diagnostic: T): T {
  const copy = Object.assign({}, diagnostic) as Record<string, unknown>;
  for (const key of ['source', 'span'] as const) {
    const value = copy[key];
    if (typeof value === 'object' && value !== null) {
      copy[key] = snapshotSourceSpan(value as SourceSpan);
    }
  }
  if (Array.isArray(copy.related)) {
    copy.related = Object.freeze(
      copy.related.map((item: unknown) => {
        if (typeof item !== 'object' || item === null) return item;
        const related = Object.assign({}, item) as Record<string, unknown>;
        const span = related.span;
        if (typeof span === 'object' && span !== null) {
          related.span = snapshotSourceSpan(span as SourceSpan);
        }
        return Object.freeze(related);
      }),
    );
  }
  if (Array.isArray(copy.instancePath)) copy.instancePath = Object.freeze([...copy.instancePath]);
  if (Array.isArray(copy.instancePaths)) {
    copy.instancePaths = Object.freeze(
      copy.instancePaths.map((path: readonly unknown[]) => Object.freeze([...path])),
    );
  }
  return Object.freeze(copy) as T;
}

function mismatch(
  path: string,
  message: string,
  source?: SourceSpan,
  entityNumber?: number,
): CanonicalBlueprintSourceVerificationMismatch {
  return Object.freeze({
    category: 'source-verification-mismatch',
    path,
    message,
    ...(entityNumber === undefined ? {} : { entityNumber }),
    ...(source === undefined ? {} : { source: Object.freeze({ ...source }) }),
  });
}

function result(
  state: CanonicalBlueprintSourceVerificationResult['state'],
  diagnostics: readonly CanonicalBlueprintSourceVerificationDiagnostic[],
  entities: readonly CanonicalBlueprintSourceEntityVerification[] = emptyEntities,
  networks: readonly CanonicalBlueprintSourceNetworkVerification[] = emptyNetworks,
): CanonicalBlueprintSourceVerificationResult {
  return Object.freeze({
    state,
    diagnostics: Object.freeze(diagnostics.map((diagnostic) => snapshotDiagnostic(diagnostic))),
    entities: Object.freeze(entities.map((entity) => Object.freeze({ ...entity }))),
    networks: Object.freeze(networks.map((network) => Object.freeze({ ...network }))),
  });
}

function sourceKey(span: SourceSpan | undefined): string | undefined {
  return span === undefined ? undefined : `${span.fileId}\u0000${span.start}\u0000${span.end}`;
}

function sameSpan(left: SourceSpan | undefined, right: SourceSpan): boolean {
  return (
    left !== undefined &&
    left.fileId === right.fileId &&
    left.start === right.start &&
    left.end === right.end
  );
}

function rootInstance(instancePath: readonly string[]): boolean {
  return instancePath.length === 0;
}

function spanWithin(candidate: SourceSpan | undefined, container: SourceSpan): boolean {
  return (
    candidate !== undefined &&
    candidate.fileId === container.fileId &&
    candidate.start >= container.start &&
    candidate.end <= container.end
  );
}

function indexBy<T, K>(items: readonly T[], keyOf: (item: T) => K): Map<K, T[]> {
  const result = new Map<K, T[]>();
  for (const item of items) {
    const key = keyOf(item);
    const bucket = result.get(key);
    if (bucket === undefined) result.set(key, [item]);
    else bucket.push(item);
  }
  return result;
}

function sameProfileRef(left: EntityProfileRef, right: EntityProfileRef): boolean {
  return (
    left.prototypeKey === right.prototypeKey &&
    left.profileId === right.profileId &&
    left.database.schemaVersion === right.database.schemaVersion &&
    left.database.identity === right.database.identity
  );
}

function sameNumber(left: number, right: number): boolean {
  return Object.is(left, right);
}

function sameConstantConfiguration(
  left: ConstantConfiguration,
  right: ConstantConfiguration,
): boolean {
  if (left.isOn !== right.isOn || left.sections.length !== right.sections.length) return false;
  for (let sectionIndex = 0; sectionIndex < left.sections.length; sectionIndex += 1) {
    const leftSection = left.sections[sectionIndex]!;
    const rightSection = right.sections[sectionIndex]!;
    if (
      leftSection.active !== rightSection.active ||
      !sameNumber(leftSection.multiplier, rightSection.multiplier) ||
      Object.hasOwn(leftSection, 'group') !== Object.hasOwn(rightSection, 'group') ||
      leftSection.group !== rightSection.group ||
      leftSection.filters.length !== rightSection.filters.length
    ) {
      return false;
    }
    for (let filterIndex = 0; filterIndex < leftSection.filters.length; filterIndex += 1) {
      const leftFilter = leftSection.filters[filterIndex]!;
      const rightFilter = rightSection.filters[filterIndex]!;
      if (
        !sameSignal(leftFilter.signal, rightFilter.signal) ||
        !sameNumber(leftFilter.value, rightFilter.value)
      ) {
        return false;
      }
    }
  }
  return true;
}

function sameNetworkRef(
  left: LogicalNetworkRef,
  right: LogicalNetworkRef,
  remap?: ReadonlyMap<NetworkId, NetworkId>,
): boolean {
  if (left.refKind !== right.refKind) return false;
  if (left.refKind === 'single' && right.refKind === 'single') {
    return (remap === undefined ? left.network : remap.get(left.network)) === right.network;
  }
  if (left.refKind === 'pair' && right.refKind === 'pair') {
    return (
      (remap === undefined ? left.networks[0] : remap.get(left.networks[0])) ===
        right.networks[0] &&
      (remap === undefined ? left.networks[1] : remap.get(left.networks[1])) === right.networks[1]
    );
  }
  return false;
}

function sameOperand(
  left: LogicalArithmeticOperand,
  right: LogicalArithmeticOperand,
  remap?: ReadonlyMap<NetworkId, NetworkId>,
): boolean {
  if (left.kind !== right.kind) return false;
  if (left.kind === 'constant' && right.kind === 'constant') {
    return sameNumber(left.value, right.value);
  }
  if (left.kind === 'signal' && right.kind === 'signal') {
    return sameSignal(left.signal, right.signal) && sameNetworkRef(left, right, remap);
  }
  if (left.kind === 'each' && right.kind === 'each') return sameNetworkRef(left, right, remap);
  return false;
}

function sameOutput(left: LogicalArithmeticOutput, right: LogicalArithmeticOutput): boolean {
  if (left.kind !== right.kind) return false;
  return left.kind === 'each' || (right.kind === 'signal' && sameSignal(left.signal, right.signal));
}

function sameArithmeticConfiguration(
  left: ArithmeticProducerConfig,
  right: ArithmeticProducerConfig,
  remap: ReadonlyMap<NetworkId, NetworkId>,
): boolean {
  return (
    left.operation === right.operation &&
    sameOperand(left.left, right.left, remap) &&
    sameOperand(left.right, right.right, remap) &&
    sameOutput(left.output, right.output)
  );
}

function sameArithmeticPhysicalConfiguration(
  left: ArithmeticProducerConfig,
  right: Extract<EntityPhysicalRecord['configuration'], { mode: 'arithmetic' }>,
): boolean {
  return (
    left.operation === right.operation &&
    sameOperand(left.left, right.left) &&
    sameOperand(left.right, right.right) &&
    sameOutput(left.output, right.output)
  );
}

function finiteNumber(value: unknown): number | undefined {
  if (!(value instanceof LosslessJsonNumber)) return undefined;
  const number = value.toNumberIfExact();
  return number !== undefined && Number.isFinite(number) ? number : undefined;
}

function expectedPlacement(
  entity: BlueprintImportEntity,
): { readonly x: number; readonly y: number; readonly direction: number } | undefined {
  if (!(entity.position instanceof LosslessJsonObject)) return undefined;
  const x = finiteNumber(entity.position.get('x'));
  const y = finiteNumber(entity.position.get('y'));
  const direction = finiteNumber(entity.direction);
  if (
    x === undefined ||
    y === undefined ||
    direction === undefined ||
    !Number.isInteger(direction) ||
    direction < 0 ||
    direction > 15
  ) {
    return undefined;
  }
  return { x, y, direction };
}

function samePlacement(
  actual: EntityPhysicalRecord['placement'],
  expected: { readonly x: number; readonly y: number; readonly direction: number },
): boolean {
  return (
    actual !== undefined &&
    sameNumber(actual.x, expected.x) &&
    sameNumber(actual.y, expected.y) &&
    actual.direction !== undefined &&
    sameNumber(actual.direction, expected.direction)
  );
}

function containsRequiredDestinations(
  actual: readonly NetworkId[],
  expected: CanonicalBlueprintImportEntity['outputNetworks'],
  remap: ReadonlyMap<NetworkId, NetworkId>,
): boolean {
  // Imported physical attachments are required; additional compiler-owned unused output views
  // are allowed here and are checked for endpoint/wire effects by the native projection below.
  const expectedNetworks = [expected.red, expected.green]
    .filter((network): network is NetworkId => network !== undefined)
    .map((network) => remap.get(network));
  if (
    expectedNetworks.some((network) => network === undefined) ||
    new Set(actual).size !== actual.length
  ) {
    return false;
  }
  const actualSet = new Set(actual);
  return expectedNetworks.every((network) => actualSet.has(network!));
}

function sameImportedOutputs(
  actual: CanonicalBlueprintImportEntity['outputNetworks'],
  expected: CanonicalBlueprintImportEntity['outputNetworks'],
  remap: ReadonlyMap<NetworkId, NetworkId>,
): boolean {
  for (const color of ['red', 'green'] as const) {
    const expectedNetwork = expected[color];
    const actualNetwork = actual[color];
    if (expectedNetwork === undefined || actualNetwork === undefined) {
      if (expectedNetwork !== actualNetwork) return false;
    } else if (remap.get(expectedNetwork) !== actualNetwork) {
      return false;
    }
  }
  return true;
}

function componentSignature(
  network: CanonicalBlueprintImportNetwork,
  entityNumber: (nativeEntityNumber: number) => number | undefined,
): string | undefined {
  const endpoints: string[] = [];
  for (const endpoint of network.component.endpoints) {
    const originalEntityNumber = entityNumber(endpoint.entityNumber);
    if (originalEntityNumber === undefined) return undefined;
    endpoints.push(`${originalEntityNumber}:${endpoint.connectorId}`);
  }
  endpoints.sort();
  return `${network.component.color}|${endpoints.join(',')}`;
}

function hasError(diagnostics: readonly CanonicalBlueprintSourceVerificationDiagnostic[]): boolean {
  return diagnostics.some(
    (diagnostic) => 'severity' in diagnostic && diagnostic.severity === 'error',
  );
}

function appendDiagnostics(
  target: CanonicalBlueprintSourceVerificationDiagnostic[],
  source: readonly CanonicalBlueprintSourceVerificationDiagnostic[],
): void {
  for (const diagnostic of source) target.push(snapshotDiagnostic(diagnostic));
}

function appendMismatch(
  diagnostics: CanonicalBlueprintSourceVerificationDiagnostic[],
  path: string,
  message: string,
  source?: SourceSpan,
  entityNumber?: number,
): void {
  diagnostics.push(mismatch(path, message, source, entityNumber));
}

function rootSourceForEntity(entity: BlueprintSourceEntityCorrespondence): SourceSpan {
  return entity.constructionSpan;
}

function verifyEntityAndNetworkCorrespondence(
  assembled: Extract<CanonicalBlueprintSourceResult, { state: 'complete' }>,
  bridgeEntities: readonly CanonicalBlueprintImportEntity[],
  bridgeNetworks: readonly CanonicalBlueprintImportNetwork[],
  ir: NativeCircuitIr,
  diagnostics: CanonicalBlueprintSourceVerificationDiagnostic[],
): {
  readonly entities: readonly MatchedEntity[];
  readonly networkMap: ReadonlyMap<NetworkId, NetworkId>;
} {
  const expectedByNumber = new Map<number, ExpectedEntity>();
  const inventoryByNumber = new Map<number, BlueprintImportEntity>();
  for (const entity of assembled.analysis.entities ?? []) {
    inventoryByNumber.set(entity.entityNumber, entity);
  }
  const bridgeByNumber = new Map<number, CanonicalBlueprintImportEntity>();
  for (const entity of bridgeEntities) bridgeByNumber.set(entity.entityNumber, entity);
  for (const correspondence of assembled.correspondence.entities) {
    const imported = bridgeByNumber.get(correspondence.entityNumber);
    const inventory = inventoryByNumber.get(correspondence.entityNumber);
    if (
      imported === undefined ||
      inventory === undefined ||
      imported.path !== correspondence.path ||
      imported.family !== correspondence.family
    ) {
      appendMismatch(
        diagnostics,
        correspondence.path,
        'Assembly entity correspondence does not match the canonical inventory.',
        rootSourceForEntity(correspondence),
        correspondence.entityNumber,
      );
      continue;
    }
    if (expectedByNumber.has(correspondence.entityNumber)) {
      appendMismatch(
        diagnostics,
        correspondence.path,
        'Assembly contains duplicate entity correspondence.',
        rootSourceForEntity(correspondence),
        correspondence.entityNumber,
      );
      continue;
    }
    expectedByNumber.set(correspondence.entityNumber, { imported, correspondence, inventory });
  }
  if (expectedByNumber.size !== bridgeEntities.length) {
    appendMismatch(
      diagnostics,
      '$.correspondence.entities',
      'Assembly correspondence does not cover every canonical entity exactly once.',
    );
  }

  const networkRowsById = new Map<NetworkId, BlueprintSourceNetworkCorrespondence>();
  for (const row of assembled.correspondence.networks) {
    if (networkRowsById.has(row.network)) {
      appendMismatch(
        diagnostics,
        '$.correspondence.networks',
        'Assembly contains duplicate imported Network correspondence.',
        row.declarationSpan,
      );
    } else networkRowsById.set(row.network, row);
  }
  const expectedNetworks = new Map(bridgeNetworks.map((network) => [network.network, network]));
  if (
    networkRowsById.size !== expectedNetworks.size ||
    [...expectedNetworks.keys()].some((network) => !networkRowsById.has(network))
  ) {
    appendMismatch(
      diagnostics,
      '$.correspondence.networks',
      'Assembly Network correspondence does not cover every canonical component exactly once.',
    );
  }

  const networkRowsByName = indexBy(ir.networks, (network) => network.name ?? '');
  const compiledByImportedNetwork = new Map<NetworkId, NetworkId>();
  const importedByCompiledNetwork = new Map<NetworkId, NetworkId>();
  const seenNetworkNames = new Set<string>();
  for (const expected of bridgeNetworks) {
    const row = networkRowsById.get(expected.network);
    if (row === undefined) continue;
    if (seenNetworkNames.has(row.name)) {
      appendMismatch(
        diagnostics,
        row.name,
        'Imported Network declarations must have unique generated names.',
        row.declarationSpan,
      );
      continue;
    }
    seenNetworkNames.add(row.name);
    const expectedDeclaration = `const ${row.name} = new Network<${expected.component.color === 'red' ? 'R' : 'G'}>();`;
    if (
      assembled.source.text.slice(row.declarationSpan.start, row.declarationSpan.end) !==
      expectedDeclaration
    ) {
      appendMismatch(
        diagnostics,
        row.name,
        'Recorded Network declaration span does not contain the expected generated declaration.',
        row.declarationSpan,
      );
      continue;
    }
    const candidates = (networkRowsByName.get(row.name) ?? []).filter(
      (candidate) =>
        rootInstance(candidate.provenance.instancePath) &&
        spanWithin(candidate.provenance.source, row.declarationSpan),
    );
    if (candidates.length !== 1) {
      appendMismatch(
        diagnostics,
        row.name,
        candidates.length === 0
          ? 'No root compiled Network matches the generated declaration and source span.'
          : 'More than one compiled Network matches the generated declaration and source span.',
        row.declarationSpan,
      );
      continue;
    }
    const candidate = candidates[0]!;
    if (
      candidate.color !== expected.component.color ||
      candidate.fixedColor !== expected.component.color
    ) {
      appendMismatch(
        diagnostics,
        row.name,
        'Compiled Network color does not match its imported component.',
        row.declarationSpan,
      );
      continue;
    }
    if (
      importedByCompiledNetwork.has(candidate.id) ||
      compiledByImportedNetwork.has(expected.network)
    ) {
      appendMismatch(
        diagnostics,
        row.name,
        'Distinct imported components must map to distinct compiled Networks.',
        row.declarationSpan,
      );
      continue;
    }
    compiledByImportedNetwork.set(expected.network, candidate.id);
    importedByCompiledNetwork.set(candidate.id, expected.network);
  }

  const producersBySource = indexBy(
    ir.producers,
    (producer) => sourceKey(producer.provenance.source) ?? '',
  );
  const physicalById = new Map(ir.entities.map((entity) => [entity.id, entity] as const));
  if (physicalById.size !== ir.entities.length) {
    appendMismatch(
      diagnostics,
      '$.resolvedCircuit.ir.entities',
      'Physical Entity IDs are not unique.',
    );
  }
  if (ir.entities.length !== assembled.correspondence.entities.length) {
    appendMismatch(
      diagnostics,
      '$.resolvedCircuit.ir.entities',
      'Resolved circuit contains extra or missing physical Entities.',
    );
  }
  if (ir.producers.length !== assembled.correspondence.entities.length) {
    appendMismatch(
      diagnostics,
      '$.resolvedCircuit.ir.producers',
      'Resolved circuit contains extra or missing producers.',
    );
  }

  const matchedEntities: MatchedEntity[] = [];
  const usedProducerIds = new Set<ProducerId>();
  const usedEntityIds = new Set<EntityId>();
  for (const expected of expectedByNumber.values()) {
    const { imported, correspondence, inventory } = expected;
    const source = correspondence.constructionSpan;
    const candidates = producersBySource.get(sourceKey(source) ?? '') ?? [];
    if (candidates.length !== 1) {
      appendMismatch(
        diagnostics,
        correspondence.path,
        candidates.length === 0
          ? 'No producer has the exact constructor source span.'
          : 'Multiple producers have the same constructor source span.',
        source,
        correspondence.entityNumber,
      );
      continue;
    }
    const producer = candidates[0]!;
    if (
      !sameSpan(producer.provenance.source, source) ||
      !rootInstance(producer.provenance.instancePath)
    ) {
      appendMismatch(
        diagnostics,
        correspondence.path,
        'Generated constructor provenance must match exactly at the root source instance.',
        source,
        correspondence.entityNumber,
      );
      continue;
    }
    if (producer.kind !== imported.family) {
      appendMismatch(
        diagnostics,
        correspondence.path,
        'Producer family does not match the imported constructor family.',
        source,
        correspondence.entityNumber,
      );
      continue;
    }
    if (producer.entityId === undefined) {
      appendMismatch(
        diagnostics,
        correspondence.path,
        'Generated producer is not linked to a physical Entity.',
        source,
        correspondence.entityNumber,
      );
      continue;
    }
    const physical = physicalById.get(producer.entityId);
    if (
      physical === undefined ||
      usedProducerIds.has(producer.id) ||
      usedEntityIds.has(producer.entityId)
    ) {
      appendMismatch(
        diagnostics,
        correspondence.path,
        'Producer-to-Entity association is missing, duplicated, or not one-to-one.',
        source,
        correspondence.entityNumber,
      );
      continue;
    }
    usedProducerIds.add(producer.id);
    usedEntityIds.add(producer.entityId);
    if (
      !sameSpan(physical.provenance.source, source) ||
      !rootInstance(physical.provenance.instancePath)
    ) {
      appendMismatch(
        diagnostics,
        correspondence.path,
        'Linked physical Entity provenance must match the exact root constructor source span.',
        source,
        correspondence.entityNumber,
      );
    }
    matchedEntities.push({ ...expected, producer, physical, nativeEntityNumber: 0 });
  }
  if (usedProducerIds.size !== ir.producers.length || usedEntityIds.size !== ir.entities.length) {
    appendMismatch(
      diagnostics,
      '$.resolvedCircuit.ir',
      'Every producer and physical Entity must belong to exactly one imported source site.',
    );
  }

  return { entities: matchedEntities, networkMap: compiledByImportedNetwork };
}

/**
 * Structurally checks that ordinary compilation artifacts agree with one assembled source snapshot.
 * This does not execute source, grant replay authority, or cryptographically prove that arbitrary
 * submitted artifacts were produced by that source; the caller supplies the host-owned snapshot.
 */
export function verifyCanonicalBlueprintSourceRoundTrip(
  assembled: CanonicalBlueprintSourceResult,
  compiled: CompiledCanonicalBlueprintSource,
  selections: readonly BlueprintImportProfileMappingEntry[],
  context: TrustedEntityReplayContext,
): CanonicalBlueprintSourceVerificationResult {
  const diagnostics: CanonicalBlueprintSourceVerificationDiagnostic[] = [];
  if (assembled.state === 'blocked') appendDiagnostics(diagnostics, assembled.diagnostics);
  appendDiagnostics(diagnostics, compiled.diagnostics);
  if (assembled.state === 'blocked') return result('blocked', diagnostics);

  if (compiled.source.path !== assembled.source.path) {
    appendMismatch(
      diagnostics,
      '$.source.path',
      'Compiled source path differs from the assembled snapshot.',
    );
  }
  if (compiled.source.text !== assembled.source.text) {
    appendMismatch(
      diagnostics,
      '$.source.text',
      'Compiled source text differs from the assembled snapshot.',
    );
  }
  if (compiled.plan === undefined) {
    appendMismatch(diagnostics, '$.plan', 'The compiled Direct Plan is missing.');
  }
  if (compiled.resolvedCircuit === undefined) {
    appendMismatch(diagnostics, '$.resolvedCircuit', 'The compiled ResolvedCircuit is missing.');
  }
  if (
    hasError(diagnostics) ||
    compiled.plan === undefined ||
    compiled.resolvedCircuit === undefined
  ) {
    return result('blocked', diagnostics);
  }

  const validation = validateResolvedCircuit(compiled.resolvedCircuit);
  appendDiagnostics(diagnostics, validation.diagnostics);
  if (validation.value === undefined || hasError(diagnostics))
    return result('blocked', diagnostics);
  const resolved = validation.value;
  let expectedFingerprint: string;
  try {
    expectedFingerprint = resolvedCircuitPlanFingerprint(compiled.plan);
  } catch (error) {
    if (!(error instanceof TypeError)) throw error;
    appendMismatch(diagnostics, '$.plan', `Direct Plan cannot be fingerprinted: ${error.message}`);
    return result('blocked', diagnostics);
  }
  if (resolved.planFingerprint !== expectedFingerprint) {
    appendMismatch(
      diagnostics,
      '$.resolvedCircuit.planFingerprint',
      'ResolvedCircuit fingerprint does not match the supplied Direct Plan.',
    );
    return result('blocked', diagnostics);
  }

  const bridge = analyzeCanonicalBlueprintImport(assembled.analysis, selections, context);
  appendDiagnostics(diagnostics, bridge.diagnostics);
  if (bridge.state === 'blocked') return result('blocked', diagnostics);

  const matched = verifyEntityAndNetworkCorrespondence(
    assembled,
    bridge.entities,
    bridge.networks,
    resolved.ir,
    diagnostics,
  );
  const expectedByNumber = new Map(
    bridge.entities.map((entity) => [entity.entityNumber, entity] as const),
  );
  const selectionByNumber = new Map(
    selections.map((selection) => [selection.entityNumber, selection] as const),
  );
  const correspondenceByNumber = new Map(
    assembled.correspondence.entities.map((row) => [row.entityNumber, row] as const),
  );
  const finalEntities: MatchedEntity[] = [];

  for (const matchedEntity of matched.entities) {
    const { imported, correspondence, inventory, producer, physical } = matchedEntity;
    const source = correspondence.constructionSpan;
    const selected = selectionByNumber.get(correspondence.entityNumber);
    const expectedImported = expectedByNumber.get(correspondence.entityNumber);
    if (selected === undefined || expectedImported === undefined) {
      appendMismatch(
        diagnostics,
        correspondence.path,
        'Original trusted profile selection is missing for the imported Entity.',
        source,
        correspondence.entityNumber,
      );
      continue;
    }
    const expectedProfile = resolveEntityReplayProfile(selected.profile, context);
    if (
      physical.prototypeName !==
        (imported.family === 'constant' ? 'constant-combinator' : 'arithmetic-combinator') ||
      !sameProfileRef(physical.profile, expectedProfile.ref)
    ) {
      appendMismatch(
        diagnostics,
        correspondence.path,
        'Linked physical Entity prototype/profile differs from the selected trusted profile.',
        source,
        correspondence.entityNumber,
      );
    }

    if (imported.family === 'constant') {
      if (
        producer.kind !== 'constant' ||
        !('configuration' in producer.config) ||
        !sameConstantConfiguration(imported.configuration, producer.config.configuration)
      ) {
        appendMismatch(
          diagnostics,
          correspondence.path,
          'Compiled Constant producer configuration differs from the imported configuration.',
          source,
          correspondence.entityNumber,
        );
      }
      if (
        physical.configuration?.mode !== 'constant' ||
        !sameConstantConfiguration(imported.configuration, physical.configuration.value)
      ) {
        appendMismatch(
          diagnostics,
          correspondence.path,
          'Linked physical Entity Constant configuration differs from the imported configuration.',
          source,
          correspondence.entityNumber,
        );
      }
    } else {
      if (
        producer.kind !== 'arithmetic' ||
        !sameArithmeticConfiguration(imported.configuration, producer.config, matched.networkMap)
      ) {
        appendMismatch(
          diagnostics,
          correspondence.path,
          'Compiled Arithmetic producer configuration or Network references differ from the import.',
          source,
          correspondence.entityNumber,
        );
      }
      if (
        producer.kind !== 'arithmetic' ||
        physical.configuration?.mode !== 'arithmetic' ||
        !sameArithmeticPhysicalConfiguration(producer.config, physical.configuration)
      ) {
        appendMismatch(
          diagnostics,
          correspondence.path,
          'Linked physical Entity Arithmetic configuration differs from its producer.',
          source,
          correspondence.entityNumber,
        );
      }
    }

    if (
      !containsRequiredDestinations(
        producer.destinations,
        imported.outputNetworks,
        matched.networkMap,
      )
    ) {
      appendMismatch(
        diagnostics,
        correspondence.path,
        'Producer is missing an imported output Network destination.',
        source,
        correspondence.entityNumber,
      );
    }
    const exactPlacement = expectedPlacement(inventory);
    if (exactPlacement === undefined || !samePlacement(physical.placement, exactPlacement)) {
      appendMismatch(
        diagnostics,
        `${inventory.path}.position`,
        'Linked physical Entity placement/direction differs from the exact source placement.',
        source,
        correspondence.entityNumber,
      );
    }
    finalEntities.push(matchedEntity);
  }

  if (diagnostics.some((diagnostic) => diagnostic.category === 'source-verification-mismatch')) {
    return result('blocked', diagnostics);
  }

  let emitted: ReturnType<typeof emitNativeBlueprintJson>;
  let fcir: ReturnType<typeof buildNativeBlueprintFcir>;
  try {
    fcir = buildNativeBlueprintFcir(resolved.ir, {
      label: 'Canonical blueprint source verification',
      maxDeciderConditionRows: 1,
    });
    emitted = emitNativeBlueprintJson(fcir);
  } catch (error) {
    if (!(error instanceof BlueprintJsonError)) throw error;
    appendMismatch(
      diagnostics,
      '$.resolvedCircuit.ir',
      `Existing native projection rejected the resolved circuit: ${error.message}`,
      error.span,
    );
    return result('blocked', diagnostics);
  }

  const expectedBySource = new Map(
    finalEntities.map(
      (entity) => [sourceKey(entity.correspondence.constructionSpan)!, entity] as const,
    ),
  );
  const finalIndexByNumber = new Map(
    finalEntities.map((entity, index) => [entity.correspondence.entityNumber, index] as const),
  );
  const nativeByOriginal = new Map<number, number>();
  const originalByNative = new Map<number, number>();
  const nativeBySource = indexBy(fcir.entities, (entity) => sourceKey(entity.source) ?? '');
  for (const [key, candidates] of nativeBySource) {
    const expected = expectedBySource.get(key);
    if (expected === undefined || candidates.length !== 1) {
      appendMismatch(
        diagnostics,
        '$.nativeProjection.entities',
        'Projected native Entity lacks one exact constructor source association.',
        candidates[0]?.source,
      );
      continue;
    }
    const nativeEntityNumber = candidates[0]!.entityNumber;
    const originalEntityNumber = expected.correspondence.entityNumber;
    if (nativeByOriginal.has(originalEntityNumber) || originalByNative.has(nativeEntityNumber)) {
      appendMismatch(
        diagnostics,
        expected.correspondence.path,
        'Native Entity numbering association is not one-to-one.',
        expected.correspondence.constructionSpan,
        originalEntityNumber,
      );
      continue;
    }
    nativeByOriginal.set(originalEntityNumber, nativeEntityNumber);
    originalByNative.set(nativeEntityNumber, originalEntityNumber);
    const index = finalIndexByNumber.get(originalEntityNumber);
    if (index !== undefined)
      finalEntities[index] = { ...finalEntities[index]!, nativeEntityNumber };
  }
  if (
    fcir.entities.length !== finalEntities.length ||
    nativeByOriginal.size !== finalEntities.length
  ) {
    appendMismatch(
      diagnostics,
      '$.nativeProjection.entities',
      'Native projection contains extra or missing physical Entities.',
    );
  }
  if (diagnostics.some((diagnostic) => diagnostic.category === 'source-verification-mismatch')) {
    return result('blocked', diagnostics);
  }

  let reprojectedAnalysis: BlueprintImportAnalysis;
  try {
    const document = parseLosslessJson(JSON.stringify(emitted));
    reprojectedAnalysis = analyzeBlueprintImport(classifyBlueprintDocument(document));
  } catch (error) {
    if (!(error instanceof BlueprintDocumentError)) throw error;
    appendMismatch(
      diagnostics,
      error.path ?? '$.nativeProjection',
      `Existing native document parser rejected projected JSON: ${error.message}`,
    );
    return result('blocked', diagnostics);
  }

  const reprojectedSelections: BlueprintImportProfileMappingEntry[] = [];
  for (const entity of finalEntities) {
    const selection = selectionByNumber.get(entity.correspondence.entityNumber);
    if (selection === undefined || entity.nativeEntityNumber === 0) {
      appendMismatch(
        diagnostics,
        '$.nativeProjection.selections',
        'Native entity cannot be remapped to its original trusted profile selection.',
        entity.correspondence.constructionSpan,
        entity.correspondence.entityNumber,
      );
      continue;
    }
    reprojectedSelections.push({
      entityNumber: entity.nativeEntityNumber,
      profile: selection.profile,
    });
  }
  if (diagnostics.some((diagnostic) => diagnostic.category === 'source-verification-mismatch')) {
    return result('blocked', diagnostics);
  }

  const reprojected = analyzeCanonicalBlueprintImport(
    reprojectedAnalysis,
    reprojectedSelections,
    context,
  );
  appendDiagnostics(diagnostics, reprojected.diagnostics);
  if (reprojected.state === 'blocked') {
    appendMismatch(
      diagnostics,
      '$.nativeProjection',
      'Projected blueprint does not re-enter the existing canonical family bridge.',
    );
    return result('blocked', diagnostics);
  }

  const reprojectedNetworksBySignature = new Map<string, CanonicalBlueprintImportNetwork[]>();
  for (const network of reprojected.networks) {
    const signature = componentSignature(network, (nativeEntityNumber) =>
      originalByNative.get(nativeEntityNumber),
    );
    if (signature === undefined) {
      appendMismatch(
        diagnostics,
        '$.nativeProjection.networks',
        'Projected component contains an endpoint without an exact original Entity association.',
      );
      continue;
    }
    const bucket = reprojectedNetworksBySignature.get(signature);
    if (bucket === undefined) reprojectedNetworksBySignature.set(signature, [network]);
    else bucket.push(network);
  }
  const reprojectedNetworkMap = new Map<NetworkId, NetworkId>();
  const usedReprojectedNetworks = new Set<NetworkId>();
  for (const network of bridge.networks) {
    const signature = componentSignature(network, (entityNumber) => entityNumber);
    if (signature === undefined) continue;
    const candidates = reprojectedNetworksBySignature.get(signature) ?? [];
    if (
      candidates.length !== 1 ||
      usedReprojectedNetworks.has(candidates[0]?.network as NetworkId)
    ) {
      appendMismatch(
        diagnostics,
        '$.nativeProjection.networks',
        'Projected red/green component partition differs from the imported endpoint partition.',
      );
      continue;
    }
    const candidate = candidates[0]!;
    usedReprojectedNetworks.add(candidate.network);
    reprojectedNetworkMap.set(network.network, candidate.network);
  }
  if (
    reprojected.networks.length !== bridge.networks.length ||
    reprojectedNetworkMap.size !== bridge.networks.length ||
    usedReprojectedNetworks.size !== reprojected.networks.length
  ) {
    appendMismatch(
      diagnostics,
      '$.nativeProjection.networks',
      'Projected native endpoint components do not form the exact imported partition.',
    );
  }

  const reprojectedEntitiesByOriginal = new Map<number, CanonicalBlueprintImportEntity>();
  for (const entity of reprojected.entities) {
    const originalEntityNumber = originalByNative.get(entity.entityNumber);
    if (
      originalEntityNumber === undefined ||
      reprojectedEntitiesByOriginal.has(originalEntityNumber)
    ) {
      appendMismatch(
        diagnostics,
        '$.nativeProjection.entities',
        'Reprojected family entity has no unique original entity association.',
      );
      continue;
    }
    reprojectedEntitiesByOriginal.set(originalEntityNumber, entity);
  }
  if (reprojectedEntitiesByOriginal.size !== bridge.entities.length) {
    appendMismatch(
      diagnostics,
      '$.nativeProjection.entities',
      'Reprojected canonical entities do not cover the original entity set.',
    );
  }
  for (const expected of bridge.entities) {
    const actual = reprojectedEntitiesByOriginal.get(expected.entityNumber);
    if (actual === undefined || actual.family !== expected.family) {
      appendMismatch(
        diagnostics,
        expected.path,
        'Reprojected native entity family differs from the imported source.',
        correspondenceByNumber.get(expected.entityNumber)?.constructionSpan,
        expected.entityNumber,
      );
      continue;
    }
    const configurationMatches =
      expected.family === 'constant' && actual.family === 'constant'
        ? sameConstantConfiguration(expected.configuration, actual.configuration)
        : expected.family === 'arithmetic' && actual.family === 'arithmetic'
          ? sameArithmeticConfiguration(
              expected.configuration,
              actual.configuration,
              reprojectedNetworkMap,
            )
          : false;
    if (!configurationMatches) {
      appendMismatch(
        diagnostics,
        expected.path,
        'Reprojected native configuration or Arithmetic input mask differs from the imported source.',
        correspondenceByNumber.get(expected.entityNumber)?.constructionSpan,
        expected.entityNumber,
      );
    }
    if (
      !sameImportedOutputs(actual.outputNetworks, expected.outputNetworks, reprojectedNetworkMap)
    ) {
      appendMismatch(
        diagnostics,
        expected.path,
        'Reprojected native output endpoints differ from the imported output participation.',
        correspondenceByNumber.get(expected.entityNumber)?.constructionSpan,
        expected.entityNumber,
      );
    }
  }

  if (diagnostics.some((diagnostic) => diagnostic.category === 'source-verification-mismatch')) {
    return result('blocked', diagnostics);
  }

  const verifiedEntities: CanonicalBlueprintSourceEntityVerification[] = finalEntities.map(
    ({ correspondence, producer, physical, nativeEntityNumber }) => ({
      entityNumber: correspondence.entityNumber,
      producerId: producer.id,
      entityId: physical.id,
      nativeEntityNumber,
    }),
  );
  const verifiedNetworks: CanonicalBlueprintSourceNetworkVerification[] = bridge.networks.map(
    ({ network }) => ({ network, compiledNetwork: matched.networkMap.get(network)! }),
  );
  return result('verified', diagnostics, verifiedEntities, verifiedNetworks);
}

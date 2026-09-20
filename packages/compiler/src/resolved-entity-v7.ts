import type { Diagnostic, NetworkId, SourceSpan } from '@comblang/shared';
import type { DeciderOutputOrigin } from './direct-plan-schema.js';
import type { LogicalNetworkRef } from './ir.js';
import type {
  DirectElaborationPlanV7,
  EntityPhysicalRecordV7,
  EntityV7PhysicalConfiguration,
  EntityV7SelectorConfiguration,
  EntityV7SelectorPhysicalConfiguration,
  NativeCircuitIrV7,
  CircuitProducerNodeV7,
} from './entity-v7.js';
import type { EntityId } from './entity.js';
import { cloneAndDeepFreeze } from './immutable.js';
import { parseResolvedSourceCircuit } from './resolved-source-circuit.js';
import { parseResolvedEntityV4Circuit } from './resolved-entity-v4.js';
import { parseResolvedEntityV5Circuit } from './resolved-entity-v5.js';
import { parseResolvedEntityV6Circuit } from './resolved-entity-v6.js';

export const resolvedEntityV7CircuitFormat = 'comblang-resolved-entity-v7' as const;
export const resolvedEntityV7CircuitVersion = 1 as const;

/** Cloneable, already-authorized v7 physical output; no profiles or providers are carried. */
export interface ResolvedEntityV7Circuit {
  readonly format: typeof resolvedEntityV7CircuitFormat;
  readonly version: typeof resolvedEntityV7CircuitVersion;
  readonly planFingerprint: string;
  readonly ir: NativeCircuitIrV7;
}

export class ResolvedEntityV7CircuitError extends Error {
  readonly code = 'RSC7001';

  constructor(
    readonly path: string,
    readonly detail: string,
    readonly span?: SourceSpan,
  ) {
    super(`${path}: ${detail}`);
    this.name = 'ResolvedEntityV7CircuitError';
  }
}

export interface ResolvedEntityV7CircuitValidationResult {
  readonly value?: ResolvedEntityV7Circuit;
  readonly diagnostics: readonly Diagnostic[];
}

type DataRecord = Record<string, unknown>;
const maximumArrayLength = 100_000;
const syntaxIntents = new Set([
  'implicit-concrete-copy',
  'implicit-each-copy',
  'explicit-wildcard-copy',
  'explicit-constant',
  'exact',
]);

function invalid(path: string, detail: string, span?: SourceSpan): never {
  throw new ResolvedEntityV7CircuitError(path, detail, span);
}

function dataRecord(value: unknown, path: string): DataRecord {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    invalid(path, 'expected a plain data record.');
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null)
    invalid(path, 'expected a plain object or null-prototype record.');
  const output = Object.create(null) as DataRecord;
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string') invalid(`${path}[${String(key)}]`, 'symbol keys are not allowed.');
    const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
    if (!('value' in descriptor)) invalid(`${path}.${key}`, 'accessors are not allowed.');
    output[key] = descriptor.value;
  }
  return output;
}

function dataArray(value: unknown, path: string): readonly unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype)
    invalid(path, 'expected a plain array.');
  const length = Object.getOwnPropertyDescriptor(value, 'length')?.value;
  if (typeof length !== 'number' || !Number.isSafeInteger(length) || length < 0)
    invalid(`${path}.length`, 'array length must be a non-negative safe integer.');
  if (length > maximumArrayLength) invalid(path, 'array exceeds the item limit.');
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string') invalid(`${path}[${String(key)}]`, 'symbol keys are not allowed.');
    if (key === 'length') continue;
    if (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= length)
      invalid(`${path}.${key}`, 'unknown array field.');
    const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
    if (!('value' in descriptor)) invalid(`${path}[${key}]`, 'accessors are not allowed.');
  }
  return Array.from({ length }, (_, index) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (descriptor === undefined) invalid(`${path}[${index}]`, 'array holes are not allowed.');
    return descriptor.value;
  });
}

function exactKeys(record: DataRecord, allowed: readonly string[], path: string): void {
  const allowedSet = new Set(allowed);
  for (const key of Reflect.ownKeys(record)) {
    if (typeof key !== 'string' || !allowedSet.has(key))
      invalid(`${path}.${String(key)}`, 'unknown resolved v7 field.');
  }
}

function text(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.length === 0)
    invalid(path, 'expected a non-empty string.');
  return value;
}

function sourceOf(value: unknown): SourceSpan | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as DataRecord;
  return typeof record.fileId === 'string' &&
    record.fileId.length > 0 &&
    Number.isSafeInteger(record.start) &&
    Number.isSafeInteger(record.end) &&
    Number(record.start) >= 0 &&
    Number(record.end) >= Number(record.start)
    ? (record as unknown as SourceSpan)
    : undefined;
}

function parseSource(value: unknown, path: string): SourceSpan {
  const record = dataRecord(value, path);
  exactKeys(record, ['fileId', 'start', 'end'], path);
  const source = sourceOf(record);
  if (source === undefined) invalid(path, 'source span must use a valid half-open range.');
  return Object.freeze({ ...source });
}

function parseStringArray(value: unknown, path: string): readonly string[] {
  return Object.freeze(
    dataArray(value, path).map((entry, index) => text(entry, `${path}[${index}]`)),
  );
}

function stableJson(value: unknown, seen = new WeakSet<object>()): string {
  if (value === null || value === undefined) return 'null';
  if (typeof value !== 'object') return JSON.stringify(value);
  if (seen.has(value)) throw new TypeError('cyclic v7 transport data.');
  seen.add(value);
  try {
    if (Array.isArray(value)) return `[${value.map((entry) => stableJson(entry, seen)).join(',')}]`;
    const record = value as DataRecord;
    return `{${Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(record[key], seen)}`)
      .join(',')}}`;
  } finally {
    seen.delete(value);
  }
}

function parseOrigin(value: unknown, path: string, branch: 'normal' | 'else', ordinal: number) {
  const record = dataRecord(value, path);
  exactKeys(record, ['branch', 'ordinal', 'source', 'instancePath', 'syntaxIntent'], path);
  if (record.branch !== branch) invalid(`${path}.branch`, `expected ${branch} branch origin.`);
  if (record.ordinal !== ordinal) invalid(`${path}.ordinal`, `expected dense ordinal ${ordinal}.`);
  if (typeof record.syntaxIntent !== 'string' || !syntaxIntents.has(record.syntaxIntent))
    invalid(`${path}.syntaxIntent`, 'unknown Decider output syntax intent.');
  return Object.freeze({
    branch,
    ordinal,
    source: parseSource(record.source, `${path}.source`),
    instancePath: parseStringArray(record.instancePath, `${path}.instancePath`),
    syntaxIntent: record.syntaxIntent as DeciderOutputOrigin['syntaxIntent'],
  });
}

function parseOrigins(value: unknown, path: string, branch: 'normal' | 'else', count: number) {
  const entries = dataArray(value, path);
  if (entries.length !== count)
    invalid(path, 'Decider output origins must align with output rows.');
  return Object.freeze(
    entries.map((entry, index) => parseOrigin(entry, `${path}[${index}]`, branch, index)),
  );
}

function producerKeys(kind: string): readonly string[] {
  const common = ['id', 'kind', 'config', 'destinations', 'provenance', 'placement'];
  if (kind === 'decider') return [...common, 'entityId', 'outputOrigins', 'elseOutputOrigins'];
  if (kind === 'constant' || kind === 'arithmetic' || kind === 'selector')
    return [...common, 'entityId'];
  return [];
}

function entityKeys(): readonly string[] {
  return [
    'id',
    'profile',
    'prototypeName',
    'configuration',
    'connectorBindings',
    'placement',
    'provenance',
    'ordinal',
  ];
}

function computedConfiguration(value: unknown): boolean {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const mode = (value as DataRecord).mode;
  return mode === 'constant' || mode === 'arithmetic' || mode === 'decider' || mode === 'selector';
}

type InheritedVersion = 3 | 4 | 5 | 6;

function inheritedVersion(
  rawProducers: readonly unknown[],
  rawEntities: readonly unknown[],
): InheritedVersion {
  let version: InheritedVersion = 3;
  for (const entry of rawProducers) {
    const producer = entry as DataRecord;
    if (!('entityId' in producer)) continue;
    if (producer.kind === 'decider') version = 6;
    else if (producer.kind === 'arithmetic' && version < 5) version = 5;
    else if (producer.kind === 'constant' && version < 4) version = 4;
  }
  for (const entry of rawEntities) {
    const entity = entry as DataRecord;
    const configuration = entity.configuration;
    if (configuration === null || typeof configuration !== 'object' || Array.isArray(configuration))
      continue;
    const mode = (configuration as DataRecord).mode;
    if (mode === 'decider') version = 6;
    else if (mode === 'arithmetic' && version < 5) version = 5;
    else if (mode === 'constant' && version < 4) version = 4;
  }
  return version;
}

function inheritedProjection(
  value: DataRecord,
  rawProducers: readonly unknown[],
  rawEntities: readonly unknown[],
  version: InheritedVersion,
): unknown {
  const ir = dataRecord(value.ir, '$.ir');
  const format =
    version === 3 ? 'comblang-resolved-source-circuit' : `comblang-resolved-entity-v${version}`;
  const fingerprint = version === 3 ? 'v1-0000000000000000' : `v${version}-0000000000000000`;
  return {
    format,
    version: 1,
    planFingerprint: fingerprint,
    ir: {
      ...ir,
      version,
      producers: rawProducers.map((entry, index) => {
        const record = dataRecord(entry, `$.ir.producers[${index}]`);
        const {
          entityId: _entityId,
          outputOrigins: _outputOrigins,
          elseOutputOrigins: _elseOutputOrigins,
          ...withoutV6Fields
        } = record;
        if (version === 6) {
          if (record.kind === 'selector') return withoutV6Fields;
          return record;
        }
        if (version === 5) {
          if (record.kind === 'decider' || record.kind === 'selector') return withoutV6Fields;
          return record;
        }
        if (version === 4) {
          if (record.kind === 'constant') {
            const {
              outputOrigins: _unusedNormal,
              elseOutputOrigins: _unusedElse,
              ...withoutOrigins
            } = record;
            return withoutOrigins;
          }
          const { entityId: _unusedEntity, ...withoutAssociation } = withoutV6Fields;
          return withoutAssociation;
        }
        return withoutV6Fields;
      }),
      entities: rawEntities.map((entry, index) => {
        const record = dataRecord(entry, `$.ir.entities[${index}]`);
        if (version !== 3) {
          const configuration =
            'configuration' in record
              ? dataRecord(record.configuration, `$.ir.entities[${index}].configuration`)
              : undefined;
          if (configuration?.mode !== 'selector') return record;
          const { configuration: _configuration, ...withoutConfiguration } = record;
          return withoutConfiguration;
        }
        if (!computedConfiguration(record.configuration)) return record;
        const { configuration: _configuration, ...withoutConfiguration } = record;
        return withoutConfiguration;
      }),
    },
  };
}

function selectorPhysicalConfiguration(value: DataRecord): EntityV7PhysicalConfiguration {
  if (value.mode !== 'selector') invalid('$.ir.entities.configuration.mode', 'expected selector.');
  if (value.operation === 'select') {
    exactKeys(value, ['mode', 'operation', 'input', 'selectMax', 'index'], '$.configuration');
    if (typeof value.selectMax !== 'boolean')
      invalid('$.configuration.selectMax', 'expected boolean.');
    if (value.index === undefined) invalid('$.configuration.index', 'index is required.');
    return value as unknown as EntityV7PhysicalConfiguration;
  }
  if (value.operation === 'count') {
    exactKeys(value, ['mode', 'operation', 'input', 'output'], '$.configuration');
    return value as unknown as EntityV7PhysicalConfiguration;
  }
  invalid('$.configuration.operation', 'unknown Selector operation.');
}

function parseValue(value: unknown): ResolvedEntityV7Circuit {
  const record = dataRecord(value, '$');
  exactKeys(record, ['format', 'version', 'planFingerprint', 'ir'], '$');
  if (record.format !== resolvedEntityV7CircuitFormat)
    invalid('$.format', 'unsupported resolved Entity v7 circuit format.');
  if (record.version !== resolvedEntityV7CircuitVersion)
    invalid('$.version', 'unsupported resolved Entity v7 circuit version.');
  const fingerprint = text(record.planFingerprint, '$.planFingerprint');
  if (!/^v7-[0-9a-f]{16}$/.test(fingerprint))
    invalid('$.planFingerprint', 'expected a canonical v7 plan fingerprint.');
  const ir = dataRecord(record.ir, '$.ir');
  exactKeys(ir, ['format', 'version', 'context', 'networks', 'producers', 'entities'], '$.ir');
  if (ir.format !== 'comblang-ncir' || ir.version !== 7)
    invalid('$.ir', 'resolved v7 IR requires version 7.');
  const rawProducers = dataArray(ir.producers, '$.ir.producers');
  const rawEntities = dataArray(ir.entities, '$.ir.entities');
  rawProducers.forEach((entry, index) => {
    const path = `$.ir.producers[${index}]`;
    const producer = dataRecord(entry, path);
    const kind = typeof producer.kind === 'string' ? producer.kind : '';
    const keys = producerKeys(kind);
    if (keys.length === 0)
      invalid(`${path}.kind`, 'unknown Producer tag.', sourceOf(producer.provenance));
    exactKeys(producer, keys, path);
    if ('entityId' in producer) text(producer.entityId, `${path}.entityId`);
    if ('entityId' in producer && 'placement' in producer)
      invalid(`${path}.placement`, 'linked producer placement must be omitted.');
    if (kind === 'decider') {
      if (!('outputOrigins' in producer))
        invalid(`${path}.outputOrigins`, 'v7 Decider output origins are required.');
      if ('elseOutputOrigins' in producer && producer.elseOutputOrigins === undefined)
        invalid(`${path}.elseOutputOrigins`, 'optional origin arrays must be omitted when unused.');
    }
  });
  rawEntities.forEach((entry, index) => {
    const path = `$.ir.entities[${index}]`;
    const entity = dataRecord(entry, path);
    exactKeys(entity, entityKeys(), path);
    if ('configuration' in entity && computedConfiguration(entity.configuration)) {
      const configuration = dataRecord(entity.configuration, `${path}.configuration`);
      if (configuration.mode === 'selector') selectorPhysicalConfiguration(configuration);
      else if (configuration.mode === 'constant')
        exactKeys(configuration, ['mode', 'value'], `${path}.configuration`);
      else if (configuration.mode === 'arithmetic')
        exactKeys(
          configuration,
          ['mode', 'left', 'operation', 'right', 'output'],
          `${path}.configuration`,
        );
      else
        exactKeys(
          configuration,
          ['mode', 'condition', 'outputs', 'elseOutputs'],
          `${path}.configuration`,
        );
    }
  });

  const version = inheritedVersion(rawProducers, rawEntities);
  let base;
  try {
    const projected = inheritedProjection(record, rawProducers, rawEntities, version);
    base =
      version === 6
        ? parseResolvedEntityV6Circuit(projected).ir
        : version === 5
          ? parseResolvedEntityV5Circuit(projected).ir
          : version === 4
            ? parseResolvedEntityV4Circuit(projected).ir
            : parseResolvedSourceCircuit(projected).ir;
  } catch (error) {
    invalid('$.ir', error instanceof Error ? error.message : 'invalid v7 physical circuit.');
  }
  const entityById = new Map(base.entities.map((entity) => [entity.id, entity]));
  const associated = new Map<EntityId, number>();
  const producers: CircuitProducerNodeV7[] = base.producers.map((producer, index) => {
    const raw = dataRecord(rawProducers[index], `$.ir.producers[${index}]`);
    const entityId =
      'entityId' in raw
        ? (text(raw.entityId, `$.ir.producers[${index}].entityId`) as EntityId)
        : undefined;
    if (entityId !== undefined) {
      if (associated.has(entityId))
        invalid(
          `$.ir.producers[${index}].entityId`,
          'an Entity may have only one linked producer.',
        );
      if (!entityById.has(entityId))
        invalid(`$.ir.producers[${index}].entityId`, 'linked Entity does not exist.');
      associated.set(entityId, index);
    }
    if (producer.kind !== 'decider')
      return Object.freeze({
        ...producer,
        ...(entityId === undefined ? {} : { entityId }),
      }) as CircuitProducerNodeV7;
    const normal = parseOrigins(
      raw.outputOrigins,
      `$.ir.producers[${index}].outputOrigins`,
      'normal',
      producer.config.outputs.length,
    );
    const alternate =
      producer.config.elseOutputs === undefined
        ? undefined
        : parseOrigins(
            raw.elseOutputOrigins,
            `$.ir.producers[${index}].elseOutputOrigins`,
            'else',
            producer.config.elseOutputs.length,
          );
    if (producer.config.elseOutputs === undefined && 'elseOutputOrigins' in raw)
      invalid(`$.ir.producers[${index}].elseOutputOrigins`, 'origins require elseOutputs.');
    if (producer.config.elseOutputs !== undefined && !('elseOutputOrigins' in raw))
      invalid(`$.ir.producers[${index}].elseOutputOrigins`, 'else output origins are required.');
    return Object.freeze({
      ...producer,
      ...(entityId === undefined ? {} : { entityId }),
      outputOrigins: normal,
      ...(alternate === undefined ? {} : { elseOutputOrigins: alternate }),
    }) as unknown as CircuitProducerNodeV7;
  });
  const entities: EntityPhysicalRecordV7[] = base.entities.map((entity, index) => {
    const raw = dataRecord(rawEntities[index], `$.ir.entities[${index}]`);
    if (!('configuration' in raw) || !computedConfiguration(raw.configuration))
      return entity as EntityPhysicalRecordV7;
    const configuration = dataRecord(raw.configuration, `$.ir.entities[${index}].configuration`);
    if (configuration.mode !== 'selector') return entity as EntityPhysicalRecordV7;
    return {
      ...entity,
      configuration: selectorPhysicalConfiguration(configuration),
    } as EntityPhysicalRecordV7;
  });
  const selectorLinks = [...associated.entries()].filter(
    ([, index]) => producers[index]?.kind === 'selector',
  );
  if (selectorLinks.length === 0)
    invalid(
      '$.ir.producers',
      'resolved Entity v7 circuits require at least one linked Selector producer.',
    );
  for (const [entityId, producerIndex] of selectorLinks) {
    const entity = entities.find((candidate) => candidate.id === entityId);
    const producer = producers[producerIndex];
    if (entity === undefined || producer?.kind !== 'selector')
      invalid('$.ir', 'linked Selector family does not match.');
    if (entity.profile.prototypeKey !== 'entity:selector-combinator')
      invalid(
        `$.ir.entities[${entityId}].profile`,
        'linked Selector profile must identify entity:selector-combinator.',
      );
    if (entity.prototypeName !== 'selector-combinator')
      invalid(
        `$.ir.entities[${entityId}].prototypeName`,
        'linked Selector prototype name must be selector-combinator.',
      );
    if (entity.configuration?.mode !== 'selector')
      invalid(
        `$.ir.entities[${entityId}].configuration`,
        'linked Selector Entity configuration is required.',
      );
    if (stableJson(entity.configuration) !== stableJson({ mode: 'selector', ...producer.config }))
      invalid(
        `$.ir.entities[${entityId}].configuration`,
        'Selector producer configuration must equal the linked Entity configuration.',
      );
  }
  return cloneAndDeepFreeze({
    format: resolvedEntityV7CircuitFormat,
    version: resolvedEntityV7CircuitVersion,
    planFingerprint: fingerprint,
    ir: {
      format: 'comblang-ncir',
      version: 7,
      context: base.context,
      networks: base.networks,
      producers,
      entities,
    },
  }) as ResolvedEntityV7Circuit;
}

export function resolvedEntityV7CircuitPlanFingerprint(plan: DirectElaborationPlanV7): string {
  let hash = 0xcbf29ce484222325n;
  const serialized = stableJson(plan);
  for (let index = 0; index < serialized.length; index += 1) {
    hash ^= BigInt(serialized.charCodeAt(index));
    hash = (hash * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  return `v7-${hash.toString(16).padStart(16, '0')}`;
}

function physicalSelectorConfiguration(
  configuration: EntityV7SelectorConfiguration,
  networkIds: ReadonlyMap<string, NetworkId>,
): EntityV7SelectorPhysicalConfiguration {
  const networkRef = (value: EntityV7SelectorConfiguration['input']): LogicalNetworkRef =>
    value.refKind === 'single'
      ? {
          refKind: 'single',
          network: networkIds.get(value.network) ?? (value.network as NetworkId),
        }
      : {
          refKind: 'pair',
          networks: [
            networkIds.get(value.networks[0]) ?? (value.networks[0] as NetworkId),
            networkIds.get(value.networks[1]) ?? (value.networks[1] as NetworkId),
          ],
        };
  return configuration.operation === 'select'
    ? { ...configuration, mode: 'selector', input: networkRef(configuration.input) }
    : { ...configuration, mode: 'selector', input: networkRef(configuration.input) };
}

export function assertResolvedEntityV7CircuitMatchesPlan(
  plan: DirectElaborationPlanV7,
  artifact: ResolvedEntityV7Circuit,
): void {
  if (artifact.planFingerprint !== resolvedEntityV7CircuitPlanFingerprint(plan))
    invalid(
      '$.planFingerprint',
      'resolved v7 circuit fingerprint does not match the current plan.',
    );
  if (stableJson(plan.context) !== stableJson(artifact.ir.context))
    invalid('$.ir.context', 'resolved v7 circuit context does not match the current plan.');
  if (
    plan.producers.length !== artifact.ir.producers.length ||
    plan.entities.length !== artifact.ir.entities.length
  )
    invalid('$.ir', 'resolved v7 circuit cardinality does not match the current plan.');
  const networkIds = new Map(
    artifact.ir.networks.map((network) => [network.name ?? network.id, network.id] as const),
  );
  const entities = new Map(artifact.ir.entities.map((entity) => [entity.id, entity]));
  let linkedSelector = false;
  for (const entity of plan.entities) {
    const physical = entities.get(entity.id);
    if (
      physical === undefined ||
      physical.ordinal !== entity.ordinal ||
      stableJson(physical.profile) !== stableJson(entity.profile)
    )
      invalid(`$.ir.entities[${entity.id}]`, 'resolved v7 Entity does not match the current plan.');
    if (entity.configuration?.mode === 'selector') {
      const expected = physicalSelectorConfiguration(entity.configuration, networkIds);
      if (stableJson(physical.configuration) !== stableJson(expected))
        invalid(
          `$.ir.entities[${entity.id}].configuration`,
          'resolved v7 Selector Entity does not match the current plan.',
        );
      linkedSelector = true;
    }
  }
  for (const [index, producer] of plan.producers.entries()) {
    const physical = artifact.ir.producers[index];
    const physicalEntityId =
      physical !== undefined && 'entityId' in physical ? physical.entityId : undefined;
    if ((producer.entityId ?? undefined) !== (physicalEntityId ?? undefined))
      invalid(
        `$.ir.producers[${index}].entityId`,
        'resolved v7 producer association does not match the current plan.',
      );
    if (producer.kind === 'selector') {
      if (physical?.kind !== 'selector')
        invalid(`$.ir.producers[${index}]`, 'resolved v7 Selector producer kind does not match.');
      const expected =
        producer.operation === 'select'
          ? {
              operation: 'select',
              input: physicalSelectorConfiguration({ mode: 'selector', ...producer }, networkIds)
                .input,
              selectMax: producer.selectMax,
              index: producer.index,
            }
          : {
              operation: 'count',
              input: physicalSelectorConfiguration({ mode: 'selector', ...producer }, networkIds)
                .input,
              output: producer.output,
            };
      if (stableJson(physical.config) !== stableJson(expected))
        invalid(
          `$.ir.producers[${index}].config`,
          'resolved v7 Selector producer does not match the current plan.',
        );
      linkedSelector ||= producer.entityId !== undefined;
    }
    if (producer.kind === 'decider') {
      const physicalDecider =
        physical?.kind === 'decider'
          ? (physical as CircuitProducerNodeV7 & {
              readonly outputOrigins: readonly DeciderOutputOrigin[];
              readonly elseOutputOrigins?: readonly DeciderOutputOrigin[];
            })
          : undefined;
      if (
        physicalDecider === undefined ||
        stableJson(physicalDecider.outputOrigins) !== stableJson(producer.outputOrigins) ||
        stableJson(physicalDecider.elseOutputOrigins) !== stableJson(producer.elseOutputOrigins)
      )
        invalid(
          `$.ir.producers[${index}].outputOrigins`,
          'resolved v7 Decider row origins do not match the current plan.',
        );
    }
  }
  if (!linkedSelector)
    invalid('$.ir.producers', 'resolved v7 circuit has no linked Selector producer.');
}

export function snapshotResolvedEntityV7CircuitFromPlan(
  plan: DirectElaborationPlanV7,
  ir: NativeCircuitIrV7,
): ResolvedEntityV7Circuit {
  const snapshot = parseResolvedEntityV7Circuit({
    format: resolvedEntityV7CircuitFormat,
    version: resolvedEntityV7CircuitVersion,
    planFingerprint: resolvedEntityV7CircuitPlanFingerprint(plan),
    ir,
  });
  assertResolvedEntityV7CircuitMatchesPlan(plan, snapshot);
  return snapshot;
}

export function validateResolvedEntityV7Circuit(
  value: unknown,
): ResolvedEntityV7CircuitValidationResult {
  try {
    return { value: parseResolvedEntityV7Circuit(value), diagnostics: [] };
  } catch (error) {
    if (error instanceof ResolvedEntityV7CircuitError)
      return { diagnostics: [{ code: error.code, severity: 'error', message: error.message }] };
    return {
      diagnostics: [
        {
          code: 'RSC7099',
          severity: 'error',
          message: error instanceof Error ? error.message : 'Resolved Entity v7 validation failed.',
        },
      ],
    };
  }
}

export function parseResolvedEntityV7Circuit(value: unknown): ResolvedEntityV7Circuit {
  return parseValue(value);
}

export const snapshotResolvedEntityV7Circuit = parseResolvedEntityV7Circuit;

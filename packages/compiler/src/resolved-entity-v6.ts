import type { Diagnostic, SourceSpan } from '@comblang/shared';

import type {
  DeciderOutputOrigin,
  DirectElaborationPlan,
  DirectPlanDecider,
  PlanDeciderCondition,
} from './direct-plan-schema.js';
import type {
  DirectElaborationPlanV6,
  EntityPhysicalRecordV6,
  EntityV6DeciderPhysicalConfiguration,
  EntityV6DeciderConfiguration,
  NativeCircuitIrV6,
  CircuitProducerNodeV6,
} from './entity-v6.js';
import type { EntityId } from './entity.js';
import type { LogicalDeciderCondition, LogicalDeciderOutput, LogicalNetworkRef } from './ir.js';
import type { NetworkId } from '@comblang/shared';
import { cloneAndDeepFreeze } from './immutable.js';
import { parseResolvedEntityV5Circuit } from './resolved-entity-v5.js';

export const resolvedEntityV6CircuitFormat = 'comblang-resolved-entity-v6' as const;
export const resolvedEntityV6CircuitVersion = 1 as const;

/** Cloneable, already-authorized v6 physical output; no profiles or providers are carried. */
export interface ResolvedEntityV6Circuit {
  readonly format: typeof resolvedEntityV6CircuitFormat;
  readonly version: typeof resolvedEntityV6CircuitVersion;
  readonly planFingerprint: string;
  readonly ir: NativeCircuitIrV6;
}

export class ResolvedEntityV6CircuitError extends Error {
  readonly code = 'RSC6001';

  constructor(
    readonly path: string,
    readonly detail: string,
    readonly span?: SourceSpan,
  ) {
    super(`${path}: ${detail}`);
    this.name = 'ResolvedEntityV6CircuitError';
  }
}

export interface ResolvedEntityV6CircuitValidationResult {
  readonly value?: ResolvedEntityV6Circuit;
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
  throw new ResolvedEntityV6CircuitError(path, detail, span);
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
      invalid(`${path}.${String(key)}`, 'unknown resolved v6 field.');
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
  if (seen.has(value)) throw new TypeError('cyclic v6 transport data.');
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

function parseOrigin(
  value: unknown,
  path: string,
  branch: 'normal' | 'else',
  ordinal: number,
): DeciderOutputOrigin {
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

function parseOrigins(
  value: unknown,
  path: string,
  branch: 'normal' | 'else',
  count: number,
): readonly DeciderOutputOrigin[] {
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
  if (kind === 'constant' || kind === 'arithmetic') return [...common, 'entityId'];
  if (kind === 'selector') return [...common, 'entityId'];
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

function projection(
  value: DataRecord,
  producers: readonly unknown[],
  entities: readonly unknown[],
): unknown {
  const ir = dataRecord(value.ir, '$.ir');
  return {
    format: 'comblang-resolved-entity-v5',
    version: 1,
    planFingerprint: 'v5-0000000000000000',
    ir: {
      ...ir,
      version: 5,
      producers: producers.map((entry, index) => {
        const record = dataRecord(entry, `$.ir.producers[${index}]`);
        if (record.kind !== 'decider') return record;
        const {
          entityId: _entityId,
          outputOrigins: _outputOrigins,
          elseOutputOrigins: _elseOutputOrigins,
          ...withoutV6Fields
        } = record;
        return withoutV6Fields;
      }),
      entities: entities.map((entry, index) => {
        const record = dataRecord(entry, `$.ir.entities[${index}]`);
        const configuration =
          'configuration' in record
            ? dataRecord(record.configuration, `$.ir.entities[${index}].configuration`)
            : undefined;
        if (configuration?.mode !== 'decider') return record;
        const { configuration: _configuration, ...withoutConfiguration } = record;
        return withoutConfiguration;
      }),
    },
  };
}

function parsePhysicalDeciderConfiguration(
  value: unknown,
  path: string,
  producer: Extract<CircuitProducerNodeV6, { readonly kind: 'decider' }>,
): EntityV6DeciderPhysicalConfiguration {
  const record = dataRecord(value, path);
  exactKeys(record, ['mode', 'condition', 'outputs', 'elseOutputs'], path);
  if (record.mode !== 'decider') invalid(`${path}.mode`, 'expected decider configuration.');
  const outputs = dataArray(record.outputs, `${path}.outputs`);
  const expected = producer.config;
  const hasElse = Object.prototype.hasOwnProperty.call(record, 'elseOutputs');
  if (outputs.length !== expected.outputs.length)
    invalid(path, 'Decider Entity configuration does not match its producer.');
  const elseOutputs = hasElse ? dataArray(record.elseOutputs, `${path}.elseOutputs`) : undefined;
  if ((expected.elseOutputs === undefined) !== (elseOutputs === undefined))
    invalid(path, 'Decider Entity configuration does not match its producer.');
  if (elseOutputs !== undefined && elseOutputs.length !== expected.elseOutputs!.length)
    invalid(path, 'Decider Entity configuration does not match its producer.');
  const actual = {
    condition: record.condition,
    outputs,
    ...(elseOutputs === undefined ? {} : { elseOutputs }),
  };
  const expectedShape = {
    condition: expected.condition,
    outputs: expected.outputs,
    ...(expected.elseOutputs === undefined ? {} : { elseOutputs: expected.elseOutputs }),
  };
  try {
    if (stableJson(actual) !== stableJson(expectedShape))
      invalid(path, 'Decider producer configuration must equal the linked Entity configuration.');
  } catch (error) {
    invalid(path, error instanceof Error ? error.message : 'invalid Decider configuration.');
  }
  return Object.freeze({
    mode: 'decider',
    condition: expected.condition,
    outputs: expected.outputs,
    ...(expected.elseOutputs === undefined ? {} : { elseOutputs: expected.elseOutputs }),
  });
}

function validateRawShape(
  record: DataRecord,
  rawProducers: readonly unknown[],
  rawEntities: readonly unknown[],
): void {
  exactKeys(record, ['format', 'version', 'planFingerprint', 'ir'], '$');
  if (record.format !== resolvedEntityV6CircuitFormat)
    invalid('$.format', 'unsupported resolved Entity v6 circuit format.');
  if (record.version !== resolvedEntityV6CircuitVersion)
    invalid('$.version', 'unsupported resolved Entity v6 circuit version.');
  const fingerprint = text(record.planFingerprint, '$.planFingerprint');
  if (!/^v6-[0-9a-f]{16}$/.test(fingerprint))
    invalid('$.planFingerprint', 'expected a canonical v6 plan fingerprint.');
  const ir = dataRecord(record.ir, '$.ir');
  exactKeys(ir, ['format', 'version', 'context', 'networks', 'producers', 'entities'], '$.ir');
  if (ir.format !== 'comblang-ncir' || ir.version !== 6)
    invalid('$.ir', 'resolved v6 IR requires version 6.');
  rawProducers.forEach((entry, index) => {
    const path = `$.ir.producers[${index}]`;
    const producer = dataRecord(entry, path);
    const kind = typeof producer.kind === 'string' ? producer.kind : '';
    const keys = producerKeys(kind);
    if (keys.length === 0)
      invalid(`${path}.kind`, 'unknown Producer tag.', sourceOf(producer.provenance));
    exactKeys(producer, keys, path);
    if (kind === 'decider') {
      if (!('outputOrigins' in producer))
        invalid(`${path}.outputOrigins`, 'v6 Decider output origins are required.');
      if ('elseOutputOrigins' in producer && producer.elseOutputOrigins === undefined)
        invalid(`${path}.elseOutputOrigins`, 'optional origin arrays must be omitted when unused.');
    }
    if ('entityId' in producer) text(producer.entityId, `${path}.entityId`);
    if ('entityId' in producer && 'placement' in producer)
      invalid(`${path}.placement`, 'linked producer placement must be omitted.');
  });
  rawEntities.forEach((entry, index) => {
    const path = `$.ir.entities[${index}]`;
    const entity = dataRecord(entry, path);
    exactKeys(entity, entityKeys(), path);
    if ('configuration' in entity) {
      const configuration = dataRecord(entity.configuration, `${path}.configuration`);
      if (configuration.mode === 'decider')
        exactKeys(
          configuration,
          ['mode', 'condition', 'outputs', 'elseOutputs'],
          `${path}.configuration`,
        );
    }
  });
}

function parseValue(value: unknown): ResolvedEntityV6Circuit {
  const record = dataRecord(value, '$');
  const irRecord = dataRecord(record.ir, '$.ir');
  const rawProducers = dataArray(irRecord.producers, '$.ir.producers');
  const rawEntities = dataArray(irRecord.entities, '$.ir.entities');
  validateRawShape(record, rawProducers, rawEntities);
  let base;
  try {
    base = parseResolvedEntityV5Circuit(projection(record, rawProducers, rawEntities));
  } catch (error) {
    invalid('$.ir', error instanceof Error ? error.message : 'invalid v6 physical circuit.');
  }
  const entityById = new Map(base.ir.entities.map((entity) => [entity.id, entity]));
  const associated = new Map<EntityId, number>();
  const producers: CircuitProducerNodeV6[] = base.ir.producers.map((producer, index) => {
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
    if (producer.kind !== 'decider') return producer as CircuitProducerNodeV6;
    const decider = producer;
    const normal = parseOrigins(
      raw.outputOrigins,
      `$.ir.producers[${index}].outputOrigins`,
      'normal',
      decider.config.outputs.length,
    );
    const alternate =
      decider.config.elseOutputs === undefined
        ? undefined
        : parseOrigins(
            raw.elseOutputOrigins,
            `$.ir.producers[${index}].elseOutputOrigins`,
            'else',
            decider.config.elseOutputs.length,
          );
    if (decider.config.elseOutputs === undefined && 'elseOutputOrigins' in raw)
      invalid(`$.ir.producers[${index}].elseOutputOrigins`, 'origins require elseOutputs.');
    if (decider.config.elseOutputs !== undefined && !('elseOutputOrigins' in raw))
      invalid(`$.ir.producers[${index}].elseOutputOrigins`, 'else output origins are required.');
    return Object.freeze({
      ...decider,
      ...(entityId === undefined ? {} : { entityId }),
      outputOrigins: normal,
      ...(alternate === undefined ? {} : { elseOutputOrigins: alternate }),
    }) as unknown as CircuitProducerNodeV6;
  });
  const configurations = new Map<EntityId, EntityV6DeciderPhysicalConfiguration>();
  for (const [index, raw] of rawEntities.entries()) {
    const entity = dataRecord(raw, `$.ir.entities[${index}]`);
    const configuration =
      'configuration' in entity
        ? dataRecord(entity.configuration, `$.ir.entities[${index}].configuration`)
        : undefined;
    if (configuration?.mode !== 'decider') continue;
    const id = text(entity.id, `$.ir.entities[${index}].id`) as EntityId;
    const producerIndex = associated.get(id);
    if (producerIndex === undefined)
      invalid(
        `$.ir.entities[${index}].configuration`,
        'configured Decider Entity must have one linked producer.',
      );
    const producer = producers[producerIndex];
    if (producer?.kind !== 'decider')
      invalid(`$.ir.producers[${producerIndex}].entityId`, 'linked Entity family does not match.');
    const profile = entityById.get(id)?.profile;
    if (profile?.prototypeKey !== 'entity:decider-combinator')
      invalid(
        `$.ir.entities[${index}].profile`,
        'linked Entity profile must identify the decider-combinator family.',
      );
    if (entityById.get(id)?.prototypeName !== 'decider-combinator')
      invalid(
        `$.ir.entities[${index}].prototypeName`,
        'linked Entity prototype name must be decider-combinator.',
      );
    configurations.set(
      id,
      parsePhysicalDeciderConfiguration(
        configuration,
        `$.ir.entities[${index}].configuration`,
        producer,
      ),
    );
  }
  for (const [id, producerIndex] of associated) {
    const producer = producers[producerIndex];
    if (producer?.kind === 'decider' && !configurations.has(id))
      invalid(
        `$.ir.producers[${producerIndex}].entityId`,
        'linked Decider Entity must declare decider configuration.',
      );
  }
  for (const [index, raw] of rawEntities.entries()) {
    const id = text(
      dataRecord(raw, `$.ir.entities[${index}]`).id,
      `$.ir.entities[${index}].id`,
    ) as EntityId;
    const configuration = configurations.get(id);
    if (configuration !== undefined) continue;
    if (associated.has(id) && producers[associated.get(id)!]?.kind === 'decider')
      invalid(`$.ir.entities[${index}]`, 'linked Decider Entity configuration is missing.');
  }
  if (
    !producers.some(
      (producer) =>
        producer.kind === 'decider' &&
        producer.entityId !== undefined &&
        configurations.has(producer.entityId),
    )
  )
    invalid(
      '$.ir.producers',
      'resolved Entity v6 circuits require at least one linked Decider producer.',
    );
  const entities: EntityPhysicalRecordV6[] = base.ir.entities.map((entity) => {
    const configuration = configurations.get(entity.id);
    return (
      configuration === undefined ? entity : Object.freeze({ ...entity, configuration })
    ) as EntityPhysicalRecordV6;
  });
  return cloneAndDeepFreeze({
    format: resolvedEntityV6CircuitFormat,
    version: resolvedEntityV6CircuitVersion,
    planFingerprint: text(record.planFingerprint, '$.planFingerprint'),
    ir: {
      format: 'comblang-ncir',
      version: 6,
      context: base.ir.context,
      networks: base.ir.networks,
      producers,
      entities,
    },
  }) as ResolvedEntityV6Circuit;
}

export function resolvedEntityV6CircuitPlanFingerprint(plan: DirectElaborationPlanV6): string {
  let hash = 0xcbf29ce484222325n;
  const serialized = stableJson(plan);
  for (let index = 0; index < serialized.length; index += 1) {
    hash ^= BigInt(serialized.charCodeAt(index));
    hash = (hash * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  return `v6-${hash.toString(16).padStart(16, '0')}`;
}

export function entityV6PhysicalDeciderConfiguration(
  configuration: EntityV6DeciderConfiguration,
  networkIds: ReadonlyMap<string, string>,
): EntityV6DeciderPhysicalConfiguration {
  const networkRef = (
    value:
      | { readonly refKind: 'single'; readonly network: string }
      | { readonly refKind: 'pair'; readonly networks: readonly [string, string] },
  ): LogicalNetworkRef =>
    value.refKind === 'single'
      ? {
          refKind: 'single',
          network: (networkIds.get(value.network) ?? value.network) as NetworkId,
        }
      : {
          refKind: 'pair',
          networks: [
            (networkIds.get(value.networks[0]) ?? value.networks[0]) as NetworkId,
            (networkIds.get(value.networks[1]) ?? value.networks[1]) as NetworkId,
          ] as readonly [NetworkId, NetworkId],
        };
  const condition = (value: PlanDeciderCondition): LogicalDeciderCondition => {
    if (value.kind === 'and' || value.kind === 'or')
      return { kind: value.kind, conditions: value.conditions.map(condition) };
    if (value.kind === 'compare-signals')
      return {
        kind: 'compare',
        left: { kind: 'signal', signal: value.left.signal, ...networkRef(value.left) },
        comparator: value.comparator,
        right: { kind: 'signal', signal: value.right.signal, ...networkRef(value.right) },
      };
    return {
      kind: 'compare',
      left:
        value.kind === 'compare-each'
          ? { kind: 'wildcard', value: 'each', ...networkRef(value) }
          : value.kind === 'compare-signal'
            ? { kind: 'signal', signal: value.signal, ...networkRef(value) }
            : { kind: 'wildcard', value: value.wildcard, ...networkRef(value) },
      comparator: value.comparator,
      right: { kind: 'constant', value: value.constant },
    };
  };
  const output = (value: DirectPlanDecider['output']): LogicalDeciderOutput => {
    if (value.kind === 'each-constant')
      return { mode: 'constant', signal: { kind: 'wildcard', value: 'each' }, value: value.value };
    if (value.kind === 'signal-constant')
      return {
        mode: 'constant',
        signal: { kind: 'signal', signal: value.signal },
        value: value.value,
      };
    if (value.kind === 'each')
      return {
        mode: 'copy',
        signal: { kind: 'wildcard', value: 'each' },
        input: networkRef(value),
      };
    if (value.kind === 'signal')
      return {
        mode: 'copy',
        signal: { kind: 'signal', signal: value.signal },
        input: networkRef(value),
      };
    return {
      mode: 'copy',
      signal: { kind: 'wildcard', value: value.wildcard },
      input: networkRef(value),
    };
  };
  return {
    mode: 'decider',
    condition: condition(configuration.condition),
    outputs: configuration.outputs.map(output),
    ...(configuration.elseOutputs === undefined
      ? {}
      : { elseOutputs: configuration.elseOutputs.map(output) }),
  };
}

export function assertResolvedEntityV6CircuitMatchesPlan(
  plan: DirectElaborationPlanV6,
  artifact: ResolvedEntityV6Circuit,
): void {
  if (artifact.planFingerprint !== resolvedEntityV6CircuitPlanFingerprint(plan))
    invalid(
      '$.planFingerprint',
      'resolved v6 circuit fingerprint does not match the current plan.',
    );
  if (stableJson(plan.context) !== stableJson(artifact.ir.context))
    invalid('$.ir.context', 'resolved v6 circuit context does not match the current plan.');
  if (
    plan.producers.length !== artifact.ir.producers.length ||
    plan.entities.length !== artifact.ir.entities.length
  )
    invalid('$.ir', 'resolved v6 circuit cardinality does not match the current plan.');
  const networkIds = new Map(
    artifact.ir.networks.map((network) => [network.name ?? network.id, network.id] as const),
  );
  const entities = new Map(artifact.ir.entities.map((entity) => [entity.id, entity]));
  for (const entity of plan.entities) {
    const physical = entities.get(entity.id);
    if (
      physical === undefined ||
      physical.ordinal !== entity.ordinal ||
      stableJson(physical.profile) !== stableJson(entity.profile)
    )
      invalid(`$.ir.entities[${entity.id}]`, 'resolved v6 Entity does not match the current plan.');
    if (entity.configuration?.mode === 'decider') {
      const expected = entityV6PhysicalDeciderConfiguration(entity.configuration, networkIds);
      if (stableJson(physical.configuration) !== stableJson(expected))
        invalid(
          `$.ir.entities[${entity.id}].configuration`,
          'resolved v6 Decider Entity does not match the current plan.',
        );
    } else if (
      entity.configuration !== undefined &&
      stableJson(physical.configuration) !== stableJson(entity.configuration)
    ) {
      invalid(
        `$.ir.entities[${entity.id}].configuration`,
        'resolved v6 Entity does not match the current plan.',
      );
    }
  }
  for (const [index, producer] of plan.producers.entries()) {
    const physical = artifact.ir.producers[index];
    if ((producer.entityId ?? undefined) !== (physical?.entityId ?? undefined))
      invalid(
        `$.ir.producers[${index}].entityId`,
        'resolved v6 producer association does not match the current plan.',
      );
    if (producer.kind === 'decider') {
      if (
        physical?.kind !== 'decider' ||
        stableJson(physical.outputOrigins) !== stableJson(producer.outputOrigins) ||
        stableJson(physical.elseOutputOrigins) !== stableJson(producer.elseOutputOrigins)
      )
        invalid(
          `$.ir.producers[${index}].outputOrigins`,
          'resolved v6 Decider row origins do not match the current plan.',
        );
    }
  }
}

export function snapshotResolvedEntityV6CircuitFromPlan(
  plan: DirectElaborationPlanV6,
  ir: NativeCircuitIrV6,
): ResolvedEntityV6Circuit {
  const snapshot = parseResolvedEntityV6Circuit({
    format: resolvedEntityV6CircuitFormat,
    version: resolvedEntityV6CircuitVersion,
    planFingerprint: resolvedEntityV6CircuitPlanFingerprint(plan),
    ir,
  });
  assertResolvedEntityV6CircuitMatchesPlan(plan, snapshot);
  return snapshot;
}

export function validateResolvedEntityV6Circuit(
  value: unknown,
): ResolvedEntityV6CircuitValidationResult {
  try {
    return { value: parseResolvedEntityV6Circuit(value), diagnostics: [] };
  } catch (error) {
    if (error instanceof ResolvedEntityV6CircuitError)
      return {
        diagnostics: [
          {
            code: error.code,
            severity: 'error',
            message: error.message,
            ...(error.span === undefined ? {} : { span: error.span }),
          },
        ],
      };
    return {
      diagnostics: [
        {
          code: 'RSC6099',
          severity: 'error',
          message: error instanceof Error ? error.message : 'Resolved Entity v6 validation failed.',
        },
      ],
    };
  }
}

export function parseResolvedEntityV6Circuit(value: unknown): ResolvedEntityV6Circuit {
  return parseValue(value);
}

export const snapshotResolvedEntityV6Circuit = parseResolvedEntityV6Circuit;

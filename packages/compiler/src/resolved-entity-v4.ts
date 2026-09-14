import {
  canonicalizeConstantConfiguration,
  classifyConstantConfigurationSupport,
  constantConfigurationToSparseBus,
} from '@comblang/factorio';
import type { Diagnostic, SourceSpan } from '@comblang/shared';
import type {
  DirectElaborationPlanV4,
  EntityPhysicalRecordV4,
  NativeCircuitIrV4,
} from './entity-v4.js';
import type { EntityId } from './entity.js';
import { parseResolvedSourceCircuit } from './resolved-source-circuit.js';

export const resolvedEntityV4CircuitFormat = 'comblang-resolved-entity-v4' as const;
export const resolvedEntityV4CircuitVersion = 1 as const;

/** Cloneable, already-authorized v4 physical output; no profiles or providers are carried. */
export interface ResolvedEntityV4Circuit {
  readonly format: typeof resolvedEntityV4CircuitFormat;
  readonly version: typeof resolvedEntityV4CircuitVersion;
  /** Correlation identity only; it grants no replay authority. */
  readonly planFingerprint: string;
  readonly ir: NativeCircuitIrV4;
}

export class ResolvedEntityV4CircuitError extends Error {
  readonly code = 'RSC4001';

  constructor(
    readonly path: string,
    readonly detail: string,
    readonly span?: SourceSpan,
  ) {
    super(`${path}: ${detail}`);
    this.name = 'ResolvedEntityV4CircuitError';
  }
}

export interface ResolvedEntityV4CircuitValidationResult {
  readonly value?: ResolvedEntityV4Circuit;
  readonly diagnostics: readonly Diagnostic[];
}

type DataRecord = Record<string, unknown>;
const maximumArrayLength = 100_000;

function stableJson(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number')
    return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (typeof value === 'object') {
    const record = value as DataRecord;
    return `{${Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
      .join(',')}}`;
  }
  throw new TypeError('Cannot fingerprint a non-JSON value.');
}

/** Computes a deterministic correlation identity for a canonical v4 plan. */
export function resolvedEntityV4CircuitPlanFingerprint(plan: DirectElaborationPlanV4): string {
  const serialized = stableJson(plan);
  let hash = 0xcbf29ce484222325n;
  for (let index = 0; index < serialized.length; index += 1) {
    hash ^= BigInt(serialized.charCodeAt(index));
    hash = (hash * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  return `v4-${hash.toString(16).padStart(16, '0')}`;
}

/** Checks that a resolved v4 snapshot still belongs to the exact source plan. */
export function assertResolvedEntityV4CircuitMatchesPlan(
  plan: DirectElaborationPlanV4,
  artifact: ResolvedEntityV4Circuit,
): void {
  if (artifact.planFingerprint !== resolvedEntityV4CircuitPlanFingerprint(plan))
    invalid(
      '$.planFingerprint',
      'resolved v4 circuit fingerprint does not match the current plan.',
    );
  if (stableJson(plan.context) !== stableJson(artifact.ir.context))
    invalid('$.ir.context', 'resolved v4 circuit context does not match the current plan.');
  if (plan.producers.length !== artifact.ir.producers.length)
    invalid('$.ir.producers', 'resolved v4 producer count does not match the current plan.');
  if (plan.entities.length !== artifact.ir.entities.length)
    invalid('$.ir.entities', 'resolved v4 Entity count does not match the current plan.');
  const physicalById = new Map(artifact.ir.entities.map((entity) => [entity.id, entity]));
  for (const entity of plan.entities) {
    const physical = physicalById.get(entity.id);
    const constantConfiguration =
      entity.configuration?.mode === 'constant' ? entity.configuration : undefined;
    if (
      physical === undefined ||
      physical.ordinal !== entity.ordinal ||
      stableJson(physical.profile) !== stableJson(entity.profile) ||
      physical.prototypeName !== entity.profile.prototypeKey.slice('entity:'.length) ||
      (constantConfiguration !== undefined &&
        stableJson(physical.configuration) !== stableJson(constantConfiguration))
    ) {
      invalid(`$.ir.entities[${entity.id}]`, 'resolved v4 Entity does not match the current plan.');
    }
  }
  for (const [index, producer] of plan.producers.entries()) {
    if (artifact.ir.producers[index]?.entityId !== producer.entityId)
      invalid(
        `$.ir.producers[${index}].entityId`,
        'resolved v4 producer association does not match the current plan.',
      );
  }
}

/** Creates the detached v4 snapshot produced after host-authorized lowering. */
export function snapshotResolvedEntityV4CircuitFromPlan(
  plan: DirectElaborationPlanV4,
  ir: NativeCircuitIrV4,
): ResolvedEntityV4Circuit {
  const snapshot = parseResolvedEntityV4Circuit({
    format: resolvedEntityV4CircuitFormat,
    version: resolvedEntityV4CircuitVersion,
    planFingerprint: resolvedEntityV4CircuitPlanFingerprint(plan),
    ir,
  });
  assertResolvedEntityV4CircuitMatchesPlan(plan, snapshot);
  return snapshot;
}

function invalid(path: string, detail: string, span?: SourceSpan): never {
  throw new ResolvedEntityV4CircuitError(path, detail, span);
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
  if (length > maximumArrayLength)
    invalid(path, `array exceeds the ${maximumArrayLength} item limit.`);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string') invalid(`${path}[${String(key)}]`, 'symbol keys are not allowed.');
    if (key === 'length') continue;
    if (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= length)
      invalid(`${path}.${key}`, 'unknown array field.');
    const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
    if (!('value' in descriptor)) invalid(`${path}[${key}]`, 'accessors are not allowed.');
  }
  const output: unknown[] = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (descriptor === undefined) invalid(`${path}[${index}]`, 'array holes are not allowed.');
    output.push(descriptor.value);
  }
  return output;
}

function exactKeys(record: DataRecord, allowed: readonly string[], path: string): void {
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(record)) {
    if (!allowedSet.has(key)) invalid(`${path}.${key}`, 'unknown resolved v4 field.');
  }
}

function text(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.length === 0)
    invalid(path, 'expected a non-empty string.');
  return value;
}

function sourceOf(value: unknown): SourceSpan | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const source = (value as DataRecord).source;
  if (source === null || typeof source !== 'object' || Array.isArray(source)) return undefined;
  const record = source as DataRecord;
  const start = record.start;
  const end = record.end;
  return typeof record.fileId === 'string' &&
    typeof start === 'number' &&
    typeof end === 'number' &&
    Number.isSafeInteger(start) &&
    Number.isSafeInteger(end) &&
    start >= 0 &&
    end >= start
    ? (record as unknown as SourceSpan)
    : undefined;
}

function parseConfiguration(value: unknown, path: string) {
  const record = dataRecord(value, path);
  exactKeys(record, ['mode', 'value'], path);
  if (record.mode !== 'constant')
    invalid(`${path}.mode`, 'only constant configuration is supported.');
  try {
    return canonicalizeConstantConfiguration(record.value, undefined, `${path}.value`);
  } catch (error) {
    if (error instanceof Error && 'path' in error && 'detail' in error)
      invalid(String(error.path), String(error.detail));
    throw error;
  }
}

function parseRawEnvelope(value: unknown) {
  const record = dataRecord(value, '$');
  exactKeys(record, ['format', 'version', 'planFingerprint', 'ir'], '$');
  if (record.format !== resolvedEntityV4CircuitFormat)
    invalid('$.format', 'unsupported resolved Entity v4 circuit format.');
  if (record.version !== resolvedEntityV4CircuitVersion)
    invalid('$.version', 'unsupported resolved Entity v4 circuit version.');
  const fingerprint = text(record.planFingerprint, '$.planFingerprint');
  if (!/^v4-[0-9a-f]{16}$/.test(fingerprint))
    invalid('$.planFingerprint', 'expected a canonical v4 plan fingerprint.');
  const ir = dataRecord(record.ir, '$.ir');
  exactKeys(ir, ['format', 'version', 'context', 'networks', 'producers', 'entities'], '$.ir');
  if (ir.format !== 'comblang-ncir') invalid('$.ir.format', 'unsupported resolved v4 IR format.');
  if (ir.version !== 4) invalid('$.ir.version', 'resolved v4 IR requires version 4.');
  const context = dataRecord(ir.context, '$.ir.context');
  if (
    typeof context.profileSetIdentity !== 'string' ||
    !/^entity-profile-set-v2-sha256:[0-9a-f]{64}$/.test(context.profileSetIdentity)
  )
    invalid(
      '$.ir.context.profileSetIdentity',
      'expected the current v2 SHA-256 profile-set identity.',
    );
  return {
    fingerprint,
    ir,
    rawProducers: dataArray(ir.producers, '$.ir.producers'),
    rawEntities: dataArray(ir.entities, '$.ir.entities'),
  };
}

function parseV4SpecificFields(rawProducers: readonly unknown[], rawEntities: readonly unknown[]) {
  const associations: readonly (EntityId | undefined)[] = rawProducers.map((entry, index) => {
    const path = `$.ir.producers[${index}]`;
    const record = dataRecord(entry, path);
    exactKeys(
      record,
      ['id', 'kind', 'config', 'destinations', 'provenance', 'placement', 'entityId'],
      path,
    );
    const entityId =
      'entityId' in record ? (text(record.entityId, `${path}.entityId`) as EntityId) : undefined;
    if (entityId !== undefined && record.kind !== 'constant')
      invalid(`${path}.entityId`, 'only a Constant producer may be linked to an Entity.');
    if (entityId !== undefined && 'placement' in record)
      invalid(`${path}.placement`, 'linked producer placement must be omitted.');
    return entityId;
  });
  const constantConfigurations = new Map<
    string,
    ReturnType<typeof parseConfiguration> | undefined
  >();
  for (const [index, entry] of rawEntities.entries()) {
    const path = `$.ir.entities[${index}]`;
    const record = dataRecord(entry, path);
    exactKeys(
      record,
      [
        'id',
        'profile',
        'prototypeName',
        'configuration',
        'connectorBindings',
        'placement',
        'provenance',
        'ordinal',
      ],
      path,
    );
    const id = text(record.id, `${path}.id`);
    if (constantConfigurations.has(id))
      invalid(`${path}.id`, 'Entity IDs must be unique.', sourceOf(record.provenance));
    const configuration =
      'configuration' in record
        ? dataRecord(record.configuration, `${path}.configuration`)
        : undefined;
    constantConfigurations.set(
      id,
      configuration?.mode === 'constant'
        ? parseConfiguration(configuration, `${path}.configuration`)
        : undefined,
    );
  }
  return { associations, constantConfigurations };
}

function projectEntityRecord(record: DataRecord, path: string): DataRecord {
  if (!('configuration' in record)) return record;
  const configuration = dataRecord(record.configuration, `${path}.configuration`);
  if (configuration.mode !== 'constant') return record;
  const { configuration: _configuration, ...withoutConfiguration } = record;
  return withoutConfiguration;
}

/** Parses a detached v4 physical envelope and rejects v3/v4 cross-read. */
export function parseResolvedEntityV4Circuit(value: unknown): ResolvedEntityV4Circuit {
  const { fingerprint, ir, rawProducers, rawEntities } = parseRawEnvelope(value);
  const { associations, constantConfigurations } = parseV4SpecificFields(rawProducers, rawEntities);
  const projected = {
    format: 'comblang-resolved-source-circuit',
    version: 1,
    planFingerprint: 'v1-0000000000000000',
    ir: {
      ...ir,
      version: 3,
      producers: rawProducers.map((entry) => {
        const record = dataRecord(entry, '$.ir.producers');
        const { entityId: _entityId, ...withoutAssociation } = record;
        return withoutAssociation;
      }),
      entities: rawEntities.map((entry) => {
        const record = dataRecord(entry, '$.ir.entities');
        return projectEntityRecord(record, '$.ir.entities');
      }),
    },
  };
  const parsed = parseResolvedSourceCircuit(projected);
  const linked = new Map<EntityId, number>();
  const producers = parsed.ir.producers.map((producer, index) => {
    const entityId = associations[index];
    if (entityId === undefined) return producer;
    if (linked.has(entityId))
      invalid(`$.ir.producers[${index}].entityId`, 'an Entity may have only one linked producer.');
    if (!parsed.ir.entities.some((entity) => entity.id === entityId))
      invalid(`$.ir.producers[${index}].entityId`, 'linked Entity does not exist.');
    linked.set(entityId, index);
    return Object.freeze({ ...producer, entityId });
  });
  const entities: EntityPhysicalRecordV4[] = parsed.ir.entities.map((entity) => {
    const configuration = constantConfigurations.get(entity.id);
    const producerIndex = linked.get(entity.id);
    if (configuration !== undefined && producerIndex === undefined)
      invalid(
        `$.ir.entities[${entity.id}].configuration`,
        'configured Entity must have a linked Constant producer.',
      );
    if (producerIndex !== undefined) {
      if (configuration === undefined)
        invalid(
          `$.ir.producers[${producerIndex}].entityId`,
          'linked Entity must carry constant configuration.',
        );
      const producer = producers[producerIndex];
      if (producer?.kind !== 'constant')
        invalid(
          `$.ir.producers[${producerIndex}].entityId`,
          'linked producer must remain Constant.',
        );
      const support = classifyConstantConfigurationSupport(configuration);
      if (support.status === 'unsupported')
        invalid(
          `$.ir.entities[${entity.id}].configuration`,
          `unsupported Constant configuration: ${support.reasons.join(', ')}.`,
        );
      const expected = constantConfigurationToSparseBus(configuration).toJSON();
      if (JSON.stringify(producer.config.outputs) !== JSON.stringify(expected))
        invalid(
          `$.ir.producers[${producerIndex}].config.outputs`,
          'Constant outputs do not match the linked Entity configuration.',
        );
    }
    return Object.freeze(
      configuration === undefined
        ? entity
        : { ...entity, configuration: { mode: 'constant', value: configuration } },
    ) as EntityPhysicalRecordV4;
  });
  return Object.freeze({
    format: resolvedEntityV4CircuitFormat,
    version: resolvedEntityV4CircuitVersion,
    planFingerprint: fingerprint,
    ir: Object.freeze({
      format: 'comblang-ncir',
      version: 4,
      context: parsed.ir.context,
      networks: parsed.ir.networks,
      producers: Object.freeze(producers),
      entities: Object.freeze(entities),
    }),
  });
}

export function validateResolvedEntityV4Circuit(
  value: unknown,
): ResolvedEntityV4CircuitValidationResult {
  try {
    return { value: parseResolvedEntityV4Circuit(value), diagnostics: [] };
  } catch (error) {
    if (error instanceof ResolvedEntityV4CircuitError)
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
          code: 'RSC4099',
          severity: 'error',
          message: error instanceof Error ? error.message : 'Resolved Entity v4 validation failed.',
        },
      ],
    };
  }
}

export const snapshotResolvedEntityV4Circuit = parseResolvedEntityV4Circuit;

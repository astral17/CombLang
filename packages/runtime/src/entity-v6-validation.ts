import type {
  DirectElaborationPlan,
  DirectPlanDecider,
  DirectPlanProducer,
  DeciderOutputOrigin,
} from '@comblang/compiler/direct-plan-schema';
import type {
  DirectElaborationPlanV6,
  DirectPlanDeciderV6,
  DirectPlanProducerV6,
  EntityPlanRecordV6,
  EntityV6DeciderConfiguration,
} from '@comblang/compiler/entity-v6';
import {
  entityReplayContextRef,
  resolveEntityReplayProfile,
  type TrustedEntityReplayContext,
} from '@comblang/compiler/entity-replay-context';
import type { EntityId } from '@comblang/compiler/entity';
import { cloneAndDeepFreeze } from '@comblang/compiler/immutable';
import type { Diagnostic, SourceSpan } from '@comblang/shared';

import { validateEntityV5DirectPlan } from './entity-v5-validation.js';

type DataRecord = Record<string, unknown>;
const maximumArrayLength = 100_000;
const syntaxIntents = new Set([
  'implicit-concrete-copy',
  'implicit-each-copy',
  'explicit-wildcard-copy',
  'explicit-constant',
  'exact',
]);

export class EntityV6PlanValidationError extends Error {
  readonly code: string;
  readonly path: string;
  readonly detail: string;
  readonly span: SourceSpan | undefined;

  constructor(code: string, path: string, message: string, span?: SourceSpan) {
    super(`${path}: ${message}`);
    this.name = 'EntityV6PlanValidationError';
    this.code = code;
    this.path = path;
    this.detail = message;
    this.span = span;
  }
}

export interface ValidatedEntityPlanV6 {
  readonly plan: DirectElaborationPlanV6;
  readonly context: TrustedEntityReplayContext;
}

export interface EntityV6PlanValidationResult {
  readonly value?: ValidatedEntityPlanV6;
  readonly diagnostics: readonly Diagnostic[];
}

function invalid(code: string, path: string, message: string, span?: SourceSpan): never {
  throw new EntityV6PlanValidationError(code, path, message, span);
}

function dataRecord(value: unknown, path: string): DataRecord {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    invalid('RT6000', path, 'expected a plain data record.');
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null)
    invalid('RT6000', path, 'expected a plain object or null-prototype record.');
  const output = Object.create(null) as DataRecord;
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string')
      invalid('RT6000', `${path}[${String(key)}]`, 'symbol keys are not allowed.');
    const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
    if (!('value' in descriptor)) invalid('RT6000', `${path}.${key}`, 'accessors are not allowed.');
    output[key] = descriptor.value;
  }
  return output;
}

function dataArray(value: unknown, path: string): readonly unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype)
    invalid('RT6000', path, 'expected a plain array.');
  const length = Object.getOwnPropertyDescriptor(value, 'length')?.value;
  if (typeof length !== 'number' || !Number.isSafeInteger(length) || length < 0)
    invalid('RT6000', `${path}.length`, 'array length must be a non-negative safe integer.');
  if (length > maximumArrayLength) invalid('RT6000', path, 'array exceeds the item limit.');
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string')
      invalid('RT6000', `${path}[${String(key)}]`, 'symbol keys are not allowed.');
    if (key === 'length') continue;
    if (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= length)
      invalid('RT6000', `${path}.${key}`, 'unknown array field.');
    const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
    if (!('value' in descriptor))
      invalid('RT6000', `${path}[${key}]`, 'accessors are not allowed.');
  }
  return Array.from({ length }, (_, index) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (descriptor === undefined)
      invalid('RT6000', `${path}[${index}]`, 'array holes are not allowed.');
    return descriptor.value;
  });
}

function exactKeys(record: DataRecord, allowed: readonly string[], path: string): void {
  const allowedSet = new Set(allowed);
  for (const key of Reflect.ownKeys(record)) {
    if (typeof key !== 'string' || !allowedSet.has(key))
      invalid('RT6000', `${path}.${String(key)}`, 'unknown Entity v6 field.');
  }
}

function text(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.length === 0)
    invalid('RT6000', path, 'expected a non-empty string.');
  return value;
}

function sourceOf(value: unknown): SourceSpan | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const source = (value as DataRecord).source;
  if (source === null || typeof source !== 'object' || Array.isArray(source)) return undefined;
  const record = source as DataRecord;
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
  const source = sourceOf({ source: record });
  if (source === undefined)
    invalid('RT6000', path, 'source span must use a valid half-open range.');
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
  if (record.branch !== branch)
    invalid('RT6002', `${path}.branch`, `expected ${branch} branch origin.`);
  if (record.ordinal !== ordinal)
    invalid('RT6002', `${path}.ordinal`, `expected dense ordinal ${ordinal}.`);
  if (typeof record.syntaxIntent !== 'string' || !syntaxIntents.has(record.syntaxIntent))
    invalid('RT6002', `${path}.syntaxIntent`, 'unknown Decider output syntax intent.');
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
  expectedLength: number,
): readonly DeciderOutputOrigin[] {
  const entries = dataArray(value, path);
  if (entries.length !== expectedLength)
    invalid('RT6002', path, 'Decider output origins must align with output rows.');
  return Object.freeze(
    entries.map((entry, index) => parseOrigin(entry, `${path}[${index}]`, branch, index)),
  );
}

function producerKeys(kind: string): readonly string[] {
  const common = [
    'kind',
    'bindingName',
    'debugCaptureIds',
    'source',
    'instancePath',
    'placement',
    'destinations',
  ];
  if (kind === 'constant') return [...common, 'entityId', 'outputs'];
  if (kind === 'arithmetic') return [...common, 'entityId', 'left', 'operation', 'right', 'output'];
  if (kind === 'decider')
    return [
      ...common,
      'entityId',
      'condition',
      'output',
      'outputs',
      'elseOutputs',
      'outputOrigins',
      'elseOutputOrigins',
    ];
  if (kind === 'selector') return [...common, 'input', 'operation', 'selectMax', 'index', 'output'];
  return [];
}

interface RawDeciderRecord {
  readonly index: number;
  readonly path: string;
  readonly record: DataRecord;
  readonly entityId?: EntityId;
}

function parseProducerRecords(value: readonly unknown[]): {
  readonly deciders: readonly RawDeciderRecord[];
  readonly associations: ReadonlyMap<EntityId, number>;
} {
  const deciders: RawDeciderRecord[] = [];
  const associations = new Map<EntityId, number>();
  value.forEach((entry, index) => {
    const path = `$.producers[${index}]`;
    const record = dataRecord(entry, path);
    const kind = typeof record.kind === 'string' ? record.kind : '';
    const keys = producerKeys(kind);
    if (keys.length === 0)
      invalid('RT6000', `${path}.kind`, 'unknown Producer tag.', sourceOf(record));
    exactKeys(record, keys, path);
    const entityId =
      'entityId' in record ? (text(record.entityId, `${path}.entityId`) as EntityId) : undefined;
    if (entityId !== undefined) {
      if (associations.has(entityId))
        invalid(
          'RT6002',
          `${path}.entityId`,
          'an Entity may have only one linked producer.',
          sourceOf(record),
        );
      if ('placement' in record)
        invalid(
          'RT6002',
          `${path}.placement`,
          'a linked producer must omit placement.',
          sourceOf(record),
        );
      associations.set(entityId, index);
    }
    if (kind === 'decider') {
      if (!('outputs' in record))
        invalid('RT6002', `${path}.outputs`, 'v6 Decider outputs are required.');
      if (!('outputOrigins' in record))
        invalid('RT6002', `${path}.outputOrigins`, 'v6 Decider output origins are required.');
      deciders.push({ index, path, record, ...(entityId === undefined ? {} : { entityId }) });
    }
  });
  return { deciders, associations };
}

function projection(
  value: DataRecord,
  producers: readonly unknown[],
  entities: readonly unknown[],
): DirectElaborationPlan {
  return {
    ...value,
    version: 5,
    producers: producers.map((entry, index) => {
      const record = dataRecord(entry, `$.producers[${index}]`);
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
      const record = dataRecord(entry, `$.entities[${index}]`);
      const configuration =
        'configuration' in record
          ? dataRecord(record.configuration, `$.entities[${index}].configuration`)
          : undefined;
      if (configuration?.mode !== 'decider') return record;
      const { configuration: _configuration, ...withoutConfiguration } = record;
      return withoutConfiguration;
    }),
  } as unknown as DirectElaborationPlan;
}

function parseEntityRecords(value: readonly unknown[]): ReadonlyMap<EntityId, DataRecord> {
  const entities = new Map<EntityId, DataRecord>();
  value.forEach((entry, index) => {
    const path = `$.entities[${index}]`;
    const record = dataRecord(entry, path);
    exactKeys(
      record,
      ['id', 'profile', 'configuration', 'connectorBindings', 'placement', 'provenance', 'ordinal'],
      path,
    );
    const id = text(record.id, `${path}.id`) as EntityId;
    if (entities.has(id))
      invalid('RT6002', `${path}.id`, 'Entity IDs must be unique.', sourceOf(record.provenance));
    entities.set(id, record);
  });
  return entities;
}

function parseDeciderConfiguration(
  value: unknown,
  path: string,
  producer: Extract<DirectPlanProducer, { readonly kind: 'decider' }>,
): EntityV6DeciderConfiguration {
  const record = dataRecord(value, path);
  exactKeys(record, ['mode', 'condition', 'outputs', 'elseOutputs'], path);
  if (record.mode !== 'decider')
    invalid('RT6002', `${path}.mode`, 'expected decider configuration.');
  const outputs = dataArray(record.outputs, `${path}.outputs`);
  if (outputs.length !== producer.outputs!.length)
    invalid(
      'RT6003',
      `${path}.outputs`,
      'Decider Entity configuration does not match its producer.',
    );
  const elseOutputs =
    'elseOutputs' in record ? dataArray(record.elseOutputs, `${path}.elseOutputs`) : undefined;
  if (elseOutputs !== undefined && elseOutputs.length === 0)
    invalid('RT6002', `${path}.elseOutputs`, 'empty elseOutputs must be omitted.');
  const expected = {
    condition: producer.condition,
    outputs: producer.outputs,
    ...(producer.elseOutputs === undefined ? {} : { elseOutputs: producer.elseOutputs }),
  };
  const actual = {
    condition: record.condition,
    outputs,
    ...(elseOutputs === undefined ? {} : { elseOutputs }),
  };
  try {
    if (stableJson(actual) !== stableJson(expected))
      invalid(
        'RT6003',
        path,
        'Decider producer configuration must equal the linked Entity configuration.',
      );
  } catch (error) {
    invalid(
      'RT6000',
      path,
      error instanceof Error ? error.message : 'invalid Decider configuration.',
    );
  }
  return Object.freeze({
    mode: 'decider',
    condition: producer.condition,
    outputs: producer.outputs!,
    ...(producer.elseOutputs === undefined ? {} : { elseOutputs: producer.elseOutputs }),
  });
}

function validateValue(value: unknown, context: TrustedEntityReplayContext): ValidatedEntityPlanV6 {
  const record = dataRecord(value, '$');
  exactKeys(
    record,
    [
      'format',
      'version',
      'context',
      'networks',
      'networkAliases',
      'networkTransfers',
      'networkPairs',
      'capabilityUses',
      'debugInstances',
      'producers',
      'entities',
      'diagnostics',
    ],
    '$',
  );
  if (record.format !== 'comblang-direct-plan')
    invalid('RT1001', '$.format', 'unsupported direct plan format.');
  if (record.version !== 6)
    invalid('RT1001', '$.version', 'Entity computation plans require version 6.');
  const rawProducers = dataArray(record.producers, '$.producers');
  const rawEntities = dataArray(record.entities, '$.entities');
  const { deciders } = parseProducerRecords(rawProducers);
  const entityRecords = parseEntityRecords(rawEntities);
  const commonResult = validateEntityV5DirectPlan(
    projection(record, rawProducers, rawEntities),
    context,
  );
  if (!commonResult.value) {
    const diagnostic = commonResult.diagnostics[0];
    invalid(
      diagnostic?.code ?? 'RT6000',
      '$',
      diagnostic?.message ?? 'invalid v6 Entity plan.',
      diagnostic?.span,
    );
  }
  const commonPlan = commonResult.value.plan;
  const entitiesById = new Map(commonPlan.entities.map((entity) => [entity.id, entity]));
  const linkedDeciderEntities = new Set<EntityId>();
  const producers: DirectPlanProducerV6[] = commonPlan.producers.map((producer, index) => {
    const raw = dataRecord(rawProducers[index], `$.producers[${index}]`);
    const entityId =
      'entityId' in raw
        ? (text(raw.entityId, `$.producers[${index}].entityId`) as EntityId)
        : undefined;
    if (producer.kind !== 'decider')
      return Object.freeze({
        ...producer,
        ...(entityId === undefined ? {} : { entityId }),
      }) as DirectPlanProducerV6;
    const decider = producer as Extract<DirectPlanProducer, { readonly kind: 'decider' }>;
    const normal = parseOrigins(
      raw.outputOrigins,
      `$.producers[${index}].outputOrigins`,
      'normal',
      decider.outputs!.length,
    );
    const alternate =
      raw.elseOutputs === undefined
        ? undefined
        : parseOrigins(
            raw.elseOutputOrigins,
            `$.producers[${index}].elseOutputOrigins`,
            'else',
            decider.elseOutputs?.length ?? 0,
          );
    if (raw.elseOutputs === undefined && raw.elseOutputOrigins !== undefined)
      invalid('RT6002', `$.producers[${index}].elseOutputOrigins`, 'origins require elseOutputs.');
    if (raw.elseOutputs !== undefined && raw.elseOutputOrigins === undefined)
      invalid(
        'RT6002',
        `$.producers[${index}].elseOutputOrigins`,
        'else output origins are required.',
      );
    const expectedOutput =
      decider.outputs!.length > 0 ? decider.outputs![0] : decider.elseOutputs![0];
    if (
      decider.outputs!.length === 0 &&
      (decider.elseOutputs === undefined || decider.elseOutputs.length === 0)
    )
      invalid(
        'RT6002',
        `$.producers[${index}].outputs`,
        'a v6 Decider must contain at least one output row.',
      );
    if (stableJson(decider.output) !== stableJson(expectedOutput))
      invalid(
        'RT6003',
        `$.producers[${index}].output`,
        'Decider output must equal the first canonical branch row.',
      );
    return Object.freeze({
      ...decider,
      ...(entityId === undefined ? {} : { entityId }),
      outputs: Object.freeze([...decider.outputs!]),
      outputOrigins: normal,
      ...(decider.elseOutputs === undefined
        ? {}
        : { elseOutputs: Object.freeze([...decider.elseOutputs]) }),
      ...(alternate === undefined ? {} : { elseOutputOrigins: alternate }),
    }) as DirectPlanDeciderV6;
  });
  const deciderByEntity = new Map<EntityId, number>();
  for (const decider of deciders) {
    if (decider.entityId === undefined) continue;
    if (!entitiesById.has(decider.entityId))
      invalid(
        'RT6002',
        `${decider.path}.entityId`,
        'linked Entity does not exist.',
        sourceOf(decider.record),
      );
    deciderByEntity.set(decider.entityId, decider.index);
  }
  const deciderConfigurations = new Map<EntityId, EntityV6DeciderConfiguration>();
  for (const [id, entity] of entityRecords) {
    const configuration =
      'configuration' in entity
        ? dataRecord(entity.configuration, `$.entities[${id}].configuration`)
        : undefined;
    if (configuration?.mode !== 'decider') continue;
    const producerIndex = deciderByEntity.get(id);
    if (producerIndex === undefined)
      invalid(
        'RT6002',
        `$.entities[${id}].configuration`,
        'configured Decider Entity must have one linked producer.',
      );
    const producer = producers[producerIndex];
    if (producer?.kind !== 'decider')
      invalid(
        'RT6002',
        `$.producers[${producerIndex}].entityId`,
        'linked Entity family does not match.',
      );
    const profile = resolveEntityReplayProfile(
      commonPlan.entities.find((candidate) => candidate.id === id)!.profile,
      context,
    );
    if (profile.prototypeType !== 'decider-combinator')
      invalid(
        'RT6002',
        `$.entities[${id}].profile`,
        'linked Entity profile must identify the decider-combinator family.',
      );
    if (profile.ref.prototypeKey !== 'entity:decider-combinator')
      invalid(
        'RT6002',
        `$.entities[${id}].profile`,
        'linked Entity profile must use the exact entity:decider-combinator base key.',
      );
    deciderConfigurations.set(
      id,
      parseDeciderConfiguration(configuration, `$.entities[${id}].configuration`, producer),
    );
    linkedDeciderEntities.add(id);
  }
  for (const decider of deciders) {
    if (decider.entityId === undefined) continue;
    if (!linkedDeciderEntities.has(decider.entityId))
      invalid(
        'RT6002',
        `${decider.path}.entityId`,
        'linked Decider Entity must declare decider configuration.',
      );
  }
  if (linkedDeciderEntities.size === 0)
    invalid(
      'RT6002',
      '$.producers',
      'Entity v6 requires at least one Decider producer linked to a configured Entity.',
    );
  const entities: EntityPlanRecordV6[] = commonPlan.entities.map((entity) => {
    const configuration = deciderConfigurations.get(entity.id);
    return Object.freeze(
      configuration === undefined ? entity : { ...entity, configuration },
    ) as EntityPlanRecordV6;
  });
  const plan: DirectElaborationPlanV6 = {
    format: 'comblang-direct-plan',
    version: 6,
    context: entityReplayContextRef(context),
    networks: commonPlan.networks,
    ...(commonPlan.networkAliases === undefined
      ? {}
      : { networkAliases: commonPlan.networkAliases }),
    ...(commonPlan.networkTransfers === undefined
      ? {}
      : { networkTransfers: commonPlan.networkTransfers }),
    ...(commonPlan.networkPairs === undefined ? {} : { networkPairs: commonPlan.networkPairs }),
    ...(commonPlan.capabilityUses === undefined
      ? {}
      : { capabilityUses: commonPlan.capabilityUses }),
    ...(commonPlan.debugInstances === undefined
      ? {}
      : { debugInstances: commonPlan.debugInstances }),
    producers,
    entities,
    ...(commonPlan.diagnostics === undefined ? {} : { diagnostics: commonPlan.diagnostics }),
  };
  return { plan: cloneAndDeepFreeze(plan), context };
}

export function validateEntityV6DirectPlan(
  value: unknown,
  context: TrustedEntityReplayContext,
): EntityV6PlanValidationResult {
  try {
    return { value: validateValue(value, context), diagnostics: [] };
  } catch (error) {
    if (error instanceof EntityV6PlanValidationError)
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
          code: 'RT6099',
          severity: 'error',
          message: error instanceof Error ? error.message : 'Entity v6 validation failed.',
        },
      ],
    };
  }
}

export const validateEntityDirectPlanV6 = validateEntityV6DirectPlan;

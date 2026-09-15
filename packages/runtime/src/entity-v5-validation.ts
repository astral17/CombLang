import {
  canonicalizeConstantConfiguration,
  classifyConstantConfigurationSupport,
  constantConfigurationToSparseBus,
  Signal,
  signalTypes,
  type SignalId,
} from '@comblang/factorio';
import type {
  DirectElaborationPlan,
  PlanNetworkRef,
  PlanArithmeticOperand,
} from '@comblang/compiler/direct-plan-schema';
import type {
  DirectElaborationPlanV5,
  DirectPlanProducerV5,
  EntityV5ArithmeticConfiguration,
  EntityV5PlanConfiguration,
  EntityPlanRecordV5,
} from '@comblang/compiler/entity-v5';
import {
  entityReplayContextRef,
  resolveEntityReplayProfile,
  type TrustedEntityReplayContext,
} from '@comblang/compiler/entity-replay-context';
import type { EntityId, EntityProfileRef } from '@comblang/compiler/entity';
import { cloneAndDeepFreeze } from '@comblang/compiler/immutable';
import type { Diagnostic, SourceSpan } from '@comblang/shared';
import { validateEntityDirectPlan } from './entity-plan-validation.js';

type DataRecord = Record<string, unknown>;
const maximumArrayLength = 100_000;
const arithmeticOperations = new Set([
  'add',
  'subtract',
  'multiply',
  'divide',
  'modulo',
  'power',
  'left-shift',
  'right-shift',
  'bit-and',
  'bit-or',
  'bit-xor',
]);

export class EntityV5PlanValidationError extends Error {
  readonly code: string;
  readonly path: string;
  readonly detail: string;
  readonly span: SourceSpan | undefined;

  constructor(code: string, path: string, message: string, span?: SourceSpan) {
    super(`${path}: ${message}`);
    this.name = 'EntityV5PlanValidationError';
    this.code = code;
    this.path = path;
    this.detail = message;
    this.span = span;
  }
}

export interface ValidatedEntityPlanV5 {
  readonly plan: DirectElaborationPlanV5;
  readonly context: TrustedEntityReplayContext;
}

export interface EntityV5PlanValidationResult {
  readonly value?: ValidatedEntityPlanV5;
  readonly diagnostics: readonly Diagnostic[];
}

function invalid(code: string, path: string, message: string, span?: SourceSpan): never {
  throw new EntityV5PlanValidationError(code, path, message, span);
}

function dataRecord(value: unknown, path: string): DataRecord {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    invalid('RT5000', path, 'expected a plain data record.');
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null)
    invalid('RT5000', path, 'expected a plain object or null-prototype record.');
  const output = Object.create(null) as DataRecord;
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string')
      invalid('RT5000', `${path}[${String(key)}]`, 'symbol keys are not allowed.');
    const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
    if (!('value' in descriptor)) invalid('RT5000', `${path}.${key}`, 'accessors are not allowed.');
    output[key] = descriptor.value;
  }
  return output;
}

function dataArray(value: unknown, path: string): readonly unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype)
    invalid('RT5000', path, 'expected a plain array.');
  const length = Object.getOwnPropertyDescriptor(value, 'length')?.value;
  if (typeof length !== 'number' || !Number.isSafeInteger(length) || length < 0)
    invalid('RT5000', `${path}.length`, 'array length must be a non-negative safe integer.');
  if (length > maximumArrayLength)
    invalid('RT5000', path, `array exceeds the ${maximumArrayLength} item limit.`);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string')
      invalid('RT5000', `${path}[${String(key)}]`, 'symbol keys are not allowed.');
    if (key === 'length') continue;
    if (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= length)
      invalid('RT5000', `${path}.${key}`, 'unknown array field.');
    const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
    if (!('value' in descriptor))
      invalid('RT5000', `${path}[${key}]`, 'accessors are not allowed.');
  }
  return Array.from({ length }, (_, index) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (descriptor === undefined)
      invalid('RT5000', `${path}[${index}]`, 'array holes are not allowed.');
    return descriptor.value;
  });
}

function exactKeys(record: DataRecord, allowed: readonly string[], path: string): void {
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(record)) {
    if (!allowedSet.has(key)) invalid('RT5000', `${path}.${key}`, 'unknown Entity v5 field.');
  }
}

function text(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.length === 0)
    invalid('RT5000', path, 'expected a non-empty string.');
  return value;
}

function sourceOf(value: unknown): SourceSpan | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const candidate = (value as DataRecord).source;
  if (candidate === null || typeof candidate !== 'object' || Array.isArray(candidate))
    return undefined;
  const span = candidate as DataRecord;
  const start = span.start;
  const end = span.end;
  return typeof span.fileId === 'string' &&
    typeof start === 'number' &&
    typeof end === 'number' &&
    Number.isSafeInteger(start) &&
    Number.isSafeInteger(end) &&
    start >= 0 &&
    end >= start
    ? (span as unknown as SourceSpan)
    : undefined;
}

function parseSignal(value: unknown, path: string): SignalId {
  const record = dataRecord(value, path);
  exactKeys(record, ['type', 'name', 'quality'], path);
  if (typeof record.type !== 'string' || !signalTypes.includes(record.type as SignalId['type']))
    invalid('RT5000', `${path}.type`, 'expected a valid Signal type.');
  if (typeof record.name !== 'string' || record.name.length === 0)
    invalid('RT5000', `${path}.name`, 'expected a non-empty Signal name.');
  if ('quality' in record && (typeof record.quality !== 'string' || record.quality.length === 0))
    invalid('RT5000', `${path}.quality`, 'expected a non-empty Signal quality.');
  try {
    return Signal(
      record.type as SignalId['type'],
      record.name,
      'quality' in record ? (record.quality as string) : undefined,
    );
  } catch (error) {
    invalid('RT5000', path, error instanceof Error ? error.message : 'invalid Signal ID.');
  }
}

function networkRef(record: DataRecord, path: string): PlanNetworkRef {
  if (record.refKind === 'single') {
    exactKeys(record, ['kind', 'refKind', 'network', 'signal'], path);
    return { refKind: 'single', network: text(record.network, `${path}.network`) };
  }
  if (record.refKind === 'pair') {
    exactKeys(record, ['kind', 'refKind', 'networks', 'signal'], path);
    const networks = dataArray(record.networks, `${path}.networks`);
    if (networks.length !== 2)
      invalid('RT5000', `${path}.networks`, 'a pair reference requires two networks.');
    return {
      refKind: 'pair',
      networks: [
        text(networks[0], `${path}.networks[0]`),
        text(networks[1], `${path}.networks[1]`),
      ],
    };
  }
  invalid('RT5000', `${path}.refKind`, 'expected single or pair network reference.');
}

function parseArithmeticOperand(value: unknown, path: string): PlanArithmeticOperand {
  const record = dataRecord(value, path);
  if (record.kind === 'constant') {
    exactKeys(record, ['kind', 'value'], path);
    if (typeof record.value !== 'number' || !Number.isSafeInteger(record.value))
      invalid('RT5000', `${path}.value`, 'expected a safe integer circuit constant.');
    return { kind: 'constant', value: record.value };
  }
  if (record.kind === 'each') {
    return { kind: 'each', ...networkRef(record, path) };
  }
  if (record.kind === 'signal') {
    const reference = networkRef(record, path);
    return {
      kind: 'signal',
      ...reference,
      signal: parseSignal(record.signal, `${path}.signal`),
    };
  }
  invalid('RT5000', `${path}.kind`, 'expected constant, signal, or each arithmetic operand.');
}

function parseArithmeticConfiguration(
  value: unknown,
  path: string,
): EntityV5ArithmeticConfiguration {
  const record = dataRecord(value, path);
  exactKeys(record, ['mode', 'left', 'operation', 'right', 'output'], path);
  if (record.mode !== 'arithmetic')
    invalid('RT5000', `${path}.mode`, 'only arithmetic configuration is supported.');
  if (typeof record.operation !== 'string' || !arithmeticOperations.has(record.operation))
    invalid('RT5000', `${path}.operation`, 'expected a canonical Arithmetic operation.');
  const outputRecord = dataRecord(record.output, `${path}.output`);
  let output: EntityV5ArithmeticConfiguration['output'];
  if (outputRecord.kind === 'each') {
    exactKeys(outputRecord, ['kind'], `${path}.output`);
    output = { kind: 'each' };
  } else if (outputRecord.kind === 'signal') {
    exactKeys(outputRecord, ['kind', 'signal'], `${path}.output`);
    output = { kind: 'signal', signal: parseSignal(outputRecord.signal, `${path}.output.signal`) };
  } else {
    invalid('RT5000', `${path}.output.kind`, 'expected a concrete signal or each output.');
  }
  return Object.freeze({
    mode: 'arithmetic',
    left: parseArithmeticOperand(record.left, `${path}.left`),
    operation: record.operation as EntityV5ArithmeticConfiguration['operation'],
    right: parseArithmeticOperand(record.right, `${path}.right`),
    output,
  });
}

function parseConstantConfiguration(value: unknown, path: string) {
  const record = dataRecord(value, path);
  exactKeys(record, ['mode', 'value'], path);
  if (record.mode !== 'constant')
    invalid('RT5000', `${path}.mode`, 'only constant configuration is supported.');
  try {
    return Object.freeze({
      mode: 'constant' as const,
      value: canonicalizeConstantConfiguration(record.value, undefined, `${path}.value`),
    });
  } catch (error) {
    if (error instanceof Error && 'path' in error && 'detail' in error)
      invalid('RT5000', String(error.path), String(error.detail));
    throw error;
  }
}

type V5Configuration = Exclude<
  EntityV5PlanConfiguration,
  import('@comblang/compiler/entity').EntityConfiguration
>;

function parseEntityConfiguration(value: unknown, path: string): V5Configuration {
  const record = dataRecord(value, path);
  if (record.mode === 'constant') return parseConstantConfiguration(record, path);
  if (record.mode === 'arithmetic') return parseArithmeticConfiguration(record, path);
  invalid('RT5000', `${path}.mode`, 'expected constant or arithmetic linked Entity configuration.');
}

interface ProducerAssociation {
  readonly kind: string;
  readonly entityId?: EntityId;
}

function parseProducerAssociations(value: unknown): readonly ProducerAssociation[] {
  return dataArray(value, '$.producers').map((entry, index) => {
    const path = `$.producers[${index}]`;
    const record = dataRecord(entry, path);
    const kind = record.kind;
    const specific =
      kind === 'arithmetic'
        ? ['left', 'operation', 'right', 'output']
        : kind === 'decider'
          ? ['condition', 'output', 'outputs', 'elseOutputs']
          : kind === 'constant'
            ? ['outputs']
            : [];
    if (specific.length === 0)
      invalid('RT5000', `${path}.kind`, 'unknown Producer tag.', sourceOf(record));
    exactKeys(
      record,
      [
        'kind',
        'bindingName',
        'debugCaptureIds',
        'source',
        'instancePath',
        'placement',
        'destinations',
        'entityId',
        ...specific,
      ],
      path,
    );
    const entityId =
      'entityId' in record ? (text(record.entityId, `${path}.entityId`) as EntityId) : undefined;
    if (entityId !== undefined && kind !== 'arithmetic' && kind !== 'constant')
      invalid(
        'RT5002',
        `${path}.entityId`,
        'only Arithmetic or Constant producers may be linked to an Entity.',
        sourceOf(record),
      );
    if (entityId !== undefined && 'placement' in record)
      invalid(
        'RT5002',
        `${path}.placement`,
        'a linked producer must omit placement; the Entity owns placement.',
        sourceOf(record),
      );
    return { kind: String(kind), ...(entityId === undefined ? {} : { entityId }) };
  });
}

interface EntityEntry {
  readonly id: EntityId;
  readonly configuration?: V5Configuration;
}

function parseEntities(value: unknown): ReadonlyMap<string, EntityEntry> {
  const entities = new Map<string, EntityEntry>();
  for (const [index, entry] of dataArray(value, '$.entities').entries()) {
    const path = `$.entities[${index}]`;
    const record = dataRecord(entry, path);
    exactKeys(
      record,
      ['id', 'profile', 'configuration', 'connectorBindings', 'placement', 'provenance', 'ordinal'],
      path,
    );
    const id = text(record.id, `${path}.id`) as EntityId;
    if (entities.has(id))
      invalid('RT5002', `${path}.id`, 'Entity IDs must be unique.', sourceOf(record.provenance));
    const rawConfiguration =
      'configuration' in record
        ? dataRecord(record.configuration, `${path}.configuration`)
        : undefined;
    const configuration =
      rawConfiguration !== undefined &&
      (rawConfiguration.mode === 'constant' || rawConfiguration.mode === 'arithmetic')
        ? parseEntityConfiguration(rawConfiguration, `${path}.configuration`)
        : undefined;
    entities.set(id, { id, ...(configuration === undefined ? {} : { configuration }) });
  }
  return entities;
}

function projectEntityRecord(record: DataRecord): DataRecord {
  if (!('configuration' in record)) return record;
  const configuration = dataRecord(record.configuration, '$.configuration');
  return configuration.mode === 'constant' || configuration.mode === 'arithmetic'
    ? Object.fromEntries(Object.entries(record).filter(([key]) => key !== 'configuration'))
    : record;
}

function projection(
  value: DataRecord,
  producers: readonly unknown[],
  entities: readonly unknown[],
): DirectElaborationPlan {
  return {
    ...value,
    version: 3,
    producers: producers.map((entry) => {
      const record = dataRecord(entry, '$.producers');
      const { entityId: _entityId, ...withoutAssociation } = record;
      return withoutAssociation;
    }),
    entities: entities.map((entry) => projectEntityRecord(dataRecord(entry, '$.entities'))),
  } as unknown as DirectElaborationPlan;
}

function stableJson(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  const record = value as DataRecord;
  return `{${Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
    .join(',')}}`;
}

function validateValue(value: unknown, context: TrustedEntityReplayContext): ValidatedEntityPlanV5 {
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
  if (record.version !== 5)
    invalid('RT1001', '$.version', 'Entity computation plans require version 5.');
  const contextRecord = dataRecord(record.context, '$.context');
  exactKeys(
    contextRecord,
    ['database', 'profileSetIdentity', 'evidenceIdentity', 'policyIdentity'],
    '$.context',
  );
  const database = dataRecord(contextRecord.database, '$.context.database');
  exactKeys(database, ['schemaVersion', 'identity'], '$.context.database');
  if (
    database.identity !== context.database.identity ||
    database.schemaVersion !== context.database.schemaVersion ||
    contextRecord.profileSetIdentity !== context.profileSetIdentity ||
    contextRecord.evidenceIdentity !== context.evidenceIdentity ||
    contextRecord.policyIdentity !== context.policyIdentity
  )
    invalid(
      'RT5001',
      '$.context',
      'v5 computation requires the exact current replay context identity.',
    );

  const rawProducers = dataArray(record.producers, '$.producers');
  const associations = parseProducerAssociations(rawProducers);
  const rawEntities = dataArray(record.entities, '$.entities');
  const entityEntries = parseEntities(rawEntities);
  const commonResult = validateEntityDirectPlan(
    projection(record, rawProducers, rawEntities),
    context,
  );
  if (!commonResult.value) {
    const diagnostic = commonResult.diagnostics[0];
    invalid(
      diagnostic?.code ?? 'RT5000',
      '$',
      diagnostic?.message ?? 'invalid v5 Entity plan.',
      diagnostic?.span,
    );
  }
  const commonPlan = commonResult.value.plan;
  const entitiesById = new Map(commonPlan.entities.map((entity) => [entity.id, entity]));
  const linked = new Map<EntityId, number>();
  const producers: DirectPlanProducerV5[] = commonPlan.producers.map((producer, index) => {
    const entityId = associations[index]?.entityId;
    if (entityId === undefined) return producer as DirectPlanProducerV5;
    if (!entitiesById.has(entityId))
      invalid(
        'RT5002',
        `$.producers[${index}].entityId`,
        'linked Entity does not exist.',
        sourceOf(rawProducers[index]),
      );
    if (linked.has(entityId))
      invalid(
        'RT5002',
        `$.producers[${index}].entityId`,
        'an Entity may have at most one linked producer.',
        sourceOf(rawProducers[index]),
      );
    if (producer.kind !== 'arithmetic' && producer.kind !== 'constant')
      invalid(
        'RT5002',
        `$.producers[${index}].entityId`,
        'only Arithmetic or Constant producers may be linked to an Entity.',
        sourceOf(rawProducers[index]),
      );
    linked.set(entityId, index);
    return Object.freeze({ ...producer, entityId }) as DirectPlanProducerV5;
  });

  const entities: EntityPlanRecordV5[] = commonPlan.entities.map((entity) => {
    const entry = entityEntries.get(entity.id)!;
    const configuration = entry.configuration;
    const producerIndex = linked.get(entity.id);
    const entityPath = `$.entities[${rawEntities.findIndex((candidate) => dataRecord(candidate, '$.entities').id === entity.id)}]`;
    if (configuration !== undefined && producerIndex === undefined)
      invalid(
        'RT5002',
        `${entityPath}.configuration`,
        'configured Entity must have one linked Arithmetic or Constant producer.',
      );
    if (producerIndex !== undefined) {
      if (configuration === undefined)
        invalid(
          'RT5002',
          `$.producers[${producerIndex}].entityId`,
          'linked Entity must declare its configuration.',
        );
      const profile = resolveEntityReplayProfile(entity.profile, context);
      if (configuration!.mode === 'constant') {
        if (profile.prototypeType !== 'constant-combinator')
          invalid(
            'RT5002',
            `${entityPath}.profile`,
            'linked Entity profile must identify the constant-combinator family.',
          );
        const support = classifyConstantConfigurationSupport(configuration.value);
        if (support.status === 'unsupported')
          invalid(
            'RT5003',
            `${entityPath}.configuration.value`,
            `unsupported Constant configuration: ${support.reasons.join(', ')}.`,
          );
        const expected = constantConfigurationToSparseBus(configuration.value).toJSON();
        const producer = producers[producerIndex];
        if (producer?.kind !== 'constant' || stableJson(producer.outputs) !== stableJson(expected))
          invalid(
            'RT5003',
            `$.producers[${producerIndex}].outputs`,
            'Constant producer outputs must equal the linked Entity configuration.',
          );
      } else {
        if (profile.prototypeType !== 'arithmetic-combinator')
          invalid(
            'RT5002',
            `${entityPath}.profile`,
            'linked Entity profile must identify the arithmetic-combinator family.',
          );
        const producer = producers[producerIndex];
        if (
          producer?.kind !== 'arithmetic' ||
          stableJson({
            left: producer.left,
            operation: producer.operation,
            right: producer.right,
            output: producer.output,
          }) !==
            stableJson({
              left: configuration.left,
              operation: configuration.operation,
              right: configuration.right,
              output: configuration.output,
            })
        )
          invalid(
            'RT5003',
            `$.producers[${producerIndex}]`,
            'Arithmetic producer configuration must equal the linked Entity configuration.',
          );
      }
    }
    return Object.freeze(
      configuration === undefined ? entity : { ...entity, configuration },
    ) as EntityPlanRecordV5;
  });

  const plan: DirectElaborationPlanV5 = {
    format: 'comblang-direct-plan',
    version: 5,
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

export function validateEntityV5DirectPlan(
  value: unknown,
  context: TrustedEntityReplayContext,
): EntityV5PlanValidationResult {
  try {
    return { value: validateValue(value, context), diagnostics: [] };
  } catch (error) {
    if (error instanceof EntityV5PlanValidationError) {
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
    }
    return {
      diagnostics: [
        {
          code: 'RT5099',
          severity: 'error',
          message: error instanceof Error ? error.message : 'Entity v5 validation failed.',
        },
      ],
    };
  }
}

export const validateEntityDirectPlanV5 = validateEntityV5DirectPlan;

import {
  canonicalizeConstantConfiguration,
  classifyConstantConfigurationSupport,
  constantConfigurationToSparseBus,
  type ConstantConfiguration,
} from '@comblang/factorio';
import type {
  DirectElaborationPlanV4,
  DirectPlanProducerV4,
  EntityPlanRecordV4,
  EntityV4ConstantConfiguration,
} from '@comblang/compiler/entity-v4';
import type { DirectElaborationPlan } from '@comblang/compiler/direct-plan-schema';
import {
  entityReplayContextRef,
  resolveEntityReplayProfile,
  type TrustedEntityReplayContext,
} from '@comblang/compiler/entity-replay-context';
import type { EntityId, EntityProfileRef } from '@comblang/compiler/entity';
import type { Diagnostic, SourceSpan } from '@comblang/shared';
import { validateEntityDirectPlan } from './entity-plan-validation.js';

type DataRecord = Record<string, unknown>;
const maximumArrayLength = 100_000;

export class EntityV4PlanValidationError extends Error {
  readonly code: string;
  readonly path: string;
  readonly detail: string;
  readonly span: SourceSpan | undefined;

  constructor(code: string, path: string, message: string, span?: SourceSpan) {
    super(`${path}: ${message}`);
    this.name = 'EntityV4PlanValidationError';
    this.code = code;
    this.path = path;
    this.detail = message;
    this.span = span;
  }
}

export interface ValidatedEntityPlanV4 {
  readonly plan: DirectElaborationPlanV4;
  readonly context: TrustedEntityReplayContext;
}

export interface EntityV4PlanValidationResult {
  readonly value?: ValidatedEntityPlanV4;
  readonly diagnostics: readonly Diagnostic[];
}

function invalid(code: string, path: string, message: string, span?: SourceSpan): never {
  throw new EntityV4PlanValidationError(code, path, message, span);
}

function dataRecord(value: unknown, path: string): DataRecord {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    invalid('RT4000', path, 'expected a plain data record.');
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null)
    invalid('RT4000', path, 'expected a plain object or null-prototype record.');
  const output = Object.create(null) as DataRecord;
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string')
      invalid('RT4000', `${path}[${String(key)}]`, 'symbol keys are not allowed.');
    const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
    if (!('value' in descriptor)) invalid('RT4000', `${path}.${key}`, 'accessors are not allowed.');
    output[key] = descriptor.value;
  }
  return output;
}

function dataArray(value: unknown, path: string): readonly unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype)
    invalid('RT4000', path, 'expected a plain array.');
  const length = Object.getOwnPropertyDescriptor(value, 'length')?.value;
  if (typeof length !== 'number' || !Number.isSafeInteger(length) || length < 0)
    invalid('RT4000', `${path}.length`, 'array length must be a non-negative safe integer.');
  if (length > maximumArrayLength)
    invalid('RT4000', path, `array exceeds the ${maximumArrayLength} item limit.`);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string')
      invalid('RT4000', `${path}[${String(key)}]`, 'symbol keys are not allowed.');
    if (key === 'length') continue;
    if (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= length)
      invalid('RT4000', `${path}.${key}`, 'unknown array field.');
    const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
    if (!('value' in descriptor))
      invalid('RT4000', `${path}[${key}]`, 'accessors are not allowed.');
  }
  const output: unknown[] = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (descriptor === undefined)
      invalid('RT4000', `${path}[${index}]`, 'array holes are not allowed.');
    output.push(descriptor.value);
  }
  return output;
}

function exactKeys(record: DataRecord, allowed: readonly string[], path: string): void {
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(record)) {
    if (!allowedSet.has(key)) invalid('RT4000', `${path}.${key}`, 'unknown Entity v4 field.');
  }
}

function text(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.length === 0)
    invalid('RT4000', path, 'expected a non-empty string.');
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

function profileReference(value: unknown, path: string): EntityProfileRef {
  const record = dataRecord(value, path);
  exactKeys(record, ['prototypeKey', 'database', 'profileId'], path);
  const database = dataRecord(record.database, `${path}.database`);
  exactKeys(database, ['schemaVersion', 'identity'], `${path}.database`);
  const schemaVersion = database.schemaVersion;
  if (
    typeof schemaVersion !== 'number' ||
    !Number.isSafeInteger(schemaVersion) ||
    schemaVersion < 1
  )
    invalid('RT4000', `${path}.database.schemaVersion`, 'expected a positive schema version.');
  return {
    prototypeKey: text(record.prototypeKey, `${path}.prototypeKey`),
    database: {
      schemaVersion,
      identity: text(database.identity, `${path}.database.identity`),
    },
    profileId: text(record.profileId, `${path}.profileId`) as EntityProfileRef['profileId'],
  };
}

function parseV4ConstantConfiguration(value: unknown, path: string): EntityV4ConstantConfiguration {
  const record = dataRecord(value, path);
  exactKeys(record, ['mode', 'value'], path);
  if (record.mode !== 'constant')
    invalid('RT4000', `${path}.mode`, 'only constant configuration is supported.');
  try {
    const value = canonicalizeConstantConfiguration(record.value, undefined, `${path}.value`);
    return Object.freeze({ mode: 'constant', value });
  } catch (error) {
    if (error instanceof Error && 'path' in error && 'detail' in error) {
      invalid('RT4000', String(error.path), String(error.detail));
    }
    throw error;
  }
}

function parseProducerMetadata(value: unknown, path: string): { readonly entityId?: EntityId } {
  const record = dataRecord(value, path);
  const entityId = 'entityId' in record ? text(record.entityId, `${path}.entityId`) : undefined;
  if (entityId !== undefined) return { entityId: entityId as EntityId };
  return {};
}

function parseRawProducers(value: unknown): readonly { readonly entityId?: EntityId }[] {
  return dataArray(value, '$.producers').map((entry, index) => {
    const path = `$.producers[${index}]`;
    const record = dataRecord(entry, path);
    const common = [
      'kind',
      'bindingName',
      'debugCaptureIds',
      'source',
      'instancePath',
      'placement',
      'destinations',
      'entityId',
    ];
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
      invalid('RT4000', `${path}.kind`, 'unknown Producer tag.', sourceOf(record));
    exactKeys(record, [...common, ...specific], path);
    const metadata = parseProducerMetadata(record, path);
    if (metadata.entityId !== undefined && kind !== 'constant')
      invalid(
        'RT4002',
        `${path}.entityId`,
        'only a Constant producer may be linked to an Entity.',
        sourceOf(record),
      );
    if (metadata.entityId !== undefined && 'placement' in record)
      invalid(
        'RT4002',
        `${path}.placement`,
        'a linked producer must omit placement; the Entity owns placement.',
        sourceOf(record),
      );
    return metadata;
  });
}

function parseRawEntities(
  value: unknown,
): ReadonlyMap<string, EntityV4ConstantConfiguration | undefined> {
  const constantConfigurations = new Map<string, EntityV4ConstantConfiguration | undefined>();
  for (const [index, entry] of dataArray(value, '$.entities').entries()) {
    const path = `$.entities[${index}]`;
    const record = dataRecord(entry, path);
    exactKeys(
      record,
      ['id', 'profile', 'configuration', 'connectorBindings', 'placement', 'provenance', 'ordinal'],
      path,
    );
    const id = text(record.id, `${path}.id`);
    if (constantConfigurations.has(id))
      invalid('RT4002', `${path}.id`, 'Entity IDs must be unique.', sourceOf(record.provenance));
    const configurationRecord =
      'configuration' in record
        ? dataRecord(record.configuration, `${path}.configuration`)
        : undefined;
    const constantConfiguration =
      configurationRecord?.mode === 'constant'
        ? parseV4ConstantConfiguration(configurationRecord, `${path}.configuration`)
        : undefined;
    // Validate the profile reference as data before the v3 projection resolves it.
    profileReference(record.profile, `${path}.profile`);
    constantConfigurations.set(id, constantConfiguration);
  }
  return constantConfigurations;
}

function projectEntityRecord(record: DataRecord, path: string): DataRecord {
  if (!('configuration' in record)) return record;
  const configuration = dataRecord(record.configuration, `${path}.configuration`);
  if (configuration.mode !== 'constant') return record;
  const { configuration: _configuration, ...withoutConfiguration } = record;
  return withoutConfiguration;
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
    entities: entities.map((entry) => {
      const record = dataRecord(entry, '$.entities');
      return projectEntityRecord(record, '$.entities');
    }),
  } as unknown as DirectElaborationPlan;
}

function validateValue(value: unknown, context: TrustedEntityReplayContext): ValidatedEntityPlanV4 {
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
  if (record.version !== 4)
    invalid('RT1001', '$.version', 'Entity computation plans require version 4.');

  const contextRecord = dataRecord(record.context, '$.context');
  const database = dataRecord(contextRecord.database, '$.context.database');
  if (
    database.identity !== context.database.identity ||
    database.schemaVersion !== context.database.schemaVersion ||
    contextRecord.profileSetIdentity !== context.profileSetIdentity ||
    contextRecord.evidenceIdentity !== context.evidenceIdentity ||
    contextRecord.policyIdentity !== context.policyIdentity
  ) {
    invalid(
      'RT4001',
      '$.context',
      'v4 computation requires the exact current replay context identity.',
    );
  }

  const rawProducers = dataArray(record.producers, '$.producers');
  const associations = parseRawProducers(rawProducers);
  const rawEntities = dataArray(record.entities, '$.entities');
  const constantConfigurations = parseRawEntities(rawEntities);
  const commonResult = validateEntityDirectPlan(
    projection(record, rawProducers, rawEntities),
    context,
  );
  if (!commonResult.value) {
    const diagnostic = commonResult.diagnostics[0];
    invalid(
      diagnostic?.code ?? 'RT4000',
      '$',
      diagnostic?.message ?? 'invalid v4 Entity plan.',
      diagnostic?.span,
    );
  }
  const commonPlan = commonResult.value.plan;
  const entitiesById = new Map(commonPlan.entities.map((entity) => [entity.id, entity]));
  const linked = new Map<EntityId, number>();
  const v4Producers: DirectPlanProducerV4[] = commonPlan.producers.map((producer, index) => {
    const entityId = associations[index]?.entityId;
    if (entityId === undefined) return producer as DirectPlanProducerV4;
    if (!entitiesById.has(entityId))
      invalid(
        'RT4002',
        `$.producers[${index}].entityId`,
        'linked Entity does not exist.',
        sourceOf(rawProducers[index]),
      );
    if (linked.has(entityId))
      invalid(
        'RT4002',
        `$.producers[${index}].entityId`,
        'an Entity may have at most one linked producer.',
        sourceOf(rawProducers[index]),
      );
    if (producer.kind !== 'constant')
      invalid(
        'RT4002',
        `$.producers[${index}].entityId`,
        'only a Constant producer may be linked to an Entity.',
        sourceOf(rawProducers[index]),
      );
    linked.set(entityId, index);
    return Object.freeze({ ...producer, entityId });
  });

  const v4Entities: EntityPlanRecordV4[] = commonPlan.entities.map((entity) => {
    const constantConfiguration = constantConfigurations.get(entity.id);
    const producerIndex = linked.get(entity.id);
    if (constantConfiguration !== undefined && producerIndex === undefined)
      invalid(
        'RT4002',
        `$.entities[${rawEntities.findIndex((entry) => dataRecord(entry, '$.entities').id === entity.id)}].configuration`,
        'configured Entity must have one linked Constant producer.',
      );
    if (producerIndex !== undefined) {
      if (constantConfiguration === undefined)
        invalid(
          'RT4002',
          `$.producers[${producerIndex}].entityId`,
          'linked Entity must declare constant configuration.',
        );
      const profile = resolveEntityReplayProfile(entity.profile, context);
      if (profile.prototypeType !== 'constant-combinator')
        invalid(
          'RT4002',
          `$.entities[${rawEntities.findIndex((entry) => dataRecord(entry, '$.entities').id === entity.id)}].profile`,
          'linked Entity profile must identify the constant-combinator family.',
        );
      const support = classifyConstantConfigurationSupport(constantConfiguration.value);
      if (support.status === 'unsupported')
        invalid(
          'RT4003',
          `$.entities[${rawEntities.findIndex((entry) => dataRecord(entry, '$.entities').id === entity.id)}].configuration.value`,
          `unsupported Constant configuration: ${support.reasons.join(', ')}.`,
        );
      const expected = constantConfigurationToSparseBus(constantConfiguration.value).toJSON();
      const actual = (
        v4Producers[producerIndex] as Extract<DirectPlanProducerV4, { kind: 'constant' }>
      ).outputs;
      if (JSON.stringify(actual) !== JSON.stringify(expected))
        invalid(
          'RT4003',
          `$.producers[${producerIndex}].outputs`,
          'Constant producer outputs must equal the linked Entity configuration projection.',
          sourceOf(rawProducers[producerIndex]),
        );
    }
    return Object.freeze(
      constantConfiguration === undefined
        ? entity
        : { ...entity, configuration: constantConfiguration },
    ) as EntityPlanRecordV4;
  });

  return Object.freeze({
    plan: Object.freeze({
      format: 'comblang-direct-plan',
      version: 4,
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
      producers: Object.freeze(v4Producers),
      entities: Object.freeze(v4Entities),
      ...(commonPlan.diagnostics === undefined ? {} : { diagnostics: commonPlan.diagnostics }),
    }),
    context,
  });
}

/** Validates v4 computation semantics and its embedded v3 topology before allocation. */
export function validateEntityV4DirectPlan(
  value: unknown,
  context: TrustedEntityReplayContext,
): EntityV4PlanValidationResult {
  try {
    return { value: validateValue(value, context), diagnostics: [] };
  } catch (error) {
    if (error instanceof EntityV4PlanValidationError) {
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
          code: 'RT4099',
          severity: 'error',
          message: error instanceof Error ? error.message : 'Entity v4 validation failed.',
        },
      ],
    };
  }
}

export const validateEntityDirectPlanV4 = validateEntityV4DirectPlan;

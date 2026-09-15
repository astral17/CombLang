import { canonicalizeConstantConfiguration } from '@comblang/factorio';
import type { Diagnostic, SourceSpan } from '@comblang/shared';
import type {
  DirectElaborationPlanV5,
  EntityV5ArithmeticPhysicalConfiguration,
  EntityV5PhysicalConfiguration,
  EntityPhysicalRecordV5,
  NativeCircuitIrV5,
} from './entity-v5.js';
import type { EntityId } from './entity.js';
import { cloneAndDeepFreeze } from './immutable.js';
import { parseResolvedSourceCircuit } from './resolved-source-circuit.js';

export const resolvedEntityV5CircuitFormat = 'comblang-resolved-entity-v5' as const;
export const resolvedEntityV5CircuitVersion = 1 as const;

export interface ResolvedEntityV5Circuit {
  readonly format: typeof resolvedEntityV5CircuitFormat;
  readonly version: typeof resolvedEntityV5CircuitVersion;
  readonly planFingerprint: string;
  readonly ir: NativeCircuitIrV5;
}

export class ResolvedEntityV5CircuitError extends Error {
  readonly code = 'RSC5001';
  constructor(
    readonly path: string,
    readonly detail: string,
    readonly span?: SourceSpan,
  ) {
    super(`${path}: ${detail}`);
    this.name = 'ResolvedEntityV5CircuitError';
  }
}

export interface ResolvedEntityV5CircuitValidationResult {
  readonly value?: ResolvedEntityV5Circuit;
  readonly diagnostics: readonly Diagnostic[];
}

type DataRecord = Record<string, unknown>;
const maximumArrayLength = 100_000;

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

function invalid(path: string, detail: string, span?: SourceSpan): never {
  throw new ResolvedEntityV5CircuitError(path, detail, span);
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
  return Array.from({ length }, (_, index) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (descriptor === undefined) invalid(`${path}[${index}]`, 'array holes are not allowed.');
    return descriptor.value;
  });
}

function exactKeys(record: DataRecord, keys: readonly string[], path: string): void {
  const allowed = new Set(keys);
  for (const key of Reflect.ownKeys(record)) {
    if (typeof key !== 'string' || !allowed.has(key))
      invalid(`${path}.${String(key)}`, 'unknown resolved v5 field.');
  }
}

function text(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.length === 0)
    invalid(path, 'expected a non-empty string.');
  return value;
}

function producerArithmeticConfiguration(
  producer: Extract<NativeCircuitIrV5['producers'][number], { readonly kind: 'arithmetic' }>,
  networkNames: ReadonlyMap<string, string>,
) {
  const operand = (value: typeof producer.config.left) => {
    if (value.kind === 'constant') return value;
    return {
      ...value,
      ...(value.refKind === 'single'
        ? { network: networkNames.get(value.network) ?? value.network }
        : {
            networks: value.networks.map((network) => networkNames.get(network) ?? network),
          }),
    };
  };
  return {
    left: operand(producer.config.left),
    operation: producer.config.operation,
    right: operand(producer.config.right),
    output: producer.config.output,
  };
}

function parseArithmeticConfiguration(
  value: unknown,
  path: string,
): EntityV5ArithmeticPhysicalConfiguration {
  const record = dataRecord(value, path);
  exactKeys(record, ['mode', 'left', 'operation', 'right', 'output'], path);
  if (record.mode !== 'arithmetic') invalid(`${path}.mode`, 'expected arithmetic configuration.');
  if (
    typeof record.operation !== 'string' ||
    !new Set([
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
    ]).has(record.operation)
  )
    invalid(`${path}.operation`, 'expected a canonical Arithmetic operation.');
  const operand = (value: unknown, operandPath: string): unknown => {
    const operandRecord = dataRecord(value, operandPath);
    if (operandRecord.kind === 'constant') {
      exactKeys(operandRecord, ['kind', 'value'], operandPath);
      if (typeof operandRecord.value !== 'number' || !Number.isSafeInteger(operandRecord.value))
        invalid(`${operandPath}.value`, 'expected a safe integer circuit constant.');
      return { kind: 'constant', value: operandRecord.value };
    }
    if (operandRecord.kind !== 'each' && operandRecord.kind !== 'signal')
      invalid(`${operandPath}.kind`, 'expected an Arithmetic operand.');
    exactKeys(operandRecord, ['kind', 'refKind', 'network', 'networks', 'signal'], operandPath);
    if (operandRecord.refKind === 'single') text(operandRecord.network, `${operandPath}.network`);
    else if (operandRecord.refKind === 'pair') {
      const networks = dataArray(operandRecord.networks, `${operandPath}.networks`);
      if (networks.length !== 2) invalid(`${operandPath}.networks`, 'expected two network names.');
      networks.forEach((network, index) => text(network, `${operandPath}.networks[${index}]`));
    } else invalid(`${operandPath}.refKind`, 'expected a single or pair reference.');
    return operandRecord;
  };
  const output = dataRecord(record.output, `${path}.output`);
  let canonicalOutput: EntityV5ArithmeticPhysicalConfiguration['output'];
  if (output.kind === 'each') {
    exactKeys(output, ['kind'], `${path}.output`);
    canonicalOutput = { kind: 'each' };
  } else {
    exactKeys(output, ['kind', 'signal'], `${path}.output`);
    if (output.kind !== 'signal') invalid(`${path}.output.kind`, 'expected each or signal output.');
    canonicalOutput = {
      kind: 'signal',
      signal: dataRecord(
        output.signal,
        `${path}.output.signal`,
      ) as EntityV5ArithmeticPhysicalConfiguration['output'] extends {
        kind: 'signal';
        signal: infer T;
      }
        ? T
        : never,
    };
  }
  return Object.freeze({
    mode: 'arithmetic',
    left: operand(record.left, `${path}.left`) as EntityV5ArithmeticPhysicalConfiguration['left'],
    operation: record.operation as EntityV5ArithmeticPhysicalConfiguration['operation'],
    right: operand(
      record.right,
      `${path}.right`,
    ) as EntityV5ArithmeticPhysicalConfiguration['right'],
    output: canonicalOutput,
  });
}

function parseConfiguration(value: unknown, path: string): EntityV5PhysicalConfiguration {
  const record = dataRecord(value, path);
  if (record.mode === 'constant') {
    exactKeys(record, ['mode', 'value'], path);
    return Object.freeze({
      mode: 'constant',
      value: canonicalizeConstantConfiguration(record.value, undefined, `${path}.value`),
    });
  }
  return parseArithmeticConfiguration(record, path);
}

function parseArtifact(value: unknown): {
  fingerprint: string;
  producers: readonly unknown[];
  entities: readonly unknown[];
  ir: DataRecord;
} {
  const record = dataRecord(value, '$');
  exactKeys(record, ['format', 'version', 'planFingerprint', 'ir'], '$');
  if (record.format !== resolvedEntityV5CircuitFormat)
    invalid('$.format', 'unsupported resolved Entity v5 circuit format.');
  if (record.version !== resolvedEntityV5CircuitVersion)
    invalid('$.version', 'unsupported resolved Entity v5 circuit version.');
  const fingerprint = text(record.planFingerprint, '$.planFingerprint');
  if (!/^v5-[0-9a-f]{16}$/.test(fingerprint))
    invalid('$.planFingerprint', 'expected a canonical v5 plan fingerprint.');
  const ir = dataRecord(record.ir, '$.ir');
  exactKeys(ir, ['format', 'version', 'context', 'networks', 'producers', 'entities'], '$.ir');
  if (ir.format !== 'comblang-ncir' || ir.version !== 5)
    invalid('$.ir', 'resolved v5 IR requires version 5.');
  const producers = dataArray(ir.producers, '$.ir.producers');
  const entities = dataArray(ir.entities, '$.ir.entities');
  const linked = new Set<string>();
  producers.forEach((entry, index) => {
    const producer = dataRecord(entry, `$.ir.producers[${index}]`);
    if ('entityId' in producer) {
      if (producer.kind !== 'arithmetic' && producer.kind !== 'constant')
        invalid(
          `$.ir.producers[${index}].entityId`,
          'only Arithmetic or Constant producers may be linked.',
        );
      if ('placement' in producer)
        invalid(`$.ir.producers[${index}].placement`, 'linked producer placement must be omitted.');
      const id = text(producer.entityId, `$.ir.producers[${index}].entityId`);
      if (linked.has(id))
        invalid(
          `$.ir.producers[${index}].entityId`,
          'an Entity may have only one linked producer.',
        );
      linked.add(id);
    }
  });
  entities.forEach((entry, index) => {
    const entity = dataRecord(entry, `$.ir.entities[${index}]`);
    if ('configuration' in entity) {
      const configuration = dataRecord(
        entity.configuration,
        `$.ir.entities[${index}].configuration`,
      );
      if (configuration.mode === 'constant' || configuration.mode === 'arithmetic')
        parseConfiguration(configuration, `$.ir.entities[${index}].configuration`);
    }
  });
  return { fingerprint, producers, entities, ir };
}

export function resolvedEntityV5CircuitPlanFingerprint(plan: DirectElaborationPlanV5): string {
  const serialized = stableJson(plan);
  let hash = 0xcbf29ce484222325n;
  for (let index = 0; index < serialized.length; index += 1) {
    hash ^= BigInt(serialized.charCodeAt(index));
    hash = (hash * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  return `v5-${hash.toString(16).padStart(16, '0')}`;
}

export function assertResolvedEntityV5CircuitMatchesPlan(
  plan: DirectElaborationPlanV5,
  artifact: ResolvedEntityV5Circuit,
): void {
  if (artifact.planFingerprint !== resolvedEntityV5CircuitPlanFingerprint(plan))
    invalid(
      '$.planFingerprint',
      'resolved v5 circuit fingerprint does not match the current plan.',
    );
  if (stableJson(plan.context) !== stableJson(artifact.ir.context))
    invalid('$.ir.context', 'resolved v5 circuit context does not match the current plan.');
  if (
    plan.producers.length !== artifact.ir.producers.length ||
    plan.entities.length !== artifact.ir.entities.length
  )
    invalid('$.ir', 'resolved v5 circuit cardinality does not match the current plan.');
  const entities = new Map(artifact.ir.entities.map((entity) => [entity.id, entity]));
  const networkNames = new Map(
    artifact.ir.networks.map((network) => [network.id, network.name ?? network.id] as const),
  );
  for (const entity of plan.entities) {
    const physical = entities.get(entity.id);
    const linkedConfiguration =
      entity.configuration?.mode === 'constant' || entity.configuration?.mode === 'arithmetic'
        ? entity.configuration
        : undefined;
    const configurationMatches =
      linkedConfiguration === undefined
        ? true
        : linkedConfiguration.mode === 'constant'
          ? stableJson(physical?.configuration) === stableJson(linkedConfiguration)
          : (() => {
              const producer = artifact.ir.producers.find(
                (
                  candidate,
                ): candidate is Extract<
                  NativeCircuitIrV5['producers'][number],
                  { readonly kind: 'arithmetic' }
                > & { readonly entityId: EntityId } =>
                  candidate.kind === 'arithmetic' && candidate.entityId === entity.id,
              );
              return (
                physical?.configuration?.mode === 'arithmetic' &&
                producer !== undefined &&
                stableJson(producerArithmeticConfiguration(producer, networkNames)) ===
                  stableJson({
                    left: linkedConfiguration.left,
                    operation: linkedConfiguration.operation,
                    right: linkedConfiguration.right,
                    output: linkedConfiguration.output,
                  })
              );
            })();
    if (
      physical === undefined ||
      physical.ordinal !== entity.ordinal ||
      stableJson(physical.profile) !== stableJson(entity.profile) ||
      !configurationMatches
    )
      invalid(`$.ir.entities[${entity.id}]`, 'resolved v5 Entity does not match the current plan.');
  }
  for (const [index, producer] of plan.producers.entries()) {
    if (artifact.ir.producers[index]?.entityId !== producer.entityId)
      invalid(
        `$.ir.producers[${index}].entityId`,
        'resolved v5 producer association does not match the current plan.',
      );
  }
}

export function parseResolvedEntityV5Circuit(value: unknown): ResolvedEntityV5Circuit {
  const { fingerprint, producers: rawProducers, entities: rawEntities, ir } = parseArtifact(value);
  const projected = {
    format: 'comblang-resolved-source-circuit',
    version: 1,
    planFingerprint: 'v1-0000000000000000',
    ir: {
      ...ir,
      version: 3,
      producers: rawProducers.map((entry) => {
        const { entityId: _entityId, ...producer } = dataRecord(entry, '$.ir.producers');
        return producer;
      }),
      entities: rawEntities.map((entry) => {
        const entity = dataRecord(entry, '$.ir.entities');
        const configuration =
          'configuration' in entity
            ? dataRecord(entity.configuration, '$.ir.entities.configuration')
            : undefined;
        return configuration !== undefined &&
          (configuration.mode === 'constant' || configuration.mode === 'arithmetic')
          ? Object.fromEntries(Object.entries(entity).filter(([key]) => key !== 'configuration'))
          : entity;
      }),
    },
  };
  const parsed = parseResolvedSourceCircuit(projected);
  const networkNames = new Map(
    parsed.ir.networks.map((network) => [network.id, network.name ?? network.id] as const),
  );
  const associations = rawProducers.map((entry) => {
    const producer = dataRecord(entry, '$.ir.producers');
    return 'entityId' in producer
      ? (text(producer.entityId, '$.ir.producers.entityId') as EntityId)
      : undefined;
  });
  const entityConfigs = new Map<string, EntityV5PhysicalConfiguration | undefined>();
  rawEntities.forEach((entry, index) => {
    const entity = dataRecord(entry, `$.ir.entities[${index}]`);
    const configuration =
      'configuration' in entity
        ? dataRecord(entity.configuration, `$.ir.entities[${index}].configuration`)
        : undefined;
    if (
      configuration !== undefined &&
      (configuration.mode === 'constant' || configuration.mode === 'arithmetic')
    ) {
      entityConfigs.set(
        text(entity.id, `$.ir.entities[${index}].id`),
        parseConfiguration(configuration, `$.ir.entities[${index}].configuration`),
      );
    }
  });
  const linked = new Set<EntityId>();
  const producers = parsed.ir.producers.map((producer, index) => {
    const entityId = associations[index];
    if (entityId === undefined) return producer;
    if (!entityConfigs.has(entityId))
      invalid(`$.ir.producers[${index}].entityId`, 'linked Entity does not exist.');
    linked.add(entityId);
    const configuration = entityConfigs.get(entityId);
    if (configuration === undefined)
      invalid(`$.ir.producers[${index}].entityId`, 'linked Entity must carry configuration.');
    if (configuration.mode === 'constant' && producer.kind !== 'constant')
      invalid(
        `$.ir.producers[${index}]`,
        'linked producer family does not match Entity configuration.',
      );
    if (
      configuration.mode === 'arithmetic' &&
      (producer.kind !== 'arithmetic' ||
        stableJson(producerArithmeticConfiguration(producer, new Map())) !==
          stableJson({
            left: configuration.left,
            operation: configuration.operation,
            right: configuration.right,
            output: configuration.output,
          }))
    )
      invalid(
        `$.ir.producers[${index}]`,
        'Arithmetic producer configuration does not match linked Entity configuration.',
      );
    return Object.freeze({ ...producer, entityId });
  });
  const entities: EntityPhysicalRecordV5[] = parsed.ir.entities.map((entity) => {
    const configuration = entityConfigs.get(entity.id);
    if (configuration !== undefined && !linked.has(entity.id))
      invalid(
        `$.ir.entities[${entity.id}].configuration`,
        'configured Entity must have a linked producer.',
      );
    return (configuration === undefined
      ? entity
      : Object.freeze({ ...entity, configuration })) as unknown as EntityPhysicalRecordV5;
  });
  return cloneAndDeepFreeze({
    format: resolvedEntityV5CircuitFormat,
    version: 1,
    planFingerprint: fingerprint,
    ir: {
      format: 'comblang-ncir',
      version: 5,
      context: parsed.ir.context,
      networks: parsed.ir.networks,
      producers,
      entities,
    },
  }) as ResolvedEntityV5Circuit;
}

export function snapshotResolvedEntityV5CircuitFromPlan(
  plan: DirectElaborationPlanV5,
  ir: NativeCircuitIrV5,
): ResolvedEntityV5Circuit {
  const snapshot = parseResolvedEntityV5Circuit({
    format: resolvedEntityV5CircuitFormat,
    version: 1,
    planFingerprint: resolvedEntityV5CircuitPlanFingerprint(plan),
    ir,
  });
  assertResolvedEntityV5CircuitMatchesPlan(plan, snapshot);
  return snapshot;
}

export function validateResolvedEntityV5Circuit(
  value: unknown,
): ResolvedEntityV5CircuitValidationResult {
  try {
    return { value: parseResolvedEntityV5Circuit(value), diagnostics: [] };
  } catch (error) {
    if (error instanceof ResolvedEntityV5CircuitError)
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
          code: 'RSC5099',
          severity: 'error',
          message: error instanceof Error ? error.message : 'Resolved Entity v5 validation failed.',
        },
      ],
    };
  }
}

export const snapshotResolvedEntityV5Circuit = parseResolvedEntityV5Circuit;

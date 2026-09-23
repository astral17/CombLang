import type { NetworkId, ProducerId, SourceSpan } from '@comblang/shared';

import { lowerNativeBlueprintConfig, BlueprintJsonError } from './blueprint-native-config.js';
import {
  canonicalizeEntityNativeSingleCondition,
  EntityConfigurationError,
} from './entity-configuration.js';
import { canonicalizeEntityRawObject, EntityRawJsonError } from './entity-raw.js';
import type {
  EntityBehaviorKey,
  EntityConnectorKey,
  EntityFeatureKey,
  EntityLaneKey,
  EntityNativeField,
  EntityRawJsonObject,
  EntityPhysicalRecord,
  EntityPhysicalTypedConfiguration,
} from './entity.js';
import type { CircuitColor, CircuitProducerNode, NativeCircuitIr } from './ir.js';
import {
  constantEntityControlBehavior,
  signalJson,
  comparatorJson,
} from './native-blueprint-fields.js';
import type {
  NativeBlueprintEntity,
  NativeBlueprintFcir,
  NativeBlueprintJsonObject,
  NativeBlueprintWireEndpoint,
} from './native-blueprint-ir.js';
import { validateNativeBlueprintFcir } from './native-blueprint-ir.js';

const FACTORIO_2_0_VERSION = 562_949_953_421_312;

export interface NativeBlueprintProjectionOptions {
  readonly label: string;
  readonly maxDeciderConditionRows: number;
}

type BlueprintFail = (message: string) => never;
type DataRecord = Record<string, unknown>;

function dataRecord(value: unknown, path: string, fail: BlueprintFail): DataRecord {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    fail(`${path}: expected a plain data record.`);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null)
    fail(`${path}: expected a plain object or null-prototype record.`);
  const output = Object.create(null) as DataRecord;
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string') fail(`${path}[${String(key)}]: symbol keys are not allowed.`);
    const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
    if (!('value' in descriptor)) fail(`${path}.${key}: accessors are not allowed.`);
    output[key] = descriptor.value;
  }
  return output;
}

function dataArray(value: unknown, path: string, fail: BlueprintFail): readonly unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype)
    fail(`${path}: expected a plain array.`);
  const lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length');
  if (lengthDescriptor === undefined || !('value' in lengthDescriptor))
    fail(`${path}.length: array length must be data-only.`);
  const length = lengthDescriptor.value;
  if (typeof length !== 'number' || !Number.isSafeInteger(length) || length < 0)
    fail(`${path}.length: array length must be a non-negative safe integer.`);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string') fail(`${path}[${String(key)}]: symbol keys are not allowed.`);
    if (key === 'length') continue;
    if (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= length)
      fail(`${path}.${key}: unknown array field.`);
    const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
    if (!('value' in descriptor)) fail(`${path}[${key}]: accessors are not allowed.`);
  }
  const output: unknown[] = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (descriptor === undefined) fail(`${path}[${index}]: array holes are not allowed.`);
    if (!('value' in descriptor)) fail(`${path}[${index}]: accessors are not allowed.`);
    output.push(descriptor.value);
  }
  return output;
}

function exactKeys(
  record: DataRecord,
  allowed: readonly string[],
  path: string,
  fail: BlueprintFail,
): void {
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(record)) {
    if (!allowedSet.has(key)) fail(`${path}.${key}: unknown physical Entity configuration field.`);
  }
}

function identifier(value: unknown, path: string, fail: BlueprintFail): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)
  )
    fail(`${path}: expected a non-empty ASCII identifier.`);
  return value;
}

function validateEntityTypedConfiguration(
  value: unknown,
  fail: BlueprintFail,
): EntityPhysicalTypedConfiguration {
  const path = '$.configuration';
  const record = dataRecord(value, path, fail);
  exactKeys(
    record,
    ['mode', 'rule', 'feature', 'nativeField', 'connector', 'lanes', 'laneMask', 'condition'],
    path,
    fail,
  );
  if (record.mode !== 'typed') fail(`${path}.mode: expected typed configuration.`);
  const rule = identifier(record.rule, `${path}.rule`, fail) as EntityBehaviorKey;
  const feature = identifier(record.feature, `${path}.feature`, fail) as EntityFeatureKey;
  const nativeField = record.nativeField;
  if (nativeField !== 'control_behavior.circuit_condition')
    fail(`${path}.nativeField: unsupported native Entity configuration field.`);
  const connector = identifier(record.connector, `${path}.connector`, fail) as EntityConnectorKey;
  const lanes = dataArray(record.lanes, `${path}.lanes`, fail).map(
    (lane, index) => identifier(lane, `${path}.lanes[${index}]`, fail) as EntityLaneKey,
  );
  if (lanes.length === 0) fail(`${path}.lanes: at least one lane must be selected.`);
  const seenLanes = new Set<EntityLaneKey>();
  for (const lane of lanes) {
    if (seenLanes.has(lane)) fail(`${path}.lanes: duplicate lane ${JSON.stringify(lane)}.`);
    seenLanes.add(lane);
  }

  const mask = dataRecord(record.laneMask, `${path}.laneMask`, fail);
  exactKeys(mask, ['red', 'green'], `${path}.laneMask`, fail);
  if (!('red' in mask)) fail(`${path}.laneMask.red: field is required.`);
  if (!('green' in mask)) fail(`${path}.laneMask.green: field is required.`);
  if (typeof mask.red !== 'boolean') fail(`${path}.laneMask.red: expected a boolean.`);
  if (typeof mask.green !== 'boolean') fail(`${path}.laneMask.green: expected a boolean.`);
  if (!mask.red && !mask.green) fail(`${path}.laneMask: at least one color must be selected.`);

  const conditionRecord = dataRecord(record.condition, `${path}.condition`, fail);
  let condition;
  try {
    condition = canonicalizeEntityNativeSingleCondition(conditionRecord, `${path}.condition`);
  } catch (error) {
    if (error instanceof EntityConfigurationError) fail(`${error.path}: ${error.detail}`);
    fail(`${path}.condition: invalid native Entity condition.`);
  }
  if (!Object.is(conditionRecord.constant, condition.constant)) {
    fail(`${path}.condition.constant: physical constant is not normalized to signed int32.`);
  }

  return Object.freeze({
    mode: 'typed',
    rule,
    feature,
    nativeField: nativeField as EntityNativeField,
    connector,
    lanes: Object.freeze(lanes),
    laneMask: Object.freeze({ red: mask.red as boolean, green: mask.green as boolean }),
    condition,
  });
}

function entityControlBehavior(
  configuration: EntityPhysicalTypedConfiguration,
): Record<string, unknown> {
  return {
    circuit_condition: {
      first_signal: signalJson(configuration.condition.signal),
      first_signal_networks: { ...configuration.laneMask },
      comparator: comparatorJson(configuration.condition.comparator),
      constant: configuration.condition.constant,
    },
  };
}

interface WireEndpoint extends NativeBlueprintWireEndpoint {
  readonly source?: SourceSpan;
}

function connector(
  producer: CircuitProducerNode,
  side: 'input' | 'output',
  color: CircuitColor,
): number {
  const colorOffset = color === 'red' ? 0 : 1;
  return producer.kind === 'constant' || side === 'input' ? 1 + colorOffset : 3 + colorOffset;
}

function immutableSource(source: SourceSpan | undefined): SourceSpan | undefined {
  return source === undefined
    ? undefined
    : Object.freeze({ fileId: source.fileId, start: source.start, end: source.end });
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    if (!Object.isFrozen(value)) Object.freeze(value);
  }
  return value;
}

/** Projects resolved NCIR into an immutable, validated native blueprint document. */
export function buildNativeBlueprintFcir(
  ir: NativeCircuitIr,
  options: NativeBlueprintProjectionOptions,
): NativeBlueprintFcir {
  const maxRows = options.maxDeciderConditionRows;
  if (!Number.isSafeInteger(maxRows) || maxRows < 1) {
    throw new RangeError('maxDeciderConditionRows must be a positive safe integer.');
  }
  const physicalEntities = ir.entities ?? [];
  const entitiesById = new Map(physicalEntities.map((entity) => [entity.id, entity]));
  const linkedEntities = new Map<ProducerId, EntityPhysicalRecord>();
  for (const producer of ir.producers) {
    if (producer.entityId === undefined) continue;
    const entity = entitiesById.get(producer.entityId);
    if (entity === undefined)
      throw new BlueprintJsonError(
        `Missing physical Entity for linked producer ${producer.id}.`,
        producer.provenance.source,
      );
    linkedEntities.set(producer.id, entity);
  }

  const lowered = lowerNativeBlueprintConfig(ir, maxRows);
  const numbers = new Map<ProducerId, number>(
    ir.producers.map((producer, index) => [producer.id, index + 1]),
  );
  const endpoints = new Map<NetworkId, WireEndpoint[]>();
  const addEndpoint = (network: NetworkId, endpoint: WireEndpoint) => {
    const list = endpoints.get(network) ?? [];
    if (
      !list.some(
        (value) =>
          value.entityNumber === endpoint.entityNumber && value.connector === endpoint.connector,
      )
    ) {
      list.push(endpoint);
      endpoints.set(network, list);
    }
  };

  for (const { producer, inputNetworks } of lowered.combinators) {
    const entityNumber = numbers.get(producer.id)!;
    for (const network of inputNetworks) {
      addEndpoint(network, {
        entityNumber,
        connector: connector(producer, 'input', lowered.networkColors.get(network)!),
        ...(producer.provenance.source === undefined ? {} : { source: producer.provenance.source }),
      });
    }
    for (const network of producer.destinations) {
      addEndpoint(network, {
        entityNumber,
        connector: connector(producer, 'output', lowered.networkColors.get(network)!),
        ...(producer.provenance.source === undefined ? {} : { source: producer.provenance.source }),
      });
    }
  }

  const sortedEntities = [...physicalEntities].sort((a, b) => a.ordinal - b.ordinal);
  const ids = new Set<string>();
  const ordinals = new Set<number>();
  const typedConfigurations = new Map<string, EntityPhysicalTypedConfiguration>();
  const rawConfigurations = new Map<string, EntityRawJsonObject>();
  for (const [index, entity] of sortedEntities.entries()) {
    const failEntity = (message: string): never => {
      throw new BlueprintJsonError(message, entity.provenance.source);
    };
    if (ids.has(entity.id) || ordinals.has(entity.ordinal))
      failEntity('Duplicate physical Entity identity or ordinal.');
    ids.add(entity.id);
    ordinals.add(entity.ordinal);
    const linked = [...linkedEntities.values()].find(({ id }) => id === entity.id);
    if (linked !== undefined) {
      if (
        entity.configuration?.mode !== 'constant' &&
        entity.configuration?.mode !== 'arithmetic' &&
        entity.configuration?.mode !== 'decider' &&
        entity.configuration?.mode !== 'selector'
      )
        failEntity(
          'Linked Entity requires Constant, Arithmetic, Decider, or Selector configuration.',
        );
    } else if (entity.configuration !== undefined) {
      const configuration = dataRecord(entity.configuration, '$.configuration', failEntity);
      if (configuration.mode === 'raw') {
        exactKeys(configuration, ['mode', 'payload'], '$.configuration', failEntity);
        try {
          rawConfigurations.set(
            entity.id,
            canonicalizeEntityRawObject(
              configuration.payload,
              undefined,
              '$.configuration.payload',
            ),
          );
        } catch (error) {
          if (error instanceof EntityRawJsonError) failEntity(error.message);
          throw error;
        }
      } else {
        if (configuration.mode !== 'typed')
          failEntity('$.configuration.mode: unsupported configuration mode.');
        if ('payload' in configuration)
          failEntity('Raw/typed Entity configuration preview lowering is unsupported.');
        typedConfigurations.set(
          entity.id,
          validateEntityTypedConfiguration(configuration, failEntity),
        );
      }
    }
    if (
      !/^[^:\s]+$/.test(entity.prototypeName) ||
      entity.profile.prototypeKey !== `entity:${entity.prototypeName}`
    )
      failEntity('Invalid physical Entity prototype name.');
    for (const binding of entity.connectorBindings) {
      if (binding.network === undefined) continue;
      const ordinal = binding.nativeConnector;
      if (
        ordinal === undefined ||
        !Number.isSafeInteger(ordinal) ||
        ordinal < 1 ||
        !Number.isSafeInteger(ordinal * 2)
      )
        failEntity('Missing or invalid native Entity connector ordinal.');
      if (lowered.networkColors.get(binding.network) !== binding.endpoint.color)
        failEntity('Entity endpoint requires a matching resolved Network color.');
      const linkedProducer = ir.producers.find(
        (producer) => linkedEntities.get(producer.id)?.id === entity.id,
      );
      addEndpoint(binding.network, {
        entityNumber:
          linkedProducer === undefined
            ? ir.producers.length + index + 1
            : numbers.get(linkedProducer.id)!,
        connector: ordinal! * 2 - (binding.endpoint.color === 'red' ? 1 : 0),
        source: binding.provenance.source,
      });
    }
  }

  const wires: NativeBlueprintFcir['wires'][number][] = [];
  for (const list of endpoints.values()) {
    for (let index = 1; index < list.length; index += 1) {
      const left = list[index - 1]!;
      const right = list[index]!;
      const source = immutableSource(right.source ?? left.source);
      wires.push({
        from: { entityNumber: left.entityNumber, connector: left.connector },
        to: { entityNumber: right.entityNumber, connector: right.connector },
        ...(source === undefined ? {} : { source }),
      });
    }
  }

  const entities: NativeBlueprintEntity[] = lowered.combinators.map(
    ({ producer, entity }, index) => {
      const linked = linkedEntities.get(producer.id);
      let native: Record<string, unknown>;
      if (linked === undefined) {
        native = {
          ...entity,
          position:
            producer.placement === undefined
              ? { x: index * 2 + 0.5, y: 0.5 }
              : { x: producer.placement.x, y: producer.placement.y },
          direction: producer.placement?.direction ?? 4,
        };
      } else if (
        linked.configuration?.mode === 'arithmetic' ||
        linked.configuration?.mode === 'decider' ||
        linked.configuration?.mode === 'selector'
      ) {
        native = {
          name: linked.prototypeName,
          control_behavior: entity.control_behavior,
          position: linked.placement
            ? { x: linked.placement.x, y: linked.placement.y }
            : { x: index * 2 + 0.5, y: 0.5 },
          direction: linked.placement?.direction ?? 4,
        };
      } else if (linked.configuration?.mode === 'constant') {
        native = {
          name: linked.prototypeName,
          control_behavior: constantEntityControlBehavior(linked.configuration.value),
          position: linked.placement
            ? { x: linked.placement.x, y: linked.placement.y }
            : { x: index * 2 + 0.5, y: 0.5 },
          direction: linked.placement?.direction ?? 4,
        };
      } else {
        throw new BlueprintJsonError(
          'Linked Entity requires Constant, Arithmetic, Decider, or Selector configuration.',
          linked.provenance.source,
        );
      }
      const source = immutableSource(linked?.provenance.source ?? producer.provenance.source);
      return {
        entityNumber: numbers.get(producer.id)!,
        native: native as NativeBlueprintJsonObject,
        ...(source === undefined ? {} : { source }),
      };
    },
  );

  const occupied = new Set(entities.map((entity) => JSON.stringify(entity.native.position)));
  for (const entity of sortedEntities) {
    if (entity.placement)
      occupied.add(JSON.stringify({ x: entity.placement.x, y: entity.placement.y }));
  }
  let automaticIndex = ir.producers.length;
  for (const [index, entity] of sortedEntities.entries()) {
    if ([...linkedEntities.values()].some((linked) => linked.id === entity.id)) continue;
    const typedConfiguration = typedConfigurations.get(entity.id);
    const rawConfiguration = rawConfigurations.get(entity.id);
    let position = entity.placement
      ? { x: entity.placement.x, y: entity.placement.y }
      : { x: automaticIndex * 2 + 0.5, y: 0.5 };
    if (!entity.placement) {
      while (occupied.has(JSON.stringify(position)))
        position = { x: ++automaticIndex * 2 + 0.5, y: 0.5 };
      automaticIndex++;
    }
    occupied.add(JSON.stringify(position));
    const native: Record<string, unknown> = {
      name: entity.prototypeName,
      ...(typedConfiguration !== undefined
        ? { control_behavior: entityControlBehavior(typedConfiguration) }
        : {}),
      position,
      direction: entity.placement?.direction ?? 4,
    };
    entities.push({
      entityNumber: ir.producers.length + index + 1,
      native: native as NativeBlueprintJsonObject,
      ...(rawConfiguration === undefined
        ? {}
        : { nativeBeforeNumber: rawConfiguration as NativeBlueprintJsonObject }),
      ...(entity.provenance.source === undefined
        ? {}
        : { source: immutableSource(entity.provenance.source)! }),
    });
  }

  const fcir = deepFreeze({
    header: {
      item: 'blueprint' as const,
      label: options.label,
      version: FACTORIO_2_0_VERSION,
      icons: [{ signal: { type: 'item' as const, name: 'blueprint' as const }, index: 1 as const }],
    },
    entities,
    wires,
  });
  validateNativeBlueprintFcir(fcir);
  return fcir;
}

import type { ConstantConfiguration, SignalId } from '@comblang/factorio';
import type { NetworkId, ProducerId } from '@comblang/shared';

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

export { BlueprintJsonError } from './blueprint-native-config.js';

export interface FactorioBlueprintJson {
  readonly blueprint: {
    readonly item: 'blueprint';
    readonly label: string;
    readonly version: number;
    readonly icons: readonly {
      readonly signal: { readonly type: 'item'; readonly name: 'blueprint' };
      readonly index: 1;
    }[];
    readonly entities: readonly Record<string, unknown>[];
    readonly wires: readonly (readonly [number, number, number, number])[];
  };
}

export interface BlueprintJsonOptions {
  readonly label?: string;
  /** Export-time expansion guard, not a language/DSL operation limit. Default: 1024. */
  readonly maxDeciderConditionRows?: number;
}

const FACTORIO_2_0_VERSION = 562_949_953_421_312;

function signalJson(signal: SignalId): Record<string, string> {
  return {
    ...(signal.type === 'item' ? {} : { type: signal.type }),
    name: signal.name,
    ...(signal.quality === undefined ? {} : { quality: signal.quality }),
  };
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

function comparatorJson(
  comparator: EntityPhysicalTypedConfiguration['condition']['comparator'],
): string {
  return comparator === '>='
    ? '≥'
    : comparator === '<='
      ? '≤'
      : comparator === '!='
        ? '≠'
        : comparator;
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

function constantEntityControlBehavior(
  configuration: ConstantConfiguration,
): Record<string, unknown> {
  return {
    is_on: configuration.isOn,
    sections: {
      sections: configuration.sections.map((section, sectionIndex) => ({
        index: sectionIndex + 1,
        active: section.active,
        filters: section.filters.map((filter, filterIndex) => ({
          index: filterIndex + 1,
          ...signalJson(filter.signal),
          quality: filter.signal.quality ?? 'normal',
          comparator: '=',
          count: filter.value,
        })),
      })),
    },
  };
}

interface WireEndpoint {
  readonly entity: number;
  readonly connector: number;
}

function connector(
  producer: CircuitProducerNode,
  side: 'input' | 'output',
  color: CircuitColor,
): number {
  const colorOffset = color === 'red' ? 0 : 1;
  return producer.kind === 'constant' || side === 'input' ? 1 + colorOffset : 3 + colorOffset;
}

/** Generates readable, uncompressed Factorio 2.x blueprint JSON from resolved circuit IR. */
export function generateBlueprintJson(
  ir: NativeCircuitIr,
  options: BlueprintJsonOptions = {},
): FactorioBlueprintJson {
  const physicalEntities = ir.entities ?? [];
  const entitiesById = new Map(physicalEntities.map((entity) => [entity.id, entity]));
  const linked = new Map<ProducerId, EntityPhysicalRecord>();
  for (const producer of ir.producers) {
    if (producer.entityId === undefined) continue;
    const entity = entitiesById.get(producer.entityId);
    if (entity === undefined)
      throw new BlueprintJsonError(`Missing physical Entity for linked producer ${producer.id}.`);
    linked.set(producer.id, entity);
  }
  return generatePreview(ir, options, physicalEntities, linked);
}

function generatePreview(
  ir: NativeCircuitIr,
  options: BlueprintJsonOptions,
  physicalEntities: readonly EntityPhysicalRecord[],
  linkedEntities: ReadonlyMap<ProducerId, EntityPhysicalRecord> = new Map(),
): FactorioBlueprintJson {
  const maxRows = options.maxDeciderConditionRows ?? 1024;
  if (!Number.isSafeInteger(maxRows) || maxRows < 1) {
    throw new RangeError('maxDeciderConditionRows must be a positive safe integer.');
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
        (value) => value.entity === endpoint.entity && value.connector === endpoint.connector,
      )
    ) {
      list.push(endpoint);
      endpoints.set(network, list);
    }
  };

  for (const { producer, inputNetworks } of lowered.combinators) {
    const entity = numbers.get(producer.id)!;
    for (const network of inputNetworks) {
      addEndpoint(network, {
        entity,
        connector: connector(producer, 'input', lowered.networkColors.get(network)!),
      });
    }
    for (const network of producer.destinations) {
      addEndpoint(network, {
        entity,
        connector: connector(producer, 'output', lowered.networkColors.get(network)!),
      });
    }
  }

  const sortedEntities = [...physicalEntities].sort((a, b) => a.ordinal - b.ordinal);
  const ids = new Set<string>();
  const ordinals = new Set<number>();
  const typedConfigurations = new Map<string, EntityPhysicalTypedConfiguration>();
  const rawConfigurations = new Map<string, EntityRawJsonObject>();
  for (const [index, entity] of sortedEntities.entries()) {
    const fail = (message: string): never => {
      throw new BlueprintJsonError(message, entity.provenance.source);
    };
    if (ids.has(entity.id) || ordinals.has(entity.ordinal))
      fail('Duplicate physical Entity identity or ordinal.');
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
        fail('Linked Entity requires Constant, Arithmetic, Decider, or Selector configuration.');
    } else if (entity.configuration !== undefined) {
      const configuration = dataRecord(entity.configuration, '$.configuration', fail);
      if (configuration.mode === 'raw') {
        exactKeys(configuration, ['mode', 'payload'], '$.configuration', fail);
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
          if (error instanceof EntityRawJsonError) fail(error.message);
          throw error;
        }
      } else {
        if (configuration.mode !== 'typed')
          fail('$.configuration.mode: unsupported configuration mode.');
        if ('payload' in configuration)
          fail('Raw/typed Entity configuration preview lowering is unsupported.');
        typedConfigurations.set(entity.id, validateEntityTypedConfiguration(configuration, fail));
      }
    }
    if (
      !/^[^:\s]+$/.test(entity.prototypeName) ||
      entity.profile.prototypeKey !== `entity:${entity.prototypeName}`
    )
      fail('Invalid physical Entity prototype name.');
    for (const binding of entity.connectorBindings) {
      if (binding.network === undefined) continue;
      const ordinal = binding.nativeConnector;
      if (
        ordinal === undefined ||
        !Number.isSafeInteger(ordinal) ||
        ordinal < 1 ||
        !Number.isSafeInteger(ordinal * 2)
      )
        fail('Missing or invalid native Entity connector ordinal.');
      if (lowered.networkColors.get(binding.network) !== binding.endpoint.color)
        fail('Entity endpoint requires a matching resolved Network color.');
      const linkedProducer = ir.producers.find(
        (producer) => linkedEntities.get(producer.id)?.id === entity.id,
      );
      addEndpoint(binding.network, {
        entity:
          linkedProducer === undefined
            ? ir.producers.length + index + 1
            : numbers.get(linkedProducer.id)!,
        connector: ordinal! * 2 - (binding.endpoint.color === 'red' ? 1 : 0),
      });
    }
  }

  const wires: [number, number, number, number][] = [];
  for (const list of endpoints.values()) {
    for (let index = 1; index < list.length; index += 1) {
      const left = list[index - 1]!;
      const right = list[index]!;
      wires.push([left.entity, left.connector, right.entity, right.connector]);
    }
  }

  const entities: Record<string, unknown>[] = lowered.combinators.map(
    ({ producer, entity }, index) => {
      const linked = linkedEntities.get(producer.id);
      if (linked === undefined) {
        return {
          entity_number: numbers.get(producer.id)!,
          ...entity,
          position:
            producer.placement === undefined
              ? { x: index * 2 + 0.5, y: 0.5 }
              : { x: producer.placement.x, y: producer.placement.y },
          direction: producer.placement?.direction ?? 4,
        };
      }
      if (
        linked.configuration?.mode === 'arithmetic' ||
        linked.configuration?.mode === 'decider' ||
        linked.configuration?.mode === 'selector'
      ) {
        return {
          entity_number: numbers.get(producer.id)!,
          name: linked.prototypeName,
          control_behavior: entity.control_behavior,
          position: linked.placement
            ? { x: linked.placement.x, y: linked.placement.y }
            : { x: index * 2 + 0.5, y: 0.5 },
          direction: linked.placement?.direction ?? 4,
        };
      }
      if (linked.configuration?.mode !== 'constant')
        throw new BlueprintJsonError(
          'Linked Entity requires Constant, Arithmetic, Decider, or Selector configuration.',
          linked.provenance.source,
        );
      return {
        entity_number: numbers.get(producer.id)!,
        name: linked.prototypeName,
        control_behavior: constantEntityControlBehavior(linked.configuration.value),
        position: linked.placement
          ? { x: linked.placement.x, y: linked.placement.y }
          : { x: index * 2 + 0.5, y: 0.5 },
        direction: linked.placement?.direction ?? 4,
      };
    },
  );

  const occupied = new Set(entities.map((entity) => JSON.stringify(entity.position)));
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
    entities.push({
      ...(rawConfiguration ?? {}),
      entity_number: ir.producers.length + index + 1,
      name: entity.prototypeName,
      ...(typedConfiguration !== undefined
        ? { control_behavior: entityControlBehavior(typedConfiguration) }
        : {}),
      position,
      direction: entity.placement?.direction ?? 4,
    });
  }

  return {
    blueprint: {
      item: 'blueprint',
      label: options.label ?? 'CombLang generated circuit',
      version: FACTORIO_2_0_VERSION,
      icons: [{ signal: { type: 'item', name: 'blueprint' }, index: 1 }],
      entities,
      wires,
    },
  };
}

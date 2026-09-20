import { circuitConstant, Signal, signalTypes, type SignalId } from '@comblang/factorio';

import type {
  EntityBehaviorKey,
  EntityConfiguration,
  EntityFeatureProfile,
  EntityLaneKey,
  EntityNativeComparator,
  EntityNativeField,
  EntityNativeSingleCondition,
  EntityPhysicalConfiguration,
  EntityProfile,
  EntityRawConfiguration,
  EntityTypedConfiguration,
} from './entity.js';
import { canonicalizeEntityRawObject, EntityRawJsonError } from './entity-raw.js';

type DataRecord = Record<string, unknown>;

const entityWildcardSignalNames = new Set(['signal-each', 'signal-anything', 'signal-everything']);

export type EntityConfigurationErrorCode = 'EC1000' | 'EC1001' | 'EC1002' | 'EC1003';

export class EntityConfigurationError extends Error {
  readonly code: EntityConfigurationErrorCode;
  readonly path: string;
  readonly detail: string;

  constructor(code: EntityConfigurationErrorCode, path: string, message: string) {
    super(`${path}: ${message}`);
    this.name = 'EntityConfigurationError';
    this.code = code;
    this.path = path;
    this.detail = message;
  }
}

function invalid(code: EntityConfigurationErrorCode, path: string, message: string): never {
  throw new EntityConfigurationError(code, path, message);
}

function dataRecord(value: unknown, path: string): DataRecord {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    invalid('EC1001', path, 'expected a plain data record.');
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    invalid('EC1001', path, 'expected a plain object or null-prototype record.');
  }
  const output = Object.create(null) as DataRecord;
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string')
      invalid('EC1000', `${path}[${String(key)}]`, 'symbol keys are not allowed.');
    const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
    if (!('value' in descriptor)) invalid('EC1001', `${path}.${key}`, 'accessors are not allowed.');
    output[key] = descriptor.value;
  }
  return output;
}

function dataArray(value: unknown, path: string): readonly unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    invalid('EC1001', path, 'expected a plain array.');
  }
  const lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length');
  if (lengthDescriptor === undefined || !('value' in lengthDescriptor)) {
    invalid('EC1001', `${path}.length`, 'array length must be data-only.');
  }
  const length = lengthDescriptor.value;
  if (typeof length !== 'number' || !Number.isSafeInteger(length) || length < 0) {
    invalid('EC1001', `${path}.length`, 'array length must be a non-negative safe integer.');
  }
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string')
      invalid('EC1000', `${path}[${String(key)}]`, 'symbol keys are not allowed.');
    if (key === 'length') continue;
    if (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= length) {
      invalid('EC1000', `${path}.${key}`, 'unknown array field.');
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
    if (!('value' in descriptor))
      invalid('EC1001', `${path}[${key}]`, 'accessors are not allowed.');
  }
  const output: unknown[] = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (descriptor === undefined)
      invalid('EC1001', `${path}[${index}]`, 'array holes are not allowed.');
    if (!('value' in descriptor))
      invalid('EC1001', `${path}[${index}]`, 'accessors are not allowed.');
    output.push(descriptor.value);
  }
  return output;
}

function exactKeys(record: DataRecord, allowed: readonly string[], path: string): void {
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(record)) {
    if (!allowedSet.has(key))
      invalid('EC1000', `${path}.${key}`, 'unknown Entity configuration field.');
  }
}

function identifier(value: unknown, path: string): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)
  ) {
    invalid(
      'EC1001',
      path,
      'expected a non-empty ASCII identifier without whitespace or path separators.',
    );
  }
  return value;
}

function comparator(value: unknown, path: string): EntityNativeComparator {
  if (
    value !== '>' &&
    value !== '<' &&
    value !== '=' &&
    value !== '>=' &&
    value !== '<=' &&
    value !== '!='
  ) {
    invalid('EC1001', path, 'expected a supported native comparator.');
  }
  return value;
}

function canonicalSignal(value: unknown, path: string): SignalId {
  const record = dataRecord(value, path);
  exactKeys(record, ['type', 'name', 'quality'], path);
  const type = record.type;
  if (typeof type !== 'string' || !signalTypes.includes(type as SignalId['type'])) {
    invalid('EC1001', `${path}.type`, 'expected a valid Signal type.');
  }
  if (typeof record.name !== 'string' || record.name.length === 0) {
    invalid('EC1001', `${path}.name`, 'expected a non-empty Signal name.');
  }
  if (type === 'virtual' && entityWildcardSignalNames.has(record.name)) {
    invalid('EC1001', `${path}.name`, 'wildcard Signal IDs are not concrete Signals.');
  }
  if ('quality' in record && (typeof record.quality !== 'string' || record.quality.length === 0)) {
    invalid('EC1001', `${path}.quality`, 'expected a non-empty Signal quality.');
  }
  try {
    return Signal(
      type as SignalId['type'],
      record.name,
      'quality' in record ? (record.quality as string) : undefined,
    );
  } catch (error) {
    invalid('EC1001', path, error instanceof Error ? error.message : 'invalid Signal ID.');
  }
}

function canonicalConstant(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value))
    invalid('EC1001', path, 'expected a safe integer circuit constant.');
  try {
    return circuitConstant(value);
  } catch (error) {
    invalid('EC1001', path, error instanceof Error ? error.message : 'invalid circuit constant.');
  }
}

/** Canonicalizes the pure one-comparison native condition without profile context. */
export function canonicalizeEntityNativeSingleCondition(
  value: unknown,
  path = '$',
): EntityNativeSingleCondition {
  const record = dataRecord(value, path);
  exactKeys(record, ['kind', 'signal', 'comparator', 'constant'], path);
  if (record.kind !== 'compare-signal-constant') {
    invalid('EC1001', `${path}.kind`, 'expected compare-signal-constant.');
  }
  return Object.freeze({
    kind: 'compare-signal-constant',
    signal: canonicalSignal(record.signal, `${path}.signal`),
    comparator: comparator(record.comparator, `${path}.comparator`),
    constant: canonicalConstant(record.constant, `${path}.constant`),
  });
}

function findRule(profile: EntityProfile, key: string, path: string) {
  const rule = profile.configurationRules.find((candidate) => candidate.key === key);
  if (rule === undefined)
    invalid('EC1002', path, `unknown Entity configuration rule ${JSON.stringify(key)}.`);
  return rule;
}

function findFeature(profile: EntityProfile, key: string, path: string): EntityFeatureProfile {
  const feature = profile.features.find((candidate) => candidate.key === key);
  if (feature === undefined)
    invalid('EC1002', path, `unknown Entity feature ${JSON.stringify(key)}.`);
  return feature;
}

function canonicalLanes(
  value: unknown,
  path: string,
  feature: EntityFeatureProfile,
): readonly EntityLaneKey[] {
  const lanes = dataArray(value, path).map(
    (lane, index) => identifier(lane, `${path}[${index}]`) as EntityLaneKey,
  );
  if (lanes.length === 0)
    invalid('EC1001', path, 'typed Entity configuration needs one input lane.');
  const seen = new Set<EntityLaneKey>();
  for (const lane of lanes) {
    if (seen.has(lane)) invalid('EC1002', path, `duplicate input lane ${JSON.stringify(lane)}.`);
    seen.add(lane);
    if (!feature.allowedLanes.includes(lane)) {
      invalid(
        'EC1002',
        path,
        `input lane ${JSON.stringify(lane)} is not allowed by the rule feature.`,
      );
    }
  }
  return Object.freeze([...lanes].sort());
}

function typedConfiguration(
  record: DataRecord,
  path: string,
  profile: EntityProfile,
): EntityTypedConfiguration {
  exactKeys(record, ['mode', 'rule', 'lanes', 'condition'], path);
  const ruleKey = identifier(record.rule, `${path}.rule`) as EntityBehaviorKey;
  const rule = findRule(profile, ruleKey, `${path}.rule`);
  if (!rule.modes.includes('typed')) {
    invalid(
      'EC1002',
      `${path}.mode`,
      `rule ${JSON.stringify(ruleKey)} does not allow typed configuration.`,
    );
  }
  if (!profile.synthetic && (rule.evidence.status !== 'verified' || rule.evidence.value !== true)) {
    invalid(
      'EC1003',
      `${path}.rule`,
      'typed Entity configuration requires verified positive evidence for this rule.',
    );
  }
  const feature = findFeature(profile, rule.feature, `${path}.rule.feature`);
  const connector = profile.connectors.find((candidate) => candidate.key === feature.connector);
  if (connector === undefined) {
    invalid(
      'EC1002',
      `${path}.rule.feature.connector`,
      'rule feature references an unknown connector.',
    );
  }
  if (connector.direction === 'output') {
    invalid(
      'EC1002',
      `${path}.rule.feature.connector`,
      'native condition requires an input connector.',
    );
  }
  if (rule.nativeField !== 'control_behavior.circuit_condition') {
    invalid('EC1002', `${path}.rule.nativeField`, 'unsupported native Entity configuration field.');
  }
  return Object.freeze({
    mode: 'typed',
    rule: ruleKey,
    lanes: canonicalLanes(record.lanes, `${path}.lanes`, feature),
    condition: canonicalizeEntityNativeSingleCondition(record.condition, `${path}.condition`),
  });
}

function rawConfiguration(record: DataRecord, path: string): EntityRawConfiguration {
  exactKeys(record, ['mode', 'payload'], path);
  if (!('payload' in record)) invalid('EC1001', `${path}.payload`, 'field is required.');
  try {
    return Object.freeze({
      mode: 'raw',
      payload: canonicalizeEntityRawObject(record.payload, undefined, `${path}.payload`),
    });
  } catch (error) {
    if (error instanceof EntityRawJsonError) {
      invalid('EC1001', error.path, error.detail);
    }
    throw error;
  }
}

/** Canonicalizes one plan configuration and resolves all profile-owned rule/lane checks. */
export function canonicalizeEntityConfiguration(
  value: unknown,
  profile: EntityProfile,
  path = '$',
): EntityConfiguration {
  const record = dataRecord(value, path);
  if (record.mode === 'raw') return rawConfiguration(record, path);
  if (record.mode === 'typed') return typedConfiguration(record, path, profile);
  invalid('EC1001', `${path}.mode`, 'expected raw or typed Entity configuration.');
}

/** Detaches a typed plan rule into the profile-independent physical IR configuration. */
export function resolveEntityPhysicalConfiguration(
  value: EntityConfiguration,
  profile: EntityProfile,
): EntityPhysicalConfiguration {
  const configuration = canonicalizeEntityConfiguration(value, profile, '$.configuration');
  if (configuration.mode === 'raw') return configuration;
  const rule = findRule(profile, configuration.rule, '$.configuration.rule');
  const feature = findFeature(profile, rule.feature, '$.configuration.rule.feature');
  const connector = profile.connectors.find((candidate) => candidate.key === feature.connector);
  if (connector === undefined) {
    invalid(
      'EC1002',
      '$.configuration.rule.feature.connector',
      'rule feature references an unknown connector.',
    );
  }
  const laneColors = Object.fromEntries(
    connector.lanes.map((lane) => [lane.key, lane.color]),
  ) as Record<string, 'red' | 'green'>;
  const laneMask = { red: false, green: false };
  for (const lane of configuration.lanes) laneMask[laneColors[lane]!] = true;
  return Object.freeze({
    mode: 'typed',
    rule: configuration.rule,
    feature: rule.feature,
    nativeField: rule.nativeField as EntityNativeField,
    connector: feature.connector,
    lanes: configuration.lanes,
    laneMask: Object.freeze(laneMask),
    condition: configuration.condition,
  });
}

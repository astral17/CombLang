import { int32, type CircuitValue } from './int32.js';
import { Signal, signalTypes, type SignalId, type SignalType } from './signal.js';
import { SparseBus } from './sparse-bus.js';

export interface ConstantConfigurationFilter {
  readonly signal: SignalId;
  readonly value: CircuitValue;
}

export interface ConstantConfigurationSection {
  readonly active: boolean;
  readonly group?: string;
  readonly multiplier: number;
  readonly filters: readonly ConstantConfigurationFilter[];
}

export interface ConstantConfiguration {
  readonly isOn: boolean;
  readonly sections: readonly ConstantConfigurationSection[];
}

export interface ConstantConfigurationLimits {
  readonly maxDepth: number;
  readonly maxNodes: number;
  readonly maxBytes: number;
}

/** The bounded semantic-input budget shared with raw Entity configuration. */
export const constantConfigurationLimits: ConstantConfigurationLimits = Object.freeze({
  maxDepth: 32,
  maxNodes: 4096,
  maxBytes: 262144,
});

export type ConstantConfigurationErrorCode = 'FC1000' | 'FC1001' | 'FC1002' | 'FC1003';

export class ConstantConfigurationError extends Error {
  readonly code: ConstantConfigurationErrorCode;
  readonly path: string;
  readonly detail: string;

  constructor(code: ConstantConfigurationErrorCode, path: string, message: string) {
    super(`${path}: ${message}`);
    this.name = 'ConstantConfigurationError';
    this.code = code;
    this.path = path;
    this.detail = message;
  }
}

export type ConstantConfigurationSupportReason = 'non-unit-multiplier' | 'group';

export type ConstantConfigurationSupport =
  | { readonly status: 'supported' }
  | {
      readonly status: 'unsupported';
      readonly reasons: readonly ConstantConfigurationSupportReason[];
    };

export class UnsupportedConstantConfigurationError extends Error {
  readonly code = 'FC1003' as const;
  readonly reasons: readonly ConstantConfigurationSupportReason[];

  constructor(reasons: readonly ConstantConfigurationSupportReason[]) {
    super(`Constant configuration is unsupported for evaluation: ${reasons.join(', ')}.`);
    this.name = 'UnsupportedConstantConfigurationError';
    this.reasons = Object.freeze([...reasons]);
  }
}

type DataRecord = Record<string, unknown>;

interface WalkState {
  readonly seen: WeakSet<object>;
  nodes: number;
}

function invalid(code: ConstantConfigurationErrorCode, path: string, message: string): never {
  throw new ConstantConfigurationError(code, path, message);
}

function assertLimits(configuration: ConstantConfigurationLimits): ConstantConfigurationLimits {
  if (
    !Number.isSafeInteger(configuration.maxDepth) ||
    configuration.maxDepth < 0 ||
    !Number.isSafeInteger(configuration.maxNodes) ||
    configuration.maxNodes < 1 ||
    !Number.isSafeInteger(configuration.maxBytes) ||
    configuration.maxBytes < 1
  ) {
    invalid(
      'FC1000',
      '$.limits',
      'configuration limits must be non-negative/positive safe integers.',
    );
  }
  return configuration;
}

function visit(
  value: unknown,
  path: string,
  depth: number,
  state: WalkState,
  limits: ConstantConfigurationLimits,
): void {
  if (depth > limits.maxDepth) {
    invalid('FC1002', path, `configuration exceeds the depth limit of ${limits.maxDepth}.`);
  }
  state.nodes += 1;
  if (state.nodes > limits.maxNodes) {
    invalid('FC1002', path, `configuration exceeds the node limit of ${limits.maxNodes}.`);
  }
  if (value !== null && typeof value === 'object') {
    if (state.seen.has(value)) invalid('FC1002', path, 'cycles are not allowed.');
    state.seen.add(value);
  }
}

function leave(value: unknown, state: WalkState): void {
  if (value !== null && typeof value === 'object') state.seen.delete(value);
}

function dataRecord(value: unknown, path: string): DataRecord {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    invalid('FC1001', path, 'expected a plain data record.');
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    invalid('FC1001', path, 'expected a plain object or null-prototype record.');
  }
  const output = Object.create(null) as DataRecord;
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string') {
      invalid('FC1000', `${path}[${String(key)}]`, 'symbol keys are not allowed.');
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
    if (!('value' in descriptor)) invalid('FC1001', `${path}.${key}`, 'accessors are not allowed.');
    output[key] = descriptor.value;
  }
  return output;
}

function dataArray(value: unknown, path: string): readonly unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    invalid('FC1001', path, 'expected a plain array.');
  }
  const lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length');
  if (lengthDescriptor === undefined || !('value' in lengthDescriptor)) {
    invalid('FC1001', `${path}.length`, 'array length must be data-only.');
  }
  const length = lengthDescriptor.value;
  if (typeof length !== 'number' || !Number.isSafeInteger(length) || length < 0) {
    invalid('FC1001', `${path}.length`, 'array length must be a non-negative safe integer.');
  }
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string') {
      invalid('FC1000', `${path}[${String(key)}]`, 'symbol keys are not allowed.');
    }
    if (key === 'length') continue;
    if (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= length) {
      invalid('FC1000', `${path}.${key}`, 'unknown array field.');
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
    if (!('value' in descriptor))
      invalid('FC1001', `${path}[${key}]`, 'accessors are not allowed.');
  }
  const output: unknown[] = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (descriptor === undefined)
      invalid('FC1001', `${path}[${index}]`, 'array holes are not allowed.');
    if (!('value' in descriptor))
      invalid('FC1001', `${path}[${index}]`, 'accessors are not allowed.');
    output.push(descriptor.value);
  }
  return output;
}

function exactKeys(record: DataRecord, allowed: readonly string[], path: string): void {
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(record)) {
    if (!allowedSet.has(key)) invalid('FC1000', `${path}.${key}`, 'unknown configuration field.');
  }
}

function booleanValue(value: unknown, path: string): boolean {
  if (typeof value !== 'boolean') invalid('FC1001', path, 'expected a boolean.');
  return value;
}

function finiteNumber(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    invalid('FC1001', path, 'expected a finite number.');
  }
  return value;
}

function groupValue(value: unknown, path: string): string {
  if (typeof value !== 'string') invalid('FC1001', path, 'expected a group string.');
  return value;
}

function circuitValue(value: unknown, path: string): CircuitValue {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    invalid('FC1001', path, 'expected a safe integer circuit value.');
  }
  try {
    return int32(value);
  } catch (error) {
    invalid('FC1001', path, error instanceof Error ? error.message : 'invalid circuit value.');
  }
}

function canonicalSignal(
  value: unknown,
  path: string,
  depth: number,
  state: WalkState,
  limits: ConstantConfigurationLimits,
): SignalId {
  visit(value, path, depth, state, limits);
  try {
    const record = dataRecord(value, path);
    exactKeys(record, ['type', 'name', 'quality'], path);
    if (typeof record.type !== 'string' || !signalTypes.includes(record.type as SignalType)) {
      invalid('FC1001', `${path}.type`, 'expected a valid Signal type.');
    }
    if (typeof record.name !== 'string' || record.name.length === 0) {
      invalid('FC1001', `${path}.name`, 'expected a non-empty Signal name.');
    }
    if (
      'quality' in record &&
      (typeof record.quality !== 'string' || record.quality.length === 0)
    ) {
      invalid('FC1001', `${path}.quality`, 'expected a non-empty Signal quality.');
    }
    try {
      return Signal(
        record.type as SignalType,
        record.name,
        'quality' in record ? (record.quality as string) : undefined,
      );
    } catch (error) {
      invalid('FC1001', path, error instanceof Error ? error.message : 'invalid Signal ID.');
    }
  } finally {
    leave(value, state);
  }
}

function canonicalFilter(
  value: unknown,
  path: string,
  depth: number,
  state: WalkState,
  limits: ConstantConfigurationLimits,
): ConstantConfigurationFilter {
  visit(value, path, depth, state, limits);
  try {
    const record = dataRecord(value, path);
    exactKeys(record, ['signal', 'value'], path);
    return Object.freeze({
      signal: canonicalSignal(record.signal, `${path}.signal`, depth + 1, state, limits),
      value: circuitValue(record.value, `${path}.value`),
    });
  } finally {
    leave(value, state);
  }
}

function canonicalSection(
  value: unknown,
  path: string,
  depth: number,
  state: WalkState,
  limits: ConstantConfigurationLimits,
): ConstantConfigurationSection {
  visit(value, path, depth, state, limits);
  try {
    const record = dataRecord(value, path);
    exactKeys(record, ['active', 'group', 'multiplier', 'filters'], path);
    const filtersValue = 'filters' in record ? dataArray(record.filters, `${path}.filters`) : [];
    visit(filtersValue, `${path}.filters`, depth + 1, state, limits);
    try {
      return Object.freeze({
        active: 'active' in record ? booleanValue(record.active, `${path}.active`) : true,
        ...('group' in record ? { group: groupValue(record.group, `${path}.group`) } : {}),
        multiplier:
          'multiplier' in record ? finiteNumber(record.multiplier, `${path}.multiplier`) : 1,
        filters: Object.freeze(
          filtersValue.map((filter, index) =>
            canonicalFilter(filter, `${path}.filters[${index}]`, depth + 2, state, limits),
          ),
        ),
      });
    } finally {
      leave(filtersValue, state);
    }
  } finally {
    leave(value, state);
  }
}

/** Canonicalizes one bounded ordered Constant semantic configuration. */
export function canonicalizeConstantConfiguration(
  value: unknown,
  configuration: ConstantConfigurationLimits = constantConfigurationLimits,
  path = '$',
): ConstantConfiguration {
  const limits = assertLimits(configuration);
  const state: WalkState = { seen: new WeakSet(), nodes: 0 };
  visit(value, path, 0, state, limits);
  let canonical: ConstantConfiguration;
  try {
    const record = dataRecord(value, path);
    exactKeys(record, ['isOn', 'sections'], path);
    const sectionsValue =
      'sections' in record ? dataArray(record.sections, `${path}.sections`) : [];
    visit(sectionsValue, `${path}.sections`, 1, state, limits);
    try {
      canonical = Object.freeze({
        isOn: 'isOn' in record ? booleanValue(record.isOn, `${path}.isOn`) : true,
        sections: Object.freeze(
          sectionsValue.map((section, index) =>
            canonicalSection(section, `${path}.sections[${index}]`, 2, state, limits),
          ),
        ),
      });
    } finally {
      leave(sectionsValue, state);
    }
  } finally {
    leave(value, state);
  }

  const bytes = new TextEncoder().encode(JSON.stringify(canonical)).byteLength;
  if (bytes > limits.maxBytes) {
    invalid('FC1002', path, `configuration exceeds the byte limit of ${limits.maxBytes}.`);
  }
  return canonical;
}

/** Reports the evaluator subset without dropping unsupported structural data. */
export function classifyConstantConfigurationSupport(
  configuration: ConstantConfiguration,
): ConstantConfigurationSupport {
  const reasons: ConstantConfigurationSupportReason[] = [];
  if (configuration.sections.some((section) => section.multiplier !== 1)) {
    reasons.push('non-unit-multiplier');
  }
  if (configuration.sections.some((section) => section.group !== undefined)) reasons.push('group');
  return reasons.length === 0
    ? { status: 'supported' }
    : { status: 'unsupported', reasons: Object.freeze(reasons) };
}

/** Evaluates the currently supported subset, aggregating rows only at the final bus boundary. */
export function constantConfigurationToSparseBus(configuration: ConstantConfiguration): SparseBus {
  const support = classifyConstantConfigurationSupport(configuration);
  if (support.status === 'unsupported') {
    throw new UnsupportedConstantConfigurationError(support.reasons);
  }
  const values = new SparseBus();
  if (!configuration.isOn) return values;
  for (const section of configuration.sections) {
    if (!section.active) continue;
    for (const filter of section.filters) values.add(filter.signal, filter.value);
  }
  return values;
}

/** Losslessly adapts the legacy ordered CC output list to one ordinary Constant section. */
export function constantConfigurationFromOutputs(
  outputs: readonly { readonly signal: SignalId; readonly value: number }[],
): ConstantConfiguration {
  return canonicalizeConstantConfiguration({
    isOn: true,
    sections: [
      {
        active: true,
        multiplier: 1,
        filters: outputs.map((output) => ({ signal: output.signal, value: output.value })),
      },
    ],
  });
}

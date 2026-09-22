import { canonicalizeConstantConfiguration, type ConstantConfiguration } from '@comblang/factorio';

import {
  normalizeSignalValueSources,
  type SignalValueSourceContext,
} from './constant-signal-values.js';

type DataRecord = Record<string, unknown>;

/** Runtime-facing source normalizer for the exact Constant({ isOn, sections }) form. */
export interface ConstantConfigurationSourceContext extends SignalValueSourceContext {}

export class ConstantConfigurationSourceError extends TypeError {
  constructor(
    readonly path: string,
    message: string,
  ) {
    super(`${path}: ${message}`);
    this.name = 'ConstantConfigurationSourceError';
  }
}

function fail(path: string, message: string): never {
  throw new ConstantConfigurationSourceError(path, message);
}

function ownDataRecord(value: unknown, path: string): DataRecord {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    fail(path, 'expected a plain data record.');
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    fail(path, 'expected a plain object or null-prototype record.');
  }
  const record = Object.create(null) as DataRecord;
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string') fail(`${path}[${String(key)}]`, 'symbol keys are not supported.');
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !('value' in descriptor)) {
      fail(`${path}.${key}`, 'accessors are not supported.');
    }
    record[key] = descriptor.value;
  }
  return record;
}

function ownDataArray(value: unknown, path: string): readonly unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    fail(path, 'expected a plain array.');
  }
  const length = Object.getOwnPropertyDescriptor(value, 'length')?.value;
  if (typeof length !== 'number' || !Number.isSafeInteger(length) || length < 0) {
    fail(`${path}.length`, 'array length must be a non-negative safe integer.');
  }
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string') fail(`${path}[${String(key)}]`, 'symbol keys are not supported.');
    if (key === 'length') continue;
    if (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= length) {
      fail(`${path}.${key}`, 'unknown array field.');
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !('value' in descriptor)) {
      fail(`${path}[${key}]`, 'accessors are not supported.');
    }
  }
  const result: unknown[] = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (descriptor === undefined) fail(`${path}[${index}]`, 'array holes are not supported.');
    result.push(descriptor.value);
  }
  return result;
}

function snapshotSignal(signal: {
  readonly type: string;
  readonly name: string;
  readonly quality?: string;
}) {
  return Object.freeze({
    type: signal.type,
    name: signal.name,
    ...(signal.quality === undefined ? {} : { quality: signal.quality }),
  });
}

function normalizeFilters(
  value: unknown,
  path: string,
  context: ConstantConfigurationSourceContext,
): readonly { readonly signal: ReturnType<typeof snapshotSignal>; readonly value: number }[] {
  const entries = normalizeSignalValueSources([value], context, path);
  return Object.freeze(
    entries.map(({ signal, value: count }) =>
      Object.freeze({ signal: snapshotSignal(signal), value: count }),
    ),
  );
}

/**
 * Normalizes source values exactly once, preserves ordered filter rows, and then
 * delegates shape/bounds validation to Factorio's canonical configuration boundary.
 */
export function normalizeConstantConfigurationSource(
  value: unknown,
  context: ConstantConfigurationSourceContext,
  path = '$',
): ConstantConfiguration {
  const record = ownDataRecord(value, path);
  const sectionsValue =
    'sections' in record ? ownDataArray(record.sections, `${path}.sections`) : [];
  const sections = sectionsValue.map((section, index) => {
    const sectionPath = `${path}.sections[${index}]`;
    const source = ownDataRecord(section, sectionPath);
    return {
      ...source,
      ...(Object.hasOwn(source, 'filters')
        ? { filters: normalizeFilters(source.filters, `${sectionPath}.filters`, context) }
        : {}),
    };
  });
  let configuration: ConstantConfiguration;
  try {
    configuration = canonicalizeConstantConfiguration(
      {
        ...record,
        ...(Object.hasOwn(record, 'sections') ? { sections } : {}),
      },
      undefined,
      path,
    );
  } catch (error) {
    if (error instanceof Error && 'path' in error && 'detail' in error) {
      throw new ConstantConfigurationSourceError(String(error.path), String(error.detail));
    }
    throw error;
  }
  return configuration;
}

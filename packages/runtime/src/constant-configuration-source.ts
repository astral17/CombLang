import {
  canonicalizeConstantConfiguration,
  formatSignalRef,
  type ConstantConfiguration,
  type SignalId,
} from '@comblang/factorio';
import {
  BlueprintParameterError,
  type BlueprintNumberParameterHandle,
  type BlueprintParameterSession,
  type BlueprintSignalParameterHandle,
} from '../../compiler/src/blueprint-parameters.js';
import { lookupBlueprintParameterSlot } from '../../compiler/src/blueprint-parameter-validation.js';

import {
  normalizeSignalValueSources,
  SignalValueSourceError,
  type SignalValueSourceContext,
} from './constant-signal-values.js';

type DataRecord = Record<string, unknown>;

interface ConstantFilterParameterSlots {
  readonly signal?: BlueprintSignalParameterHandle;
  readonly value?: BlueprintNumberParameterHandle;
}

interface NormalizedConstantFilters {
  readonly filters: readonly {
    readonly signal: ReturnType<typeof snapshotSignal>;
    readonly value: number;
  }[];
  readonly slots: readonly ConstantFilterParameterSlots[];
  readonly hasParameterSlots: boolean;
}

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

function normalizeSignalValues(
  sources: readonly unknown[],
  context: ConstantConfigurationSourceContext,
  path: string,
) {
  try {
    return normalizeSignalValueSources(sources, context, path);
  } catch (error) {
    if (error instanceof SignalValueSourceError) {
      const message = error.message.startsWith(`${error.path}: `)
        ? error.message.slice(error.path.length + 2)
        : error.message;
      fail(error.path, message);
    }
    throw error;
  }
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

function isDirectFilterCandidate(candidate: unknown): candidate is DataRecord {
  if (candidate === null || typeof candidate !== 'object' || Array.isArray(candidate)) return false;
  const prototype = Object.getPrototypeOf(candidate);
  if (prototype !== Object.prototype && prototype !== null) return false;
  const signalField = Object.getOwnPropertyDescriptor(candidate, 'signal');
  // A map-style row may legitimately contain the item Signal named "signal".
  // Its count is numeric, so preserve that established interpretation.
  return (
    signalField !== undefined &&
    (!('value' in signalField) || typeof signalField.value !== 'number')
  );
}

function normalizeFilters(
  value: unknown,
  path: string,
  context: ConstantConfigurationSourceContext,
  session: BlueprintParameterSession | undefined,
): NormalizedConstantFilters {
  const directRows = Array.isArray(value) ? ownDataArray(value, path) : undefined;
  const hasDirectFilter = directRows?.some(isDirectFilterCandidate);
  if (!hasDirectFilter || directRows === undefined) {
    const entries = normalizeSignalValues([value], context, path);
    const filters = entries.map(({ signal, value: count }) =>
      Object.freeze({ signal: snapshotSignal(signal), value: count }),
    );
    return {
      filters: Object.freeze(filters),
      slots: Object.freeze(filters.map(() => Object.freeze({}))),
      hasParameterSlots: false,
    };
  }

  const filters: { readonly signal: ReturnType<typeof snapshotSignal>; readonly value: number }[] =
    [];
  const slots: ConstantFilterParameterSlots[] = [];
  let hasParameterSlots = false;
  directRows.forEach((candidate, index) => {
    const rowPath = `${path}[${index}]`;
    const isDirectRow = isDirectFilterCandidate(candidate);
    if (!isDirectRow) {
      const entries = normalizeSignalValues([candidate], context, rowPath);
      for (const entry of entries) {
        filters.push(Object.freeze({ signal: snapshotSignal(entry.signal), value: entry.value }));
        slots.push(Object.freeze({}));
      }
      return;
    }

    const row = ownDataRecord(candidate, rowPath);
    for (const key of Object.keys(row)) {
      if (key !== 'signal' && key !== 'value') {
        fail(`${rowPath}.${key}`, 'unknown direct filter field.');
      }
    }
    if (!Object.hasOwn(row, 'signal')) fail(`${rowPath}.signal`, 'field is required.');
    if (!Object.hasOwn(row, 'value')) fail(`${rowPath}.value`, 'field is required.');

    let rawSignal = row.signal;
    let signalSlot: BlueprintSignalParameterHandle | undefined;
    let rawCount = row.value;
    let numberSlot: BlueprintNumberParameterHandle | undefined;
    if (session !== undefined) {
      try {
        const slot = lookupBlueprintParameterSlot(
          rawSignal,
          'signal',
          session,
          `${rowPath}.signal`,
        );
        if (slot !== undefined) {
          if (slot.registration.defaultValue === undefined) {
            fail(`${rowPath}.signal`, 'Signal parameter requires a concrete default value.');
          }
          signalSlot = slot.handle as BlueprintSignalParameterHandle;
          rawSignal = formatSignalRef(slot.registration.defaultValue as SignalId);
        }
        const countSlot = lookupBlueprintParameterSlot(
          rawCount,
          'number',
          session,
          `${rowPath}.value`,
        );
        if (countSlot !== undefined) {
          if (typeof countSlot.registration.defaultValue !== 'number') {
            fail(`${rowPath}.value`, 'number parameter requires a numeric default value.');
          }
          numberSlot = countSlot.handle as BlueprintNumberParameterHandle;
          rawCount = countSlot.registration.defaultValue;
        }
      } catch (error) {
        if (error instanceof ConstantConfigurationSourceError) throw error;
        if (error instanceof BlueprintParameterError) {
          const message = error.message.startsWith(`${error.path}: `)
            ? error.message.slice(error.path.length + 2)
            : error.message;
          fail(error.path, message);
        }
        throw error;
      }
    }
    const [entry] = normalizeSignalValues([[rawSignal, rawCount]], context, rowPath);
    if (entry === undefined) fail(rowPath, 'expected one direct filter row.');
    filters.push(Object.freeze({ signal: snapshotSignal(entry.signal), value: entry.value }));
    slots.push(
      Object.freeze({
        ...(signalSlot === undefined ? {} : { signal: signalSlot }),
        ...(numberSlot === undefined ? {} : { value: numberSlot }),
      }),
    );
    hasParameterSlots ||= signalSlot !== undefined || numberSlot !== undefined;
  });
  return {
    filters: Object.freeze(filters),
    slots: Object.freeze(slots),
    hasParameterSlots,
  };
}

export interface NormalizedConstantConfigurationSource {
  readonly configuration: ConstantConfiguration;
  readonly templateConfiguration?: unknown;
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
  return normalizeConstantConfigurationSourceWithParameters(value, context, undefined, path)
    .configuration;
}

/** Normalizes defaults and retains only direct filter parameter slots for host-local capture. */
export function normalizeConstantConfigurationSourceWithParameters(
  value: unknown,
  context: ConstantConfigurationSourceContext,
  session: BlueprintParameterSession | undefined,
  path = '$',
): NormalizedConstantConfigurationSource {
  const record = ownDataRecord(value, path);
  const sectionsValue =
    'sections' in record ? ownDataArray(record.sections, `${path}.sections`) : [];
  const parameterSlots: (readonly ConstantFilterParameterSlots[])[] = [];
  let hasParameterSlots = false;
  const sections = sectionsValue.map((section, index) => {
    const sectionPath = `${path}.sections[${index}]`;
    const source = ownDataRecord(section, sectionPath);
    const normalizedFilters = Object.hasOwn(source, 'filters')
      ? normalizeFilters(source.filters, `${sectionPath}.filters`, context, session)
      : undefined;
    parameterSlots.push(normalizedFilters?.slots ?? []);
    hasParameterSlots ||= normalizedFilters?.hasParameterSlots ?? false;
    return {
      ...source,
      ...(normalizedFilters !== undefined ? { filters: normalizedFilters.filters } : {}),
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
  if (!hasParameterSlots) return { configuration };
  const templateConfiguration = {
    isOn: configuration.isOn,
    sections: configuration.sections.map((section, sectionIndex) => ({
      active: section.active,
      ...(section.group === undefined ? {} : { group: section.group }),
      multiplier: section.multiplier,
      filters: section.filters.map((filter, filterIndex) => {
        const slots = parameterSlots[sectionIndex]?.[filterIndex];
        return {
          signal: slots?.signal ?? filter.signal,
          value: slots?.value ?? filter.value,
        };
      }),
    })),
  };
  return { configuration, templateConfiguration };
}

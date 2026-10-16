import { canonicalizeConstantConfiguration, type ConstantConfiguration } from '@comblang/factorio';
import {
  BlueprintParameterError,
  findBlueprintParameterHandle,
  type BlueprintNumberParameterHandle,
  type BlueprintParameterSession,
  type BlueprintSignalParameterHandle,
} from '../../compiler/src/blueprint-parameters.js';
import { lookupBlueprintParameterSlot } from '../../compiler/src/blueprint-parameter-validation.js';
import type { BlueprintNumericExpression } from '../../compiler/src/blueprint-numeric-expression.js';
import { bindConstantConfigurationTemplate } from '../../compiler/src/constant-configuration-binding.js';
import {
  createConstantConfigurationTemplate,
  type ConstantConfigurationTemplate,
} from '../../compiler/src/constant-configuration-template.js';

import {
  normalizeSignalCountValue,
  normalizeSignalValueKey,
  normalizeSignalValueSources,
  SignalValueSourceError,
  type SignalValueSourceContext,
} from './constant-signal-values.js';
import { findSourceNumericExpressionView } from './source-numeric-expressions.js';

type DataRecord = Record<string, unknown>;

interface NormalizedConstantFilters {
  readonly filters: readonly {
    readonly signal: unknown;
    readonly value: unknown;
  }[];
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

function normalizeSignalKey(
  value: unknown,
  context: ConstantConfigurationSourceContext,
  path: string,
) {
  try {
    return normalizeSignalValueKey(value, context, path);
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

function normalizeSignalCount(value: unknown, path: string): number {
  try {
    return normalizeSignalCountValue(value, path);
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

function rejectUnsupportedSymbolicValue(
  value: unknown,
  path: string,
  session: BlueprintParameterSession | undefined,
): void {
  const expressionView = findSourceNumericExpressionView(value);
  if (expressionView !== undefined) {
    fail(
      path,
      'numeric expressions are allowed only in Constant section multipliers and filter counts.',
    );
  }
  const registration = findBlueprintParameterHandle(value);
  if (registration === undefined) return;
  if (session !== undefined) {
    try {
      lookupBlueprintParameterSlot(value, registration.kind, session, path);
    } catch (error) {
      if (error instanceof BlueprintParameterError) {
        const message = error.message.startsWith(`${error.path}: `)
          ? error.message.slice(error.path.length + 2)
          : error.message;
        fail(error.path, message);
      }
      throw error;
    }
  }
  fail(
    path,
    'parameter references are allowed only in signal, filter count, and multiplier slots.',
  );
}

function normalizeFilters(
  value: unknown,
  path: string,
  context: ConstantConfigurationSourceContext,
  session: BlueprintParameterSession | undefined,
  expressionPaths: string[],
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
      hasParameterSlots: false,
    };
  }

  const filters: { readonly signal: unknown; readonly value: unknown }[] = [];
  let hasParameterSlots = false;
  directRows.forEach((candidate, index) => {
    const rowPath = `${path}[${index}]`;
    const isDirectRow = isDirectFilterCandidate(candidate);
    if (!isDirectRow) {
      const entries = normalizeSignalValues([candidate], context, rowPath);
      for (const entry of entries) {
        filters.push(Object.freeze({ signal: snapshotSignal(entry.signal), value: entry.value }));
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

    let rawSignal: unknown = row.signal;
    let signalSlot: BlueprintSignalParameterHandle | undefined;
    const rawCount = row.value;
    let numberSlot: BlueprintNumberParameterHandle | BlueprintNumericExpression | undefined;
    try {
      if (session !== undefined) {
        const slot = lookupBlueprintParameterSlot(
          rawSignal,
          'signal',
          session,
          `${rowPath}.signal`,
        );
        if (slot !== undefined) {
          signalSlot = slot.handle as BlueprintSignalParameterHandle;
        }
      }

      const expressionView = findSourceNumericExpressionView(rawCount);
      if (expressionView !== undefined) {
        if (session === undefined) {
          fail(
            `${rowPath}.value`,
            'source numeric expression requires its owning parameter session.',
          );
        }
        if (expressionView.session !== session) {
          fail(
            `${rowPath}.value`,
            'source numeric expression belongs to a different parameter session.',
          );
        }
        numberSlot = expressionView.expression;
        expressionPaths.push(`${rowPath}.value`);
      } else if (session !== undefined) {
        const countSlot = lookupBlueprintParameterSlot(
          rawCount,
          'number',
          session,
          `${rowPath}.value`,
        );
        if (countSlot !== undefined) {
          numberSlot = countSlot.handle as BlueprintNumberParameterHandle;
        }
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
    const signal =
      signalSlot ?? snapshotSignal(normalizeSignalKey(rawSignal, context, `${rowPath}.signal`));
    const count = numberSlot ?? normalizeSignalCount(rawCount, `${rowPath}.value`);
    filters.push(Object.freeze({ signal, value: count }));
    hasParameterSlots ||= signalSlot !== undefined || numberSlot !== undefined;
  });
  return {
    filters: Object.freeze(filters),
    hasParameterSlots,
  };
}

export interface NormalizedConstantConfigurationSource {
  readonly configuration: ConstantConfiguration;
  readonly template?: ConstantConfigurationTemplate;
}

export interface PreparedConstantConfigurationSource {
  readonly template: ConstantConfigurationTemplate;
  readonly hasParameterSlots: boolean;
}

interface NormalizedConstantSourceData {
  readonly value: Record<string, unknown>;
  readonly hasParameterSlots: boolean;
  readonly expressionPaths: readonly string[];
}

function normalizeSourceData(
  value: unknown,
  context: ConstantConfigurationSourceContext,
  session: BlueprintParameterSession | undefined,
  path: string,
): NormalizedConstantSourceData {
  const record = ownDataRecord(value, path);
  const sectionsValue =
    'sections' in record ? ownDataArray(record.sections, `${path}.sections`) : [];
  let hasParameterSlots = false;
  const expressionPaths: string[] = [];
  const sections = sectionsValue.map((section, index) => {
    const sectionPath = `${path}.sections[${index}]`;
    const source = ownDataRecord(section, sectionPath);
    const normalizedSection: Record<string, unknown> = { ...source };

    if (Object.hasOwn(source, 'multiplier')) {
      const multiplier = source.multiplier;
      const expressionView = findSourceNumericExpressionView(multiplier);
      if (expressionView !== undefined) {
        if (session === undefined) {
          fail(
            `${sectionPath}.multiplier`,
            'source numeric expression requires its owning parameter session.',
          );
        }
        if (expressionView.session !== session) {
          fail(
            `${sectionPath}.multiplier`,
            'source numeric expression belongs to a different parameter session.',
          );
        }
        normalizedSection.multiplier = expressionView.expression;
        hasParameterSlots = true;
        expressionPaths.push(`${sectionPath}.multiplier`);
      } else if (session !== undefined) {
        try {
          const slot = lookupBlueprintParameterSlot(
            multiplier,
            'number',
            session,
            `${sectionPath}.multiplier`,
          );
          if (slot !== undefined) {
            normalizedSection.multiplier = slot.handle as BlueprintNumberParameterHandle;
            hasParameterSlots = true;
          }
        } catch (error) {
          if (error instanceof BlueprintParameterError) {
            fail(
              error.path,
              error.message.startsWith(`${error.path}: `)
                ? error.message.slice(error.path.length + 2)
                : error.message,
            );
          }
          throw error;
        }
      }
    }

    if (Object.hasOwn(source, 'filters')) {
      const normalizedFilters = normalizeFilters(
        source.filters,
        `${sectionPath}.filters`,
        context,
        session,
        expressionPaths,
      );
      normalizedSection.filters = normalizedFilters.filters;
      hasParameterSlots ||= normalizedFilters.hasParameterSlots;
    }
    for (const key of Object.keys(source)) {
      if (!['active', 'group', 'multiplier', 'filters'].includes(key)) {
        rejectUnsupportedSymbolicValue(source[key], `${sectionPath}.${key}`, session);
      } else if (key === 'active' || key === 'group') {
        rejectUnsupportedSymbolicValue(source[key], `${sectionPath}.${key}`, session);
      }
    }
    return normalizedSection;
  });
  for (const key of Object.keys(record)) {
    if (key !== 'sections') {
      rejectUnsupportedSymbolicValue(record[key], `${path}.${key}`, session);
    }
  }
  return {
    value: {
      ...record,
      ...(Object.hasOwn(record, 'sections') ? { sections } : {}),
    },
    hasParameterSlots,
    // Binder paths are rooted at the template, not at its containing source field.
    expressionPaths: Object.freeze(
      expressionPaths.map((slotPath) => `$${slotPath.slice(path.length)}`),
    ),
  };
}

function withSourcePath(path: string, nestedPath: string): string {
  if (path === '$') return nestedPath;
  return `${path}${nestedPath === '$' ? '' : nestedPath.slice(1)}`;
}

function rethrowParameterError(
  error: unknown,
  path: string,
  expressionPaths: readonly string[] = [],
): never {
  if (error instanceof BlueprintParameterError) {
    const message = error.message.startsWith(`${error.path}: `)
      ? error.message.slice(error.path.length + 2)
      : error.message;
    const sourcePath = [...expressionPaths]
      .filter((slotPath) => error.path.startsWith(`${slotPath}.`))
      .sort((left, right) => right.length - left.length)[0];
    fail(withSourcePath(path, sourcePath ?? error.path), message);
  }
  throw error;
}

function canonicalizeSourceData(value: unknown, path: string): ConstantConfiguration {
  try {
    return canonicalizeConstantConfiguration(value, undefined, path);
  } catch (error) {
    if (error instanceof Error && 'path' in error && 'detail' in error) {
      throw new ConstantConfigurationSourceError(String(error.path), String(error.detail));
    }
    throw error;
  }
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

/** Normalizes defaults and retains direct filter/multiplier slots for host-local capture. */
export function normalizeConstantConfigurationSourceWithParameters(
  value: unknown,
  context: ConstantConfigurationSourceContext,
  session: BlueprintParameterSession | undefined,
  path = '$',
): NormalizedConstantConfigurationSource {
  const normalized = normalizeSourceData(value, context, session, path);
  if (session === undefined) {
    return { configuration: canonicalizeSourceData(normalized.value, path) };
  }

  let template: ConstantConfigurationTemplate;
  try {
    template = createConstantConfigurationTemplate(session, normalized.value);
  } catch (error) {
    rethrowParameterError(error, path);
  }
  let configuration: ConstantConfiguration;
  try {
    configuration = bindConstantConfigurationTemplate(template);
  } catch (error) {
    rethrowParameterError(error, path, normalized.expressionPaths);
  }
  return {
    configuration,
    ...(normalized.hasParameterSlots ? { template } : {}),
  };
}

/** Snapshots and authenticates symbolic Constant source data without binding defaults. */
export function prepareConstantConfigurationSource(
  value: unknown,
  context: ConstantConfigurationSourceContext,
  session: BlueprintParameterSession,
  path = '$',
): PreparedConstantConfigurationSource {
  const normalized = normalizeSourceData(value, context, session, path);
  let template: ConstantConfigurationTemplate;
  try {
    template = createConstantConfigurationTemplate(session, normalized.value);
  } catch (error) {
    rethrowParameterError(error, path);
  }
  return Object.freeze({ template, hasParameterSlots: normalized.hasParameterSlots });
}

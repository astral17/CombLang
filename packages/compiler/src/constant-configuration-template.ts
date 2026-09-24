import {
  canonicalizeConstantConfiguration,
  ConstantConfigurationError,
  constantConfigurationLimits,
  signal,
  type ConstantConfiguration,
  type SignalId,
} from '@comblang/factorio';

import {
  assertConstantParameterFromSession,
  assertConstantParameterSession,
  ConstantParameterError,
  findConstantParameterHandle,
  type ConstantParameterSession,
  type NumberParameterHandle,
  type SignalParameterHandle,
} from './constant-parameters.js';

const templateBrand: unique symbol = Symbol('constant-configuration-template');

export type ConstantTemplateNumberSlot = number | NumberParameterHandle;
export type ConstantTemplateSignalSlot = SignalId | SignalParameterHandle;

export interface ConstantConfigurationTemplateFilter {
  readonly signal: ConstantTemplateSignalSlot;
  readonly value: ConstantTemplateNumberSlot;
}

export interface ConstantConfigurationTemplateSection {
  readonly active: boolean;
  readonly group?: string;
  readonly multiplier: ConstantTemplateNumberSlot;
  readonly filters: readonly ConstantConfigurationTemplateFilter[];
}

export interface ConstantConfigurationTemplate {
  readonly [templateBrand]: true;
  readonly isOn: boolean;
  readonly sections: readonly ConstantConfigurationTemplateSection[];
}

export interface ConstantConfigurationTemplateRegistration {
  readonly session: ConstantParameterSession;
}

interface TemplateBudget {
  readonly active: WeakSet<object>;
  nodes: number;
  parameterBytes: number;
}

interface OpenRecord {
  readonly value: Record<string, unknown>;
  readonly release: () => void;
}

interface OpenArray {
  readonly value: readonly unknown[];
  readonly release: () => void;
}

interface FilterSlots {
  readonly signal?: SignalParameterHandle;
  readonly value?: NumberParameterHandle;
}

interface SectionSlots {
  readonly multiplier?: NumberParameterHandle;
  readonly filters: readonly FilterSlots[];
}

const templateRegistrations = new WeakMap<object, ConstantConfigurationTemplateRegistration>();

function fail(path: string, message: string, span?: import('@comblang/shared').SourceSpan): never {
  throw new ConstantParameterError('CP1000', path, message, span);
}

function enterContainer(
  value: object,
  path: string,
  depth: number,
  budget: TemplateBudget,
): () => void {
  if (depth > constantConfigurationLimits.maxDepth) {
    fail(path, `template exceeds the depth limit of ${constantConfigurationLimits.maxDepth}.`);
  }
  budget.nodes += 1;
  if (budget.nodes > constantConfigurationLimits.maxNodes) {
    fail(path, `template exceeds the node limit of ${constantConfigurationLimits.maxNodes}.`);
  }
  if (budget.active.has(value)) fail(path, 'cyclic template data is not supported.');
  budget.active.add(value);
  return () => budget.active.delete(value);
}

function openRecord(
  value: unknown,
  path: string,
  depth: number,
  budget: TemplateBudget,
): OpenRecord {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    fail(path, 'expected a plain data record.');
  }
  const release = enterContainer(value, path, depth, budget);
  try {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      fail(path, 'expected a plain object or null-prototype record.');
    }
    const record = Object.create(null) as Record<string, unknown>;
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== 'string') fail(path, 'symbol keys are not supported.');
      const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
      if (!('value' in descriptor)) fail(`${path}.${key}`, 'accessors are not supported.');
      if (!descriptor.enumerable)
        fail(`${path}.${key}`, 'non-enumerable fields are not supported.');
      record[key] = descriptor.value;
    }
    return { value: record, release };
  } catch (error) {
    release();
    throw error;
  }
}

function openArray(value: unknown, path: string, depth: number, budget: TemplateBudget): OpenArray {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    fail(path, 'expected a plain array.');
  }
  if (value.length > constantConfigurationLimits.maxNodes - budget.nodes) {
    fail(path, `template exceeds the node limit of ${constantConfigurationLimits.maxNodes}.`);
  }
  const release = enterContainer(value, path, depth, budget);
  try {
    const values: unknown[] = [];
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== 'string') fail(path, 'symbol keys are not supported.');
      if (key === 'length') continue;
      if (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= value.length) {
        fail(`${path}.${key}`, 'unknown array field.');
      }
      const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
      if (!('value' in descriptor)) fail(`${path}[${key}]`, 'accessors are not supported.');
      if (!descriptor.enumerable)
        fail(`${path}[${key}]`, 'non-enumerable values are not supported.');
    }
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (descriptor === undefined) fail(`${path}[${index}]`, 'array holes are not supported.');
      if (!('value' in descriptor)) fail(`${path}[${index}]`, 'accessors are not supported.');
      values.push(descriptor.value);
    }
    return { value: values, release };
  } catch (error) {
    release();
    throw error;
  }
}

function exactKeys(record: Record<string, unknown>, keys: readonly string[], path: string): void {
  const allowed = new Set(keys);
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) fail(`${path}.${key}`, 'unknown Constant template field.');
  }
}

function parameterShaped(value: unknown): boolean {
  if (value === null || (typeof value !== 'object' && typeof value !== 'function')) return false;
  const descriptor = Object.getOwnPropertyDescriptor(value, 'kind');
  return (
    descriptor !== undefined &&
    'value' in descriptor &&
    (descriptor.value === 'number' || descriptor.value === 'signal')
  );
}

function accountParameter(
  value: unknown,
  kind: 'number' | 'signal',
  session: ConstantParameterSession,
  path: string,
  budget: TemplateBudget,
): NumberParameterHandle | SignalParameterHandle | undefined {
  const registration = findConstantParameterHandle(value);
  if (registration === undefined) {
    if (parameterShaped(value)) {
      throw new ConstantParameterError('CP1001', path, 'unregistered parameter-like object.');
    }
    return undefined;
  }
  const owned = assertConstantParameterFromSession(session, value, path);
  if (owned.kind !== kind) {
    throw new ConstantParameterError(
      'CP1001',
      path,
      `expected a ${kind} parameter, received ${owned.kind}.`,
      owned.source,
    );
  }
  const descriptorBytes = new TextEncoder().encode(
    JSON.stringify({
      kind: owned.kind,
      label: owned.label,
      ...(owned.defaultValue === undefined ? {} : { defaultValue: owned.defaultValue }),
    }),
  ).byteLength;
  budget.parameterBytes += descriptorBytes;
  if (budget.parameterBytes > constantConfigurationLimits.maxBytes) {
    fail(
      path,
      `template exceeds the byte limit of ${constantConfigurationLimits.maxBytes}.`,
      owned.source,
    );
  }
  return value as NumberParameterHandle | SignalParameterHandle;
}

function rejectParameterOutsideSlot(value: unknown, path: string): void {
  const registration = findConstantParameterHandle(value);
  if (registration !== undefined) {
    throw new ConstantParameterError(
      'CP1001',
      path,
      'parameter references are allowed only in signal, filter count, and multiplier slots.',
      registration.source,
    );
  }
  if (parameterShaped(value)) {
    throw new ConstantParameterError('CP1001', path, 'unregistered parameter-like object.');
  }
}

function canonicalizePrepared(value: unknown): ConstantConfiguration {
  try {
    return canonicalizeConstantConfiguration(value);
  } catch (error) {
    if (error instanceof ConstantConfigurationError) {
      fail(error.path, error.detail);
    }
    fail('$', error instanceof Error ? error.message : 'invalid Constant template data.');
  }
}

function freezeTemplate<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) freezeTemplate(child);
    Object.freeze(value);
  }
  return value;
}

/** Creates a bounded immutable symbolic Constant template without widening concrete config types. */
export function createConstantConfigurationTemplate(
  session: ConstantParameterSession,
  value: unknown,
): ConstantConfigurationTemplate {
  assertConstantParameterSession(session, '$.session');
  const budget: TemplateBudget = { active: new WeakSet(), nodes: 0, parameterBytes: 0 };
  const root = openRecord(value, '$', 0, budget);
  let normalized: ConstantConfiguration;
  let slots: readonly SectionSlots[];
  try {
    exactKeys(root.value, ['isOn', 'sections'], '$');
    const prepared: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    if (Object.hasOwn(root.value, 'isOn')) {
      rejectParameterOutsideSlot(root.value.isOn, '$.isOn');
      prepared.isOn = root.value.isOn;
    }

    const sectionsPath = '$.sections';
    const rawSections = Object.hasOwn(root.value, 'sections') ? root.value.sections : [];
    const sections = openArray(rawSections, sectionsPath, 1, budget);
    try {
      const preparedSections: Record<string, unknown>[] = [];
      const sectionSlots: SectionSlots[] = [];
      sections.value.forEach((rawSection, sectionIndex) => {
        const sectionPath = `${sectionsPath}[${sectionIndex}]`;
        const section = openRecord(rawSection, sectionPath, 2, budget);
        try {
          exactKeys(section.value, ['active', 'group', 'multiplier', 'filters'], sectionPath);
          const preparedSection: Record<string, unknown> = Object.create(null) as Record<
            string,
            unknown
          >;
          for (const key of ['active', 'group'] as const) {
            if (Object.hasOwn(section.value, key)) {
              rejectParameterOutsideSlot(section.value[key], `${sectionPath}.${key}`);
              preparedSection[key] = section.value[key];
            }
          }
          let multiplier: NumberParameterHandle | undefined;
          if (Object.hasOwn(section.value, 'multiplier')) {
            const rawMultiplier = section.value.multiplier;
            const reference = accountParameter(
              rawMultiplier,
              'number',
              session,
              `${sectionPath}.multiplier`,
              budget,
            );
            if (reference !== undefined) {
              multiplier = reference as NumberParameterHandle;
              preparedSection.multiplier = 1;
            } else {
              preparedSection.multiplier = rawMultiplier;
            }
          }

          const filtersPath = `${sectionPath}.filters`;
          const rawFilters = Object.hasOwn(section.value, 'filters') ? section.value.filters : [];
          const filters = openArray(rawFilters, filtersPath, 3, budget);
          try {
            const preparedFilters: Record<string, unknown>[] = [];
            const filterSlots: FilterSlots[] = [];
            filters.value.forEach((rawFilter, filterIndex) => {
              const filterPath = `${filtersPath}[${filterIndex}]`;
              const filter = openRecord(rawFilter, filterPath, 4, budget);
              try {
                exactKeys(filter.value, ['signal', 'value'], filterPath);
                const preparedFilter: Record<string, unknown> = Object.create(null) as Record<
                  string,
                  unknown
                >;
                let signalReference: SignalParameterHandle | undefined;
                if (Object.hasOwn(filter.value, 'signal')) {
                  const rawSignal = filter.value.signal;
                  const reference = accountParameter(
                    rawSignal,
                    'signal',
                    session,
                    `${filterPath}.signal`,
                    budget,
                  );
                  if (reference !== undefined) {
                    signalReference = reference as SignalParameterHandle;
                    preparedFilter.signal = signal('virtual', 'signal-template-placeholder');
                  } else {
                    preparedFilter.signal = rawSignal;
                  }
                }
                let valueReference: NumberParameterHandle | undefined;
                if (Object.hasOwn(filter.value, 'value')) {
                  const rawValue = filter.value.value;
                  const reference = accountParameter(
                    rawValue,
                    'number',
                    session,
                    `${filterPath}.value`,
                    budget,
                  );
                  if (reference !== undefined) {
                    valueReference = reference as NumberParameterHandle;
                    preparedFilter.value = 0;
                  } else {
                    preparedFilter.value = rawValue;
                  }
                }
                preparedFilters.push(preparedFilter);
                filterSlots.push({
                  ...(signalReference === undefined ? {} : { signal: signalReference }),
                  ...(valueReference === undefined ? {} : { value: valueReference }),
                });
              } finally {
                filter.release();
              }
            });
            preparedSection.filters = preparedFilters;
            preparedSections.push(preparedSection);
            sectionSlots.push({
              ...(multiplier === undefined ? {} : { multiplier }),
              filters: filterSlots,
            });
          } finally {
            filters.release();
          }
        } finally {
          section.release();
        }
      });
      prepared.sections = preparedSections;
      slots = sectionSlots;
      normalized = canonicalizePrepared(prepared);
    } finally {
      sections.release();
    }
  } finally {
    root.release();
  }

  const canonicalBytes = new TextEncoder().encode(JSON.stringify(normalized)).byteLength;
  if (canonicalBytes + budget.parameterBytes > constantConfigurationLimits.maxBytes) {
    fail('$', `template exceeds the byte limit of ${constantConfigurationLimits.maxBytes}.`);
  }
  const template = freezeTemplate({
    [templateBrand]: true as const,
    isOn: normalized.isOn,
    sections: normalized.sections.map((section, sectionIndex) => {
      const sectionSlots = slots[sectionIndex]!;
      return {
        active: section.active,
        ...(section.group === undefined ? {} : { group: section.group }),
        multiplier: sectionSlots.multiplier ?? section.multiplier,
        filters: section.filters.map((filter, filterIndex) => {
          const filterSlots = sectionSlots.filters[filterIndex]!;
          return {
            signal: filterSlots.signal ?? filter.signal,
            value: filterSlots.value ?? filter.value,
          };
        }),
      };
    }),
  });
  templateRegistrations.set(template, Object.freeze({ session }));
  return template;
}

/** Verifies template authenticity for atomic binding and returns its owner session. */
export function inspectConstantConfigurationTemplate(
  value: unknown,
  path: string,
): ConstantConfigurationTemplateRegistration {
  if (value === null || (typeof value !== 'object' && typeof value !== 'function')) {
    throw new ConstantParameterError(
      'CP1002',
      path,
      'value is not a registered Constant template.',
    );
  }
  const registration = templateRegistrations.get(value);
  if (registration === undefined) {
    throw new ConstantParameterError(
      'CP1002',
      path,
      'value is not a registered Constant template.',
    );
  }
  return registration;
}

import {
  canonicalizeConstantConfiguration,
  ConstantConfigurationError,
  constantConfigurationLimits,
  signal,
  type ConstantConfiguration,
  type SignalId,
} from '@comblang/factorio';

import {
  assertBlueprintParameterSession,
  BlueprintParameterError,
  findBlueprintParameterHandle,
  type BlueprintParameterSession,
  type BlueprintNumberParameterHandle,
  type BlueprintSignalParameterHandle,
} from './blueprint-parameters.js';
import {
  assertBlueprintParameterExactKeys,
  createBlueprintParameterDataBudget,
  isBlueprintParameterShaped,
  lookupBlueprintParameterSlot,
  openBlueprintParameterArray,
  openBlueprintParameterRecord,
  type BlueprintParameterDataBudget,
  type OpenBlueprintParameterArray,
  type OpenBlueprintParameterRecord,
} from './blueprint-parameter-validation.js';

const templateBrand: unique symbol = Symbol('constant-configuration-template');

export type ConstantTemplateNumberSlot = number | BlueprintNumberParameterHandle;
export type ConstantTemplateSignalSlot = SignalId | BlueprintSignalParameterHandle;

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
  readonly session: BlueprintParameterSession;
}

interface TemplateBudget extends BlueprintParameterDataBudget {
  parameterBytes: number;
}

interface FilterSlots {
  readonly signal?: BlueprintSignalParameterHandle;
  readonly value?: BlueprintNumberParameterHandle;
}

interface SectionSlots {
  readonly multiplier?: BlueprintNumberParameterHandle;
  readonly filters: readonly FilterSlots[];
}

const templateRegistrations = new WeakMap<object, ConstantConfigurationTemplateRegistration>();

function fail(path: string, message: string, span?: import('@comblang/shared').SourceSpan): never {
  throw new BlueprintParameterError('CP1000', path, message, span);
}

function accountParameter(
  value: unknown,
  kind: 'number' | 'signal',
  session: BlueprintParameterSession,
  path: string,
  budget: TemplateBudget,
): BlueprintNumberParameterHandle | BlueprintSignalParameterHandle | undefined {
  const slot = lookupBlueprintParameterSlot(value, kind, session, path);
  if (slot === undefined) return undefined;
  const owned = slot.registration;
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
  return slot.handle as BlueprintNumberParameterHandle | BlueprintSignalParameterHandle;
}

function rejectParameterOutsideSlot(value: unknown, path: string): void {
  const registration = findBlueprintParameterHandle(value);
  if (registration !== undefined) {
    throw new BlueprintParameterError(
      'CP1001',
      path,
      'parameter references are allowed only in signal, filter count, and multiplier slots.',
      registration.source,
    );
  }
  if (isBlueprintParameterShaped(value)) {
    throw new BlueprintParameterError('CP1001', path, 'unregistered parameter-like object.');
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
  session: BlueprintParameterSession,
  value: unknown,
): ConstantConfigurationTemplate {
  assertBlueprintParameterSession(session, '$.session');
  const budget: TemplateBudget = { ...createBlueprintParameterDataBudget(), parameterBytes: 0 };
  const root = openBlueprintParameterRecord(value, '$', 0, budget);
  let normalized: ConstantConfiguration;
  let slots: readonly SectionSlots[];
  try {
    assertBlueprintParameterExactKeys(
      root.value,
      ['isOn', 'sections'],
      '$',
      'unknown Constant template field.',
    );
    const prepared: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    if (Object.hasOwn(root.value, 'isOn')) {
      rejectParameterOutsideSlot(root.value.isOn, '$.isOn');
      prepared.isOn = root.value.isOn;
    }

    const sectionsPath = '$.sections';
    const rawSections = Object.hasOwn(root.value, 'sections') ? root.value.sections : [];
    const sections: OpenBlueprintParameterArray = openBlueprintParameterArray(
      rawSections,
      sectionsPath,
      1,
      budget,
    );
    try {
      const preparedSections: Record<string, unknown>[] = [];
      const sectionSlots: SectionSlots[] = [];
      sections.value.forEach((rawSection, sectionIndex) => {
        const sectionPath = `${sectionsPath}[${sectionIndex}]`;
        const section: OpenBlueprintParameterRecord = openBlueprintParameterRecord(
          rawSection,
          sectionPath,
          2,
          budget,
        );
        try {
          assertBlueprintParameterExactKeys(
            section.value,
            ['active', 'group', 'multiplier', 'filters'],
            sectionPath,
            'unknown Constant template field.',
          );
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
          let multiplier: BlueprintNumberParameterHandle | undefined;
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
              multiplier = reference as BlueprintNumberParameterHandle;
              preparedSection.multiplier = 1;
            } else {
              preparedSection.multiplier = rawMultiplier;
            }
          }

          const filtersPath = `${sectionPath}.filters`;
          const rawFilters = Object.hasOwn(section.value, 'filters') ? section.value.filters : [];
          const filters = openBlueprintParameterArray(rawFilters, filtersPath, 3, budget);
          try {
            const preparedFilters: Record<string, unknown>[] = [];
            const filterSlots: FilterSlots[] = [];
            filters.value.forEach((rawFilter, filterIndex) => {
              const filterPath = `${filtersPath}[${filterIndex}]`;
              const filter = openBlueprintParameterRecord(rawFilter, filterPath, 4, budget);
              try {
                assertBlueprintParameterExactKeys(
                  filter.value,
                  ['signal', 'value'],
                  filterPath,
                  'unknown Constant template field.',
                );
                const preparedFilter: Record<string, unknown> = Object.create(null) as Record<
                  string,
                  unknown
                >;
                let signalReference: BlueprintSignalParameterHandle | undefined;
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
                    signalReference = reference as BlueprintSignalParameterHandle;
                    preparedFilter.signal = signal('virtual', 'signal-template-placeholder');
                  } else {
                    preparedFilter.signal = rawSignal;
                  }
                }
                let valueReference: BlueprintNumberParameterHandle | undefined;
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
                    valueReference = reference as BlueprintNumberParameterHandle;
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
    throw new BlueprintParameterError(
      'CP1002',
      path,
      'value is not a registered Constant template.',
    );
  }
  const registration = templateRegistrations.get(value);
  if (registration === undefined) {
    throw new BlueprintParameterError(
      'CP1002',
      path,
      'value is not a registered Constant template.',
    );
  }
  return registration;
}

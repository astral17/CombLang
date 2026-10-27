import {
  canonicalizeConstantConfiguration,
  ConstantConfigurationError,
  constantConfigurationLimits,
  maxConstantConfigurationFiltersPerSection,
  signal,
  type ConstantConfiguration,
  type SignalId,
} from '@comblang/factorio';
import type { SourceSpan } from '@comblang/shared';

import {
  assertBlueprintParameterSession,
  BlueprintParameterError,
  findBlueprintParameterHandle,
  type BlueprintParameterHandle,
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
import type { BlueprintNumericExpression } from './blueprint-numeric-expression.js';
import {
  inspectRegisteredBlueprintNumericExpression,
  isRegisteredBlueprintNumericExpression,
} from './blueprint-numeric-expression-bridge.js';
import {
  inspectBlueprintRecipeIngredientReference,
  type RegisteredBlueprintRecipeIngredientReference,
} from './blueprint-recipe-ingredient-reference.js';

const templateBrand: unique symbol = Symbol('constant-configuration-template');

export type ConstantTemplateNumberSlot =
  | number
  | BlueprintNumberParameterHandle
  | RegisteredBlueprintRecipeIngredientReference['reference'];
export type ConstantTemplateMultiplierSlot =
  ConstantTemplateNumberSlot | BlueprintNumericExpression;
export type ConstantTemplateSignalSlot =
  | SignalId
  | BlueprintSignalParameterHandle
  | RegisteredBlueprintRecipeIngredientReference['reference'];

export interface ConstantConfigurationTemplateFilter {
  readonly signal: ConstantTemplateSignalSlot;
  readonly value: ConstantTemplateNumberSlot | BlueprintNumericExpression;
}

export interface ConstantConfigurationTemplateSection {
  readonly active: boolean;
  readonly group?: string;
  readonly multiplier: ConstantTemplateMultiplierSlot;
  readonly filters: readonly ConstantConfigurationTemplateFilter[];
}

export interface ConstantConfigurationTemplate {
  readonly [templateBrand]: true;
  readonly isOn: boolean;
  readonly sections: readonly ConstantConfigurationTemplateSection[];
}

export interface ConstantConfigurationTemplateRegistration {
  readonly session: BlueprintParameterSession;
  readonly usedParameters: readonly BlueprintParameterHandle[];
  readonly recipeIngredientReferences: readonly RegisteredBlueprintRecipeIngredientReference[];
}

/** Host-resolved leaf material supplied to the compiler without provider knowledge. */
export interface ConstantRecipeIngredientResolution {
  readonly parameter: BlueprintSignalParameterHandle;
  readonly index: number;
  readonly status: 'absent' | 'present';
  readonly signal?: SignalId;
  readonly amount?: number;
}

interface TemplateBudget extends BlueprintParameterDataBudget {
  parameterBytes: number;
  expressionBytes: number;
  expressionRoots: WeakSet<object>;
  readonly recipeIngredientRoots: WeakSet<object>;
  sectionRecipeIngredientRoots: WeakSet<object>;
  readonly recipeIngredientReferences: RegisteredBlueprintRecipeIngredientReference[];
}

interface FilterSlots {
  readonly signal?:
    BlueprintSignalParameterHandle | RegisteredBlueprintRecipeIngredientReference['reference'];
  readonly value?: ConstantTemplateNumberSlot | BlueprintNumericExpression;
}

interface SectionSlots {
  readonly multiplier?: ConstantTemplateMultiplierSlot;
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
  budget.usedParameters.add(slot.handle);
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

function accountRecipeIngredientReference(
  reference: RegisteredBlueprintRecipeIngredientReference,
  path: string,
  budget: TemplateBudget,
): void {
  assertBlueprintParameterSession(reference.session, `${path}.session`);
  const registration = lookupBlueprintParameterSlot(
    reference.parameter,
    'signal',
    reference.session,
    `${path}.parameter`,
  );
  if (registration === undefined) {
    throw new BlueprintParameterError(
      'CP1001',
      `${path}.parameter`,
      'recipe ingredient reference has no owning Signal parameter.',
      reference.source,
    );
  }
  budget.usedParameters.add(registration.handle);
  if (!budget.recipeIngredientRoots.has(reference.reference)) {
    budget.recipeIngredientRoots.add(reference.reference);
    budget.recipeIngredientReferences.push(reference);
  }
  if (budget.sectionRecipeIngredientRoots.has(reference.reference)) return;
  budget.sectionRecipeIngredientRoots.add(reference.reference);
  budget.nodes += 1;
  if (budget.nodes > constantConfigurationLimits.maxNodes) {
    fail(
      path,
      `template exceeds the node limit of ${constantConfigurationLimits.maxNodes}.`,
      reference.source,
    );
  }
  budget.parameterBytes += new TextEncoder().encode(
    JSON.stringify({ index: reference.index, slot: reference.slot, source: reference.source }),
  ).byteLength;
  if (budget.parameterBytes > constantConfigurationLimits.maxBytes) {
    fail(
      path,
      `template exceeds the byte limit of ${constantConfigurationLimits.maxBytes}.`,
      reference.source,
    );
  }
}

function accountExpression(
  expression: BlueprintNumericExpression,
  session: BlueprintParameterSession,
  path: string,
  budget: TemplateBudget,
): BlueprintNumericExpression {
  const inspection = inspectRegisteredBlueprintNumericExpression(session, expression, path);
  if (!budget.expressionRoots.has(expression)) {
    budget.expressionRoots.add(expression);
    budget.nodes += inspection.nodeCount;
    if (budget.nodes > constantConfigurationLimits.maxNodes) {
      fail(
        path,
        `template exceeds the node limit of ${constantConfigurationLimits.maxNodes}.`,
        inspection.source,
      );
    }
    budget.expressionBytes += inspection.byteLength;
    if (budget.expressionBytes > constantConfigurationLimits.maxBytes) {
      fail(
        path,
        `template exceeds the byte limit of ${constantConfigurationLimits.maxBytes}.`,
        inspection.source,
      );
    }
    for (const dependency of inspection.dependencies) {
      budget.usedParameters.add(dependency);
    }
  }
  return expression;
}

function rejectParameterOutsideSlot(value: unknown, path: string): void {
  rejectNumericExpressionOutsideSlot(value, path);
  const ingredient = inspectBlueprintRecipeIngredientReference(value);
  if (ingredient !== undefined) {
    throw new BlueprintParameterError(
      'CP1001',
      path,
      'recipe ingredient references are allowed only in exact Constant filter signal or value slots.',
      ingredient.source,
    );
  }
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

function isNumericExpressionShaped(value: unknown): boolean {
  if (value === null || typeof value !== 'object') return false;
  const descriptor = Object.getOwnPropertyDescriptor(value, 'kind');
  return (
    descriptor !== undefined &&
    'value' in descriptor &&
    ['literal', 'parameter', 'negate', 'binary'].includes(String(descriptor.value))
  );
}

function rejectNumericExpressionOutsideSlot(value: unknown, path: string): void {
  if (inspectBlueprintRecipeIngredientReference(value) !== undefined) return;
  if (isRegisteredBlueprintNumericExpression(value) || isNumericExpressionShaped(value)) {
    throw new BlueprintParameterError(
      'CP1001',
      path,
      'numeric expressions are allowed only in Constant section multipliers and filter counts.',
    );
  }
}

function assertConstantExactKeys(
  record: Record<string, unknown>,
  keys: readonly string[],
  path: string,
  message: string,
): void {
  const allowed = new Set(keys);
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) {
      const ingredient = inspectBlueprintRecipeIngredientReference(record[key]);
      if (ingredient !== undefined) {
        throw new BlueprintParameterError(
          'CP1001',
          `${path}.${key}`,
          'recipe ingredient references are allowed only in exact Constant filter signal or value slots.',
          ingredient.source,
        );
      }
      rejectNumericExpressionOutsideSlot(record[key], `${path}.${key}`);
    }
  }
  assertBlueprintParameterExactKeys(record, keys, path, message);
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
  if (inspectBlueprintRecipeIngredientReference(value) !== undefined) return value;
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
  const budget: TemplateBudget = {
    ...createBlueprintParameterDataBudget(),
    parameterBytes: 0,
    expressionBytes: 0,
    expressionRoots: new WeakSet(),
    recipeIngredientRoots: new WeakSet(),
    sectionRecipeIngredientRoots: new WeakSet(),
    recipeIngredientReferences: [],
  };
  let recipeIngredientPlaceholderOrdinal = 0;
  const root = openBlueprintParameterRecord(value, '$', 0, budget);
  let normalized: ConstantConfiguration;
  let slots: readonly SectionSlots[];
  let sectionBudgets: { parameterBytes: number; expressionBytes: number }[] = [];
  try {
    assertConstantExactKeys(
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
      sectionBudgets = [];
      const headerNodes = budget.nodes;
      sections.value.forEach((rawSection, sectionIndex) => {
        budget.nodes = 0;
        budget.parameterBytes = 0;
        budget.expressionBytes = 0;
        budget.expressionRoots = new WeakSet();
        budget.sectionRecipeIngredientRoots = new WeakSet();
        const sectionPath = `${sectionsPath}[${sectionIndex}]`;
        const section: OpenBlueprintParameterRecord = openBlueprintParameterRecord(
          rawSection,
          sectionPath,
          2,
          budget,
        );
        try {
          assertConstantExactKeys(
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
          let multiplier: ConstantTemplateMultiplierSlot | undefined;
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
            } else if (isRegisteredBlueprintNumericExpression(rawMultiplier)) {
              multiplier = accountExpression(
                rawMultiplier,
                session,
                `${sectionPath}.multiplier`,
                budget,
              );
              preparedSection.multiplier = 1;
            } else if (isNumericExpressionShaped(rawMultiplier)) {
              rejectNumericExpressionOutsideSlot(rawMultiplier, `${sectionPath}.multiplier`);
            } else {
              preparedSection.multiplier = rawMultiplier;
            }
          }

          const filtersPath = `${sectionPath}.filters`;
          const rawFilters = Object.hasOwn(section.value, 'filters') ? section.value.filters : [];
          if (
            Array.isArray(rawFilters) &&
            Object.getPrototypeOf(rawFilters) === Array.prototype &&
            rawFilters.length > maxConstantConfigurationFiltersPerSection
          ) {
            fail(
              filtersPath,
              `section exceeds the filter row limit of ${maxConstantConfigurationFiltersPerSection}.`,
            );
          }
          const filters = openBlueprintParameterArray(rawFilters, filtersPath, 3, budget);
          try {
            const preparedFilters: Record<string, unknown>[] = [];
            const filterSlots: FilterSlots[] = [];
            filters.value.forEach((rawFilter, filterIndex) => {
              const filterPath = `${filtersPath}[${filterIndex}]`;
              const filter = openBlueprintParameterRecord(rawFilter, filterPath, 4, budget);
              try {
                assertConstantExactKeys(
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
                let signalIngredientReference:
                  RegisteredBlueprintRecipeIngredientReference['reference'] | undefined;
                if (Object.hasOwn(filter.value, 'signal')) {
                  const rawSignal = filter.value.signal;
                  rejectNumericExpressionOutsideSlot(rawSignal, `${filterPath}.signal`);
                  const ingredient = inspectBlueprintRecipeIngredientReference(rawSignal);
                  if (ingredient !== undefined) {
                    if (ingredient.session !== session) {
                      throw new BlueprintParameterError(
                        'CP1001',
                        `${filterPath}.signal`,
                        'recipe ingredient reference belongs to a different parameter session.',
                        ingredient.source,
                      );
                    }
                    if (ingredient.slot !== 'signal') {
                      throw new BlueprintParameterError(
                        'CP1001',
                        `${filterPath}.signal`,
                        'expected the signal field of a recipe ingredient reference.',
                        ingredient.source,
                      );
                    }
                    accountRecipeIngredientReference(ingredient, `${filterPath}.signal`, budget);
                    signalIngredientReference = ingredient.reference;
                    preparedFilter.signal = signal(
                      'virtual',
                      `ingredient-template-${recipeIngredientPlaceholderOrdinal++}`,
                    );
                  } else {
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
                }
                let valueReference:
                  ConstantTemplateNumberSlot | BlueprintNumericExpression | undefined;
                if (Object.hasOwn(filter.value, 'value')) {
                  const rawValue = filter.value.value;
                  const ingredient = inspectBlueprintRecipeIngredientReference(rawValue);
                  if (ingredient !== undefined) {
                    if (ingredient.session !== session) {
                      throw new BlueprintParameterError(
                        'CP1001',
                        `${filterPath}.value`,
                        'recipe ingredient reference belongs to a different parameter session.',
                        ingredient.source,
                      );
                    }
                    if (ingredient.slot !== 'amount') {
                      throw new BlueprintParameterError(
                        'CP1001',
                        `${filterPath}.value`,
                        'expected the amount field of a recipe ingredient reference.',
                        ingredient.source,
                      );
                    }
                    accountRecipeIngredientReference(ingredient, `${filterPath}.value`, budget);
                    valueReference = ingredient.reference;
                    preparedFilter.value = 0;
                  } else if (isRegisteredBlueprintNumericExpression(rawValue)) {
                    valueReference = accountExpression(
                      rawValue,
                      session,
                      `${filterPath}.value`,
                      budget,
                    );
                    preparedFilter.value = 0;
                  } else {
                    rejectNumericExpressionOutsideSlot(rawValue, `${filterPath}.value`);
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
                }
                preparedFilters.push(preparedFilter);
                filterSlots.push({
                  ...(signalReference === undefined ? {} : { signal: signalReference }),
                  ...(signalIngredientReference === undefined
                    ? {}
                    : { signal: signalIngredientReference }),
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
        sectionBudgets.push({
          parameterBytes: budget.parameterBytes,
          expressionBytes: budget.expressionBytes,
        });
      });
      budget.nodes = headerNodes;
      prepared.sections = preparedSections;
      slots = sectionSlots;
      normalized = canonicalizePrepared(prepared);
    } finally {
      sections.release();
    }
  } finally {
    root.release();
  }

  const encoder = new TextEncoder();
  const header = {
    isOn: normalized.isOn,
    sections: normalized.sections.map(({ active, group, multiplier }) => ({
      active,
      ...(group === undefined ? {} : { group }),
      multiplier,
    })),
  };
  const headerBytes = encoder.encode(JSON.stringify(header)).byteLength;
  if (headerBytes > constantConfigurationLimits.maxBytes) {
    fail('$', `template header exceeds the byte limit of ${constantConfigurationLimits.maxBytes}.`);
  }
  for (let index = 0; index < normalized.sections.length; index += 1) {
    const canonicalBytes = encoder.encode(JSON.stringify(normalized.sections[index])).byteLength;
    const sectionBudget = sectionBudgets[index]!;
    if (
      canonicalBytes + sectionBudget.parameterBytes + sectionBudget.expressionBytes >
      constantConfigurationLimits.maxBytes
    ) {
      fail(
        `$.sections[${index}]`,
        `template section exceeds the byte limit of ${constantConfigurationLimits.maxBytes}.`,
      );
    }
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
  templateRegistrations.set(
    template,
    Object.freeze({
      session,
      usedParameters: Object.freeze([...budget.usedParameters]),
      recipeIngredientReferences: Object.freeze([...budget.recipeIngredientReferences]),
    }),
  );
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

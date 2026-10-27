import {
  canonicalizeConstantConfiguration,
  ConstantConfigurationError,
  type ConstantConfiguration,
} from '@comblang/factorio';
import type { SourceSpan } from '@comblang/shared';

import { prefixExpressionError } from './blueprint-configuration-utils.js';
import {
  assertBlueprintParameterFromSession,
  BlueprintParameterError,
  findBlueprintParameterHandle,
  inspectBlueprintParameterHandle,
  type BlueprintParameterHandle,
  type BlueprintParameterKind,
} from './blueprint-parameters.js';
import {
  assertBlueprintParameterNumberValue,
  canonicalizeBlueprintParameterSignal,
  readBlueprintParameterBindings,
  type BlueprintParameterBinding,
} from './blueprint-parameter-validation.js';
import {
  evaluateRegisteredBlueprintNumericExpression,
  inspectRegisteredBlueprintNumericExpression,
  isRegisteredBlueprintNumericExpression,
} from './blueprint-numeric-expression-bridge.js';
import type { BlueprintNumericExpression } from './blueprint-numeric-expression.js';
import {
  inspectConstantConfigurationTemplate,
  type ConstantRecipeIngredientResolution,
  type ConstantConfigurationTemplate,
} from './constant-configuration-template.js';
import { inspectBlueprintRecipeIngredientReference } from './blueprint-recipe-ingredient-reference.js';

interface SlotSource {
  readonly parameter?: BlueprintParameterHandle;
  readonly span?: SourceSpan;
}

function fail(
  path: string,
  message: string,
  span?: SourceSpan,
  code: 'CP1000' | 'CP1001' | 'CP1002' = 'CP1000',
): never {
  throw new BlueprintParameterError(code, path, message, span);
}

/** Resolves one internal symbolic Constant template to a fresh concrete configuration. */
export function bindConstantConfigurationTemplate(
  templateValue: unknown,
  bindingsValue: readonly BlueprintParameterBinding[] = [],
  recipeIngredientResolutions: readonly ConstantRecipeIngredientResolution[] = [],
): ConstantConfiguration {
  const { session, usedParameters } = inspectConstantConfigurationTemplate(
    templateValue,
    '$.template',
  );
  const template = templateValue as ConstantConfigurationTemplate;
  const bindings = readBlueprintParameterBindings(session, bindingsValue);
  const explicit = new Map<object, unknown>();

  for (const binding of bindings) {
    explicit.set(binding.parameter, binding.value);
  }
  const ingredientResolutions = new Map<
    BlueprintParameterHandle,
    Map<number, ConstantRecipeIngredientResolution>
  >();
  for (const [index, resolution] of recipeIngredientResolutions.entries()) {
    const owned = assertBlueprintParameterFromSession(
      session,
      resolution.parameter,
      `$.recipeIngredientResolutions[${index}].parameter`,
    );
    if (owned.kind !== 'signal') {
      fail(
        `$.recipeIngredientResolutions[${index}].parameter`,
        'recipe ingredient resolutions require a Signal parameter.',
        owned.source,
        'CP1001',
      );
    }
    let byIndex = ingredientResolutions.get(resolution.parameter);
    if (byIndex === undefined) {
      byIndex = new Map();
      ingredientResolutions.set(resolution.parameter, byIndex);
    }
    if (byIndex.has(resolution.index)) {
      fail(
        `$.recipeIngredientResolutions[${index}]`,
        'duplicate recipe ingredient resolution.',
        owned.source,
        'CP1001',
      );
    }
    if (!Number.isSafeInteger(resolution.index) || resolution.index < 0) {
      fail(
        `$.recipeIngredientResolutions[${index}].index`,
        'expected a non-negative safe integer ingredient index.',
        owned.source,
      );
    }
    if (resolution.status !== 'absent' && resolution.status !== 'present') {
      fail(
        `$.recipeIngredientResolutions[${index}].status`,
        'expected an absent or present recipe ingredient resolution.',
        owned.source,
      );
    }
    byIndex.set(resolution.index, resolution);
  }

  // A missing derived signal omits its filter before resolving the count, but
  // declarations in that count still belong to the authored template.
  const used = new Set<object>(usedParameters);
  const slotSources = new Map<string, SlotSource>();
  const concreteSections: Record<string, unknown>[] = [];

  const resolve = (
    value: unknown,
    kind: BlueprintParameterKind,
    path: string,
    domain: 'signal' | 'count' | 'multiplier',
  ): unknown => {
    const registration = findBlueprintParameterHandle(value);
    if (registration === undefined) {
      slotSources.set(path, {});
      return value;
    }
    const owned = assertBlueprintParameterFromSession(session, value, path);
    if (owned.kind !== kind) {
      fail(path, `expected a ${kind} parameter, received ${owned.kind}.`, owned.source, 'CP1001');
    }
    const parameter = value as object;
    used.add(parameter);
    const supplied = explicit.has(parameter);
    const resolved = supplied ? explicit.get(parameter) : owned.defaultValue;
    if (resolved === undefined) {
      if (supplied) fail(path, 'a binding value cannot be undefined.', owned.source);
      fail(path, `parameter "${owned.label}" has no binding or default.`, owned.source, 'CP1002');
    }
    let canonicalValue = resolved;
    if (owned.kind === 'number') {
      assertBlueprintParameterNumberValue(
        resolved,
        path,
        domain === 'count' ? 'safe-integer' : 'finite',
        owned.source,
        domain === 'count' ? 'filter counts must be safe integers.' : undefined,
      );
    } else {
      canonicalValue = canonicalizeBlueprintParameterSignal(resolved, path, owned.source);
    }
    slotSources.set(path, {
      parameter: value as BlueprintParameterHandle,
      ...(owned.source === undefined ? {} : { span: owned.source }),
    });
    return canonicalValue;
  };

  const resolveNumericExpression = (
    value: BlueprintNumericExpression,
    path: string,
    domain: 'count' | 'multiplier',
  ): number => {
    const inspection = inspectRegisteredBlueprintNumericExpression(session, value, path);
    const dependencies = new Set<object>(inspection.dependencies);
    for (const dependency of inspection.dependencies) used.add(dependency);
    const expressionBindings = bindings
      .filter((binding) => dependencies.has(binding.parameter))
      .map(({ parameter, value: bindingValue }) => ({ parameter, value: bindingValue }));
    let evaluated: number;
    try {
      evaluated = evaluateRegisteredBlueprintNumericExpression(session, value, expressionBindings);
    } catch (error) {
      prefixExpressionError(error, path);
    }
    slotSources.set(path, {
      ...(inspection.source === undefined ? {} : { span: inspection.source }),
    });
    return assertBlueprintParameterNumberValue(
      evaluated,
      path,
      domain === 'count' ? 'safe-integer' : 'finite',
      inspection.source,
      domain === 'count'
        ? 'Constant filter counts must be safe integers.'
        : 'Constant multipliers must be finite numbers.',
    );
  };

  const resolveMultiplier = (value: unknown, path: string): number =>
    isRegisteredBlueprintNumericExpression(value)
      ? resolveNumericExpression(value, path, 'multiplier')
      : (resolve(value, 'number', path, 'multiplier') as number);

  const resolveCount = (value: unknown, path: string): number =>
    isRegisteredBlueprintNumericExpression(value)
      ? resolveNumericExpression(value, path, 'count')
      : (resolve(value, 'number', path, 'count') as number);

  const ingredientResolution = (
    value: unknown,
    slot: 'signal' | 'amount',
    path: string,
  ):
    | {
        readonly reference: NonNullable<
          ReturnType<typeof inspectBlueprintRecipeIngredientReference>
        >;
        readonly resolution: ConstantRecipeIngredientResolution;
      }
    | undefined => {
    const reference = inspectBlueprintRecipeIngredientReference(value);
    if (reference === undefined) return undefined;
    if (reference.session !== session) {
      fail(
        path,
        'recipe ingredient reference belongs to a different parameter session.',
        reference.source,
        'CP1001',
      );
    }
    if (reference.slot !== slot) {
      fail(
        path,
        `expected the ${slot} field of a recipe ingredient reference.`,
        reference.source,
        'CP1001',
      );
    }
    used.add(reference.parameter);
    const resolution = ingredientResolutions.get(reference.parameter)?.get(reference.index);
    if (resolution === undefined) {
      fail(
        path,
        'recipe ingredient reference was not resolved for this binding.',
        reference.source,
        'CP1002',
      );
    }
    return { reference, resolution };
  };
  const omittedFilter = Symbol('omitted recipe ingredient filter');
  const resolveFilterSignal = (value: unknown, path: string): unknown | typeof omittedFilter => {
    const ingredient = ingredientResolution(value, 'signal', path);
    if (ingredient === undefined) return resolve(value, 'signal', path, 'signal');
    slotSources.set(path, { span: ingredient.reference.source });
    if (ingredient.resolution.status === 'absent') return omittedFilter;
    if (ingredient.resolution.signal === undefined) {
      fail(
        path,
        'present recipe ingredient resolution has no Signal.',
        ingredient.reference.source,
        'CP1002',
      );
    }
    return canonicalizeBlueprintParameterSignal(
      ingredient.resolution.signal,
      path,
      ingredient.reference.source,
    );
  };
  const resolveIngredientAmount = (value: unknown, path: string): number | undefined => {
    const ingredient = ingredientResolution(value, 'amount', path);
    if (ingredient === undefined) return undefined;
    slotSources.set(path, { span: ingredient.reference.source });
    if (ingredient.resolution.status === 'absent') {
      fail(
        path,
        'recipe ingredient amount is absent for the selected Signal.',
        ingredient.reference.source,
        'CP1002',
      );
    }
    if (ingredient.resolution.amount === undefined) {
      fail(
        path,
        'present recipe ingredient resolution has no amount.',
        ingredient.reference.source,
        'CP1002',
      );
    }
    return assertBlueprintParameterNumberValue(
      ingredient.resolution.amount,
      path,
      'safe-integer',
      ingredient.reference.source,
      'recipe ingredient amounts used as Constant filter counts must be safe integers.',
    );
  };

  for (const [sectionIndex, section] of template.sections.entries()) {
    const sectionPath = `$.sections[${sectionIndex}]`;
    const concreteSection: Record<string, unknown> = {
      active: section.active,
      multiplier: resolveMultiplier(section.multiplier, `${sectionPath}.multiplier`),
      filters: section.filters.flatMap((filter, filterIndex) => {
        const filterPath = `${sectionPath}.filters[${filterIndex}]`;
        const signalValue = resolveFilterSignal(filter.signal, `${filterPath}.signal`);
        if (signalValue === omittedFilter) return [];
        const ingredientAmount = resolveIngredientAmount(filter.value, `${filterPath}.value`);
        return {
          signal: signalValue,
          value: ingredientAmount ?? resolveCount(filter.value, `${filterPath}.value`),
        };
      }),
    };
    if (section.group !== undefined) concreteSection.group = section.group;
    concreteSections.push(concreteSection);
  }

  for (const [parameter] of explicit) {
    if (!used.has(parameter)) {
      const registration = inspectBlueprintParameterHandle(parameter, '$.bindings');
      fail(
        '$.bindings',
        `parameter "${registration.label}" is not used by this template.`,
        registration.source,
        'CP1001',
      );
    }
  }

  try {
    return canonicalizeConstantConfiguration({ isOn: template.isOn, sections: concreteSections });
  } catch (error) {
    if (error instanceof ConstantConfigurationError) {
      const matchingPath = [...slotSources.keys()]
        .filter((path) => error.path === path || error.path.startsWith(`${path}.`))
        .sort((left, right) => right.length - left.length)[0];
      const span = matchingPath === undefined ? undefined : slotSources.get(matchingPath)?.span;
      fail(error.path, error.detail, span);
    }
    throw error;
  }
}

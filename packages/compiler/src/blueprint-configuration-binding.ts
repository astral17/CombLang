import {
  readBlueprintParameterBindings,
  type BlueprintParameterBinding,
} from './blueprint-parameter-validation.js';
import {
  BlueprintParameterError,
  inspectBlueprintParameterHandle,
} from './blueprint-parameters.js';
import { bindArithmeticConfigurationTemplate } from './arithmetic-configuration-binding.js';
import { inspectArithmeticConfigurationTemplate } from './arithmetic-configuration-template.js';
import { bindConstantConfigurationTemplate } from './constant-configuration-binding.js';
import { inspectConstantConfigurationTemplate } from './constant-configuration-template.js';
import { bindDeciderConfigurationTemplate } from './decider-configuration-binding.js';
import { inspectDeciderConfigurationTemplate } from './decider-configuration-template.js';
import { bindSelectorConfigurationTemplate } from './selector-configuration-binding.js';
import { inspectSelectorConfigurationTemplate } from './selector-configuration-template.js';
import {
  inspectBlueprintConfigurationSet,
  type BoundBlueprintConfiguration,
  type BlueprintConfigurationSetEntry,
} from './blueprint-configuration-set.js';

function fail(path: string, message: string, span?: import('@comblang/shared').SourceSpan): never {
  throw new BlueprintParameterError('CP1001', path, message, span);
}

function freezeDeep<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) freezeDeep(child);
    Object.freeze(value);
  }
  return value;
}

function templateParameters(entry: BlueprintConfigurationSetEntry) {
  switch (entry.kind) {
    case 'constant':
      return inspectConstantConfigurationTemplate(entry.template, '$.template').usedParameters;
    case 'arithmetic':
      return inspectArithmeticConfigurationTemplate(entry.template, '$.template').usedParameters;
    case 'decider':
      return inspectDeciderConfigurationTemplate(entry.template, '$.template').usedParameters;
    case 'selector':
      return inspectSelectorConfigurationTemplate(entry.template, '$.template').usedParameters;
  }
}

function bindEntry(
  entry: BlueprintConfigurationSetEntry,
  bindings: readonly BlueprintParameterBinding[],
): BoundBlueprintConfiguration {
  switch (entry.kind) {
    case 'constant':
      return freezeDeep({
        key: entry.key,
        kind: entry.kind,
        config: bindConstantConfigurationTemplate(entry.template, bindings),
      });
    case 'arithmetic':
      return freezeDeep({
        key: entry.key,
        kind: entry.kind,
        config: bindArithmeticConfigurationTemplate(entry.template, bindings),
      });
    case 'decider':
      return freezeDeep({
        key: entry.key,
        kind: entry.kind,
        config: bindDeciderConfigurationTemplate(entry.template, bindings),
      });
    case 'selector':
      return freezeDeep({
        key: entry.key,
        kind: entry.kind,
        config: bindSelectorConfigurationTemplate(entry.template, bindings),
      });
  }
}

function prefixEntryError(error: unknown, entryIndex: number): never {
  if (!(error instanceof BlueprintParameterError)) throw error;
  const prefix = `$.entries[${entryIndex}]`;
  const suffix =
    error.path === '$' ? '' : error.path.startsWith('$') ? error.path.slice(1) : `.${error.path}`;
  const messagePrefix = `${error.path}: `;
  const message = error.message.startsWith(messagePrefix)
    ? error.message.slice(messagePrefix.length)
    : error.message;
  throw new BlueprintParameterError(error.code, `${prefix}${suffix}`, message, error.span);
}

/** Binds every leaf as one transaction and returns only the complete immutable result. */
export function bindBlueprintConfigurationSet(
  setValue: unknown,
  bindingsValue: readonly BlueprintParameterBinding[] = [],
): readonly BoundBlueprintConfiguration[] {
  const registration = inspectBlueprintConfigurationSet(setValue, '$.set');
  const parsedBindings = readBlueprintParameterBindings(registration.session, bindingsValue);
  const allUsed = new Set<object>();
  const entryParameters = registration.entries.map((entry) => {
    const parameters = templateParameters(entry);
    for (const parameter of parameters) allUsed.add(parameter);
    return new Set<object>(parameters);
  });

  for (const binding of parsedBindings) {
    if (allUsed.has(binding.parameter)) continue;
    const parameter = inspectBlueprintParameterHandle(binding.parameter, '$.bindings');
    fail(
      '$.bindings',
      `parameter "${parameter.label}" is not used by this configuration set.`,
      parameter.source,
    );
  }

  const bound: BoundBlueprintConfiguration[] = [];
  for (const [entryIndex, entry] of registration.entries.entries()) {
    const usedParameters = entryParameters[entryIndex]!;
    const entryBindings: BlueprintParameterBinding[] = parsedBindings
      .filter((binding) => usedParameters.has(binding.parameter))
      .map(({ parameter, value }) => ({ parameter, value }));
    try {
      bound.push(bindEntry(entry, entryBindings));
    } catch (error) {
      prefixEntryError(error, entryIndex);
    }
  }

  return Object.freeze(bound);
}

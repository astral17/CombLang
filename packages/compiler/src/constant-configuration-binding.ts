import {
  canonicalizeConstantConfiguration,
  ConstantConfigurationError,
  type ConstantConfiguration,
} from '@comblang/factorio';
import type { SourceSpan } from '@comblang/shared';

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
  inspectConstantConfigurationTemplate,
  type ConstantConfigurationTemplate,
} from './constant-configuration-template.js';

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
): ConstantConfiguration {
  const { session } = inspectConstantConfigurationTemplate(templateValue, '$.template');
  const template = templateValue as ConstantConfigurationTemplate;
  const bindings = readBlueprintParameterBindings(session, bindingsValue);
  const explicit = new Map<object, unknown>();

  for (const binding of bindings) {
    explicit.set(binding.parameter, binding.value);
  }

  const used = new Set<object>();
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

  for (const [sectionIndex, section] of template.sections.entries()) {
    const sectionPath = `$.sections[${sectionIndex}]`;
    const concreteSection: Record<string, unknown> = {
      active: section.active,
      multiplier: resolve(section.multiplier, 'number', `${sectionPath}.multiplier`, 'multiplier'),
      filters: section.filters.map((filter, filterIndex) => {
        const filterPath = `${sectionPath}.filters[${filterIndex}]`;
        return {
          signal: resolve(filter.signal, 'signal', `${filterPath}.signal`, 'signal'),
          value: resolve(filter.value, 'number', `${filterPath}.value`, 'count'),
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

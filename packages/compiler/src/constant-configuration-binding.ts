import {
  canonicalizeConstantConfiguration,
  ConstantConfigurationError,
  constantConfigurationLimits,
  type ConstantConfiguration,
} from '@comblang/factorio';
import type { SourceSpan } from '@comblang/shared';

import {
  assertConstantParameterFromSession,
  ConstantParameterError,
  findConstantParameterHandle,
  inspectConstantParameterHandle,
  type ConstantParameterHandle,
  type ConstantParameterKind,
  type ConstantParameterSession,
  type NumberParameterHandle,
  type SignalParameterHandle,
} from './constant-parameters.js';
import {
  inspectConstantConfigurationTemplate,
  type ConstantConfigurationTemplate,
} from './constant-configuration-template.js';

export interface ConstantParameterBinding {
  readonly parameter: ConstantParameterHandle;
  readonly value: unknown;
}

interface ParsedBinding {
  readonly parameter: ConstantParameterHandle;
  readonly value: unknown;
}

interface SlotSource {
  readonly parameter?: ConstantParameterHandle;
  readonly span?: SourceSpan;
}

function fail(
  path: string,
  message: string,
  span?: SourceSpan,
  code: 'CP1000' | 'CP1001' | 'CP1002' = 'CP1000',
): never {
  throw new ConstantParameterError(code, path, message, span);
}

function readBindingArray(value: unknown): readonly ParsedBinding[] {
  const path = '$.bindings';
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    fail(path, 'expected a plain binding array.');
  }
  if (value.length > constantConfigurationLimits.maxNodes) {
    fail(path, `bindings exceed the node limit of ${constantConfigurationLimits.maxNodes}.`);
  }
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string') fail(path, 'symbol keys are not supported.');
    if (key === 'length') continue;
    if (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= value.length) {
      fail(`${path}.${key}`, 'unknown binding array field.');
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
    if (!('value' in descriptor)) fail(`${path}[${key}]`, 'accessors are not supported.');
    if (!descriptor.enumerable) fail(`${path}[${key}]`, 'non-enumerable fields are not supported.');
  }

  const output: ParsedBinding[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const entryPath = `${path}[${index}]`;
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (descriptor === undefined) fail(entryPath, 'array holes are not supported.');
    const entry = descriptor.value as unknown;
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      fail(entryPath, 'expected a binding record.');
    }
    const prototype = Object.getPrototypeOf(entry);
    if (prototype !== Object.prototype && prototype !== null) {
      fail(entryPath, 'expected a plain binding record.');
    }
    const record = Object.create(null) as Record<string, unknown>;
    for (const key of Reflect.ownKeys(entry)) {
      if (typeof key !== 'string') fail(entryPath, 'symbol keys are not supported.');
      if (key !== 'parameter' && key !== 'value') {
        fail(`${entryPath}.${key}`, 'unknown binding field.');
      }
      const field = Object.getOwnPropertyDescriptor(entry, key)!;
      if (!('value' in field)) fail(`${entryPath}.${key}`, 'accessors are not supported.');
      if (!field.enumerable)
        fail(`${entryPath}.${key}`, 'non-enumerable fields are not supported.');
      record[key] = field.value;
    }
    if (!Object.hasOwn(record, 'parameter'))
      fail(`${entryPath}.parameter`, 'parameter is required.');
    if (!Object.hasOwn(record, 'value')) fail(`${entryPath}.value`, 'value is required.');
    const parameter = record.parameter;
    if (findConstantParameterHandle(parameter) === undefined) {
      fail(
        `${entryPath}.parameter`,
        'value is not a registered parameter handle.',
        undefined,
        'CP1001',
      );
    }
    output.push({ parameter: parameter as ConstantParameterHandle, value: record.value });
  }
  return output;
}

function bindingKindMatches(kind: ConstantParameterKind, value: unknown): boolean {
  if (kind === 'number') return typeof value === 'number' && Number.isFinite(value);
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Resolves one internal symbolic Constant template to a fresh concrete configuration. */
export function bindConstantConfigurationTemplate(
  templateValue: unknown,
  bindingsValue: readonly ConstantParameterBinding[] = [],
): ConstantConfiguration {
  const { session } = inspectConstantConfigurationTemplate(templateValue, '$.template');
  const template = templateValue as ConstantConfigurationTemplate;
  const bindings = readBindingArray(bindingsValue);
  const explicit = new Map<object, unknown>();

  for (const [index, binding] of bindings.entries()) {
    const path = `$.bindings[${index}].parameter`;
    const registration = assertConstantParameterFromSession(session, binding.parameter, path);
    if (explicit.has(binding.parameter)) {
      fail(path, 'duplicate binding for the same parameter handle.', registration.source, 'CP1001');
    }
    explicit.set(binding.parameter, binding.value);
  }

  const used = new Set<object>();
  const slotSources = new Map<string, SlotSource>();
  const concreteSections: Record<string, unknown>[] = [];

  const resolve = (
    value: unknown,
    kind: ConstantParameterKind,
    path: string,
    domain: 'signal' | 'count' | 'multiplier',
  ): unknown => {
    const registration = findConstantParameterHandle(value);
    if (registration === undefined) {
      slotSources.set(path, {});
      return value;
    }
    const owned = assertConstantParameterFromSession(session, value, path);
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
    if (owned.kind === 'number') {
      if (typeof resolved !== 'number' || !Number.isFinite(resolved)) {
        fail(path, 'expected a finite number.', owned.source);
      }
      if (domain === 'count' && !Number.isSafeInteger(resolved)) {
        fail(path, 'filter counts must be safe integers.', owned.source);
      }
    } else if (!bindingKindMatches('signal', resolved)) {
      fail(path, 'expected a SignalId record.', owned.source);
    }
    slotSources.set(path, {
      parameter: value as ConstantParameterHandle,
      ...(owned.source === undefined ? {} : { span: owned.source }),
    });
    return resolved;
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
      const registration = inspectConstantParameterHandle(parameter, '$.bindings');
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

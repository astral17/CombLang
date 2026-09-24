import {
  canonicalizeConstantConfiguration,
  ConstantConfigurationError,
  constantConfigurationLimits,
  type ConstantConfiguration,
  type SignalId,
} from '@comblang/factorio';
import type { SourceSpan } from '@comblang/shared';

import {
  assertBlueprintParameterFromSession,
  assertBlueprintParameterSession,
  BlueprintParameterError,
  findBlueprintParameterHandle,
  type BlueprintParameterHandle,
  type BlueprintParameterKind,
  type BlueprintParameterRegistration,
  type BlueprintParameterSession,
} from './blueprint-parameters.js';

export interface BlueprintParameterDataBudget {
  readonly active: WeakSet<object>;
  nodes: number;
}

export interface OpenBlueprintParameterRecord {
  readonly value: Record<string, unknown>;
  readonly release: () => void;
}

export interface OpenBlueprintParameterArray {
  readonly value: readonly unknown[];
  readonly release: () => void;
}

export interface BlueprintParameterSlot {
  readonly handle: BlueprintParameterHandle;
  readonly registration: BlueprintParameterRegistration;
}

export interface ParsedBlueprintParameterBinding {
  readonly parameter: BlueprintParameterHandle;
  readonly value: unknown;
  readonly registration: BlueprintParameterRegistration;
}

export interface BlueprintParameterBinding {
  readonly parameter: BlueprintParameterHandle;
  readonly value: unknown;
}

export type BlueprintNumberDomain = 'finite' | 'safe-integer';

export function createBlueprintParameterDataBudget(): BlueprintParameterDataBudget {
  return { active: new WeakSet(), nodes: 0 };
}

function fail(code: 'CP1000' | 'CP1001', path: string, message: string, span?: SourceSpan): never {
  throw new BlueprintParameterError(code, path, message, span);
}

function enterContainer(
  value: object,
  path: string,
  depth: number,
  budget: BlueprintParameterDataBudget,
): () => void {
  if (depth > constantConfigurationLimits.maxDepth) {
    fail(
      'CP1000',
      path,
      `data exceeds the depth limit of ${constantConfigurationLimits.maxDepth}.`,
    );
  }
  budget.nodes += 1;
  if (budget.nodes > constantConfigurationLimits.maxNodes) {
    fail('CP1000', path, `data exceeds the node limit of ${constantConfigurationLimits.maxNodes}.`);
  }
  if (budget.active.has(value)) fail('CP1000', path, 'cyclic data is not supported.');
  budget.active.add(value);
  return () => budget.active.delete(value);
}

export function openBlueprintParameterRecord(
  value: unknown,
  path: string,
  depth: number,
  budget: BlueprintParameterDataBudget,
): OpenBlueprintParameterRecord {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    fail('CP1000', path, 'expected a plain data record.');
  }
  const release = enterContainer(value, path, depth, budget);
  try {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      fail('CP1000', path, 'expected a plain object or null-prototype record.');
    }
    const record = Object.create(null) as Record<string, unknown>;
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== 'string') fail('CP1000', path, 'symbol keys are not supported.');
      const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
      if (!('value' in descriptor))
        fail('CP1000', `${path}.${key}`, 'accessors are not supported.');
      if (!descriptor.enumerable) {
        fail('CP1000', `${path}.${key}`, 'non-enumerable fields are not supported.');
      }
      record[key] = descriptor.value;
    }
    return { value: record, release };
  } catch (error) {
    release();
    throw error;
  }
}

export function openBlueprintParameterArray(
  value: unknown,
  path: string,
  depth: number,
  budget: BlueprintParameterDataBudget,
): OpenBlueprintParameterArray {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    fail('CP1000', path, 'expected a plain array.');
  }
  if (value.length > constantConfigurationLimits.maxNodes - budget.nodes) {
    fail('CP1000', path, `data exceeds the node limit of ${constantConfigurationLimits.maxNodes}.`);
  }
  const release = enterContainer(value, path, depth, budget);
  try {
    const values: unknown[] = [];
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== 'string') fail('CP1000', path, 'symbol keys are not supported.');
      if (key === 'length') continue;
      if (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= value.length) {
        fail('CP1000', `${path}.${key}`, 'unknown array field.');
      }
      const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
      if (!('value' in descriptor)) {
        fail('CP1000', `${path}[${key}]`, 'accessors are not supported.');
      }
      if (!descriptor.enumerable) {
        fail('CP1000', `${path}[${key}]`, 'non-enumerable values are not supported.');
      }
    }
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (descriptor === undefined)
        fail('CP1000', `${path}[${index}]`, 'array holes are not supported.');
      if (!('value' in descriptor)) {
        fail('CP1000', `${path}[${index}]`, 'accessors are not supported.');
      }
      values.push(descriptor.value);
    }
    return { value: values, release };
  } catch (error) {
    release();
    throw error;
  }
}

export function assertBlueprintParameterExactKeys(
  record: Record<string, unknown>,
  keys: readonly string[],
  path: string,
  message = 'unknown field.',
): void {
  const allowed = new Set(keys);
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) fail('CP1000', `${path}.${key}`, message);
  }
}

export function isBlueprintParameterShaped(value: unknown): boolean {
  if (value === null || (typeof value !== 'object' && typeof value !== 'function')) return false;
  const descriptor = Object.getOwnPropertyDescriptor(value, 'kind');
  return (
    descriptor !== undefined &&
    'value' in descriptor &&
    (descriptor.value === 'number' || descriptor.value === 'signal')
  );
}

export function lookupBlueprintParameterSlot(
  value: unknown,
  kind: BlueprintParameterKind,
  session: BlueprintParameterSession,
  path: string,
): BlueprintParameterSlot | undefined {
  const registration = findBlueprintParameterHandle(value);
  if (registration === undefined) {
    if (isBlueprintParameterShaped(value)) {
      fail('CP1001', path, 'unregistered parameter-like object.');
    }
    return undefined;
  }
  const owned = assertBlueprintParameterFromSession(session, value, path);
  if (owned.kind !== kind) {
    fail('CP1001', path, `expected a ${kind} parameter, received ${owned.kind}.`, owned.source);
  }
  return { handle: value as BlueprintParameterHandle, registration: owned };
}

export function readBlueprintParameterBindings(
  session: BlueprintParameterSession,
  value: unknown,
): readonly ParsedBlueprintParameterBinding[] {
  assertBlueprintParameterSession(session, '$.session');
  const path = '$.bindings';
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    fail('CP1000', path, 'expected a plain binding array.');
  }
  if (value.length > constantConfigurationLimits.maxNodes) {
    fail(
      'CP1000',
      path,
      `bindings exceed the node limit of ${constantConfigurationLimits.maxNodes}.`,
    );
  }
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string') fail('CP1000', path, 'symbol keys are not supported.');
    if (key === 'length') continue;
    if (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= value.length) {
      fail('CP1000', `${path}.${key}`, 'unknown binding array field.');
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
    if (!('value' in descriptor)) fail('CP1000', `${path}[${key}]`, 'accessors are not supported.');
    if (!descriptor.enumerable) {
      fail('CP1000', `${path}[${key}]`, 'non-enumerable fields are not supported.');
    }
  }

  const output: ParsedBlueprintParameterBinding[] = [];
  const seen = new Set<object>();
  for (let index = 0; index < value.length; index += 1) {
    const entryPath = `${path}[${index}]`;
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (descriptor === undefined) fail('CP1000', entryPath, 'array holes are not supported.');
    const entry = descriptor.value as unknown;
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      fail('CP1000', entryPath, 'expected a binding record.');
    }
    const prototype = Object.getPrototypeOf(entry);
    if (prototype !== Object.prototype && prototype !== null) {
      fail('CP1000', entryPath, 'expected a plain binding record.');
    }
    const record = Object.create(null) as Record<string, unknown>;
    for (const key of Reflect.ownKeys(entry)) {
      if (typeof key !== 'string') fail('CP1000', entryPath, 'symbol keys are not supported.');
      if (key !== 'parameter' && key !== 'value') {
        fail('CP1000', `${entryPath}.${key}`, 'unknown binding field.');
      }
      const field = Object.getOwnPropertyDescriptor(entry, key)!;
      if (!('value' in field)) {
        fail('CP1000', `${entryPath}.${key}`, 'accessors are not supported.');
      }
      if (!field.enumerable) {
        fail('CP1000', `${entryPath}.${key}`, 'non-enumerable fields are not supported.');
      }
      record[key] = field.value;
    }
    if (!Object.hasOwn(record, 'parameter')) {
      fail('CP1000', `${entryPath}.parameter`, 'parameter is required.');
    }
    if (!Object.hasOwn(record, 'value')) fail('CP1000', `${entryPath}.value`, 'value is required.');
    const parameter = record.parameter;
    const registration = findBlueprintParameterHandle(parameter);
    if (registration === undefined) {
      fail('CP1001', `${entryPath}.parameter`, 'value is not a registered parameter handle.');
    }
    const owned = assertBlueprintParameterFromSession(session, parameter, `${entryPath}.parameter`);
    if (seen.has(parameter as object)) {
      fail(
        'CP1001',
        `${entryPath}.parameter`,
        'duplicate binding for the same parameter handle.',
        owned.source,
      );
    }
    seen.add(parameter as object);
    output.push({
      parameter: parameter as BlueprintParameterHandle,
      value: record.value,
      registration: owned,
    });
  }
  return output;
}

export function assertBlueprintParameterNumberValue(
  value: unknown,
  path: string,
  domain: BlueprintNumberDomain,
  span?: SourceSpan,
  safeIntegerMessage = 'expected a safe integer.',
): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    fail('CP1000', path, 'expected a finite number.', span);
  }
  if (domain === 'safe-integer' && !Number.isSafeInteger(value)) {
    fail('CP1000', path, safeIntegerMessage, span);
  }
  return value;
}

export function canonicalizeBlueprintParameterSignal(
  value: unknown,
  path: string,
  span?: SourceSpan,
): SignalId {
  const signalPath = `${path}.__validation.sections[0].filters[0].signal`;
  try {
    const canonical: ConstantConfiguration = canonicalizeConstantConfiguration(
      { sections: [{ filters: [{ signal: value, value: 0 }] }] },
      undefined,
      `${path}.__validation`,
    );
    return canonical.sections[0]!.filters[0]!.signal;
  } catch (error) {
    if (error instanceof ConstantConfigurationError) {
      const reportedPath = error.path.startsWith(signalPath)
        ? `${path}${error.path.slice(signalPath.length)}`
        : path;
      fail('CP1000', reportedPath, error.detail, span);
    }
    fail('CP1000', path, error instanceof Error ? error.message : 'invalid SignalId.', span);
  }
}

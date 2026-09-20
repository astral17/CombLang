import { circuitConstant, parseSignalRef, type SignalId } from '@comblang/factorio';

import type { SignalValue } from './elaboration-values.js';

const MAX_SOURCE_DEPTH = 32;

export interface SignalCountEntry {
  readonly signal: SignalId;
  readonly value: number;
  readonly sourcePath: string;
  readonly ordinal: number;
}

export interface SignalValueSourceContext {
  isSignal(value: unknown): value is SignalId;
  isSignalValue(value: unknown): value is SignalValue;
}

export class SignalValueSourceError extends TypeError {
  constructor(
    readonly path: string,
    message: string,
  ) {
    super(`${path}: ${message}`);
    this.name = 'SignalValueSourceError';
  }
}

function fail(path: string, message: string): never {
  throw new SignalValueSourceError(path, message);
}

function count(value: unknown, path: string): number {
  if (typeof value !== 'number') fail(path, 'expected a finite safe-integer signal count.');
  try {
    return circuitConstant(value);
  } catch (error) {
    fail(path, error instanceof Error ? error.message : String(error));
  }
}

function signalKey(value: unknown, path: string, context: SignalValueSourceContext): SignalId {
  if (context.isSignal(value)) return value;
  if (typeof value !== 'string') fail(path, 'expected a Signal or string signal key.');
  try {
    return parseSignalRef(value);
  } catch (error) {
    fail(path, error instanceof Error ? error.message : String(error));
  }
}

function isPlainObject(value: object): boolean {
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertDataArray(value: unknown, path: string): asserts value is readonly unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    fail(path, 'expected a plain array.');
  }
  const length = Object.getOwnPropertyDescriptor(value, 'length')?.value;
  if (typeof length !== 'number' || !Number.isSafeInteger(length) || length < 0) {
    fail(`${path}.length`, 'array length must be a non-negative safe integer.');
  }
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string')
      fail(`${path}[${String(key)}]`, 'enumerable symbol keys are not supported.');
    if (key === 'length') continue;
    if (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= length) {
      fail(`${path}.${key}`, 'unknown array field.');
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !('value' in descriptor)) {
      fail(`${path}[${key}]`, 'accessors are not supported.');
    }
  }
  for (let index = 0; index < length; index += 1) {
    if (Object.getOwnPropertyDescriptor(value, String(index)) === undefined) {
      fail(`${path}[${index}]`, 'array holes are not supported.');
    }
  }
}

function dataObjectKeys(value: object, path: string): readonly string[] {
  const keys: string[] = [];
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string')
      fail(`${path}[${String(key)}]`, 'enumerable symbol keys are not supported.');
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !('value' in descriptor)) {
      fail(`${path}.${key}`, 'accessors are not supported.');
    }
    if (descriptor.enumerable) keys.push(key);
  }
  return keys;
}

/** Normalizes CC source values without sorting, merging, or dropping zero rows. */
export function normalizeSignalValueSources(
  sources: readonly unknown[],
  context: SignalValueSourceContext,
  sourcePath = 'args',
): readonly SignalCountEntry[] {
  const entries: SignalCountEntry[] = [];
  const active = new Set<object>();

  const append = (signal: SignalId, value: unknown, sourcePath: string) => {
    entries.push(
      Object.freeze({
        signal,
        value: count(value, `${sourcePath}.value`),
        sourcePath,
        ordinal: entries.length,
      }),
    );
  };

  const appendNormalized = (signal: SignalId, value: number, sourcePath: string) => {
    entries.push(
      Object.freeze({
        signal,
        value,
        sourcePath,
        ordinal: entries.length,
      }),
    );
  };

  const visit = (value: unknown, path: string, depth: number): void => {
    if (depth > MAX_SOURCE_DEPTH) fail(path, `source nesting exceeds ${MAX_SOURCE_DEPTH} levels.`);
    if (context.isSignalValue(value)) {
      // SignalValue is created only by the numericCount * Signal operator, which
      // already performs the shared constant-boundary conversion at its narrower
      // source span. Do not normalize it a second time here.
      appendNormalized(value.signal, value.value, path);
      return;
    }
    if (Array.isArray(value)) {
      assertDataArray(value, path);
      const tupleCandidate =
        value.length === 2 && (context.isSignal(value[0]) || typeof value[0] === 'string');
      if (tupleCandidate) {
        append(signalKey(value[0], `${path}[0]`, context), value[1], path);
        return;
      }
      if (active.has(value)) fail(path, 'cyclic signal-value source.');
      active.add(value);
      try {
        value.forEach((item, index) => visit(item, `${path}[${index}]`, depth + 1));
      } finally {
        active.delete(value);
      }
      return;
    }
    if (value instanceof Map) {
      let index = 0;
      for (const [key, item] of value) {
        const entryPath = `${path}.map[${index}]`;
        append(signalKey(key, `${entryPath}.key`, context), item, entryPath);
        index += 1;
      }
      return;
    }
    if (typeof value === 'object' && value !== null && isPlainObject(value)) {
      for (const key of dataObjectKeys(value, path)) {
        const entryPath = `${path}.object[${JSON.stringify(key)}]`;
        append(
          signalKey(key, `${entryPath}.key`, context),
          (value as Record<string, unknown>)[key],
          entryPath,
        );
      }
      return;
    }
    fail(path, 'expected a typed signal count, tuple, array, Map, or plain object.');
  };

  sources.forEach((source, index) => visit(source, `${sourcePath}[${index}]`, 0));
  return Object.freeze(entries);
}

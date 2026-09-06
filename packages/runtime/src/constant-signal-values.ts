import { circuitConstant, parseSignalPropertyKey, Signal, type SignalId } from '@comblang/factorio';

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
  if (!value.startsWith('signal:')) return Signal(value);
  try {
    return parseSignalPropertyKey(value);
  } catch (error) {
    fail(path, error instanceof Error ? error.message : String(error));
  }
}

function isPlainObject(value: object): boolean {
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** Normalizes CC source values without sorting, merging, or dropping zero rows. */
export function normalizeSignalValueSources(
  sources: readonly unknown[],
  context: SignalValueSourceContext,
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
      const symbols = Object.getOwnPropertySymbols(value).filter(
        (key) => Object.getOwnPropertyDescriptor(value, key)?.enumerable === true,
      );
      if (symbols.length !== 0) fail(path, 'enumerable symbol keys are not supported.');
      for (const key of Object.keys(value)) {
        const entryPath = `${path}.object[${JSON.stringify(key)}]`;
        append(signalKey(key, `${entryPath}.key`, context), Reflect.get(value, key), entryPath);
      }
      return;
    }
    fail(path, 'expected a typed signal count, tuple, array, Map, or plain object.');
  };

  sources.forEach((source, index) => visit(source, `args[${index}]`, 0));
  return Object.freeze(entries);
}

import { formatSignalRef, Signal, type SignalId } from '@comblang/factorio';
import { describe, expect, test } from 'vitest';

import {
  normalizeSignalValueSources,
  SignalValueSourceError,
  type SignalValueSourceContext,
} from './constant-signal-values.js';
import type { SignalValue } from './elaboration-values.js';

function fixture() {
  const a = Signal('virtual', 'signal-A');
  const sameA = Signal('virtual', 'signal-A');
  const b = Signal('virtual', 'signal-B', 'legendary');
  const handles = new Set<SignalId>([a, sameA, b]);
  const context: SignalValueSourceContext = {
    isSignal: (value): value is SignalId =>
      typeof value === 'object' && value !== null && handles.has(value as SignalId),
    isSignalValue: (value): value is SignalValue =>
      typeof value === 'object' && value !== null && (value as SignalValue).kind === 'signal-value',
  };
  const typed = (signal: SignalId, value: number): SignalValue => ({
    kind: 'signal-value',
    signal,
    value,
  });
  return { a, sameA, b, context, typed };
}

describe('constant signal-value sources', () => {
  test('preserves source order, duplicate signals, zeros, paths, and ordinals', () => {
    const { a, sameA, b, context, typed } = fixture();
    const object = {
      [formatSignalRef(b)]: 8,
      'copper-plate': 0,
    };

    const entries = normalizeSignalValueSources(
      [
        typed(a, 1),
        [a, 2],
        [[sameA, 3], [[b, 4]]],
        new Map<SignalId | string, number>([
          [a, 5],
          [sameA, 6],
          ['iron-plate', 7],
        ]),
        object,
      ],
      context,
    );

    expect(
      entries.map(({ signal, value }) => [signal.type, signal.name, signal.quality, value]),
    ).toEqual([
      ['virtual', 'signal-A', undefined, 1],
      ['virtual', 'signal-A', undefined, 2],
      ['virtual', 'signal-A', undefined, 3],
      ['virtual', 'signal-B', 'legendary', 4],
      ['virtual', 'signal-A', undefined, 5],
      ['virtual', 'signal-A', undefined, 6],
      ['item', 'iron-plate', undefined, 7],
      ['virtual', 'signal-B', 'legendary', 8],
      ['item', 'copper-plate', undefined, 0],
    ]);
    expect(entries.map(({ ordinal }) => ordinal)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
    expect(entries.map(({ sourcePath }) => sourcePath)).toEqual([
      'args[0]',
      'args[1]',
      'args[2][0]',
      'args[2][1][0]',
      'args[3].map[0]',
      'args[3].map[1]',
      'args[3].map[2]',
      `args[4].object[${JSON.stringify(formatSignalRef(b))}]`,
      'args[4].object["copper-plate"]',
    ]);
    expect(Object.isFrozen(entries)).toBe(true);
    expect(entries.every(Object.isFrozen)).toBe(true);
  });

  test('applies the integer boundary to raw counts without dropping zero', () => {
    const { a, context } = fixture();
    expect(
      normalizeSignalValueSources(
        [
          [a, 4_294_967_295],
          [a, 0],
        ],
        context,
      ),
    ).toMatchObject([{ value: -1 }, { value: 0 }]);
  });

  test('parses shorthand and explicit SignalRef spellings at tuple, Map, and object boundaries', () => {
    const { context } = fixture();
    const entries = normalizeSignalValueSources(
      [
        ['iron-plate', 1],
        new Map([
          ['virtual/signal-A', 2],
          ['item/iron-plate/normal', 3],
        ]),
        { 'virtual/signal-B/legendary': 4 },
      ],
      context,
    );

    expect(entries.map(({ signal, value }) => [signal, value])).toEqual([
      [Signal('item', 'iron-plate'), 1],
      [Signal('virtual', 'signal-A'), 2],
      [Signal('item', 'iron-plate'), 3],
      [Signal('virtual', 'signal-B', 'legendary'), 4],
    ]);
  });

  test('uses ordinary object overwrite semantics and Map identity semantics', () => {
    const { a, sameA, context } = fixture();
    const object: Record<string, number> = {};
    object['iron-plate'] = 1;
    object['iron-plate'] = 2;
    const entries = normalizeSignalValueSources(
      [
        object,
        new Map<SignalId, number>([
          [a, 3],
          [sameA, 4],
        ]),
      ],
      context,
    );
    expect(entries.map(({ value }) => value)).toEqual([2, 3, 4]);
  });

  test.each([
    ['invalid tuple count', (a: SignalId) => [a, 1.5], 'args[0].value'],
    ['malformed SignalRef', () => ({ 'virtual/%2f': 1 }), 'args[0].object["virtual/%2f"].key'],
    ['arbitrary iterable', () => new Set([[Signal('item', 'iron-plate'), 1]]), 'args[0]'],
    ['non-plain object', () => new Date(0), 'args[0]'],
  ])('rejects %s with its structural path', (_name, makeValue, path) => {
    const { a, context } = fixture();
    expect(() => normalizeSignalValueSources([makeValue(a)], context)).toThrowError(
      expect.objectContaining<Partial<SignalValueSourceError>>({ path }),
    );
  });

  test('rejects enumerable symbols, cyclic arrays, and excessive nesting', () => {
    const { context } = fixture();
    const symbolObject = { 'iron-plate': 1, [Symbol('hidden-loss')]: 2 };
    const cyclic: unknown[] = [];
    cyclic.push(cyclic);
    let deep: unknown = ['iron-plate', 1];
    for (let index = 0; index < 34; index += 1) deep = [deep];

    expect(() => normalizeSignalValueSources([symbolObject], context)).toThrowError(
      /enumerable symbol keys/,
    );
    expect(() => normalizeSignalValueSources([cyclic], context)).toThrowError(/cyclic/);
    expect(() => normalizeSignalValueSources([deep], context)).toThrowError(/exceeds 32 levels/);
  });
});

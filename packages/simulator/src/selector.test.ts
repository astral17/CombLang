import { signal, SparseBus } from '@comblang/factorio';
import { describe, expect, it } from 'vitest';

import { evaluateSelector, type SelectorCombinatorConfig } from './selector.js';
import type { CircuitInput } from './circuit-input.js';

const red = signal('virtual', 'signal-red');
const green = signal('virtual', 'signal-green');
const blue = signal('virtual', 'signal-blue');
const index = signal('virtual', 'signal-index');
const output = signal('virtual', 'signal-output');

function input(redValues: Iterable<readonly [typeof red, number]> = []): CircuitInput {
  return { red: new SparseBus(redValues), green: new SparseBus() };
}

describe('Selector simulator model', () => {
  it('aggregates both wire colors and orders select rows deterministically', () => {
    const values: CircuitInput = {
      red: new SparseBus([
        [red, 4],
        [green, 2],
        [blue, 1],
      ]),
      green: new SparseBus([
        [red, -1],
        [green, 1],
        [signal('virtual', 'signal-yellow'), 5],
      ]),
    };

    expect(evaluateSelector({ operation: 'select', index: 2 }, values).toJSON()).toEqual([
      { signal: red, value: 3 },
    ]);
    expect(evaluateSelector({ operation: 'select', selectMax: false }, values).toJSON()).toEqual([
      { signal: blue, value: 1 },
    ]);
  });

  it('uses canonical Signal ordering as the tie-breaker', () => {
    const first = signal('virtual', 'signal-A');
    const second = signal('virtual', 'signal-B');

    expect(
      evaluateSelector(
        { operation: 'select', index: 0 },
        input([
          [second, 4],
          [first, 4],
        ]),
      ).toJSON(),
    ).toEqual([{ signal: first, value: 4 }]);
  });

  it('canonicalizes safe integer constants to int32 and reads Signal indexes from the pair', () => {
    const values: CircuitInput = {
      red: new SparseBus([
        [index, 1],
        [red, 4],
      ]),
      green: new SparseBus([
        [index, 1],
        [green, 3],
      ]),
    };

    expect(
      evaluateSelector(
        { operation: 'select', index: { type: 'virtual', name: 'signal-index' } },
        values,
      ).toJSON(),
    ).toEqual([{ signal: index, value: 2 }]);
    expect(
      evaluateSelector({ operation: 'select', index: 4_294_967_298 }, values).toJSON(),
    ).toEqual([{ signal: index, value: 2 }]);
  });

  it('counts distinct non-zero combined input Signals on the configured output', () => {
    expect(
      evaluateSelector(
        { operation: 'count', output },
        {
          red: new SparseBus([
            [red, 2],
            [green, 1],
          ]),
          green: new SparseBus([
            [green, -1],
            [blue, 3],
          ]),
        },
      ).toJSON(),
    ).toEqual([{ signal: output, value: 2 }]);
  });

  it.each([
    ['negative', -1],
    ['out of range', 99],
  ])('emits an empty bus for a %s index', (_label, indexValue) => {
    expect(
      evaluateSelector({ operation: 'select', index: indexValue }, input([[red, 4]])).toJSON(),
    ).toEqual([]);
  });

  it('emits an empty bus for empty select input and zero count', () => {
    expect(evaluateSelector({ operation: 'select' }, input()).toJSON()).toEqual([]);
    expect(evaluateSelector({ operation: 'count', output }, input()).toJSON()).toEqual([]);
  });

  it('rejects non-safe integer select constants', () => {
    for (const indexValue of [1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      const config: SelectorCombinatorConfig = { operation: 'select', index: indexValue };
      expect(() => evaluateSelector(config, input([[red, 4]]))).toThrow(
        'Circuit values must be safe integers before int32 normalization.',
      );
    }
  });
});

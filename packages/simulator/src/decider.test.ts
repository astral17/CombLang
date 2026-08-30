import { signal, SparseBus } from '@comblang/factorio';
import { describe, expect, it } from 'vitest';

import { singleWireInput } from './circuit-input.js';
import { evaluateDecider, type DeciderCondition } from './decider.js';

const a = signal('virtual', 'signal-A');
const b = signal('virtual', 'signal-B');
const c = signal('virtual', 'signal-C');
const out = signal('virtual', 'signal-Z');

const eachPositive: DeciderCondition = {
  kind: 'compare',
  left: { kind: 'wildcard', value: 'each' },
  comparator: '>',
  right: { kind: 'constant', value: 0 },
};

describe('decider combinator semantics', () => {
  it('treats Everything as vacuously true and Anything as false on an empty bus', () => {
    const constantOutput = [
      { mode: 'constant' as const, signal: { kind: 'signal' as const, signal: out }, value: 1 },
    ];
    expect(
      evaluateDecider(
        {
          condition: {
            kind: 'compare',
            left: { kind: 'wildcard', value: 'everything' },
            comparator: '>',
            right: { kind: 'constant', value: 0 },
          },
          outputs: constantOutput,
        },
        singleWireInput(new SparseBus()),
      ).get(out),
    ).toBe(1);
    expect(
      evaluateDecider(
        {
          condition: {
            kind: 'compare',
            left: { kind: 'wildcard', value: 'anything' },
            comparator: '>',
            right: { kind: 'constant', value: 0 },
          },
          outputs: constantOutput,
        },
        singleWireInput(new SparseBus()),
      ).get(out),
    ).toBe(0);
  });

  it('excludes a concrete right operand from Anything and Everything candidates', () => {
    const input = new SparseBus([
      [a, 10],
      [b, 5],
    ]);
    const result = evaluateDecider(
      {
        condition: {
          kind: 'compare',
          left: { kind: 'wildcard', value: 'anything' },
          comparator: '>=',
          right: { kind: 'signal', signal: a },
        },
        outputs: [{ mode: 'constant', signal: { kind: 'signal', signal: out }, value: 1 }],
        elseOutputs: [{ mode: 'constant', signal: { kind: 'signal', signal: out }, value: -1 }],
      },
      singleWireInput(input),
    );
    expect(result.get(out)).toBe(-1);
  });

  it('copies passing Each signals and routes failing signals through else outputs', () => {
    const result = evaluateDecider(
      {
        condition: eachPositive,
        outputs: [{ mode: 'copy', signal: { kind: 'wildcard', value: 'each' } }],
        elseOutputs: [{ mode: 'constant', signal: { kind: 'signal', signal: out }, value: 2 }],
      },
      singleWireInput(
        new SparseBus([
          [a, 4],
          [b, -3],
          [c, 8],
        ]),
      ),
    );
    expect(result.get(a)).toBe(4);
    expect(result.get(c)).toBe(8);
    expect(result.get(out)).toBe(2);
  });

  it('sums passing Each counts into a specific signal', () => {
    const result = evaluateDecider(
      {
        condition: eachPositive,
        outputs: [{ mode: 'copy', signal: { kind: 'signal', signal: out } }],
      },
      singleWireInput(
        new SparseBus([
          [a, 4],
          [b, -3],
          [c, 8],
        ]),
      ),
    );
    expect(result.get(out)).toBe(12);
  });

  it('uses injectable signal precedence for Anything output', () => {
    const result = evaluateDecider(
      {
        condition: eachPositive,
        outputs: [{ mode: 'copy', signal: { kind: 'wildcard', value: 'anything' } }],
        compareSignals: (left, right) =>
          left.name === 'signal-C' ? -1 : right.name === 'signal-C' ? 1 : 0,
      },
      singleWireInput(
        new SparseBus([
          [a, 4],
          [c, 8],
        ]),
      ),
    );
    expect(result.toJSON()).toEqual([{ signal: c, value: 8 }]);
  });

  it('uses separate condition and output network masks', () => {
    const result = evaluateDecider(
      {
        condition: {
          kind: 'compare',
          left: {
            kind: 'signal',
            signal: a,
            networks: { red: true, green: false },
          },
          comparator: '>',
          right: { kind: 'constant', value: 0 },
        },
        outputs: [
          {
            mode: 'copy',
            signal: { kind: 'signal', signal: b },
            networks: { red: false, green: true },
          },
        ],
      },
      {
        red: new SparseBus([[a, 1]]),
        green: new SparseBus([[b, 42]]),
      },
    );
    expect(result.get(b)).toBe(42);
  });

  it('builds the Each candidate set from every Each operand mask', () => {
    const result = evaluateDecider(
      {
        condition: {
          kind: 'and',
          conditions: [
            {
              kind: 'compare',
              left: {
                kind: 'wildcard',
                value: 'each',
                networks: { red: true, green: false },
              },
              comparator: '=',
              right: { kind: 'constant', value: 0 },
            },
            {
              kind: 'compare',
              left: {
                kind: 'wildcard',
                value: 'each',
                networks: { red: false, green: true },
              },
              comparator: '!=',
              right: { kind: 'constant', value: 0 },
            },
          ],
        },
        outputs: [
          {
            mode: 'copy',
            signal: { kind: 'wildcard', value: 'each' },
            networks: { red: false, green: true },
          },
        ],
      },
      {
        red: new SparseBus([[a, 5]]),
        green: new SparseBus([[b, 7]]),
      },
    );
    expect(result.toJSON()).toEqual([{ signal: b, value: 7 }]);
  });
});

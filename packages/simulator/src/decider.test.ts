import { signal, SparseBus } from '@comblang/factorio';
import { describe, expect, it } from 'vitest';

import { singleWireInput } from './circuit-input.js';
import { evaluateDecider, type DeciderCondition } from './decider.js';

const a = signal('virtual', 'signal-A');
const b = signal('virtual', 'signal-B');
const c = signal('virtual', 'signal-C');
const out = signal('virtual', 'signal-Z');
const rareIron = signal('item', 'iron-plate', 'rare');
const uncommonWater = signal('fluid', 'water', 'uncommon');

const eachPositive: DeciderCondition = {
  kind: 'compare',
  left: { kind: 'wildcard', value: 'each' },
  comparator: '>',
  right: { kind: 'constant', value: 0 },
};

const eachNonzero: DeciderCondition = {
  kind: 'compare',
  left: { kind: 'wildcard', value: 'each' },
  comparator: '!=',
  right: { kind: 'constant', value: 0 },
};

describe('decider combinator semantics', () => {
  it('emits Everything constant rows only for selected input candidates and adds copy rows', () => {
    const result = evaluateDecider(
      {
        condition: {
          kind: 'compare',
          left: { kind: 'wildcard', value: 'everything' },
          comparator: '>',
          right: { kind: 'constant', value: -(2 ** 31) },
        },
        outputs: [
          { mode: 'constant', signal: { kind: 'wildcard', value: 'everything' }, value: 7 },
          { mode: 'copy', signal: { kind: 'wildcard', value: 'everything' } },
        ],
      },
      {
        red: new SparseBus([
          [rareIron, 2],
          [a, 5],
        ]),
        green: new SparseBus([
          [a, -5],
          [uncommonWater, -4],
        ]),
      },
    );

    expect(result.toJSON()).toEqual([
      { signal: uncommonWater, value: 3 },
      { signal: rareIron, value: 9 },
    ]);
    expect(result.get(a)).toBe(0);
  });

  it('does not invent Everything candidates on empty input and keeps zero sparse', () => {
    const result = evaluateDecider(
      {
        condition: {
          kind: 'compare',
          left: { kind: 'wildcard', value: 'everything' },
          comparator: '>',
          right: { kind: 'constant', value: 0 },
        },
        outputs: [
          { mode: 'constant', signal: { kind: 'wildcard', value: 'everything' }, value: 0 },
        ],
      },
      singleWireInput(new SparseBus()),
    );
    expect(result.entries()).toEqual([]);

    const zero = evaluateDecider(
      {
        condition: {
          kind: 'compare',
          left: { kind: 'wildcard', value: 'everything' },
          comparator: '>',
          right: { kind: 'constant', value: 0 },
        },
        outputs: [
          { mode: 'constant', signal: { kind: 'wildcard', value: 'everything' }, value: 0 },
        ],
      },
      singleWireInput(new SparseBus([[a, 1]])),
    );
    expect(zero.entries()).toEqual([]);
  });

  it('adds ordered duplicate Everything constant rows with int32 wrap and cancellation', () => {
    const input = singleWireInput(new SparseBus([[a, 1]]));
    const run = (values: readonly number[]) =>
      evaluateDecider(
        {
          condition: {
            kind: 'compare',
            left: { kind: 'wildcard', value: 'everything' },
            comparator: '>',
            right: { kind: 'constant', value: 0 },
          },
          outputs: values.map((value) => ({
            mode: 'constant' as const,
            signal: { kind: 'wildcard' as const, value: 'everything' as const },
            value,
          })),
        },
        input,
      );

    expect(run([7, -3]).get(a)).toBe(4);
    expect(run([2 ** 31]).get(a)).toBe(-(2 ** 31));
    expect(run([7, -7]).entries()).toEqual([]);
  });

  it('emits one Anything constant for a candidate, including quality-bearing signals', () => {
    const candidates = [a, rareIron, uncommonWater] as const;
    const result = evaluateDecider(
      {
        condition: {
          kind: 'compare',
          left: { kind: 'signal', signal: a },
          comparator: '>',
          right: { kind: 'constant', value: 0 },
        },
        outputs: [{ mode: 'constant', signal: { kind: 'wildcard', value: 'anything' }, value: 7 }],
      },
      singleWireInput(
        new SparseBus([
          [a, 2],
          [rareIron, 4],
          [uncommonWater, 6],
        ]),
      ),
    );

    const entries = result.entries();
    expect(entries).toHaveLength(1);
    expect(candidates).toContain(entries[0]![0]);
    expect(entries[0]![1]).toBe(7);
  });

  it('does not invent Anything candidates on empty input and keeps zero sparse', () => {
    const config = {
      condition: {
        kind: 'compare' as const,
        left: { kind: 'signal' as const, signal: a },
        comparator: '>' as const,
        right: { kind: 'constant' as const, value: 0 },
      },
      outputs: [
        {
          mode: 'constant' as const,
          signal: { kind: 'wildcard' as const, value: 'anything' as const },
          value: 7,
        },
      ],
    };
    expect(evaluateDecider(config, singleWireInput(new SparseBus())).entries()).toEqual([]);

    const zero = evaluateDecider(
      {
        ...config,
        outputs: [
          {
            mode: 'constant',
            signal: { kind: 'wildcard', value: 'anything' },
            value: 0,
          },
        ],
      },
      singleWireInput(new SparseBus([[a, 1]])),
    );
    expect(zero.entries()).toEqual([]);
  });

  it('adds duplicate Anything constant and copy rows and wraps the constant count', () => {
    const input = singleWireInput(new SparseBus([[a, 5]]));
    const duplicateRows = evaluateDecider(
      {
        condition: {
          kind: 'compare',
          left: { kind: 'signal', signal: a },
          comparator: '>',
          right: { kind: 'constant', value: 0 },
        },
        outputs: [
          { mode: 'constant', signal: { kind: 'wildcard', value: 'anything' }, value: 3 },
          { mode: 'constant', signal: { kind: 'wildcard', value: 'anything' }, value: 2 },
          { mode: 'copy', signal: { kind: 'wildcard', value: 'anything' } },
        ],
      },
      input,
    );
    expect(duplicateRows.get(a)).toBe(10);

    const wrapped = evaluateDecider(
      {
        condition: {
          kind: 'compare',
          left: { kind: 'signal', signal: a },
          comparator: '>',
          right: { kind: 'constant', value: 0 },
        },
        outputs: [
          { mode: 'constant', signal: { kind: 'wildcard', value: 'anything' }, value: 2 ** 31 },
        ],
      },
      input,
    );
    expect(wrapped.get(a)).toBe(-(2 ** 31));
  });

  it('keeps Anything constant rows available in an Each condition context', () => {
    const candidates = [a, b, c] as const;
    const result = evaluateDecider(
      {
        condition: eachPositive,
        outputs: [{ mode: 'constant', signal: { kind: 'wildcard', value: 'anything' }, value: 9 }],
      },
      singleWireInput(
        new SparseBus([
          [a, 2],
          [b, 3],
          [c, -4],
        ]),
      ),
    );
    const entries = result.entries();
    expect(entries).toHaveLength(1);
    expect(candidates.slice(0, 2)).toContain(entries[0]![0]);
    expect(entries[0]![1]).toBe(9);
  });

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

  it('does not exclude a concrete right operand from Each candidates', () => {
    const input = new SparseBus([
      [a, 10],
      [b, 5],
    ]);
    const result = evaluateDecider(
      {
        condition: {
          kind: 'compare',
          left: { kind: 'wildcard', value: 'each' },
          comparator: '>=',
          right: { kind: 'signal', signal: a },
        },
        outputs: [{ mode: 'copy', signal: { kind: 'wildcard', value: 'each' } }],
      },
      singleWireInput(input),
    );
    expect(result.get(a)).toBe(10);
    expect(result.get(b)).toBe(0);
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

  it('treats concrete copy output as one contribution per matching Each signal', () => {
    const input = singleWireInput(
      new SparseBus([
        [b, 10],
        [c, 20],
        [out, -5],
      ]),
    );
    const concreteCopy = { mode: 'copy' as const, signal: { kind: 'signal' as const, signal: a } };

    expect(evaluateDecider({ condition: eachNonzero, outputs: [concreteCopy] }, input).get(a)).toBe(
      25,
    );
    expect(
      evaluateDecider(
        {
          condition: eachNonzero,
          outputs: [
            concreteCopy,
            { mode: 'constant', signal: { kind: 'signal', signal: a }, value: 1 },
          ],
        },
        input,
      ).get(a),
    ).toBe(28);
  });

  it('preserves duplicate concrete Each-copy rows without deduplication', () => {
    const input = singleWireInput(
      new SparseBus([
        [b, 10],
        [c, 20],
        [out, -5],
      ]),
    );
    const concreteCopy = { mode: 'copy' as const, signal: { kind: 'signal' as const, signal: a } };

    expect(
      evaluateDecider({ condition: eachNonzero, outputs: [concreteCopy, concreteCopy] }, input).get(
        a,
      ),
    ).toBe(50);
  });

  it('copies only the concrete-output contributions of matching Each candidates', () => {
    const result = evaluateDecider(
      {
        condition: eachPositive,
        outputs: [{ mode: 'copy', signal: { kind: 'signal', signal: a } }],
      },
      singleWireInput(
        new SparseBus([
          [b, 10],
          [c, -20],
          [out, 5],
        ]),
      ),
    );
    expect(result.get(a)).toBe(15);
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

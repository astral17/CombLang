import { signal, SparseBus } from '@comblang/factorio';
import { describe, expect, it } from 'vitest';

import { evaluateArithmetic, evaluateArithmeticOperation } from './arithmetic.js';
import { singleWireInput } from './circuit-input.js';

const a = signal('virtual', 'signal-A');
const b = signal('virtual', 'signal-B');
const out = signal('virtual', 'signal-Z');

describe('arithmetic combinator semantics', () => {
  it('evaluates signed division, modulo, shifts, bitwise operations, and overflow', () => {
    expect(evaluateArithmeticOperation('divide', -19, 10)).toBe(-1);
    expect(evaluateArithmeticOperation('modulo', -13, -3)).toBe(-1);
    expect(evaluateArithmeticOperation('left-shift', 1, 31)).toBe(-2_147_483_648);
    expect(evaluateArithmeticOperation('right-shift', -2, 1)).toBe(-1);
    expect(evaluateArithmeticOperation('bit-and', 0b1100, 0b1010)).toBe(0b1000);
    expect(evaluateArithmeticOperation('add', 2_147_483_647, 1)).toBe(-2_147_483_648);
  });

  it('maps Each to Each over non-zero input signals', () => {
    const result = evaluateArithmetic(
      {
        left: { kind: 'each' },
        operation: 'multiply',
        right: { kind: 'constant', value: -2 },
        output: { kind: 'each' },
      },
      singleWireInput(
        new SparseBus([
          [a, 3],
          [b, -4],
        ]),
      ),
    );
    expect(result.toJSON()).toEqual([
      { signal: a, value: -6 },
      { signal: b, value: 8 },
    ]);
  });

  it('sums Each operation results into a concrete output signal', () => {
    const result = evaluateArithmetic(
      {
        left: { kind: 'each' },
        operation: 'add',
        right: { kind: 'signal', signal: a },
        output: { kind: 'signal', signal: out },
      },
      singleWireInput(
        new SparseBus([
          [a, 2],
          [b, 3],
        ]),
      ),
    );
    expect(result.get(out)).toBe(9);
  });

  it('rejects physically invalid Each combinations', () => {
    expect(() =>
      evaluateArithmetic(
        {
          left: { kind: 'signal', signal: a },
          operation: 'add',
          right: { kind: 'signal', signal: b },
          output: { kind: 'each' },
        },
        singleWireInput(new SparseBus()),
      ),
    ).toThrow(/requires at least one Each input/);
  });

  it('applies independent red and green masks to operands', () => {
    const result = evaluateArithmetic(
      {
        left: { kind: 'signal', signal: a, networks: { red: true, green: false } },
        operation: 'subtract',
        right: { kind: 'signal', signal: a, networks: { red: false, green: true } },
        output: { kind: 'signal', signal: out },
      },
      {
        red: new SparseBus([[a, 20]]),
        green: new SparseBus([[a, 7]]),
      },
    );
    expect(result.get(out)).toBe(13);
  });

  it('maps two independently selected Each operands lane by lane', () => {
    const result = evaluateArithmetic(
      {
        left: { kind: 'each', networks: { red: true, green: false } },
        operation: 'add',
        right: { kind: 'each', networks: { red: false, green: true } },
        output: { kind: 'each' },
      },
      {
        red: new SparseBus([
          [a, 2],
          [b, 4],
        ]),
        green: new SparseBus([[a, 3]]),
      },
    );

    expect(result.toJSON()).toEqual([
      { signal: a, value: 5 },
      { signal: b, value: 4 },
    ]);
  });
});

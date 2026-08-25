import { describe, expect, test } from 'vitest';

import { ColorConstraintError, solveCircuitColors } from './color-solver.js';

describe('circuit color solver', () => {
  test('propagates equal and opposite color classes', () => {
    const colors = solveCircuitColors(
      ['input', 'out', 'mem'],
      [
        { left: 'input', right: 'out', relation: 'same' },
        { left: 'out', right: 'mem', relation: 'different' },
      ],
    );

    expect(colors.get('input')).toBe(colors.get('out'));
    expect(colors.get('out')).not.toBe(colors.get('mem'));
  });

  test('honors fixed colors', () => {
    const colors = solveCircuitColors(
      ['red', 'green'],
      [{ left: 'red', right: 'green', relation: 'different' }],
      [{ id: 'green', color: 'green' }],
    );

    expect(colors).toEqual(
      new Map([
        ['red', 'red'],
        ['green', 'green'],
      ]),
    );
  });

  test('reports a contradictory constraint', () => {
    expect(() =>
      solveCircuitColors(
        ['a', 'b'],
        [
          { left: 'a', right: 'b', relation: 'same' },
          { left: 'a', right: 'b', relation: 'different', reason: 'one connector' },
        ],
      ),
    ).toThrow(ColorConstraintError);
  });
});

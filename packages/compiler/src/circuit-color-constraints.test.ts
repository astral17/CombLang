import { describe, expect, test } from 'vitest';

import {
  CircuitColorConstraints,
  ColorConstraintError,
  UnknownColorConstraintIdError,
} from './circuit-color-constraints.js';

type Operation =
  | readonly ['same', string, string]
  | readonly ['different', string, string]
  | readonly ['fix', string, 'red' | 'green'];

function oracle(
  ids: readonly string[],
  operations: readonly Operation[],
): Map<string, 'red' | 'green'> {
  const edges = new Map(ids.map((id) => [id, [] as { id: string; parity: 0 | 1 }[]]));
  const fixed = new Map<string, 0 | 1>();
  for (const operation of operations) {
    if (operation[0] === 'fix') {
      const value = operation[2] === 'red' ? 0 : 1;
      if (fixed.has(operation[1]) && fixed.get(operation[1]) !== value) throw new Error('conflict');
      fixed.set(operation[1], value);
      continue;
    }
    const parity = operation[0] === 'same' ? 0 : 1;
    edges.get(operation[1])!.push({ id: operation[2], parity });
    edges.get(operation[2])!.push({ id: operation[1], parity });
  }

  const result = new Map<string, 'red' | 'green'>();
  const relative = new Map<string, 0 | 1>();
  for (const start of ids) {
    if (relative.has(start)) continue;
    const component: string[] = [];
    const queue = [start];
    relative.set(start, 0);
    for (let cursor = 0; cursor < queue.length; cursor += 1) {
      const current = queue[cursor]!;
      component.push(current);
      for (const edge of edges.get(current)!) {
        const value = (relative.get(current)! ^ edge.parity) as 0 | 1;
        if (relative.has(edge.id) && relative.get(edge.id) !== value) throw new Error('conflict');
        if (!relative.has(edge.id)) {
          relative.set(edge.id, value);
          queue.push(edge.id);
        }
      }
    }
    let orientation = relative.get(component[0]!)!;
    for (const id of component) {
      const color = fixed.get(id);
      if (color === undefined) continue;
      const candidate = (relative.get(id)! ^ color) as 0 | 1;
      if (
        component.some(
          (member) =>
            fixed.has(member) && (relative.get(member)! ^ fixed.get(member)!) !== candidate,
        )
      ) {
        throw new Error('conflict');
      }
      orientation = candidate;
      break;
    }
    for (const id of component) {
      result.set(id, (relative.get(id)! ^ orientation) === 0 ? 'red' : 'green');
    }
  }
  return result;
}

function evaluate(ids: readonly string[], operations: readonly Operation[]) {
  const engine = new CircuitColorConstraints<string>();
  for (const id of ids) engine.add(id);
  for (const operation of operations) {
    if (operation[0] === 'same') engine.same(operation[1], operation[2]);
    else if (operation[0] === 'different') engine.different(operation[1], operation[2]);
    else engine.fix(operation[1], operation[2]);
  }
  return engine.resolve();
}

describe('stateful circuit color constraints', () => {
  test('matches a BFS oracle after every consistent prefix', () => {
    const ids = ['a', 'b', 'c', 'isolated'];
    const operations: Operation[] = [
      ['different', 'b', 'c'],
      ['same', 'a', 'b'],
      ['same', 'a', 'a'],
      ['different', 'b', 'c'],
      ['fix', 'c', 'green'],
    ];

    for (let length = 0; length <= operations.length; length += 1) {
      const prefix = operations.slice(0, length);
      expect(evaluate(ids, prefix)).toEqual(oracle(ids, prefix));
    }
  });

  test('reports a contradictory triangle with its provenance', () => {
    const engine = new CircuitColorConstraints<string>();
    engine.add('a').add('b').add('c');
    engine.different('a', 'b').different('b', 'c');
    const beforeConflict = engine.resolve();
    const provenance = Object.freeze({ source: { start: 17, end: 23 } });

    try {
      engine.different('c', 'a', { reason: 'third edge', provenance });
      expect.unreachable('expected a color conflict');
    } catch (error) {
      expect(error).toBeInstanceOf(ColorConstraintError);
      const conflict = (error as ColorConstraintError<string>).constraint;
      expect(conflict).toMatchObject({ reason: 'third edge', provenance });
    }
    expect(engine.resolve()).toEqual(beforeConflict);
  });

  test('reports contradictory fixed anchors', () => {
    const engine = new CircuitColorConstraints<string>();
    engine.add('a').add('b').same('a', 'b').fix('a', 'red');
    expect(() => engine.fix('b', 'green', { reason: 'fixed parameter' })).toThrow(
      ColorConstraintError,
    );
  });

  test('rejects unknown IDs without implicitly registering them', () => {
    const engine = new CircuitColorConstraints<string>();
    engine.add('known');
    expect(() => engine.same('known', 'missing')).toThrow(UnknownColorConstraintIdError);
    expect(() => engine.fix('missing', 'red')).toThrow(UnknownColorConstraintIdError);
  });

  test('resolve is observational and later constraints remain valid', () => {
    const engine = new CircuitColorConstraints<string>();
    engine.add('a').add('b').add('c').different('a', 'b');
    expect(engine.resolve()).toEqual(engine.resolve());
    engine.same('b', 'c');
    expect(engine.resolve()).toEqual(
      new Map([
        ['a', 'red'],
        ['b', 'green'],
        ['c', 'green'],
      ]),
    );
  });

  test('uses registration order rather than union order for free component orientation', () => {
    const first = evaluate(
      ['a', 'b', 'c'],
      [
        ['different', 'a', 'b'],
        ['same', 'b', 'c'],
      ],
    );
    const second = evaluate(
      ['a', 'b', 'c'],
      [
        ['same', 'c', 'b'],
        ['different', 'b', 'a'],
      ],
    );
    expect(first).toEqual(second);
    expect(first.get('a')).toBe('red');
  });
});

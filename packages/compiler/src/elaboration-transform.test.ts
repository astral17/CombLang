import { parseFile } from '@comblang/language';
import { describe, expect, test, vi } from 'vitest';

import { transformElaborationModule } from './elaboration-transform.js';

describe('executable elaboration transform', () => {
  test('leaves a compile-time for loop to the JS engine while rewriting DSL operations', () => {
    const source = parseFile({
      path: 'loop.factorio.ts',
      text: `const SIGNAL_A = Signal("virtual", "signal-A");
let input = CC(5 * SIGNAL_A);
let output = new Network();
for (let i = 0; i < 10; i++) {
  output += IF(input < i, 1 * SIGNAL_A);
}`,
    });
    const program = transformElaborationModule(source);
    const dsl = {
      enterFunction: vi.fn(),
      enterLoop: vi.fn(),
      exitInstance: vi.fn(),
      signal: vi.fn(() => ({ signal: true })),
      binary: vi.fn((operator, left, right) =>
        operator === '*' && typeof left === 'number' && typeof right === 'object'
          ? { kind: 'signal-value', left, right }
          : operator === '+'
            ? Number(left) + Number(right)
            : operator === '*'
              ? Number(left) * Number(right)
              : undefined,
      ),
      constant: vi.fn(() => ({ producer: 'constant' })),
      materialize: vi.fn((value, name) =>
        typeof value === 'object' && value?.producer !== undefined ? { network: name } : value,
      ),
      network: vi.fn(() => ({ network: 'anonymous' })),
      compare: vi.fn((operator, left, right) =>
        typeof left === 'number' && typeof right === 'number'
          ? operator === '<'
            ? left < right
            : false
          : { operator, left, right },
      ),
      decider: vi.fn((condition, value) => ({ producer: 'decider', condition, value })),
      attach: vi.fn(),
      addAssign: vi.fn((left, right, assign) => {
        if (typeof left === 'object' && right?.producer !== undefined) {
          dsl.attach(left, right);
          return left;
        }
        const result = Number(left) + Number(right);
        assign(result);
        return result;
      }),
      discard: vi.fn(),
    };

    // The production executor will run the same code in a terminable Worker;
    // this fixture proves that iteration is performed by JavaScript, not AST unrolling.
    Function('__dsl', `"use strict";\n${program.code}`)(dsl);

    expect(dsl.constant).toHaveBeenCalledTimes(1);
    expect(dsl.compare).toHaveBeenCalledTimes(21);
    expect(dsl.decider).toHaveBeenCalledTimes(10);
    expect(dsl.attach).toHaveBeenCalledTimes(10);
    expect(
      dsl.compare.mock.calls.filter((call) => typeof call[1] === 'object').map((call) => call[2]),
    ).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(program.code).toContain('__dsl.compare("<", i, 10');
  });

  test('routes reads through runtime dispatch while preserving ordinary element writes', () => {
    const source = parseFile({
      path: 'elements.factorio.ts',
      text: `const values = [1, 2];
values[0] = 3;
values[1]++;
const result = values[0] + values[1];`,
    });
    const program = transformElaborationModule(source);

    expect(program.code).toContain('values[0] = 3');
    expect(program.code).toContain('values[1]++');
    expect(program.code).toContain('__dsl.element(values, 0');
    expect(program.code).toContain('__dsl.element(values, 1');
  });

  test('preserves a contextual Network color and rewrites explicit placement', () => {
    const source = parseFile({
      path: 'placement.factorio.ts',
      text: `const input = new Network();
const output: Network<G> = (input + 1).at(10.5, -2, 8);`,
    });
    const program = transformElaborationModule(source);

    expect(program.code).toContain('__dsl.place(');
    expect(program.code).toContain('"green"');
    expect(program.code).toContain('10.5, -2, 8');
  });

  test('defers property and element += classification to runtime without repeating targets', () => {
    const source = parseFile({
      path: 'compound-targets.factorio.ts',
      text: `const state = { value: 1 };
const values = [2];
getState().value += 3;
getValues()[0] += 4;`,
    });
    const program = transformElaborationModule(source);

    expect(program.code).toContain('__dsl.addAssign(_target_1.value, 3');
    expect(program.code).toContain('))(getState())');
    expect(program.code).toContain('__dsl.addAssign(__dsl.element(_target_2, _key_1');
    expect(program.code).toContain('))(getValues(), 0)');
    expect(program.code.match(/getState\(\)/g)).toHaveLength(1);
    expect(program.code.match(/getValues\(\)/g)).toHaveLength(1);
  });

  test('routes one-argument .take calls through ownership-aware runtime dispatch', () => {
    const source = parseFile({
      path: 'take.factorio.ts',
      text: `const destination = new Network();
const source = new Network();
destination.take(source);`,
    });

    expect(transformElaborationModule(source).code).toContain('__dsl.take(destination, source');
  });

  test('rebinds Readonly and Ref parameters to runtime borrow views', () => {
    const source = parseFile({
      path: 'borrows.factorio.ts',
      text: `function Connect(output: Ref<Network<G>>, input: Readonly<Network<R>>): void {
  output += input + 1;
}`,
    });
    const code = transformElaborationModule(source).code;

    expect(code).toContain('__dsl.borrowParameter(output, "ref", "output"');
    expect(code).toContain('__dsl.borrowParameter(input, "readonly", "input"');
    expect(code).toContain('__dsl.exitInstance({ start: 0');
  });
});

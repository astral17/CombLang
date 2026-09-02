import { parseFile } from '@comblang/language';
import { describe, expect, test, vi } from 'vitest';

import { transformElaborationModule } from './elaboration-transform.js';

describe('executable elaboration transform', () => {
  test('routes the reserved prototypes value through the hygienic runtime bridge', () => {
    const source = parseFile({
      path: 'prototype-access.factorio.ts',
      text: `const plate = prototypes.item['iron-plate'];`,
    });
    const code = transformElaborationModule(source).code;

    expect(code).toContain('__dsl.prototypeEnvironment({ start:');
    expect(code).toContain(".item, 'iron-plate'");
    expect(code).not.toMatch(/\bprototypes\.item\b/);
  });

  test('keeps ordinary prototypes property names while transforming value references', () => {
    const source = parseFile({
      path: 'prototype-property.factorio.ts',
      text: `const named = { prototypes: 'metadata' };
const forwarded = { prototypes };`,
    });
    const code = transformElaborationModule(source).code;

    expect(code).toContain("prototypes: 'metadata'");
    expect(code).toContain('prototypes: __dsl.prototypeEnvironment(');
  });

  test('leaves optional element and property-call chains native', () => {
    const source = parseFile({
      path: 'optional.ts',
      text: `const element = maybe?.[key()];
const call = maybe?.to(value);`,
    });
    const code = transformElaborationModule(source).code;

    expect(code).toContain('maybe?.[__dsl.invoke(key, []');
    expect(code).toContain('maybe?.to(value)');
    expect(code).not.toContain('__dsl.element');
    expect(code).not.toContain('__dsl.attachTo');
  });

  test('transforms DSL-sensitive descendants without lowering the optional operation itself', () => {
    const source = parseFile({
      path: 'optional-descendants.ts',
      text: `const call = helper?.use(input + 1);
const element = helper?.[input[SIGNAL_A]];`,
    });
    const code = transformElaborationModule(source).code;

    expect(code).toContain('helper?.use(__dsl.binary("+", input, 1');
    expect(code).toContain('helper?.[__dsl.element(input, SIGNAL_A');
    expect(code).not.toContain('__dsl.attachTo(helper');
  });

  test('chooses a runtime bridge identifier absent from the entire source', () => {
    const source = parseFile({
      path: 'bridge-hygiene.ts',
      text: `const __dsl = 1;
const first = __dsl_1;
const input = new Network();`,
    });
    const program = transformElaborationModule(source);

    expect(program.runtimeParameter).toBe('__dsl_2');
    expect(program.code).toContain('const __dsl = __dsl_2.materialize(1');
    expect(program.code).toContain('__dsl_2.network(');
  });

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
      controlTest: vi.fn((value) => value),
      deciderBranches: vi.fn((condition, value) => ({ producer: 'decider', condition, value })),
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
    };

    // The production executor will run the same code in a terminable Worker;
    // this fixture proves that iteration is performed by JavaScript, not AST unrolling.
    Function(program.runtimeParameter, `"use strict";\n${program.code}`)(dsl);

    expect(dsl.constant).toHaveBeenCalledTimes(1);
    expect(dsl.compare).toHaveBeenCalledTimes(21);
    expect(dsl.deciderBranches).toHaveBeenCalledTimes(10);
    expect(dsl.attach).toHaveBeenCalledTimes(10);
    expect(
      dsl.compare.mock.calls.filter((call) => typeof call[1] === 'object').map((call) => call[2]),
    ).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(program.code).toContain('__dsl.compare("<", i, 10');
    expect(program.code).toContain('__dsl.controlTest(__dsl.compare("<", i, 10');
  });

  test('guards JavaScript control-flow tests and routes unary not through runtime dispatch', () => {
    const source = parseFile({
      path: 'control-flow.factorio.ts',
      text: `if (condition) yes(); else no();
const selected = condition ? yes() : no();
while (condition) work();
do work(); while (condition);
for (; condition;) work();
for (;;) break;
const inverted = !value;`,
    });
    const code = transformElaborationModule(source).code;

    expect(code.match(/__dsl\.controlTest\(condition/g)).toHaveLength(5);
    expect(code).toContain('for (;;)');
    expect(code).toContain('__dsl.not(value');
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

    expect(program.code).toContain('__dsl.invokePrepared(__dsl.prepareMember(');
    expect(program.code).toContain('"at", { start:');
    expect(program.code).toContain('"green"');
    expect(program.code).toContain('value: 10.5, source:');
    expect(program.code).toContain('value: -2, source:');
    expect(program.code).toContain('value: 8, source:');
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
    expect(program.code).toContain('))(__dsl.invoke(getState, []');
    expect(program.code).toContain('__dsl.addAssign(__dsl.element(_target_2, _key_1');
    expect(program.code).toContain('))(__dsl.invoke(getValues, []');
    expect(program.code.match(/__dsl\.invoke\(getState,/g)).toHaveLength(1);
    expect(program.code.match(/__dsl\.invoke\(getValues,/g)).toHaveLength(1);
  });

  test('routes one-argument .take calls through ownership-aware runtime dispatch', () => {
    const source = parseFile({
      path: 'take.factorio.ts',
      text: `const destination = new Network();
const source = new Network();
destination.take(source);`,
    });

    expect(transformElaborationModule(source).code).toContain(
      '__dsl.invokePrepared(__dsl.prepareMember(destination, "take",',
    );
  });

  test('routes pair views and their selections through runtime dispatch', () => {
    const source = parseFile({
      path: 'pair.factorio.ts',
      text: `const A = Signal("virtual", "signal-A");
const red = new Network<R>();
const green = new Network<G>();
const combined: Network = Each(pair(red, green)) + pair(red, green)[A];`,
    });
    const code = transformElaborationModule(source).code;

    expect(code.match(/__dsl\.pair\(/g)).toHaveLength(2);
    expect(code).toContain('__dsl.wildcard("each", __dsl.pair(');
    expect(code).toContain('__dsl.element(__dsl.pair(');
  });

  test('preserves explicit combinator handles and selected free destinations', () => {
    const source = parseFile({
      path: 'producer-handle.factorio.ts',
      text: `const A = Signal('virtual', 'signal-A');
const input = new Network();
let comb: DeciderCombinator = when(input > 0).then(input);
const first = new Network();
const second = new Network();
to(first, second)[A] += comb;`,
    });
    const code = transformElaborationModule(source).code;

    expect(code).toContain('let comb = __dsl.producerHandle(__dsl.deciderBranches(');
    expect(code).not.toContain('__dsl.materialize(__dsl.deciderBranches(');
    expect(code).toContain('__dsl.attach(__dsl.select(__dsl.destinations(first, second');
  });

  test('marks precise Producer returns as preserving the handle boundary', () => {
    const source = parseFile({
      path: 'producer-return.factorio.ts',
      text: `function Gate(input: Readonly<Network>): DeciderCombinator {
  return when(input > 0).then(input);
}`,
    });

    expect(transformElaborationModule(source).code).toMatch(
      /return __dsl\.returnValue\([\s\S]*?, "DeciderCombinator"\);/,
    );
  });

  test('leaves expression results to identity-based runtime finalization', () => {
    const source = parseFile({
      path: 'producer-slot.factorio.ts',
      text: `function test(input: Readonly<Network>): ArithmeticCombinator {
  let tmp = [];
  tmp[1] = input + 0;
  return tmp[1];
}`,
    });
    const code = transformElaborationModule(source).code;

    expect(code).toContain('tmp[1] = __dsl.binary(');
    expect(code).not.toContain('__dsl.discard');
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

  test('validates concrete Producer parameters in the function prologue', () => {
    const source = parseFile({
      path: 'producer-parameter.factorio.ts',
      text: `function Configure(value: ArithmeticCombinator): Producer {
  return value;
}`,
    });
    const code = transformElaborationModule(source).code;

    expect(code).toContain('value = __dsl.producerHandle(value, "ArithmeticCombinator"');
    expect(code).toContain('return __dsl.returnValue(value');
    expect(code).toContain('"Producer"');
  });

  test('validates concrete Producer arguments at direct call sites', () => {
    const source = parseFile({
      path: 'producer-call.factorio.ts',
      text: `function Configure(value: ArithmeticCombinator): Producer {
  return value;
}
const values = [5];
Configure(values[0]);`,
    });
    const code = transformElaborationModule(source).code;

    expect(code).toContain('__dsl.invoke(Configure, [{ value: __dsl.element(values, 0');
    expect(code).toContain('__dsl.parameterSource(0,');
    expect(code).toContain('"ArithmeticCombinator", "value"');
  });

  test('carries concrete Producer types into destructuring descriptors', () => {
    const source = parseFile({
      path: 'producer-destructuring.factorio.ts',
      text: `let [arithmetic]: [ArithmeticCombinator] = values;
let {gate}: {gate: DeciderCombinator} = record;`,
    });
    const code = transformElaborationModule(source).code;

    expect(code).toContain('producerType: "ArithmeticCombinator"');
    expect(code).toContain('producerType: "DeciderCombinator"');
  });

  test('validates later writes to typed Producer slots without leaking across shadows', () => {
    const source = parseFile({
      path: 'producer-assignments.factorio.ts',
      text: `let direct: ArithmeticCombinator;
direct = dynamicValue;
let slots: DeciderCombinator[] = [];
slots[0] = dynamicValue;
let record: {constant: ConstantCombinator} = {};
record.constant = dynamicValue;
{
  let direct = 1;
  direct = 2;
}`,
    });
    const code = transformElaborationModule(source).code;

    expect(code).toContain('direct = __dsl.producerHandle(dynamicValue, "ArithmeticCombinator"');
    expect(code).toContain('slots[0] = __dsl.producerHandle(dynamicValue, "DeciderCombinator"');
    expect(code).toContain(
      'record.constant = __dsl.producerHandle(dynamicValue, "ConstantCombinator"',
    );
    expect(code).toContain('direct = 2;');
    expect(code.match(/__dsl\.producerHandle/g)).toHaveLength(3);
  });

  test('instruments Move parameters and owned returns', () => {
    const source = parseFile({
      path: 'move.factorio.ts',
      text: `function Pass(input: Move<Network<G>>): Network {
  return input;
}`,
    });
    const code = transformElaborationModule(source).code;

    expect(code).toContain('__dsl.moveParameter(input, "input", "green"');
    expect(code).toContain('return __dsl.returnNetwork(input');
  });

  test('does not treat a nested callback return as the surrounding ownership boundary', () => {
    const source = parseFile({
      path: 'callback-return.factorio.ts',
      text: `function Pick(input: Readonly<Network>): Network {
  const values = [0].map(() => { return input; });
  return values[0] + 0;
}`,
    });
    const code = transformElaborationModule(source).code;

    expect(code.match(/__dsl\.returnNetwork/g)).toHaveLength(1);
    expect(code).toContain('return input;');
  });
});

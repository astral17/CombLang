import { generateBlueprintJson, transformElaborationModule } from '@comblang/compiler';
import { signal, SparseBus } from '@comblang/factorio';
import { parseFile, validateDslSemantics } from '@comblang/language';
import { loadPrototypeDatabase, syntheticPrototypeDatabase } from '@comblang/prototypes';
import { describe, expect, test } from 'vitest';

import { elaborateDirectPlan, tryElaborateDirectPlan } from './direct-plan.js';
import { RuntimeDiagnosticError } from './elaboration.js';
import {
  ElaborationExecutionError,
  ElaborationOperationLimitError,
  executeElaborationProgram,
} from './elaboration-program.js';

const loopSource = `const SIGNAL_A = Signal("virtual", "signal-A");

let input = CC(5 * SIGNAL_A);
let output = new Network();
for (let i = 0; i < 10; i++) {
  output += IF(input < i, 1 * SIGNAL_A);
}`;

describe('executed elaboration program', () => {
  test('exposes an explicitly injected immutable prototype environment to source', async () => {
    const { prototypes } = await loadPrototypeDatabase(syntheticPrototypeDatabase());
    const parsed = parseFile({
      path: 'prototype-environment.factorio.ts',
      text: `const PLATE = Signal(prototypes.item['iron-plate'].name);
const source = CC(prototypes.item['iron-plate'].stackSize * PLATE);`,
    });

    const plan = executeElaborationProgram(transformElaborationModule(parsed), { prototypes });

    expect(plan.producers).toMatchObject([
      {
        kind: 'constant',
        outputs: [{ signal: { type: 'item', name: 'iron-plate' }, value: 100 }],
      },
    ]);
  });

  test('reports source-linked failure when prototypes are used without an environment', () => {
    const parsed = parseFile({
      path: 'missing-prototype-environment.factorio.ts',
      text: `const plate = prototypes.item['iron-plate'];`,
    });

    expect(() => executeElaborationProgram(transformElaborationModule(parsed))).toThrowError(
      expect.objectContaining({ code: 'EX1004', span: expect.any(Object) }),
    );
  });

  test('seals the runtime against delayed Promise mutations', async () => {
    const globalKey = '__comblangLateDslMutationTest';
    const parsed = parseFile({
      path: 'late-promise.factorio.ts',
      text: `const input = new Network();
globalThis.${globalKey} = Promise.resolve().then(() => input + 1);`,
    });

    const plan = executeElaborationProgram(transformElaborationModule(parsed));
    const lateMutation = (globalThis as unknown as Record<string, unknown>)[globalKey];
    try {
      await expect(lateMutation).rejects.toMatchObject({
        code: 'RT2025',
        span: expect.any(Object),
      });
      expect(plan.producers).toEqual([]);
    } finally {
      delete (globalThis as unknown as Record<string, unknown>)[globalKey];
    }
  });

  test('validates the versioned hygienic runtime bridge metadata', () => {
    const program = transformElaborationModule(
      parseFile({ path: 'runtime-envelope.factorio.ts', text: 'const input = new Network();' }),
    );

    expect(() =>
      executeElaborationProgram({ ...program, version: 1 } as unknown as typeof program),
    ).toThrow(/Unsupported elaboration JavaScript format/);
    expect(() => executeElaborationProgram({ ...program, runtimeParameter: 'bridge) {}' })).toThrow(
      /Invalid elaboration runtime parameter/,
    );

    const asyncProgram = transformElaborationModule(
      parseFile({ path: 'async-envelope.factorio.ts', text: 'async function later() {}' }),
    );
    expect(asyncProgram.containsUnsupportedAsync).toBe(true);
    expect(() => executeElaborationProgram(asyncProgram)).toThrow(
      /Asynchronous syntax is not supported/,
    );
  });

  test('serializes executed capability uses with pair and transfer descriptors', () => {
    const parsed = parseFile({
      path: 'capability-boundary.factorio.ts',
      text: `function Inspect(input: Readonly<Network<R>>, output: Ref<Network<G>>): void {
  output += input + 1;
}
function Pass(input: Move<Network>): Network { return input; }
let red = new Network<R>();
const green = new Network<G>();
Inspect(red, green);
red = Pass(red);
const inputs = pair(red, green);`,
    });
    const plan = executeElaborationProgram(transformElaborationModule(parsed));

    expect(plan.capabilityUses).toMatchObject([
      { network: 'red', capability: 'readonly', parameter: 'input', fixedColor: 'red' },
      { network: 'green', capability: 'ref', parameter: 'output', fixedColor: 'green' },
      { network: 'red', capability: 'move', parameter: 'input' },
    ]);
    expect(
      plan.capabilityUses?.every(
        ({ provenance, instancePath }) =>
          provenance.fileId === parsed.id && instancePath.length > 0,
      ),
    ).toBe(true);
    expect(plan.networkPairs).toMatchObject([{ networks: ['red', 'green'] }]);
  });

  test('limits recorded DSL work rather than empty JavaScript iterations', () => {
    const parsed = parseFile({
      path: 'budget.factorio.ts',
      text: `const A = Signal("virtual", "signal-A");
for (let i = 0; i < 100; i++) { CC(i * A); }`,
    });
    const program = transformElaborationModule(parsed);

    expect(() => executeElaborationProgram(program, { dslCallBudget: 12 })).toThrow(
      ElaborationOperationLimitError,
    );

    const emptyLoop = transformElaborationModule(
      parseFile({ path: 'empty-loop.factorio.ts', text: 'for (let i = 0; i < 1000; i++) {}' }),
    );
    expect(executeElaborationProgram(emptyLoop, { dslCallBudget: 1 }).producers).toHaveLength(0);
  });

  test('formats object loop provenance by stable identity', () => {
    const parsed = parseFile({
      path: 'safe-loop-provenance.factorio.ts',
      text: `const object = {};
const input = new Network();
for (const value of [object]) {
  const output: Network = input + 1;
}`,
    });
    const plan = executeElaborationProgram(transformElaborationModule(parsed));

    expect(plan.producers).toMatchObject([
      { kind: 'arithmetic', instancePath: ['for value=object#1'] },
    ]);
  });

  test('records standalone producers in an unused sink with a source warning', () => {
    const expression = 'input + 0';
    const parsed = parseFile({
      path: 'unused.factorio.ts',
      text: `const input = new Network();
${expression};`,
    });
    const plan = executeElaborationProgram(transformElaborationModule(parsed));

    expect(plan.producers).toMatchObject([
      { kind: 'arithmetic', destinations: [{ network: '$unused:1' }] },
    ]);
    expect(plan.diagnostics).toContainEqual(
      expect.objectContaining({ code: 'CL2001', severity: 'warning' }),
    );
    const warning = plan.diagnostics?.[0];
    expect(warning?.span && parsed.text.slice(warning.span.start, warning.span.end)).toBe(
      expression,
    );
    expect(() => elaborateDirectPlan(plan)).not.toThrow();
  });

  test('preserves a contextual Network<G> color during runtime materialization', () => {
    const parsed = parseFile({
      path: 'context-color.factorio.ts',
      text: `const input = new Network();
let test: Network<G> = input + 0;`,
    });
    const plan = executeElaborationProgram(transformElaborationModule(parsed));
    const execution = elaborateDirectPlan(plan);

    expect(plan.networks).toMatchObject([{ name: 'input' }, { name: 'test', fixedColor: 'green' }]);
    expect(execution.circuit.ir.networks.find(({ name }) => name === 'test')?.color).toBe('green');
  });

  test('preserves circuit grouping while folding numeric-only subexpressions', () => {
    const parsed = parseFile({
      path: 'arithmetic-grouping.factorio.ts',
      text: `const input = new Network();
const grouped = (input + 1) * 2;
const folded = input + (2 * 3);`,
    });
    const plan = executeElaborationProgram(transformElaborationModule(parsed));

    expect(plan.producers).toMatchObject([
      {
        kind: 'arithmetic',
        operation: 'add',
        left: { kind: 'each', network: 'input' },
        right: { kind: 'constant', value: 1 },
        destinations: [{ network: '$tmp:1' }],
      },
      {
        kind: 'arithmetic',
        operation: 'multiply',
        left: { kind: 'each', network: '$tmp:1' },
        right: { kind: 'constant', value: 2 },
        destinations: [{ network: 'grouped' }],
      },
      {
        kind: 'arithmetic',
        operation: 'add',
        left: { kind: 'each', network: 'input' },
        right: { kind: 'constant', value: 6 },
        destinations: [{ network: 'folded' }],
      },
    ]);
    expect(plan.networks.map(({ name }) => name)).toEqual(['input', '$tmp:1', 'grouped', 'folded']);
  });

  test('preserves ordinary JavaScript arithmetic and comparison semantics', () => {
    const parsed = parseFile({
      path: 'ordinary-operators.factorio.ts',
      text: `const type = "virt" + "ual";
const name = "signal-" + "A";
const count = "a" < "b" ? 2 : 99;
const loose = "2" == 2 ? 3 : 99;
const strict = "2" === 2 ? 99 : 4;
const A = Signal(type, name);
const input = CC((count + loose + strict) * A);`,
    });
    const plan = executeElaborationProgram(transformElaborationModule(parsed));

    expect(plan.producers).toMatchObject([
      {
        kind: 'constant',
        outputs: [{ signal: { type: 'virtual', name: 'signal-A' }, value: 9 }],
        destinations: [{ network: 'input' }],
      },
    ]);
  });

  test('preserves ordinary JavaScript .as and .to methods through runtime dispatch', () => {
    const parsed = parseFile({
      path: 'ordinary-fluent-methods.ts',
      text: `const formatter = { as(value: string) { return value + "!"; } };
const target = { to(value: number) { return value + 1; } };
const formatted = formatter.as("ok");
const incremented = target.to(4);
if (formatted !== "ok!" || incremented !== 5) {
  throw new Error("ordinary fluent dispatch failed");
}`,
    });

    expect(validateDslSemantics(parsed)).toEqual([]);
    expect(executeElaborationProgram(transformElaborationModule(parsed)).producers).toEqual([]);
  });

  test('treats Signal quality as part of an output binding constraint', () => {
    const conflict = '(input[normal] + 1).as(normal).to(output, legendary)';
    const parsed = parseFile({
      path: 'quality-output-conflict.factorio.ts',
      text: `const normal = Signal("item", "iron-plate", "normal");
const legendary = Signal("item", "iron-plate", "legendary");
const input = new Network();
const output = new Network();
${conflict};`,
    });

    try {
      executeElaborationProgram(transformElaborationModule(parsed));
      expect.fail('Expected different Signal qualities to conflict.');
    } catch (error) {
      expect(error).toMatchObject({ code: 'RT2023', span: expect.any(Object) });
      expect(
        parsed.text.slice(
          (error as ElaborationExecutionError).span.start,
          (error as ElaborationExecutionError).span.end,
        ),
      ).toBe(conflict);
    }
  });

  test('preserves JavaScript logical short-circuiting without weakening circuit conditions', () => {
    const parsed = parseFile({
      path: 'logical-short-circuit.factorio.ts',
      text: `let calls = 0;
function bump(): boolean { calls++; return true; }
false && bump();
true || bump();
const A = Signal("virtual", "signal-A");
const source = CC((calls + 1) * A);
const output = IF(source > 0 && source < 10, source);`,
    });
    const plan = executeElaborationProgram(transformElaborationModule(parsed));

    expect(plan.producers[0]).toMatchObject({
      kind: 'constant',
      outputs: [{ value: 1 }],
    });
    expect(plan.producers[1]).toMatchObject({
      kind: 'decider',
      condition: {
        kind: 'and',
        conditions: [{ comparator: '>' }, { comparator: '<' }],
      },
    });
  });

  test('preserves ordinary optional element and method-call short-circuiting', () => {
    const parsed = parseFile({
      path: 'ordinary-optional-access.ts',
      text: `let keyCalls = 0;
function key(): string { keyCalls++; return "value"; }
const missing: { value: number } | undefined = undefined;
const skippedElement = missing?.[key()];
const skippedCall = missing?.toString();
const present = { value: 7 };
const read = present?.[key()];
if (skippedElement !== undefined || skippedCall !== undefined || keyCalls !== 1 || read !== 7) {
  throw new Error("optional access semantics changed");
}`,
    });

    expect(executeElaborationProgram(transformElaborationModule(parsed)).producers).toEqual([]);
  });

  test('keeps transformed DSL arguments behind native optional-call short-circuiting', () => {
    const parsed = parseFile({
      path: 'optional-dsl-arguments.factorio.ts',
      text: `const input = new Network();
const missing = undefined;
missing?.use(input + 1);
const helper = { use: (value) => value };
const output = helper?.use(input + 2);`,
    });
    const plan = executeElaborationProgram(transformElaborationModule(parsed));

    expect(plan.producers).toMatchObject([
      {
        kind: 'arithmetic',
        right: { kind: 'constant', value: 2 },
        destinations: [{ network: 'output' }],
      },
    ]);
  });

  test('executes DSL code when user source binds or references former bridge names', () => {
    const parsed = parseFile({
      path: 'runtime-bridge-hygiene.factorio.ts',
      text: `const __dsl = 7;
const mentioned = typeof __dsl_1;
if (__dsl !== 7 || mentioned !== "undefined") throw new Error("user bindings changed");
const A = Signal("virtual", "signal-A");
const input = CC(5 * A);`,
    });
    const program = transformElaborationModule(parsed);
    const plan = executeElaborationProgram(program);

    expect(program.runtimeParameter).toBe('__dsl_2');
    expect(plan.producers).toMatchObject([
      { kind: 'constant', outputs: [{ signal: { name: 'signal-A' }, value: 5 }] },
    ]);
  });

  test('carries explicit .at placement into blueprint JSON', () => {
    const parsed = parseFile({
      path: 'placement.factorio.ts',
      text: `const A = Signal("virtual", "signal-A");
const input = CC(5 * A);
const output = (input + 1).at(10.5, -2, 8);`,
    });
    const plan = executeElaborationProgram(transformElaborationModule(parsed));
    const execution = elaborateDirectPlan(plan);
    const entities = generateBlueprintJson(execution.circuit.ir).blueprint.entities;

    expect(plan.producers[1]).toMatchObject({ placement: { x: 10.5, y: -2, direction: 8 } });
    expect(entities[1]).toMatchObject({ position: { x: 10.5, y: -2 }, direction: 8 });
  });

  test('preserves an ordinary JavaScript .at call with extra arguments', () => {
    const parsed = parseFile({
      path: 'ordinary-at.factorio.ts',
      text: `const A = Signal("virtual", "signal-A");
const values = [2];
const chosen = values.at(0, "ignored");
const input = CC(5 * A);
const output = input * chosen;`,
    });
    const plan = executeElaborationProgram(transformElaborationModule(parsed));

    expect(plan.producers).toHaveLength(2);
    expect(plan.producers[1]).toMatchObject({
      kind: 'arithmetic',
      right: { kind: 'constant', value: 2 },
    });
  });

  test('accepts a compile-time constant and TypeScript enum as .at direction', () => {
    const parsed = parseFile({
      path: 'direction.factorio.ts',
      text: `enum Direction { East = 4, South = 8 }
const chosen = Direction.South;
const input = new Network();
const first = (input + 1).at(1, 2, chosen);
const second = (input + 2).at(3, 4, Direction.East);`,
    });
    const plan = executeElaborationProgram(transformElaborationModule(parsed));

    expect(plan.producers).toMatchObject([
      { placement: { x: 1, y: 2, direction: 8 } },
      { placement: { x: 3, y: 4, direction: 4 } },
    ]);
  });

  test('fans one producer out through inferred and typed tuple bindings', () => {
    const parsed = parseFile({
      path: 'tuple-bindings.factorio.ts',
      text: `const A = Signal("virtual", "signal-A");
const input = CC(5 * A);
let [a, b]: [Network, Network] = input + 0;
let [c, d] = input + 1;
let [e, f]: [Network<G>, Network] = input + 2;
a += IF(input > 0, input);`,
    });
    const plan = executeElaborationProgram(transformElaborationModule(parsed));
    const execution = elaborateDirectPlan(plan);
    const colors = new Map(execution.circuit.ir.networks.map(({ name, color }) => [name, color]));

    expect(plan.producers[1]).toMatchObject({ destinations: [{ network: 'a' }, { network: 'b' }] });
    expect(plan.producers[2]).toMatchObject({ destinations: [{ network: 'c' }, { network: 'd' }] });
    expect(plan.producers[3]).toMatchObject({ destinations: [{ network: 'e' }, { network: 'f' }] });
    expect(plan.producers[4]).toMatchObject({ destinations: [{ network: 'a' }] });
    expect(plan.networks.find(({ name }) => name === 'e')).toMatchObject({ fixedColor: 'green' });
    expect(colors.get('a')).not.toBe(colors.get('b'));
    expect(colors.get('c')).not.toBe(colors.get('d'));
    expect(colors.get('e')).toBe('green');
    expect(colors.get('f')).toBe('red');
  });

  test('supports flat object producer bindings and preserves ordinary destructuring', () => {
    const parsed = parseFile({
      path: 'object-bindings.factorio.ts',
      text: `const A = Signal("virtual", "signal-A");
const input = CC(5 * A);
let {left, right}: {left: Network<G>, right: Network} = input + 0;
let {third, fourth} = input + 1;
const [factor] = [2];
const {bias} = {bias: 1};
const output = left * factor + bias;`,
    });
    const plan = executeElaborationProgram(transformElaborationModule(parsed));
    const execution = elaborateDirectPlan(plan);

    expect(plan.producers[1]).toMatchObject({
      destinations: [{ network: 'left' }, { network: 'right' }],
    });
    expect(plan.networks.find(({ name }) => name === 'left')).toMatchObject({
      fixedColor: 'green',
    });
    expect(plan.producers[2]).toMatchObject({
      destinations: [{ network: 'third' }, { network: 'fourth' }],
    });
    expect(plan.producers.filter(({ kind }) => kind === 'arithmetic')).toHaveLength(4);
    expect(execution.circuit.ir.networks.find(({ name }) => name === 'right')?.color).toBe('red');
  });

  test('lowers when(...).then(...) output arguments into one native multi-output decider', () => {
    const parsed = parseFile({
      path: 'multi-output-when.factorio.ts',
      text: `const A = Signal("virtual", "signal-A");
const a = CC(5 * A);
const b = new Network();
when(a > 0).then(a, 2 * A, b);`,
    });
    const plan = executeElaborationProgram(transformElaborationModule(parsed));
    const decider = plan.producers[1];
    const execution = elaborateDirectPlan(plan);
    const simulation = execution.circuit.createSimulation();
    const unused = execution.network('$unused:1');

    expect(decider).toMatchObject({ kind: 'decider', destinations: [{ network: '$unused:1' }] });
    expect(plan.diagnostics).toContainEqual(
      expect.objectContaining({ code: 'CL2001', severity: 'warning' }),
    );
    expect(decider?.kind === 'decider' ? decider.outputs : undefined).toHaveLength(3);
    expect(execution.circuit.ir.producers[1]).toMatchObject({
      kind: 'decider',
      config: { outputs: [{}, {}, {}] },
    });
    simulation.step();
    expect(simulation.step().read(unused.id).get(signal('virtual', 'signal-A'))).toBe(7);
  });

  test('preserves per-Each concrete-copy and constant row multiplicity end to end', () => {
    const parsed = parseFile({
      path: 'each-concrete-copy.factorio.ts',
      text: `const A = Signal("virtual", "signal-A");
const B = Signal("virtual", "signal-B");
const C = Signal("virtual", "signal-C");
const D = Signal("virtual", "signal-D");
const input = CC(10 * B, 20 * C, -5 * D);
const output: Network = when(input != 0).then(input[A], 1 * A);`,
    });
    const plan = executeElaborationProgram(transformElaborationModule(parsed));
    const execution = elaborateDirectPlan(plan);
    const output = execution.network('output');
    const decider = plan.producers.find(({ kind }) => kind === 'decider');

    expect(decider?.kind === 'decider' ? decider.outputs : undefined).toMatchObject([
      { kind: 'signal', signal: signal('virtual', 'signal-A') },
      { kind: 'signal-constant', signal: signal('virtual', 'signal-A'), value: 1 },
    ]);
    expect(execution.circuit.ir.producers.find(({ kind }) => kind === 'decider')).toMatchObject({
      config: {
        outputs: [
          { mode: 'copy', signal: { kind: 'signal', signal: signal('virtual', 'signal-A') } },
          {
            mode: 'constant',
            signal: { kind: 'signal', signal: signal('virtual', 'signal-A') },
            value: 1,
          },
        ],
      },
    });

    const simulation = execution.circuit.createSimulation();
    simulation.step();
    expect(simulation.step().read(output.id).get(signal('virtual', 'signal-A'))).toBe(28);
  });

  test('retains Each concrete-copy semantics for generated conditions and outputs', () => {
    const parsed = parseFile({
      path: 'generated-each-concrete-copy.factorio.ts',
      text: `const A = Signal("virtual", "signal-A");
const B = Signal("virtual", "signal-B");
const C = Signal("virtual", "signal-C");
const D = Signal("virtual", "signal-D");
function BuildCondition(input: Readonly<Network>) {
  const parts = [];
  for (const threshold of [0]) parts.push(input != threshold);
  return parts[0];
}
const input = CC(10 * B, 20 * C, -5 * D);
const outputRows = [];
for (const mode of ["copy", "constant"]) {
  outputRows.push(mode === "copy" ? input[A] : 1 * A);
}
const output: Network = when(BuildCondition(input)).then(...outputRows);`,
    });
    expect(validateDslSemantics(parsed)).toEqual([]);
    const plan = executeElaborationProgram(transformElaborationModule(parsed));
    const execution = elaborateDirectPlan(plan);
    const simulation = execution.circuit.createSimulation();
    simulation.step();

    expect(
      simulation.step().read(execution.network('output').id).get(signal('virtual', 'signal-A')),
    ).toBe(28);
  });

  test.each([
    {
      name: 'Each output without an Each condition',
      condition: 'input[A] > 0',
      row: 'input',
      message: 'Each output requires a final condition set that uses Each',
    },
    {
      name: 'Everything output with an Each condition',
      condition: 'input > 0',
      row: 'Everything(input)',
      message: 'Everything output is invalid when the final condition set uses Each',
    },
  ])('validates generated Decider modes after execution: $name', ({ condition, row, message }) => {
    const parsed = parseFile({
      path: 'generated-invalid-decider-mode.factorio.ts',
      text: `const A = Signal("virtual", "signal-A");
const input = new Network();
const rows = [];
for (const enabled of [true]) {
  if (enabled) rows.push(${row});
}
const output: Network = when(${condition}).then(...rows);`,
    });
    expect(validateDslSemantics(parsed)).toEqual([]);
    const plan = executeElaborationProgram(transformElaborationModule(parsed));
    const result = tryElaborateDirectPlan(plan);

    expect(result.execution).toBeUndefined();
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        code: 'RT2027',
        severity: 'error',
        message: expect.stringContaining(message),
        span: expect.any(Object),
      }),
    ]);
  });

  test('executes fluent deciders, wildcards, output binding, and method fan-out', () => {
    const parsed = parseFile({
      path: 'surface.factorio.ts',
      text: `const A = Signal("virtual", "signal-A");
const input = new Network();
const selected: Network = when(Any(input) > 0).then(input[A]);
const painted: Network = IF(input > 0, 2 * EACH);
const rebound: Network = (input + 1).as(A);
const first = new Network();
const second = new Network();
(input + 2).to(first, second);`,
    });
    const plan = executeElaborationProgram(transformElaborationModule(parsed));
    const execution = elaborateDirectPlan(plan);

    expect(plan.producers).toHaveLength(4);
    expect(plan.producers.filter(({ kind }) => kind === 'decider')).toHaveLength(2);
    expect(execution.circuit.graph.attachments).toHaveLength(5);
    expect(generateBlueprintJson(execution.circuit.ir).blueprint.entities).toHaveLength(4);
  });

  test('does not leak .as across a function Network return boundary', () => {
    const call = 'Gate(input).as(A)';
    const parsed = parseFile({
      path: 'function-return-as.factorio.ts',
      text: `const A = Signal('virtual', 'signal-A');
function Gate(input: Readonly<Network>): Network {
  return IF(input > 0, input);
}
const input = new Network();
const output: Network = ${call};`,
    });

    expect(() => executeElaborationProgram(transformElaborationModule(parsed))).toThrowError(
      ElaborationExecutionError,
    );
    try {
      executeElaborationProgram(transformElaborationModule(parsed));
      expect.fail('Expected the function return boundary to reject .as(...).');
    } catch (error) {
      expect(error).toBeInstanceOf(ElaborationExecutionError);
      const failure = error as ElaborationExecutionError;
      expect(failure.code).toBe('RT2021');
      expect(parsed.text.slice(failure.span.start, failure.span.end)).toBe(call);
      expect(failure.related).toHaveLength(1);
    }
  });

  test('keeps .as valid inside the function that creates the producer', () => {
    const parsed = parseFile({
      path: 'local-producer-as.factorio.ts',
      text: `const A = Signal('virtual', 'signal-A');
function Gate(input: Readonly<Network>): Network {
  return IF(input > 0, input).as(A);
}
const input = new Network();
const output: Network = Gate(input);`,
    });
    const plan = executeElaborationProgram(transformElaborationModule(parsed));

    expect(plan.producers[0]).toMatchObject({
      kind: 'decider',
      output: { kind: 'signal', signal: { type: 'virtual', name: 'signal-A' } },
    });
  });

  test('binds one concrete output Signal through the final .to(...) argument', () => {
    const parsed = parseFile({
      path: 'selected-to.factorio.ts',
      text: `const A = Signal("virtual", "signal-A");
const input = new Network();
const first = new Network();
const second = new Network();
(input + 1).to(first, second, A);`,
    });
    const plan = executeElaborationProgram(transformElaborationModule(parsed));

    expect(plan.producers).toMatchObject([
      {
        kind: 'arithmetic',
        output: { kind: 'signal', signal: { type: 'virtual', name: 'signal-A' } },
        destinations: [{ network: 'first' }, { network: 'second' }],
      },
    ]);
    const execution = elaborateDirectPlan(plan);
    const colors = new Map(execution.circuit.ir.networks.map(({ name, color }) => [name, color]));
    expect(colors.get('first')).not.toBe(colors.get('second'));
  });

  test('binds a free fan-out destination through to(...)[SIGNAL]', () => {
    const parsed = parseFile({
      path: 'selected-free-to.factorio.ts',
      text: `const A = Signal('virtual', 'signal-A');
const input = new Network();
const first = new Network();
const second = new Network();
to(first, second)[A] += input + 1;`,
    });
    const plan = executeElaborationProgram(transformElaborationModule(parsed));

    expect(plan.producers[0]).toMatchObject({
      kind: 'arithmetic',
      output: { kind: 'signal', signal: { type: 'virtual', name: 'signal-A' } },
      destinations: [{ network: 'first' }, { network: 'second' }],
    });
  });

  test('stores an explicitly typed DeciderCombinator without materializing it', () => {
    const parsed = parseFile({
      path: 'stored-decider.factorio.ts',
      text: `const A = Signal('virtual', 'signal-A');
const input = new Network();
let comb: DeciderCombinator = when(input > 0).then(input);
const output = new Network();
output += comb.as(A);`,
    });
    const plan = executeElaborationProgram(transformElaborationModule(parsed));

    expect(plan.producers).toHaveLength(1);
    expect(plan.producers[0]).toMatchObject({
      kind: 'decider',
      output: { kind: 'signal', signal: { type: 'virtual', name: 'signal-A' } },
      destinations: [{ network: 'output' }],
    });
    expect(plan.networks.map(({ name }) => name)).not.toContain('comb');
  });

  test('preserves producer methods through a DeciderCombinator function return', () => {
    const parsed = parseFile({
      path: 'returned-decider.factorio.ts',
      text: `const A = Signal('virtual', 'signal-A');
function Gate(input: Readonly<Network>): DeciderCombinator {
  return when(input > 0).then(input);
}
const input = new Network();
const output = new Network();
output += Gate(input).as(A);`,
    });
    const plan = executeElaborationProgram(transformElaborationModule(parsed));

    expect(plan.producers[0]).toMatchObject({
      kind: 'decider',
      output: { kind: 'signal', signal: { type: 'virtual', name: 'signal-A' } },
      destinations: [{ network: 'output' }],
    });
  });

  test('rejects a materialized Network at the combinator return boundary', () => {
    const returned = 'return tmp;';
    const parsed = parseFile({
      path: 'materialized-producer-return.factorio.ts',
      text: `function test(input: Readonly<Network>): ArithmeticCombinator {
  let tmp = input + 0;
  ${returned}
}
const input = new Network();
const output = test(input);`,
    });

    try {
      executeElaborationProgram(transformElaborationModule(parsed));
      expect.fail('Expected the combinator return contract to reject a Network.');
    } catch (error) {
      expect(error).toBeInstanceOf(ElaborationExecutionError);
      const failure = error as ElaborationExecutionError;
      expect(failure.code).toBe('RT2022');
      expect(parsed.text.slice(failure.span.start, failure.span.end)).toBe(returned);
    }
  });

  test('checks the concrete combinator kind at annotated declarations', () => {
    const declaration = 'let comb: ArithmeticCombinator = when(input > 0).then(input);';
    const parsed = parseFile({
      path: 'wrong-producer-kind.factorio.ts',
      text: `const input = new Network();
${declaration}`,
    });

    try {
      executeElaborationProgram(transformElaborationModule(parsed));
      expect.fail('Expected the concrete producer kind check to fail.');
    } catch (error) {
      expect(error).toBeInstanceOf(ElaborationExecutionError);
      const failure = error as ElaborationExecutionError;
      expect(failure.code).toBe('RT2022');
      expect(parsed.text.slice(failure.span.start, failure.span.end)).toBe(
        declaration.slice(4, -1),
      );
    }
  });

  test('preserves producers assigned into dynamic array and object slots', () => {
    const parsed = parseFile({
      path: 'container-producer.factorio.ts',
      text: `function fromArray(input: Readonly<Network>): ArithmeticCombinator {
  let tmp = [];
  tmp[1] = input + 0;
  return tmp[1];
}
function fromObject(input: Readonly<Network>): ArithmeticCombinator {
  let tmp = {};
  tmp.value = input + 1;
  return tmp.value;
}
const input = new Network();
const first: Network = fromArray(input);
const second: Network = fromObject(input);`,
    });
    const plan = executeElaborationProgram(transformElaborationModule(parsed));

    expect(plan.diagnostics).toEqual([]);
    expect(plan.producers).toMatchObject([
      { kind: 'arithmetic', destinations: [{ network: 'first' }] },
      { kind: 'arithmetic', destinations: [{ network: 'second' }] },
    ]);
  });

  test('warns after execution when a producer remains unused in a dynamic container', () => {
    const expression = 'input + 0';
    const parsed = parseFile({
      path: 'unused-container-producer.factorio.ts',
      text: `const input = new Network();
const tmp = [];
tmp[1] = ${expression};`,
    });
    const plan = executeElaborationProgram(transformElaborationModule(parsed));
    const warning = plan.diagnostics?.find(({ code }) => code === 'CL2001');

    expect(plan.producers).toHaveLength(1);
    expect(plan.producers[0]).toMatchObject({
      kind: 'arithmetic',
      destinations: [{ network: '$unused:1' }],
    });
    expect(warning).toMatchObject({ severity: 'warning', span: expect.any(Object) });
    expect(parsed.text.slice(warning!.span!.start, warning!.span!.end)).toBe(expression);
  });

  test('does not finalize an ignored Producer alias before a later attachment', () => {
    const parsed = parseFile({
      path: 'ignored-producer-alias.factorio.ts',
      text: `function same(value: ArithmeticCombinator): ArithmeticCombinator {
  return value;
}
const input = new Network();
const producer: ArithmeticCombinator = input + 1;
same(producer);
const output = new Network();
producer.to(output);`,
    });
    const plan = executeElaborationProgram(transformElaborationModule(parsed));

    expect(plan.diagnostics).toEqual([]);
    expect(plan.producers).toMatchObject([
      { kind: 'arithmetic', destinations: [{ network: 'output' }] },
    ]);
  });

  test('keeps one physical Producer identity across aliases and fluent wrappers', () => {
    const secondAttachment = 'second += configured;';
    const parsed = parseFile({
      path: 'producer-identity.factorio.ts',
      text: `const A = Signal('virtual', 'signal-A');
const input = new Network();
const producer: ArithmeticCombinator = input + 0;
const configured: ArithmeticCombinator = producer.as(A);
const first = new Network();
const second = new Network();
first += producer;
${secondAttachment}`,
    });

    try {
      executeElaborationProgram(transformElaborationModule(parsed));
      expect.fail('Expected one physical Producer to reject a second attachment.');
    } catch (error) {
      expect(error).toBeInstanceOf(ElaborationExecutionError);
      const failure = error as ElaborationExecutionError;
      expect(failure.code).toBe('RT2006');
      expect(parsed.text.slice(failure.span.start, failure.span.end)).toBe(
        secondAttachment.slice(0, -1),
      );
      expect(failure.related).toHaveLength(2);
    }
  });

  test('preserves Producer identity and concrete kind through function parameters', () => {
    const parsed = parseFile({
      path: 'producer-parameter.factorio.ts',
      text: `const A = Signal('virtual', 'signal-A');
function Configure(value: ArithmeticCombinator): ArithmeticCombinator {
  return value.as(A);
}
const input = new Network();
const producer: ArithmeticCombinator = input + 0;
const configured: ArithmeticCombinator = Configure(producer);
const output = new Network();
output += configured;`,
    });
    const plan = executeElaborationProgram(transformElaborationModule(parsed));

    expect(plan.diagnostics).toEqual([]);
    expect(plan.producers).toMatchObject([
      {
        kind: 'arithmetic',
        output: { kind: 'signal', signal: { type: 'virtual', name: 'signal-A' } },
        destinations: [{ network: 'output' }],
      },
    ]);
  });

  test('checks a dynamically selected value at the Producer parameter boundary', () => {
    const parameter = 'value: ArithmeticCombinator';
    const parsed = parseFile({
      path: 'dynamic-producer-parameter.factorio.ts',
      text: `function Configure(${parameter}): ArithmeticCombinator {
  return value;
}
const input = new Network();
const values = [when(input > 0).then(input)];
const output = Configure(values[0]);`,
    });

    try {
      executeElaborationProgram(transformElaborationModule(parsed));
      expect.fail('Expected the concrete Producer parameter kind check to fail.');
    } catch (error) {
      expect(error).toBeInstanceOf(ElaborationExecutionError);
      const failure = error as ElaborationExecutionError;
      expect(failure.code).toBe('RT2022');
      expect(parsed.text.slice(failure.span.start, failure.span.end)).toBe(parameter);
    }
  });

  test('validates Producer handles in typed array and object destructuring', () => {
    const parsed = parseFile({
      path: 'producer-destructuring.factorio.ts',
      text: `const input = new Network();
const arithmetic: ArithmeticCombinator = input + 0;
const decider: DeciderCombinator = when(input > 0).then(input);
const values = [arithmetic, decider];
let [firstProducer, secondProducer]: [ArithmeticCombinator, DeciderCombinator] = values;
const record = {producer: secondProducer, label: 'gate'};
let {producer, label}: {producer: DeciderCombinator, label: string} = record;
const first = new Network();
const second = new Network();
first += firstProducer;
second += producer;`,
    });
    const plan = executeElaborationProgram(transformElaborationModule(parsed));

    expect(plan.diagnostics).toEqual([]);
    expect(plan.producers).toMatchObject([
      { kind: 'arithmetic', destinations: [{ network: 'first' }] },
      { kind: 'decider', destinations: [{ network: 'second' }] },
    ]);
  });

  test('rejects a wrong dynamic Producer kind in typed destructuring', () => {
    const declaration = 'let [producer]: [ArithmeticCombinator] = values;';
    const parsed = parseFile({
      path: 'wrong-producer-destructuring.factorio.ts',
      text: `const input = new Network();
const values = [when(input > 0).then(input)];
${declaration}`,
    });

    try {
      executeElaborationProgram(transformElaborationModule(parsed));
      expect.fail('Expected typed Producer destructuring to validate the concrete kind.');
    } catch (error) {
      expect(error).toBeInstanceOf(ElaborationExecutionError);
      const failure = error as ElaborationExecutionError;
      expect(failure.code).toBe('RT2022');
      expect(parsed.text.slice(failure.span.start, failure.span.end)).toBe(
        declaration.slice(4, -1),
      );
    }
  });

  test('does not reinterpret one Producer as several Producer handles', () => {
    const declaration =
      'let [first, second]: [ArithmeticCombinator, ArithmeticCombinator] = input + 0;';
    const parsed = parseFile({
      path: 'cloned-producer-destructuring.factorio.ts',
      text: `const input = new Network();
${declaration}`,
    });

    expect(() => executeElaborationProgram(transformElaborationModule(parsed))).toThrowError(
      'A single Producer cannot be destructured into Producer handles',
    );
  });

  test('keeps Signal-shaped ordinary objects in the JavaScript value domain', () => {
    const parsed = parseFile({
      path: 'signal-lookalike.factorio.ts',
      text: `const lookalike = { type: "virtual", name: "signal-A" };
const product = 5 * lookalike;
if (!Number.isNaN(product)) throw new Error("Signal lookalike entered DSL dispatch");`,
    });

    expect(executeElaborationProgram(transformElaborationModule(parsed)).producers).toEqual([]);
  });

  test('does not accept a structural Signal lookalike as a Network selection', () => {
    const parsed = parseFile({
      path: 'forged-signal.factorio.ts',
      text: `const lookalike = { type: "virtual", name: "signal-A" };
const input = new Network();
input[lookalike];`,
    });

    expect(() => executeElaborationProgram(transformElaborationModule(parsed))).toThrow(
      /Network selection requires a Signal or wildcard/,
    );
  });

  test('exposes a frozen Network handle without mutable ownership internals', () => {
    const parsed = parseFile({
      path: 'opaque-network.factorio.ts',
      text: `const input = new Network();
if ("ownership" in input || "borrow" in input || !Object.isFrozen(input)) {
  throw new Error("Network internals are visible");
}
if (Reflect.set(input, "generation", 99) || Reflect.set(input, "ownership", {})) {
  throw new Error("Network handle accepted mutation");
}
const output = input + 1;`,
    });
    const plan = executeElaborationProgram(transformElaborationModule(parsed));

    expect(plan.producers).toMatchObject([{ kind: 'arithmetic' }]);
    expect(plan.networks.map(({ name }) => name)).toEqual(['input', 'output']);
  });

  test('cannot revive a moved Network alias by mutating its frozen generation snapshot', () => {
    const expression = 'alias + 0';
    const parsed = parseFile({
      path: 'opaque-moved-network.factorio.ts',
      text: `function Pass(input: Move<Network>): Network { return input; }
let input = new Network();
const alias = input;
input = Pass(input);
Reflect.set(alias, "generation", input.generation);
${expression};`,
    });

    try {
      executeElaborationProgram(transformElaborationModule(parsed));
      expect.fail('Expected the stale Network alias to remain invalid.');
    } catch (error) {
      expect(error).toMatchObject({ code: 'RT2012', span: expect.any(Object) });
      const failure = error as ElaborationExecutionError;
      expect(parsed.text.slice(failure.span.start, failure.span.end)).toBe(expression);
    }
  });

  test.each([
    ['if', 'if (input > 0) {}', 'input > 0'],
    ['conditional expression', 'const value = input > 0 ? 1 : 2;', 'input > 0'],
    ['while', 'while (input > 0) {}', 'input > 0'],
    ['do-while', 'do {} while (input > 0);', 'input > 0'],
    ['for condition', 'for (; input > 0;) {}', 'input > 0'],
  ])(
    'rejects a circuit Condition used by JavaScript %s control flow',
    (_kind, statement, testText) => {
      const parsed = parseFile({
        path: 'circuit-control-flow.factorio.ts',
        text: `const input = new Network();\n${statement}`,
      });

      try {
        executeElaborationProgram(transformElaborationModule(parsed));
        expect.fail('Expected circuit Condition control flow to be rejected.');
      } catch (error) {
        expect(error).toMatchObject({ code: 'RT2024', span: expect.any(Object) });
        const failure = error as ElaborationExecutionError;
        expect(parsed.text.slice(failure.span.start, failure.span.end)).toBe(testText);
      }
    },
  );

  test('preserves JavaScript truthiness for unary not and guarded control-flow tests', () => {
    const parsed = parseFile({
      path: 'ordinary-truthiness.factorio.ts',
      text: `const zero = !0;
const empty = !"";
const nil = !null;
const object = !{};
const array = ![];
const one = !1;
const selected = zero ? 7 : 9;
let iterations = 0;
while (iterations < 2) iterations++;
do iterations++; while (false);
for (let i = 0; i < 2; i++) iterations++;
if (!zero || !empty || !nil || object || array || one || selected !== 7 || iterations !== 5) {
  throw new Error("ordinary JavaScript truthiness changed");
}`,
    });

    expect(executeElaborationProgram(transformElaborationModule(parsed)).producers).toEqual([]);
  });

  test('validates later writes to direct, array, and object Producer slots', () => {
    const parsed = parseFile({
      path: 'producer-assignments.factorio.ts',
      text: `const A = Signal('virtual', 'signal-A');
const input = new Network();
let direct: ArithmeticCombinator;
direct = input + 0;
let slots: DeciderCombinator[] = [];
slots[0] = when(input > 0).then(input);
let record: {constant: ConstantCombinator} = {};
record.constant = CC(1 * A);
{
  let direct = 1;
  direct = 2;
}
const first = new Network();
const second = new Network();
const third = new Network();
first += direct;
second += slots[0];
third += record.constant;`,
    });
    const plan = executeElaborationProgram(transformElaborationModule(parsed));

    expect(plan.diagnostics).toEqual([]);
    expect(plan.producers).toMatchObject([
      { kind: 'arithmetic', destinations: [{ network: 'first' }] },
      { kind: 'decider', destinations: [{ network: 'second' }] },
      { kind: 'constant', destinations: [{ network: 'third' }] },
    ]);
  });

  test('checks a dynamically selected value at a typed Producer assignment boundary', () => {
    const assigned = 'values[0]';
    const parsed = parseFile({
      path: 'dynamic-producer-assignment.factorio.ts',
      text: `const input = new Network();
const values = [when(input > 0).then(input)];
let slots: ArithmeticCombinator[] = [];
slots[0] = ${assigned};`,
    });

    try {
      executeElaborationProgram(transformElaborationModule(parsed));
      expect.fail('Expected the typed Producer assignment check to fail.');
    } catch (error) {
      expect(error).toBeInstanceOf(ElaborationExecutionError);
      const failure = error as ElaborationExecutionError;
      expect(failure.code).toBe('RT2022');
      expect(parsed.text.slice(failure.span.start, failure.span.end)).toBe(assigned);
    }
  });

  test('binds one concrete output Signal through a single selected .to(...) destination', () => {
    const parsed = parseFile({
      path: 'single-selected-to.factorio.ts',
      text: `const A = Signal("virtual", "signal-A");
const input = new Network();
const output = new Network();
(input + 0).to(output[A]);`,
    });
    const plan = executeElaborationProgram(transformElaborationModule(parsed));
    expect(plan.producers[0]).toMatchObject({
      kind: 'arithmetic',
      output: { kind: 'signal', signal: { type: 'virtual', name: 'signal-A' } },
      destinations: [{ network: 'output' }],
    });
  });

  test('lets a destination override inferred arithmetic output but not an explicit .as signal', () => {
    const inferred = parseFile({
      path: 'inferred-output.factorio.ts',
      text: `const A = Signal("virtual", "signal-A");
const B = Signal("virtual", "signal-B");
const input = new Network();
const output = new Network();
(input[A] + 1).to(output[B]);`,
    });
    const plan = executeElaborationProgram(transformElaborationModule(inferred));
    expect(plan.producers[0]).toMatchObject({
      kind: 'arithmetic',
      output: { kind: 'signal', signal: { type: 'virtual', name: 'signal-B' } },
    });

    const conflictingCall = '(input[A] + 1).as(A).to(output[B])';
    const conflicting = parseFile({
      path: 'explicit-output-conflict.factorio.ts',
      text: `const A = Signal("virtual", "signal-A");
const B = Signal("virtual", "signal-B");
const input = new Network();
const output = new Network();
${conflictingCall};`,
    });
    expect(() => executeElaborationProgram(transformElaborationModule(conflicting))).toThrowError(
      'Explicit producer output Signal conflicts with its destination binding.',
    );
    try {
      executeElaborationProgram(transformElaborationModule(conflicting));
      expect.fail('Expected an explicit output conflict.');
    } catch (error) {
      expect(error).toBeInstanceOf(ElaborationExecutionError);
      const failure = error as ElaborationExecutionError;
      expect(failure.code).toBe('RT2023');
      expect(failure.related).toHaveLength(2);
      const span = failure.span;
      expect(conflicting.text.slice(span.start, span.end)).toBe(conflictingCall);
    }
  });

  test('uses one attachment path for +=, free to, fluent to, and contextual fan-out', () => {
    const parsed = parseFile({
      path: 'attachment-matrix.factorio.ts',
      text: `const A = Signal('virtual', 'signal-A');
const input = new Network();
const direct = new Network();
direct += input + 0;
const freeFirst = new Network();
const freeSecond = new Network();
to(freeFirst, freeSecond)[A] += input + 1;
const fluentFirst = new Network();
const fluentSecond = new Network();
(input + 2).to(fluentFirst, fluentSecond, A);
let [left, right] = input + 3;`,
    });
    const plan = executeElaborationProgram(transformElaborationModule(parsed));
    const execution = elaborateDirectPlan(plan);

    expect(plan.producers).toMatchObject([
      { kind: 'arithmetic', destinations: [{ network: 'direct' }] },
      {
        kind: 'arithmetic',
        output: { kind: 'signal', signal: { type: 'virtual', name: 'signal-A' } },
        destinations: [{ network: 'freeFirst' }, { network: 'freeSecond' }],
      },
      {
        kind: 'arithmetic',
        output: { kind: 'signal', signal: { type: 'virtual', name: 'signal-A' } },
        destinations: [{ network: 'fluentFirst' }, { network: 'fluentSecond' }],
      },
      { kind: 'arithmetic', destinations: [{ network: 'left' }, { network: 'right' }] },
    ]);
    const colors = new Map(execution.circuit.ir.networks.map(({ name, color }) => [name, color]));
    for (const [first, second] of [
      ['freeFirst', 'freeSecond'],
      ['fluentFirst', 'fluentSecond'],
      ['left', 'right'],
    ] as const) {
      expect(colors.get(first)).not.toBe(colors.get(second));
    }
  });

  test('reports common destination cardinality diagnostics before direct-plan lowering', () => {
    const cases = [
      {
        code: 'RT2003',
        expression: '(input + 0).to(...targets)',
        targets: 'const targets = [];',
      },
      {
        code: 'RT2004',
        expression: '(input + 0).to(output, alias)',
        targets: 'const targets = [];\nconst alias = output;',
      },
      {
        code: 'RT2005',
        expression: '(input + 0).to(...targets)',
        targets: 'const targets = [output, new Network(), new Network()];',
      },
    ] as const;

    for (const expected of cases) {
      const parsed = parseFile({
        path: `${expected.code}.factorio.ts`,
        text: `const input = new Network();
const output = new Network();
${expected.targets}
${expected.expression};`,
      });
      try {
        executeElaborationProgram(transformElaborationModule(parsed));
        expect.fail(`Expected ${expected.code}.`);
      } catch (error) {
        expect(error).toBeInstanceOf(ElaborationExecutionError);
        const failure = error as ElaborationExecutionError;
        expect(failure.code).toBe(expected.code);
        expect(parsed.text.slice(failure.span.start, failure.span.end)).toBe(expected.expression);
        if (expected.code !== 'RT2003') expect(failure.related?.length).toBeGreaterThan(0);
      }
    }
  });

  test('uses RT2023 for output binding conflicts across every attachment spelling', () => {
    const cases = [
      'output[B] += (input + 0).as(A)',
      'to(output)[B] += (input + 0).as(A)',
      '(input + 0).as(A).to(output, B)',
    ] as const;

    for (const expression of cases) {
      const parsed = parseFile({
        path: 'output-binding-conflict.factorio.ts',
        text: `const A = Signal('virtual', 'signal-A');
const B = Signal('virtual', 'signal-B');
const input = new Network();
const output = new Network();
${expression};`,
      });
      try {
        executeElaborationProgram(transformElaborationModule(parsed));
        expect.fail('Expected an output binding conflict.');
      } catch (error) {
        expect(error).toBeInstanceOf(ElaborationExecutionError);
        const failure = error as ElaborationExecutionError;
        expect(failure.code).toBe('RT2023');
        expect(parsed.text.slice(failure.span.start, failure.span.end)).toBe(expression);
        expect(failure.related).toHaveLength(2);
      }
    }
  });

  test('rejects constant and multi-output decider rebinding with RT2023', () => {
    const expressions = [
      'to(output)[A] += CC(1 * A)',
      'when(input > 0).then(input, input).to(output, A)',
    ] as const;

    for (const expression of expressions) {
      const parsed = parseFile({
        path: 'unsupported-output-rebinding.factorio.ts',
        text: `const A = Signal('virtual', 'signal-A');
const input = new Network();
const output = new Network();
${expression};`,
      });
      try {
        executeElaborationProgram(transformElaborationModule(parsed));
        expect.fail('Expected output rebinding to fail.');
      } catch (error) {
        expect(error).toBeInstanceOf(ElaborationExecutionError);
        const failure = error as ElaborationExecutionError;
        expect(failure.code).toBe('RT2023');
        expect(parsed.text.slice(failure.span.start, failure.span.end)).toBe(expression);
      }
    }
  });

  test('rejects selected .to(...) destinations and preserves the call span', () => {
    const call = '(input + 0).to(output[A], tmp[Signal("virtual", "signal-A")])';
    const parsed = parseFile({
      path: 'selected-to.factorio.ts',
      text: `const A = Signal("virtual", "signal-A");
const input = new Network();
const output = new Network();
const tmp = new Network();
${call};`,
    });

    try {
      executeElaborationProgram(transformElaborationModule(parsed));
      expect.fail('Expected selected destinations to be rejected.');
    } catch (error) {
      expect(error).toBeInstanceOf(ElaborationExecutionError);
      expect((error as ElaborationExecutionError).message).toContain(
        'Network[SIGNAL] only for one destination',
      );
      const span = (error as ElaborationExecutionError).span;
      expect(parsed.text.slice(span.start, span.end)).toBe(call);
    }
  });

  test('binds a helper fan-out output Signal through to(...)[SIGNAL]', () => {
    const parsed = parseFile({
      path: 'helper-signal-to.factorio.ts',
      text: `const A = Signal("virtual", "signal-A");
const input = new Network();
const first = new Network();
const second = new Network();
to(first, second)[A] += input + 1;`,
    });
    const plan = executeElaborationProgram(transformElaborationModule(parsed));
    expect(plan.producers[0]).toMatchObject({
      kind: 'arithmetic',
      output: { kind: 'signal', signal: { type: 'virtual', name: 'signal-A' } },
      destinations: [{ network: 'first' }, { network: 'second' }],
    });
  });

  test('executes a structural MemoCell function with boolean conditions and feedback', () => {
    const parsed = parseFile({
      path: 'memo.factorio.ts',
      text: `const A = Signal("virtual", "signal-A");
function MemoCell(input: Readonly<Network>): Network {
  let out = new Network();
  let mem = new Network();
  to(out, mem) += input + 0;
  to(out, mem) += IF(input == 0 && mem != 0, mem);
  return out;
}
let input: Network = CC(42 * A);
let output = MemoCell(input);`,
    });
    const plan = executeElaborationProgram(transformElaborationModule(parsed));
    const execution = elaborateDirectPlan(plan);

    expect(plan.producers).toHaveLength(3);
    expect(plan.producers.filter(({ kind }) => kind === 'arithmetic')).toHaveLength(1);
    expect(plan.producers.filter(({ kind }) => kind === 'decider')).toHaveLength(1);
    expect(execution.circuit.graph.attachments).toHaveLength(5);
    expect(plan.producers[1]?.instancePath).toEqual(['function MemoCell']);
  });

  test('executes composed functions, selections, colors, CC, and multi-destination attachment', () => {
    const parsed = parseFile({
      path: 'composed.factorio.ts',
      text: `const SIGNAL_A = Signal("virtual", "signal-A");
function Scale(input: Readonly<Network>): Network {
  const factor = 2 + 3;
  const scaled = input * factor;
  return scaled + 1;
}
function Bias(input: Readonly<Network>): Network {
  const bias = 10 / 2;
  return input + bias;
}
function Gate(input: Readonly<Network>, threshold: Readonly<Network>): Network {
  return IF(input[SIGNAL_A] > threshold[SIGNAL_A], input[SIGNAL_A]);
}
const input = new Network<R>();
const middle: Network = Scale(input);
const biased: Network = Bias(middle);
const threshold = new Network();
threshold += CC(40 * SIGNAL_A);
const output = new Network();
const mirror = new Network();
to(output, mirror)[SIGNAL_A] += Gate(biased, threshold);`,
    });
    const plan = executeElaborationProgram(transformElaborationModule(parsed));
    const execution = elaborateDirectPlan(plan);
    const colors = new Map(execution.circuit.ir.networks.map(({ name, color }) => [name, color]));

    expect(plan.producers).toHaveLength(5);
    expect(plan.producers[0]?.instancePath).toEqual(['function Scale']);
    expect(plan.producers[2]?.instancePath).toEqual(['function Bias']);
    expect(plan.producers[4]?.instancePath).toEqual(['function Gate']);
    expect(colors.get('input')).toBe('red');
    expect(colors.get('output')).not.toBe(colors.get('mirror'));
    expect(generateBlueprintJson(execution.circuit.ir).blueprint.entities).toHaveLength(5);
  });

  test('accepts an inline Signal factory inside a contextual CC entry', () => {
    const parsed = parseFile({
      path: 'inline-signal.factorio.ts',
      text: `let input: Network = CC(5 * Signal("virtual", "signal-A"));`,
    });
    const plan = executeElaborationProgram(transformElaborationModule(parsed));

    expect(plan.networks.map(({ name }) => name)).toEqual(['input']);
    expect(plan.producers).toMatchObject([
      {
        kind: 'constant',
        outputs: [{ signal: { type: 'virtual', name: 'signal-A' }, value: 5 }],
      },
    ]);
  });

  test('uses the default item type for Signal(name) and omits it from blueprint JSON', () => {
    const parsed = parseFile({
      path: 'name-only-signal.factorio.ts',
      text: `const CHEST = Signal("chest");
const input = CC(5 * CHEST);`,
    });

    expect(validateDslSemantics(parsed)).toEqual([]);
    const plan = executeElaborationProgram(transformElaborationModule(parsed));
    expect(plan.producers[0]).toMatchObject({
      kind: 'constant',
      outputs: [{ signal: { type: 'item', name: 'chest' }, value: 5 }],
    });

    const entity = generateBlueprintJson(elaborateDirectPlan(plan).circuit.ir).blueprint
      .entities[0];
    expect(JSON.stringify(entity)).not.toContain('"type":"item"');
  });

  test('validates dynamic Signal arguments at execution time', () => {
    const call = 'Signal(values[0], values[1])';
    const parsed = parseFile({
      path: 'dynamic-signal.factorio.ts',
      text: `const values = [5, "signal-A"];
const A = ${call};`,
    });

    try {
      executeElaborationProgram(transformElaborationModule(parsed));
      expect.fail('Expected dynamic non-string Signal arguments to be rejected.');
    } catch (error) {
      expect(error).toBeInstanceOf(ElaborationExecutionError);
      expect((error as ElaborationExecutionError).message).toContain(
        'Signal(...) arguments must evaluate to strings',
      );
      const span = (error as ElaborationExecutionError).span;
      expect(parsed.text.slice(span.start, span.end)).toBe(call);
    }
  });

  test('preserves an optional Signal quality through executed elaboration', () => {
    const parsed = parseFile({
      path: 'quality-signal.factorio.ts',
      text: `const A = Signal("virtual", "signal-A", "legendary");
const input = CC(5 * A);`,
    });
    const plan = executeElaborationProgram(transformElaborationModule(parsed));

    expect(plan.producers[0]).toMatchObject({
      kind: 'constant',
      outputs: [
        {
          signal: { type: 'virtual', name: 'signal-A', quality: 'legendary' },
          value: 5,
        },
      ],
    });
  });

  test('materializes untyped producer declarations from their runtime values', () => {
    const parsed = parseFile({
      path: 'inferred-producers.factorio.ts',
      text: `const A = Signal("virtual", "signal-A");
const input = CC(5 * A);
const tmp = IF(input < 10, 1 * A);
const output = tmp * 2 + 1;`,
    });
    const plan = executeElaborationProgram(transformElaborationModule(parsed));

    expect(plan.networks.map(({ name }) => name)).toEqual(['input', 'tmp', '$tmp:1', 'output']);
    expect(plan.producers.filter(({ kind }) => kind === 'constant')).toHaveLength(1);
    expect(plan.producers.filter(({ kind }) => kind === 'decider')).toHaveLength(1);
    expect(plan.producers.filter(({ kind }) => kind === 'arithmetic')).toHaveLength(2);
  });

  test('reuses one materialized Producer result without cloning its hardware', () => {
    const parsed = parseFile({
      path: 'producer-reuse.factorio.ts',
      text: `const input = new Network();
const dx = input - 1;
const squared = dx * dx;
const biased = dx + 10;`,
    });
    const plan = executeElaborationProgram(transformElaborationModule(parsed));

    expect(plan.producers).toHaveLength(3);
    expect(plan.producers[0]).toMatchObject({
      kind: 'arithmetic',
      destinations: [{ network: 'dx' }],
    });
    expect(plan.producers[1]).toMatchObject({
      kind: 'arithmetic',
      left: { kind: 'each', network: 'dx' },
      right: { kind: 'each', network: 'dx' },
    });
    expect(plan.producers[2]).toMatchObject({
      kind: 'arithmetic',
      left: { kind: 'each', network: 'dx' },
    });
  });

  test('selects an owned local Network returned without a receiving annotation', () => {
    const parsed = parseFile({
      path: 'runtime-selection.factorio.ts',
      text: `const A = Signal("virtual", "signal-A");
function MakeInput() {
  const input: Network = CC(5 * A);
  return input;
}
const inferred = MakeInput();
const output = IF(inferred[A] > 0, inferred[A]);`,
    });
    const plan = executeElaborationProgram(transformElaborationModule(parsed));

    expect(plan.networks.map(({ name }) => name)).toEqual(['input', 'output']);
    expect(plan.producers).toMatchObject([
      { kind: 'constant', destinations: [{ network: 'input' }] },
      {
        kind: 'decider',
        condition: { kind: 'compare-signal', network: 'input' },
        output: { kind: 'signal', network: 'input' },
        destinations: [{ network: 'output' }],
      },
    ]);
  });

  test('resolves name-only Network selections as item signals', () => {
    const parsed = parseFile({
      path: 'name-only-selection.factorio.ts',
      text: `const input = new Network();
const output = input["iron-plate"] + 1;`,
    });

    expect(validateDslSemantics(parsed)).toEqual([]);
    const plan = executeElaborationProgram(transformElaborationModule(parsed));
    expect(plan.producers[0]).toMatchObject({
      kind: 'arithmetic',
      left: {
        kind: 'signal',
        network: 'input',
        signal: { type: 'item', name: 'iron-plate' },
      },
      output: { kind: 'signal', signal: { type: 'item', name: 'iron-plate' } },
    });

    const entity = generateBlueprintJson(elaborateDirectPlan(plan).circuit.ir).blueprint
      .entities[0];
    expect(entity).toMatchObject({
      control_behavior: {
        arithmetic_conditions: {
          first_signal: { name: 'iron-plate' },
          output_signal: { name: 'iron-plate' },
        },
      },
    });
    expect(JSON.stringify(entity)).not.toContain('"type":"item"');
  });

  test('reads and simulates both pair wire colors in arithmetic and wildcard deciders', () => {
    const parsed = parseFile({
      path: 'pair-input.factorio.ts',
      text: `const A = Signal("virtual", "signal-A");
const B = Signal("virtual", "signal-B");
const red: Network<R> = CC(2 * A, 1 * B);
const green: Network<G> = CC(3 * A, 4 * B);
const sum: Network = pair(red, green)[A] + 0;
const copied: Network = IF(Anything(pair(red, green)) > 0, Everything(pair(red, green)));`,
    });
    const plan = executeElaborationProgram(transformElaborationModule(parsed));

    expect(plan.networkPairs).toHaveLength(3);
    expect(plan.producers[2]).toMatchObject({
      kind: 'arithmetic',
      left: { kind: 'signal', refKind: 'pair', networks: ['red', 'green'] },
    });
    expect(
      plan.producers[2]?.kind === 'arithmetic' ? plan.producers[2].left : undefined,
    ).not.toHaveProperty('network');
    expect(plan.producers[3]).toMatchObject({
      kind: 'decider',
      condition: {
        kind: 'compare-wildcard',
        wildcard: 'anything',
        networks: ['red', 'green'],
      },
      output: { kind: 'wildcard', wildcard: 'everything', networks: ['red', 'green'] },
    });

    const execution = elaborateDirectPlan(plan);
    const A = signal('virtual', 'signal-A');
    const B = signal('virtual', 'signal-B');
    const simulation = execution.circuit.createSimulation();
    simulation.step();
    const snapshot = simulation.step();
    expect(snapshot.read(execution.network('sum').id).get(A)).toBe(5);
    expect(snapshot.read(execution.network('copied').id)).toEqual(
      new SparseBus([
        [A, 5],
        [B, 5],
      ]),
    );

    const blueprint = generateBlueprintJson(execution.circuit.ir).blueprint;
    expect(blueprint.wires).toEqual(
      expect.arrayContaining([
        [1, 1, 3, 1],
        [2, 2, 3, 2],
      ]),
    );
  });

  test('enforces standalone pair colors and rejects dynamic destination/ownership misuse', () => {
    const conflicting = parseFile({
      path: 'pair-color.factorio.ts',
      text: `const first = new Network<R>();
const second = new Network<R>();
const inputs = pair(first, second);`,
    });
    const conflictPlan = executeElaborationProgram(transformElaborationModule(conflicting));
    const result = tryElaborateDirectPlan(conflictPlan);
    const conflict = result.diagnostics[0];
    expect(conflict).toMatchObject({ code: 'RT2010', severity: 'error', span: expect.any(Object) });
    expect(
      conflict?.span === undefined
        ? undefined
        : conflicting.text.slice(conflict.span.start, conflict.span.end),
    ).toBe('pair(first, second)');

    const destination = parseFile({
      path: 'pair-destination.factorio.ts',
      text: `const a = new Network();
const b = new Network();
const inputs = pair(a, b);
inputs += a + 0;`,
    });
    expect(() => executeElaborationProgram(transformElaborationModule(destination))).toThrowError(
      expect.objectContaining({ code: 'RT2020' }),
    );

    const escaped = parseFile({
      path: 'pair-return.factorio.ts',
      text: `function Leak(a: Readonly<Network>, b: Readonly<Network>) {
  const inputs = pair(a, b);
  return inputs;
}
const a = new Network();
const b = new Network();
const escaped = Leak(a, b);`,
    });
    expect(() => executeElaborationProgram(transformElaborationModule(escaped))).toThrowError(
      expect.objectContaining({ code: 'RT2020' }),
    );

    const repeated = parseFile({
      path: 'pair-repeated.factorio.ts',
      text: `const input = new Network();
const invalid = pair(input, input);`,
    });
    expect(() => executeElaborationProgram(transformElaborationModule(repeated))).toThrowError(
      expect.objectContaining({ code: 'RT2020' }),
    );

    const stale = parseFile({
      path: 'pair-stale.factorio.ts',
      text: `function Pass(input: Move<Network>): Network { return input; }
const first = new Network();
const second = new Network();
const inputs = pair(first, second);
const moved = Pass(first);
const output: Network = inputs + 0;`,
    });
    expect(() => executeElaborationProgram(transformElaborationModule(stale))).toThrowError(
      expect.objectContaining({ code: 'RT2012' }),
    );

    const collapsed = parseFile({
      path: 'pair-collapsed-by-take.factorio.ts',
      text: `const first = new Network();
const second = new Network();
const inputs = pair(first, second);
first.take(second);`,
    });
    const collapsedResult = tryElaborateDirectPlan(
      executeElaborationProgram(transformElaborationModule(collapsed)),
    );
    expect(collapsedResult.diagnostics).toEqual([
      expect.objectContaining({ code: 'RT2020', severity: 'error', span: expect.any(Object) }),
    ]);
  });

  test('materializes loop-local Networks and feeds them into arithmetic producers', () => {
    const parsed = parseFile({
      path: 'local-loop.factorio.ts',
      text: `const SIGNAL_A = Signal("virtual", "signal-A");
let input: Network = CC(5 * SIGNAL_A);
let output = new Network();
for (let i = 0; i < 10; i++) {
  let tmp: Network = IF(input < i, 1 * SIGNAL_A);
  output += tmp * 2 + 1;
}`,
    });
    const plan = executeElaborationProgram(transformElaborationModule(parsed));

    expect(plan.producers.filter(({ kind }) => kind === 'constant')).toHaveLength(1);
    expect(plan.producers.filter(({ kind }) => kind === 'decider')).toHaveLength(10);
    expect(plan.producers.filter(({ kind }) => kind === 'arithmetic')).toHaveLength(20);
    expect(
      plan.producers
        .filter(({ kind }) => kind === 'decider')
        .map(({ instancePath }) => instancePath.at(-1)),
    ).toEqual(Array.from({ length: 10 }, (_, index) => `for i=${index}`));
    expect(
      plan.networks
        .map(({ name }) => name)
        .filter(
          (name) =>
            name === 'input' || name === 'output' || name.endsWith(':tmp') || name === 'tmp',
        ),
    ).toEqual([
      'input',
      'output',
      'tmp',
      ...Array.from({ length: 9 }, (_, index) => `$instance:${index + 2}:tmp`),
    ]);

    const execution = elaborateDirectPlan(plan);
    const output = execution.network('output');
    const A = signal('virtual', 'signal-A');
    const simulation = execution.circuit.createSimulation();
    expect(simulation.step().read(output.id).get(A)).toBe(0);
    expect(simulation.step().read(output.id).get(A)).toBe(0);
    expect(simulation.step().read(output.id).get(A)).toBe(0);
    expect(simulation.step().read(output.id).get(A)).toBe(12);
    expect(generateBlueprintJson(execution.circuit.ir).blueprint.entities).toHaveLength(31);
  });

  test('attaches producers through runtime Network values in properties and array elements', () => {
    const parsed = parseFile({
      path: 'compound-targets.factorio.ts',
      text: `const A = Signal("virtual", "signal-A");
const input = CC(5 * A);
const holder = { output: new Network() };
const outputs = [new Network()];
holder.output += input + 1;
outputs[0] += input + 2;
let count = 1;
count += 2;`,
    });
    const plan = executeElaborationProgram(transformElaborationModule(parsed));

    expect(plan.producers.filter(({ kind }) => kind === 'arithmetic')).toHaveLength(2);
    expect(plan.producers.slice(1).map(({ destinations }) => destinations?.[0]?.network)).toEqual([
      '$network:1',
      '$network:2',
    ]);
    expect(plan.diagnostics).toEqual([]);
  });

  test('reads Network[] elements in compile-time loops', () => {
    const parsed = parseFile({
      path: 'network-array-loop.factorio.ts',
      text: `const output = new Network();
const arr: Network[] = [new Network(), new Network(), new Network(), new Network(), new Network()];
for (let i = 0; i < 5; i++) {
  output += arr[i] * 2;
}`,
    });
    const plan = executeElaborationProgram(transformElaborationModule(parsed));

    expect(plan.producers).toHaveLength(5);
    expect(plan.producers).toMatchObject(
      Array.from({ length: 5 }, (_, index) => ({
        kind: 'arithmetic',
        left: { kind: 'each', network: `$network:${index + 1}` },
        operation: 'multiply',
        right: { kind: 'constant', value: 2 },
        destinations: [{ network: 'output' }],
      })),
    );
  });

  test('rejects a heterogeneous array when execution reaches a non-Network element', () => {
    const assignment = 'output += arr[i] * 2';
    const parsed = parseFile({
      path: 'mixed-array-loop.factorio.ts',
      text: `const output = new Network();
const arr = [new Network(), new Network(), new Network(), 5, new Network()];
for (let i = 0; i < 5; i++) {
  ${assignment};
}`,
    });

    try {
      executeElaborationProgram(transformElaborationModule(parsed));
      expect.fail('Expected the numeric array element to be rejected as an attachment.');
    } catch (error) {
      expect(error).toBeInstanceOf(ElaborationExecutionError);
      expect((error as ElaborationExecutionError).message).toContain(
        'Network += requires a combinator producer',
      );
      const span = (error as ElaborationExecutionError).span;
      expect(parsed.text.slice(span.start, span.end)).toBe(assignment);
    }
  });

  test('rejects Network += constant instead of falling through to JavaScript coercion', () => {
    const assignment = 'output += 5';
    const parsed = parseFile({
      path: 'invalid-network-addition.factorio.ts',
      text: `let output = new Network();
${assignment};`,
    });

    try {
      executeElaborationProgram(transformElaborationModule(parsed));
      expect.fail('Expected Network += constant to be rejected.');
    } catch (error) {
      expect(error).toBeInstanceOf(ElaborationExecutionError);
      expect((error as ElaborationExecutionError).message).toContain(
        'Network += requires a combinator producer',
      );
      const span = (error as ElaborationExecutionError).span;
      expect(parsed.text.slice(span.start, span.end)).toBe(assignment);
    }
  });

  test('builds, simulates, and exports hardware created by ordinary JavaScript iteration', () => {
    const parsed = parseFile({ path: 'loop.factorio.ts', text: loopSource });
    const program = transformElaborationModule(parsed);
    const plan = executeElaborationProgram(program);

    expect(plan.networks.map(({ name }) => name)).toEqual(['input', 'output']);
    expect(plan.producers.filter(({ kind }) => kind === 'constant')).toHaveLength(1);
    expect(plan.producers.filter(({ kind }) => kind === 'decider')).toHaveLength(10);
    expect(
      plan.producers
        .filter(({ kind }) => kind === 'decider')
        .map((producer) =>
          producer.kind === 'decider' && producer.condition.kind === 'compare-each'
            ? producer.condition.constant
            : null,
        ),
    ).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);

    const execution = elaborateDirectPlan(plan);
    const output = execution.network('output');
    const A = signal('virtual', 'signal-A');
    const simulation = execution.circuit.createSimulation();
    expect(simulation.step().read(output.id).get(A)).toBe(0);
    expect(simulation.step().read(output.id).get(A)).toBe(4);

    const blueprint = generateBlueprintJson(execution.circuit.ir);
    expect(blueprint.blueprint.entities).toHaveLength(11);
    expect(blueprint.blueprint.entities.map(({ name }) => name)).toEqual([
      'constant-combinator',
      ...Array.from({ length: 10 }, () => 'decider-combinator'),
    ]);
  });

  test('normalizes every executed configuration number at the circuit boundary', () => {
    const parsed = parseFile({
      path: 'circuit-constant-boundary.factorio.ts',
      text: `const A = Signal("virtual", "signal-A");
const input: Network = CC(4294967295 * A);
const arithmetic = new Network();
arithmetic += input + 2147483648;
const decider = new Network();
decider += IF(input > 4294967295, 4294967295 * A);`,
    });
    const plan = executeElaborationProgram(transformElaborationModule(parsed));

    expect(plan.producers).toMatchObject([
      { kind: 'constant', outputs: [{ value: -1 }] },
      { kind: 'arithmetic', right: { kind: 'constant', value: -2_147_483_648 } },
      {
        kind: 'decider',
        condition: { kind: 'compare-each', constant: -1 },
        output: { kind: 'signal-constant', value: -1 },
      },
    ]);
  });

  test.each(['1.5', 'NaN', 'Infinity', '9007199254740992'])(
    'rejects non-canonical circuit configuration number %s',
    (value) => {
      const expression = `${value} * A`;
      const parsed = parseFile({
        path: 'invalid-circuit-constant.factorio.ts',
        text: `const A = Signal("virtual", "signal-A");
const output: Network = CC(${expression});`,
      });

      try {
        executeElaborationProgram(transformElaborationModule(parsed));
        expect.fail('Expected the invalid circuit configuration number to fail.');
      } catch (error) {
        expect(error).toBeInstanceOf(ElaborationExecutionError);
        expect((error as ElaborationExecutionError).message).toContain('safe integers');
        expect(
          parsed.text.slice(
            (error as ElaborationExecutionError).span.start,
            (error as ElaborationExecutionError).span.end,
          ),
        ).toBe(expression);
      }
    },
  );

  test('executes arrays, objects, branches, and every ordinary JavaScript loop family', () => {
    const parsed = parseFile({
      path: 'control-flow.factorio.ts',
      text: `const A = Signal("virtual", "signal-A");
const input: Network = CC(5 * A);
const output = new Network();
const values = [1, 2, 4];
const config = { enabled: true, limit: 3 };
for (const value of values) {
  if (config.enabled && value <= config.limit) output += IF(input < value, 1 * A);
}
const table = { first: 1, second: 2 };
for (const key in table) output += input + table[key];
let whileIndex = 0;
while (whileIndex < 2) {
  output += input + whileIndex;
  whileIndex++;
}
let doIndex = 0;
do {
  output += input + doIndex;
  doIndex++;
} while (doIndex < 2);`,
    });
    const plan = executeElaborationProgram(transformElaborationModule(parsed));

    expect(plan.producers.filter(({ kind }) => kind === 'constant')).toHaveLength(1);
    expect(plan.producers.filter(({ kind }) => kind === 'decider')).toHaveLength(2);
    expect(plan.producers.filter(({ kind }) => kind === 'arithmetic')).toHaveLength(6);
    expect(
      plan.producers
        .filter(({ kind }) => kind === 'decider')
        .map(({ instancePath }) => instancePath.at(-1)),
    ).toEqual(['for value=1', 'for value=2']);
    expect(
      plan.producers
        .filter(({ kind }) => kind === 'arithmetic')
        .map(({ instancePath }) => instancePath.at(-1)),
    ).toEqual(['for key=first', 'for key=second', 'while #1', 'while #2', 'do #1', 'do #2']);
  });

  test('executes destination.take(source) as one zero-tick Network union', () => {
    const parsed = parseFile({
      path: 'take.factorio.ts',
      text: `const A = Signal("virtual", "signal-A");
const input: Network = CC(5 * A);
const source: Network = input + 1;
const destination = new Network();
destination.take(source);
const output: Network = destination * 2;`,
    });
    const plan = executeElaborationProgram(transformElaborationModule(parsed));

    expect(plan.networkTransfers).toEqual([
      expect.objectContaining({ destination: 'destination', source: 'source' }),
    ]);
    const execution = elaborateDirectPlan(plan);
    expect(execution.circuit.graph.networks).toHaveLength(3);
    expect(execution.circuit.ir.networks).toHaveLength(3);
    expect(() => execution.network('source')).toThrowError(RuntimeDiagnosticError);
    const destination = execution.network('destination');
    const sourceProducer = execution.circuit.graph.producers[1]!;
    const outputProducer = execution.circuit.graph.producers[2]!;
    expect(sourceProducer.destinations).toContain(destination.id);
    expect(outputProducer.kind).toBe('arithmetic');
    if (outputProducer.kind === 'arithmetic') {
      expect(outputProducer.config.left).toEqual({
        kind: 'each',
        refKind: 'single',
        network: destination.id,
      });
    }
  });

  test('reports dynamic use-after-move through an array alias with source provenance', () => {
    const parsed = parseFile({
      path: 'take-alias.factorio.ts',
      text: `const destination = new Network();
const source = new Network();
const aliases = [source];
destination.take(source);
const output: Network = aliases[0] + 1;`,
    });

    try {
      executeElaborationProgram(transformElaborationModule(parsed));
      throw new Error('Expected use-after-move failure.');
    } catch (error) {
      expect(error).toBeInstanceOf(ElaborationExecutionError);
      const ownership = error as ElaborationExecutionError;
      expect(ownership.code).toBe('RT2012');
      expect(parsed.text.slice(ownership.span.start, ownership.span.end)).toBe('aliases[0] + 1');
      expect(ownership.related).toHaveLength(2);
      expect(
        parsed.text.slice(ownership.related![0]!.span.start, ownership.related![0]!.span.end),
      ).toBe('destination.take(source)');
    }
  });

  test('reports a repeated move and a fixed-color transfer conflict', () => {
    const repeated = parseFile({
      path: 'double-move.factorio.ts',
      text: `const a = new Network();
const b = new Network();
const c = new Network();
a.take(b);
c.take(b);`,
    });
    expect(() => executeElaborationProgram(transformElaborationModule(repeated))).toThrowError(
      expect.objectContaining({ code: 'RT2012' }),
    );

    const conflicting = parseFile({
      path: 'take-color.factorio.ts',
      text: `const red = new Network<R>();
const green = new Network<G>();
red.take(green);`,
    });
    const result = tryElaborateDirectPlan(
      executeElaborationProgram(transformElaborationModule(conflicting)),
    );
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        code: 'RT2014',
        span: expect.objectContaining({
          start: conflicting.text.indexOf('red.take(green)'),
        }),
        related: expect.any(Array),
      }),
    ]);
  });

  test('preserves an ordinary JavaScript .take method', () => {
    const parsed = parseFile({
      path: 'ordinary-take.ts',
      text: `const bag = { take(value) { return value + 1; } };
const result = bag.take(2);
if (result !== 3) throw new Error("ordinary take failed");`,
    });

    expect(executeElaborationProgram(transformElaborationModule(parsed)).networks).toEqual([]);
  });

  test('allows Ref attachment and overlapping Readonly parameters', () => {
    const parsed = parseFile({
      path: 'valid-borrows.factorio.ts',
      text: `function Connect(output: Ref<Network>, left: Readonly<Network>, right: Readonly<Network>): void {
  output += left + right;
}
const input = new Network();
const output = new Network();
Connect(output, input, input);`,
    });
    const plan = executeElaborationProgram(transformElaborationModule(parsed));

    expect(plan.producers).toMatchObject([
      {
        kind: 'arithmetic',
        left: { kind: 'each', network: 'input' },
        right: { kind: 'each', network: 'input' },
        destinations: [{ network: 'output' }],
      },
    ]);
  });

  test('applies color-qualified borrow requirements to the underlying Network', () => {
    const parsed = parseFile({
      path: 'borrow-colors.factorio.ts',
      text: `function Connect(output: Ref<Network<G>>, input: Readonly<Network<R>>): void {
  output += input + 1;
}
const input = new Network();
const output = new Network();
Connect(output, input);`,
    });
    const plan = executeElaborationProgram(transformElaborationModule(parsed));

    expect(plan.networks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'input', fixedColor: 'red' }),
        expect.objectContaining({ name: 'output', fixedColor: 'green' }),
      ]),
    );

    const conflicting = parseFile({
      path: 'borrow-color-conflict.factorio.ts',
      text: `function Read(input: Readonly<Network<R>>): Network { return input + 1; }
const input = new Network<G>();
const output: Network = Read(input);`,
    });
    expect(() => executeElaborationProgram(transformElaborationModule(conflicting))).toThrowError(
      expect.objectContaining({ code: 'RT2018' }),
    );
  });

  test('rejects writes and consuming transfer through borrowed parameters', () => {
    const readonlyWrite = parseFile({
      path: 'readonly-write.factorio.ts',
      text: `function Write(output: Readonly<Network>, input: Readonly<Network>): void {
  output += input + 1;
}
Write(new Network(), new Network());`,
    });
    expect(() => executeElaborationProgram(transformElaborationModule(readonlyWrite))).toThrowError(
      expect.objectContaining({ code: 'RT2015' }),
    );

    const refTake = parseFile({
      path: 'ref-take.factorio.ts',
      text: `function Merge(destination: Ref<Network>, source: Readonly<Network>): void {
  destination.take(source);
}
Merge(new Network(), new Network());`,
    });
    expect(() => executeElaborationProgram(transformElaborationModule(refTake))).toThrowError(
      expect.objectContaining({ code: 'RT2015' }),
    );
  });

  test('rejects overlapping mutable/shared borrows and writes through an outer alias', () => {
    const overlap = parseFile({
      path: 'borrow-overlap.factorio.ts',
      text: `function Invalid(write: Ref<Network>, read: Readonly<Network>): void {}
const network = new Network();
Invalid(network, network);`,
    });
    expect(() => executeElaborationProgram(transformElaborationModule(overlap))).toThrowError(
      expect.objectContaining({ code: 'RT2016' }),
    );

    const aliasWrite = parseFile({
      path: 'borrow-alias.factorio.ts',
      text: `const network = new Network();
function Invalid(_read: Readonly<Network>): void {
  network += CC(1 * Signal("virtual", "signal-A"));
}
Invalid(network);`,
    });
    expect(() => executeElaborationProgram(transformElaborationModule(aliasWrite))).toThrowError(
      expect.objectContaining({ code: 'RT2016' }),
    );
  });

  test('rejects a borrowed view escaping through a dynamic container', () => {
    const parsed = parseFile({
      path: 'borrow-escape.factorio.ts',
      text: `function Leak(input: Readonly<Network>) { return [input]; }
const input = new Network();
const escaped = Leak(input);
const output: Network = escaped[0] + 1;`,
    });

    try {
      executeElaborationProgram(transformElaborationModule(parsed));
      throw new Error('Expected borrow escape failure.');
    } catch (error) {
      expect(error).toBeInstanceOf(ElaborationExecutionError);
      const ownership = error as ElaborationExecutionError;
      expect(ownership.code).toBe('RT2017');
      expect(parsed.text.slice(ownership.span.start, ownership.span.end)).toBe('return [input];');
      expect(ownership.related).toHaveLength(1);
    }
  });

  test('moves ownership into a Move parameter and returns a fresh owned view', () => {
    const parsed = parseFile({
      path: 'move-return.factorio.ts',
      text: `function Advance(input: Move<Network<R>>): Network {
  input += input + 1;
  return input;
}
const input = new Network();
const advanced = Advance(input);
const output: Network = advanced * 2;`,
    });
    const plan = executeElaborationProgram(transformElaborationModule(parsed));

    expect(plan.networks).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: 'input', fixedColor: 'red' })]),
    );
    expect(plan.producers).toMatchObject([
      { kind: 'arithmetic', destinations: [{ network: 'input' }] },
      { kind: 'arithmetic', left: { kind: 'each', network: 'input' } },
    ]);

    const conflicting = parseFile({
      path: 'move-color-conflict.factorio.ts',
      text: `function RequireGreen(input: Move<Network<G>>): Network { return input; }
const input = new Network<R>();
const output = RequireGreen(input);`,
    });
    expect(() => executeElaborationProgram(transformElaborationModule(conflicting))).toThrowError(
      expect.objectContaining({ code: 'RT2018', related: expect.any(Array) }),
    );
  });

  test('invalidates caller aliases and moved container slots', () => {
    const alias = parseFile({
      path: 'move-alias.factorio.ts',
      text: `function Pass(input: Move<Network>): Network { return input; }
const input = new Network();
const alias = input;
const result = Pass(input);
const output: Network = alias + 1;`,
    });
    expect(() => executeElaborationProgram(transformElaborationModule(alias))).toThrowError(
      expect.objectContaining({ code: 'RT2012' }),
    );

    const container = parseFile({
      path: 'move-container.factorio.ts',
      text: `function Pass(input: Move<Network>): Network { return input; }
const values: Network[] = [new Network()];
const result = Pass(values[0]);
const output: Network = values[0] + 1;`,
    });
    expect(() => executeElaborationProgram(transformElaborationModule(container))).toThrowError(
      expect.objectContaining({ code: 'RT2012' }),
    );
  });

  test('replaces moved ownership in direct, array, object, and destructured slots', () => {
    const parsed = parseFile({
      path: 'replace-moved-slots.factorio.ts',
      text: `function Advance(input: Move<Network>): Network {
  input += input + 1;
  return input;
}
let direct = new Network();
const stages: Network[] = [new Network(), new Network()];
const state = { current: new Network() };
let [destructured] = [new Network()];
direct = Advance(direct);
for (let i = 0; i < stages.length; i++) {
  stages[i] = Advance(stages[i]);
}
state.current = Advance(state.current);
destructured = Advance(destructured);
const output: Network = direct + stages[0] + stages[1] + state.current + destructured;`,
    });
    const plan = executeElaborationProgram(transformElaborationModule(parsed));

    expect(plan.diagnostics).toEqual([]);
    expect(plan.producers).toHaveLength(9);
    expect(plan.producers.slice(0, 5).every(({ destinations }) => destinations.length === 1)).toBe(
      true,
    );
    expect(plan.producers.at(-1)?.destinations).toMatchObject([{ network: 'output' }]);
  });

  test('keeps aliases usable until a move and invalidates stale slot aliases after replacement', () => {
    const valid = parseFile({
      path: 'local-network-alias.factorio.ts',
      text: `const input = new Network();
const alias = input;
const slots = [alias];
slots[0] += input + 1;`,
    });
    expect(executeElaborationProgram(transformElaborationModule(valid)).producers).toMatchObject([
      { kind: 'arithmetic', destinations: [{ network: 'input' }] },
    ]);

    const staleUse = 'alias + 1';
    const stale = parseFile({
      path: 'stale-replaced-slot-alias.factorio.ts',
      text: `function Advance(input: Move<Network>): Network { return input; }
const stages: Network[] = [new Network()];
const alias = stages[0];
stages[0] = Advance(stages[0]);
const valid: Network = stages[0] + 1;
const invalid: Network = ${staleUse};`,
    });
    try {
      executeElaborationProgram(transformElaborationModule(stale));
      expect.fail('Expected the pre-move alias to retain its stale ownership generation.');
    } catch (error) {
      expect(error).toBeInstanceOf(ElaborationExecutionError);
      const failure = error as ElaborationExecutionError;
      expect(failure.code).toBe('RT2012');
      expect(stale.text.slice(failure.span.start, failure.span.end)).toBe(staleUse);
      expect(failure.related).toHaveLength(2);
    }
  });

  test('rejects a closure that uses an expired Network borrow', () => {
    const use = 'input + 1';
    const parsed = parseFile({
      path: 'borrowed-network-closure.factorio.ts',
      text: `function Capture(input: Readonly<Network>) {
  return () => ${use};
}
const input = new Network();
const delayed = Capture(input);
const output: Network = delayed();`,
    });

    try {
      executeElaborationProgram(transformElaborationModule(parsed));
      expect.fail('Expected the closure to retain an expired borrow view.');
    } catch (error) {
      expect(error).toBeInstanceOf(ElaborationExecutionError);
      const failure = error as ElaborationExecutionError;
      expect(failure.code).toBe('RT2017');
      expect(parsed.text.slice(failure.span.start, failure.span.end)).toBe(use);
      expect(failure.related).toHaveLength(2);
    }
  });

  test('lets Move parameters participate in take and rejects dropped ownership reuse', () => {
    const merged = parseFile({
      path: 'move-take.factorio.ts',
      text: `function Combine(destination: Move<Network>, source: Move<Network>): Network {
  destination.take(source);
  return destination;
}
const destination = new Network();
const source = new Network();
const merged = Combine(destination, source);
const output: Network = merged + 1;`,
    });
    const plan = executeElaborationProgram(transformElaborationModule(merged));
    expect(plan.networkTransfers).toEqual([
      expect.objectContaining({ destination: 'destination', source: 'source' }),
    ]);

    const dropped = parseFile({
      path: 'move-drop.factorio.ts',
      text: `function Drop(input: Move<Network>): void {
  input += CC(1 * Signal("virtual", "signal-A"));
}
const input = new Network();
Drop(input);
const output: Network = input + 1;`,
    });
    expect(() => executeElaborationProgram(transformElaborationModule(dropped))).toThrowError(
      expect.objectContaining({ code: 'RT2019' }),
    );
  });

  test('rejects returning a foreign owned Network without Move', () => {
    const parsed = parseFile({
      path: 'implicit-steal.factorio.ts',
      text: `const input = new Network();
function Steal(): Network { return input; }
const stolen = Steal();`,
    });

    expect(() => executeElaborationProgram(transformElaborationModule(parsed))).toThrowError(
      expect.objectContaining({ code: 'RT2019' }),
    );
  });

  test('transfers owned Networks returned inside arrays and objects', () => {
    const parsed = parseFile({
      path: 'move-container-return.factorio.ts',
      text: `function Bundle(input: Move<Network>) {
  const local = new Network();
  return { input, local };
}
const input = new Network();
const bundle = Bundle(input);
const output: Network = bundle.input + bundle.local;`,
    });
    const plan = executeElaborationProgram(transformElaborationModule(parsed));

    expect(plan.producers).toMatchObject([
      {
        kind: 'arithmetic',
        left: { kind: 'each', network: 'input' },
        right: { kind: 'each', network: 'local' },
      },
    ]);

    const duplicate = parseFile({
      path: 'duplicate-owner-return.factorio.ts',
      text: `function Duplicate(input: Move<Network>) { return [input, input]; }
const input = new Network();
const values = Duplicate(input);`,
    });
    expect(() => executeElaborationProgram(transformElaborationModule(duplicate))).toThrowError(
      expect.objectContaining({ code: 'RT2012' }),
    );
  });

  test('keeps callback-local returns inside the surrounding borrow lifetime', () => {
    const parsed = parseFile({
      path: 'callback-borrow.factorio.ts',
      text: `function Pick(input: Readonly<Network>): Network {
  const values = [0].map(() => { return input; });
  return values[0] + 0;
}
const input = new Network();
const output: Network = Pick(input);`,
    });

    const plan = executeElaborationProgram(transformElaborationModule(parsed));
    expect(plan.producers).toMatchObject([
      { kind: 'arithmetic', left: { kind: 'each', network: 'input' } },
    ]);
  });
});

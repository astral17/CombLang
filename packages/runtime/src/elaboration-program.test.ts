import { generateBlueprintJson, transformElaborationModule } from '@comblang/compiler';
import { signal } from '@comblang/factorio';
import { parseFile, validateDslSemantics } from '@comblang/language';
import { describe, expect, test } from 'vitest';

import { elaborateDirectPlan } from './direct-plan.js';
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
      'Arithmetic output Signal conflicts with its destination binding.',
    );
    try {
      executeElaborationProgram(transformElaborationModule(conflicting));
      expect.fail('Expected an explicit output conflict.');
    } catch (error) {
      expect(error).toBeInstanceOf(ElaborationExecutionError);
      const span = (error as ElaborationExecutionError).span;
      expect(conflicting.text.slice(span.start, span.end)).toBe(conflictingCall);
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

  test('binds a helper fan-out output Signal through the final to(...) argument', () => {
    const parsed = parseFile({
      path: 'helper-signal-to.factorio.ts',
      text: `const A = Signal("virtual", "signal-A");
const input = new Network();
const first = new Network();
const second = new Network();
to(first, second, A) += input + 1;`,
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
to(output, mirror, SIGNAL_A) += Gate(biased, threshold);`,
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

  test('selects a Network returned at runtime without a declaration annotation', () => {
    const parsed = parseFile({
      path: 'runtime-selection.factorio.ts',
      text: `const A = Signal("virtual", "signal-A");
function Identity(input: Readonly<Network>): Network { return input; }
const input = CC(5 * A);
const inferred = Identity(input);
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
});

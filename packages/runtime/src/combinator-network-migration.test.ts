import { transformElaborationModule } from '@comblang/compiler';
import { signal } from '@comblang/factorio';
import { parseFile, validateDslSemantics } from '@comblang/language';
import { describe, expect, test } from 'vitest';

import { elaborateDirectPlan } from './direct-plan.js';
import { ElaborationExecutionError, executeElaborationProgram } from './elaboration-program.js';

describe('Combinator Network facet migration', () => {
  test('rejects a conflicting arithmetic output binding at the second source operation', () => {
    const parsed = parseFile({
      path: 'arithmetic-conflicting-binding.factorio.ts',
      text: `const input = new Network();
const first = new Network();
const second = new Network();
const comb = input * 2;
const A = Signal('virtual', 'signal-A');
const B = Signal('virtual', 'signal-B');
first[A] += comb;
second[B] += comb;`,
    });
    const line = 'second[B] += comb';

    try {
      executeElaborationProgram(transformElaborationModule(parsed));
      expect.fail('expected the second incompatible output binding to fail');
    } catch (error) {
      expect(error).toMatchObject({ code: 'RT2023' });
      const failure = error as ElaborationExecutionError;
      expect(parsed.text.slice(failure.span.start, failure.span.end)).toBe(line);
    }
  });

  test('allows repeated identical arithmetic output bindings', () => {
    const parsed = parseFile({
      path: 'arithmetic-identical-binding.factorio.ts',
      text: `const input = new Network();
const first = new Network();
const second = new Network();
const comb = input * 2;
const A = Signal('virtual', 'signal-A');
first[A] += comb;
second[A] += comb;`,
    });

    expect(() => executeElaborationProgram(transformElaborationModule(parsed))).not.toThrow();
  });

  test('rejects a mutable when reconfiguration that conflicts with its bound output', () => {
    const parsed = parseFile({
      path: 'when-conflicting-binding.factorio.ts',
      text: `const input = new Network();
const other = new Network();
const destination = new Network();
const A = Signal('virtual', 'signal-A');
const decider = when(input > 0).then(input);
decider.to(destination, A);
decider.then(other);`,
    });
    const line = 'decider.then(other)';

    try {
      executeElaborationProgram(transformElaborationModule(parsed));
      expect.fail('expected the conflicting mutable when reconfiguration to fail');
    } catch (error) {
      expect(error).toMatchObject({ code: 'RT2023' });
      const failure = error as ElaborationExecutionError;
      expect(parsed.text.slice(failure.span.start, failure.span.end)).toBe(line);
    }
  });

  test('reapplies one output binding across then-before-to, to-before-then, and else-only orders', () => {
    const cases = [
      {
        path: 'when-then-before-to.factorio.ts',
        text: `const input = new Network();
const destination = new Network();
const A = Signal('virtual', 'signal-A');
const decider = when(input > 0).then(input);
decider.to(destination, A);`,
      },
      {
        path: 'when-to-before-then.factorio.ts',
        text: `const input = new Network();
const destination = new Network();
const A = Signal('virtual', 'signal-A');
const decider = when(input > 0);
decider.to(destination, A);
decider.then(input);`,
      },
      {
        path: 'when-else-only-binding.factorio.ts',
        text: `const input = new Network();
const destination = new Network();
const A = Signal('virtual', 'signal-A');
const decider = when(input > 0);
decider.to(destination, A);
decider.else(input);`,
      },
    ];

    for (const parsed of cases.map(({ path, text }) => parseFile({ path, text }))) {
      const plan = executeElaborationProgram(transformElaborationModule(parsed));
      expect(plan.producers[0]).toMatchObject({
        kind: 'decider',
        output: { kind: 'signal', signal: { type: 'virtual', name: 'signal-A' } },
      });
    }
  });

  test('reapplies one output binding to both mutually exclusive decider branches', () => {
    const parsed = parseFile({
      path: 'when-then-else-binding.factorio.ts',
      text: `const input = new Network();
const destination = new Network();
const A = Signal('virtual', 'signal-A');
const decider = when(input > 0);
decider.to(destination, A);
decider.then(input).else(input);`,
    });

    const plan = executeElaborationProgram(transformElaborationModule(parsed));
    expect(plan.producers[0]).toMatchObject({
      kind: 'decider',
      output: { kind: 'signal', signal: { type: 'virtual', name: 'signal-A' } },
      outputs: [{ kind: 'signal', signal: { type: 'virtual', name: 'signal-A' } }],
      elseOutputs: [{ kind: 'signal', signal: { type: 'virtual', name: 'signal-A' } }],
    });
  });

  test('keeps explicit Network returns narrowed when created by arrows or function expressions', () => {
    const narrowed = parseFile({
      path: 'network-narrowed-arrow.factorio.ts',
      text: `const input = new Network();
const output = new Network();
const make = (value: Network): Network => value + 1;
const values = [make(input)];
const result = values[0];
result.to(output);`,
    });
    expect(() => executeElaborationProgram(transformElaborationModule(narrowed))).toThrow(
      'combinator producer or an ordinary .to method',
    );

    const expression = parseFile({
      path: 'network-narrowed-expression.factorio.ts',
      text: `const input = new Network();
const output = new Network();
const make = function (value: Network): Network { return value + 1; };
const result = make(input);
result.at(1, 2);`,
    });
    expect(() => executeElaborationProgram(transformElaborationModule(expression))).toThrow(
      'combinator producer or an ordinary .at method',
    );
  });

  test('resolves the primary Network facet at every writable boundary', () => {
    const cases = [
      `const input = new Network();
const destination = input + 1;
(input + 2).to(destination);`,
      `const input = new Network();
const destination = input + 1;
to(destination) += input + 2;`,
      `const input = new Network();
const source = new Network();
const destination = input + 1;
destination.take(source);`,
      `const input = new Network();
const destination = input + 1;
destination += input + 2;`,
    ];

    for (const [index, text] of cases.entries()) {
      const parsed = parseFile({ path: `combinator-facet-boundary-${index}.factorio.ts`, text });
      expect(() => executeElaborationProgram(transformElaborationModule(parsed))).not.toThrow();
    }
  });

  test('keeps combinators inside Network[] containers and permits repeated primary reads', () => {
    const parsed = parseFile({
      path: 'combinator-array.factorio.ts',
      text: `const SIGNAL_A = Signal("virtual", "signal-A");
let base = CC(5 * SIGNAL_A);
let arr: Network[] = Array.from({ length: 10 }, (_, i) => base * (i + 1));
let out = new Network();
for (let i = 0; i < 10; i++) {
  out += arr[i] * arr[i];
}`,
    });

    expect(validateDslSemantics(parsed)).toEqual([]);
    const plan = executeElaborationProgram(transformElaborationModule(parsed));

    expect(plan.producers.filter(({ kind }) => kind === 'constant')).toHaveLength(1);
    expect(plan.producers.filter(({ kind }) => kind === 'arithmetic')).toHaveLength(20);
    expect(plan.networks.some(({ name }) => name.startsWith('$tmp:'))).toBe(false);
    expect(plan.diagnostics).toEqual([]);

    const execution = elaborateDirectPlan(plan);
    const output = execution.network('out');
    const simulation = execution.circuit.createSimulation();
    const A = signal('virtual', 'signal-A');
    let snapshot = simulation.step();
    for (let tick = 1; tick < 5; tick += 1) snapshot = simulation.step();
    expect(snapshot.read(output.id).get(A)).toBe(9625);
  });

  test('allocates at most one stable secondary lane for sequential attachments', () => {
    const parsed = parseFile({
      path: 'combinator-output-lanes.factorio.ts',
      text: `const A = Signal('virtual', 'signal-A');
const comb = CC(1 * A);
const first = new Network();
const second = new Network();
first += comb;
second += comb;`,
    });
    const plan = executeElaborationProgram(transformElaborationModule(parsed));
    expect(plan.producers).toHaveLength(1);
    expect(plan.producers[0]!.destinations).toHaveLength(2);
    expect(plan.networkTransfers).toHaveLength(2);
    expect(() => elaborateDirectPlan(plan)).not.toThrow();
  });

  test('keeps inferred handles but narrows an explicit Network return without new topology', () => {
    const parsed = parseFile({
      path: 'combinator-function-returns.factorio.ts',
      text: `const A = Signal('virtual', 'signal-A');
const input = CC(2 * A);
function AsNetwork(value: Readonly<Network>): Network {
  return value * 3;
}
function AsCombinator(value: Readonly<Network>): ArithmeticCombinator {
  const comb = value * 4;
  return comb;
}
const narrowed = AsNetwork(input);
const retained = AsCombinator(input);
retained.at(4, 7, 4);
const first = new Network();
const second = new Network();
first.take(narrowed);
second += retained;`,
    });

    expect(validateDslSemantics(parsed)).toEqual([]);
    const plan = executeElaborationProgram(transformElaborationModule(parsed));

    expect(plan.producers).toHaveLength(3);
    expect(plan.producers.filter(({ kind }) => kind === 'arithmetic')).toHaveLength(2);
    expect(plan.producers.find(({ bindingName }) => bindingName === 'retained')?.placement).toEqual(
      {
        x: 4,
        y: 7,
        direction: 4,
      },
    );
    expect(plan.networks.some(({ name }) => name.startsWith('$tmp:'))).toBe(false);
    expect(() => elaborateDirectPlan(plan)).not.toThrow();
  });

  test('gives a typed Combinator parameter physical access but only a readonly Network facet', () => {
    const valid = parseFile({
      path: 'readonly-combinator-parameter.factorio.ts',
      text: `const A = Signal('virtual', 'signal-A');
function Place(comb: ConstantCombinator) { comb.at(2, 3, 8); }
const comb = CC(1 * A);
Place(comb);
const output = new Network();
output += comb;`,
    });
    const validPlan = executeElaborationProgram(transformElaborationModule(valid));
    expect(validPlan.producers[0]?.placement).toEqual({ x: 2, y: 3, direction: 8 });

    const invalidLine = '  output += comb;';
    const invalid = parseFile({
      path: 'consume-combinator-parameter.factorio.ts',
      text: `const A = Signal('virtual', 'signal-A');
function Consume(comb: ConstantCombinator) {
  const output = new Network();
${invalidLine}
}
Consume(CC(1 * A));`,
    });

    expect(() => executeElaborationProgram(transformElaborationModule(invalid))).toThrowError(
      expect.objectContaining({ code: 'RT2015' }),
    );
    try {
      executeElaborationProgram(transformElaborationModule(invalid));
    } catch (error) {
      const failure = error as ElaborationExecutionError;
      expect(invalid.text.slice(failure.span.start, failure.span.end)).toBe('output += comb');
    }
  });

  test('projects stable primary and secondary aliases without cloning hardware', () => {
    const parsed = parseFile({
      path: 'stable-output-projection.factorio.ts',
      text: `const A = Signal('virtual', 'signal-A');
const comb = CC(1 * A);
let [primary, secondary] = comb;
let [samePrimary, sameSecondary] = comb;
const sum = primary + secondary;
const output = new Network();
output += sum;`,
    });
    const plan = executeElaborationProgram(transformElaborationModule(parsed));
    const aliases = new Map(plan.networkAliases?.map(({ name, network }) => [name, network]));

    expect(plan.producers).toHaveLength(2);
    expect(plan.producers[0]?.destinations).toHaveLength(2);
    expect(aliases.get('primary')).toBe(aliases.get('samePrimary'));
    expect(aliases.get('secondary')).toBe(aliases.get('sameSecondary'));
    expect(aliases.get('primary')).not.toBe(aliases.get('secondary'));
    expect(() => elaborateDirectPlan(plan)).not.toThrow();
  });

  test('uses the first available lane and reports a third attachment at its source line', () => {
    const valid = parseFile({
      path: 'secondary-before-primary.factorio.ts',
      text: `const A = Signal('virtual', 'signal-A');
const comb = CC(1 * A);
let [, secondary] = comb;
const second = new Network();
const first = new Network();
second.take(secondary);
first += comb;`,
    });
    const validPlan = executeElaborationProgram(transformElaborationModule(valid));
    expect(validPlan.producers[0]?.destinations).toHaveLength(2);
    expect(() => elaborateDirectPlan(validPlan)).not.toThrow();

    const thirdLine = 'third += comb';
    const exhausted = parseFile({
      path: 'exhausted-output.factorio.ts',
      text: `const comb = CC(1 * Signal('virtual', 'signal-A'));
const first = new Network(), second = new Network(), third = new Network();
first += comb;
second += comb;
${thirdLine};`,
    });
    try {
      executeElaborationProgram(transformElaborationModule(exhausted));
      expect.fail('Expected the physical output connector to be exhausted.');
    } catch (error) {
      const failure = error as ElaborationExecutionError;
      expect(failure.code).toBe('RT2028');
      expect(exhausted.text.slice(failure.span.start, failure.span.end)).toBe(thirdLine);
    }
  });

  test('keeps placement and output configuration on one physical two-lane combinator', () => {
    const parsed = parseFile({
      path: 'shared-output-configuration.factorio.ts',
      text: `const A = Signal('virtual', 'signal-A');
const comb = new Network() + 1;
const first = new Network(), second = new Network();
comb.to(first, second, A);
comb.at(10, 5);
`,
    });
    const plan = executeElaborationProgram(transformElaborationModule(parsed));

    expect(plan.producers).toHaveLength(1);
    expect(plan.producers[0]).toMatchObject({
      placement: { x: 10, y: 5 },
      destinations: [{}, {}],
    });
    expect(() => elaborateDirectPlan(plan)).not.toThrow();
  });

  test('mutates one when combinator through aliases and checks new inputs online', () => {
    const valid = parseFile({
      path: 'mutable-when-alias.factorio.ts',
      text: `const a = new Network(), b = new Network();
const decider = when(a > 0);
const alias = decider;
decider.then(a);
alias.else(b);
const output = new Network();
output += decider;`,
    });
    const validPlan = executeElaborationProgram(transformElaborationModule(valid));
    expect(validPlan.producers).toHaveLength(1);
    expect(validPlan.producers[0]).toMatchObject({ kind: 'decider' });
    expect(() => elaborateDirectPlan(validPlan)).not.toThrow();

    const merged = parseFile({
      path: 'mutable-when-merged-input.factorio.ts',
      text: `const a = new Network(), b = new Network(), c = new Network();
const decider = when(b > 0);
a.take(b);
decider.then(a);
decider.else(c);
const output = new Network();
output += decider;`,
    });
    expect(() =>
      elaborateDirectPlan(executeElaborationProgram(transformElaborationModule(merged))),
    ).not.toThrow();

    const failingLine = 'decider.else(c)';
    const invalid = parseFile({
      path: 'mutable-when-capacity.factorio.ts',
      text: `const a = new Network(), b = new Network(), c = new Network();
const decider = when(a > 0);
decider.then(b);
${failingLine};`,
    });
    try {
      executeElaborationProgram(transformElaborationModule(invalid));
      expect.fail('Expected the third input Network to exceed connector capacity.');
    } catch (error) {
      const failure = error as ElaborationExecutionError;
      expect(failure.code).toBe('RT2009');
      expect(invalid.text.slice(failure.span.start, failure.span.end)).toBe(failingLine);
    }
  });
});

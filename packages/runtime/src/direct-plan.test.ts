import { compileDirectPlan } from '@comblang/compiler/direct-plan';
import { signal, SparseBus } from '@comblang/factorio';
import { parseFile } from '@comblang/language';
import { describe, expect, test } from 'vitest';

import { elaborateDirectPlan, tryElaborateDirectPlan } from './direct-plan.js';
import { RuntimeDiagnosticError } from './elaboration.js';

describe('direct plan execution', () => {
  test('compiles and retains a value through a source-level MemoCell', () => {
    const parsed = parseFile({
      path: 'memo-cell.factorio.ts',
      text: `const SIGNAL_A = Signal("virtual", "signal-A");
function MemoCell(input: Readonly<Network>): Network {
  let out = new Network();
  let mem = new Network();
  to(out, mem) += input + 0;
  to(out, mem) += IF(input == 0 && mem != 0, mem);
  return out;
}
const input = new Network();
const output: Network = MemoCell(input);`,
    });
    const compiled = compileDirectPlan(parsed);
    expect(compiled.diagnostics).toEqual([]);
    const executed = elaborateDirectPlan(compiled.plan!);
    const A = signal('virtual', 'signal-A');
    const input = executed.network('input');
    const output = executed.network('output');
    const simulation = executed.circuit.createSimulation([
      { network: input, values: new SparseBus([[A, 42]]) },
    ]);

    expect(executed.circuit.graph.producers).toHaveLength(2);
    expect(executed.circuit.graph.attachments).toHaveLength(4);
    expect(simulation.step().read(output.id).get(A)).toBe(42);
    expect(simulation.step().read(output.id).get(A)).toBe(42);
    expect(simulation.step().read(output.id).get(A)).toBe(42);
  });

  test('compiles, elaborates, and simulates Scale end to end', () => {
    const parsed = parseFile({
      path: 'scale.factorio.ts',
      text: `function Scale(input: Readonly<Network>): Network {
  return input * 10;
}
const input = new Network<R>();
const output: Network = Scale(input);`,
    });
    const compiled = compileDirectPlan(parsed);
    expect(compiled.plan).toBeDefined();
    const executed = elaborateDirectPlan(compiled.plan!);
    const A = signal('virtual', 'signal-A');
    const input = executed.network('input');
    const output = executed.network('output');
    const simulation = executed.circuit.createSimulation([
      { network: input, values: new SparseBus([[A, 7]]) },
    ]);

    expect(executed.circuit.graph.producers).toHaveLength(1);
    expect(simulation.step().read(output.id).get(A)).toBe(70);
  });

  test('preserves one tick per arithmetic node in a source pipeline', () => {
    const parsed = parseFile({
      path: 'pipeline.factorio.ts',
      text: `function Pipeline(input: Readonly<Network>): Network {
  return input * 10 + 5;
}
const input = new Network<R>();
const output: Network = Pipeline(input);`,
    });
    const compiled = compileDirectPlan(parsed);
    expect(compiled.plan).toBeDefined();
    const executed = elaborateDirectPlan(compiled.plan!);
    const A = signal('virtual', 'signal-A');
    const output = executed.network('output');
    const simulation = executed.circuit.createSimulation([
      { network: executed.network('input'), values: new SparseBus([[A, 7]]) },
    ]);

    expect(simulation.step().read(output.id).get(A)).toBe(0);
    expect(simulation.step().read(output.id).get(A)).toBe(75);

    const plannedAttachmentSources = compiled.plan!.producers.flatMap((producer) =>
      producer.destinations.map(({ source }) => source),
    );
    expect(
      executed.circuit.graph.attachments.map((attachment) => attachment.provenance.source),
    ).toEqual(plannedAttachmentSources);
    expect(executed.circuit.graph.attachments[0]?.provenance.source).toEqual(
      executed.circuit.graph.producers[0]?.provenance.source,
    );
    expect(executed.circuit.graph.attachments[1]?.provenance.source).not.toEqual(
      executed.circuit.graph.producers[1]?.provenance.source,
    );
  });

  test('returns a structured source-aware diagnostic for an invalid plan', () => {
    const parsed = parseFile({
      path: 'invalid-plan.factorio.ts',
      text: `function Scale(input: Readonly<Network>): Network {
  return input * 10;
}
const input = new Network<R>();
const output: Network = Scale(input);`,
    });
    const compiled = compileDirectPlan(parsed);
    const plan = compiled.plan!;
    const producer = plan.producers[0]!;
    const attachment = producer.destinations[0]!;
    const invalidPlan = {
      ...plan,
      producers: [
        {
          ...producer,
          destinations: [{ ...attachment, network: 'missing' }],
        },
      ],
    };

    const result = tryElaborateDirectPlan(invalidPlan);
    expect(result.execution).toBeUndefined();
    expect(result.diagnostics).toEqual([
      {
        code: 'RT1004',
        severity: 'error',
        message: 'Unknown attachment Network: missing.',
        span: attachment.source,
      },
    ]);
    expect(() => elaborateDirectPlan(invalidPlan)).toThrow(RuntimeDiagnosticError);
  });

  test('preserves stable function-call instance paths through elaboration', () => {
    const parsed = parseFile({
      path: 'composed.factorio.ts',
      text: `function Scale(input: Readonly<Network>): Network {
  return input * 5;
}
function Bias(input: Readonly<Network>): Network {
  return input + 5;
}
const input = new Network<R>();
const middle: Network = Scale(input);
const output: Network = Bias(middle);`,
    });
    const compiled = compileDirectPlan(parsed);
    const executed = elaborateDirectPlan(compiled.plan!);

    expect(
      executed.circuit.graph.networks.map(({ name, provenance }) => [
        name,
        provenance.instancePath,
      ]),
    ).toEqual([
      ['input', []],
      ['middle', ['Scale:middle']],
      ['output', ['Bias:output']],
    ]);
    expect(
      executed.circuit.graph.producers.map(({ provenance }) => provenance.instancePath),
    ).toEqual([['Scale:middle'], ['Bias:output']]);
    expect(
      executed.circuit.graph.attachments.map(({ provenance }) => provenance.instancePath),
    ).toEqual([['Scale:middle'], ['Bias:output']]);
  });

  test('executes a source += attachment without an extra tick', () => {
    const parsed = parseFile({
      path: 'attachment.factorio.ts',
      text: `function Scale(input: Readonly<Network>): Network {
  return input * 10;
}
const input = new Network<R>();
const output = new Network();
output += Scale(input);`,
    });
    const compiled = compileDirectPlan(parsed);
    const executed = elaborateDirectPlan(compiled.plan!);
    const A = signal('virtual', 'signal-A');
    const output = executed.network('output');
    const simulation = executed.circuit.createSimulation([
      { network: executed.network('input'), values: new SparseBus([[A, 7]]) },
    ]);

    expect(simulation.step().read(output.id).get(A)).toBe(70);
    expect(executed.circuit.graph.networks[1]?.provenance.instancePath).toEqual([]);
    expect(executed.circuit.graph.attachments[0]?.provenance.instancePath).toEqual([
      'Scale:output',
    ]);
  });

  test('solves opposite wire colors for source .to(...) fan-out', () => {
    const parsed = parseFile({
      path: 'fan-out.factorio.ts',
      text: `function Delay(input: Readonly<Network>): Network {
  return input + 0;
}
const input = new Network<R>();
const output = new Network();
const mirror = new Network();
Delay(input).to(output, mirror);`,
    });
    const compiled = compileDirectPlan(parsed);
    const executed = elaborateDirectPlan(compiled.plan!);
    const A = signal('virtual', 'signal-A');
    const output = executed.network('output');
    const mirror = executed.network('mirror');
    const simulation = executed.circuit.createSimulation([
      { network: executed.network('input'), values: new SparseBus([[A, 7]]) },
    ]);
    const snapshot = simulation.step();
    const colors = new Map(
      executed.circuit.ir.networks.map((network) => [network.name, network.color]),
    );

    expect(executed.circuit.graph.attachments).toHaveLength(2);
    expect(colors.get('output')).not.toBe(colors.get('mirror'));
    expect(snapshot.read(output.id).get(A)).toBe(7);
    expect(snapshot.read(mirror.id).get(A)).toBe(7);
  });

  test('reports a source-aware conflict when both fan-out Networks require red', () => {
    const parsed = parseFile({
      path: 'fan-out-conflict.factorio.ts',
      text: `function Delay(input: Readonly<Network>): Network {
  return input + 0;
}
const input = new Network();
const first = new Network<R>();
const second = new Network<R>();
Delay(input).to(first, second);`,
    });
    const compiled = compileDirectPlan(parsed);
    const result = tryElaborateDirectPlan(compiled.plan!);

    expect(result.execution).toBeUndefined();
    expect(result.diagnostics).toEqual([
      expect.objectContaining({ code: 'RT2010', severity: 'error' }),
    ]);
  });

  test('colors two arithmetic inputs and two outputs independently', () => {
    const parsed = parseFile({
      path: 'direct-arithmetic.factorio.ts',
      text: `const a = new Network();
const b = new Network();
const c = new Network();
const d = new Network();
to(c, d) += a + b;`,
    });
    const compiled = compileDirectPlan(parsed);
    const executed = elaborateDirectPlan(compiled.plan!);
    const A = signal('virtual', 'signal-A');
    const colors = new Map(
      executed.circuit.ir.networks.map((network) => [network.name, network.color]),
    );
    const simulation = executed.circuit.createSimulation([
      { network: executed.network('a'), values: new SparseBus([[A, 2]]) },
      { network: executed.network('b'), values: new SparseBus([[A, 3]]) },
    ]);
    const snapshot = simulation.step();

    expect(colors.get('a')).not.toBe(colors.get('b'));
    expect(colors.get('c')).not.toBe(colors.get('d'));
    expect(snapshot.read(executed.network('c').id).get(A)).toBe(5);
    expect(snapshot.read(executed.network('d').id).get(A)).toBe(5);
  });

  test('simulates explicitly bound signal arithmetic with inferred input colors', () => {
    const parsed = parseFile({
      path: 'signal-arithmetic.factorio.ts',
      text: `const LEFT = Signal("virtual", "signal-A");
const RIGHT = Signal("virtual", "signal-B");
const RESULT = Signal("virtual", "signal-C");
const a = new Network();
const b = new Network();
const out = new Network();
out[RESULT] += a[LEFT] + b[RIGHT];`,
    });
    const compiled = compileDirectPlan(parsed);
    const executed = elaborateDirectPlan(compiled.plan!);
    const A = signal('virtual', 'signal-A');
    const B = signal('virtual', 'signal-B');
    const C = signal('virtual', 'signal-C');
    const colors = new Map(
      executed.circuit.ir.networks.map((network) => [network.name, network.color]),
    );
    const simulation = executed.circuit.createSimulation([
      { network: executed.network('a'), values: new SparseBus([[A, 20]]) },
      { network: executed.network('b'), values: new SparseBus([[B, 7]]) },
    ]);
    const snapshot = simulation.step();

    expect(colors.get('a')).not.toBe(colors.get('b'));
    expect(snapshot.read(executed.network('out').id).get(C)).toBe(27);
    expect(snapshot.read(executed.network('out').id).get(A)).toBe(0);
    expect(snapshot.read(executed.network('out').id).get(B)).toBe(0);
  });

  test('accepts a one-Network IF feedback loop', () => {
    const parsed = parseFile({
      path: 'direct-if.factorio.ts',
      text: `const a = new Network();
a += IF(a > 0, a);`,
    });
    const compiled = compileDirectPlan(parsed);
    const executed = elaborateDirectPlan(compiled.plan!);
    const A = signal('virtual', 'signal-A');
    const simulation = executed.circuit.createSimulation([
      { network: executed.network('a'), values: new SparseBus([[A, 7]]) },
    ]);

    expect(simulation.step().read(executed.network('a').id).get(A)).toBe(7);
  });

  test('accepts an attached when(...).then(...) feedback loop', () => {
    const parsed = parseFile({
      path: 'attached-when.factorio.ts',
      text: `const a = new Network();
a += when(a > 0).then(a);`,
    });
    const compiled = compileDirectPlan(parsed);
    const executed = elaborateDirectPlan(compiled.plan!);
    const A = signal('virtual', 'signal-A');
    const simulation = executed.circuit.createSimulation([
      { network: executed.network('a'), values: new SparseBus([[A, 7]]) },
    ]);

    expect(compiled.diagnostics).toEqual([]);
    expect(simulation.step().read(executed.network('a').id).get(A)).toBe(7);
  });

  test('still checks connector capacity for an unbound when producer', () => {
    const parsed = parseFile({
      path: 'standalone-when.factorio.ts',
      text: `const a = new Network();
const b = new Network();
const c = new Network();
when(a > 0 && b > 0).then(c);`,
    });
    const compiled = compileDirectPlan(parsed);
    const result = tryElaborateDirectPlan(compiled.plan!);

    expect(compiled.diagnostics).toContainEqual(
      expect.objectContaining({ code: 'CL2001', severity: 'warning' }),
    );
    expect(result.execution).toBeUndefined();
    expect(result.diagnostics).toEqual([
      expect.objectContaining({ code: 'RT2009', severity: 'error' }),
    ]);
  });

  test('checks colors for standalone arithmetic despite its unused output warning', () => {
    const parsed = parseFile({
      path: 'standalone-arithmetic.factorio.ts',
      text: `const a = new Network<R>();
const b = new Network<R>();
a + b;`,
    });
    const compiled = compileDirectPlan(parsed);
    const result = tryElaborateDirectPlan(compiled.plan!);

    expect(compiled.diagnostics).toContainEqual(
      expect.objectContaining({ code: 'CL2001', severity: 'warning' }),
    );
    expect(result.execution).toBeUndefined();
    expect(result.diagnostics).toEqual([
      expect.objectContaining({ code: 'RT2010', severity: 'error' }),
    ]);
  });

  test('executes out += CC(...) as a persistent source device', () => {
    const parsed = parseFile({
      path: 'constant-combinator.factorio.ts',
      text: `const A = Signal("virtual", "signal-A");
const B = Signal("virtual", "signal-B");
const out = new Network();
out += CC(5 * A, -2 * B);`,
    });
    const compiled = compileDirectPlan(parsed);
    const executed = elaborateDirectPlan(compiled.plan!);
    const A = signal('virtual', 'signal-A');
    const B = signal('virtual', 'signal-B');
    const simulation = executed.circuit.createSimulation();

    expect(executed.circuit.graph.producers).toMatchObject([{ kind: 'constant' }]);
    expect(simulation.step().read(executed.network('out').id).get(A)).toBe(5);
    expect(simulation.step().read(executed.network('out').id).get(B)).toBe(-2);
  });

  test('fans one CC output bus into opposite-colored Networks', () => {
    const parsed = parseFile({
      path: 'constant-fanout.factorio.ts',
      text: `const A = Signal("virtual", "signal-A");
const first = new Network();
const second = new Network();
to(first, second) += CC(9 * A);`,
    });
    const compiled = compileDirectPlan(parsed);
    const executed = elaborateDirectPlan(compiled.plan!);
    const A = signal('virtual', 'signal-A');
    const colors = new Map(
      executed.circuit.ir.networks.map((network) => [network.name, network.color]),
    );
    const snapshot = executed.circuit.createSimulation().step();

    expect(colors.get('first')).not.toBe(colors.get('second'));
    expect(snapshot.read(executed.network('first').id).get(A)).toBe(9);
    expect(snapshot.read(executed.network('second').id).get(A)).toBe(9);
  });

  test('rejects a decider that needs more than two logical input Networks', () => {
    const parsed = parseFile({
      path: 'wide-if.factorio.ts',
      text: `const a = new Network();
const b = new Network();
const c = new Network();
const d = new Network();
d += IF(a > 0 || (b > 0 && c > 0), d);`,
    });
    const compiled = compileDirectPlan(parsed);
    const result = tryElaborateDirectPlan(compiled.plan!);

    expect(result.execution).toBeUndefined();
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        code: 'RT2009',
        severity: 'error',
        message: expect.stringMatching(/needs 4 logical networks on two wires/),
      }),
    ]);
  });

  test('rejects a global odd cycle of color constraints across producers', () => {
    const parsed = parseFile({
      path: 'odd-color-cycle.factorio.ts',
      text: `const a = new Network();
const b = new Network();
const c = new Network();
const first = new Network();
const second = new Network();
const third = new Network();
first += a + b;
second += b + c;
third += c + a;`,
    });
    const compiled = compileDirectPlan(parsed);
    const result = tryElaborateDirectPlan(compiled.plan!);

    expect(result.execution).toBeUndefined();
    expect(result.diagnostics).toEqual([
      expect.objectContaining({ code: 'RT2010', severity: 'error' }),
    ]);
  });

  test('elaborates and simulates a compact source IF as one decider tick', () => {
    const parsed = parseFile({
      path: 'gate.factorio.ts',
      text: `function Gate(input: Readonly<Network>): Network {
  return IF(input > 40, input);
}
const input = new Network<R>();
const output: Network = Gate(input);`,
    });
    const compiled = compileDirectPlan(parsed);
    const executed = elaborateDirectPlan(compiled.plan!);
    const A = signal('virtual', 'signal-A');
    const input = executed.network('input');
    const output = executed.network('output');

    expect(executed.circuit.graph.producers).toMatchObject([
      { kind: 'decider', provenance: { instancePath: ['Gate:output'] } },
    ]);
    const passing = executed.circuit.createSimulation([
      { network: input, values: new SparseBus([[A, 41]]) },
    ]);
    const blocked = executed.circuit.createSimulation([
      { network: input, values: new SparseBus([[A, 40]]) },
    ]);
    expect(passing.step().read(output.id).get(A)).toBe(41);
    expect(blocked.step().read(output.id).get(A)).toBe(0);
  });

  test('filters and copies one explicitly selected source Signal', () => {
    const parsed = parseFile({
      path: 'signal-gate.factorio.ts',
      text: `const SIGNAL_A = Signal("virtual", "signal-A");
function Gate(input: Readonly<Network>): Network {
  return IF(input[SIGNAL_A] > 40, input[SIGNAL_A]);
}
const input = new Network<R>();
const output: Network = Gate(input);`,
    });
    const compiled = compileDirectPlan(parsed);
    const executed = elaborateDirectPlan(compiled.plan!);
    const A = signal('virtual', 'signal-A');
    const B = signal('virtual', 'signal-B');
    const output = executed.network('output');
    const simulation = executed.circuit.createSimulation([
      {
        network: executed.network('input'),
        values: new SparseBus([
          [A, 41],
          [B, 99],
        ]),
      },
    ]);
    const snapshot = simulation.step();

    expect(snapshot.read(output.id).get(A)).toBe(41);
    expect(snapshot.read(output.id).get(B)).toBe(0);
    expect(executed.circuit.graph.producers).toMatchObject([
      {
        kind: 'decider',
        config: {
          condition: { left: { kind: 'signal', signal: A } },
          outputs: [{ signal: { kind: 'signal', signal: A } }],
        },
      },
    ]);
  });

  test('uses opposite input wire colors for a two-Network signal comparison', () => {
    const parsed = parseFile({
      path: 'network-comparison.factorio.ts',
      text: `const SIGNAL_A = Signal("virtual", "signal-A");
function Greater(
  value: Readonly<Network>,
  threshold: Readonly<Network>,
): Network {
  return IF(value[SIGNAL_A] > threshold[SIGNAL_A], value[SIGNAL_A]);
}
const value = new Network<R>();
const threshold = new Network();
const output: Network = Greater(value, threshold);`,
    });
    const compiled = compileDirectPlan(parsed);
    const executed = elaborateDirectPlan(compiled.plan!);
    const A = signal('virtual', 'signal-A');
    const colors = new Map(
      executed.circuit.ir.networks.map((network) => [network.name, network.color]),
    );
    const simulation = executed.circuit.createSimulation([
      { network: executed.network('value'), values: new SparseBus([[A, 41]]) },
      { network: executed.network('threshold'), values: new SparseBus([[A, 40]]) },
    ]);

    expect(colors.get('value')).toBe('red');
    expect(colors.get('threshold')).toBe('green');
    expect(simulation.step().read(executed.network('output').id).get(A)).toBe(41);
  });

  test('rejects equal fixed colors on a two-Network decider input', () => {
    const parsed = parseFile({
      path: 'network-comparison-conflict.factorio.ts',
      text: `const SIGNAL_A = Signal("virtual", "signal-A");
function Greater(
  value: Readonly<Network>,
  threshold: Readonly<Network>,
): Network {
  return IF(value[SIGNAL_A] > threshold[SIGNAL_A], value[SIGNAL_A]);
}
const value = new Network<R>();
const threshold = new Network<R>();
const output: Network = Greater(value, threshold);`,
    });
    const compiled = compileDirectPlan(parsed);
    const result = tryElaborateDirectPlan(compiled.plan!);

    expect(result.execution).toBeUndefined();
    expect(result.diagnostics).toEqual([
      expect.objectContaining({ code: 'RT2010', severity: 'error' }),
    ]);
  });

  test('evaluates compound source IF predicates in one decider', () => {
    const parsed = parseFile({
      path: 'window.factorio.ts',
      text: `function Window(input: Readonly<Network>): Network {
  return IF((input > 40 && input < 50) || input === 100, input);
}
const input = new Network<R>();
const output: Network = Window(input);`,
    });
    const compiled = compileDirectPlan(parsed);
    const executed = elaborateDirectPlan(compiled.plan!);
    const A = signal('virtual', 'signal-A');
    const input = executed.network('input');
    const output = executed.network('output');
    const resultFor = (value: number) =>
      executed.circuit
        .createSimulation([{ network: input, values: new SparseBus([[A, value]]) }])
        .step()
        .read(output.id)
        .get(A);

    expect(executed.circuit.graph.producers).toHaveLength(1);
    expect(resultFor(41)).toBe(41);
    expect(resultFor(50)).toBe(0);
    expect(resultFor(100)).toBe(100);
  });

  test('simulates a negated source predicate after De Morgan normalization', () => {
    const parsed = parseFile({
      path: 'negated-window.factorio.ts',
      text: `function Window(input: Readonly<Network>): Network {
  return IF(!(40 >= input || input >= 50), input);
}
const input = new Network<R>();
const output: Network = Window(input);`,
    });
    const compiled = compileDirectPlan(parsed);
    const executed = elaborateDirectPlan(compiled.plan!);
    const A = signal('virtual', 'signal-A');
    const input = executed.network('input');
    const output = executed.network('output');
    const resultFor = (value: number) =>
      executed.circuit
        .createSimulation([{ network: input, values: new SparseBus([[A, value]]) }])
        .step()
        .read(output.id)
        .get(A);

    expect(executed.circuit.graph.producers).toHaveLength(1);
    expect(resultFor(41)).toBe(41);
    expect(resultFor(40)).toBe(0);
    expect(resultFor(50)).toBe(0);
  });
});

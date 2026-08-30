import { compileDirectPlan } from '@comblang/compiler/direct-plan';
import { transformElaborationModule } from '@comblang/compiler/elaboration-transform';
import { parseFile } from '@comblang/language';
import { executeElaborationProgram } from '@comblang/runtime';
import { describe, expect, test } from 'vitest';

import { runSourcePlanDemo } from './source-demo.js';

function compileScale(multiplier: number) {
  const parsed = parseFile({
    path: 'main.factorio.ts',
    text: `function Scale(input: Readonly<Network>): Network {
  return input * ${multiplier};
}
const input = new Network<R>();
const output: Network = Scale(input);`,
  });
  const result = compileDirectPlan(parsed);
  if (result.plan === undefined) throw new Error('Scale fixture did not compile.');
  return result.plan;
}

describe('source-driven homepage proof', () => {
  test('colors declared Networks even when the source has no producers', () => {
    const parsed = parseFile({
      path: 'declarations.factorio.ts',
      text: `let a = new Network();
let b = new Network<G>();`,
    });
    const demo = runSourcePlanDemo(compileDirectPlan(parsed).plan!);

    expect(demo).toMatchObject({ combinators: 0, attachments: 0, stages: 0, waveform: [] });
    expect(demo.colors).toEqual([
      { name: 'a', color: 'red' },
      { name: 'b', color: 'green' },
    ]);
  });

  test('uses the current compiled multiplier', () => {
    expect(runSourcePlanDemo(compileScale(10)).outputValue).toBe(70);
    expect(runSourcePlanDemo(compileScale(3)).outputValue).toBe(21);
  });

  test('simulates every physical stage of an arithmetic chain', () => {
    const parsed = parseFile({
      path: 'pipeline.factorio.ts',
      text: `function Pipeline(input: Readonly<Network>): Network {
  return input * 10 + 5;
}
const input = new Network<R>();
const output: Network = Pipeline(input);`,
    });
    const compiled = compileDirectPlan(parsed);
    if (compiled.plan === undefined) throw new Error('Pipeline fixture did not compile.');

    const demo = runSourcePlanDemo(compiled.plan);
    expect(demo).toMatchObject({
      combinators: 2,
      attachments: 2,
      stages: 2,
      outputValue: 75,
    });
    expect(demo.waveform.map((sample) => sample.output)).toEqual([0, 0, 75]);
  });

  test('uses a folded integer subexpression without adding a physical stage', () => {
    const parsed = parseFile({
      path: 'folded-pipeline.factorio.ts',
      text: `function Pipeline(input: Readonly<Network>): Network {
  const scale = 2 + 3;
  const bias = 10 / 2;
  const scaled = input * scale;
  return scaled + bias;
}
const input = new Network<R>();
const output: Network = Pipeline(input);`,
    });
    const compiled = compileDirectPlan(parsed);
    if (compiled.plan === undefined) throw new Error('Folded Pipeline fixture did not compile.');

    const demo = runSourcePlanDemo(compiled.plan);
    expect(demo).toMatchObject({
      combinators: 2,
      attachments: 2,
      stages: 2,
      outputValue: 40,
    });
    expect(demo.colors).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: '$local:1:scaled' })]),
    );
    expect(demo.waveform.map((sample) => sample.output)).toEqual([0, 0, 40]);
  });

  test('simulates a pipeline composed from multiple source functions', () => {
    const parsed = parseFile({
      path: 'composed.factorio.ts',
      text: `function Scale(input: Readonly<Network>): Network {
  const factor = 2 + 3;
  const scaled = input * factor;
  return scaled + 1;
}
function Bias(input: Readonly<Network>): Network {
  const bias = 10 / 2;
  return input + bias;
}
const input = new Network<R>();
const middle: Network = Scale(input);
const output: Network = Bias(middle);`,
    });
    const compiled = compileDirectPlan(parsed);
    if (compiled.plan === undefined) throw new Error('Composed Pipeline fixture did not compile.');

    const demo = runSourcePlanDemo(compiled.plan);
    expect(demo).toMatchObject({ combinators: 3, attachments: 3, stages: 3, outputValue: 41 });
    expect(demo.waveform.map((sample) => sample.output)).toEqual([0, 0, 0, 41]);
    expect(demo.colors).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: '$local:1:scaled' })]),
    );
  });

  test('includes a compact source IF in the waveform pipeline', () => {
    const parsed = parseFile({
      path: 'gate.factorio.ts',
      text: `function Gate(input: Readonly<Network>): Network {
  return IF(input > 40, input);
}
const input = new Network<R>();
const output: Network = Gate(input);`,
    });
    const compiled = compileDirectPlan(parsed);

    expect(runSourcePlanDemo(compiled.plan!, 41)).toMatchObject({
      combinators: 1,
      stages: 1,
      outputValue: 41,
      waveform: [
        { tick: 0, output: 0 },
        { tick: 1, output: 41 },
      ],
    });
    expect(runSourcePlanDemo(compiled.plan!, 40).outputValue).toBe(0);
  });

  test('runs a source plan attached to an existing Network with +=', () => {
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

    expect(runSourcePlanDemo(compiled.plan!)).toMatchObject({
      combinators: 1,
      attachments: 1,
      stages: 1,
      outputValue: 70,
    });
  });

  test('shows two differently colored outputs for .to(...) fan-out', () => {
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
    const demo = runSourcePlanDemo(compiled.plan!);
    const colors = new Map(demo.colors.map(({ name, color }) => [name, color]));

    expect(demo).toMatchObject({ combinators: 1, attachments: 2, outputValue: 7 });
    expect(colors.get('output')).not.toBe(colors.get('mirror'));
  });

  test('shows opposite input colors for a two-Network decider', () => {
    const parsed = parseFile({
      path: 'network-comparison.factorio.ts',
      text: `const SIGNAL_A = Signal("virtual", "signal-A");
function Gate(input: Readonly<Network>, threshold: Readonly<Network>): Network {
  return IF(input[SIGNAL_A] > threshold[SIGNAL_A], input[SIGNAL_A]);
}
const input = new Network<R>();
const threshold = new Network();
const output: Network = Gate(input, threshold);`,
    });
    const demo = runSourcePlanDemo(compileDirectPlan(parsed).plan!, 7);
    const colors = new Map(demo.colors.map(({ name, color }) => [name, color]));

    expect(demo.outputValue).toBe(7);
    expect(colors.get('input')).toBe('red');
    expect(colors.get('threshold')).toBe('green');
  });

  test('shows independent input and output color pairs for direct arithmetic', () => {
    const parsed = parseFile({
      path: 'direct-arithmetic.factorio.ts',
      text: `const a = new Network();
const b = new Network();
const c = new Network();
const d = new Network();
to(c, d) += a + b;`,
    });
    const demo = runSourcePlanDemo(compileDirectPlan(parsed).plan!, 7);
    const colors = new Map(demo.colors.map(({ name, color }) => [name, color]));

    expect(demo.outputValue).toBe(7);
    expect(colors.get('a')).not.toBe(colors.get('b'));
    expect(colors.get('c')).not.toBe(colors.get('d'));
  });

  test('keeps an unbound producer simulatable without exposing its internal sink', () => {
    const parsed = parseFile({
      path: 'unused-producer.factorio.ts',
      text: `const a = new Network();
a + 1;`,
    });
    const compiled = compileDirectPlan(parsed);
    const demo = runSourcePlanDemo(compiled.plan!, 7);

    expect(compiled.diagnostics).toContainEqual(
      expect.objectContaining({ code: 'CL2001', severity: 'warning' }),
    );
    expect(demo.outputValue).toBe(8);
    expect(demo.colors.map(({ name }) => name)).toEqual(['a']);
  });

  test('simulates a contextual CC source without an input Network', () => {
    const parsed = parseFile({
      path: 'constant-combinator.factorio.ts',
      text: `const A = Signal("virtual", "signal-A");
const constants: Network = CC(12 * A);`,
    });
    const compiled = compileDirectPlan(parsed);
    const demo = runSourcePlanDemo(compiled.plan!);

    expect(compiled.diagnostics).toEqual([]);
    expect(demo).toMatchObject({
      combinators: 1,
      attachments: 1,
      stages: 1,
      outputNetwork: 'constants',
      outputValue: 12,
    });
    expect(demo.inputNetwork).toBeUndefined();
  });

  test('does not count a parallel CC source as an extra serial stage', () => {
    const parsed = parseFile({
      path: 'constant-threshold.factorio.ts',
      text: `const A = Signal("virtual", "signal-A");
const input = new Network();
const delayed = new Network();
delayed += input + 0;
const threshold = new Network();
threshold += CC(4 * A);
const output = new Network();
output += IF(delayed[A] > threshold[A], delayed[A]);`,
    });
    const compiled = compileDirectPlan(parsed);
    const demo = runSourcePlanDemo(compiled.plan!, 7);

    expect(compiled.diagnostics).toEqual([]);
    expect(demo).toMatchObject({ combinators: 3, stages: 2, outputValue: 7 });
  });

  test('simulates a direct contextual arithmetic declaration', () => {
    const parsed = parseFile({
      path: 'contextual-arithmetic.factorio.ts',
      text: `const input = new Network();
const output: Network = input * 3;`,
    });
    const compiled = compileDirectPlan(parsed);
    const demo = runSourcePlanDemo(compiled.plan!, 7);

    expect(compiled.diagnostics).toEqual([]);
    expect(demo).toMatchObject({ combinators: 1, stages: 1, outputValue: 21 });
  });

  test('simulates a constant EACH decider output as one physical stage', () => {
    const parsed = parseFile({
      path: 'constant-each-output.factorio.ts',
      text: `const input = new Network();
const output: Network = IF(input > 0, 255 * EACH);`,
    });
    const compiled = compileDirectPlan(parsed);
    const demo = runSourcePlanDemo(compiled.plan!, 7);

    expect(compiled.diagnostics).toEqual([]);
    expect(demo).toMatchObject({ combinators: 1, stages: 1, outputValue: 255 });
  });

  test('simulates explicit Each syntax through arithmetic and decider stages', () => {
    const parsed = parseFile({
      path: 'explicit-each.factorio.ts',
      text: `const input = new Network();
const scaled: Network = Each(input) * 2;
const output: Network = IF(scaled[EACH] > 0, Each(scaled));`,
    });
    const compiled = compileDirectPlan(parsed);
    const demo = runSourcePlanDemo(compiled.plan!, 7);

    expect(compiled.diagnostics).toEqual([]);
    expect(demo).toMatchObject({ combinators: 2, stages: 2, outputValue: 14 });
  });

  test('simulates an Anything condition selection', () => {
    const parsed = parseFile({
      path: 'anything-condition.factorio.ts',
      text: `const A = Signal("virtual", "signal-A");
const input = new Network();
const output: Network = IF(Anything(input) > 0, input[A]);`,
    });
    const compiled = compileDirectPlan(parsed);
    const demo = runSourcePlanDemo(compiled.plan!, 7);

    expect(compiled.diagnostics).toEqual([]);
    expect(demo).toMatchObject({ combinators: 1, stages: 1, outputValue: 7 });
  });

  test('simulates an Anything output selection', () => {
    const parsed = parseFile({
      path: 'anything-output.factorio.ts',
      text: `const input = new Network();
const output: Network = IF(input > 0, Anything(input));`,
    });
    const compiled = compileDirectPlan(parsed);
    const demo = runSourcePlanDemo(compiled.plan!, 7);

    expect(compiled.diagnostics).toEqual([]);
    expect(demo).toMatchObject({ combinators: 1, stages: 1, outputValue: 7 });
  });

  test('simulates an Everything output after an Anything condition', () => {
    const parsed = parseFile({
      path: 'everything-output.factorio.ts',
      text: `const input = new Network();
const output: Network = IF(Anything(input) > 0, Everything(input));`,
    });
    const compiled = compileDirectPlan(parsed);
    const demo = runSourcePlanDemo(compiled.plan!, 7);

    expect(compiled.diagnostics).toEqual([]);
    expect(demo).toMatchObject({ combinators: 1, stages: 1, outputValue: 7 });
  });

  test('simulates Any and All aliases', () => {
    const parsed = parseFile({
      path: 'quantifier-aliases.factorio.ts',
      text: `const input = new Network();
const output: Network = IF(Any(input) > 0, All(input));`,
    });
    const compiled = compileDirectPlan(parsed);
    const demo = runSourcePlanDemo(compiled.plan!, 7);

    expect(compiled.diagnostics).toEqual([]);
    expect(demo).toMatchObject({ combinators: 1, stages: 1, outputValue: 7 });
  });

  test('simulates an executed pair as a summed two-color input view', () => {
    const parsed = parseFile({
      path: 'pair.factorio.ts',
      text: `const A = Signal('virtual', 'signal-A');
const red: Network<R> = CC(2 * A);
const green: Network<G> = CC(3 * A);
const inputs = pair(red, green);
const output: Network = inputs[A] + 0;`,
    });
    const plan = executeElaborationProgram(transformElaborationModule(parsed));
    const demo = runSourcePlanDemo(plan);
    const colors = new Map(demo.colors.map(({ name, color }) => [name, color]));

    expect(demo).toMatchObject({ combinators: 3, stages: 2, outputValue: 5 });
    expect(colors.get('red')).toBe('red');
    expect(colors.get('green')).toBe('green');
  });
});

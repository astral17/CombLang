import { compileDirectPlan } from '@comblang/compiler/direct-plan';
import { parseFile } from '@comblang/language';
import { describe, expect, test } from 'vitest';

import { blueprintJsonForPlan } from './blueprint-demo.js';
import { compileSource } from './compile-source.js';

describe('source blueprint JSON preview', () => {
  test('retains executed operand colors, output selection, and nested condition groups', () => {
    const result = compileSource({
      path: 'blueprint-colors.factorio.ts',
      text: `
const A = Signal('virtual', 'signal-A');
const B = Signal('virtual', 'signal-B');
const red: Network<R> = CC(5 * A, 1 * B);
const green: Network<G> = CC(2 * A, 2 * B);
const difference = red[A] - green[A];
const result = when((red[A] > 0 && green[A] > 0) || (red[B] > 0 && green[B] > 0)).then(green[A]).else(red[A]);`,
    });
    expect(result.compilerDiagnostics).toEqual([]);
    const entities = blueprintJsonForPlan(result.plan!).blueprint.entities;
    const arithmetic = entities.find(({ name }) => name === 'arithmetic-combinator')!;
    expect(arithmetic).toMatchObject({
      control_behavior: {
        arithmetic_conditions: {
          first_signal_networks: { red: true, green: false },
          second_signal_networks: { red: false, green: true },
        },
      },
    });
    const decider = entities.find(({ name }) => name === 'decider-combinator')!;
    expect(decider).toMatchObject({
      control_behavior: {
        decider_conditions: {
          conditions: [
            { compare_type: 'and' },
            { compare_type: 'and' },
            { compare_type: 'or' },
            { compare_type: 'and' },
          ],
          outputs: [{ networks: { red: false, green: true } }],
          else_outputs: [{ networks: { red: true, green: false } }],
        },
      },
    });
  });

  test('converts source through lowering, color solving, and JSON generation', () => {
    const parsed = parseFile({
      path: 'blueprint.factorio.ts',
      text: `const A = Signal("virtual", "signal-A");
const constants: Network = CC(5 * A);
const output: Network = constants * 2;`,
    });
    const compiled = compileDirectPlan(parsed);
    const generated = blueprintJsonForPlan(compiled.plan!);

    expect(compiled.diagnostics).toEqual([]);
    expect(generated.blueprint.entities.map((entity) => entity.name)).toEqual([
      'constant-combinator',
      'arithmetic-combinator',
    ]);
    expect(generated.blueprint.wires).toHaveLength(1);
  });
});

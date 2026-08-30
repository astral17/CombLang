import { transformElaborationModule } from '@comblang/compiler/elaboration-transform';
import { parseFile } from '@comblang/language';
import { describe, expect, test } from 'vitest';

import { executeElaborationProgram } from './elaboration-program.js';

function planFor(name: string, text: string) {
  const parsed = parseFile({ path: `${name}.factorio.ts`, text });
  expect(parsed.diagnostics).toEqual([]);
  return executeElaborationProgram(transformElaborationModule(parsed));
}

describe('producer materialization design benchmarks', () => {
  test('Scale keeps value-oriented inferred Networks', () => {
    const plan = planFor(
      'benchmark-scale',
      `function Scale(input: Readonly<Network>): Network {
  const scaled = input * 10;
  return scaled;
}
const input = new Network();
const output = Scale(input);`,
    );

    expect(plan.producers).toHaveLength(1);
    expect(plan.producers[0]).toMatchObject({
      kind: 'arithmetic',
      destinations: [{ network: 'scaled' }],
    });
  });

  test('Distance reuses materialized intermediates without cloning producers', () => {
    const plan = planFor(
      'benchmark-distance',
      `const x1 = new Network();
const x2 = new Network();
const y1 = new Network();
const y2 = new Network();
const dx = x1 - x2;
const dy = y1 - y2;
const squaredX = dx * dx;
const squaredY = dy * dy;
const distanceSquared = squaredX + squaredY;`,
    );

    expect(plan.producers).toHaveLength(5);
    expect(plan.producers[2]).toMatchObject({
      left: { kind: 'each', network: 'dx' },
      right: { kind: 'each', network: 'dx' },
    });
    expect(plan.producers[3]).toMatchObject({
      left: { kind: 'each', network: 'dy' },
      right: { kind: 'each', network: 'dy' },
    });
  });

  test('MemoCell consumes producers directly into explicit fan-out topology', () => {
    const plan = planFor(
      'benchmark-memo-cell',
      `function MemoCell(input: Readonly<Network>): Network {
  const out = new Network();
  const memory = new Network();
  to(out, memory) += input + 0;
  to(out, memory) += IF(input == 0 && memory != 0, memory);
  return out;
}
const input = new Network();
const output = MemoCell(input);`,
    );

    expect(plan.producers).toHaveLength(2);
    expect(plan.producers).toMatchObject([
      { kind: 'arithmetic', destinations: [{ network: 'out' }, { network: 'memory' }] },
      { kind: 'decider', destinations: [{ network: 'out' }, { network: 'memory' }] },
    ]);
  });

  test('RGB indicator defaults to Networks but explicit annotations retain handles', () => {
    const plan = planFor(
      'benchmark-rgb',
      `const A = Signal('virtual', 'signal-A');
const RED = Signal('virtual', 'signal-red');
const GREEN = Signal('virtual', 'signal-green');
const BLUE = Signal('virtual', 'signal-blue');
const level = new Network();
const red = IF(level[A] > 0, 1 * RED);
const green = IF(level[A] > 1, 1 * GREEN);
const blue: DeciderCombinator = IF(level[A] > 2, 1 * BLUE);
const blueOutput = new Network();
blueOutput += blue;`,
    );

    expect(plan.producers).toHaveLength(3);
    expect(plan.producers).toMatchObject([
      { kind: 'decider', destinations: [{ network: 'red' }] },
      { kind: 'decider', destinations: [{ network: 'green' }] },
      { kind: 'decider', destinations: [{ network: 'blueOutput' }] },
    ]);
    expect(plan.networks.map(({ name }) => name)).not.toContain('blue');
  });
});

import { transformElaborationModule } from '@comblang/compiler';
import { parseFile, validateDslSemantics } from '@comblang/language';
import { describe, expect, test } from 'vitest';

import { elaborateDirectPlan } from './direct-plan.js';
import { executeElaborationProgram } from './elaboration-program.js';

describe('semantic, transform, and runtime language contract', () => {
  test('executes ordinary fluent names and operators as JavaScript', () => {
    const parsed = parseFile({
      path: 'ordinary-contract.ts',
      text: `const value = {
  kind: "producer",
  producer: { kind: "arithmetic" },
  as(input: number) { return input + 1; },
  to(input: number) { return input * 2; },
  at(x: number, y: number) { return x + y; },
  take(input: number) { return input - 1; },
};
const networkConfig = { kind: "network", name: "ordinary-config" };
const values = [value.as(1), value.to(2), value.at(3, 4), value.take(5)];
if (values[0] !== 2 || values[1] !== 4 || values[2] !== 7 || values[3] !== 4 || networkConfig.name !== "ordinary-config") {
  throw new Error("ordinary contract changed");
}`,
    });

    expect(validateDslSemantics(parsed)).toEqual([]);
    const plan = executeElaborationProgram(transformElaborationModule(parsed));
    expect(plan.networks).toEqual([]);
    expect(plan.producers).toEqual([]);
  });

  test('routes the same fluent spellings from DSL handles into one physical plan', () => {
    const parsed = parseFile({
      path: 'dsl-contract.factorio.ts',
      text: `const A = Signal("virtual", "signal-A");
const input = new Network<R>();
const first = new Network<R>();
const second = new Network<G>();
const producer: ArithmeticCombinator = (input + 1).at(1, 2);
producer.to(first, second, A);
const combined: Network = pair(first, second)[A] + 0;`,
    });

    expect(validateDslSemantics(parsed)).toEqual([]);
    const plan = executeElaborationProgram(transformElaborationModule(parsed));
    expect(plan.producers).toHaveLength(2);
    expect(plan.networkPairs).toMatchObject([{ networks: ['first', 'second'] }]);
    expect(plan.producers[0]).toMatchObject({
      placement: { x: 1, y: 2 },
      destinations: [{ network: 'first' }, { network: 'second' }],
    });
    expect(elaborateDirectPlan(plan).circuit.graph.producers).toHaveLength(2);
  });
});

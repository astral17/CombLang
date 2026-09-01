import { transformElaborationModule } from '@comblang/compiler/elaboration-transform';
import { parseFile } from '@comblang/language';
import { describe, expect, it } from 'vitest';

import { StructureAssertionError } from './debug-structure.js';
import { elaborateDirectPlan } from './direct-plan.js';
import { executeElaborationProgram } from './elaboration-program.js';

function pipelineExecution() {
  const parsed = parseFile({
    path: 'structure.factorio.ts',
    text: `function Pipeline(input: Readonly<Network>): {
  middle: Network;
  output: Network;
  merged: Network;
} {
  const middle = new Network();
  const output = new Network();
  const add: ArithmeticCombinator = (input + 1).at(10, 20, 2);
  middle += add;
  output += middle * 2;
  const merged = new Network();
  const consumed = new Network();
  merged.take(consumed);
  return { middle, output, merged };
}
const input = new Network();
const dut = t.instantiate(Pipeline, input);`,
  });
  return elaborateDirectPlan(
    executeElaborationProgram(transformElaborationModule(parsed, { testContextName: 't' })),
  );
}

describe('debug structural assertions', () => {
  it('checks recursive counts, presence, configuration, placement, aliases, and latency', () => {
    const execution = pipelineExecution();
    const dut = execution.instance('dut');
    const structure = execution.structure(dut.$);
    const session = execution.createTestSession();
    const tickBefore = session.currentTick;

    expect(
      structure
        .toHaveProducerCounts({ arithmetic: 2, decider: 0, constant: 0 })
        .toHaveNetwork('middle')
        .toHaveProducer('add', { producerKind: 'arithmetic' })
        .toHavePlacement('add', { x: 10, y: 20, direction: 2 })
        .toMatchConfiguration('add', {
          operation: 'add',
          right: { kind: 'constant', value: 1 },
        })
        .toBeZeroTickAlias('merged', 'consumed')
        .toHaveTickLatency(execution.debug.root.network('input'), 'output', 2)
        .toHaveTickLatency('middle', 'output', 1),
    ).toBe(structure);
    expect(session.currentTick).toBe(tickBefore);
  });

  it('returns structured failures without advancing simulation', () => {
    const execution = pipelineExecution();
    const structure = execution.structure(execution.instance('dut').$);
    const session = execution.createTestSession();

    expect(() => structure.toHaveProducerCounts({ arithmetic: 3 })).toThrowError(
      expect.objectContaining({
        code: 'DBG2001',
        details: expect.objectContaining({
          matcher: 'toHaveProducerCounts',
          expected: { arithmetic: 3 },
        }),
      }),
    );
    expect(() => structure.toHavePlacement('add', undefined)).toThrowError(StructureAssertionError);
    expect(() => structure.toHaveTickLatency('middle', 'output', 2)).toThrowError(
      expect.objectContaining({
        code: 'DBG2001',
        details: expect.objectContaining({ matcher: 'toHaveTickLatency', actual: 1 }),
      }),
    );
    expect(() => structure.toHaveNetwork('missing')).toThrowError(StructureAssertionError);
    expect(session.currentTick).toBe(0);
  });

  it('visits typed Network references instead of matching arbitrary config strings', () => {
    const parsed = parseFile({
      path: 'structure-string-collision.factorio.ts',
      text: `const COLLISION = Signal("item", "network:1");
const unrelated = new Network();
const output: Network = CC(1 * COLLISION);`,
    });
    const execution = elaborateDirectPlan(
      executeElaborationProgram(transformElaborationModule(parsed)),
    );

    expect(execution.debug.root.network('unrelated').id).toBe('network:1');
    expect(() => execution.structure().toHaveTickLatency('unrelated', 'output', 1)).toThrowError(
      expect.objectContaining({
        code: 'DBG2001',
        message: expect.stringContaining('received no path'),
        details: expect.objectContaining({ matcher: 'toHaveTickLatency' }),
      }),
    );
  });
});

import { transformElaborationModule } from '@comblang/compiler/elaboration-transform';
import { parseFile } from '@comblang/language';
import { describe, expect, it } from 'vitest';

import { DebugQueryError } from './debug-index.js';
import { elaborateDirectPlan } from './direct-plan.js';
import { executeElaborationProgram } from './elaboration-program.js';

describe('executed debug index', () => {
  it('indexes physical Networks and Producers by exact function and loop scope', () => {
    const parsed = parseFile({
      path: 'debug-index.factorio.ts',
      text: `function Stage(input: Readonly<Network>, offset: number): Network {
  let local = input + offset;
  for (let i = 0; i < 2; i++) {
    local += local + i;
  }
  return local;
}
const input = new Network();
const first = Stage(input, 1);
const second = Stage(input, 2);`,
    });
    const plan = executeElaborationProgram(transformElaborationModule(parsed));
    const execution = elaborateDirectPlan(plan);
    const debug = execution.debug;

    expect(debug.root.network('input').id).toBe(execution.network('input').id);
    const stage = debug.root.child('function Stage');
    expect(stage.combinators()).toHaveLength(2);
    expect(stage.combinator(1)).toMatchObject({
      kind: 'producer',
      producerKind: 'arithmetic',
      ordinal: 1,
      kindOrdinal: 1,
    });
    expect(stage.combinator(2).id).toBe(execution.circuit.graph.producers[3]?.id);

    const firstIteration = stage.child('for i=0');
    const secondIteration = stage.child('for i=1');
    expect(firstIteration.combinators()).toHaveLength(2);
    expect(secondIteration.combinators()).toHaveLength(2);
    expect(debug.scope(['function Stage', 'for i=1'])).toBe(secondIteration);
    expect(
      parsed.text.slice(
        firstIteration.combinator(1).source.start,
        firstIteration.combinator(1).source.end,
      ),
    ).toContain('local + i');
  });

  it('reports repeated lexical bindings as deterministic ambiguity', () => {
    const parsed = parseFile({
      path: 'debug-ambiguity.factorio.ts',
      text: `function Stage(input: Readonly<Network>): Network {
  const local = input + 1;
  return local;
}
const input = new Network();
const first = Stage(input);
const second = Stage(input);`,
    });
    const execution = elaborateDirectPlan(
      executeElaborationProgram(transformElaborationModule(parsed)),
    );
    const stage = execution.debug.root.child('function Stage');

    expect(() => stage.network('local')).toThrowError(
      expect.objectContaining({
        code: 'DBG1002',
        candidates: ['function Stage: local', 'function Stage: $instance:2:local'],
      }),
    );
    expect(() => stage.network('missing')).toThrowError(
      expect.objectContaining({ code: 'DBG1001' }),
    );
    expect(() => stage.combinator(3)).toThrowError(expect.objectContaining({ code: 'DBG1001' }));
    expect(() => execution.debug.scope(['missing'])).toThrowError(DebugQueryError);
  });

  it('retains zero-tick moved declarations as debug entries sharing one physical ID', () => {
    const parsed = parseFile({
      path: 'debug-move.factorio.ts',
      text: `const destination = new Network();
const source = new Network();
destination.take(source);`,
    });
    const execution = elaborateDirectPlan(
      executeElaborationProgram(transformElaborationModule(parsed)),
    );
    const destination = execution.debug.root.network('destination');
    const source = execution.debug.root.network('source');

    expect(source).toMatchObject({ moved: true });
    expect(destination).toMatchObject({ moved: false });
    expect(source.id).toBe(destination.id);
  });
});

import { transformElaborationModule } from '@comblang/compiler/elaboration-transform';
import { Signal } from '@comblang/factorio';
import { parseFile } from '@comblang/language';
import { describe, expect, it } from 'vitest';

import { DebugQueryError } from './debug-index.js';
import { elaborateDirectPlan } from './direct-plan.js';
import type { NetworkHandle } from './elaboration.js';
import { executeElaborationProgram } from './elaboration-program.js';

describe('executed debug index', () => {
  it('retains caller aliases for existing function returns without creating hardware', () => {
    const parsed = parseFile({
      path: 'debug-return-alias.factorio.ts',
      text: `function Cell(): Network {
  const out = new Network();
  out += CC();
  return out;
}
const output = Cell();
const secondOutput = Cell();`,
    });
    const plan = executeElaborationProgram(transformElaborationModule(parsed));
    const execution = elaborateDirectPlan(plan);
    const firstOut = execution.debug.root.child('function Cell').network('out');
    const secondOut = execution.debug.root.child('function Cell #2').network('out');

    expect(plan.networkAliases).toMatchObject([
      { name: 'output', network: 'out', instancePath: [], moved: false },
      { name: 'secondOutput', network: '$instance:2:out', instancePath: [], moved: false },
    ]);
    expect(execution.network('output').id).toBe(firstOut.id);
    expect(execution.network('secondOutput').id).toBe(secondOut.id);
    expect(execution.debug.root.network('output')).toMatchObject({
      planName: 'out',
      id: firstOut.id,
      moved: false,
      internal: false,
    });
    expect(execution.circuit.graph.networks).toHaveLength(2);
    expect(execution.circuit.graph.producers).toHaveLength(2);
  });

  it('keeps final assignment aliases and invalidates aliases of consumed ownership', () => {
    const rebound = elaborateDirectPlan(
      executeElaborationProgram(
        transformElaborationModule(
          parseFile({
            path: 'debug-reassignment.factorio.ts',
            text: `const original = new Network();
const replacement = new Network();
let selected = original;
const retained = selected;
selected = replacement;`,
          }),
        ),
      ),
    );
    expect(rebound.network('selected').id).toBe(rebound.network('replacement').id);
    expect(rebound.network('retained').id).toBe(rebound.network('original').id);
    expect(rebound.debug.root.network('selected').planName).toBe('replacement');

    const moved = elaborateDirectPlan(
      executeElaborationProgram(
        transformElaborationModule(
          parseFile({
            path: 'debug-moved-alias.factorio.ts',
            text: `const source = new Network();
const alias = source;
const destination = new Network();
destination.take(source);`,
          }),
        ),
      ),
    );
    expect(moved.debug.root.network('alias')).toMatchObject({ planName: 'source', moved: true });
    expect(() => moved.network('alias')).toThrowError(
      expect.objectContaining({
        diagnostic: expect.objectContaining({ code: 'RT2012' }),
      }),
    );
    expect(() =>
      moved.createTestSession().readValue(moved.debug.root.network('alias')),
    ).toThrowError(
      expect.objectContaining({ diagnostic: expect.objectContaining({ code: 'RT2012' }) }),
    );
  });

  it('reads final lexical bindings after loop and closure assignments', () => {
    const parsed = parseFile({
      path: 'debug-lexical-alias.factorio.ts',
      text: `const first = new Network();
const second = new Network();
let selected = first;
let original = new Network();
for (let i = 0; i < 2; i++) {
  selected = second;
}
function replace() { original = second; }
replace();`,
    });
    const execution = elaborateDirectPlan(
      executeElaborationProgram(transformElaborationModule(parsed)),
    );
    expect(execution.network('selected').id).toBe(execution.network('second').id);
    expect(execution.network('original').id).toBe(execution.network('second').id);
    expect(execution.debug.root.network('selected').instancePath).toEqual([]);
    expect(execution.debug.root.network('original').planName).toBe('second');
    expect(execution.circuit.graph.networks).toHaveLength(3);
  });

  it('keeps readonly returns and same-named caller bindings queryable', () => {
    const parsed = parseFile({
      path: 'debug-readonly-return.factorio.ts',
      text: `function Cell(): Readonly<Network> {
  const out = new Network();
  return out;
}
const out = Cell();`,
    });
    const execution = elaborateDirectPlan(
      executeElaborationProgram(transformElaborationModule(parsed)),
    );
    const caller = execution.debug.root.network('out');
    expect(caller.id).toBe(execution.debug.root.child('function Cell').network('out').id);
    expect(caller.moved).toBe(false);
    expect(execution.network('out').id).toBe(caller.id);
  });

  it('preserves ambiguity between separate lexical declarations in the same debug scope', () => {
    const parsed = parseFile({
      path: 'debug-shadowed-alias.factorio.ts',
      text: `const first = new Network();
const second = new Network();
{ const selected = first; }
{ const selected = second; }`,
    });
    const execution = elaborateDirectPlan(
      executeElaborationProgram(transformElaborationModule(parsed)),
    );
    expect(() => execution.debug.root.network('selected')).toThrowError(
      expect.objectContaining({ code: 'DBG1002', scopePath: [] }),
    );
    expect(() => execution.network('selected')).toThrowError(
      expect.objectContaining({ code: 'DBG1002', scopePath: [] }),
    );
  });

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
    const secondStage = debug.root.child('function Stage #2');
    expect(stage.combinators()).toHaveLength(1);
    expect(secondStage.combinators()).toHaveLength(1);
    expect(stage.combinator(1)).toMatchObject({
      kind: 'producer',
      producerKind: 'arithmetic',
      ordinal: 1,
      kindOrdinal: 1,
    });
    expect(secondStage.combinator(1).id).toBe(execution.circuit.graph.producers[3]?.id);

    const firstIteration = stage.child('for i=0');
    const secondIteration = stage.child('for i=1');
    expect(firstIteration.combinators()).toHaveLength(1);
    expect(secondIteration.combinators()).toHaveLength(1);
    expect(debug.scope(['function Stage', 'for i=1'])).toBe(secondIteration);
    expect(
      parsed.text.slice(
        firstIteration.combinator(1).source.start,
        firstIteration.combinator(1).source.end,
      ),
    ).toContain('local + i');
  });

  it('separates repeated dynamic calls into deterministic sibling scopes', () => {
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
    const repeatedStage = execution.debug.root.child('function Stage #2');

    expect(stage.network('local')).toMatchObject({ name: 'local', planName: 'local' });
    expect(repeatedStage.network('local')).toMatchObject({
      name: 'local',
      planName: '$instance:2:local',
    });
    expect(stage.network('local').id).not.toBe(repeatedStage.network('local').id);
    expect(() => stage.network('missing')).toThrowError(
      expect.objectContaining({ code: 'DBG1001' }),
    );
    expect(() => stage.combinator(2)).toThrowError(expect.objectContaining({ code: 'DBG1001' }));
    expect(() => execution.debug.scope(['missing'])).toThrowError(DebugQueryError);
  });

  it('resolves an explicitly bound Producer by its source name', () => {
    const parsed = parseFile({
      path: 'debug-named-producer.factorio.ts',
      text: `function Stage(input: Readonly<Network>): Network {
  const output = new Network();
  const copy: ArithmeticCombinator = input + 0;
  output += copy;
  return output;
}
const input = new Network();
const output = Stage(input);`,
    });
    const execution = elaborateDirectPlan(
      executeElaborationProgram(transformElaborationModule(parsed)),
    );
    const stage = execution.debug.root.child('function Stage');

    expect(stage.combinator('copy')).toBe(stage.combinator(1));
    expect(stage.combinator('copy')).toMatchObject({
      name: 'copy',
      producerKind: 'arithmetic',
    });
    expect(() => stage.combinator('missing')).toThrowError(
      expect.objectContaining({ code: 'DBG1001', candidates: ['1: copy'] }),
    );
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

    const session = execution.createTestSession();
    expect(() => session.drive(source, [[Signal('virtual', 'signal-A'), 1]])).toThrowError(
      expect.objectContaining({ diagnostic: expect.objectContaining({ code: 'RT2012' }) }),
    );
    session.drive(destination, [[Signal('virtual', 'signal-A'), 2]]).tick();
    expect(session.read(destination).get(Signal('virtual', 'signal-A'))).toBe(2);
  });

  it('uses debug Networks as external test targets without inheriting source capabilities', () => {
    const parsed = parseFile({
      path: 'debug-test-target.factorio.ts',
      text: `function Stage(input: Readonly<Network>): Network {
  const local = new Network();
  local += input + 0;
  return local;
}
const input: Readonly<Network> = new Network();
const output = Stage(input);`,
    });
    const plan = executeElaborationProgram(transformElaborationModule(parsed));
    const execution = elaborateDirectPlan(plan);
    const input = execution.debug.root.network('input');
    const local = execution.debug.root.child('function Stage').network('local');
    const signal = Signal('virtual', 'signal-A');
    const session = execution.createTestSession();

    session.drive(input, [[signal, 7]]).tick();
    expect(session.read(input).get(signal)).toBe(7);
    session.drive(local, [[signal, 11]]).tick();
    expect(session.read(local).get(signal)).toBe(18);

    const foreignExecution = elaborateDirectPlan(plan);
    const foreignInput = foreignExecution.debug.root.network('input');
    expect(() => session.read(foreignInput)).toThrowError(
      expect.objectContaining({ diagnostic: expect.objectContaining({ code: 'RT2001' }) }),
    );
  });

  it('captures a test-only instantiated function without changing its physical topology', () => {
    const functionSource = `function Stage(input: Readonly<Network>): Network {
  const output = new Network();
  output += input + 1;
  return output;
}
const input = new Network();`;
    const ordinary = parseFile({
      path: 'ordinary-stage.factorio.ts',
      text: `${functionSource}
const output = Stage(input);`,
    });
    const captured = parseFile({
      path: 'captured-stage.factorio.ts',
      text: `${functionSource}
const dut = t.instantiate(Stage, input);
const output = dut.value;`,
    });
    const ordinaryExecution = elaborateDirectPlan(
      executeElaborationProgram(transformElaborationModule(ordinary)),
    );
    const capturedExecution = elaborateDirectPlan(
      executeElaborationProgram(transformElaborationModule(captured, { testContextName: 't' })),
    );
    const dut = capturedExecution.instance('dut');

    expect(capturedExecution.instances).toHaveLength(1);
    expect(dut.$.path).toEqual(['DUT dut']);
    expect(dut.$.network('output').id).toBe(capturedExecution.network('output').id);
    expect(dut.value).toBe(capturedExecution.network('output'));
    expect(capturedExecution.circuit.ir.producers).toMatchObject(
      ordinaryExecution.circuit.ir.producers.map(({ kind, config, destinations }) => ({
        kind,
        config,
        destinations,
      })),
    );

    const signal = Signal('virtual', 'signal-A');
    const session = capturedExecution.createTestSession();
    session.drive(dut.value as NetworkHandle, [[signal, 9]]).tick();
    expect(session.read(dut.$.network('output')).get(signal)).toBe(9);
  });

  it('retains Producer return identity and repeated DUT scopes', () => {
    const producerSource = parseFile({
      path: 'captured-producer.factorio.ts',
      text: `function Add(input: Readonly<Network>): ArithmeticCombinator {
  return input + 1;
}
const input = new Network();
const output = new Network();
const dut = t.instantiate(Add, input);
output += dut.value;`,
    });
    const producerExecution = elaborateDirectPlan(
      executeElaborationProgram(
        transformElaborationModule(producerSource, { testContextName: 't' }),
      ),
    );
    const producerDut = producerExecution.instance('dut');

    expect(producerDut.value).toMatchObject({ kind: 'producer' });
    expect((producerDut.value as { id: string }).id).toBe(
      producerExecution.circuit.graph.producers[0]?.id,
    );
    expect(producerDut.$.combinator(1).id).toBe(producerExecution.circuit.graph.producers[0]?.id);

    const repeatedSource = parseFile({
      path: 'captured-repeated.factorio.ts',
      text: `function Stage(): Network {
  return new Network();
}
for (let i = 0; i < 2; i++) {
  const dut = t.instantiate(Stage);
}`,
    });
    const repeatedExecution = elaborateDirectPlan(
      executeElaborationProgram(
        transformElaborationModule(repeatedSource, { testContextName: 't' }),
      ),
    );

    expect(repeatedExecution.instances.map(({ $ }) => $.path)).toEqual([
      ['for i=0', 'DUT dut'],
      ['for i=1', 'DUT dut'],
    ]);
    expect(repeatedExecution.instance(2)).toBe(repeatedExecution.instances[1]);
    expect(() => repeatedExecution.instance('dut')).toThrowError(
      expect.objectContaining({ code: 'DBG1002' }),
    );
  });
});

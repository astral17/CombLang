import { transformElaborationModule } from '@comblang/compiler';
import { parseFile } from '@comblang/language';
import { TraceReader, type TestSession } from '@comblang/simulator';
import { afterEach, describe, expect, test } from 'vitest';

import { executeElaborationProgram } from './elaboration-program.js';
import { runDirectPlanTests } from './test-runner.js';

const latePromiseKey = '__comblangLateTestPromise';
const lateSessionKey = '__comblangLateTestSession';
const globals = globalThis as typeof globalThis & {
  [latePromiseKey]?: Promise<unknown>;
  [lateSessionKey]?: TestSession<unknown>;
};

afterEach(() => {
  delete globals[latePromiseKey];
  delete globals[lateSessionKey];
});

describe('direct plan test runner lifecycle', () => {
  test('reports a failed scheduled boundary with its last committed trace and isolates the next test', () => {
    const parsed = parseFile({
      path: 'failed-boundary.factorio.ts',
      text: 'const input = new Network();',
    });
    const plan = executeElaborationProgram(transformElaborationModule(parsed));
    const result = runDirectPlanTests(
      plan,
      `test('broken callback', ({ network, session }) => {
  const input = network('input');
  session.trace(input);
  session.tick();
  session.at(2, () => {
    session.drive(input, [[Signal('virtual', 'signal-A'), 99]]);
    throw new Error('scheduled failure');
  });
  session.tick(3);
});
test('fresh session', ({ network, session }) => {
  session.tick();
  session.expect(network('input')).toBeEmpty();
});`,
    );
    expect(result).toMatchObject({
      passed: 1,
      failed: 1,
      results: [{ status: 'failed', trace: { endTick: 1 } }, { status: 'passed' }],
    });
    const reader = new TraceReader(result.results[0]!.trace!);
    expect(reader.endTick).toBe(1);
    expect(result.results[0]!.trace!.events).toHaveLength(1);
  });

  test('labels a traced returned Network with its caller binding', () => {
    const parsed = parseFile({
      path: 'trace-alias.factorio.ts',
      text: `function Cell(): Network { const out = new Network(); out += CC(); return out; }
const output = Cell();`,
    });
    const plan = executeElaborationProgram(transformElaborationModule(parsed));
    const result = runDirectPlanTests(
      plan,
      `test('alias', ({ network, session }) => { session.trace(network('output')); });`,
    ).results[0]!;
    const target = result.trace!.targets[0]!;
    if (target.kind !== 'network') throw new Error('Expected Network trace target.');
    expect(result.traceNetworkNames?.[target.networkId]).toBe('output');
  });

  test('retains replayable quiet tails for passing and failing test bodies', () => {
    const parsed = parseFile({
      path: 'trace-horizon.factorio.ts',
      text: 'const input = new Network();',
    });
    const plan = executeElaborationProgram(transformElaborationModule(parsed));
    const result = runDirectPlanTests(
      plan,
      `test('quiet pass', ({ network, session, tick }) => {
  session.trace(network('input'));
  tick(8);
});
test('quiet failure', ({ network, session, tick, expectSignal }) => {
  const input = network('input');
  session.trace(input);
  tick(6);
  expectSignal(input, Signal('virtual', 'signal-A')).toBe(1);
});`,
    );
    expect(result).toMatchObject({
      passed: 1,
      failed: 1,
      results: [
        { status: 'passed', trace: { endTick: 8 } },
        { status: 'failed', failureKind: 'assertion', trace: { endTick: 6 } },
      ],
    });
    for (const entry of result.results) {
      const trace = JSON.parse(JSON.stringify(entry.trace));
      const reader = new TraceReader(trace);
      expect(
        entry.traceNetworkNames?.[
          reader.targets[0]!.kind === 'network' ? reader.targets[0]!.networkId : ''
        ],
      ).toBe('input');
      expect(trace.events).toHaveLength(1);
      expect([...reader.snapshots({ fromTick: reader.endTick })]).toHaveLength(1);
    }
  });

  test('seals a completed session before a delayed microtask can mutate it', async () => {
    const parsed = parseFile({
      path: 'late-test-circuit.factorio.ts',
      text: 'const input = new Network();',
    });
    const plan = executeElaborationProgram(transformElaborationModule(parsed));
    const result = runDirectPlanTests(
      plan,
      `test("late mutation", ({ session }) => {
  globalThis.${lateSessionKey} = session;
  globalThis.${latePromiseKey} = Promise.resolve().then(() => session.tick());
});`,
    );

    expect(result).toMatchObject({ passed: 1, failed: 0 });
    expect(globals[lateSessionKey]?.currentTick).toBe(0);
    await expect(globals[latePromiseKey]).rejects.toThrow(
      'TestSession is finished; tick cannot mutate it.',
    );
    expect(globals[lateSessionKey]?.currentTick).toBe(0);
  });
});

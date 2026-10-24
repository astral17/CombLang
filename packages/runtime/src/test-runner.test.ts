import { transformElaborationModule } from '@comblang/compiler';
import { parseFile } from '@comblang/language';
import { TraceReader, type TestSession } from '@comblang/simulator';
import { afterEach, describe, expect, test } from 'vitest';

import { executeElaborationProgram } from './elaboration-program.js';
import { elaborateDirectPlan } from './direct-plan.js';
import {
  runDirectPlanTests,
  runExecutedDirectPlanTests,
  runResolvedDirectPlanTests,
  runTestsWithExecution,
  runTestsWithExecutionResolver,
} from './test-runner.js';
import { compileSourceProgram } from './source-compilation.js';

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
  test('snapshots optional case parameters before later test-file mutations', () => {
    const parsed = parseFile({
      path: 'case-parameters.factorio.ts',
      text: 'const input = new Network();',
    });
    const plan = executeElaborationProgram(transformElaborationModule(parsed));
    const execution = elaborateDirectPlan(plan);
    const received: unknown[] = [];
    const result = runTestsWithExecution(
      (parameters) => {
        received.push(parameters);
        return execution;
      },
      `const entries = [{ id: 0, value: 4 }];
test('snapshot', () => {}, { parameters: entries });
entries[0].value = 99;
test('omitted', () => {});`,
    );

    expect(result).toMatchObject({ passed: 2, failed: 0 });
    expect(received).toEqual([[{ id: 0, value: 4 }], undefined]);
    expect(Object.isFrozen(received[0])).toBe(true);
    expect(Object.isFrozen((received[0] as Array<unknown>)[0])).toBe(true);
  });

  test('rejects unsupported or malformed generic bindings per case without running the callback', () => {
    const parsed = parseFile({
      path: 'unsupported-case-parameters.factorio.ts',
      text: 'const input = new Network();',
    });
    const plan = executeElaborationProgram(transformElaborationModule(parsed));
    const execution = elaborateDirectPlan(plan);
    const ran: string[] = [];
    const globals = globalThis as typeof globalThis & { __unsupportedCaseRan?: string[] };
    globals.__unsupportedCaseRan = ran;
    try {
      const source = `test('empty', () => {} , { parameters: [] });
test('unsupported', () => globalThis.__unsupportedCaseRan.push('nonempty'), { parameters: [{ id: 0, value: 7 }] });
test('malformed', () => globalThis.__unsupportedCaseRan.push('malformed'), { parameters: {} });
test('continues', () => {});`;
      const sourceCompilation = compileSourceProgram({
        path: 'unsupported-case-parameters.factorio.ts',
        text: 'const input = new Network();',
      });
      const results = [
        runDirectPlanTests(plan, source),
        runExecutedDirectPlanTests(execution, source),
        runResolvedDirectPlanTests(
          sourceCompilation.plan!,
          sourceCompilation.resolvedCircuit!,
          source,
        ),
      ];

      for (const result of results) {
        expect(result).toMatchObject({
          passed: 2,
          failed: 2,
          results: [
            { status: 'passed' },
            { status: 'failed', failureKind: 'runtime', code: 'CP1000' },
            { status: 'failed', failureKind: 'runtime', code: 'CP1000' },
            { status: 'passed' },
          ],
        });
      }
      expect(ran).toEqual([]);
    } finally {
      delete globals.__unsupportedCaseRan;
    }
  });

  test('reports malformed metadata before the body and continues registration order', () => {
    const parsed = parseFile({
      path: 'malformed-case-options.factorio.ts',
      text: 'const input = new Network();',
    });
    const plan = executeElaborationProgram(transformElaborationModule(parsed));
    const execution = elaborateDirectPlan(plan);
    const calls: unknown[] = [];
    const ran: string[] = [];
    const globals = globalThis as typeof globalThis & { __malformedCaseRan?: string[] };
    globals.__malformedCaseRan = ran;
    try {
      const result = runTestsWithExecution(
        (parameters) => {
          calls.push(parameters);
          return execution;
        },
        `const bad = {};
Object.defineProperty(bad, 'id', { enumerable: true, get() { throw new Error('must not run'); } });
test('bad metadata', () => globalThis.__malformedCaseRan.push('bad'), { parameters: [bad] });
test('good metadata', () => {}, { parameters: [] });`,
      );

      expect(result).toMatchObject({
        passed: 1,
        failed: 1,
        results: [
          { name: 'bad metadata', status: 'failed', code: 'CP1000' },
          { name: 'good metadata', status: 'passed' },
        ],
      });
      expect(result.results[0]).not.toHaveProperty('line');
      expect(calls).toEqual([[]]);
      expect(ran).toEqual([]);
    } finally {
      delete globals.__malformedCaseRan;
    }
  });

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

  test('runs async-resolved cases sequentially and preserves synchronous results', async () => {
    const parsed = parseFile({
      path: 'async-resolver.factorio.ts',
      text: 'const input = new Network();',
    });
    const plan = executeElaborationProgram(transformElaborationModule(parsed));
    const execution = elaborateDirectPlan(plan);
    const source = `test('first', ({ tick }) => { tick(); });
test('second', ({ tick }) => { tick(2); });`;

    const sync = runTestsWithExecution(() => execution, source);
    const calls: unknown[] = [];
    let activeResolvers = 0;
    let maxActiveResolvers = 0;
    const asyncRun = await runTestsWithExecutionResolver(async (parameters) => {
      activeResolvers += 1;
      maxActiveResolvers = Math.max(maxActiveResolvers, activeResolvers);
      calls.push(parameters);
      await Promise.resolve();
      activeResolvers -= 1;
      return execution;
    }, source);

    expect(asyncRun).toEqual(sync);
    expect(calls).toEqual([undefined, undefined]);
    expect(maxActiveResolvers).toBe(1);
  });

  test('snapshots async resolver metadata, skips invalid cases, and continues after rejection', async () => {
    const parsed = parseFile({
      path: 'async-case-parameters.factorio.ts',
      text: 'const input = new Network();',
    });
    const plan = executeElaborationProgram(transformElaborationModule(parsed));
    const execution = elaborateDirectPlan(plan);
    const calls: unknown[] = [];
    const source = `const entries = [{ id: 0, value: 4 }];
const bad = {};
Object.defineProperty(bad, 'id', { enumerable: true, get() { throw new Error('must not run'); } });
test('snapshot', () => {}, { parameters: entries });
entries[0].value = 99;
test('bad metadata', () => {}, { parameters: [bad] });
test('omitted', () => {});
test('empty', () => {}, { parameters: [] });
test('reject', () => {}, { parameters: [{ id: 1, value: 2 }] });
test('continues', () => {});`;
    const result = await runTestsWithExecutionResolver(async (parameters) => {
      calls.push(parameters);
      if (Array.isArray(parameters) && parameters[0]?.value === 2) {
        throw new Error('case binding failed');
      }
      return execution;
    }, source);

    expect(calls).toEqual([[{ id: 0, value: 4 }], undefined, [], [{ id: 1, value: 2 }], undefined]);
    expect(Object.isFrozen(calls[0])).toBe(true);
    expect(result).toMatchObject({
      passed: 4,
      failed: 2,
      results: [
        { name: 'snapshot', status: 'passed' },
        { name: 'bad metadata', status: 'failed', code: 'CP1000' },
        { name: 'omitted', status: 'passed' },
        { name: 'empty', status: 'passed' },
        { name: 'reject', status: 'failed', message: 'case binding failed' },
        { name: 'continues', status: 'passed' },
      ],
    });
  });

  test('async resolver reports source syntax errors without resolving and keeps bodies synchronous', async () => {
    const parsed = parseFile({
      path: 'async-error.factorio.ts',
      text: 'const input = new Network();',
    });
    const plan = executeElaborationProgram(transformElaborationModule(parsed));
    const execution = elaborateDirectPlan(plan);
    let calls = 0;
    const syntaxError = await runTestsWithExecutionResolver(async () => {
      calls += 1;
      return execution;
    }, `test('broken', () => {`);
    const asyncBody = await runTestsWithExecutionResolver(async () => {
      calls += 1;
      return execution;
    }, `test('async body', async () => {});`);

    expect(syntaxError).toMatchObject({ failed: 1, results: [{ name: 'Test file' }] });
    expect(asyncBody).toMatchObject({
      failed: 1,
      results: [
        { name: 'async body', status: 'failed', message: 'Async tests are not supported yet.' },
      ],
    });
    expect(calls).toBe(1);
  });
});

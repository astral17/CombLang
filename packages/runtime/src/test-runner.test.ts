import { transformElaborationModule } from '@comblang/compiler';
import { parseFile } from '@comblang/language';
import type { TestSession } from '@comblang/simulator';
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

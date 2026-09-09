import { describe, expect, test } from 'vitest';

import {
  CompilerWorkerScheduler,
  compilerWorkerBootstrapTimeoutReason,
} from './compiler-worker-scheduler.js';
import {
  compilerWorkerRequestTimeoutReason,
  compilerWorkerRequestTimeoutMs,
} from './compiler-worker-budget.js';
import type { CompilerWorkerRequest } from './worker-protocol.js';

function request(
  revision: number,
  prototypeProfile?: CompilerWorkerRequest['prototypeProfile'],
): CompilerWorkerRequest {
  return {
    kind: 'parse',
    revision,
    file: { path: 'main.factorio.ts', text: `const revision = ${revision};` },
    ...(prototypeProfile === undefined ? {} : { prototypeProfile }),
  };
}

describe('compiler Worker readiness scheduler', () => {
  test('sends no parse while booting and collapses boot-time revisions to the newest', () => {
    const scheduler = new CompilerWorkerScheduler();
    const workerId = scheduler.createWorker();

    scheduler.enqueue(request(1));
    scheduler.enqueue(request(2));
    expect(scheduler.phase).toBe('booting');
    expect(scheduler.takeForDispatch()).toBeUndefined();

    expect(scheduler.markReady(workerId)).toBe(true);
    expect(scheduler.takeForDispatch()?.request.revision).toBe(2);
    expect(scheduler.takeForDispatch()).toBeUndefined();
  });

  test('dispatches once after ready and returns to ready after the response', () => {
    const scheduler = new CompilerWorkerScheduler();
    const workerId = scheduler.createWorker();
    const queued = request(3);
    scheduler.enqueue(queued);
    scheduler.markReady(workerId);

    expect(scheduler.takeForDispatch()).toMatchObject({ request: queued, isCold: true });
    expect(scheduler.phase).toBe('busy');
    expect(scheduler.complete(workerId, 3)).toBe(true);
    expect(scheduler.phase).toBe('ready');
    expect(scheduler.activeRevision).toBeUndefined();
    scheduler.enqueue(request(4));
    expect(scheduler.takeForDispatch()).toMatchObject({
      request: { revision: 4 },
      isCold: false,
    });
  });

  test('does not become warm after a stale completion', () => {
    const scheduler = new CompilerWorkerScheduler();
    const workerId = scheduler.createWorker();
    scheduler.enqueue(request(5));
    scheduler.markReady(workerId);
    expect(scheduler.takeForDispatch()?.isCold).toBe(true);

    expect(scheduler.complete(workerId, 99)).toBe(false);
    expect(scheduler.phase).toBe('busy');
    expect(scheduler.complete(workerId, 5)).toBe(true);
    scheduler.enqueue(request(6));
    expect(scheduler.takeForDispatch()?.isCold).toBe(false);
  });

  test('ignores stale ready messages and waits for a replacement Worker readiness', () => {
    const scheduler = new CompilerWorkerScheduler();
    const staleWorkerId = scheduler.createWorker();
    expect(scheduler.fail(staleWorkerId)).toBe(true);
    const replacementWorkerId = scheduler.createWorker();
    scheduler.enqueue(request(4));

    expect(scheduler.markReady(staleWorkerId)).toBe(false);
    expect(scheduler.takeForDispatch()).toBeUndefined();
    expect(scheduler.markReady(replacementWorkerId)).toBe(true);
    expect(scheduler.takeForDispatch()?.request.revision).toBe(4);
    expect(scheduler.takeForDispatch()).toBeUndefined();
  });

  test('resets the cold classification after a failed generation', () => {
    const scheduler = new CompilerWorkerScheduler();
    const firstWorkerId = scheduler.createWorker();
    scheduler.enqueue(request(7));
    scheduler.markReady(firstWorkerId);
    expect(scheduler.takeForDispatch()?.isCold).toBe(true);
    expect(scheduler.fail(firstWorkerId)).toBe(true);

    const replacementWorkerId = scheduler.createWorker();
    scheduler.enqueue(request(8));
    scheduler.markReady(replacementWorkerId);
    expect(scheduler.takeForDispatch()?.isCold).toBe(true);
  });

  test('keeps bootstrap and request timeout reasons distinct', () => {
    const ordinary = request(5);
    const bootstrapReason = compilerWorkerBootstrapTimeoutReason();
    const requestReason = compilerWorkerRequestTimeoutReason(
      ordinary,
      compilerWorkerRequestTimeoutMs(ordinary, false),
    );

    expect(bootstrapReason).toContain('readiness');
    expect(bootstrapReason).not.toContain('EX1002');
    expect(requestReason).toBe('Compilation exceeded the 1000 ms worker budget.');
    expect(compilerWorkerRequestTimeoutReason(ordinary, 1000, 'execute')).toBe(
      'Compilation exceeded the 1000 ms worker budget. (last reported phase: execute)',
    );
    expect(requestReason).not.toBe(bootstrapReason);
  });
});

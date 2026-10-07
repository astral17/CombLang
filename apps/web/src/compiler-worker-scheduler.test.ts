import { describe, expect, test } from 'vitest';

import {
  CompilerWorkerScheduler,
  compilerWorkerBootstrapTimeoutReason,
} from './compiler-worker-scheduler.js';
import {
  compilerWorkerRequestTimeoutReason,
  compilerWorkerRequestTimeoutMs,
} from './compiler-worker-budget.js';
import type {
  CompilerWorkerBindRequest,
  CompilerWorkerBoundResponse,
  CompilerWorkerParsedResponse,
  CompilerWorkerRequest,
} from './worker-protocol.js';

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

function parsed(
  revision: number,
  parameterBinding?: CompilerWorkerParsedResponse['parameterBinding'],
): CompilerWorkerParsedResponse {
  return {
    kind: 'parsed',
    revision,
    result: {} as CompilerWorkerParsedResponse['result'],
    ...(parameterBinding === undefined ? {} : { parameterBinding }),
  };
}

function bindingRequest(
  revision: number,
  sourceRevision: number,
  token: string,
): CompilerWorkerBindRequest {
  return { kind: 'bind-parameters', revision, sourceRevision, token };
}

function bound(
  revision: number,
  sourceRevision: number,
  code?: string,
): CompilerWorkerBoundResponse {
  return {
    kind: 'bound',
    revision,
    sourceRevision,
    result:
      code === undefined
        ? ({ ok: true } as CompilerWorkerBoundResponse['result'])
        : { ok: false, diagnostics: [{ code, severity: 'error', message: code }] },
  };
}

function readyWithCapture(revision = 1, token = 'token-1') {
  const scheduler = new CompilerWorkerScheduler();
  const workerId = scheduler.createWorker();
  scheduler.enqueue(request(revision));
  expect(scheduler.markReady(workerId)).toBe(true);
  expect(scheduler.takeForDispatch()?.request.revision).toBe(revision);
  expect(scheduler.complete(workerId, parsed(revision, { ok: true, parameters: [], token }))).toBe(
    'accepted',
  );
  return { scheduler, workerId, sourceRevision: revision, token };
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
    expect(scheduler.complete(workerId, parsed(3))).toBe('accepted');
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

    expect(scheduler.complete(workerId, parsed(99))).toBe('ignored');
    expect(scheduler.phase).toBe('busy');
    expect(scheduler.complete(workerId, parsed(5))).toBe('accepted');
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

  test('captures only a successful token listing and freezes generation routing metadata', () => {
    const { scheduler, workerId, sourceRevision, token } = readyWithCapture(12, 'capture-12');
    const capture = scheduler.bindingCapture;
    expect(capture).toEqual({ workerId, sourceRevision, token });
    expect(Object.isFrozen(capture)).toBe(true);

    const cases: Array<CompilerWorkerParsedResponse['parameterBinding'] | undefined> = [
      undefined,
      { ok: false, diagnostics: [] },
      { ok: true, parameters: [] },
    ];
    for (const [index, parameterBinding] of cases.entries()) {
      const current = new CompilerWorkerScheduler();
      const currentWorker = current.createWorker();
      current.enqueue(request(20 + index));
      current.markReady(currentWorker);
      current.takeForDispatch();
      expect(current.complete(currentWorker, parsed(20 + index, parameterBinding))).toBe(
        'accepted',
      );
      expect(current.bindingCapture).toBeUndefined();
    }
  });

  test('wrong response kind with the active correlation ID leaves the active parse untouched', () => {
    const scheduler = new CompilerWorkerScheduler();
    const workerId = scheduler.createWorker();
    scheduler.enqueue(request(30));
    scheduler.markReady(workerId);
    scheduler.takeForDispatch();

    expect(scheduler.complete(workerId, bound(30, 30))).toBe('ignored');
    expect(scheduler.phase).toBe('busy');
    expect(scheduler.activeRequest).toMatchObject({ kind: 'parse', revision: 30 });
    expect(scheduler.bindingCapture).toBeUndefined();
    expect(scheduler.complete(workerId, parsed(30))).toBe('accepted');
  });

  test('rejects binding completions from the wrong source revision or Worker generation', () => {
    const { scheduler, workerId, sourceRevision, token } = readyWithCapture(40, 'capture-40');
    expect(scheduler.enqueueBinding(bindingRequest(41, sourceRevision, token))).toBe(true);
    scheduler.takeForDispatch();

    expect(scheduler.complete(workerId, bound(41, sourceRevision + 1))).toBe('ignored');
    expect(scheduler.complete(workerId + 1, bound(41, sourceRevision))).toBe('ignored');
    expect(scheduler.phase).toBe('busy');
    expect(scheduler.activeRequest).toMatchObject({ kind: 'bind-parameters', revision: 41 });
    expect(scheduler.bindingCapture).toEqual({ workerId, sourceRevision, token });
    expect(scheduler.complete(workerId, bound(41, sourceRevision))).toBe('accepted');
    expect(scheduler.bindingCapture).toEqual({ workerId, sourceRevision, token });
  });

  test('coalesces queued bindings to the latest request for the current capture', () => {
    const { scheduler, sourceRevision, token } = readyWithCapture(50, 'capture-50');
    expect(scheduler.enqueueBinding(bindingRequest(51, sourceRevision, token))).toBe(true);
    expect(scheduler.enqueueBinding(bindingRequest(52, sourceRevision, token))).toBe(true);
    expect(scheduler.takeForDispatch()?.request).toEqual(bindingRequest(52, sourceRevision, token));
  });

  test('rejects binds without a ready capture, during parse, or behind a queued parse', () => {
    const absent = new CompilerWorkerScheduler();
    expect(absent.enqueueBinding(bindingRequest(60, 59, 'missing'))).toBe(false);
    expect(absent.hasQueuedRequest).toBe(false);

    const booting = new CompilerWorkerScheduler();
    booting.createWorker();
    expect(booting.enqueueBinding(bindingRequest(600, 599, 'missing'))).toBe(false);
    expect(booting.phase).toBe('booting');
    expect(booting.hasQueuedRequest).toBe(false);

    const { scheduler, workerId, sourceRevision, token } = readyWithCapture(61, 'capture-61');
    expect(scheduler.enqueueBinding(bindingRequest(610, sourceRevision, 'wrong-token'))).toBe(
      false,
    );
    expect(scheduler.enqueueBinding(bindingRequest(611, sourceRevision + 1, token))).toBe(false);
    expect(scheduler.hasQueuedRequest).toBe(false);
    scheduler.enqueue(request(62));
    expect(scheduler.bindingCapture).toBeUndefined();
    expect(scheduler.enqueueBinding(bindingRequest(63, sourceRevision, token))).toBe(false);
    expect(scheduler.takeForDispatch()?.request).toMatchObject({ kind: 'parse', revision: 62 });
    expect(scheduler.enqueueBinding(bindingRequest(64, sourceRevision, token))).toBe(false);
    expect(scheduler.activeRequest).toMatchObject({ kind: 'parse', revision: 62 });
    expect(scheduler.phase).toBe('busy');
    expect(scheduler.isCurrent(workerId)).toBe(true);
  });

  test('a parse completion with a newer parse queued releases but cannot install its token', () => {
    const scheduler = new CompilerWorkerScheduler();
    const workerId = scheduler.createWorker();
    scheduler.enqueue(request(65));
    scheduler.markReady(workerId);
    scheduler.takeForDispatch();
    scheduler.enqueue(request(66));

    expect(
      scheduler.complete(workerId, parsed(65, { ok: true, parameters: [], token: 'old-token' })),
    ).toBe('stale');
    expect(scheduler.phase).toBe('ready');
    expect(scheduler.activeRequest).toBeUndefined();
    expect(scheduler.bindingCapture).toBeUndefined();
    expect(scheduler.takeForDispatch()?.request).toMatchObject({ kind: 'parse', revision: 66 });
  });

  test('a new parse clears capture immediately and makes an active bind completion stale', () => {
    const { scheduler, workerId, sourceRevision, token } = readyWithCapture(70, 'capture-70');
    scheduler.enqueueBinding(bindingRequest(71, sourceRevision, token));
    scheduler.takeForDispatch();
    scheduler.enqueue(request(72));
    expect(scheduler.bindingCapture).toBeUndefined();

    expect(scheduler.complete(workerId, bound(71, sourceRevision))).toBe('stale');
    expect(scheduler.phase).toBe('ready');
    expect(scheduler.bindingCapture).toBeUndefined();
    expect(scheduler.takeForDispatch()?.request).toMatchObject({ kind: 'parse', revision: 72 });
  });

  test('a queued newer bind makes the active binding completion stale', () => {
    const { scheduler, workerId, sourceRevision, token } = readyWithCapture(80, 'capture-80');
    scheduler.enqueueBinding(bindingRequest(81, sourceRevision, token));
    scheduler.takeForDispatch();
    scheduler.enqueueBinding(bindingRequest(82, sourceRevision, token));

    expect(scheduler.complete(workerId, bound(81, sourceRevision))).toBe('stale');
    expect(scheduler.bindingCapture).toEqual({ workerId, sourceRevision, token });
    expect(scheduler.takeForDispatch()?.request).toEqual(bindingRequest(82, sourceRevision, token));
  });

  test('generation failure drops queued binds, preserves queued parses, and resets replacement state', () => {
    const { scheduler, workerId, sourceRevision, token } = readyWithCapture(90, 'capture-90');
    scheduler.enqueueBinding(bindingRequest(91, sourceRevision, token));
    scheduler.takeForDispatch();
    scheduler.enqueueBinding(bindingRequest(92, sourceRevision, token));
    expect(scheduler.fail(workerId)).toBe(true);
    expect(scheduler.bindingCapture).toBeUndefined();
    expect(scheduler.hasQueuedRequest).toBe(false);

    const replacement = scheduler.createWorker();
    expect(scheduler.markReady(replacement)).toBe(true);
    expect(scheduler.takeForDispatch()).toBeUndefined();

    scheduler.enqueue(request(93));
    scheduler.takeForDispatch();
    scheduler.enqueue(request(94));
    expect(scheduler.fail(replacement)).toBe(true);
    const nextWorker = scheduler.createWorker();
    expect(scheduler.takeForDispatch()).toBeUndefined();
    expect(scheduler.markReady(nextWorker)).toBe(true);
    expect(scheduler.takeForDispatch()).toMatchObject({
      request: { kind: 'parse', revision: 94 },
      isCold: true,
    });
    expect(scheduler.bindingCapture).toBeUndefined();
  });

  test('keeps the capture after ordinary bind failures so a corrected retry can run', () => {
    const { scheduler, workerId, sourceRevision, token } = readyWithCapture(100, 'capture-100');
    scheduler.enqueueBinding(bindingRequest(101, sourceRevision, token));
    scheduler.takeForDispatch();
    expect(scheduler.complete(workerId, bound(101, sourceRevision, 'CP1001'))).toBe('accepted');
    expect(scheduler.bindingCapture).toEqual({ workerId, sourceRevision, token });
    expect(scheduler.enqueueBinding(bindingRequest(102, sourceRevision, token))).toBe(true);
    expect(scheduler.takeForDispatch()?.request).toEqual(
      bindingRequest(102, sourceRevision, token),
    );
  });

  test('WP1007 expires capture and cancels its queued retry but remains reportable', () => {
    const { scheduler, workerId, sourceRevision, token } = readyWithCapture(110, 'capture-110');
    scheduler.enqueueBinding(bindingRequest(111, sourceRevision, token));
    scheduler.takeForDispatch();
    scheduler.enqueueBinding(bindingRequest(112, sourceRevision, token));

    expect(scheduler.complete(workerId, bound(111, sourceRevision, 'WP1007'))).toBe('accepted');
    expect(scheduler.bindingCapture).toBeUndefined();
    expect(scheduler.hasQueuedRequest).toBe(false);
  });

  test('WP1007 is stale when a newer parse is queued, and a queued parse completion installs only its own token', () => {
    const { scheduler, workerId, sourceRevision, token } = readyWithCapture(120, 'capture-120');
    scheduler.enqueueBinding(bindingRequest(121, sourceRevision, token));
    scheduler.takeForDispatch();
    scheduler.enqueue(request(122));

    expect(scheduler.complete(workerId, bound(121, sourceRevision, 'WP1007'))).toBe('stale');
    expect(scheduler.bindingCapture).toBeUndefined();
    expect(scheduler.takeForDispatch()?.request).toMatchObject({ kind: 'parse', revision: 122 });
    expect(
      scheduler.complete(workerId, parsed(122, { ok: true, parameters: [], token: 'new-token' })),
    ).toBe('accepted');
    expect(scheduler.bindingCapture).toEqual({
      workerId,
      sourceRevision: 122,
      token: 'new-token',
    });
  });
});

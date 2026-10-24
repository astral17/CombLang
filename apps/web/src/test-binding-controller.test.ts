import { describe, expect, it } from 'vitest';
import type { CompilerWorkerBoundResponse } from './worker-protocol.js';
import { CompilerWorkerScheduler } from './compiler-worker-scheduler.js';
import {
  shouldTerminateTestRunForInvalidation,
  TestBindingController,
  type TestBindingRunInvalidation,
  type TestBindingRunSnapshot,
} from './test-binding-controller.js';
import type { TestWorkerBindRequest } from './test-worker-protocol.js';

const snapshot: TestBindingRunSnapshot = {
  revision: 7,
  sourceRevision: 31,
  workerId: 4,
  profileSelectionRevision: 2,
  profileIdentity: 'profile:stable',
  token: 'capture-secret',
};

function request(overrides: Partial<TestWorkerBindRequest> = {}): TestWorkerBindRequest {
  return {
    kind: 'test-bind-request',
    revision: snapshot.revision,
    sourceRevision: snapshot.sourceRevision,
    requestId: 1,
    hasParameters: false,
    ...overrides,
  };
}

function boundResponse(
  revision: number,
  result: CompilerWorkerBoundResponse['result'],
): CompilerWorkerBoundResponse {
  return {
    kind: 'bound',
    revision,
    sourceRevision: snapshot.sourceRevision,
    result,
  } as CompilerWorkerBoundResponse;
}

describe('test binding controller', () => {
  it('terminates the current run when a binding failure invalidates its scheduler capture', () => {
    const scheduler = new CompilerWorkerScheduler();
    const workerId = scheduler.createWorker();
    scheduler.enqueue({
      kind: 'parse',
      revision: snapshot.sourceRevision,
      file: { path: 'main.factorio.ts', text: '' },
    });
    scheduler.markReady(workerId);
    scheduler.takeForDispatch();
    scheduler.complete(workerId, {
      kind: 'parsed',
      revision: snapshot.sourceRevision,
      result: {} as never,
      parameterBinding: { ok: true, parameters: [], token: snapshot.token },
    });
    const controller = new TestBindingController();
    controller.begin({ ...snapshot, workerId });
    expect(controller.requestCase(request())).toBe(true);
    const binding = controller.takeForDispatch(105)!;
    expect(scheduler.enqueueBinding(binding)).toBe(true);
    expect(scheduler.takeForDispatch()?.request).toEqual(binding);
    const failure = boundResponse(105, {
      ok: false,
      diagnostics: [
        { code: 'WP1007', severity: 'error', message: 'The source capture has expired.' },
      ],
    });
    expect(scheduler.complete(workerId, failure)).toBe('accepted');
    expect(scheduler.bindingCapture).toBeUndefined();

    const completion = controller.complete(
      workerId,
      failure,
      () => scheduler.bindingCapture !== undefined,
    );
    expect(completion).toMatchObject({
      kind: 'test-run-invalidated',
      revision: snapshot.revision,
      sourceRevision: snapshot.sourceRevision,
      message: 'WP1007: The source capture has expired.',
    });
    expect(
      shouldTerminateTestRunForInvalidation(
        completion as TestBindingRunInvalidation,
        snapshot.revision,
        snapshot.sourceRevision,
        true,
      ),
    ).toBe(true);
    expect(controller.snapshot).toBeUndefined();
    expect(controller.hasPendingCase).toBe(false);
  });

  it('keeps one case, preserving omitted versus empty overrides and page-only authority', () => {
    const controller = new TestBindingController();
    controller.begin(snapshot);

    expect(controller.requestCase(request())).toBe(true);
    expect(controller.requestCase(request({ requestId: 2 }))).toBe(false);
    const omitted = controller.takeForDispatch(100);
    expect(omitted).toEqual({
      kind: 'bind-parameters',
      revision: 100,
      sourceRevision: 31,
      token: 'capture-secret',
    });
    expect(request()).not.toHaveProperty('token');
    expect(controller.ownsCompilerRevision(100)).toBe(true);

    expect(
      controller.complete(
        4,
        boundResponse(100, { ok: true, plan: {} as never, resolvedCircuit: {} as never }),
        () => true,
      ),
    ).toMatchObject({ kind: 'test-bind-response', requestId: 1, result: { ok: true } });
    expect(controller.requestCase(request({ requestId: 1 }))).toBe(false);
    expect(
      controller.requestCase(request({ requestId: 3, hasParameters: true, parameters: [] })),
    ).toBe(true);
    expect(controller.takeForDispatch(101)).toEqual({
      kind: 'bind-parameters',
      revision: 101,
      sourceRevision: 31,
      token: 'capture-secret',
      overrides: [],
    });
  });

  it('rejects malformed transport, mismatched generations and late/cancelled results', () => {
    const controller = new TestBindingController();
    controller.begin(snapshot);
    expect(controller.requestCase(request({ sourceRevision: 32 }))).toBe(false);
    expect(controller.requestCase(request({ hasParameters: true }))).toBe(false);
    expect(controller.requestCase(request({ parameters: [] }))).toBe(false);
    expect(controller.requestCase(request())).toBe(true);
    controller.takeForDispatch(102);

    expect(
      controller.complete(
        5,
        boundResponse(102, { ok: true, plan: {} as never, resolvedCircuit: {} as never }),
        () => true,
      ),
    ).toBeUndefined();
    controller.cancel();
    expect(controller.ownsCompilerRevision(102)).toBe(true);
    expect(
      controller.complete(
        4,
        boundResponse(102, { ok: true, plan: {} as never, resolvedCircuit: {} as never }),
        () => true,
      ),
    ).toBeUndefined();
  });

  it('returns cloneable diagnostics with code, parameter path and source span', () => {
    const controller = new TestBindingController();
    controller.begin(snapshot);
    controller.requestCase(request());
    controller.takeForDispatch(103);
    const response = controller.complete(
      4,
      boundResponse(103, {
        ok: false,
        diagnostics: [
          {
            code: 'CP1002',
            severity: 'error',
            message: '$.selectorTemplates[0].index: value has no valid binding.',
            span: { fileId: 'main.factorio.ts' as never, start: 18, end: 29 },
          },
        ],
      }),
      () => true,
    );

    expect(response).toMatchObject({
      kind: 'test-bind-response',
      result: {
        ok: false,
        error: {
          code: 'CP1002',
          path: '$.selectorTemplates[0].index',
          span: { start: 18, end: 29 },
        },
      },
    });
    expect(structuredClone(response)).toEqual(response);
  });

  it('does not deliver a result after profile or source snapshot invalidation', () => {
    const controller = new TestBindingController();
    controller.begin(snapshot);
    controller.requestCase(request());
    controller.takeForDispatch(104);
    const invalidation = controller.complete(
      4,
      boundResponse(104, { ok: true, plan: {} as never, resolvedCircuit: {} as never }),
      (active) => active.profileSelectionRevision === 3,
    );
    expect(invalidation).toMatchObject({
      kind: 'test-run-invalidated',
      revision: snapshot.revision,
      sourceRevision: snapshot.sourceRevision,
    });
    expect(controller.snapshot).toBeUndefined();
  });

  it('ignores an old invalidation when a newer test run owns the Worker', () => {
    const oldRun: TestBindingRunInvalidation = {
      kind: 'test-run-invalidated',
      revision: snapshot.revision,
      sourceRevision: snapshot.sourceRevision,
      message: 'WP1007: expired capture',
    };
    expect(shouldTerminateTestRunForInvalidation(oldRun, 8, 31, true)).toBe(false);
    expect(shouldTerminateTestRunForInvalidation(oldRun, 7, 32, true)).toBe(false);
    expect(shouldTerminateTestRunForInvalidation(oldRun, 7, 31, false)).toBe(false);

    const controller = new TestBindingController();
    controller.begin(snapshot);
    controller.requestCase(request());
    controller.takeForDispatch(105);
    controller.begin({ ...snapshot, revision: 8 });
    expect(controller.requestCase(request({ revision: 8 }))).toBe(true);
    const newerBinding = controller.takeForDispatch(106)!;

    expect(
      controller.complete(
        4,
        boundResponse(105, { ok: true, plan: {} as never, resolvedCircuit: {} as never }),
        () => false,
      ),
    ).toBeUndefined();
    expect(controller.snapshot?.revision).toBe(8);
    expect(
      controller.complete(
        4,
        boundResponse(106, {
          ok: true,
          plan: {} as never,
          resolvedCircuit: {} as never,
        }),
        () => true,
      ),
    ).toMatchObject({ kind: 'test-bind-response', revision: 8 });
    expect(newerBinding.revision).toBe(106);
  });

  it('waits behind one active import and dispatches a single case after the scheduler is idle', () => {
    const scheduler = new CompilerWorkerScheduler();
    const workerId = scheduler.createWorker();
    scheduler.enqueue({
      kind: 'parse',
      revision: snapshot.sourceRevision,
      file: { path: 'main.factorio.ts', text: '' },
    });
    expect(scheduler.markReady(workerId)).toBe(true);
    scheduler.takeForDispatch();
    expect(
      scheduler.complete(workerId, {
        kind: 'parsed',
        revision: snapshot.sourceRevision,
        result: {} as never,
        parameterBinding: { ok: true, parameters: [], token: snapshot.token },
      }),
    ).toBe('accepted');
    scheduler.enqueueImport({
      kind: 'import-blueprint',
      revision: 32,
      document: { text: '{}' },
      sourcePath: 'main.factorio.ts',
    });
    scheduler.takeForDispatch();

    const controller = new TestBindingController();
    controller.begin(snapshot);
    expect(controller.requestCase(request())).toBe(true);
    expect(scheduler.phase).toBe('busy');
    expect(controller.hasPendingCase).toBe(true);

    expect(
      scheduler.complete(workerId, {
        kind: 'blueprint-imported',
        revision: 32,
        result: { state: 'blocked', diagnostics: [] },
      } as never),
    ).toBe('accepted');
    const bind = controller.takeForDispatch(33);
    expect(bind).toBeDefined();
    expect(scheduler.enqueueBinding(bind!)).toBe(true);
    expect(scheduler.takeForDispatch()?.request).toEqual(bind);
    expect(scheduler.hasQueuedRequest).toBe(false);
  });
});

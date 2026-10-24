import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DirectElaborationPlan } from '@comblang/compiler/direct-plan-schema';
import type { ResolvedCircuit } from '@comblang/compiler/resolved-circuit';

import { compileSource } from './compile-source.js';
import type {
  TestWorkerBindRequest,
  TestWorkerBindResponse,
  TestWorkerInboundMessage,
  TestWorkerResponse,
  TestWorkerSourceRequest,
} from './test-worker-protocol.js';

type WorkerMessageListener = (event: MessageEvent<TestWorkerInboundMessage>) => void;

function compilePair(
  path: string,
  source: string,
): {
  readonly plan: DirectElaborationPlan;
  readonly resolvedCircuit: ResolvedCircuit;
} {
  const compiled = compileSource({ path, text: source });
  if (compiled.plan === undefined || compiled.resolvedCircuit === undefined) {
    throw new Error('Expected a compiler plan and its matching resolved circuit.');
  }
  return { plan: compiled.plan, resolvedCircuit: compiled.resolvedCircuit };
}

async function installWorker() {
  vi.resetModules();
  let messageListener: WorkerMessageListener | undefined;
  const postMessage = vi.fn();
  const addEventListener = vi.fn((type: string, listener: EventListener) => {
    if (type === 'message') messageListener = listener as unknown as WorkerMessageListener;
  });
  vi.stubGlobal('self', { addEventListener, postMessage } as unknown as DedicatedWorkerGlobalScope);
  await import('./test.worker.js');
  if (messageListener === undefined)
    throw new Error('Test Worker message listener was not installed.');
  return { messageListener, postMessage };
}

function messages(postMessage: ReturnType<typeof vi.fn>): TestWorkerResponse[] {
  return postMessage.mock.calls.map(([message]) => message as TestWorkerResponse);
}

function respond(
  messageListener: WorkerMessageListener,
  request: TestWorkerBindRequest,
  result: TestWorkerBindResponse['result'],
): void {
  messageListener({
    data: {
      kind: 'test-bind-response',
      revision: request.revision,
      sourceRevision: request.sourceRevision,
      requestId: request.requestId,
      result,
    },
  } as MessageEvent<TestWorkerInboundMessage>);
}

function bindingRequests(postMessage: ReturnType<typeof vi.fn>): TestWorkerBindRequest[] {
  return messages(postMessage).filter(
    (message): message is TestWorkerBindRequest => message.kind === 'test-bind-request',
  );
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe('test Worker entry routing', () => {
  it('runs an ordinary concrete pair and posts one terminal result', async () => {
    const worker = await installWorker();
    const pair = compilePair('test-worker-concrete.factorio.ts', 'const output = new Network();');

    worker.messageListener({
      data: {
        kind: 'test',
        revision: 1,
        ...pair,
        source: "test('ordinary concrete test', () => {});",
      },
    } as MessageEvent<TestWorkerInboundMessage>);

    expect(messages(worker.postMessage)).toMatchObject([
      { kind: 'test-phase', revision: 1, phase: 'executing' },
      {
        kind: 'tested',
        revision: 1,
        run: {
          passed: 1,
          failed: 0,
          results: [{ name: 'ordinary concrete test', status: 'passed' }],
        },
      },
    ]);
  });

  it('coordinates cloneable replies, skipping bad metadata and continuing after a binding failure', async () => {
    const worker = await installWorker();
    const pair = compilePair('test-worker-bound.factorio.ts', 'const output = new Network();');
    const registrationKey = '__test_worker_registration_count';
    const bodyKey = '__test_worker_body_count';
    const globals = globalThis as Record<string, unknown>;
    const oldRegistrationCount = globals[registrationKey];
    const oldBodyCount = globals[bodyKey];
    globals[registrationKey] = 0;
    globals[bodyKey] = 0;
    try {
      const request: TestWorkerSourceRequest = {
        kind: 'test-source',
        revision: 3,
        sourceRevision: 41,
        source: `globalThis.${registrationKey} = Number(globalThis.${registrationKey}) + 1;
test('invalid metadata never binds or runs', () => { globalThis.${bodyKey} = 100; }, { unexpected: true });
test('binding failure is a case result', () => { globalThis.${bodyKey} = 100; }, { parameters: [] });
test('first valid case', () => { globalThis.${bodyKey} = Number(globalThis.${bodyKey}) + 1; });
test('second valid case', () => { globalThis.${bodyKey} = Number(globalThis.${bodyKey}) + 1; });`,
      };
      worker.messageListener({ data: request } as MessageEvent<TestWorkerInboundMessage>);

      const initial = messages(worker.postMessage);
      expect(initial).toMatchObject([
        { kind: 'test-phase', revision: 3, phase: 'executing' },
        { kind: 'test-phase', revision: 3, phase: 'waiting-for-binding' },
        {
          kind: 'test-bind-request',
          revision: 3,
          sourceRevision: 41,
          requestId: 1,
          hasParameters: true,
          parameters: [],
        },
      ]);
      expect(initial[2]).not.toHaveProperty('token');
      expect(globals[registrationKey]).toBe(1);
      const first = bindingRequests(worker.postMessage)[0]!;

      respond(worker.messageListener, { ...first, revision: 2 }, { ok: true, ...pair });
      respond(worker.messageListener, { ...first, sourceRevision: 40 }, { ok: true, ...pair });
      respond(worker.messageListener, { ...first, requestId: 99 }, { ok: true, ...pair });
      expect(bindingRequests(worker.postMessage)).toHaveLength(1);
      expect(messages(worker.postMessage).some(({ kind }) => kind === 'tested')).toBe(false);

      respond(worker.messageListener, first, {
        ok: false,
        error: {
          message: '$.parameters[0].value: Signal parameter is required.',
          code: 'CP1002',
          path: '$.parameters[0].value',
          span: { fileId: 'main.factorio.ts' as never, start: 8, end: 20 },
        },
      });
      await vi.waitFor(() => expect(bindingRequests(worker.postMessage)).toHaveLength(2));
      const second = bindingRequests(worker.postMessage)[1]!;
      expect(second).toMatchObject({ requestId: 2, hasParameters: false });
      expect(globals[bodyKey]).toBe(0);

      respond(worker.messageListener, first, { ok: true, ...pair });
      respond(worker.messageListener, { ...second, requestId: 1 }, { ok: true, ...pair });
      expect(messages(worker.postMessage).some(({ kind }) => kind === 'tested')).toBe(false);
      expect(globals[bodyKey]).toBe(0);

      respond(worker.messageListener, second, { ok: true, ...structuredClone(pair) });
      await vi.waitFor(() => expect(bindingRequests(worker.postMessage)).toHaveLength(3));
      const third = bindingRequests(worker.postMessage)[2]!;
      expect(third).toMatchObject({ requestId: 3, hasParameters: false });
      expect(globals[bodyKey]).toBe(1);

      respond(worker.messageListener, third, { ok: true, ...pair });
      await vi.waitFor(() =>
        expect(messages(worker.postMessage).some(({ kind }) => kind === 'tested')).toBe(true),
      );
      const terminal = messages(worker.postMessage).filter(({ kind }) => kind === 'tested');
      expect(terminal).toHaveLength(1);
      expect(terminal[0]).toMatchObject({
        kind: 'tested',
        revision: 3,
        run: {
          passed: 2,
          failed: 2,
          results: [
            { name: 'invalid metadata never binds or runs', status: 'failed', code: 'CP1000' },
            { name: 'binding failure is a case result', status: 'failed', code: 'CP1002' },
            { name: 'first valid case', status: 'passed' },
            { name: 'second valid case', status: 'passed' },
          ],
        },
      });
      expect(globals[registrationKey]).toBe(1);
      expect(globals[bodyKey]).toBe(2);
    } finally {
      if (oldRegistrationCount === undefined) delete globals[registrationKey];
      else globals[registrationKey] = oldRegistrationCount;
      if (oldBodyCount === undefined) delete globals[bodyKey];
      else globals[bodyKey] = oldBodyCount;
    }
  });

  it('rejects a mismatched plan/resolved-circuit pair before running the case body', async () => {
    const worker = await installWorker();
    const pair = compilePair('test-worker-matching.factorio.ts', 'const output = new Network();');
    const mismatched = compilePair(
      'test-worker-unrelated.factorio.ts',
      'const input = new Network(); const output = new Network(); output += input + 1;',
    );
    const bodyKey = '__test_worker_mismatched_pair_body';
    const globals = globalThis as Record<string, unknown>;
    const oldBodyCount = globals[bodyKey];
    globals[bodyKey] = 0;
    try {
      worker.messageListener({
        data: {
          kind: 'test-source',
          revision: 5,
          sourceRevision: 52,
          source: `test('mismatched pair', () => { globalThis.${bodyKey} += 1; });`,
        },
      } as MessageEvent<TestWorkerInboundMessage>);
      const request = bindingRequests(worker.postMessage)[0]!;
      respond(worker.messageListener, request, {
        ok: true,
        plan: pair.plan,
        resolvedCircuit: mismatched.resolvedCircuit,
      });

      await vi.waitFor(() =>
        expect(messages(worker.postMessage).some(({ kind }) => kind === 'tested')).toBe(true),
      );
      expect(messages(worker.postMessage).filter(({ kind }) => kind === 'tested')).toMatchObject([
        {
          kind: 'tested',
          run: {
            passed: 0,
            failed: 1,
            results: [
              {
                name: 'mismatched pair',
                status: 'failed',
                failureKind: 'runtime',
                message: expect.stringContaining('fingerprint'),
              },
            ],
          },
        },
      ]);
      expect(globals[bodyKey]).toBe(0);
    } finally {
      if (oldBodyCount === undefined) delete globals[bodyKey];
      else globals[bodyKey] = oldBodyCount;
    }
  });
});

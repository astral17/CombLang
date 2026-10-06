import { afterEach, describe, expect, test, vi } from 'vitest';

import type {
  CompilerWorkerBindRequest,
  CompilerWorkerBoundResponse,
  CompilerWorkerOperationRequest,
  CompilerWorkerResponse,
  CompilerWorkerParsedResponse,
  CompilerWorkerRequest,
} from './worker-protocol.js';

type WorkerMessageListener = (event: MessageEvent<CompilerWorkerOperationRequest>) => void;

async function installWorker() {
  vi.resetModules();
  const runtimeModule = await import('./compiler-worker-request.js');
  let messageListener: WorkerMessageListener | undefined;
  const postMessage = vi.fn();
  const addEventListener = vi.fn((type: string, listener: EventListener) => {
    if (type === 'message') {
      messageListener = listener as unknown as WorkerMessageListener;
    }
  });
  vi.stubGlobal('self', { addEventListener, postMessage } as unknown as DedicatedWorkerGlobalScope);
  await import('./parser.worker.js');
  if (messageListener === undefined) throw new Error('Worker message listener was not installed.');
  return { runtimeModule, messageListener, postMessage, addEventListener };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe('compiler parser Worker operation routing', () => {
  test('keeps ready and parse progress/response routing unchanged', async () => {
    const worker = await installWorker();
    expect(worker.postMessage).toHaveBeenCalledOnce();
    expect(worker.postMessage).toHaveBeenCalledWith({ kind: 'ready' });
    worker.postMessage.mockClear();

    const request: CompilerWorkerRequest = {
      kind: 'parse',
      revision: 10,
      file: { path: 'worker-route.factorio.ts', text: 'const output = new Network();' },
    };
    const response: CompilerWorkerParsedResponse = {
      kind: 'parsed',
      revision: 10,
      result: {} as CompilerWorkerParsedResponse['result'],
    };
    vi.spyOn(worker.runtimeModule.CompilerWorkerRuntime.prototype, 'handle').mockImplementation(
      (_request, observe) => {
        observe?.('receive');
        return Promise.resolve(response);
      },
    );
    const handleBinding = vi.spyOn(
      worker.runtimeModule.CompilerWorkerRuntime.prototype,
      'handleBinding',
    );

    worker.messageListener({ data: request } as MessageEvent<CompilerWorkerOperationRequest>);
    await vi.waitFor(() => expect(worker.postMessage).toHaveBeenCalledTimes(3));

    expect(worker.postMessage.mock.calls.map(([message]) => message)).toEqual([
      { kind: 'progress', revision: 10, stage: 'receive' },
      { kind: 'progress', revision: 10, stage: 'transport' },
      response,
    ]);
    expect(handleBinding).not.toHaveBeenCalled();
  });

  test('posts one bound response without parse progress or parser execution', async () => {
    const worker = await installWorker();
    worker.postMessage.mockClear();
    const request: CompilerWorkerBindRequest = {
      kind: 'bind-parameters',
      revision: 11,
      sourceRevision: 10,
      token: 'wrong-token',
    };
    const response: CompilerWorkerBoundResponse = {
      kind: 'bound',
      revision: 11,
      sourceRevision: 10,
      result: {
        ok: false,
        diagnostics: [
          {
            code: 'WP1007',
            severity: 'error',
            message:
              'WP1007: parameter binding token is missing, expired, or belongs to another source revision.',
          },
        ],
      },
    };
    const handle = vi.spyOn(worker.runtimeModule.CompilerWorkerRuntime.prototype, 'handle');
    const handleBinding = vi
      .spyOn(worker.runtimeModule.CompilerWorkerRuntime.prototype, 'handleBinding')
      .mockReturnValue(response);

    worker.messageListener({ data: request } as MessageEvent<CompilerWorkerOperationRequest>);

    expect(handleBinding).toHaveBeenCalledOnce();
    expect(handleBinding).toHaveBeenCalledWith(request);
    expect(handle).not.toHaveBeenCalled();
    expect(worker.postMessage).toHaveBeenCalledOnce();
    expect(worker.postMessage).toHaveBeenCalledWith(response);
  });

  test('routes a real wrong-token operation to one WP1007 bound response', async () => {
    const worker = await installWorker();
    worker.postMessage.mockClear();
    worker.messageListener({
      data: {
        kind: 'parse',
        revision: 20,
        file: {
          path: 'worker-entrypoint-parameter.ts',
          text: "const amount = Param.number('Amount', 5); const output = new Network();",
        },
        parameterBinding: true,
      },
    } as MessageEvent<CompilerWorkerOperationRequest>);
    await vi.waitFor(() =>
      expect(
        worker.postMessage.mock.calls.some(
          ([message]) => (message as CompilerWorkerResponse).kind === 'parsed',
        ),
      ).toBe(true),
    );
    const parsed = worker.postMessage.mock.calls
      .map(([message]) => message as CompilerWorkerResponse)
      .find((message): message is CompilerWorkerParsedResponse => message.kind === 'parsed');
    const token = parsed?.parameterBinding?.ok === true ? parsed.parameterBinding.token : undefined;
    expect(token).toEqual(expect.any(String));

    worker.postMessage.mockClear();
    worker.messageListener({
      data: {
        kind: 'bind-parameters',
        revision: 21,
        sourceRevision: 20,
        token: 'wrong-token',
      },
    } as MessageEvent<CompilerWorkerOperationRequest>);

    expect(worker.postMessage).toHaveBeenCalledOnce();
    expect(worker.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'bound',
        revision: 21,
        sourceRevision: 20,
        result: expect.objectContaining({
          ok: false,
          diagnostics: expect.arrayContaining([
            expect.objectContaining({ code: 'WP1007', severity: 'error' }),
          ]),
        }),
      }),
    );
  });
});

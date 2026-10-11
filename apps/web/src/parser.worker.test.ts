import { afterEach, describe, expect, test, vi } from 'vitest';

import type {
  CompilerWorkerBindRequest,
  CompilerWorkerBoundResponse,
  CompilerWorkerImportRequest,
  CompilerWorkerImportedResponse,
  CompilerWorkerMessageRequest,
  CompilerWorkerResponse,
  CompilerWorkerParsedResponse,
  CompilerWorkerRequest,
} from './worker-protocol.js';

type WorkerMessageListener = (event: MessageEvent<CompilerWorkerMessageRequest>) => void;

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

    worker.messageListener({ data: request } as MessageEvent<CompilerWorkerMessageRequest>);
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

    worker.messageListener({ data: request } as MessageEvent<CompilerWorkerMessageRequest>);

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
    } as MessageEvent<CompilerWorkerMessageRequest>);
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
    } as MessageEvent<CompilerWorkerMessageRequest>);

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

  test('routes import to one imported terminal response without parse or bind handlers', async () => {
    const worker = await installWorker();
    worker.postMessage.mockClear();
    const request: CompilerWorkerImportRequest = {
      kind: 'import-blueprint',
      revision: 31,
      document: { text: '{"blueprint":{"entities":[],"wires":[]}}' },
      sourcePath: 'virtual/imported.factorio.ts',
    };
    const response: CompilerWorkerImportedResponse = {
      kind: 'blueprint-imported',
      revision: 31,
      result: { state: 'blocked', diagnostics: [] },
    };
    const handle = vi.spyOn(worker.runtimeModule.CompilerWorkerRuntime.prototype, 'handle');
    const handleBinding = vi.spyOn(
      worker.runtimeModule.CompilerWorkerRuntime.prototype,
      'handleBinding',
    );
    const handleImport = vi
      .spyOn(worker.runtimeModule.CompilerWorkerRuntime.prototype, 'handleImport')
      .mockImplementation(async (_request, observe) => {
        observe?.('receive');
        observe?.('profile');
        return response;
      });

    worker.messageListener({ data: request } as MessageEvent<CompilerWorkerMessageRequest>);
    await vi.waitFor(() => expect(worker.postMessage).toHaveBeenCalledTimes(4));

    expect(worker.postMessage.mock.calls.map(([message]) => message)).toEqual([
      { kind: 'progress', revision: 31, stage: 'receive' },
      { kind: 'progress', revision: 31, stage: 'profile' },
      { kind: 'progress', revision: 31, stage: 'transport' },
      response,
    ]);
    expect(
      worker.postMessage.mock.calls.filter(
        ([message]) => (message as CompilerWorkerImportedResponse).kind === 'blueprint-imported',
      ),
    ).toHaveLength(1);
    expect(handleImport).toHaveBeenCalledOnce();
    expect(handle).not.toHaveBeenCalled();
    expect(handleBinding).not.toHaveBeenCalled();
  });

  test('turns a rejected import handler into one blocked response without an unhandled rejection', async () => {
    const worker = await installWorker();
    worker.postMessage.mockClear();
    const request: CompilerWorkerImportRequest = {
      kind: 'import-blueprint',
      revision: 32,
      document: { text: '{}' },
      sourcePath: 'virtual/imported.factorio.ts',
    };
    vi.spyOn(
      worker.runtimeModule.CompilerWorkerRuntime.prototype,
      'handleImport',
    ).mockRejectedValue(new Error('unexpected endpoint rejection'));

    worker.messageListener({ data: request } as MessageEvent<CompilerWorkerMessageRequest>);
    await vi.waitFor(() => expect(worker.postMessage).toHaveBeenCalledTimes(2));
    expect(worker.postMessage.mock.calls.at(-1)?.[0]).toMatchObject({
      kind: 'blueprint-imported',
      revision: 32,
      result: {
        state: 'blocked',
        error: { code: 'WP1010', message: 'unexpected endpoint rejection' },
      },
    });
  });
});

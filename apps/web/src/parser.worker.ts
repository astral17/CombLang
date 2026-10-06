/// <reference lib="webworker" />

import { CompilerWorkerRuntime } from './compiler-worker-request.js';
import type {
  CompilerWorkerOperationRequest,
  CompilerWorkerReadyResponse,
  CompilerWorkerProgressStage,
} from './worker-protocol.js';

const worker = self as DedicatedWorkerGlobalScope;
const compiler = new CompilerWorkerRuntime();

worker.addEventListener('message', (event: MessageEvent<CompilerWorkerOperationRequest>) => {
  if (event.data.kind === 'bind-parameters') {
    worker.postMessage(compiler.handleBinding(event.data));
    return;
  }
  if (event.data.kind !== 'parse') {
    return;
  }

  const report = (stage: CompilerWorkerProgressStage): void => {
    worker.postMessage({ kind: 'progress', revision: event.data.revision, stage });
  };
  void compiler.handle(event.data, report).then((response) => {
    report('transport');
    worker.postMessage(response);
  });
});

const ready: CompilerWorkerReadyResponse = { kind: 'ready' };
worker.postMessage(ready);

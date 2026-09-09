/// <reference lib="webworker" />

import { CompilerWorkerRuntime } from './compiler-worker-request.js';
import type {
  CompilerWorkerReadyResponse,
  CompilerWorkerRequest,
  CompilerWorkerProgressStage,
} from './worker-protocol.js';

const worker = self as DedicatedWorkerGlobalScope;
const compiler = new CompilerWorkerRuntime();

worker.addEventListener('message', (event: MessageEvent<CompilerWorkerRequest>) => {
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

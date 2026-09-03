/// <reference lib="webworker" />

import { CompilerWorkerRuntime } from './compiler-worker-request.js';
import type { CompilerWorkerRequest, CompilerWorkerResponse } from './worker-protocol.js';

const worker = self as DedicatedWorkerGlobalScope;
const compiler = new CompilerWorkerRuntime();

worker.addEventListener('message', (event: MessageEvent<CompilerWorkerRequest>) => {
  if (event.data.kind !== 'parse') {
    return;
  }

  void compiler.handle(event.data).then((response: CompilerWorkerResponse) => {
    worker.postMessage(response);
  });
});

/// <reference lib="webworker" />

import { compileSource } from './compile-source.js';
import type { CompilerWorkerRequest, CompilerWorkerResponse } from './worker-protocol.js';

const worker = self as DedicatedWorkerGlobalScope;

worker.addEventListener('message', (event: MessageEvent<CompilerWorkerRequest>) => {
  if (event.data.kind !== 'parse') {
    return;
  }

  const response: CompilerWorkerResponse = {
    kind: 'parsed',
    revision: event.data.revision,
    result: compileSource(event.data.file),
  };
  worker.postMessage(response);
});

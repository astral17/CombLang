/// <reference lib="webworker" />

import type { TestWorkerRequest, TestWorkerResponse } from './test-worker-protocol.js';
import { runWebTests } from './web-test-runner.js';

const worker = self as DedicatedWorkerGlobalScope;

worker.addEventListener('message', (event: MessageEvent<TestWorkerRequest>) => {
  if (event.data.kind !== 'test') return;
  const response: TestWorkerResponse = {
    kind: 'tested',
    revision: event.data.revision,
    run: runWebTests(event.data.plan, event.data.source),
  };
  worker.postMessage(response);
});

/// <reference lib="webworker" />

import type {
  TestWorkerBindResponse,
  TestWorkerInboundMessage,
  TestWorkerRequest,
  TestWorkerResponse,
  TestWorkerSourceRequest,
} from './test-worker-protocol.js';
import { TestWorkerBindingInbox } from './test-worker-binding-inbox.js';
import { runWebTests, runWebTestsWithExecutionResolver } from './web-test-runner.js';

const worker = self as DedicatedWorkerGlobalScope;
let activeRevision: number | undefined;
let activeSourceRevision: number | undefined;
const bindingInbox = new TestWorkerBindingInbox();

worker.addEventListener('message', (event: MessageEvent<TestWorkerInboundMessage>) => {
  if (event.data.kind === 'test-bind-response') {
    receiveBinding(event.data);
    return;
  }
  if (event.data.kind === 'test') {
    runConcreteTests(event.data);
    return;
  }
  if (event.data.kind === 'test-source') runSourceTests(event.data);
});

function runConcreteTests(request: TestWorkerRequest): void {
  activeRevision = request.revision;
  activeSourceRevision = undefined;
  bindingInbox.cancel();
  worker.postMessage(phase(request.revision, 'executing'));
  const response: TestWorkerResponse = {
    kind: 'tested',
    revision: request.revision,
    run: runWebTests(request.plan, request.source, request.resolvedCircuit),
  };
  worker.postMessage(response);
}

function runSourceTests(request: TestWorkerSourceRequest): void {
  activeRevision = request.revision;
  activeSourceRevision = request.sourceRevision;
  bindingInbox.begin(request.revision, request.sourceRevision);
  worker.postMessage(phase(request.revision, 'executing'));
  void runWebTestsWithExecutionResolver((parameters) => {
    const pending = bindingInbox.request(parameters);
    worker.postMessage(phase(request.revision, 'waiting-for-binding'));
    worker.postMessage(pending.request);
    return pending.pair;
  }, request.source).then((run) => {
    if (activeRevision !== request.revision) return;
    bindingInbox.cancel();
    const response: TestWorkerResponse = {
      kind: 'tested',
      revision: request.revision,
      run,
    };
    worker.postMessage(response);
  });
}

function receiveBinding(response: TestWorkerBindResponse): void {
  if (
    activeRevision !== response.revision ||
    activeSourceRevision !== response.sourceRevision ||
    !bindingInbox.receive(response)
  )
    return;
  worker.postMessage(phase(response.revision, 'executing'));
}

function phase(revision: number, value: 'executing' | 'waiting-for-binding'): TestWorkerResponse {
  return { kind: 'test-phase', revision, phase: value };
}

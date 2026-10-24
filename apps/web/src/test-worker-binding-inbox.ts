import type { WebTestCircuitPair } from './web-test-runner.js';
import type { TestWorkerBindRequest, TestWorkerBindResponse } from './test-worker-protocol.js';

interface PendingBinding {
  readonly request: TestWorkerBindRequest;
  readonly resolve: (pair: WebTestCircuitPair) => void;
  readonly reject: (reason: unknown) => void;
}

/** Accepts exactly one response for the one case currently awaited by the test Worker. */
export class TestWorkerBindingInbox {
  #revision: number | undefined;
  #sourceRevision: number | undefined;
  #nextRequestId = 0;
  #pending: PendingBinding | undefined;

  begin(revision: number, sourceRevision: number): void {
    this.cancel();
    this.#revision = revision;
    this.#sourceRevision = sourceRevision;
  }

  request(parameters?: unknown): {
    readonly request: TestWorkerBindRequest;
    readonly pair: Promise<WebTestCircuitPair>;
  } {
    if (this.#revision === undefined || this.#sourceRevision === undefined) {
      throw new Error('No source-bound test run is active.');
    }
    if (this.#pending !== undefined) {
      throw new Error('A test case is already waiting for its compiler binding.');
    }
    const request: TestWorkerBindRequest = {
      kind: 'test-bind-request',
      revision: this.#revision,
      sourceRevision: this.#sourceRevision,
      requestId: ++this.#nextRequestId,
      hasParameters: parameters !== undefined,
      ...(parameters === undefined ? {} : { parameters }),
    };
    let resolve!: (pair: WebTestCircuitPair) => void;
    let reject!: (reason: unknown) => void;
    const pair = new Promise<WebTestCircuitPair>((done, fail) => {
      resolve = done;
      reject = fail;
    });
    this.#pending = { request, resolve, reject };
    return { request, pair };
  }

  receive(response: TestWorkerBindResponse): boolean {
    const pending = this.#pending;
    if (
      pending === undefined ||
      response.revision !== this.#revision ||
      response.sourceRevision !== this.#sourceRevision ||
      response.requestId !== pending.request.requestId
    ) {
      return false;
    }
    this.#pending = undefined;
    if (response.result.ok) {
      pending.resolve({
        plan: response.result.plan,
        resolvedCircuit: response.result.resolvedCircuit,
      });
    } else {
      pending.reject(response.result.error);
    }
    return true;
  }

  cancel(): void {
    const pending = this.#pending;
    this.#pending = undefined;
    this.#revision = undefined;
    this.#sourceRevision = undefined;
    pending?.reject(new Error('The source-bound test run was cancelled.'));
  }
}

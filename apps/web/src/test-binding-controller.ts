import type { CompilerWorkerBindRequest, CompilerWorkerBoundResponse } from './worker-protocol.js';
import type {
  TestWorkerBindRequest,
  TestWorkerBindResponse,
  TestWorkerBindingFailure,
} from './test-worker-protocol.js';
import type { Diagnostic } from '@comblang/shared';

export interface TestBindingRunSnapshot {
  readonly revision: number;
  readonly sourceRevision: number;
  readonly workerId: number;
  readonly profileSelectionRevision: number;
  readonly profileIdentity?: string;
  readonly token: string;
}

export interface TestBindingRunInvalidation {
  readonly kind: 'test-run-invalidated';
  readonly revision: number;
  readonly sourceRevision: number;
  readonly message: string;
}

export type TestBindingCompletion = TestWorkerBindResponse | TestBindingRunInvalidation | undefined;

interface PendingCase {
  readonly workerRequest: TestWorkerBindRequest;
}

interface ActiveCase extends PendingCase {
  readonly compilerRevision: number;
}

/** Correlates one awaited test case with the existing newest-only compiler scheduler. */
export class TestBindingController {
  #snapshot: TestBindingRunSnapshot | undefined;
  #pending: PendingCase | undefined;
  #active: ActiveCase | undefined;
  #ownedCompilerRevisions = new Set<number>();
  #lastRequestId = 0;

  get snapshot(): TestBindingRunSnapshot | undefined {
    return this.#snapshot;
  }

  get hasPendingCase(): boolean {
    return this.#pending !== undefined;
  }

  begin(snapshot: TestBindingRunSnapshot): void {
    if (this.#snapshot?.workerId !== snapshot.workerId) this.#ownedCompilerRevisions.clear();
    this.cancel();
    this.#lastRequestId = 0;
    this.#snapshot = snapshot;
  }

  requestCase(request: TestWorkerBindRequest): boolean {
    const snapshot = this.#snapshot;
    if (
      snapshot === undefined ||
      request.revision !== snapshot.revision ||
      request.sourceRevision !== snapshot.sourceRevision ||
      !Number.isSafeInteger(request.requestId) ||
      request.requestId <= this.#lastRequestId ||
      this.#pending !== undefined ||
      this.#active !== undefined ||
      (!request.hasParameters && Object.hasOwn(request, 'parameters')) ||
      (request.hasParameters && !Object.hasOwn(request, 'parameters'))
    ) {
      return false;
    }
    this.#lastRequestId = request.requestId;
    this.#pending = { workerRequest: request };
    return true;
  }

  takeForDispatch(compilerRevision: number): CompilerWorkerBindRequest | undefined {
    const snapshot = this.#snapshot;
    const pending = this.#pending;
    if (snapshot === undefined || pending === undefined || this.#active !== undefined) {
      return undefined;
    }
    this.#pending = undefined;
    this.#active = { ...pending, compilerRevision };
    this.#ownedCompilerRevisions.add(compilerRevision);
    return {
      kind: 'bind-parameters',
      revision: compilerRevision,
      sourceRevision: snapshot.sourceRevision,
      token: snapshot.token,
      ...(pending.workerRequest.hasParameters
        ? { overrides: pending.workerRequest.parameters }
        : {}),
    };
  }

  releaseForRetry(compilerRevision: number): boolean {
    const active = this.#active;
    if (active?.compilerRevision !== compilerRevision) return false;
    this.#pending = { workerRequest: active.workerRequest };
    this.#active = undefined;
    return true;
  }

  ownsCompilerRevision(revision: number): boolean {
    return this.#ownedCompilerRevisions.has(revision);
  }

  forgetCompilerRevision(revision: number): void {
    this.#ownedCompilerRevisions.delete(revision);
  }

  clearCompilerRevisions(): void {
    this.#ownedCompilerRevisions.clear();
  }

  complete(
    workerId: number,
    response: CompilerWorkerBoundResponse,
    isSnapshotCurrent: (snapshot: TestBindingRunSnapshot) => boolean,
  ): TestBindingCompletion {
    const active = this.#active;
    const snapshot = this.#snapshot;
    if (
      active === undefined ||
      snapshot === undefined ||
      workerId !== snapshot.workerId ||
      response.revision !== active.compilerRevision ||
      response.sourceRevision !== snapshot.sourceRevision
    ) {
      return undefined;
    }
    this.#active = undefined;
    if (!isSnapshotCurrent(snapshot)) {
      this.cancel();
      const diagnostic = response.result.ok ? undefined : response.result.diagnostics[0];
      return {
        kind: 'test-run-invalidated',
        revision: snapshot.revision,
        sourceRevision: snapshot.sourceRevision,
        message:
          diagnostic === undefined
            ? 'The source capture or test context changed during parameter binding.'
            : `${diagnostic.code}: ${diagnostic.message}`,
      };
    }
    const result: TestWorkerBindResponse['result'] = response.result.ok
      ? {
          ok: true,
          plan: response.result.plan,
          resolvedCircuit: response.result.resolvedCircuit,
        }
      : { ok: false, error: failureFromDiagnostic(response.result.diagnostics[0]) };
    return {
      kind: 'test-bind-response',
      revision: active.workerRequest.revision,
      sourceRevision: active.workerRequest.sourceRevision,
      requestId: active.workerRequest.requestId,
      result,
    };
  }

  cancel(): void {
    this.#snapshot = undefined;
    this.#pending = undefined;
    this.#active = undefined;
  }
}

/** Guards page-side termination so an old invalidation cannot stop a newer run. */
export function shouldTerminateTestRunForInvalidation(
  invalidation: TestBindingRunInvalidation,
  currentTestRevision: number,
  currentSourceRevision: number,
  hasTestWorker: boolean,
): boolean {
  return (
    hasTestWorker &&
    invalidation.revision === currentTestRevision &&
    invalidation.sourceRevision === currentSourceRevision
  );
}

function failureFromDiagnostic(diagnostic: Diagnostic | undefined): TestWorkerBindingFailure {
  if (diagnostic === undefined) return { message: 'Parameter binding failed.' };
  const path = /^((?:\$|[A-Za-z])[^:]*): /.exec(diagnostic.message)?.[1];
  return {
    message: diagnostic.message,
    code: diagnostic.code,
    ...(path === undefined ? {} : { path }),
    ...(diagnostic.span === undefined ? {} : { span: diagnostic.span }),
  };
}

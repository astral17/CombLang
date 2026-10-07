import type {
  CompilerWorkerBindRequest,
  CompilerWorkerBoundResponse,
  CompilerWorkerOperationRequest,
  CompilerWorkerParsedResponse,
  CompilerWorkerRequest,
} from './worker-protocol.js';

export const COMPILER_WORKER_BOOTSTRAP_TIMEOUT_MS = 30000;

export function compilerWorkerBootstrapTimeoutReason(): string {
  return `Compiler Worker readiness exceeded the ${COMPILER_WORKER_BOOTSTRAP_TIMEOUT_MS} ms watchdog.`;
}

export type CompilerWorkerSchedulerPhase = 'absent' | 'booting' | 'ready' | 'busy';

export type CompilerWorkerCompletionOutcome = 'ignored' | 'stale' | 'accepted';

export interface CompilerWorkerBindingCapture {
  readonly workerId: number;
  readonly sourceRevision: number;
  readonly token: string;
}

export interface CompilerWorkerDispatch {
  readonly request: CompilerWorkerOperationRequest;
  readonly isCold: boolean;
}

/** Coordinates one Worker generation and keeps only the newest queued operation. */
export class CompilerWorkerScheduler {
  #nextWorkerId = 0;
  #currentWorkerId: number | undefined;
  #phase: CompilerWorkerSchedulerPhase = 'absent';
  #queuedRequest: CompilerWorkerOperationRequest | undefined;
  #activeRequest: CompilerWorkerOperationRequest | undefined;
  #bindingCapture: CompilerWorkerBindingCapture | undefined;
  #completedParse = false;

  get phase(): CompilerWorkerSchedulerPhase {
    return this.#phase;
  }

  get activeRevision(): number | undefined {
    return this.#activeRequest?.revision;
  }

  get activeRequest(): CompilerWorkerOperationRequest | undefined {
    return this.#activeRequest;
  }

  get bindingCapture(): CompilerWorkerBindingCapture | undefined {
    return this.#bindingCapture;
  }

  get hasQueuedRequest(): boolean {
    return this.#queuedRequest !== undefined;
  }

  createWorker(): number {
    if (this.#phase !== 'absent') throw new Error('Cannot create a Worker while one is active.');
    const workerId = ++this.#nextWorkerId;
    this.#currentWorkerId = workerId;
    this.#phase = 'booting';
    this.#bindingCapture = undefined;
    if (this.#queuedRequest?.kind === 'bind-parameters') this.#queuedRequest = undefined;
    this.#completedParse = false;
    return workerId;
  }

  isCurrent(workerId: number): boolean {
    return this.#currentWorkerId === workerId;
  }

  enqueue(request: CompilerWorkerRequest): void {
    this.#queuedRequest = request;
    this.#bindingCapture = undefined;
  }

  enqueueBinding(request: CompilerWorkerBindRequest): boolean {
    const capture = this.#bindingCapture;
    const canQueue =
      this.#phase === 'ready' ||
      (this.#phase === 'busy' && this.#activeRequest?.kind === 'bind-parameters');
    if (
      !canQueue ||
      this.#currentWorkerId === undefined ||
      capture === undefined ||
      capture.workerId !== this.#currentWorkerId ||
      capture.sourceRevision !== request.sourceRevision ||
      capture.token !== request.token ||
      this.#queuedRequest?.kind === 'parse'
    ) {
      return false;
    }
    this.#queuedRequest = request;
    return true;
  }

  markReady(workerId: number): boolean {
    if (!this.isCurrent(workerId) || this.#phase !== 'booting') return false;
    this.#phase = 'ready';
    return true;
  }

  takeForDispatch(): CompilerWorkerDispatch | undefined {
    if (this.#phase !== 'ready' || this.#activeRequest !== undefined) return undefined;
    const request = this.#queuedRequest;
    if (request === undefined) return undefined;
    this.#queuedRequest = undefined;
    this.#activeRequest = request;
    this.#phase = 'busy';
    return {
      request,
      isCold: request.kind === 'parse' && !this.#completedParse,
    };
  }

  complete(
    workerId: number,
    response: CompilerWorkerParsedResponse | CompilerWorkerBoundResponse,
  ): CompilerWorkerCompletionOutcome {
    const active = this.#activeRequest;
    if (
      !this.isCurrent(workerId) ||
      this.#phase !== 'busy' ||
      active === undefined ||
      active.revision !== response.revision ||
      (active.kind === 'parse' && response.kind !== 'parsed') ||
      (active.kind === 'bind-parameters' &&
        (response.kind !== 'bound' || response.sourceRevision !== active.sourceRevision))
    ) {
      return 'ignored';
    }
    this.#activeRequest = undefined;
    if (response.kind === 'parsed') this.#completedParse = true;
    this.#phase = 'ready';

    if (response.kind === 'bound' && hasDiagnosticCode(response, 'WP1007')) {
      this.#bindingCapture = undefined;
      if (
        this.#queuedRequest?.kind === 'bind-parameters' &&
        active.kind === 'bind-parameters' &&
        this.#queuedRequest.sourceRevision === response.sourceRevision &&
        this.#queuedRequest.token === active.token
      ) {
        this.#queuedRequest = undefined;
      }
    }

    if (this.#queuedRequest !== undefined) return 'stale';

    if (response.kind === 'parsed') {
      const binding = response.parameterBinding;
      if (binding?.ok === true && binding.token !== undefined) {
        this.#bindingCapture = Object.freeze({
          workerId,
          sourceRevision: response.revision,
          token: binding.token,
        });
      }
    }

    return 'accepted';
  }

  fail(workerId: number): boolean {
    if (!this.isCurrent(workerId)) return false;
    this.#currentWorkerId = undefined;
    this.#phase = 'absent';
    this.#activeRequest = undefined;
    this.#bindingCapture = undefined;
    if (this.#queuedRequest?.kind === 'bind-parameters') this.#queuedRequest = undefined;
    this.#completedParse = false;
    return true;
  }
}

function hasDiagnosticCode(response: CompilerWorkerBoundResponse, code: string): boolean {
  return (
    !response.result.ok &&
    response.result.diagnostics.some((diagnostic) => diagnostic.code === code)
  );
}

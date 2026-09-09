import type { CompilerWorkerRequest } from './worker-protocol.js';

export const COMPILER_WORKER_BOOTSTRAP_TIMEOUT_MS = 30000;

export function compilerWorkerBootstrapTimeoutReason(): string {
  return `Compiler Worker readiness exceeded the ${COMPILER_WORKER_BOOTSTRAP_TIMEOUT_MS} ms watchdog.`;
}

export type CompilerWorkerSchedulerPhase = 'absent' | 'booting' | 'ready' | 'busy';

export interface CompilerWorkerDispatch {
  readonly request: CompilerWorkerRequest;
  readonly isCold: boolean;
}

/** Coordinates one Worker generation and keeps only the newest queued revision. */
export class CompilerWorkerScheduler {
  #nextWorkerId = 0;
  #currentWorkerId: number | undefined;
  #phase: CompilerWorkerSchedulerPhase = 'absent';
  #queuedRequest: CompilerWorkerRequest | undefined;
  #activeRequest: CompilerWorkerRequest | undefined;
  #completedRequest = false;

  get phase(): CompilerWorkerSchedulerPhase {
    return this.#phase;
  }

  get activeRevision(): number | undefined {
    return this.#activeRequest?.revision;
  }

  get hasQueuedRequest(): boolean {
    return this.#queuedRequest !== undefined;
  }

  createWorker(): number {
    if (this.#phase !== 'absent') throw new Error('Cannot create a Worker while one is active.');
    const workerId = ++this.#nextWorkerId;
    this.#currentWorkerId = workerId;
    this.#phase = 'booting';
    this.#completedRequest = false;
    return workerId;
  }

  isCurrent(workerId: number): boolean {
    return this.#currentWorkerId === workerId;
  }

  enqueue(request: CompilerWorkerRequest): void {
    this.#queuedRequest = request;
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
    return { request, isCold: !this.#completedRequest };
  }

  complete(workerId: number, revision: number): boolean {
    if (
      !this.isCurrent(workerId) ||
      this.#phase !== 'busy' ||
      this.#activeRequest?.revision !== revision
    ) {
      return false;
    }
    this.#activeRequest = undefined;
    this.#completedRequest = true;
    this.#phase = 'ready';
    return true;
  }

  fail(workerId: number): boolean {
    if (!this.isCurrent(workerId)) return false;
    this.#currentWorkerId = undefined;
    this.#phase = 'absent';
    this.#activeRequest = undefined;
    return true;
  }
}

import type { CompilerWorkerProgressStage } from './worker-protocol.js';

/** Stores only the last phase for one current Worker request. */
export class CompilerWorkerProgressTracker {
  #workerId: number | undefined;
  #revision: number | undefined;
  #lastStage: CompilerWorkerProgressStage | undefined;

  begin(workerId: number, revision: number): void {
    this.#workerId = workerId;
    this.#revision = revision;
    this.#lastStage = undefined;
  }

  report(workerId: number, revision: number, stage: CompilerWorkerProgressStage): boolean {
    if (this.#workerId !== workerId || this.#revision !== revision) return false;
    this.#lastStage = stage;
    return true;
  }

  lastStage(workerId: number, revision: number): CompilerWorkerProgressStage | undefined {
    if (this.#workerId !== workerId || this.#revision !== revision) return undefined;
    return this.#lastStage;
  }

  clear(): void {
    this.#workerId = undefined;
    this.#revision = undefined;
    this.#lastStage = undefined;
  }
}

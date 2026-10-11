import type {
  CompilerWorkerBlueprintImportResult,
  CompilerWorkerImportedResponse,
} from './worker-protocol.js';

export interface BlueprintImportSnapshot {
  readonly requestRevision: number;
  readonly workerId: number;
  readonly sourceRevision: number;
  readonly profileSelectionRevision: number;
  readonly profileIdentity: string;
  readonly inputEditGeneration: number;
}

export type BlueprintImportSessionState =
  | { readonly state: 'idle' }
  | { readonly state: 'pending'; readonly snapshot: BlueprintImportSnapshot }
  | {
      readonly state: 'verified';
      readonly snapshot: BlueprintImportSnapshot;
      readonly result: Extract<CompilerWorkerBlueprintImportResult, { state: 'verified' }>;
    }
  | {
      readonly state: 'blocked';
      readonly snapshot: BlueprintImportSnapshot;
      readonly result: Extract<CompilerWorkerBlueprintImportResult, { state: 'blocked' }>;
    }
  | {
      readonly state: 'failed';
      readonly snapshot: BlueprintImportSnapshot;
      readonly message: string;
    }
  | { readonly state: 'stale'; readonly message: string }
  | { readonly state: 'consumed' };

function snapshot(value: BlueprintImportSnapshot): BlueprintImportSnapshot {
  return Object.freeze({ ...value });
}

function sameSnapshot(a: BlueprintImportSnapshot, b: BlueprintImportSnapshot): boolean {
  return (
    a.requestRevision === b.requestRevision &&
    a.workerId === b.workerId &&
    a.sourceRevision === b.sourceRevision &&
    a.profileSelectionRevision === b.profileSelectionRevision &&
    a.profileIdentity === b.profileIdentity &&
    a.inputEditGeneration === b.inputEditGeneration
  );
}

/** In-memory, one-use permission to apply one verified import preview. */
export class BlueprintImportSession {
  #state: BlueprintImportSessionState = { state: 'idle' };

  get state(): BlueprintImportSessionState {
    return this.#state;
  }

  get activeSnapshot(): BlueprintImportSnapshot | undefined {
    return 'snapshot' in this.#state ? this.#state.snapshot : undefined;
  }

  begin(value: BlueprintImportSnapshot): void {
    this.#state = { state: 'pending', snapshot: snapshot(value) };
  }

  complete(
    requested: BlueprintImportSnapshot,
    response: CompilerWorkerImportedResponse,
    current: BlueprintImportSnapshot | undefined,
  ): boolean {
    const pending = this.#state;
    if (
      pending.state !== 'pending' ||
      !sameSnapshot(pending.snapshot, requested) ||
      response.revision !== requested.requestRevision ||
      current === undefined ||
      !sameSnapshot(requested, current)
    ) {
      return false;
    }
    this.#state =
      response.result.state === 'verified'
        ? { state: 'verified', snapshot: pending.snapshot, result: response.result }
        : { state: 'blocked', snapshot: pending.snapshot, result: response.result };
    return true;
  }

  fail(requested: BlueprintImportSnapshot, message: string): boolean {
    const pending = this.#state;
    if (pending.state !== 'pending' || !sameSnapshot(pending.snapshot, requested)) return false;
    this.#state = { state: 'failed', snapshot: pending.snapshot, message };
    return true;
  }

  invalidate(message = 'Preview is stale; convert again.'): void {
    if (this.#state.state === 'idle' || this.#state.state === 'consumed') return;
    this.#state = { state: 'stale', message };
  }

  canApply(current: BlueprintImportSnapshot | undefined): boolean {
    return (
      this.#state.state === 'verified' &&
      current !== undefined &&
      sameSnapshot(this.#state.snapshot, current)
    );
  }

  consume(
    current: BlueprintImportSnapshot | undefined,
  ): Extract<CompilerWorkerBlueprintImportResult, { state: 'verified' }> | undefined {
    if (!this.canApply(current) || this.#state.state !== 'verified') return undefined;
    const result = this.#state.result;
    this.#state = { state: 'consumed' };
    return result;
  }
}

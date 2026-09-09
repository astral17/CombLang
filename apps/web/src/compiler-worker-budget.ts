import type { CompilerWorkerProgressStage, CompilerWorkerRequest } from './worker-protocol.js';

export const COLD_COMPILER_WORKER_REQUEST_TIMEOUT_MS = 15000;
export const WARM_COMPILER_WORKER_REQUEST_TIMEOUT_MS = 1000;
export const SOURCE_PROFILE_COMPILER_WORKER_TIMEOUT_MS = 15000;

export function compilerWorkerRequestTimeoutMs(
  request: Pick<CompilerWorkerRequest, 'prototypeProfile'>,
  workerIsCold: boolean,
): number {
  if (request.prototypeProfile !== undefined && 'source' in request.prototypeProfile) {
    return SOURCE_PROFILE_COMPILER_WORKER_TIMEOUT_MS;
  }
  return workerIsCold
    ? COLD_COMPILER_WORKER_REQUEST_TIMEOUT_MS
    : WARM_COMPILER_WORKER_REQUEST_TIMEOUT_MS;
}

export function compilerWorkerRequestTimeoutReason(
  request: Pick<CompilerWorkerRequest, 'prototypeProfile'>,
  timeoutMs: number,
  lastStage?: CompilerWorkerProgressStage,
): string {
  const operation =
    request.prototypeProfile !== undefined && 'source' in request.prototypeProfile
      ? 'Prototype profile import'
      : 'Compilation';
  const phase = lastStage === undefined ? '' : ` (last reported phase: ${lastStage})`;
  return `${operation} exceeded the ${timeoutMs} ms worker budget.${phase}`;
}

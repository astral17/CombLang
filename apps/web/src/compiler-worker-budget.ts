import type {
  CompilerWorkerBindRequest,
  CompilerWorkerImportRequest,
  CompilerWorkerProgressStage,
  CompilerWorkerRequest,
} from './worker-protocol.js';

export const COLD_COMPILER_WORKER_REQUEST_TIMEOUT_MS = 15000;
export const WARM_COMPILER_WORKER_REQUEST_TIMEOUT_MS = 1000;
export const SOURCE_PROFILE_COMPILER_WORKER_TIMEOUT_MS = 15000;
export const BLUEPRINT_IMPORT_COMPILER_WORKER_TIMEOUT_MS = 15000;

type CompilerWorkerBudgetRequest =
  | Pick<CompilerWorkerRequest, 'prototypeProfile'>
  | CompilerWorkerBindRequest
  | CompilerWorkerImportRequest;

function isBindingRequest(
  request: CompilerWorkerBudgetRequest,
): request is CompilerWorkerBindRequest {
  return 'kind' in request && request.kind === 'bind-parameters';
}

function isBlueprintImportRequest(
  request: CompilerWorkerBudgetRequest,
): request is CompilerWorkerImportRequest {
  return 'kind' in request && request.kind === 'import-blueprint';
}

export function compilerWorkerRequestTimeoutMs(
  request: CompilerWorkerBudgetRequest,
  workerIsCold: boolean,
): number {
  if (isBindingRequest(request)) return WARM_COMPILER_WORKER_REQUEST_TIMEOUT_MS;
  if (isBlueprintImportRequest(request)) return BLUEPRINT_IMPORT_COMPILER_WORKER_TIMEOUT_MS;
  if (request.prototypeProfile !== undefined && 'source' in request.prototypeProfile) {
    return SOURCE_PROFILE_COMPILER_WORKER_TIMEOUT_MS;
  }
  return workerIsCold
    ? COLD_COMPILER_WORKER_REQUEST_TIMEOUT_MS
    : WARM_COMPILER_WORKER_REQUEST_TIMEOUT_MS;
}

export function compilerWorkerRequestTimeoutReason(
  request: CompilerWorkerBudgetRequest,
  timeoutMs: number,
  lastStage?: CompilerWorkerProgressStage,
): string {
  if (isBindingRequest(request)) {
    return `Parameter binding exceeded the ${timeoutMs} ms worker budget.`;
  }
  if (isBlueprintImportRequest(request)) {
    const phase = lastStage === undefined ? '' : ` (last reported phase: ${lastStage})`;
    return `Blueprint import exceeded the ${timeoutMs} ms worker budget.${phase}`;
  }
  const operation =
    request.prototypeProfile !== undefined && 'source' in request.prototypeProfile
      ? 'Prototype profile import'
      : 'Compilation';
  const phase = lastStage === undefined ? '' : ` (last reported phase: ${lastStage})`;
  return `${operation} exceeded the ${timeoutMs} ms worker budget.${phase}`;
}

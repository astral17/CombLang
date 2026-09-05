import type { Diagnostic } from '@comblang/shared';

import { ElaborationExecutionError, ElaborationOperationLimitError } from './elaboration-errors.js';

/** Normalizes execution failures identically for every compilation host. */
export function executionFailureDiagnostic(error: unknown): Diagnostic {
  return {
    code:
      error instanceof ElaborationOperationLimitError
        ? 'EX1003'
        : error instanceof ElaborationExecutionError
          ? error.code
          : 'EX1001',
    severity: 'error',
    message: error instanceof Error ? error.message : 'Elaboration execution failed.',
    ...(error instanceof ElaborationExecutionError ? { span: error.span } : {}),
    ...(error instanceof ElaborationExecutionError && error.related !== undefined
      ? { related: error.related }
      : {}),
  };
}

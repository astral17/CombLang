import type { Diagnostic, SourceSpan } from '@comblang/shared';

export class ElaborationOperationLimitError extends Error {
  constructor(limit: number) {
    super(
      `Compile-time generator exceeded the safety limit of ${limit} circuit-recording DSL calls.`,
    );
    this.name = 'ElaborationOperationLimitError';
  }
}

export class ElaborationExecutionError extends Error {
  constructor(
    message: string,
    readonly span: SourceSpan,
    readonly code = 'EX1001',
    readonly related: Diagnostic['related'] = undefined,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'ElaborationExecutionError';
  }
}

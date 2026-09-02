import { ElaborationExecutionError, RuntimeDiagnosticError } from '@comblang/runtime';
import { offsetToPosition, type Diagnostic } from '@comblang/shared';

export function sourcePreviewDiagnostic(error: unknown): Diagnostic {
  if (error instanceof RuntimeDiagnosticError) return error.diagnostic;
  if (error instanceof ElaborationExecutionError) {
    return {
      code: error.code,
      severity: 'error',
      message: error.message,
      span: error.span,
      ...(error.related === undefined ? {} : { related: error.related }),
    };
  }
  return {
    code: 'WEB1001',
    severity: 'error',
    message: error instanceof Error ? error.message : 'Runtime preview failed.',
  };
}

export function formatSourceDiagnostic(diagnostic: Diagnostic, source: string): string {
  const position =
    diagnostic.span === undefined ? undefined : offsetToPosition(source, diagnostic.span.start);
  const location = position === undefined ? '' : ` at ${position.line + 1}:${position.column + 1}`;
  return `${diagnostic.code} ${diagnostic.severity}${location}: ${diagnostic.message}`;
}

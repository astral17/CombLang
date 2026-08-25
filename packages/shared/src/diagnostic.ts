import type { SourceSpan } from './span.js';

export type DiagnosticSeverity = 'error' | 'warning' | 'info';

export interface DiagnosticRelatedInformation {
  readonly message: string;
  readonly span: SourceSpan;
}

export interface Diagnostic {
  readonly code: string;
  readonly severity: DiagnosticSeverity;
  readonly message: string;
  readonly span?: SourceSpan;
  readonly related?: readonly DiagnosticRelatedInformation[];
}

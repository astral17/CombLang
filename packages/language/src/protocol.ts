import type { Diagnostic, SourceFileId } from '@comblang/shared';

import type { SourceFileSnapshot, SyntaxNodeSummary } from './parser.js';
import type { SemanticSummary } from './semantic.js';

export interface ParseWorkerRequest {
  readonly kind: 'parse';
  readonly revision: number;
  readonly file: SourceFileSnapshot;
}

export interface ParseWorkerResult {
  readonly fileId: SourceFileId;
  readonly diagnostics: readonly Diagnostic[];
  readonly topLevel: readonly SyntaxNodeSummary[];
  readonly semantics: readonly SemanticSummary[];
}

export interface ParseWorkerResponse {
  readonly kind: 'parsed';
  readonly revision: number;
  readonly result: ParseWorkerResult;
}

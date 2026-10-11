import { offsetToPosition, type SourceSpan } from '@comblang/shared';
import type { CanonicalBlueprintSourceImportResult } from '@comblang/runtime/blueprint-source-import';
import type {
  CompilerWorkerBlueprintImportDiagnostic,
  CompilerWorkerBlueprintImportResult,
  CompilerWorkerImportRequest,
  CompilerWorkerImportedResponse,
} from './worker-protocol.js';

export class CompilerWorkerBlueprintImportRequestError extends TypeError {
  readonly code = 'WP1009';

  constructor(
    readonly path: string,
    message: string,
  ) {
    super(`${path}: ${message}`);
    this.name = 'CompilerWorkerBlueprintImportRequestError';
  }
}

function plainRecord(value: unknown, path: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new CompilerWorkerBlueprintImportRequestError(path, 'expected an object.');
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new CompilerWorkerBlueprintImportRequestError(path, 'expected a plain object.');
  }
  return value as Record<string, unknown>;
}

function ownDataValue(
  record: Record<string, unknown>,
  key: string,
  path: string,
  required = true,
): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(record, key);
  if (descriptor === undefined) {
    if (required) throw new CompilerWorkerBlueprintImportRequestError(path, 'is required.');
    return undefined;
  }
  if (!('value' in descriptor) || !descriptor.enumerable) {
    throw new CompilerWorkerBlueprintImportRequestError(
      path,
      'expected an enumerable data property.',
    );
  }
  return descriptor.value;
}

/** A safe correlation fallback for a malformed request, which still needs one terminal reply. */
export function blueprintImportResponseRevision(value: unknown): number {
  if (value === null || typeof value !== 'object') return 0;
  const descriptor = Object.getOwnPropertyDescriptor(value, 'revision');
  const revision = descriptor !== undefined && 'value' in descriptor ? descriptor.value : undefined;
  return typeof revision === 'number' && Number.isSafeInteger(revision) && revision >= 0
    ? revision
    : 0;
}

export function readCompilerWorkerImportRequest(value: unknown): CompilerWorkerImportRequest {
  const request = plainRecord(value, '$');
  if (ownDataValue(request, 'kind', '$.kind') !== 'import-blueprint') {
    throw new CompilerWorkerBlueprintImportRequestError('$.kind', 'expected import-blueprint.');
  }

  const revision = ownDataValue(request, 'revision', '$.revision');
  if (typeof revision !== 'number' || !Number.isSafeInteger(revision) || revision < 0) {
    throw new CompilerWorkerBlueprintImportRequestError(
      '$.revision',
      'expected a nonnegative safe integer.',
    );
  }

  const document = plainRecord(ownDataValue(request, 'document', '$.document'), '$.document');
  const text = ownDataValue(document, 'text', '$.document.text');
  if (typeof text !== 'string') {
    throw new CompilerWorkerBlueprintImportRequestError('$.document.text', 'expected a string.');
  }

  const sourcePath = ownDataValue(request, 'sourcePath', '$.sourcePath');
  if (
    typeof sourcePath !== 'string' ||
    sourcePath.trim().length === 0 ||
    sourcePath.includes('\0')
  ) {
    throw new CompilerWorkerBlueprintImportRequestError(
      '$.sourcePath',
      'expected a nonempty path string without NUL.',
    );
  }

  const prototypeProfile = ownDataValue(request, 'prototypeProfile', '$.prototypeProfile', false);
  const entityReplayContext = ownDataValue(
    request,
    'entityReplayContext',
    '$.entityReplayContext',
    false,
  );
  return {
    kind: 'import-blueprint',
    revision,
    document: { text },
    sourcePath,
    ...(prototypeProfile === undefined ? {} : { prototypeProfile }),
    ...(entityReplayContext === undefined ? {} : { entityReplayContext }),
  } as CompilerWorkerImportRequest;
}

function sourceSpan(value: unknown): SourceSpan | undefined {
  if (value === null || typeof value !== 'object') return undefined;
  const candidate = value as Partial<SourceSpan>;
  if (
    typeof candidate.fileId !== 'string' ||
    typeof candidate.start !== 'number' ||
    typeof candidate.end !== 'number'
  ) {
    return undefined;
  }
  return candidate as SourceSpan;
}

function generatedLocation(
  diagnostic: CompilerWorkerBlueprintImportDiagnostic,
  context: NonNullable<
    Extract<CanonicalBlueprintSourceImportResult, { state: 'blocked' }>['diagnosticContext']
  >,
) {
  const diagnosticRecord = diagnostic as CompilerWorkerBlueprintImportDiagnostic & {
    readonly span?: unknown;
    readonly source?: unknown;
  };
  const span = sourceSpan(diagnosticRecord.source) ?? sourceSpan(diagnosticRecord.span);
  if (span === undefined || span.fileId !== context.fileId) return undefined;
  try {
    const start = offsetToPosition(context.text, span.start);
    const end = offsetToPosition(context.text, span.end);
    return Object.freeze({
      path: context.path,
      start: Object.freeze({ line: start.line + 1, column: start.column + 1 }),
      end: Object.freeze({ line: end.line + 1, column: end.column + 1 }),
    });
  } catch {
    return undefined;
  }
}

export function projectBlueprintImportResult(
  result: CanonicalBlueprintSourceImportResult,
): CompilerWorkerBlueprintImportResult {
  const diagnostics = result.diagnostics.map((diagnostic) => {
    const location =
      result.diagnosticContext === undefined
        ? undefined
        : generatedLocation(diagnostic, result.diagnosticContext);
    return Object.freeze({
      ...diagnostic,
      ...(location === undefined ? {} : { generatedLocation: location }),
    });
  });

  return result.state === 'verified'
    ? Object.freeze({
        state: 'verified',
        source: result.source,
        correspondence: result.correspondence,
        diagnostics: Object.freeze(diagnostics),
        verification: result.verification,
      })
    : Object.freeze({
        state: 'blocked',
        diagnostics: Object.freeze(diagnostics),
      });
}

export function blockedBlueprintImportResponse(
  revision: number,
  code: string,
  message: string,
  path?: string,
): CompilerWorkerImportedResponse {
  const error = Object.freeze({ code, message, ...(path === undefined ? {} : { path }) });
  return Object.freeze({
    kind: 'blueprint-imported',
    revision,
    result: Object.freeze({
      state: 'blocked',
      diagnostics: Object.freeze([Object.freeze({ code, severity: 'error' as const, message })]),
      error,
    }),
  });
}

export function rejectedBlueprintImportResponse(
  revision: number,
  error: unknown,
): CompilerWorkerImportedResponse {
  const message =
    error instanceof Error && error.message.length > 0
      ? error.message
      : 'Unexpected Worker import failure.';
  return blockedBlueprintImportResponse(revision, 'WP1010', message);
}

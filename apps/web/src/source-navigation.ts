import type { SourceFileId, SourceSpan } from '@comblang/shared';

export interface SourceRange {
  readonly start: number;
  readonly end: number;
}

/** Navigation must not silently redirect foreign or stale provenance to another line. */
export function sourceNavigationRange(
  text: string,
  fileId: SourceFileId,
  span: SourceSpan,
): SourceRange | undefined {
  if (
    span.fileId !== fileId ||
    !Number.isSafeInteger(span.start) ||
    !Number.isSafeInteger(span.end) ||
    span.start < 0 ||
    span.end < span.start ||
    span.end > text.length
  )
    return undefined;
  return { start: span.start, end: span.end };
}

/** Test stacks use one-based line/column; missing columns select the whole line. */
export function testFailureRange(
  text: string,
  line: number,
  column?: number,
): SourceRange | undefined {
  const lines = text.split('\n');
  if (!Number.isSafeInteger(line) || line < 1 || line > lines.length) return undefined;
  const content = lines[line - 1]!.replace(/\r$/, '');
  const start = lines.slice(0, line - 1).reduce((offset, part) => offset + part.length + 1, 0);
  if (column === undefined) return { start, end: start + content.length };
  if (!Number.isSafeInteger(column) || column < 1 || column > content.length + 1) return undefined;
  const offset = start + column - 1;
  return { start: offset, end: Math.min(offset + 1, start + content.length) };
}

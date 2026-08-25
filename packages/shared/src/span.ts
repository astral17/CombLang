import type { SourceFileId } from './ids.js';

export interface SourcePosition {
  readonly line: number;
  readonly column: number;
  readonly offset: number;
}

export interface SourceSpan {
  readonly fileId: SourceFileId;
  readonly start: number;
  readonly end: number;
}

export function sourceSpan(fileId: SourceFileId, start: number, end: number): SourceSpan {
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start) {
    throw new RangeError(`Invalid half-open source span [${start}, ${end}).`);
  }

  return { fileId, start, end };
}

export function offsetToPosition(text: string, offset: number): SourcePosition {
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > text.length) {
    throw new RangeError(`Offset ${offset} is outside the source file.`);
  }

  let line = 0;
  let lineStart = 0;
  for (let index = 0; index < offset; index += 1) {
    if (text.charCodeAt(index) === 10) {
      line += 1;
      lineStart = index + 1;
    }
  }

  return { line, column: offset - lineStart, offset };
}

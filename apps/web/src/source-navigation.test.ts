import { sourceFileId } from '@comblang/shared';
import { describe, expect, test } from 'vitest';

import { sourceNavigationRange, testFailureRange } from './source-navigation.js';

describe('read-only source navigation', () => {
  test('keeps exact source offsets and refuses foreign, stale and malformed spans', () => {
    const fileId = sourceFileId('main.factorio.ts');
    expect(sourceNavigationRange('abc\ndef', fileId, { fileId, start: 4, end: 7 })).toEqual({
      start: 4,
      end: 7,
    });
    for (const span of [
      { fileId: sourceFileId('other.ts'), start: 0, end: 1 },
      { fileId, start: 2, end: 8 },
      { fileId, start: -1, end: 2 },
      { fileId, start: 2, end: 1 },
      { fileId, start: NaN, end: 1 },
    ])
      expect(sourceNavigationRange('abc\ndef', fileId, span)).toBeUndefined();
  });

  test('maps one-based stack lines and columns across CRLF without selecting the wrong line', () => {
    expect(testFailureRange('abc\r\ndef\r\n', 2, 2)).toEqual({ start: 6, end: 7 });
    expect(testFailureRange('abc\r\ndef\r\n', 2)).toEqual({ start: 5, end: 8 });
    expect(testFailureRange('abc\r\ndef\r\n', 3, 1)).toEqual({ start: 10, end: 10 });
    expect(testFailureRange('abc', 2)).toBeUndefined();
    expect(testFailureRange('abc', 1, 5)).toBeUndefined();
    expect(testFailureRange('abc', NaN)).toBeUndefined();
    expect(testFailureRange('abc', 1, 0)).toBeUndefined();
  });
});

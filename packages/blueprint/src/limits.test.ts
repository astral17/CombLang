import { describe, expect, test } from 'vitest';

import { DEFAULT_BLUEPRINT_CODEC_LIMITS, resolveBlueprintCodecLimits } from './limits.js';

describe('blueprint codec limits', () => {
  test('publishes immutable positive defaults for every resource boundary', () => {
    expect(Object.isFrozen(DEFAULT_BLUEPRINT_CODEC_LIMITS)).toBe(true);
    expect(Object.values(DEFAULT_BLUEPRINT_CODEC_LIMITS).every((value) => value > 0)).toBe(true);
    expect(Object.keys(DEFAULT_BLUEPRINT_CODEC_LIMITS)).toEqual([
      'maxEncodedCharacters',
      'maxCompressedBytes',
      'maxDecompressedBytes',
      'maxJsonDepth',
      'maxJsonNodes',
      'maxStringBytes',
      'maxEmittedBytes',
    ]);
  });

  test('applies partial caller overrides and freezes the resolved copy', () => {
    const overrides = { maxJsonDepth: 16 };
    const resolved = resolveBlueprintCodecLimits(overrides);

    expect(resolved).toEqual({ ...DEFAULT_BLUEPRINT_CODEC_LIMITS, maxJsonDepth: 16 });
    expect(resolved).not.toBe(overrides);
    expect(Object.isFrozen(resolved)).toBe(true);
  });

  test.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])(
    'rejects invalid limit value %s',
    (value) => {
      expect(() => resolveBlueprintCodecLimits({ maxJsonNodes: value })).toThrow(
        'must be a positive safe integer',
      );
    },
  );

  test('rejects malformed overrides and misspelled budget names', () => {
    expect(() => resolveBlueprintCodecLimits(null as never)).toThrow('plain object');
    expect(() => resolveBlueprintCodecLimits({ maxJsonNode: 10 } as never)).toThrow(
      'Unknown blueprint codec limit: maxJsonNode.',
    );
    expect(() =>
      resolveBlueprintCodecLimits(
        Object.defineProperty({}, 'maxJsonDepth', { enumerable: true, get: () => 10 }) as never,
      ),
    ).toThrow('must be a data property');
  });
});

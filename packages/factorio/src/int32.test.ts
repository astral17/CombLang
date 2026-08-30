import { describe, expect, test } from 'vitest';

import { circuitConstant } from './int32.js';

describe('circuit configuration integer boundary', () => {
  test('canonicalizes finite safe integers to signed int32', () => {
    expect(circuitConstant(0)).toBe(0);
    expect(circuitConstant(2_147_483_648)).toBe(-2_147_483_648);
    expect(circuitConstant(4_294_967_295)).toBe(-1);
  });

  test.each([1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])(
    'rejects %s before normalization',
    (value) => {
      expect(() => circuitConstant(value)).toThrow(/safe integers/);
    },
  );
});

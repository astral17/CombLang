import { describe, expect, test } from 'vitest';
import type { SourceFileId, SourceSpan } from '@comblang/shared';
import { BlueprintParameterError } from './blueprint-parameters.js';
import {
  freezeConfigurationData,
  freezeConfigurationDataSkippingFrozen,
  prefixExpressionError,
} from './blueprint-configuration-utils.js';

describe('configuration data freeze policies', () => {
  test('skips children of an already-frozen parent without changing its identity', () => {
    const child = {};
    const parent = Object.freeze({ child });
    expect(freezeConfigurationDataSkippingFrozen(parent)).toBe(parent);
    expect(parent.child).toBe(child);
    expect(Object.isFrozen(child)).toBe(false);
  });

  test('traverses children of an already-frozen parent without changing its identity', () => {
    const child = {};
    const parent = Object.freeze({ child });
    expect(freezeConfigurationData(parent)).toBe(parent);
    expect(parent.child).toBe(child);
    expect(Object.isFrozen(child)).toBe(true);
  });

  describe.each([
    ['skip frozen', freezeConfigurationDataSkippingFrozen],
    ['traverse frozen', freezeConfigurationData],
  ] as const)('%s', (_name, freeze) => {
    test('freezes newly constructed nested records and arrays in place', () => {
      const child = { value: 1 };
      const rows = [child];
      const parent = { rows };
      expect(freeze(parent)).toBe(parent);
      expect(parent.rows).toBe(rows);
      expect(parent.rows[0]).toBe(child);
      expect([parent, rows, child].every(Object.isFrozen)).toBe(true);
    });

    test('returns primitives unchanged', () => {
      for (const value of [null, undefined, false, 0, 'value']) expect(freeze(value)).toBe(value);
    });
  });
});

describe('configuration expression error paths', () => {
  const source: SourceSpan = {
    fileId: 'configuration-utils.test.ts' as SourceFileId,
    start: 2,
    end: 5,
  };

  test.each([
    ['$', '', 'CP1000'],
    ['$.value', '', 'CP1001'],
    ['$.operands[1].value', '.operands[1].value', 'CP1002'],
    ['operands[1]', '.operands[1]', 'CP1000'],
  ] as const)('prefixes %s while preserving code, message and span', (path, suffix, code) => {
    const error = new BlueprintParameterError(code, path, 'invalid expression', source);
    expect(() => prefixExpressionError(error, '$.left.value')).toThrowError(
      expect.objectContaining({
        code,
        path: `$.left.value${suffix}`,
        message: `$.left.value${suffix}: invalid expression`,
        span: source,
      }),
    );
    expect(error.path).toBe(path);
    expect(error.message).toBe(`${path}: invalid expression`);
  });

  test('retains a message without the original path prefix and an absent span', () => {
    const error = new BlueprintParameterError('CP1000', '$.value', 'invalid expression');
    error.message = 'unprefixed detail';
    expect(() => prefixExpressionError(error, '$.output.value')).toThrowError(
      expect.objectContaining({
        code: 'CP1000',
        path: '$.output.value',
        message: '$.output.value: unprefixed detail',
        span: undefined,
      }),
    );
  });

  test.each([new Error('ordinary failure'), { detail: 'non-Error failure' }])(
    'rethrows a non-Blueprint exception unchanged: %j',
    (error) => {
      let caught: unknown = Symbol('not thrown');
      try {
        prefixExpressionError(error, '$.left.value');
      } catch (failure) {
        caught = failure;
      }
      expect(caught).toBe(error);
    },
  );
});

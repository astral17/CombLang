import type { SourceFileId } from '@comblang/shared';
import { describe, expect, test, vi } from 'vitest';

import type { CombinatorValue } from './elaboration-values.js';
import {
  bindCombinatorHandle,
  type CombinatorHandlePolicyContext,
} from './combinator-handle-policy.js';

const source = { fileId: 'file:combinator-handle.ts' as SourceFileId, start: 10, end: 20 };
const producer: CombinatorValue = {
  kind: 'combinator',
  identity: {},
};

function context(bindName = vi.fn()): CombinatorHandlePolicyContext {
  return {
    isCombinator: (value): value is CombinatorValue => value === producer,
    kindOf: () => 'arithmetic',
    bindName,
  };
}

describe('Combinator handle policy', () => {
  test.each(['Combinator', 'Producer', 'ArithmeticCombinator'])(
    'accepts %s without replacing an unbound handle',
    (expectedType) => {
      const policy = context();

      expect(bindCombinatorHandle(producer, expectedType, undefined, source, policy)).toBe(
        producer,
      );
      expect(policy.bindName).not.toHaveBeenCalled();
    },
  );

  test('adds a binding name to central physical state without replacing the handle', () => {
    const bindName = vi.fn();

    const bound = bindCombinatorHandle(
      producer,
      'ArithmeticCombinator',
      'sum',
      source,
      context(bindName),
    );

    expect(bound).toBe(producer);
    expect(bindName).toHaveBeenCalledWith(producer, 'sum');
  });

  test.each([
    { value: producer, expectedType: 'DeciderCombinator', expected: 'a decider combinator' },
    { value: 42, expectedType: 'Producer', expected: 'a combinator' },
  ])('rejects a mismatched $expectedType with RT2022', ({ value, expectedType, expected }) => {
    expect(() =>
      bindCombinatorHandle(value, expectedType, undefined, source, context()),
    ).toThrowError(
      expect.objectContaining({
        code: 'RT2022',
        span: source,
        message: expect.stringContaining(expected),
      }),
    );
  });

  test('rejects invalid transform metadata without misclassifying it as a type mismatch', () => {
    expect(() => bindCombinatorHandle(producer, 'Unknown', undefined, source, context())).toThrow(
      'Unknown Combinator handle annotation.',
    );
    expect(() => bindCombinatorHandle(producer, 'Producer', 1, source, context())).toThrow(
      'Combinator binding name must be a string.',
    );
  });
});

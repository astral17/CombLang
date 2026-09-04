import type { SourceFileId } from '@comblang/shared';
import { describe, expect, test, vi } from 'vitest';

import type { ProducerValue } from './elaboration-values.js';
import { bindProducerHandle, type ProducerHandlePolicyContext } from './producer-handle-policy.js';

const source = { fileId: 'file:handle.ts' as SourceFileId, start: 10, end: 20 };
const producer: ProducerValue = {
  kind: 'producer',
  identity: {},
  producer: {
    kind: 'arithmetic',
    left: { kind: 'constant', value: 1 },
    operation: 'add',
    right: { kind: 'constant', value: 2 },
    output: { kind: 'each' },
    source,
    instancePath: [],
  },
};

function context(brand = vi.fn((value: ProducerValue) => value)): ProducerHandlePolicyContext {
  return {
    isProducer: (value): value is ProducerValue => value === producer,
    brand,
  };
}

describe('Producer handle policy', () => {
  test.each(['Producer', 'ArithmeticCombinator'])(
    'accepts %s without replacing an unbound handle',
    (expectedType) => {
      const policy = context();

      expect(bindProducerHandle(producer, expectedType, undefined, source, policy)).toBe(producer);
      expect(policy.brand).not.toHaveBeenCalled();
    },
  );

  test('adds a binding name through a wrapper with the same physical identity', () => {
    const brand = vi.fn((value: ProducerValue) => value);

    const bound = bindProducerHandle(
      producer,
      'ArithmeticCombinator',
      'sum',
      source,
      context(brand),
    );

    expect(bound).not.toBe(producer);
    expect(bound.identity).toBe(producer.identity);
    expect(bound.producer.bindingName).toBe('sum');
    expect(brand).toHaveBeenCalledWith(bound);
  });

  test.each([
    { value: producer, expectedType: 'DeciderCombinator', expected: 'a decider combinator' },
    { value: 42, expectedType: 'Producer', expected: 'a combinator producer' },
  ])('rejects a mismatched $expectedType with RT2022', ({ value, expectedType, expected }) => {
    expect(() =>
      bindProducerHandle(value, expectedType, undefined, source, context()),
    ).toThrowError(
      expect.objectContaining({
        code: 'RT2022',
        span: source,
        message: expect.stringContaining(expected),
      }),
    );
  });

  test('rejects invalid transform metadata without misclassifying it as a type mismatch', () => {
    expect(() => bindProducerHandle(producer, 'Unknown', undefined, source, context())).toThrow(
      'Unknown Producer handle annotation.',
    );
    expect(() => bindProducerHandle(producer, 'Producer', 1, source, context())).toThrow(
      'Producer binding name must be a string.',
    );
  });
});

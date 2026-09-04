import type { SourceSpan } from '@comblang/shared';

import { ElaborationExecutionError } from './elaboration-errors.js';
import type { ProducerValue } from './elaboration-values.js';

export interface ProducerHandlePolicyContext {
  isProducer(value: unknown): value is ProducerValue;
  brand(value: ProducerValue): ProducerValue;
}

const expectedProducerKinds = {
  Producer: undefined,
  DeciderCombinator: 'decider',
  ArithmeticCombinator: 'arithmetic',
  ConstantCombinator: 'constant',
} as const;

/** Validates a source Producer annotation and optionally adds its debug binding name. */
export function bindProducerHandle(
  value: unknown,
  expectedType: unknown,
  bindingName: unknown,
  source: SourceSpan,
  context: ProducerHandlePolicyContext,
): ProducerValue {
  if (typeof expectedType !== 'string' || !(expectedType in expectedProducerKinds)) {
    throw new Error('Unknown Producer handle annotation.');
  }
  const expectedKind = expectedProducerKinds[expectedType as keyof typeof expectedProducerKinds];
  if (
    !context.isProducer(value) ||
    (expectedKind !== undefined && value.producer.kind !== expectedKind)
  ) {
    throw new ElaborationExecutionError(
      `${expectedType} requires ${expectedKind === undefined ? 'a combinator producer' : `a ${expectedKind} combinator producer`}.`,
      source,
      'RT2022',
    );
  }
  if (bindingName !== undefined && typeof bindingName !== 'string') {
    throw new Error('Producer binding name must be a string.');
  }
  return bindingName === undefined
    ? value
    : context.brand({
        kind: 'producer',
        identity: value.identity,
        producer: { ...value.producer, bindingName },
      });
}

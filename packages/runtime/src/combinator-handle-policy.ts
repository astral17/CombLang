import type { SourceSpan } from '@comblang/shared';

import { ElaborationExecutionError } from './elaboration-errors.js';
import type { CombinatorValue } from './elaboration-values.js';

export interface CombinatorHandlePolicyContext {
  isCombinator(value: unknown): value is CombinatorValue;
  kindOf(value: CombinatorValue): 'arithmetic' | 'decider' | 'constant';
  bindName(value: CombinatorValue, name: string): void;
}

const expectedCombinatorKinds = {
  Combinator: undefined,
  Producer: undefined,
  DeciderCombinator: 'decider',
  ArithmeticCombinator: 'arithmetic',
  ConstantCombinator: 'constant',
} as const;

/** Validates a source Combinator annotation and optionally adds its debug binding name. */
export function bindCombinatorHandle(
  value: unknown,
  expectedType: unknown,
  bindingName: unknown,
  source: SourceSpan,
  context: CombinatorHandlePolicyContext,
): CombinatorValue {
  if (typeof expectedType !== 'string' || !(expectedType in expectedCombinatorKinds)) {
    throw new Error('Unknown Combinator handle annotation.');
  }
  const expectedKind =
    expectedCombinatorKinds[expectedType as keyof typeof expectedCombinatorKinds];
  if (
    !context.isCombinator(value) ||
    (expectedKind !== undefined && context.kindOf(value) !== expectedKind)
  ) {
    throw new ElaborationExecutionError(
      `${expectedType} requires ${expectedKind === undefined ? 'a combinator' : `a ${expectedKind} combinator`}.`,
      source,
      'RT2022',
    );
  }
  if (bindingName !== undefined && typeof bindingName !== 'string') {
    throw new Error('Combinator binding name must be a string.');
  }
  if (bindingName !== undefined) context.bindName(value, bindingName);
  return value;
}

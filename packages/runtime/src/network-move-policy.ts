import type { SourceSpan } from '@comblang/shared';

import { ElaborationExecutionError } from './elaboration-errors.js';
import type { CombinatorValue, NetworkValue } from './elaboration-values.js';

export interface CombinatorMovePolicyContext {
  lanes(value: CombinatorValue): readonly NetworkValue[];
  ensureSecondary(value: CombinatorValue): NetworkValue;
  assertConsumable(network: NetworkValue, source: SourceSpan): void;
  exhausted(value: CombinatorValue, source: SourceSpan): never;
}

function availableLanes(
  value: CombinatorValue,
  source: SourceSpan,
  context: CombinatorMovePolicyContext,
): readonly NetworkValue[] {
  return context.lanes(value).filter((network) => {
    try {
      context.assertConsumable(network, source);
      return true;
    } catch (error) {
      if (error instanceof ElaborationExecutionError) return false;
      throw error;
    }
  });
}

/** Selects caller-usable output lanes without mutating ownership or topology. */
export function selectCombinatorMoveLanes(
  value: CombinatorValue,
  count: number,
  source: SourceSpan,
  context: CombinatorMovePolicyContext,
): readonly NetworkValue[] {
  let available = availableLanes(value, source, context);
  if (available.length < count && context.lanes(value).length < 2) {
    context.ensureSecondary(value);
    available = availableLanes(value, source, context);
  }
  if (available.length < count) return context.exhausted(value, source);
  return available.slice(0, count);
}

/** Acquires one next-available output lane for a Move<Network> boundary. */
export function selectCombinatorMoveNetwork(
  value: CombinatorValue,
  source: SourceSpan,
  context: CombinatorMovePolicyContext,
): NetworkValue {
  return selectCombinatorMoveLanes(value, 1, source, context)[0]!;
}

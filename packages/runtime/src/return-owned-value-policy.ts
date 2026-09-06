import type { SourceSpan } from '@comblang/shared';

import { ElaborationExecutionError } from './elaboration-errors.js';
import type {
  NetworkOwnershipState,
  NetworkValue,
  PairSelectedValue,
  PairValue,
  CombinatorValue,
} from './elaboration-values.js';
import { inspectReturnValueGraph } from './return-value-graph.js';

export interface ReturnOwnedValuePolicyContext {
  isCombinator(value: unknown): value is CombinatorValue;
  isNetwork(value: unknown): value is NetworkValue;
  isPair(value: unknown): value is PairValue;
  isPairSelection(value: unknown): value is PairSelectedValue;
  assertReturnable(network: NetworkValue): void;
  ownershipOf(network: NetworkValue): NetworkOwnershipState;
  combinatorNetworks(value: CombinatorValue): readonly NetworkValue[];
  normalizeCombinator(value: CombinatorValue): CombinatorValue;
  isConsumed(network: NetworkValue): boolean;
  isOwnedByReturnFrame(network: NetworkValue): boolean;
  updateCombinatorNetwork(
    combinator: CombinatorValue,
    original: NetworkValue,
    returned: NetworkValue,
  ): void;
  chargeTransfer(network: NetworkValue): void;
  returnNetwork(network: NetworkValue): NetworkValue;
}

/** Validates and atomically replaces every owned Network in a returned JS value graph. */
export function returnOwnedValue(
  value: unknown,
  source: SourceSpan,
  context: ReturnOwnedValuePolicyContext,
): unknown {
  const graph = inspectReturnValueGraph(
    value,
    (item) =>
      context.isCombinator(item) ||
      context.isNetwork(item) ||
      context.isPair(item) ||
      context.isPairSelection(item),
  );
  const networks: NetworkValue[] = [];
  const owners = new Set<NetworkOwnershipState>();
  const combinatorLanes = new Map<NetworkValue, CombinatorValue>();
  const combinatorReplacements = new Map<object, CombinatorValue>();
  const seenCombinators = new Set<object>();
  const addNetwork = (network: NetworkValue, combinator?: CombinatorValue): void => {
    context.assertReturnable(network);
    const owner = context.ownershipOf(network);
    if (owners.has(owner)) {
      throw new ElaborationExecutionError(
        `Cannot return Network ${network.name} more than once; duplicated members are a double move.`,
        source,
        'RT2012',
        [{ message: 'Network declared here.', span: network.declaration }],
      );
    }
    owners.add(owner);
    networks.push(network);
    if (combinator !== undefined) combinatorLanes.set(network, combinator);
  };
  for (const handle of graph.handles) {
    if (context.isPair(handle) || context.isPairSelection(handle)) {
      throw new ElaborationExecutionError(
        'pair(a, b) is a read-only input view and cannot carry ownership across a return.',
        source,
        'RT2020',
        context.isPair(handle)
          ? [{ message: 'The pair view was created here.', span: handle.source }]
          : undefined,
      );
    }
    if (context.isCombinator(handle)) {
      if (seenCombinators.has(handle.identity)) continue;
      seenCombinators.add(handle.identity);
      const normalized = context.normalizeCombinator(handle);
      if (normalized !== handle) combinatorReplacements.set(handle, normalized);
      for (const network of context.combinatorNetworks(handle)) {
        if (!context.isConsumed(network) && context.isOwnedByReturnFrame(network)) {
          addNetwork(network, normalized);
        }
      }
      continue;
    }
    if (context.isNetwork(handle)) addNetwork(handle);
  }

  // Charge every transfer before the first ownership mutation. A caught budget
  // failure therefore cannot expose a partially moved return container.
  for (const network of networks) context.chargeTransfer(network);
  const replacements = new Map<object, unknown>(combinatorReplacements);
  for (const network of networks) {
    const returned = context.returnNetwork(network);
    const combinator = combinatorLanes.get(network);
    if (combinator === undefined) replacements.set(network, returned);
    else context.updateCombinatorNetwork(combinator, network, returned);
  }
  return graph.replace(replacements);
}

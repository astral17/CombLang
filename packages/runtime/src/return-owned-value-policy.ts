import type { SourceSpan } from '@comblang/shared';

import { ElaborationExecutionError } from './elaboration-errors.js';
import type {
  NetworkOwnershipState,
  NetworkValue,
  PairSelectedValue,
  PairValue,
  ProducerValue,
} from './elaboration-values.js';
import { inspectReturnValueGraph } from './return-value-graph.js';

export interface ReturnOwnedValuePolicyContext {
  isProducer(value: unknown): value is ProducerValue;
  isNetwork(value: unknown): value is NetworkValue;
  isPair(value: unknown): value is PairValue;
  isPairSelection(value: unknown): value is PairSelectedValue;
  assertReturnable(network: NetworkValue): void;
  ownershipOf(network: NetworkValue): NetworkOwnershipState;
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
      context.isProducer(item) ||
      context.isNetwork(item) ||
      context.isPair(item) ||
      context.isPairSelection(item),
  );
  const networks: NetworkValue[] = [];
  const owners = new Set<NetworkOwnershipState>();
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
    if (!context.isNetwork(handle)) continue;
    context.assertReturnable(handle);
    const owner = context.ownershipOf(handle);
    if (owners.has(owner)) {
      throw new ElaborationExecutionError(
        `Cannot return Network ${handle.name} more than once; duplicated members are a double move.`,
        source,
        'RT2012',
        [{ message: 'Network declared here.', span: handle.declaration }],
      );
    }
    owners.add(owner);
    networks.push(handle);
  }

  // Charge every transfer before the first ownership mutation. A caught budget
  // failure therefore cannot expose a partially moved return container.
  for (const network of networks) context.chargeTransfer(network);
  const replacements = new Map<object, unknown>();
  for (const network of networks) replacements.set(network, context.returnNetwork(network));
  return graph.replace(replacements);
}

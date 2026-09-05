import type { NetworkId } from '@comblang/shared';

import type { CircuitProducerNode, LogicalDeciderCondition, LogicalNetworkRef } from './ir.js';

function conditionInputReferences(
  condition: LogicalDeciderCondition,
  result: LogicalNetworkRef[],
): void {
  if (condition.kind === 'and' || condition.kind === 'or') {
    for (const child of condition.conditions) conditionInputReferences(child, result);
    return;
  }
  result.push(condition.left);
  if (condition.right.kind === 'signal') result.push(condition.right);
}

/**
 * Returns every semantic input reference in descriptor order. Repeated output rows remain
 * repeated so configuration consumers can preserve physical row multiplicity.
 */
export function producerInputNetworkReferences(
  producer: CircuitProducerNode,
): readonly LogicalNetworkRef[] {
  const result: LogicalNetworkRef[] = [];
  if (producer.kind === 'arithmetic') {
    if (producer.config.left.kind !== 'constant') result.push(producer.config.left);
    if (producer.config.right.kind !== 'constant') result.push(producer.config.right);
  } else if (producer.kind === 'decider') {
    conditionInputReferences(producer.config.condition, result);
    for (const output of producer.config.outputs) {
      if (output.input !== undefined) result.push(output.input);
    }
    for (const output of producer.config.elseOutputs ?? []) {
      if (output.input !== undefined) result.push(output.input);
    }
  }
  return Object.freeze(result);
}

/** Distinct physical Network IDs in first-reference order for topology consumers. */
export function producerInputNetworkIds(producer: CircuitProducerNode): readonly NetworkId[] {
  const result = new Set<NetworkId>();
  for (const reference of producerInputNetworkReferences(producer)) {
    if (reference.refKind === 'single') result.add(reference.network);
    else for (const network of reference.networks) result.add(network);
  }
  return Object.freeze([...result]);
}

import type { SourceSpan } from '@comblang/shared';

import { ElaborationExecutionError } from './elaboration-errors.js';
import type { NetworkRuntimeState, NetworkValue, ProducerValue } from './elaboration-values.js';

export type NetworkReturnCapability = 'owned' | 'readonly';

export interface NetworkReturnDescriptor {
  readonly capability: NetworkReturnCapability;
  readonly fixedColor?: 'red' | 'green';
  readonly source: SourceSpan;
}

export interface NetworkReturnPolicyContext {
  isProducer(value: unknown): value is ProducerValue;
  isNetwork(value: unknown): value is NetworkValue;
  materializeProducer(
    producer: ProducerValue,
    fixedColor: 'red' | 'green' | undefined,
  ): NetworkValue;
  requireColor(
    network: NetworkValue,
    capability: 'readonly' | 'move',
    color: 'red' | 'green',
    source: SourceSpan,
  ): void;
  transferToCaller(network: NetworkValue): NetworkValue;
  stateFor(network: NetworkValue): NetworkRuntimeState;
  brandNetwork(value: NetworkValue, state: NetworkRuntimeState): NetworkValue;
}

/** Materializes and transfers one explicitly typed Network function return. */
export function returnNetworkValue(
  value: unknown,
  descriptor: NetworkReturnDescriptor,
  context: NetworkReturnPolicyContext,
): NetworkValue {
  let network: NetworkValue;
  if (context.isProducer(value)) {
    network = context.materializeProducer(value, descriptor.fixedColor);
  } else if (context.isNetwork(value)) {
    network = value;
    if (descriptor.fixedColor !== undefined) {
      context.requireColor(
        network,
        descriptor.capability === 'readonly' ? 'readonly' : 'move',
        descriptor.fixedColor,
        descriptor.source,
      );
    }
  } else {
    throw new ElaborationExecutionError(
      'A function declared to return Network must return a Network or a combinator expression.',
      descriptor.source,
      'RT2022',
    );
  }

  const returned = context.transferToCaller(network);
  if (descriptor.capability === 'owned') return returned;
  return context.brandNetwork(
    { ...returned, capability: 'readonly' },
    { ...context.stateFor(returned) },
  );
}

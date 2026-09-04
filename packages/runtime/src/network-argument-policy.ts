import type { SourceSpan } from '@comblang/shared';

import { ElaborationExecutionError } from './elaboration-errors.js';
import type {
  NetworkRuntimeState,
  NetworkValue,
  ProducerValue,
  RuntimeNetworkCapability,
} from './elaboration-values.js';

export interface NetworkArgumentDescriptor {
  readonly functionName: string;
  readonly parameter: string;
  readonly capability: RuntimeNetworkCapability;
  readonly fixedColor?: 'red' | 'green';
  readonly source: SourceSpan;
}

export interface NetworkArgumentPolicyContext {
  isProducer(value: unknown): value is ProducerValue;
  isNetwork(value: unknown): value is NetworkValue;
  materializeProducer(
    producer: ProducerValue,
    name: string,
    fixedColor: 'red' | 'green' | undefined,
  ): NetworkValue;
  assertReadable(network: NetworkValue, source: SourceSpan, role: string): void;
  stateFor(network: NetworkValue): NetworkRuntimeState;
  brandNetwork(value: NetworkValue, state: NetworkRuntimeState): NetworkValue;
}

function capabilityName(capability: RuntimeNetworkCapability): string {
  switch (capability) {
    case 'readonly':
      return 'Readonly<Network>';
    case 'ref':
      return 'Ref<Network>';
    case 'move':
      return 'Move<Network>';
    case 'owned':
      return 'Network';
  }
}

/** Resolves one executed call argument to an opaque, source-linked Network view. */
export function resolveNetworkArgument(
  value: unknown,
  descriptor: NetworkArgumentDescriptor,
  context: NetworkArgumentPolicyContext,
): NetworkValue {
  let network: NetworkValue;
  if (context.isProducer(value)) {
    network = context.materializeProducer(
      value,
      `$argument:${descriptor.functionName}:${descriptor.parameter}`,
      descriptor.fixedColor,
    );
  } else if (context.isNetwork(value)) {
    network = value;
  } else {
    throw new ElaborationExecutionError(
      `${capabilityName(descriptor.capability)} parameter ${descriptor.parameter} received a non-Network value.`,
      descriptor.source,
      'RT2015',
    );
  }

  context.assertReadable(network, descriptor.source, `argument ${descriptor.parameter}`);
  const state = context.stateFor(network);
  return context.brandNetwork(
    { ...network },
    {
      ownership: state.ownership,
      ...(state.borrow === undefined ? {} : { borrow: state.borrow }),
      callArgument: descriptor.source,
    },
  );
}

import type { SourceSpan } from '@comblang/shared';

import { ElaborationExecutionError } from './elaboration-errors.js';
import type {
  NetworkRuntimeState,
  NetworkValue,
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
  networkFacet(value: unknown): NetworkValue | undefined;
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
  const network = context.networkFacet(value);
  if (network === undefined) {
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

import type { SourceSpan } from '@comblang/shared';

import { ElaborationExecutionError } from './elaboration-errors.js';
import type { NetworkRuntimeState, NetworkValue } from './elaboration-values.js';

export type NetworkReturnCapability = 'owned' | 'readonly';

export interface NetworkReturnDescriptor {
  readonly capability: NetworkReturnCapability;
  readonly fixedColor?: 'red' | 'green';
  readonly source: SourceSpan;
}

export interface NetworkReturnPolicyContext {
  networkFacet(value: unknown): NetworkValue | undefined;
  requireColor(
    network: NetworkValue,
    capability: 'readonly' | 'move',
    color: 'red' | 'green',
    source: SourceSpan,
  ): void;
  transferToCaller(network: NetworkValue): NetworkValue;
  assertReadable(network: NetworkValue, source: SourceSpan): void;
  isTransparentAlias?(network: NetworkValue): boolean;
  returnTransparent?(network: NetworkValue): NetworkValue;
  stateFor(network: NetworkValue): NetworkRuntimeState;
  brandNetwork(value: NetworkValue, state: NetworkRuntimeState): NetworkValue;
}

/** Projects and transfers one explicitly typed Network function return. */
export function returnNetworkValue(
  value: unknown,
  descriptor: NetworkReturnDescriptor,
  context: NetworkReturnPolicyContext,
): NetworkValue {
  const network = context.networkFacet(value);
  if (network === undefined) {
    throw new ElaborationExecutionError(
      'A function declared to return Network must return a Network or a combinator expression.',
      descriptor.source,
      'RT2022',
    );
  }
  context.assertReadable(network, descriptor.source);
  if (descriptor.fixedColor !== undefined) {
    context.requireColor(
      network,
      descriptor.capability === 'readonly' ? 'readonly' : 'move',
      descriptor.fixedColor,
      descriptor.source,
    );
  }

  const returned =
    context.isTransparentAlias?.(network) === true
      ? (context.returnTransparent?.(network) ?? network)
      : context.transferToCaller(network);
  if (descriptor.capability === 'owned') return returned;
  return context.brandNetwork(
    { ...returned, capability: 'readonly' },
    { ...context.stateFor(returned) },
  );
}

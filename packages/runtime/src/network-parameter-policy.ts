import type { SourceSpan } from '@comblang/shared';

import { ElaborationExecutionError } from './elaboration-errors.js';
import type {
  CombinatorValue,
  FunctionOwnershipFrame,
  NetworkBorrow,
  NetworkRuntimeState,
  NetworkValue,
  PairSelectedValue,
  PairValue,
} from './elaboration-values.js';

export type NetworkParameterCapability = 'readonly' | 'ref' | 'move';

export interface NetworkParameterDescriptor {
  readonly functionName: string;
  readonly parameter: string;
  readonly capability: NetworkParameterCapability;
  readonly fixedColor?: 'red' | 'green';
  readonly source: SourceSpan;
  readonly frame: FunctionOwnershipFrame | undefined;
}

export interface NetworkParameterPolicyContext {
  networkFacet(value: unknown): NetworkValue | undefined;
  isNetwork(value: unknown): value is NetworkValue;
  isCombinator(value: unknown): value is CombinatorValue;
  selectCombinatorMove(value: CombinatorValue, source: SourceSpan): NetworkValue;
  isPair(value: unknown): value is PairValue;
  isPairSelection(value: unknown): value is PairSelectedValue;
  recordDslCall(): void;
  stateFor(network: NetworkValue): NetworkRuntimeState;
  assertReadable(network: NetworkValue, source: SourceSpan): void;
  assertConsumable(network: NetworkValue, source: SourceSpan, role: string): void;
  requireColor(
    network: NetworkValue,
    capability: NetworkParameterCapability,
    color: 'red' | 'green',
    source: SourceSpan,
  ): void;
  borrow(
    network: NetworkValue,
    capability: 'readonly' | 'ref',
    parameter: string,
    source: SourceSpan,
    frame: FunctionOwnershipFrame,
  ): NetworkBorrow;
  moveToFrame(network: NetworkValue, source: SourceSpan, frame: FunctionOwnershipFrame): void;
  brandNetwork(value: NetworkValue, state: NetworkRuntimeState): NetworkValue;
}

export interface BoundNetworkParameter {
  readonly value: NetworkValue;
  readonly provenance: SourceSpan;
}

export interface NetworkReferenceParameterDescriptor {
  readonly functionName: string;
  readonly parameter: string;
  readonly requiredType: string;
  readonly fixedColor?: 'red' | 'green';
  readonly source: SourceSpan;
}

export interface NetworkReferenceParameterPolicyContext {
  networkFacet(value: unknown): NetworkValue | undefined;
  recordDslCall(): void;
  acceptUnrestricted(network: NetworkValue): void;
  requireColor(network: NetworkValue, color: 'red' | 'green', source: SourceSpan): void;
}

function capabilityName(capability: NetworkParameterCapability): string {
  return capability === 'readonly'
    ? 'Readonly<Network>'
    : capability === 'ref'
      ? 'Ref<Network>'
      : 'Move<Network>';
}

/** Resolves a bare Network parameter without borrowing, moving, or changing ownership. */
export function bindNetworkReferenceParameter(
  value: unknown,
  descriptor: NetworkReferenceParameterDescriptor,
  context: NetworkReferenceParameterPolicyContext,
): NetworkValue {
  const network = context.networkFacet(value);
  if (network === undefined) {
    throw new ElaborationExecutionError(
      `${descriptor.requiredType} parameter ${descriptor.parameter} received a non-Network value.`,
      descriptor.source,
      'RT2015',
    );
  }
  context.recordDslCall();
  if (descriptor.fixedColor !== undefined) {
    context.requireColor(network, descriptor.fixedColor, descriptor.source);
  }
  context.acceptUnrestricted(network);
  return network;
}

/** Applies one executed borrow/move parameter boundary to an already evaluated argument. */
export function bindNetworkParameter(
  value: unknown,
  descriptor: NetworkParameterDescriptor,
  context: NetworkParameterPolicyContext,
): BoundNetworkParameter {
  if (descriptor.capability === 'move' && context.isCombinator(value)) {
    value = context.selectCombinatorMove(value, descriptor.source);
  } else {
    value = context.networkFacet(value) ?? value;
  }
  if (
    descriptor.capability === 'move' &&
    (context.isPair(value) || context.isPairSelection(value))
  ) {
    throw new ElaborationExecutionError(
      'pair(a, b) is a read-only input view and cannot transfer ownership.',
      descriptor.source,
      'RT2020',
    );
  }
  if (!context.isNetwork(value)) {
    throw new ElaborationExecutionError(
      `${capabilityName(descriptor.capability)} parameter ${descriptor.parameter} received a non-Network value.`,
      descriptor.source,
      'RT2015',
    );
  }

  context.recordDslCall();
  const state = context.stateFor(value);
  const provenance = state.callArgument ?? descriptor.source;
  const frame = descriptor.frame;

  if (descriptor.capability === 'move') {
    context.assertConsumable(value, provenance, 'source');
    if (frame === undefined) {
      throw new Error('Network ownership transfer was created outside a function frame.');
    }
    if (descriptor.fixedColor !== undefined) {
      context.requireColor(value, 'move', descriptor.fixedColor, provenance);
    }
    context.moveToFrame(value, provenance, frame);
    return {
      value: context.brandNetwork(
        {
          kind: 'network',
          name: value.name,
          declaration: value.declaration,
          capability: 'move',
          generation: state.ownership.generation,
        },
        { ownership: state.ownership },
      ),
      provenance,
    };
  }

  context.assertReadable(value, provenance);
  if (descriptor.fixedColor !== undefined) {
    context.requireColor(value, descriptor.capability, descriptor.fixedColor, provenance);
  }
  if (frame === undefined) {
    throw new Error('Network parameter borrow was created outside a function frame.');
  }
  const borrow = context.borrow(
    value,
    descriptor.capability,
    descriptor.parameter,
    provenance,
    frame,
  );
  return {
    value: context.brandNetwork(
      {
        kind: 'network',
        name: value.name,
        declaration: value.declaration,
        capability: descriptor.capability,
        generation: value.generation,
      },
      { ownership: state.ownership, borrow },
    ),
    provenance: borrow.source,
  };
}

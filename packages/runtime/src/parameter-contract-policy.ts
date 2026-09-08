import type { DslParameterContract } from '@comblang/language';
import type { SourceSpan } from '@comblang/shared';

import { ElaborationExecutionError } from './elaboration-errors.js';
import type { CombinatorValue, NetworkValue } from './elaboration-values.js';
import type { FunctionOwnershipFrame } from './elaboration-values.js';
import {
  bindNetworkReferenceParameter,
  type NetworkParameterPolicyContext,
} from './network-parameter-policy.js';

export interface ParameterContractDescriptor {
  readonly functionName: string;
  readonly parameter: string;
  readonly source: SourceSpan;
  readonly frame: FunctionOwnershipFrame | undefined;
}

export interface ParameterContractPolicyContext extends NetworkParameterPolicyContext {
  isCombinator(value: unknown): value is CombinatorValue;
  bindCombinator(
    value: unknown,
    producerType: string,
    parameter: string,
    source: SourceSpan,
  ): CombinatorValue;
  bindNetwork(
    value: unknown,
    capability: 'readonly' | 'ref' | 'move',
    parameter: string,
    fixedColor: 'red' | 'green' | undefined,
    source: SourceSpan,
  ): NetworkValue;
  acceptUnrestricted(network: NetworkValue): void;
  readableNetworkFacet?(value: unknown, source: SourceSpan): NetworkValue | undefined;
}

function matches(
  value: unknown,
  contract: DslParameterContract,
  context: ParameterContractPolicyContext,
  source: SourceSpan,
): boolean {
  switch (contract.kind) {
    case 'dynamic':
      return true;
    case 'network':
      return (
        ((contract.capability === 'readonly'
          ? context.readableNetworkFacet?.(value, source)
          : undefined) ?? context.networkFacet(value)) !== undefined
      );
    case 'producer':
      return context.isCombinator(value);
    case 'primitive':
      return contract.value === 'null'
        ? value === null
        : contract.value === 'undefined'
          ? value === undefined
          : typeof value === contract.value;
    case 'union':
      return contract.members.some((member) => matches(value, member, context, source));
  }
}

function selectedContract(
  value: unknown,
  contract: DslParameterContract,
  context: ParameterContractPolicyContext,
  source: SourceSpan,
): DslParameterContract | undefined {
  if (contract.kind !== 'union')
    return matches(value, contract, context, source) ? contract : undefined;
  for (const member of contract.members) {
    const selected = selectedContract(value, member, context, source);
    if (selected !== undefined) return selected;
  }
  return undefined;
}

/** Applies one recursive executed parameter contract without probing mutating branches. */
export function bindParameterContract(
  value: unknown,
  contract: DslParameterContract,
  descriptor: ParameterContractDescriptor,
  context: ParameterContractPolicyContext,
): unknown {
  const selected = selectedContract(value, contract, context, descriptor.source);
  if (selected === undefined) {
    throw new ElaborationExecutionError(
      `${contract.text} parameter ${descriptor.parameter} received a value that matches none of its admitted branches.`,
      descriptor.source,
      'RT2015',
    );
  }
  if (selected.kind === 'dynamic') {
    if (!context.isNetwork(value)) return value;
    return bindNetworkReferenceParameter(
      value,
      {
        functionName: descriptor.functionName,
        parameter: descriptor.parameter,
        requiredType: contract.text,
        source: descriptor.source,
      },
      {
        networkFacet: context.networkFacet,
        recordDslCall: context.recordDslCall,
        acceptUnrestricted: context.acceptUnrestricted,
        requireColor: (network, color, source) =>
          context.requireColor(network, 'readonly', color, source),
      },
    );
  }
  if (selected.kind === 'network') {
    if (selected.capability === 'owned') {
      return bindNetworkReferenceParameter(
        value,
        {
          functionName: descriptor.functionName,
          parameter: descriptor.parameter,
          requiredType: selected.text,
          source: descriptor.source,
        },
        {
          networkFacet: context.networkFacet,
          recordDslCall: context.recordDslCall,
          acceptUnrestricted: context.acceptUnrestricted,
          requireColor: (network, color, source) =>
            context.requireColor(network, 'readonly', color, source),
        },
      );
    }
    return context.bindNetwork(
      value,
      selected.capability,
      descriptor.parameter,
      selected.color,
      descriptor.source,
    );
  }
  if (selected.kind === 'producer') {
    return context.bindCombinator(
      value,
      selected.producerType,
      descriptor.parameter,
      descriptor.source,
    );
  }
  return value;
}

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
}

function matches(
  value: unknown,
  contract: DslParameterContract,
  context: ParameterContractPolicyContext,
): boolean {
  switch (contract.kind) {
    case 'dynamic':
      return true;
    case 'network':
      return context.networkFacet(value) !== undefined;
    case 'producer':
      return context.isCombinator(value);
    case 'primitive':
      return contract.value === 'null'
        ? value === null
        : contract.value === 'undefined'
          ? value === undefined
          : typeof value === contract.value;
    case 'union':
      return contract.members.some((member) => matches(value, member, context));
  }
}

function selectedContract(
  value: unknown,
  contract: DslParameterContract,
  context: ParameterContractPolicyContext,
): DslParameterContract | undefined {
  if (contract.kind !== 'union') return matches(value, contract, context) ? contract : undefined;
  for (const member of contract.members) {
    const selected = selectedContract(value, member, context);
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
  const selected = selectedContract(value, contract, context);
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

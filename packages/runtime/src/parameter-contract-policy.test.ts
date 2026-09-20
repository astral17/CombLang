import type { SourceFileId } from '@comblang/shared';
import { describe, expect, test, vi } from 'vitest';

import { ElaborationExecutionError } from './elaboration-errors.js';
import {
  bindParameterContract,
  type ParameterContractPolicyContext,
} from './parameter-contract-policy.js';

const source = { fileId: 'file:network-signal.ts' as SourceFileId, start: 12, end: 24 };
const descriptor = {
  functionName: 'Read',
  parameter: 'value',
  source,
  frame: undefined,
};
const contract = {
  kind: 'union' as const,
  text: 'NetworkSignal | number',
  members: [
    { kind: 'network-signal' as const, text: 'NetworkSignal' },
    { kind: 'primitive' as const, value: 'number' as const, text: 'number' },
  ],
};

describe('executed NetworkSignal parameter contract policy', () => {
  test('selects the nominal branch without probing or borrowing other branches', () => {
    const selected = Object.freeze({ kind: 'selected' });
    const bound = Object.freeze({ kind: 'selected', bound: true });
    const bindNetworkSignal = vi.fn(() => bound);
    const context = {
      isConcreteNetworkSignal: (value: unknown) => value === selected,
      bindNetworkSignal,
    } as unknown as ParameterContractPolicyContext;

    expect(bindParameterContract(selected, contract, descriptor, context)).toBe(bound);
    expect(bindNetworkSignal).toHaveBeenCalledOnce();
    expect(bindNetworkSignal).toHaveBeenCalledWith(selected, 'value', source);
    expect(bindParameterContract(3, contract, descriptor, context)).toBe(3);
    expect(bindNetworkSignal).toHaveBeenCalledOnce();
  });

  test('rejects a lookalike at the contract source with RT2015', () => {
    const context = {
      isConcreteNetworkSignal: () => false,
      bindNetworkSignal: vi.fn(),
    } as unknown as ParameterContractPolicyContext;

    expect(() =>
      bindParameterContract(
        { kind: 'selected' },
        { kind: 'network-signal', text: 'NetworkSignal' },
        descriptor,
        context,
      ),
    ).toThrowError(
      expect.objectContaining<Partial<ElaborationExecutionError>>({
        code: 'RT2015',
        span: source,
      }),
    );
    expect(context.bindNetworkSignal).not.toHaveBeenCalled();
  });
});

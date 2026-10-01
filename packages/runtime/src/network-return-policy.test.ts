import type { SourceFileId } from '@comblang/shared';
import { describe, expect, test, vi } from 'vitest';

import type {
  NetworkOwnershipState,
  NetworkRuntimeState,
  NetworkValue,
  CombinatorValue,
} from './elaboration-values.js';
import {
  returnNetworkValue,
  type NetworkReturnCapability,
  type NetworkReturnDescriptor,
  type NetworkReturnPolicyContext,
} from './network-return-policy.js';
import { RuntimeValueRegistry } from './elaboration-values.js';
import { createElaborationOwnershipPolicy } from './elaboration-ownership.js';

const fileId = 'file:return-network.ts' as SourceFileId;
const source = { fileId, start: 20, end: 30 };
const declaration = { fileId, start: 0, end: 5 };
const ownership: NetworkOwnershipState = {
  generation: 1,
  owner: 'top-level',
  readonlyBorrows: new Set(),
};
const network: NetworkValue = {
  kind: 'network',
  name: 'local',
  declaration,
  capability: 'owned',
  generation: 0,
};
const returned: NetworkValue = { ...network, generation: 1 };
const producer: CombinatorValue = {
  kind: 'combinator',
  identity: {},
};

function descriptor(
  capability: NetworkReturnCapability,
  fixedColor: 'red' | 'green' | undefined = 'green',
): NetworkReturnDescriptor {
  return {
    capability,
    ...(fixedColor === undefined ? {} : { fixedColor }),
    source,
  };
}

function makeContext(state: NetworkRuntimeState = { ownership }): NetworkReturnPolicyContext {
  return {
    networkFacet: (value) => (value === producer || value === network ? network : undefined),
    requireColor: vi.fn(),
    transferToCaller: vi.fn(() => returned),
    assertReadable: vi.fn(),
    stateFor: () => state,
    brandNetwork: vi.fn((value: NetworkValue) => value),
  };
}

describe('typed Network return policy', () => {
  test('brands a distinct session-nominal alias without transferring or retaining a finished borrow', () => {
    const registry = new RuntimeValueRegistry();
    const owner: NetworkOwnershipState = {
      ...ownership,
      generation: 0,
      readonlyBorrows: new Set(),
    };
    const original = registry.brandNetwork({ ...network }, { ownership: owner });
    const stateFor = (value: NetworkValue) => registry.networkState(value)!;
    const policy = createElaborationOwnershipPolicy(stateFor);
    const frame = { owner: Symbol('Alias'), source, borrows: [], moves: [] };
    const borrow = policy.borrow(original, 'readonly', 'input', source, frame);
    const input = registry.brandNetwork(
      { ...original, capability: 'readonly' },
      { ownership: owner, borrow, callArgument: declaration },
    );
    const context: NetworkReturnPolicyContext = {
      ...makeContext(),
      networkFacet: () => input,
      assertReadable: (value, span) => policy.assertReadable(value, span),
      readonlyAliasState: vi.fn(() => ({ ownership: owner, callArgument: declaration })),
      stateFor,
      brandNetwork: (value, state) => registry.brandNetwork(value, state),
    };
    const alias = returnNetworkValue(input, descriptor('readonly', undefined), context);
    policy.releaseFrame(frame, source);

    expect(alias).not.toBe(input);
    expect(Object.isFrozen(alias)).toBe(true);
    expect(registry.networkState({ ...alias })).toBeUndefined();
    expect(stateFor(alias)).toEqual({ ownership: owner, callArgument: declaration });
    expect(stateFor(alias).ownership).toBe(stateFor(input).ownership);
    expect(alias).toMatchObject({ name: input.name, generation: 0, declaration });
    expect(owner).toMatchObject({ owner: 'top-level', generation: 0 });
    expect(owner.readonlyBorrows.size).toBe(0);
    expect(borrow.active).toBe(false);
    expect(context.transferToCaller).not.toHaveBeenCalled();
    expect(() => policy.assertReadable(alias, source)).not.toThrow();
    expect(() => policy.assertWritable(original, source)).not.toThrow();
    expect(() => policy.assertWritable(alias, source)).toThrowError(
      expect.objectContaining({ code: 'RT2015' }),
    );
    expect(() => policy.assertReadable(input, source)).toThrowError(
      expect.objectContaining({ code: 'RT2017' }),
    );
  });

  test('validates before considering an alias and never takes the seam for an owned return', () => {
    const context = makeContext();
    context.readonlyAliasState = vi.fn(() => ({ ownership }));
    returnNetworkValue(network, descriptor('owned'), context);
    expect(context.readonlyAliasState).not.toHaveBeenCalled();
    vi.mocked(context.assertReadable).mockImplementation(() => {
      throw new Error('expired');
    });
    expect(() => returnNetworkValue(network, descriptor('readonly'), context)).toThrow('expired');
    expect(context.readonlyAliasState).not.toHaveBeenCalled();
    expect(context.brandNetwork).not.toHaveBeenCalled();
  });

  test('checks the readonly return color before creating an alias', () => {
    const context = makeContext();
    context.readonlyAliasState = vi.fn(() => ({ ownership }));
    vi.mocked(context.requireColor).mockImplementation(() => {
      throw new Error('color conflict');
    });
    expect(() => returnNetworkValue(network, descriptor('readonly'), context)).toThrow(
      'color conflict',
    );
    expect(context.requireColor).toHaveBeenCalledWith(network, 'readonly', 'green', source);
    expect(context.readonlyAliasState).not.toHaveBeenCalled();
    expect(context.brandNetwork).not.toHaveBeenCalled();
  });

  test('projects a Combinator primary facet before transferring its output Network', () => {
    const context = makeContext();

    const value = returnNetworkValue(producer, descriptor('owned'), context);

    expect(context.requireColor).toHaveBeenCalledWith(network, 'move', 'green', source);
    expect(context.assertReadable).toHaveBeenCalledWith(network, source);
    expect(context.transferToCaller).toHaveBeenCalledWith(network);
    expect(context.brandNetwork).not.toHaveBeenCalled();
    expect(value).toBe(returned);
  });

  test.each([
    ['owned', 'move'],
    ['readonly', 'readonly'],
  ] as const)(
    'checks an existing %s return with the %s color capability',
    (capability, colorCapability) => {
      const context = makeContext();

      returnNetworkValue(network, descriptor(capability), context);

      expect(context.requireColor).toHaveBeenCalledWith(network, colorCapability, 'green', source);
    },
  );

  test('brands a Readonly view after the owned transfer completes', () => {
    const state: NetworkRuntimeState = { ownership };
    const context = makeContext(state);

    const value = returnNetworkValue(network, descriptor('readonly', undefined), context);

    expect(context.brandNetwork).toHaveBeenCalledWith(
      { ...returned, capability: 'readonly' },
      { ...state },
    );
    expect(value).toMatchObject({ capability: 'readonly', generation: 1 });
  });

  test('rejects an incompatible executed value before facet projection or transfer', () => {
    const context = makeContext();

    expect(() => returnNetworkValue(5, descriptor('owned'), context)).toThrowError(
      expect.objectContaining({ code: 'RT2022', span: source }),
    );
    expect(context.transferToCaller).not.toHaveBeenCalled();
  });

  test('does not create a Readonly wrapper when ownership transfer fails', () => {
    const context = makeContext();
    vi.mocked(context.transferToCaller).mockImplementation(() => {
      throw new Error('foreign owner');
    });

    expect(() => returnNetworkValue(network, descriptor('readonly'), context)).toThrow(
      'foreign owner',
    );
    expect(context.brandNetwork).not.toHaveBeenCalled();
  });
});

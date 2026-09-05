import type { SourceFileId } from '@comblang/shared';
import { describe, expect, test, vi } from 'vitest';

import type {
  NetworkOwnershipState,
  NetworkRuntimeState,
  NetworkValue,
  ProducerValue,
} from './elaboration-values.js';
import {
  returnNetworkValue,
  type NetworkReturnCapability,
  type NetworkReturnDescriptor,
  type NetworkReturnPolicyContext,
} from './network-return-policy.js';

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
const producer: ProducerValue = {
  kind: 'producer',
  identity: {},
  producer: {
    kind: 'constant',
    outputs: [],
    source: declaration,
    instancePath: [],
  },
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

function makeContext(
  state: NetworkRuntimeState = { ownership, returnBindingAvailable: true },
): NetworkReturnPolicyContext {
  return {
    isProducer: (value): value is ProducerValue => value === producer,
    isNetwork: (value): value is NetworkValue => value === network,
    materializeProducer: vi.fn(() => network),
    requireColor: vi.fn(),
    transferToCaller: vi.fn(() => returned),
    stateFor: () => state,
    brandNetwork: vi.fn((value: NetworkValue) => value),
  };
}

describe('typed Network return policy', () => {
  test('materializes a Producer before transferring its output Network', () => {
    const context = makeContext();

    const value = returnNetworkValue(producer, descriptor('owned'), context);

    expect(context.materializeProducer).toHaveBeenCalledWith(producer, 'green');
    expect(context.requireColor).not.toHaveBeenCalled();
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

      expect(context.materializeProducer).not.toHaveBeenCalled();
      expect(context.requireColor).toHaveBeenCalledWith(network, colorCapability, 'green', source);
    },
  );

  test('brands a Readonly view after the owned transfer completes', () => {
    const state: NetworkRuntimeState = { ownership, returnBindingAvailable: true };
    const context = makeContext(state);

    const value = returnNetworkValue(network, descriptor('readonly', undefined), context);

    expect(context.brandNetwork).toHaveBeenCalledWith(
      { ...returned, capability: 'readonly' },
      { ...state },
    );
    expect(value).toMatchObject({ capability: 'readonly', generation: 1 });
  });

  test('rejects an incompatible executed value before materialization or transfer', () => {
    const context = makeContext();

    expect(() => returnNetworkValue(5, descriptor('owned'), context)).toThrowError(
      expect.objectContaining({ code: 'RT2022', span: source }),
    );
    expect(context.materializeProducer).not.toHaveBeenCalled();
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

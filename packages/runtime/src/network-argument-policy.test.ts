import type { SourceFileId } from '@comblang/shared';
import { describe, expect, test, vi } from 'vitest';

import type {
  NetworkOwnershipState,
  NetworkRuntimeState,
  NetworkValue,
  ProducerValue,
  RuntimeNetworkCapability,
} from './elaboration-values.js';
import {
  resolveNetworkArgument,
  type NetworkArgumentDescriptor,
  type NetworkArgumentPolicyContext,
} from './network-argument-policy.js';

const source = { fileId: 'file:arguments.ts' as SourceFileId, start: 40, end: 48 };
const declaration = { fileId: source.fileId, start: 0, end: 5 };
const ownership: NetworkOwnershipState = {
  generation: 0,
  owner: 'top-level',
  readonlyBorrows: new Set(),
};
const network: NetworkValue = {
  kind: 'network',
  name: 'input',
  declaration,
  capability: 'owned',
  generation: 0,
};
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

function descriptor(capability: RuntimeNetworkCapability = 'readonly'): NetworkArgumentDescriptor {
  return {
    functionName: 'Read',
    parameter: 'input',
    capability,
    fixedColor: 'green',
    source,
  };
}

function policy(state: NetworkRuntimeState = { ownership }): NetworkArgumentPolicyContext & {
  materializeProducer: ReturnType<typeof vi.fn>;
  assertReadable: ReturnType<typeof vi.fn>;
  brandNetwork: ReturnType<typeof vi.fn>;
} {
  return {
    isProducer: (value): value is ProducerValue => value === producer,
    isNetwork: (value): value is NetworkValue => value === network,
    materializeProducer: vi.fn(() => network),
    assertReadable: vi.fn(),
    stateFor: () => state,
    brandNetwork: vi.fn((value: NetworkValue) => value),
  };
}

describe('Network call-argument policy', () => {
  test('contextually materializes a Producer and carries the direct argument source', () => {
    const context = policy();

    const resolved = resolveNetworkArgument(producer, descriptor(), context);

    expect(context.materializeProducer).toHaveBeenCalledWith(
      producer,
      '$argument:Read:input',
      'green',
    );
    expect(context.assertReadable).toHaveBeenCalledWith(network, source, 'argument input');
    expect(context.brandNetwork).toHaveBeenCalledWith(
      { ...network },
      { ownership, callArgument: source },
    );
    expect(resolved).not.toBe(network);
  });

  test('preserves an existing borrow while replacing stale call provenance', () => {
    const borrow = {
      capability: 'readonly' as const,
      parameter: 'outer',
      source: declaration,
      ownership,
      active: true,
    };
    const context = policy({ ownership, borrow, callArgument: declaration });

    resolveNetworkArgument(network, descriptor(), context);

    expect(context.materializeProducer).not.toHaveBeenCalled();
    expect(context.brandNetwork).toHaveBeenCalledWith(
      { ...network },
      { ownership, borrow, callArgument: source },
    );
  });

  test.each([
    ['owned', 'Network'],
    ['readonly', 'Readonly<Network>'],
    ['ref', 'Ref<Network>'],
    ['move', 'Move<Network>'],
  ] as const)('rejects a non-Network %s argument with its capability name', (capability, name) => {
    const context = policy();

    expect(() => resolveNetworkArgument(5, descriptor(capability), context)).toThrowError(
      expect.objectContaining({
        code: 'RT2015',
        span: source,
        message: `${name} parameter input received a non-Network value.`,
      }),
    );
    expect(context.assertReadable).not.toHaveBeenCalled();
    expect(context.brandNetwork).not.toHaveBeenCalled();
  });

  test('does not brand a wrapper after readability validation fails', () => {
    const context = policy();
    context.assertReadable.mockImplementation(() => {
      throw new Error('moved');
    });

    expect(() => resolveNetworkArgument(network, descriptor(), context)).toThrow('moved');
    expect(context.brandNetwork).not.toHaveBeenCalled();
  });
});

import type { SourceFileId } from '@comblang/shared';
import { describe, expect, test, vi } from 'vitest';

import type {
  FunctionOwnershipFrame,
  NetworkBorrow,
  NetworkOwnershipState,
  NetworkRuntimeState,
  NetworkValue,
  PairValue,
  ProducerValue,
} from './elaboration-values.js';
import {
  bindNetworkParameter,
  type NetworkParameterCapability,
  type NetworkParameterDescriptor,
  type NetworkParameterPolicyContext,
} from './network-parameter-policy.js';

const fileId = 'file:parameters.ts' as SourceFileId;
const declaration = { fileId, start: 0, end: 5 };
const parameterSource = { fileId, start: 10, end: 20 };
const argumentSource = { fileId, start: 40, end: 48 };
const frame: FunctionOwnershipFrame = {
  owner: Symbol('Read'),
  source: parameterSource,
  borrows: [],
  moves: [],
};
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
const pair: PairValue = { kind: 'pair', networks: [network, network], source: declaration };

function descriptor(
  capability: NetworkParameterCapability,
  fixedColor: 'red' | 'green' | undefined = 'green',
): NetworkParameterDescriptor {
  return {
    functionName: 'Read',
    parameter: 'input',
    capability,
    ...(fixedColor === undefined ? {} : { fixedColor }),
    source: parameterSource,
    frame,
  };
}

function makeContext(
  state: NetworkRuntimeState = { ownership, callArgument: argumentSource },
): NetworkParameterPolicyContext {
  return {
    isProducer: (value): value is ProducerValue => value === producer,
    isNetwork: (value): value is NetworkValue => value === network,
    isPair: (value): value is PairValue => value === pair,
    isPairSelection: (_value): _value is never => false,
    resolveProducerArgument: vi.fn(() => network),
    recordDslCall: vi.fn(),
    stateFor: () => state,
    assertReadable: vi.fn(),
    assertConsumable: vi.fn(),
    requireColor: vi.fn(),
    borrow: vi.fn((_value, capability, parameter, source, _ownerFrame): NetworkBorrow => ({
      capability,
      parameter,
      source,
      ownership: state.ownership,
      active: true,
    })),
    moveToFrame: vi.fn(() => {
      state.ownership.generation += 1;
    }),
    brandNetwork: vi.fn((value: NetworkValue) => value),
  };
}

describe('Network parameter capability policy', () => {
  test.each(['readonly', 'ref'] as const)(
    'creates a %s borrow from the direct call provenance',
    (capability) => {
      const context = makeContext();

      const bound = bindNetworkParameter(network, descriptor(capability), context);

      expect(context.recordDslCall).toHaveBeenCalledOnce();
      expect(context.assertReadable).toHaveBeenCalledWith(network, argumentSource);
      expect(context.requireColor).toHaveBeenCalledWith(
        network,
        capability,
        'green',
        argumentSource,
      );
      expect(context.borrow).toHaveBeenCalledWith(
        network,
        capability,
        'input',
        argumentSource,
        frame,
      );
      expect(bound.provenance).toBe(argumentSource);
      expect(bound.value).toMatchObject({ capability, generation: 0 });
    },
  );

  test('moves ownership before branding the fresh parameter generation', () => {
    const context = makeContext();

    const bound = bindNetworkParameter(network, descriptor('move'), context);

    expect(context.assertConsumable).toHaveBeenCalledWith(network, argumentSource, 'source');
    expect(context.requireColor).toHaveBeenCalledWith(network, 'move', 'green', argumentSource);
    expect(context.moveToFrame).toHaveBeenCalledWith(network, argumentSource, frame);
    expect(bound.value).toMatchObject({ capability: 'move', generation: 1 });
    expect(bound.provenance).toBe(argumentSource);
  });

  test('resolves a Producer through the shared argument policy before borrowing', () => {
    const context = makeContext();
    const binding = descriptor('readonly', undefined);

    bindNetworkParameter(producer, binding, context);

    expect(context.resolveProducerArgument).toHaveBeenCalledWith(producer, binding);
    expect(context.assertReadable).toHaveBeenCalledWith(network, argumentSource);
  });

  test('rejects a pair move before charging or mutating ownership', () => {
    const context = makeContext();

    expect(() => bindNetworkParameter(pair, descriptor('move'), context)).toThrowError(
      expect.objectContaining({ code: 'RT2020', span: parameterSource }),
    );
    expect(context.recordDslCall).not.toHaveBeenCalled();
    expect(context.moveToFrame).not.toHaveBeenCalled();
  });

  test.each([
    ['readonly', 'Readonly<Network>'],
    ['ref', 'Ref<Network>'],
    ['move', 'Move<Network>'],
  ] as const)('rejects a non-Network %s value with RT2015', (capability, name) => {
    const context = makeContext();

    expect(() => bindNetworkParameter(5, descriptor(capability), context)).toThrowError(
      expect.objectContaining({
        code: 'RT2015',
        span: parameterSource,
        message: `${name} parameter input received a non-Network value.`,
      }),
    );
    expect(context.recordDslCall).not.toHaveBeenCalled();
  });

  test('does not color, borrow, or brand after readability validation fails', () => {
    const context = makeContext();
    vi.mocked(context.assertReadable).mockImplementation(() => {
      throw new Error('moved');
    });

    expect(() => bindNetworkParameter(network, descriptor('readonly'), context)).toThrow('moved');
    expect(context.requireColor).not.toHaveBeenCalled();
    expect(context.borrow).not.toHaveBeenCalled();
    expect(context.brandNetwork).not.toHaveBeenCalled();
  });
});

import { signal } from '@comblang/factorio';
import type { NetworkId, ProducerId, SourceFileId } from '@comblang/shared';
import { describe, expect, test } from 'vitest';

import { BlueprintJsonError, lowerNativeBlueprintConfig } from './blueprint-native-config.js';
import type { NativeCircuitIr } from './ir.js';

const network = (value: number) => `network:${value}` as NetworkId;
const producer = (value: number) => `producer:${value}` as ProducerId;
const provenance = { instancePath: [], expansionStack: [] };

describe('native blueprint configuration lowering', () => {
  test('resolves logical inputs and color selections before JSON assembly', () => {
    const A = signal('virtual', 'signal-A');
    const ir: NativeCircuitIr = {
      format: 'comblang-ncir',
      version: 2,
      networks: [
        { id: network(1), color: 'red', provenance },
        { id: network(2), color: 'green', provenance },
        { id: network(3), color: 'red', provenance },
      ],
      producers: [
        {
          id: producer(1),
          kind: 'arithmetic',
          provenance,
          destinations: [network(3)],
          config: {
            left: { kind: 'each', refKind: 'pair', networks: [network(1), network(2)] },
            operation: 'multiply',
            right: { kind: 'constant', value: 2 },
            output: { kind: 'signal', signal: A },
          },
        },
      ],
    };

    const lowered = lowerNativeBlueprintConfig(ir, 1024);

    expect(lowered.combinators[0]?.inputNetworks).toEqual([network(1), network(2)]);
    expect(lowered.combinators[0]?.entity).toMatchObject({
      name: 'arithmetic-combinator',
      control_behavior: {
        arithmetic_conditions: {
          first_signal_networks: { red: true, green: true },
          operation: '*',
          second_constant: 2,
        },
      },
    });
  });

  test('rejects an unresolved destination instead of silently selecting red', () => {
    const source = {
      fileId: 'file:destination.factorio.ts' as SourceFileId,
      start: 10,
      end: 20,
    };
    const ir: NativeCircuitIr = {
      format: 'comblang-ncir',
      version: 2,
      networks: [],
      producers: [
        {
          id: producer(1),
          kind: 'constant',
          provenance: { ...provenance, source },
          destinations: [network(99)],
          config: { outputs: [] },
        },
      ],
    };

    expect(() => lowerNativeBlueprintConfig(ir, 1024)).toThrowError(
      expect.objectContaining<Partial<BlueprintJsonError>>({
        code: 'BP1001',
        span: source,
        message: 'No resolved color for destination Network network:99.',
      }),
    );
  });

  test('includes else-only Decider inputs in native wiring', () => {
    const A = signal('virtual', 'signal-A');
    const ir: NativeCircuitIr = {
      format: 'comblang-ncir',
      version: 2,
      networks: [
        { id: network(1), color: 'red', provenance },
        { id: network(2), color: 'green', provenance },
        { id: network(3), color: 'red', provenance },
      ],
      producers: [
        {
          id: producer(2),
          kind: 'decider',
          provenance,
          destinations: [network(3)],
          config: {
            condition: {
              kind: 'compare',
              left: {
                kind: 'signal',
                signal: A,
                refKind: 'single',
                network: network(1),
              },
              comparator: '>',
              right: { kind: 'constant', value: 0 },
            },
            outputs: [],
            elseOutputs: [
              {
                mode: 'copy',
                signal: { kind: 'signal', signal: A },
                input: { refKind: 'single', network: network(2) },
              },
            ],
          },
        },
      ],
    };

    const lowered = lowerNativeBlueprintConfig(ir, 1024);

    expect(lowered.combinators[0]?.inputNetworks).toEqual([network(1), network(2)]);
    expect(lowered.combinators[0]?.entity.control_behavior).toMatchObject({
      decider_conditions: {
        else_outputs: [{ networks: { red: false, green: true } }],
      },
    });
  });
});

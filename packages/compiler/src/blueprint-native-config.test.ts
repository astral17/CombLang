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
      networks: [
        { id: network(1), color: 'red', provenance },
        { id: network(2), color: 'green', provenance },
        { id: network(3), color: 'red', provenance },
      ],
      entities: [],
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

  test('lowers ordered legacy Constant outputs with explicit normal quality and indices', () => {
    const ir: NativeCircuitIr = {
      format: 'comblang-ncir',
      networks: [],
      entities: [],
      producers: [
        {
          id: producer(3),
          kind: 'constant',
          provenance,
          destinations: [],
          config: {
            outputs: [
              { signal: signal('virtual', 'signal-A'), value: 4 },
              { signal: signal('virtual', 'signal-A', 'normal'), value: -2 },
              { signal: signal('virtual', 'signal-B'), value: 0 },
            ],
          },
        },
      ],
    };

    expect(lowerNativeBlueprintConfig(ir, 1024).combinators[0]?.entity).toEqual({
      name: 'constant-combinator',
      control_behavior: {
        sections: {
          sections: [
            {
              index: 1,
              filters: [
                {
                  index: 1,
                  type: 'virtual',
                  name: 'signal-A',
                  quality: 'normal',
                  comparator: '=',
                  count: 4,
                },
                {
                  index: 2,
                  type: 'virtual',
                  name: 'signal-A',
                  quality: 'normal',
                  comparator: '=',
                  count: -2,
                },
                {
                  index: 3,
                  type: 'virtual',
                  name: 'signal-B',
                  quality: 'normal',
                  comparator: '=',
                  count: 0,
                },
              ],
            },
          ],
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
      networks: [],
      entities: [],
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
      networks: [
        { id: network(1), color: 'red', provenance },
        { id: network(2), color: 'green', provenance },
        { id: network(3), color: 'red', provenance },
      ],
      entities: [],
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

  test('lowers Selector select and count configurations without arithmetic rows', () => {
    const index = signal('virtual', 'signal-index');
    const output = signal('virtual', 'signal-output');
    const ir: NativeCircuitIr = {
      format: 'comblang-ncir',
      networks: [
        { id: network(1), color: 'red', provenance },
        { id: network(2), color: 'green', provenance },
        { id: network(3), color: 'red', provenance },
      ],
      entities: [],
      producers: [
        {
          id: producer(4),
          kind: 'selector',
          provenance,
          destinations: [network(3)],
          config: {
            operation: 'select',
            input: { refKind: 'pair', networks: [network(1), network(2)] },
            selectMax: false,
            index,
          },
        },
        {
          id: producer(5),
          kind: 'selector',
          provenance,
          destinations: [network(3)],
          config: {
            operation: 'count',
            input: { refKind: 'single', network: network(1) },
            output,
          },
        },
      ],
    };

    const lowered = lowerNativeBlueprintConfig(ir, 1024);

    expect(lowered.combinators.map(({ inputNetworks }) => inputNetworks)).toEqual([
      [network(1), network(2)],
      [network(1)],
    ]);
    expect(lowered.combinators.map(({ entity }) => entity)).toEqual([
      {
        name: 'selector-combinator',
        control_behavior: {
          operation: 'select',
          select_max: false,
          index_signal: { type: 'virtual', name: 'signal-index' },
        },
      },
      {
        name: 'selector-combinator',
        control_behavior: {
          operation: 'count',
          count_signal: { type: 'virtual', name: 'signal-output' },
        },
      },
    ]);
  });
});

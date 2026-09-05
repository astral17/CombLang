import { signal } from '@comblang/factorio';
import type { NetworkId, ProducerId } from '@comblang/shared';
import { describe, expect, test } from 'vitest';

import type { CircuitProducerNode } from './ir.js';
import {
  producerInputNetworkIds,
  producerInputNetworkReferences,
} from './producer-network-references.js';

const network = (ordinal: number) => `network:${ordinal}` as NetworkId;
const producer = (ordinal: number) => `producer:${ordinal}` as ProducerId;
const provenance = { instancePath: [], expansionStack: [] };
const A = signal('virtual', 'signal-A');

describe('producer input Network references', () => {
  test('expands pair operands and returns distinct IDs in first-reference order', () => {
    const descriptor: CircuitProducerNode = {
      id: producer(1),
      kind: 'arithmetic',
      provenance,
      destinations: [],
      config: {
        left: { kind: 'each', refKind: 'pair', networks: [network(1), network(2)] },
        operation: 'add',
        right: { kind: 'signal', signal: A, refKind: 'single', network: network(1) },
        output: { kind: 'each' },
      },
    };

    expect(producerInputNetworkReferences(descriptor)).toHaveLength(2);
    expect(producerInputNetworkIds(descriptor)).toEqual([network(1), network(2)]);
    expect(Object.isFrozen(producerInputNetworkIds(descriptor))).toBe(true);
  });

  test('preserves nested-condition and normal/else output row multiplicity', () => {
    const repeated = { refKind: 'single' as const, network: network(3) };
    const descriptor: CircuitProducerNode = {
      id: producer(2),
      kind: 'decider',
      provenance,
      destinations: [],
      config: {
        condition: {
          kind: 'and',
          conditions: [
            {
              kind: 'compare',
              left: {
                kind: 'wildcard',
                value: 'anything',
                refKind: 'pair',
                networks: [network(1), network(2)],
              },
              comparator: '>',
              right: { kind: 'signal', signal: A, ...repeated },
            },
            {
              kind: 'or',
              conditions: [
                {
                  kind: 'compare',
                  left: { kind: 'signal', signal: A, ...repeated },
                  comparator: '=',
                  right: { kind: 'constant', value: 0 },
                },
              ],
            },
          ],
        },
        outputs: [
          { mode: 'copy', signal: { kind: 'signal', signal: A }, input: repeated },
          { mode: 'constant', signal: { kind: 'signal', signal: A }, value: 1, input: repeated },
        ],
        elseOutputs: [
          {
            mode: 'copy',
            signal: { kind: 'signal', signal: A },
            input: { refKind: 'pair', networks: [network(2), network(4)] },
          },
        ],
      },
    };

    const references = producerInputNetworkReferences(descriptor);
    expect(references).toHaveLength(6);
    expect(
      references.filter(
        (reference) => reference.refKind === 'single' && reference.network === network(3),
      ),
    ).toHaveLength(4);
    expect(producerInputNetworkIds(descriptor)).toEqual([
      network(1),
      network(2),
      network(3),
      network(4),
    ]);
  });

  test('does not treat constant rows as circuit inputs', () => {
    const descriptor: CircuitProducerNode = {
      id: producer(3),
      kind: 'constant',
      provenance,
      destinations: [],
      config: { outputs: [{ signal: A, value: 5 }] },
    };

    expect(producerInputNetworkReferences(descriptor)).toEqual([]);
    expect(producerInputNetworkIds(descriptor)).toEqual([]);
  });
});

import { describe, expect, test } from 'vitest';

import type {
  EntityBehaviorKey,
  EntityConnectorKey,
  EntityFeatureKey,
  EntityId,
  EntityLaneKey,
  EntityProfileId,
  EntityProfileSetId,
  NativeCircuitIrV3,
} from './entity.js';
import type { NetworkId, ProducerId, SourceSpan } from '@comblang/shared';
import {
  parseResolvedSourceCircuit,
  type ResolvedSourceCircuit,
} from './resolved-source-circuit.js';

const source: SourceSpan = { fileId: 'file:resolved.ts' as SourceSpan['fileId'], start: 0, end: 1 };
const context = {
  database: { schemaVersion: 1, identity: 'database:synthetic' },
  profileSetIdentity: 'profiles:synthetic' as EntityProfileSetId,
  evidenceIdentity: 'evidence:synthetic',
  policyIdentity: 'policy:synthetic',
};
const network = {
  id: 'network:input' as NetworkId,
  name: 'input',
  fixedColor: 'red' as const,
  color: 'red' as const,
  provenance: { source, instancePath: [], expansionStack: [] },
};
const greenNetwork = {
  ...network,
  id: 'network:green' as NetworkId,
  name: 'green',
  fixedColor: 'green' as const,
  color: 'green' as const,
};
const entity = {
  id: 'entity:1' as EntityId,
  profile: {
    prototypeKey: 'entity:synthetic-zero-port',
    database: context.database,
    profileId: 'profile:synthetic-zero-port-v1' as EntityProfileId,
  },
  prototypeName: 'synthetic-zero-port',
  connectorBindings: [],
  placement: { x: 2.5, y: -1, direction: 8 },
  provenance: {
    source,
    instancePath: [],
    expansionStack: [],
    creationRevision: 1,
  },
  ordinal: 1,
};

function valid(overrides: Partial<NativeCircuitIrV3> = {}): ResolvedSourceCircuit {
  return {
    format: 'comblang-resolved-source-circuit',
    version: 1,
    planFingerprint: 'v1-0000000000000000',
    ir: {
      format: 'comblang-ncir',
      version: 3,
      context,
      networks: [network],
      producers: [],
      entities: [],
      ...overrides,
    },
  };
}

describe('resolved source circuit transport', () => {
  test('accepts and deeply freezes cloneable zero- and one-Entity envelopes', () => {
    const zero = parseResolvedSourceCircuit(valid());
    const one = parseResolvedSourceCircuit(valid({ entities: [entity] }));

    expect(zero.ir.entities).toEqual([]);
    expect(one.ir.entities[0]).toMatchObject({
      id: 'entity:1',
      prototypeName: 'synthetic-zero-port',
      placement: { x: 2.5, y: -1, direction: 8 },
    });
    expect(structuredClone(one)).toEqual(one);
    expect(Object.isFrozen(one)).toBe(true);
    expect(Object.isFrozen(one.ir)).toBe(true);
    expect(Object.isFrozen(one.ir.entities[0])).toBe(true);
    expect(Object.isFrozen(one.ir.networks[0])).toBe(true);

    const withProducer = parseResolvedSourceCircuit(
      valid({
        producers: [
          {
            id: 'producer:1' as ProducerId,
            kind: 'constant',
            config: {
              outputs: [{ signal: { type: 'virtual', name: 'signal-A' }, value: 1 }],
            },
            destinations: ['network:input' as NetworkId],
            provenance: { source, instancePath: [], expansionStack: [] },
          },
        ],
      }),
    );
    expect(Object.isFrozen(withProducer.ir.producers[0]!.config)).toBe(true);
    const producer = withProducer.ir.producers[0]!;
    if (producer.kind !== 'constant') throw new Error('Expected a constant producer.');
    expect(Object.isFrozen(producer.config.outputs[0])).toBe(true);
  });

  test('detaches caller data before freezing the transport snapshot', () => {
    const input = structuredClone(valid({ entities: [structuredClone(entity)] }));
    const snapshot = parseResolvedSourceCircuit(input);
    (input as any).ir.networks[0]!.color = 'green';
    (input as any).ir.entities[0]!.placement!.x = 99;

    expect(snapshot.ir.networks[0]!.color).toBe('red');
    expect(snapshot.ir.entities[0]!.placement).toEqual({ x: 2.5, y: -1, direction: 8 });
  });

  test.each([
    ['envelope format', { format: 'wrong' }],
    ['envelope version', { version: 2 }],
    ['unknown envelope field', { extra: true }],
    ['context field', { ir: { ...valid().ir, context: { ...context, profiles: [] } } }],
  ])('rejects %s', (_name, override) => {
    expect(() => parseResolvedSourceCircuit({ ...valid(), ...override } as unknown)).toThrowError();
  });

  test.each([
    {
      name: 'duplicate Network id',
      value: valid({ networks: [network, { ...network, name: 'other' }] }),
    },
    {
      name: 'duplicate Entity id',
      value: valid({ entities: [entity, { ...entity, ordinal: 2 }] }),
    },
    {
      name: 'duplicate Entity ordinal',
      value: valid({ entities: [entity, { ...entity, id: 'entity:2' as EntityId }] }),
    },
    {
      name: 'dangling Producer destination',
      value: valid({
        producers: [
          {
            id: 'producer:1' as ProducerId,
            kind: 'constant',
            config: {
              outputs: [{ signal: { type: 'virtual', name: 'signal-A' }, value: 1 }],
            },
            destinations: ['network:missing' as NetworkId],
            provenance: { source, instancePath: [], expansionStack: [] },
          },
        ],
      }),
    },
    {
      name: 'dangling Entity binding',
      value: valid({
        entities: [
          {
            ...entity,
            connectorBindings: [
              {
                endpoint: {
                  connector: 'connector' as EntityConnectorKey,
                  lane: 'lane' as EntityLaneKey,
                  color: 'red' as const,
                },
                network: 'network:missing' as NetworkId,
                nativeConnector: 1,
                generation: 0,
                direction: 'input' as const,
                provenance: {
                  source,
                  instancePath: [],
                  operationOrdinal: 1,
                },
              },
            ],
          },
        ],
      }),
    },
  ])('rejects $name', ({ value }) => {
    expect(() => parseResolvedSourceCircuit(value)).toThrowError();
  });

  test.each([
    {
      name: 'fractional placement direction',
      value: valid({ entities: [{ ...entity, placement: { x: 0, y: 0, direction: 1.5 } }] }),
    },
    {
      name: 'invalid physical condition',
      value: valid({
        entities: [
          {
            ...entity,
            configuration: {
              mode: 'typed',
              rule: 'rule' as EntityBehaviorKey,
              feature: 'feature' as EntityFeatureKey,
              nativeField: 'control_behavior.circuit_condition',
              connector: 'connector' as EntityConnectorKey,
              lanes: ['lane' as EntityLaneKey],
              laneMask: { red: true, green: false },
              condition: {
                kind: 'compare-signal-constant',
                signal: { type: 'virtual', name: 'signal-each' },
                comparator: '>',
                constant: 0,
              },
            },
          },
        ],
      }),
    },
    {
      name: 'cross-record database identity',
      value: valid({
        entities: [
          {
            ...entity,
            profile: {
              ...entity.profile,
              database: { schemaVersion: 1, identity: 'database:other' },
            },
          },
        ],
      }),
    },
  ])('rejects malformed $name', ({ value }) => {
    expect(() => parseResolvedSourceCircuit(value)).toThrowError();
  });

  test.each([
    {
      name: 'empty Signal quality',
      value: valid({
        producers: [
          {
            id: 'producer:quality' as ProducerId,
            kind: 'constant' as const,
            config: {
              outputs: [{ signal: { type: 'virtual', name: 'signal-A', quality: '' }, value: 1 }],
            },
            destinations: [network.id],
            provenance: { source, instancePath: [], expansionStack: [] },
          },
        ],
      }),
    },
    {
      name: 'fixed color mismatch',
      value: valid({ networks: [{ ...network, fixedColor: 'green' as const }] }),
    },
    {
      name: 'same-color Network pair',
      value: valid({
        networks: [network, { ...network, id: 'network:other' as NetworkId, name: 'other' }],
        producers: [
          {
            id: 'producer:pair' as ProducerId,
            kind: 'arithmetic' as const,
            config: {
              left: {
                kind: 'each' as const,
                refKind: 'pair' as const,
                networks: [network.id, 'network:other' as NetworkId],
              },
              operation: 'add' as const,
              right: { kind: 'constant' as const, value: 1 },
              output: { kind: 'each' as const },
            },
            destinations: [network.id],
            provenance: { source, instancePath: [], expansionStack: [] },
          },
        ],
      }),
    },
    {
      name: 'same-color Producer destinations',
      value: valid({
        networks: [network, { ...network, id: 'network:other' as NetworkId, name: 'other' }],
        producers: [
          {
            id: 'producer:destinations' as ProducerId,
            kind: 'constant' as const,
            config: { outputs: [{ signal: { type: 'virtual', name: 'signal-A' }, value: 1 }] },
            destinations: [network.id, 'network:other' as NetworkId],
            provenance: { source, instancePath: [], expansionStack: [] },
          },
        ],
      }),
    },
    {
      name: 'Entity binding color mismatch',
      value: valid({
        entities: [
          {
            ...entity,
            connectorBindings: [
              {
                endpoint: {
                  connector: 'connector' as EntityConnectorKey,
                  lane: 'lane' as EntityLaneKey,
                  color: 'green' as const,
                },
                network: network.id,
                nativeConnector: 1,
                generation: 0,
                direction: 'input' as const,
                provenance: { source, instancePath: [], operationOrdinal: 1 },
              },
            ],
          },
        ],
      }),
    },
    {
      name: 'blueprint-unsafe native connector ordinal',
      value: valid({
        entities: [
          {
            ...entity,
            connectorBindings: [
              {
                endpoint: {
                  connector: 'connector' as EntityConnectorKey,
                  lane: 'lane' as EntityLaneKey,
                  color: 'red' as const,
                },
                network: network.id,
                nativeConnector: Number.MAX_SAFE_INTEGER,
                generation: 0,
                direction: 'input' as const,
                provenance: { source, instancePath: [], operationOrdinal: 1 },
              },
            ],
          },
        ],
      }),
    },
  ])('rejects resolved physical invariant: $name', ({ value }) => {
    expect(() => parseResolvedSourceCircuit(value)).toThrowError();
  });

  test('accepts opposite-color Network pairs and two-destination Producers', () => {
    const parsed = parseResolvedSourceCircuit(
      valid({
        networks: [network, greenNetwork],
        producers: [
          {
            id: 'producer:accepted' as ProducerId,
            kind: 'arithmetic' as const,
            config: {
              left: {
                kind: 'each' as const,
                refKind: 'pair' as const,
                networks: [network.id, greenNetwork.id],
              },
              operation: 'add' as const,
              right: { kind: 'constant' as const, value: 1 },
              output: { kind: 'each' as const },
            },
            destinations: [network.id, greenNetwork.id],
            provenance: { source, instancePath: [], expansionStack: [] },
          },
        ],
      }),
    );
    expect(parsed.ir.producers).toHaveLength(1);
  });

  test.each([
    {
      name: 'single Network ref with inactive networks member',
      value: valid({
        producers: [
          {
            id: 'producer:inactive-single' as ProducerId,
            kind: 'arithmetic' as const,
            config: {
              left: {
                kind: 'each' as const,
                refKind: 'single' as const,
                network: network.id,
                networks: [network.id],
              },
              operation: 'add' as const,
              right: { kind: 'constant' as const, value: 1 },
              output: { kind: 'each' as const },
            },
            destinations: [network.id],
            provenance: { source, instancePath: [], expansionStack: [] },
          } as never,
        ],
      }),
    },
    {
      name: 'pair Network ref with inactive network member',
      value: valid({
        networks: [network, { ...network, id: 'network:other' as NetworkId, name: 'other' }],
        producers: [
          {
            id: 'producer:inactive-pair' as ProducerId,
            kind: 'arithmetic' as const,
            config: {
              left: {
                kind: 'each' as const,
                refKind: 'pair' as const,
                networks: [network.id, 'network:other' as NetworkId],
                network: network.id,
              },
              operation: 'add' as const,
              right: { kind: 'constant' as const, value: 1 },
              output: { kind: 'each' as const },
            },
            destinations: [network.id],
            provenance: { source, instancePath: [], expansionStack: [] },
          } as never,
        ],
      }),
    },
    {
      name: 'flattened Decider output Network fields',
      value: valid({
        producers: [
          {
            id: 'producer:flattened-output' as ProducerId,
            kind: 'decider' as const,
            config: {
              condition: {
                kind: 'compare' as const,
                left: {
                  kind: 'signal' as const,
                  signal: { type: 'virtual', name: 'signal-A' },
                  refKind: 'single' as const,
                  network: network.id,
                },
                comparator: '>' as const,
                right: { kind: 'constant' as const, value: 0 },
              },
              outputs: [
                {
                  mode: 'copy' as const,
                  signal: {
                    kind: 'signal' as const,
                    signal: { type: 'virtual', name: 'signal-A' },
                  },
                  refKind: 'single' as const,
                  network: network.id,
                },
              ],
            },
            destinations: [network.id],
            provenance: { source, instancePath: [], expansionStack: [] },
          } as never,
        ],
      }),
    },
    {
      name: 'copy Decider output with inactive value',
      value: valid({
        producers: [
          {
            id: 'producer:copy-value' as ProducerId,
            kind: 'decider' as const,
            config: {
              condition: {
                kind: 'compare' as const,
                left: {
                  kind: 'signal' as const,
                  signal: { type: 'virtual', name: 'signal-A' },
                  refKind: 'single' as const,
                  network: network.id,
                },
                comparator: '>' as const,
                right: { kind: 'constant' as const, value: 0 },
              },
              outputs: [
                {
                  mode: 'copy' as const,
                  signal: {
                    kind: 'signal' as const,
                    signal: { type: 'virtual', name: 'signal-A' },
                  },
                  value: 1,
                },
              ],
            },
            destinations: [network.id],
            provenance: { source, instancePath: [], expansionStack: [] },
          } as never,
        ],
      }),
    },
    {
      name: 'Decider output with explicit undefined input',
      value: valid({
        producers: [
          {
            id: 'producer:undefined-input' as ProducerId,
            kind: 'decider' as const,
            config: {
              condition: {
                kind: 'compare' as const,
                left: {
                  kind: 'signal' as const,
                  signal: { type: 'virtual', name: 'signal-A' },
                  refKind: 'single' as const,
                  network: network.id,
                },
                comparator: '>' as const,
                right: { kind: 'constant' as const, value: 0 },
              },
              outputs: [
                {
                  mode: 'copy' as const,
                  signal: {
                    kind: 'signal' as const,
                    signal: { type: 'virtual', name: 'signal-A' },
                  },
                  input: undefined,
                },
              ],
            },
            destinations: [network.id],
            provenance: { source, instancePath: [], expansionStack: [] },
          } as never,
        ],
      }),
    },
  ])('rejects inactive resolved union field: $name', ({ value }) => {
    expect(() => parseResolvedSourceCircuit(value)).toThrowError();
  });
});

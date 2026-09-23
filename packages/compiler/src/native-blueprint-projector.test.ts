import { signal } from '@comblang/factorio';
import type { NetworkId, ProducerId, SourceFileId } from '@comblang/shared';
import { describe, expect, test } from 'vitest';

import { syntheticZeroPortEntityProfile } from './entity-fixtures.js';
import type { EntityConnectorKey, EntityLaneKey, EntityPhysicalRecord } from './entity.js';
import type { NativeCircuitIr } from './ir.js';
import { buildNativeBlueprintFcir } from './native-blueprint-projector.js';

const network = (value: number) => `network:${value}` as NetworkId;
const producer = (value: number) => `producer:${value}` as ProducerId;
const source = Object.freeze({
  fileId: 'file:native-blueprint-projector.test.ts' as SourceFileId,
  start: 5,
  end: 19,
});
const provenance = { source, instancePath: [], expansionStack: [] };

function physicalEntity(
  ordinal: number,
  configuration?: EntityPhysicalRecord['configuration'],
  connectorBindings: EntityPhysicalRecord['connectorBindings'] = [],
  placement?: EntityPhysicalRecord['placement'],
  prototypeName = 'synthetic-zero-port',
): EntityPhysicalRecord {
  return {
    id: `entity:${ordinal}` as EntityPhysicalRecord['id'],
    ordinal,
    profile: {
      ...syntheticZeroPortEntityProfile.ref,
      prototypeKey: `entity:${prototypeName}`,
    },
    prototypeName,
    provenance: {
      source,
      instancePath: [],
      expansionStack: [],
      creationRevision: 1,
    },
    connectorBindings,
    ...(configuration === undefined ? {} : { configuration }),
    ...(placement === undefined ? {} : { placement }),
  };
}

describe('NativeCircuitIr to blueprint FCIR projection', () => {
  test('preserves linked and raw Entities, placements, numbering, and ordered physical wires', () => {
    const constantConfiguration = {
      isOn: true,
      sections: [
        {
          active: true,
          multiplier: 2,
          filters: [{ signal: signal('virtual', 'signal-A'), value: 3 }],
        },
      ],
    };
    const linked = physicalEntity(
      1,
      { mode: 'constant', value: constantConfiguration },
      [],
      { x: 0.5, y: 0.5 },
      'constant-combinator',
    );
    const redPhysicalBinding: EntityPhysicalRecord['connectorBindings'][number] = {
      endpoint: {
        connector: 'connector:physical' as EntityConnectorKey,
        lane: 'lane:red' as EntityLaneKey,
        color: 'red',
      },
      network: network(1),
      nativeConnector: 2,
      generation: 0,
      direction: 'input',
      provenance: { source, instancePath: [], operationOrdinal: 1 },
    };
    const greenPhysicalBinding: EntityPhysicalRecord['connectorBindings'][number] = {
      ...redPhysicalBinding,
      endpoint: {
        connector: 'connector:physical' as EntityConnectorKey,
        lane: 'lane:green' as EntityLaneKey,
        color: 'green',
      },
      network: network(2),
      provenance: { source, instancePath: [], operationOrdinal: 2 },
    };
    const raw = physicalEntity(
      2,
      {
        mode: 'raw',
        payload: {
          recipe: 'iron-gear-wheel',
          future_native_extension: { revision: 3, flags: [true, null, 'opaque'] },
        },
      },
      [redPhysicalBinding, greenPhysicalBinding],
    );
    const ir: NativeCircuitIr = {
      format: 'comblang-ncir',
      networks: [
        { id: network(1), color: 'red', provenance },
        { id: network(2), color: 'green', provenance },
        { id: network(3), color: 'red', provenance },
      ],
      entities: [linked, raw],
      producers: [
        {
          id: producer(1),
          kind: 'constant',
          entityId: linked.id,
          config: { configuration: constantConfiguration },
          destinations: [network(1)],
          provenance,
        },
        {
          id: producer(2),
          kind: 'arithmetic',
          placement: { x: 2.5, y: 0.5 },
          config: {
            left: {
              kind: 'signal',
              signal: signal('virtual', 'signal-A'),
              refKind: 'single',
              network: network(1),
            },
            right: {
              kind: 'signal',
              signal: signal('virtual', 'signal-B'),
              refKind: 'single',
              network: network(2),
            },
            operation: 'add',
            output: { kind: 'signal', signal: signal('virtual', 'signal-C') },
          },
          destinations: [network(3)],
          provenance,
        },
      ],
    };

    const fcir = buildNativeBlueprintFcir(ir, {
      label: 'mixed projection',
      maxDeciderConditionRows: 1024,
    });

    expect(Object.isFrozen(fcir)).toBe(true);
    expect(fcir.header.label).toBe('mixed projection');
    expect(fcir.entities.map(({ entityNumber }) => entityNumber)).toEqual([1, 2, 4]);
    expect(fcir.entities[0]).toMatchObject({
      entityNumber: 1,
      native: {
        name: 'constant-combinator',
        control_behavior: {
          is_on: true,
          sections: {
            sections: [
              {
                index: 1,
                active: true,
                multiplier: 2,
                filters: [{ index: 1, name: 'signal-A', quality: 'normal', count: 3 }],
              },
            ],
          },
        },
        position: { x: 0.5, y: 0.5 },
        direction: 4,
      },
    });
    expect(fcir.entities[1]?.native).toMatchObject({
      name: 'arithmetic-combinator',
      position: { x: 2.5, y: 0.5 },
      direction: 4,
    });
    expect(fcir.entities[2]).toMatchObject({
      entityNumber: 4,
      native: {
        name: 'synthetic-zero-port',
        position: { x: 4.5, y: 0.5 },
        direction: 4,
      },
      nativeBeforeNumber: {
        recipe: 'iron-gear-wheel',
        future_native_extension: { revision: 3, flags: [true, null, 'opaque'] },
      },
    });
    expect(fcir.entities[2]?.native).not.toHaveProperty('entity_number');
    expect(fcir.entities[2]?.nativeBeforeNumber).not.toHaveProperty('entity_number');
    expect(
      fcir.wires.map(({ from, to }) => [
        from.entityNumber,
        from.connector,
        to.entityNumber,
        to.connector,
      ]),
    ).toEqual([
      [1, 1, 2, 1],
      [2, 1, 4, 3],
      [2, 2, 4, 4],
    ]);
    expect(fcir.wires[1]?.source).toEqual(source);
  });
});

import { signal } from '@comblang/factorio';
import type { NetworkId, ProducerId } from '@comblang/shared';
import { describe, expect, test } from 'vitest';

import { generateBlueprintJson } from './blueprint-json.js';
import type { NativeCircuitIr } from './ir.js';

const network = (value: number) => `network:${value}` as NetworkId;
const producer = (value: number) => `producer:${value}` as ProducerId;

describe('Factorio blueprint JSON generator', () => {
  test('emits entities, control behavior, placement, and circuit wires', () => {
    const A = signal('virtual', 'signal-A');
    const ir: NativeCircuitIr = {
      format: 'comblang-ncir',
      version: 1,
      networks: [
        {
          id: network(1),
          name: 'constants',
          color: 'red',
          provenance: { instancePath: [], expansionStack: [] },
        },
        {
          id: network(2),
          name: 'scaled',
          color: 'green',
          provenance: { instancePath: [], expansionStack: [] },
        },
      ],
      producers: [
        {
          id: producer(1),
          kind: 'constant',
          config: { outputs: [{ signal: A, value: 5 }] },
          destinations: [network(1)],
          provenance: { instancePath: [], expansionStack: [] },
        },
        {
          id: producer(2),
          kind: 'arithmetic',
          placement: { x: 12.5, y: -4, direction: 8 },
          config: {
            left: { kind: 'signal', signal: A, network: network(1) },
            operation: 'multiply',
            right: { kind: 'constant', value: 2 },
            output: { kind: 'signal', signal: A },
          },
          destinations: [network(2)],
          provenance: { instancePath: [], expansionStack: [] },
        },
      ],
    };

    const generated = generateBlueprintJson(ir, { label: 'Test circuit' });

    expect(generated.blueprint).toMatchObject({
      item: 'blueprint',
      label: 'Test circuit',
      entities: [
        {
          entity_number: 1,
          name: 'constant-combinator',
          position: { x: 0.5, y: 0.5 },
        },
        {
          entity_number: 2,
          name: 'arithmetic-combinator',
          position: { x: 12.5, y: -4 },
          direction: 8,
          control_behavior: {
            arithmetic_conditions: {
              first_signal: { type: 'virtual', name: 'signal-A' },
              operation: '*',
              second_constant: 2,
            },
          },
        },
      ],
      wires: [[1, 1, 2, 1]],
    });
    expect(JSON.parse(JSON.stringify(generated))).toEqual(generated);
  });

  test('omits the default item SignalID type in blueprint fields', () => {
    const IRON = signal('item', 'iron-plate');
    const ir: NativeCircuitIr = {
      format: 'comblang-ncir',
      version: 1,
      networks: [
        {
          id: network(1),
          name: 'constants',
          color: 'red',
          provenance: { instancePath: [], expansionStack: [] },
        },
      ],
      producers: [
        {
          id: producer(1),
          kind: 'constant',
          config: { outputs: [{ signal: IRON, value: 5 }] },
          destinations: [network(1)],
          provenance: { instancePath: [], expansionStack: [] },
        },
      ],
    };

    const filter = (
      generateBlueprintJson(ir).blueprint.entities[0]?.control_behavior as {
        sections: { sections: { filters: Record<string, unknown>[] }[] };
      }
    ).sections.sections[0]!.filters[0];
    expect(filter).toMatchObject({ name: 'iron-plate', count: 5 });
    expect(filter).not.toHaveProperty('type');
  });
});

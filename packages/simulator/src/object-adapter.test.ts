import { Signal, SparseBus } from '@comblang/factorio';
import type { NetworkId } from '@comblang/shared';
import { describe, expect, it } from 'vitest';

import { knownBus, unknownBus } from './bus-value.js';
import type { CircuitObjectAdapter } from './object-adapter.js';
import { TestSession } from './test-session.js';
import { ValueSimulationKernel } from './value-kernel.js';

const A = Signal('virtual', 'signal-A');
const network = (id: string) => id as NetworkId;

interface SyntheticObject {
  readonly id: string;
  readonly inputs: readonly NetworkId[];
  readonly output: NetworkId;
  readonly defaultValue: SparseBus;
}

const syntheticAdapter: CircuitObjectAdapter<SyntheticObject, 'circuit'> = {
  id: 'synthetic-object',
  instanceId: (instance) => instance.id,
  connectors: (instance) => [
    {
      name: 'circuit',
      inputNetworks: instance.inputs,
      outputNetworks: [instance.output],
    },
  ],
  defaultOutput: (instance) => knownBus(instance.defaultValue),
};

describe('generic circuit object adapter', () => {
  it('aggregates connector input snapshots and injects a copied default output', () => {
    const inputRed = network('network:input-red');
    const inputGreen = network('network:input-green');
    const output = network('network:output');
    const defaultValue = new SparseBus([[A, 7]]);
    const session = new TestSession(new ValueSimulationKernel());
    const object = session.adaptObject(syntheticAdapter, {
      id: 'probe-1',
      inputs: [inputRed, inputGreen],
      output,
      defaultValue,
    });
    defaultValue.set(A, 100);

    expect(object).toMatchObject({
      kind: 'test-object',
      adapterId: 'synthetic-object',
      instanceId: 'probe-1',
      connectors: ['circuit'],
    });
    expect(session.readObjectInput(object, 'circuit')).toMatchObject({ kind: 'known' });

    session
      .drive(inputRed, [[A, 2]])
      .drive(inputGreen, [[A, 3]])
      .drive(output, [[A, 4]])
      .tick();

    const input = session.readObjectInput(object, 'circuit');
    expect(input.kind === 'known' ? input.bus.get(A) : undefined).toBe(5);
    expect(session.read(output).get(A)).toBe(11);
  });

  it('preserves Unknown output provenance through the object instance', () => {
    const output = network('network:unknown-output');
    const adapter: CircuitObjectAdapter<{ readonly id: string }, 'output'> = {
      id: 'unknown-object',
      instanceId: ({ id }) => id,
      connectors: () => [{ name: 'output', inputNetworks: [], outputNetworks: [output] }],
      defaultOutput: ({ id }) =>
        unknownBus([{ id: `unmodeled:${id}`, description: `Unmodeled ${id}` }]),
    };
    const session = new TestSession(new ValueSimulationKernel());
    const object = session.adaptObject(adapter, { id: 'probe-2' });

    session.tick();

    expect(session.readValue(output)).toEqual({
      kind: 'unknown',
      origins: [
        {
          id: 'unmodeled:probe-2',
          description: 'Unmodeled probe-2',
          path: [object.id],
        },
      ],
    });
  });

  it('enforces instance, connector, session, and registration identity', () => {
    const output = network('network:identity-output');
    const instance = {
      id: 'same',
      inputs: [] as const,
      output,
      defaultValue: new SparseBus(),
    };
    const session = new TestSession(new ValueSimulationKernel());
    const object = session.adaptObject(syntheticAdapter, instance);

    expect(() => session.adaptObject(syntheticAdapter, instance)).toThrowError(
      'Duplicate circuit object instance: synthetic-object:same.',
    );
    expect(() => session.readObjectInput(object, 'missing' as 'circuit')).toThrowError(
      'has no connector named "missing"',
    );
    const foreignSession = new TestSession(new ValueSimulationKernel());
    expect(() => foreignSession.readObjectInput(object, 'circuit')).toThrowError(
      'Foreign or invalid test object handle.',
    );

    session.tick();
    expect(() => session.adaptObject(syntheticAdapter, { ...instance, id: 'late' })).toThrowError(
      'must be registered before the first tick',
    );
  });
});

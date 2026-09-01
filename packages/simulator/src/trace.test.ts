import { signal, SparseBus } from '@comblang/factorio';
import type { NetworkId } from '@comblang/shared';
import { describe, expect, it } from 'vitest';

import { unknownBus } from './bus-value.js';
import type { CircuitObjectAdapter } from './object-adapter.js';
import { TestSession } from './test-session.js';
import { ValueSimulationKernel } from './value-kernel.js';

const network = 'network:trace' as NetworkId;
const A = signal('virtual', 'signal-A');
const B = signal('virtual', 'signal-B');

describe('delta traces', () => {
  it('records tick zero and only later signal changes', () => {
    const test = new TestSession(new ValueSimulationKernel());
    test.trace(network, test.signal(network, A));
    test.drive(network, [
      [A, 5],
      [B, 2],
    ]);
    test.tick();
    test.tick();
    test.clear(network).tick();

    const document = test.traces.toJSON();
    expect(document.format).toBe('comblang-trace');
    expect(document.targets.map((target) => target.kind)).toEqual(['network', 'signal']);
    expect(document.events.map(({ tick, kind }) => ({ tick, kind }))).toEqual([
      { tick: 0, kind: 'known' },
      { tick: 0, kind: 'known' },
      { tick: 1, kind: 'known' },
      { tick: 1, kind: 'known' },
      { tick: 3, kind: 'known' },
      { tick: 3, kind: 'known' },
    ]);
    expect(document.events[2]).toMatchObject({
      kind: 'known',
      tick: 1,
      reset: false,
      changes: [
        { signal: A, value: 5 },
        { signal: B, value: 2 },
      ],
    });
    expect(document.events[4]).toMatchObject({
      kind: 'known',
      tick: 3,
      changes: [
        { signal: A, value: 0 },
        { signal: B, value: 0 },
      ],
    });
    const signalTarget = document.targets.find((target) => target.kind === 'signal');
    expect(signalTarget).toBeDefined();
    expect(test.traces.timeline(signalTarget?.id)).toHaveLength(3);
  });

  it('records Unknown origins and resets after returning to Known', () => {
    const kernel = new ValueSimulationKernel();
    kernel.setInitialNetwork(
      network,
      unknownBus([{ id: 'object:1', description: 'unmodeled output' }]),
    );
    const test = new TestSession(kernel);
    test.trace(network);
    test.drive(network, new SparseBus([[A, 9]])).tick();

    expect(test.traces.timeline()).toMatchObject([
      {
        kind: 'unknown',
        tick: 0,
        origins: [{ id: 'object:1', description: 'unmodeled output' }],
      },
      {
        kind: 'known',
        tick: 1,
        reset: true,
        changes: [{ signal: A, value: 9 }],
      },
    ]);
  });

  it('deduplicates targets and rejects late registration', () => {
    const test = new TestSession(new ValueSimulationKernel());
    test.trace(network, network);
    expect(test.traces.toJSON().targets).toHaveLength(1);

    test.tick();
    expect(() => test.trace(test.signal(network, A))).toThrow(
      'Trace targets must be registered at tick 0.',
    );
  });

  it('records object input aggregates and isolated committed output contributions', () => {
    const input = 'network:object-trace-input' as NetworkId;
    const output = 'network:object-trace-output' as NetworkId;
    const adapter: CircuitObjectAdapter<{ readonly id: string }, 'circuit'> = {
      id: 'traced-object',
      instanceId: ({ id }) => id,
      connectors: () => [
        {
          name: 'circuit',
          inputNetworks: [input],
          outputNetworks: [output],
        },
      ],
    };
    const test = new TestSession(new ValueSimulationKernel(), {
      objects: { default: 'zero' },
    });
    const object = test.adaptObject(adapter, { id: 'counter' });
    test.model(object, {
      initialState: null,
      step: ({ input: value, state }) => ({
        state,
        output: [[A, (value.kind === 'known' ? value.bus.get(A) : 0) + 1]],
      }),
    });
    test.trace(test.objectInput(object), test.objectOutput(object));
    test
      .drive(input, [[A, 3]])
      .drive(output, [[A, 10]])
      .tick(2);

    expect(test.read(output).get(A)).toBe(14);
    const document = test.traces.toJSON();
    const inputTarget = document.targets.find(({ kind }) => kind === 'object-input');
    const outputTarget = document.targets.find(({ kind }) => kind === 'object-output');
    expect(inputTarget).toMatchObject({
      adapterId: 'traced-object',
      instanceId: 'counter',
      connector: 'circuit',
    });
    expect(outputTarget).toMatchObject({
      adapterId: 'traced-object',
      instanceId: 'counter',
      connector: 'circuit',
    });
    expect(test.traces.timeline(inputTarget?.id)).toMatchObject([
      { kind: 'known', tick: 0, reset: true, changes: [] },
      { kind: 'known', tick: 1, reset: false, changes: [{ signal: A, value: 3 }] },
    ]);
    expect(test.traces.timeline(outputTarget?.id)).toMatchObject([
      { kind: 'known', tick: 0, reset: true, changes: [] },
      { kind: 'known', tick: 1, reset: false, changes: [{ signal: A, value: 1 }] },
      { kind: 'known', tick: 2, reset: false, changes: [{ signal: A, value: 4 }] },
    ]);
  });

  it('records strict Unknown object output with object provenance', () => {
    const output = 'network:unknown-object-trace' as NetworkId;
    const adapter: CircuitObjectAdapter<{ readonly id: string }, 'circuit'> = {
      id: 'unknown-traced-object',
      instanceId: ({ id }) => id,
      connectors: () => [{ name: 'circuit', inputNetworks: [], outputNetworks: [output] }],
    };
    const test = new TestSession(new ValueSimulationKernel());
    const object = test.adaptObject(adapter, { id: 'external' });
    test.trace(test.objectOutput(object));
    test.tick();

    expect(test.traces.timeline()).toMatchObject([
      { kind: 'known', tick: 0, reset: true },
      {
        kind: 'unknown',
        tick: 1,
        origins: [
          {
            id: 'unmodeled:unknown-traced-object:external:circuit',
            path: [object.id],
          },
        ],
      },
    ]);
  });
});

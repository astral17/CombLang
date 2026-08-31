import { signal, SparseBus } from '@comblang/factorio';
import type { NetworkId } from '@comblang/shared';
import { describe, expect, it } from 'vitest';

import { unknownBus } from './bus-value.js';
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
});

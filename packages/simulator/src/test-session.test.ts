import { SparseBus, signal } from '@comblang/factorio';
import type { DeviceId, NetworkId } from '@comblang/shared';
import { describe, expect, it } from 'vitest';

import { SimulationKernel } from './kernel.js';
import { TestSession } from './test-session.js';

const input = 'network:input' as NetworkId;
const output = 'network:output' as NetworkId;
const signalA = signal('virtual', 'signal-A');

describe('TestSession external drives', () => {
  it('replaces persistent drives, aggregates them with devices, and clears them', () => {
    const kernel = new SimulationKernel();
    kernel.addDevice({
      id: 'device:constant' as DeviceId,
      evaluate: () => [{ networkId: input, values: new SparseBus([[signalA, 2]]) }],
    });
    const session = new TestSession(kernel);

    session.drive(input, [[signalA, 5]]).tick();
    expect(session.currentTick).toBe(1);
    expect(session.read(input).get(signalA)).toBe(7);

    session.drive(input, [[signalA, 9]]).tick();
    expect(session.read(input).get(signalA)).toBe(11);

    session.clear(input).tick();
    expect(session.read(input).get(signalA)).toBe(2);
  });

  it('broadcasts a pulse for exactly one committed boundary', () => {
    const session = new TestSession(new SimulationKernel());

    session.pulse(input, [[signalA, 3]]).tick();
    expect(session.read(input).get(signalA)).toBe(3);

    session.tick();
    expect(session.read(input).get(signalA)).toBe(0);
  });

  it('keeps all reads on T while external writes commit at T+1', () => {
    const kernel = new SimulationKernel();
    kernel.addDevice({
      id: 'device:copy' as DeviceId,
      evaluate: (snapshot) => [{ networkId: output, values: snapshot.read(input) }],
    });
    const session = new TestSession(kernel);

    session.drive(input, [[signalA, 4]]).tick();
    expect(session.read(input).get(signalA)).toBe(4);
    expect(session.read(output).get(signalA)).toBe(0);

    session.tick();
    expect(session.read(output).get(signalA)).toBe(4);
  });

  it('copies caller-owned buses and rejects invalid tick counts', () => {
    const session = new TestSession(new SimulationKernel());
    const values = new SparseBus([[signalA, 8]]);
    session.drive(input, values);
    values.set(signalA, 99);

    session.tick();
    expect(session.read(input).get(signalA)).toBe(8);
    expect(() => session.tick(0)).toThrow('positive safe integer');
  });

  it('runs scheduled callbacks before their target boundary', () => {
    const session = new TestSession(new SimulationKernel());
    session.at(2, () => session.drive(input, [[signalA, 6]]));

    session.run(1);
    expect(session.read(input).get(signalA)).toBe(0);
    session.run(1);
    expect(session.currentTick).toBe(2);
    expect(session.read(input).get(signalA)).toBe(6);
    expect(() => session.at(2, () => undefined)).toThrow('later than current tick 2');
  });

  it('settles on observed whole-circuit state and reports non-convergence', () => {
    const stable = new TestSession(new SimulationKernel());
    expect(stable.settle({ maxTicks: 2 }).tick).toBe(1);

    const oscillatingKernel = new SimulationKernel();
    oscillatingKernel.addDevice({
      id: 'device:oscillator' as DeviceId,
      evaluate: (snapshot) => [
        {
          networkId: output,
          values: new SparseBus([[signalA, snapshot.read(output).get(signalA) === 0 ? 1 : 0]]),
        },
      ],
    });
    const oscillating = new TestSession(oscillatingKernel);
    expect(() => oscillating.settle({ maxTicks: 4 })).toThrow(
      'Circuit did not settle within 4 ticks.',
    );
  });
});

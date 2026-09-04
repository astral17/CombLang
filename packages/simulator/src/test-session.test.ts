import { SparseBus, signal } from '@comblang/factorio';
import type { DeviceId, NetworkId } from '@comblang/shared';
import { describe, expect, it } from 'vitest';

import { TestSession } from './test-session.js';
import { ValueSimulationKernel } from './value-kernel.js';
import { unknownBus } from './bus-value.js';
import { TestAssertionError } from './test-expectation.js';

const input = 'network:input' as NetworkId;
const output = 'network:output' as NetworkId;
const signalA = signal('virtual', 'signal-A');
const signalB = signal('virtual', 'signal-B');

describe('TestSession external drives', () => {
  it('replaces persistent drives, aggregates them with devices, and clears them', () => {
    const kernel = new ValueSimulationKernel();
    kernel.addDevice({
      id: 'device:constant' as DeviceId,
      evaluate: () => [
        {
          networkId: input,
          value: { kind: 'known', bus: new SparseBus([[signalA, 2]]) },
        },
      ],
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
    const session = new TestSession(new ValueSimulationKernel());

    session.pulse(input, [[signalA, 3]]).tick();
    expect(session.read(input).get(signalA)).toBe(3);

    session.tick();
    expect(session.read(input).get(signalA)).toBe(0);
  });

  it('keeps all reads on T while external writes commit at T+1', () => {
    const kernel = new ValueSimulationKernel();
    kernel.addDevice({
      id: 'device:copy' as DeviceId,
      evaluate: (snapshot) => [{ networkId: output, value: snapshot.read(input) }],
    });
    const session = new TestSession(kernel);

    session.drive(input, [[signalA, 4]]).tick();
    expect(session.read(input).get(signalA)).toBe(4);
    expect(session.read(output).get(signalA)).toBe(0);

    session.tick();
    expect(session.read(output).get(signalA)).toBe(4);
  });

  it('copies caller-owned buses and rejects invalid tick counts', () => {
    const session = new TestSession(new ValueSimulationKernel());
    const values = new SparseBus([[signalA, 8]]);
    session.drive(input, values);
    values.set(signalA, 99);

    session.tick();
    expect(session.read(input).get(signalA)).toBe(8);
    expect(() => session.tick(0)).toThrow('positive safe integer');
  });

  it('exposes Unknown values without pretending that they are empty buses', () => {
    const kernel = new ValueSimulationKernel();
    kernel.setInitialNetwork(
      input,
      unknownBus([{ id: 'object:1', description: 'unmodeled object output' }]),
    );
    const session = new TestSession(kernel);

    expect(session.readValue(input)).toMatchObject({
      kind: 'unknown',
      origins: [{ id: 'object:1' }],
    });
    expect(() => session.read(input)).toThrow(
      'Network is Unknown at tick 0: unmodeled object output.',
    );
  });

  it('asserts signal values, exact buses, containment, support, and emptiness', () => {
    const session = new TestSession(new ValueSimulationKernel());
    session.drive(input, [
      [signalA, 5],
      [signalB, -2],
    ]);
    session.tick();

    session.expectSignal(input, signalA).toBe(5);
    session.expect(session.signal(input, signalB)).toBe(-2);
    session.expect(input).toEqual([
      [signalA, 5],
      [signalB, -2],
    ]);
    session.expect(input).toContain([[signalA, 5]]);
    session.expect(input).toHaveSignal(signalB);
    session.expect(input).toHaveSignal(signalA, 5);
    session.expect(input).toHaveSupport(signalB, signalA);
    session.expect(input).toBeKnown();
    session.expect(output).toBeEmpty();
    session.expectSignal(output, signalA).toBe(0);
    expect(() => session.expect(output).toHaveSignal(signalA, 0)).toThrow(
      'zero is absent from a SparseBus',
    );
  });

  it('reports tick, target, expected value, and actual value on assertion failure', () => {
    const session = new TestSession(new ValueSimulationKernel());
    session.drive(input, [[signalA, 5]]).tick(2);

    let failure: unknown;
    try {
      session.expectSignal(input, signalA).toBe(6);
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(TestAssertionError);
    expect(failure).toMatchObject({
      details: {
        tick: 2,
        target: `Signal virtual\u0000signal-A\u0000 on Network ${input}`,
        matcher: 'toBe()',
        expected: '6',
        actual: '5',
      },
    });
  });

  it('includes deterministic Unknown dependency chains in assertion failures', () => {
    const kernel = new ValueSimulationKernel();
    kernel.setInitialNetwork(
      input,
      unknownBus([
        {
          id: 'object:1',
          description: 'unmodeled chest output',
          path: ['device:reader' as DeviceId],
        },
      ]),
    );
    const session = new TestSession(kernel);

    session.expect(input).toBeUnknown();
    session.expectSignal(input, signalA).toBeUnknown();
    expect(() => session.expectSignal(input, signalA).toBe(1)).toThrow(
      /Unknown origins:\n  - unmodeled chest output \[object:1\] via device:reader/,
    );
  });

  it('runs scheduled callbacks before their target boundary', () => {
    const session = new TestSession(new ValueSimulationKernel());
    session.at(2, () => session.drive(input, [[signalA, 6]]));

    session.run(1);
    expect(session.read(input).get(signalA)).toBe(0);
    session.run(1);
    expect(session.currentTick).toBe(2);
    expect(session.read(input).get(signalA)).toBe(6);
    expect(() => session.at(2, () => undefined)).toThrow('later than current tick 2');
  });

  it('poisons a partially applied callback boundary and retains committed reads and traces', () => {
    const session = new TestSession(new ValueSimulationKernel());
    const failure = new Error('scheduled stimulus failed');
    let calls = 0;
    let skippedCalls = 0;
    session
      .trace(input)
      .drive(input, [[signalA, 4]])
      .tick();
    const committed = session.snapshot;
    const trace = session.traces.toJSON();
    session.at(2, () => {
      calls += 1;
      session.drive(input, [[signalA, 99]]).pulse(output, [[signalB, 1]]);
      session.at(3, () => {
        skippedCalls += 1;
      });
      throw failure;
    });
    session.at(2, () => {
      skippedCalls += 1;
    });
    expect(() => session.run(5)).toThrow(failure);
    expect(session.snapshot).toBe(committed);
    expect(session.currentTick).toBe(1);
    session.expectSignal(input, signalA).toBe(4);
    session.expect(output).toBeEmpty();
    expect(session.traces.toJSON()).toEqual(trace);
    for (const mutate of [
      () => session.drive(input, []),
      () => session.clear(input),
      () => session.pulse(input, []),
      () => session.at(3, () => undefined),
      () => session.trace(output),
      () => session.tick(),
      () => session.run(1),
      () => session.settle({ maxTicks: 1 }),
    ]) {
      expect(mutate).toThrowError(
        expect.objectContaining({
          message: expect.stringContaining('TestSession failed at boundary 2;'),
          cause: failure,
        }),
      );
    }
    expect(calls).toBe(1);
    expect(skippedCalls).toBe(0);
    session.finish();
    session.finish();
    expect(session.read(input).get(signalA)).toBe(4);
  });

  it('retains a non-Error thrown value and seals even when the value is undefined', () => {
    const session = new TestSession(new ValueSimulationKernel());
    session.at(1, () => {
      throw undefined;
    });
    let caught = false;
    try {
      session.tick();
    } catch (error) {
      caught = true;
      expect(error).toBeUndefined();
    }
    expect(caught).toBe(true);
    expect(() => session.tick()).toThrow('TestSession failed at boundary 1;');
    expect(session.currentTick).toBe(0);
  });

  it('does not poison a session for validation or assertion failures outside a boundary', () => {
    const session = new TestSession(new ValueSimulationKernel());
    expect(() => session.tick(0)).toThrow('positive safe integer');
    expect(() => session.expectSignal(input, signalA).toBe(1)).toThrow(TestAssertionError);
    session.drive(input, [[signalA, 2]]).tick();
    expect(session.read(input).get(signalA)).toBe(2);
  });

  it('rejects reentrant time advancement from a scheduled callback', () => {
    for (const advance of [
      (session: TestSession) => session.tick(),
      (session: TestSession) => session.run(1),
      (session: TestSession) => session.settle({ maxTicks: 1 }),
    ]) {
      const session = new TestSession(new ValueSimulationKernel());
      session.at(1, () => advance(session));

      expect(() => session.tick()).toThrow(
        'TestSession time cannot be advanced from inside an active boundary.',
      );
      expect(session.currentTick).toBe(0);
    }
  });

  it('only allows callbacks to schedule work after the active boundary', () => {
    const session = new TestSession(new ValueSimulationKernel());
    let laterCallbackRan = false;
    session.at(1, () => {
      expect(() => session.at(1, () => undefined)).toThrow(
        'scheduled tick 1 must be later than active boundary 1.',
      );
      session.at(2, () => {
        laterCallbackRan = true;
      });
    });

    session.tick(2);
    expect(laterCallbackRan).toBe(true);
    expect(session.currentTick).toBe(2);
  });

  it('seals every mutating API after the session is finished', () => {
    const session = new TestSession(new ValueSimulationKernel());
    session.drive(input, [[signalA, 4]]).tick();
    session.finish();
    session.finish();

    expect(session.read(input).get(signalA)).toBe(4);
    expect(session.traces.toJSON().format).toBe('comblang-trace');
    for (const [operation, mutate] of [
      ['drive', () => session.drive(input, [])],
      ['clear', () => session.clear(input)],
      ['pulse', () => session.pulse(input, [])],
      ['at', () => session.at(2, () => undefined)],
      ['trace', () => session.trace(input)],
      ['tick', () => session.tick()],
      ['run', () => session.run(1)],
      ['settle', () => session.settle({ maxTicks: 1 })],
    ] as const) {
      expect(mutate).toThrow(`TestSession is finished; ${operation} cannot mutate it.`);
    }
    expect(session.currentTick).toBe(1);
  });

  it('settles on observed whole-circuit state and reports non-convergence', () => {
    const stable = new TestSession(new ValueSimulationKernel());
    expect(stable.settle({ maxTicks: 2 }).tick).toBe(1);

    const oscillatingKernel = new ValueSimulationKernel();
    oscillatingKernel.addDevice({
      id: 'device:oscillator' as DeviceId,
      evaluate: (snapshot) => {
        const current = snapshot.read(output);
        return [
          {
            networkId: output,
            value: {
              kind: 'known',
              bus: new SparseBus([
                [signalA, current.kind === 'known' && current.bus.get(signalA) === 0 ? 1 : 0],
              ]),
            },
          },
        ];
      },
    });
    const oscillating = new TestSession(oscillatingKernel);
    expect(() => oscillating.settle({ maxTicks: 4 })).toThrow(
      'Circuit did not settle within 4 ticks.',
    );
    expect(oscillating.currentTick).toBe(4);
    expect(oscillating.tick().tick).toBe(5);
  });
});

import { SparseBus, signal } from '@comblang/factorio';
import type { DeviceId, NetworkId } from '@comblang/shared';
import { describe, expect, it } from 'vitest';

import { SimulationKernel, type SynchronousDevice } from './kernel.js';

const input = 'network:input' as NetworkId;
const output = 'network:output' as NetworkId;
const signalA = signal('virtual', 'signal-A');

describe('snapshot tick kernel', () => {
  it('makes every device read T and commits all outputs at T+1', () => {
    const kernel = new SimulationKernel();
    const increment: SynchronousDevice = {
      id: 'device:increment' as DeviceId,
      evaluate(snapshot) {
        return [
          {
            networkId: output,
            values: new SparseBus([[signalA, snapshot.read(input).get(signalA) + 1]]),
          },
        ];
      },
    };

    kernel.addDevice(increment);
    kernel.setInitialNetwork(input, new SparseBus([[signalA, 41]]));

    expect(kernel.snapshot.read(output).get(signalA)).toBe(0);
    const next = kernel.step();
    expect(next.tick).toBe(1);
    expect(next.read(output).get(signalA)).toBe(42);

    const callerCopy = next.read(output);
    callerCopy.set(signalA, 0);
    expect(next.read(output).get(signalA)).toBe(42);
  });

  it('aggregates multiple producer outputs after evaluation', () => {
    const kernel = new SimulationKernel();
    for (const [id, value] of [
      ['device:first', 10],
      ['device:second', 20],
    ] as const) {
      kernel.addDevice({
        id: id as DeviceId,
        evaluate: () => [{ networkId: output, values: new SparseBus([[signalA, value]]) }],
      });
    }

    expect(kernel.step().read(output).get(signalA)).toBe(30);
  });
});

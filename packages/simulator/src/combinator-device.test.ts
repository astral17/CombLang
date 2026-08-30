import { signal, SparseBus } from '@comblang/factorio';
import type { DeviceId, NetworkId } from '@comblang/shared';
import { describe, expect, it } from 'vitest';

import {
  ArithmeticCombinatorDevice,
  ConstantCombinatorDevice,
  DeciderCombinatorDevice,
} from './combinator-device.js';
import { SimulationKernel } from './kernel.js';

const input = 'network:input' as NetworkId;
const secondInput = 'network:second-input' as NetworkId;
const output = 'network:output' as NetworkId;
const fanout = 'network:fanout' as NetworkId;
const a = signal('virtual', 'signal-A');

describe('combinator simulation devices', () => {
  it('aggregates selected input networks and broadcasts at T+1', () => {
    const kernel = new SimulationKernel();
    kernel.setInitialNetwork(input, new SparseBus([[a, 20]]));
    kernel.setInitialNetwork(secondInput, new SparseBus([[a, 22]]));
    kernel.addDevice(
      new ArithmeticCombinatorDevice({
        id: 'device:add-zero' as DeviceId,
        inputNetworks: { red: input, green: secondInput },
        outputNetworks: [output, fanout],
        combinator: {
          left: { kind: 'signal', signal: a },
          operation: 'add',
          right: { kind: 'constant', value: 0 },
          output: { kind: 'signal', signal: a },
        },
      }),
    );

    expect(kernel.snapshot.read(output).get(a)).toBe(0);
    expect(kernel.step().read(output).get(a)).toBe(42);
    expect(kernel.snapshot.read(fanout).get(a)).toBe(42);
  });

  it('evaluates a decider from T and exposes its output at T+1', () => {
    const kernel = new SimulationKernel();
    kernel.setInitialNetwork(input, new SparseBus([[a, 5]]));
    kernel.addDevice(
      new DeciderCombinatorDevice({
        id: 'device:positive' as DeviceId,
        inputNetworks: { red: input },
        outputNetworks: [output],
        combinator: {
          condition: {
            kind: 'compare',
            left: { kind: 'signal', signal: a },
            comparator: '>',
            right: { kind: 'constant', value: 0 },
          },
          outputs: [
            {
              mode: 'constant',
              signal: { kind: 'signal', signal: a },
              value: 1,
            },
          ],
        },
      }),
    );

    expect(kernel.snapshot.read(output).get(a)).toBe(0);
    expect(kernel.step().read(output).get(a)).toBe(1);
  });

  it('broadcasts constant combinator values every tick', () => {
    const kernel = new SimulationKernel();
    kernel.addDevice(
      new ConstantCombinatorDevice({
        id: 'device:constant' as DeviceId,
        outputNetworks: [output, fanout],
        values: new SparseBus([[a, 5]]),
      }),
    );

    expect(kernel.snapshot.read(output).get(a)).toBe(0);
    expect(kernel.step().read(output).get(a)).toBe(5);
    expect(kernel.step().read(fanout).get(a)).toBe(5);
  });
});

import { signal, SparseBus } from '@comblang/factorio';
import type { DeviceId, NetworkId } from '@comblang/shared';
import { describe, expect, it } from 'vitest';

import {
  ArithmeticCombinatorDevice,
  ArithmeticValueCombinatorDevice,
  ConstantCombinatorDevice,
  DeciderCombinatorDevice,
  DeciderValueCombinatorDevice,
} from './combinator-device.js';
import { knownBus, unknownBus } from './bus-value.js';
import { SimulationKernel } from './kernel.js';
import { ValueSimulationKernel } from './value-kernel.js';

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

  it('propagates Unknown through an arithmetic combinator', () => {
    const kernel = new ValueSimulationKernel();
    kernel.setInitialNetwork(
      input,
      unknownBus([{ id: 'object:1', description: 'unmodeled object' }]),
    );
    kernel.addDevice(
      new ArithmeticValueCombinatorDevice({
        id: 'device:add-zero' as DeviceId,
        inputNetworks: { red: input },
        outputNetworks: [output],
        combinator: {
          left: { kind: 'signal', signal: a },
          operation: 'add',
          right: { kind: 'constant', value: 0 },
          output: { kind: 'signal', signal: a },
        },
      }),
    );

    expect(kernel.step().read(output)).toEqual({
      kind: 'unknown',
      origins: [
        {
          id: 'object:1',
          description: 'unmodeled object',
          path: ['device:add-zero'],
        },
      ],
    });
  });

  it('does not propagate an Unknown wire that the arithmetic config does not read', () => {
    const kernel = new ValueSimulationKernel();
    kernel.setInitialNetwork(
      input,
      unknownBus([{ id: 'object:1', description: 'unmodeled object' }]),
    );
    kernel.setInitialNetwork(secondInput, knownBus(new SparseBus([[a, 7]])));
    kernel.addDevice(
      new ArithmeticValueCombinatorDevice({
        id: 'device:green-only' as DeviceId,
        inputNetworks: { red: input, green: secondInput },
        outputNetworks: [output],
        combinator: {
          left: { kind: 'signal', signal: a, networks: { red: false, green: true } },
          operation: 'add',
          right: { kind: 'constant', value: 1 },
          output: { kind: 'signal', signal: a },
        },
      }),
    );

    const value = kernel.step().read(output);
    expect(value.kind).toBe('known');
    if (value.kind === 'known') expect(value.bus.get(a)).toBe(8);
  });

  it('propagates Unknown through a decider condition', () => {
    const kernel = new ValueSimulationKernel();
    kernel.setInitialNetwork(
      input,
      unknownBus([{ id: 'object:1', description: 'unmodeled object' }]),
    );
    kernel.addDevice(
      new DeciderValueCombinatorDevice({
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

    expect(kernel.step().read(output)).toMatchObject({
      kind: 'unknown',
      origins: [{ id: 'object:1', path: ['device:positive'] }],
    });
  });
});

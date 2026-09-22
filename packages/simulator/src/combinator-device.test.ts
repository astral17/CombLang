import {
  canonicalizeConstantConfiguration,
  constantConfigurationFromOutputs,
  signal,
  SparseBus,
  UnsupportedConstantConfigurationError,
} from '@comblang/factorio';
import type { DeviceId, NetworkId } from '@comblang/shared';
import { describe, expect, it } from 'vitest';

import {
  ArithmeticCombinatorDevice,
  ArithmeticValueCombinatorDevice,
  ConstantCombinatorDevice,
  ConstantValueCombinatorDevice,
  DeciderCombinatorDevice,
  DeciderValueCombinatorDevice,
  SelectorCombinatorDevice,
} from './combinator-device.js';
import { knownBus, unknownBus } from './bus-value.js';
import { SimulationKernel } from './kernel.js';
import { ValueSimulationKernel } from './value-kernel.js';

const input = 'network:input' as NetworkId;
const secondInput = 'network:second-input' as NetworkId;
const output = 'network:output' as NetworkId;
const fanout = 'network:fanout' as NetworkId;
const a = signal('virtual', 'signal-A');
const b = signal('virtual', 'signal-B');

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
        configuration: constantConfigurationFromOutputs([{ signal: a, value: 5 }]),
      }),
    );

    expect(kernel.snapshot.read(output).get(a)).toBe(0);
    expect(kernel.step().read(output).get(a)).toBe(5);
    expect(kernel.step().read(fanout).get(a)).toBe(5);
  });

  it('rejects unsupported Constant sections in the sparse-bus kernel', () => {
    const kernel = new SimulationKernel();
    kernel.addDevice(
      new ConstantCombinatorDevice({
        id: 'device:unsupported-constant' as DeviceId,
        outputNetworks: [output],
        configuration: canonicalizeConstantConfiguration({
          sections: [{ group: 'backup', multiplier: 1.5, filters: [{ signal: a, value: 5 }] }],
        }),
      }),
    );

    expect(() => kernel.step()).toThrowError(UnsupportedConstantConfigurationError);
    try {
      kernel.step();
      expect.fail('Expected sparse-bus Constant evaluation to reject the configuration.');
    } catch (error) {
      expect(error).toMatchObject({
        code: 'FC1003',
        reasons: ['non-unit-multiplier', 'group'],
      });
    }
  });

  it('evaluates a Selector from T and exposes its selected row at T+1', () => {
    const kernel = new SimulationKernel();
    kernel.setInitialNetwork(
      input,
      new SparseBus([
        [a, 4],
        [b, 2],
      ]),
    );
    kernel.addDevice(
      new SelectorCombinatorDevice({
        id: 'device:selector' as DeviceId,
        inputNetworks: { red: input },
        outputNetworks: [output],
        combinator: { operation: 'select', index: 1 },
      }),
    );

    expect(kernel.snapshot.read(output).get(a)).toBe(0);
    expect(kernel.snapshot.read(output).get(b)).toBe(0);
    const next = kernel.step();
    expect(next.tick).toBe(1);
    expect(next.read(output).get(a)).toBe(0);
    expect(next.read(output).get(b)).toBe(2);
  });

  it('broadcasts the same Constant configuration through the value kernel', () => {
    const kernel = new ValueSimulationKernel();
    kernel.addDevice(
      new ConstantValueCombinatorDevice({
        id: 'device:value-constant' as DeviceId,
        outputNetworks: [output],
        configuration: constantConfigurationFromOutputs([
          { signal: a, value: 5 },
          { signal: a, value: -2 },
        ]),
      }),
    );

    const value = kernel.step().read(output);
    expect(value.kind).toBe('known');
    if (value.kind === 'known') expect(value.bus.get(a)).toBe(3);
  });

  it('returns stable Unknown provenance for unsupported Constant sections', () => {
    const kernel = new ValueSimulationKernel();
    kernel.addDevice(
      new ConstantValueCombinatorDevice({
        id: 'device:value-unsupported-constant' as DeviceId,
        outputNetworks: [output],
        configuration: canonicalizeConstantConfiguration({
          sections: [{ group: 'backup', multiplier: 1.5, filters: [{ signal: a, value: 5 }] }],
        }),
      }),
    );

    expect(kernel.step().read(output)).toEqual({
      kind: 'unknown',
      origins: [
        {
          id: 'unmodeled:device:value-unsupported-constant:constant-configuration',
          description:
            'Unmodeled Constant configuration for device:value-unsupported-constant: non-unit-multiplier, group.',
          path: [],
        },
      ],
    });
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

  it('does not propagate Unknown from the inactive decider branch', () => {
    const kernel = new ValueSimulationKernel();
    kernel.setInitialNetwork(
      input,
      unknownBus([{ id: 'object:1', description: 'unmodeled object' }]),
    );
    kernel.setInitialNetwork(secondInput, knownBus(new SparseBus([[a, 0]])));
    kernel.addDevice(
      new DeciderValueCombinatorDevice({
        id: 'device:branch-aware' as DeviceId,
        inputNetworks: { red: input, green: secondInput },
        outputNetworks: [output],
        combinator: {
          condition: {
            kind: 'compare',
            left: { kind: 'signal', signal: a, networks: { red: false, green: true } },
            comparator: '>',
            right: { kind: 'constant', value: 0 },
          },
          outputs: [
            {
              mode: 'copy',
              signal: { kind: 'signal', signal: b },
              networks: { red: true, green: false },
            },
          ],
          elseOutputs: [{ mode: 'constant', signal: { kind: 'signal', signal: a }, value: 123 }],
        },
      }),
    );

    const value = kernel.step().read(output);
    expect(value.kind).toBe('known');
    if (value.kind === 'known') expect(value.bus.get(a)).toBe(123);
  });

  it('short-circuits three-valued AND and OR conditions', () => {
    for (const [kind, knownValue, expected] of [
      ['and', 0, 11],
      ['or', 1, 22],
    ] as const) {
      const kernel = new ValueSimulationKernel();
      kernel.setInitialNetwork(
        input,
        unknownBus([{ id: 'object:1', description: 'unmodeled object' }]),
      );
      kernel.setInitialNetwork(secondInput, knownBus(new SparseBus([[a, knownValue]])));
      kernel.addDevice(
        new DeciderValueCombinatorDevice({
          id: `device:${kind}` as DeviceId,
          inputNetworks: { red: input, green: secondInput },
          outputNetworks: [output],
          combinator: {
            condition: {
              kind,
              conditions: [
                {
                  kind: 'compare',
                  left: { kind: 'signal', signal: a, networks: { red: false, green: true } },
                  comparator: '>',
                  right: { kind: 'constant', value: 0 },
                },
                {
                  kind: 'compare',
                  left: { kind: 'signal', signal: a, networks: { red: true, green: false } },
                  comparator: '>',
                  right: { kind: 'constant', value: 0 },
                },
              ],
            },
            outputs: [{ mode: 'constant', signal: { kind: 'signal', signal: a }, value: 22 }],
            elseOutputs: [{ mode: 'constant', signal: { kind: 'signal', signal: a }, value: 11 }],
          },
        }),
      );

      const value = kernel.step().read(output);
      expect(value.kind).toBe('known');
      if (value.kind === 'known') expect(value.bus.get(a)).toBe(expected);
    }
  });
});

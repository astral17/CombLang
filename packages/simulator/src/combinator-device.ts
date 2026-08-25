import { SparseBus } from '@comblang/factorio';
import type { DeviceId, NetworkId } from '@comblang/shared';

import { evaluateArithmetic, type ArithmeticCombinatorConfig } from './arithmetic.js';
import type { CircuitInput } from './circuit-input.js';
import { evaluateDecider, type DeciderCombinatorConfig } from './decider.js';
import type { NetworkOutput, SimulationReader, SynchronousDevice } from './kernel.js';

export interface InputConnectorNetworks {
  readonly red?: NetworkId;
  readonly green?: NetworkId;
}

interface DeviceNetworks {
  readonly id: DeviceId;
  readonly inputNetworks: InputConnectorNetworks;
  readonly outputNetworks: readonly NetworkId[];
}

export interface ArithmeticDeviceConfig extends DeviceNetworks {
  readonly combinator: ArithmeticCombinatorConfig;
}

export interface DeciderDeviceConfig extends DeviceNetworks {
  readonly combinator: DeciderCombinatorConfig;
}

export interface ConstantDeviceConfig {
  readonly id: DeviceId;
  readonly outputNetworks: readonly NetworkId[];
  readonly values: SparseBus;
}

function validateNetworks(config: DeviceNetworks): void {
  if (
    config.inputNetworks.red !== undefined &&
    config.inputNetworks.red === config.inputNetworks.green
  ) {
    throw new Error(`Device ${config.id} cannot read one logical network as both wire colors.`);
  }
  if (new Set(config.outputNetworks).size !== config.outputNetworks.length) {
    throw new Error(`Device ${config.id} has duplicate output networks.`);
  }
}

function readInputs(snapshot: SimulationReader, networkIds: InputConnectorNetworks): CircuitInput {
  return {
    red: networkIds.red === undefined ? new SparseBus() : snapshot.read(networkIds.red),
    green: networkIds.green === undefined ? new SparseBus() : snapshot.read(networkIds.green),
  };
}

function broadcast(values: SparseBus, networkIds: readonly NetworkId[]): NetworkOutput[] {
  return networkIds.map((networkId) => ({ networkId, values: values.clone() }));
}

export class ArithmeticCombinatorDevice implements SynchronousDevice {
  readonly id: DeviceId;
  readonly #config: ArithmeticDeviceConfig;

  constructor(config: ArithmeticDeviceConfig) {
    validateNetworks(config);
    this.id = config.id;
    this.#config = config;
  }

  evaluate(snapshot: SimulationReader): readonly NetworkOutput[] {
    const input = readInputs(snapshot, this.#config.inputNetworks);
    return broadcast(
      evaluateArithmetic(this.#config.combinator, input),
      this.#config.outputNetworks,
    );
  }
}

export class DeciderCombinatorDevice implements SynchronousDevice {
  readonly id: DeviceId;
  readonly #config: DeciderDeviceConfig;

  constructor(config: DeciderDeviceConfig) {
    validateNetworks(config);
    this.id = config.id;
    this.#config = config;
  }

  evaluate(snapshot: SimulationReader): readonly NetworkOutput[] {
    const input = readInputs(snapshot, this.#config.inputNetworks);
    return broadcast(evaluateDecider(this.#config.combinator, input), this.#config.outputNetworks);
  }
}

export class ConstantCombinatorDevice implements SynchronousDevice {
  readonly id: DeviceId;
  readonly #config: ConstantDeviceConfig;

  constructor(config: ConstantDeviceConfig) {
    validateNetworks({ ...config, inputNetworks: {} });
    this.id = config.id;
    this.#config = { ...config, values: config.values.clone() };
  }

  evaluate(_snapshot: SimulationReader): readonly NetworkOutput[] {
    return broadcast(this.#config.values, this.#config.outputNetworks);
  }
}

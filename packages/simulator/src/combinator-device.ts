import { readsGreen, readsRed, SparseBus, type CircuitNetworkSelection } from '@comblang/factorio';
import type { DeviceId, NetworkId } from '@comblang/shared';

import { evaluateArithmetic, type ArithmeticCombinatorConfig } from './arithmetic.js';
import type { CircuitInput } from './circuit-input.js';
import { evaluateDecider, type DeciderCombinatorConfig } from './decider.js';
import type { NetworkOutput, SimulationReader, SynchronousDevice } from './kernel.js';
import { aggregateBusValues, knownBus, throughDevice, type BusValue } from './bus-value.js';
import type {
  ValueNetworkOutput,
  ValueSimulationReader,
  ValueSynchronousDevice,
} from './value-kernel.js';

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

interface ValueCircuitInput {
  readonly red: BusValue;
  readonly green: BusValue;
}

function readValueInputs(
  snapshot: ValueSimulationReader,
  networkIds: InputConnectorNetworks,
): ValueCircuitInput {
  return {
    red: networkIds.red === undefined ? knownBus() : snapshot.read(networkIds.red),
    green: networkIds.green === undefined ? knownBus() : snapshot.read(networkIds.green),
  };
}

function selectedValues(
  input: ValueCircuitInput,
  selections: readonly (CircuitNetworkSelection | undefined)[],
): BusValue[] {
  const result: BusValue[] = [];
  if (selections.some((selection) => readsRed(selection))) result.push(input.red);
  if (selections.some((selection) => readsGreen(selection))) result.push(input.green);
  return result;
}

function concreteInput(input: ValueCircuitInput): CircuitInput {
  return {
    red: input.red.kind === 'known' ? input.red.bus : new SparseBus(),
    green: input.green.kind === 'known' ? input.green.bus : new SparseBus(),
  };
}

function valueBroadcast(value: BusValue, networkIds: readonly NetworkId[]): ValueNetworkOutput[] {
  return networkIds.map((networkId) => ({ networkId, value }));
}

function conditionSelections(
  condition: DeciderCombinatorConfig['condition'],
): (CircuitNetworkSelection | undefined)[] {
  if (condition.kind === 'and' || condition.kind === 'or') {
    return condition.conditions.flatMap(conditionSelections);
  }
  return [
    condition.left.networks,
    ...(condition.right.kind === 'constant' ? [] : [condition.right.networks]),
  ];
}

function outputSelections(
  outputs: readonly DeciderCombinatorConfig['outputs'][number][],
): (CircuitNetworkSelection | undefined)[] {
  return outputs
    .filter(
      (output) =>
        output.mode === 'copy' ||
        (output.signal.kind === 'wildcard' && output.signal.value !== 'each'),
    )
    .map((output) => output.networks);
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

export class ArithmeticValueCombinatorDevice implements ValueSynchronousDevice {
  readonly id: DeviceId;
  readonly #config: ArithmeticDeviceConfig;

  constructor(config: ArithmeticDeviceConfig) {
    validateNetworks(config);
    this.id = config.id;
    this.#config = config;
  }

  evaluate(snapshot: ValueSimulationReader): readonly ValueNetworkOutput[] {
    const input = readValueInputs(snapshot, this.#config.inputNetworks);
    const selections = [this.#config.combinator.left, this.#config.combinator.right]
      .filter((operand) => operand.kind !== 'constant')
      .map((operand) => operand.networks);
    const dependency = aggregateBusValues(selectedValues(input, selections));
    const output =
      dependency.kind === 'unknown'
        ? throughDevice(dependency, this.id)
        : knownBus(evaluateArithmetic(this.#config.combinator, concreteInput(input)));
    return valueBroadcast(output, this.#config.outputNetworks);
  }
}

export class DeciderValueCombinatorDevice implements ValueSynchronousDevice {
  readonly id: DeviceId;
  readonly #config: DeciderDeviceConfig;

  constructor(config: DeciderDeviceConfig) {
    validateNetworks(config);
    this.id = config.id;
    this.#config = config;
  }

  evaluate(snapshot: ValueSimulationReader): readonly ValueNetworkOutput[] {
    const input = readValueInputs(snapshot, this.#config.inputNetworks);
    const selections = [
      ...conditionSelections(this.#config.combinator.condition),
      ...outputSelections(this.#config.combinator.outputs),
      ...outputSelections(this.#config.combinator.elseOutputs ?? []),
    ];
    const dependency = aggregateBusValues(selectedValues(input, selections));
    const output =
      dependency.kind === 'unknown'
        ? throughDevice(dependency, this.id)
        : knownBus(evaluateDecider(this.#config.combinator, concreteInput(input)));
    return valueBroadcast(output, this.#config.outputNetworks);
  }
}

export class ConstantValueCombinatorDevice implements ValueSynchronousDevice {
  readonly id: DeviceId;
  readonly #config: ConstantDeviceConfig;

  constructor(config: ConstantDeviceConfig) {
    validateNetworks({ ...config, inputNetworks: {} });
    this.id = config.id;
    this.#config = { ...config, values: config.values.clone() };
  }

  evaluate(_snapshot: ValueSimulationReader): readonly ValueNetworkOutput[] {
    return valueBroadcast(knownBus(this.#config.values), this.#config.outputNetworks);
  }
}

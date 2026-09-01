import { SparseBus } from '@comblang/factorio';
import type { DeviceId, NetworkId } from '@comblang/shared';

import { aggregateBusValues, cloneBusValue, knownBus, type BusValue } from './bus-value.js';

export interface ValueNetworkOutput {
  readonly networkId: NetworkId;
  readonly value: BusValue;
}

export interface ValueSimulationReader {
  readonly tick: number;
  read(networkId: NetworkId): BusValue;
}

export interface ValueSynchronousDevice {
  readonly id: DeviceId;
  evaluate(snapshot: ValueSimulationReader): readonly ValueNetworkOutput[];
}

export interface ValueSimulationSnapshot extends ValueSimulationReader {
  readonly networkIds: readonly NetworkId[];
}

function makeSnapshot(
  tick: number,
  networks: ReadonlyMap<NetworkId, BusValue>,
): ValueSimulationSnapshot {
  const values = new Map(
    [...networks].map(([networkId, value]) => [networkId, cloneBusValue(value)] as const),
  );
  return Object.freeze({
    tick,
    networkIds: Object.freeze([...values.keys()]),
    read(networkId: NetworkId) {
      return cloneBusValue(values.get(networkId) ?? knownBus(new SparseBus()));
    },
  });
}

/** Opt-in whole-bus Known/Unknown kernel used by test sessions. */
export class ValueSimulationKernel {
  readonly #devices: ValueSynchronousDevice[] = [];
  #networks = new Map<NetworkId, BusValue>();
  #snapshot: ValueSimulationSnapshot = makeSnapshot(0, new Map());
  #stepping = false;

  get snapshot(): ValueSimulationSnapshot {
    return this.#snapshot;
  }

  addDevice(device: ValueSynchronousDevice): void {
    if (this.#stepping) {
      throw new Error('Value-simulation devices cannot be added during participant evaluation.');
    }
    if (this.#devices.some((candidate) => candidate.id === device.id)) {
      throw new Error(`Duplicate value-simulation device ID: ${device.id}`);
    }
    this.#devices.push(device);
  }

  setInitialNetwork(networkId: NetworkId, value: BusValue): void {
    if (this.#stepping) {
      throw new Error('Initial network values cannot change during participant evaluation.');
    }
    if (this.#snapshot.tick !== 0) {
      throw new Error('Initial network values can only be set before the first tick.');
    }
    this.#networks.set(networkId, cloneBusValue(value));
    this.#snapshot = makeSnapshot(0, this.#networks);
  }

  step(): ValueSimulationSnapshot {
    if (this.#stepping) throw new Error('ValueSimulationKernel.step() is not reentrant.');
    const previous = this.#snapshot;
    const contributions = new Map<NetworkId, BusValue[]>();
    this.#stepping = true;
    try {
      for (const device of this.#devices) {
        for (const output of device.evaluate(previous)) {
          const values = contributions.get(output.networkId) ?? [];
          values.push(output.value);
          contributions.set(output.networkId, values);
        }
      }
    } finally {
      this.#stepping = false;
    }

    const nextNetworks = new Map<NetworkId, BusValue>();
    for (const [networkId, values] of contributions) {
      nextNetworks.set(networkId, aggregateBusValues(values));
    }
    this.#networks = nextNetworks;
    this.#snapshot = makeSnapshot(previous.tick + 1, nextNetworks);
    return this.#snapshot;
  }
}

import { aggregateBuses, SparseBus } from '@comblang/factorio';
import type { DeviceId, NetworkId } from '@comblang/shared';

export interface NetworkOutput {
  readonly networkId: NetworkId;
  readonly values: SparseBus;
}

export interface SimulationReader {
  readonly tick: number;
  read(networkId: NetworkId): SparseBus;
}

export interface SynchronousDevice {
  readonly id: DeviceId;
  evaluate(snapshot: SimulationReader): readonly NetworkOutput[];
}

export interface SimulationSnapshot extends SimulationReader {
  readonly networkIds: readonly NetworkId[];
}

function makeSnapshot(
  tick: number,
  networks: ReadonlyMap<NetworkId, SparseBus>,
): SimulationSnapshot {
  const values = new Map(
    [...networks].map(([networkId, bus]) => [networkId, bus.clone()] as const),
  );

  return Object.freeze({
    tick,
    networkIds: Object.freeze([...values.keys()]),
    read(networkId: NetworkId) {
      return values.get(networkId)?.clone() ?? new SparseBus();
    },
  });
}

export class SimulationKernel {
  readonly #devices: SynchronousDevice[] = [];
  #networks = new Map<NetworkId, SparseBus>();
  #snapshot: SimulationSnapshot = makeSnapshot(0, new Map());

  get snapshot(): SimulationSnapshot {
    return this.#snapshot;
  }

  addDevice(device: SynchronousDevice): void {
    if (this.#devices.some((candidate) => candidate.id === device.id)) {
      throw new Error(`Duplicate simulation device ID: ${device.id}`);
    }
    this.#devices.push(device);
  }

  setInitialNetwork(networkId: NetworkId, values: SparseBus): void {
    if (this.#snapshot.tick !== 0) {
      throw new Error('Initial network values can only be set before the first tick.');
    }
    this.#networks.set(networkId, values.clone());
    this.#snapshot = makeSnapshot(0, this.#networks);
  }

  step(): SimulationSnapshot {
    const previous = this.#snapshot;
    const contributions = new Map<NetworkId, SparseBus[]>();

    for (const device of this.#devices) {
      for (const output of device.evaluate(previous)) {
        const buses = contributions.get(output.networkId) ?? [];
        buses.push(output.values);
        contributions.set(output.networkId, buses);
      }
    }

    const nextNetworks = new Map<NetworkId, SparseBus>();
    for (const [networkId, buses] of contributions) {
      nextNetworks.set(networkId, aggregateBuses(buses));
    }

    this.#networks = nextNetworks;
    this.#snapshot = makeSnapshot(previous.tick + 1, this.#networks);
    return this.#snapshot;
  }
}

import { SparseBus, type SignalId } from '@comblang/factorio';
import type { DeviceId, NetworkId } from '@comblang/shared';

import { SimulationKernel, type SimulationSnapshot, type SynchronousDevice } from './kernel.js';

export type TestBusInput = SparseBus | Iterable<readonly [signal: SignalId, value: number]>;

export interface TestSessionOptions<Target> {
  readonly resolveNetwork: (target: Target) => NetworkId;
}

export interface SettleOptions {
  readonly maxTicks: number;
}

function copyBus(values: TestBusInput): SparseBus {
  return values instanceof SparseBus ? values.clone() : new SparseBus(values);
}

function snapshotKey(snapshot: SimulationSnapshot): string {
  return JSON.stringify(
    [...snapshot.networkIds]
      .sort()
      .map((networkId) => [networkId, snapshot.read(networkId).toJSON()]),
  );
}

function positiveCount(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`${label} must be a positive safe integer.`);
  }
  return value;
}

/**
 * A mutable test environment around one already-built SimulationKernel.
 *
 * Test operations only control an external broadcaster. They never add circuit
 * topology after construction and never re-run source elaboration.
 */
export class TestSession<Target = NetworkId> {
  readonly #kernel: SimulationKernel;
  readonly #resolveNetwork: (target: Target) => NetworkId;
  readonly #drives = new Map<NetworkId, SparseBus>();
  readonly #pulses = new Map<NetworkId, SparseBus>();
  readonly #scheduled = new Map<number, (() => void)[]>();

  constructor(kernel: SimulationKernel, options?: TestSessionOptions<Target>) {
    this.#kernel = kernel;
    this.#resolveNetwork =
      options?.resolveNetwork ?? ((target: Target) => target as unknown as NetworkId);

    const externalSource: SynchronousDevice = {
      id: 'testbench:external-source' as DeviceId,
      evaluate: () => [
        ...[...this.#drives].map(([networkId, values]) => ({ networkId, values })),
        ...[...this.#pulses].map(([networkId, values]) => ({ networkId, values })),
      ],
    };
    this.#kernel.addDevice(externalSource);
  }

  get snapshot(): SimulationSnapshot {
    return this.#kernel.snapshot;
  }

  get currentTick(): number {
    return this.#kernel.snapshot.tick;
  }

  read(target: Target): SparseBus {
    return this.#kernel.snapshot.read(this.#networkId(target));
  }

  drive(target: Target, values: TestBusInput): this {
    this.#drives.set(this.#networkId(target), copyBus(values));
    return this;
  }

  clear(target: Target): this {
    const networkId = this.#networkId(target);
    this.#drives.delete(networkId);
    this.#pulses.delete(networkId);
    return this;
  }

  pulse(target: Target, values: TestBusInput): this {
    this.#pulses.set(this.#networkId(target), copyBus(values));
    return this;
  }

  at(tick: number, callback: () => void): this {
    positiveCount(tick, 'scheduled tick');
    if (tick <= this.currentTick) {
      throw new RangeError(
        `scheduled tick ${tick} must be later than current tick ${this.currentTick}.`,
      );
    }
    const callbacks = this.#scheduled.get(tick) ?? [];
    callbacks.push(callback);
    this.#scheduled.set(tick, callbacks);
    return this;
  }

  tick(count = 1): SimulationSnapshot {
    positiveCount(count, 'tick count');

    let snapshot = this.#kernel.snapshot;
    for (let index = 0; index < count; index += 1) {
      const nextTick = snapshot.tick + 1;
      const callbacks = this.#scheduled.get(nextTick) ?? [];
      this.#scheduled.delete(nextTick);
      for (const callback of callbacks) callback();
      snapshot = this.#kernel.step();
      this.#pulses.clear();
    }
    return snapshot;
  }

  run(count: number): SimulationSnapshot {
    return this.tick(count);
  }

  settle({ maxTicks }: SettleOptions): SimulationSnapshot {
    positiveCount(maxTicks, 'settle maxTicks');
    let previousKey = snapshotKey(this.#kernel.snapshot);
    for (let elapsed = 0; elapsed < maxTicks; elapsed += 1) {
      const snapshot = this.tick();
      const currentKey = snapshotKey(snapshot);
      if (currentKey === previousKey) return snapshot;
      previousKey = currentKey;
    }
    throw new Error(`Circuit did not settle within ${maxTicks} ticks.`);
  }

  #networkId(target: Target): NetworkId {
    return this.#resolveNetwork(target);
  }
}

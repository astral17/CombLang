import { SparseBus, type SignalId } from '@comblang/factorio';
import type { DeviceId, NetworkId } from '@comblang/shared';

import { aggregateBusValues, knownBus, throughDevice, type BusValue } from './bus-value.js';
import {
  bindCircuitObject,
  type BoundCircuitObject,
  type CircuitObjectAdapter,
} from './object-adapter.js';
import {
  ValueSimulationKernel,
  type ValueSimulationSnapshot,
  type ValueSynchronousDevice,
} from './value-kernel.js';
import {
  NetworkExpectation,
  SignalExpectation,
  type TestSignalTarget,
} from './test-expectation.js';
import { networkTraceTarget, signalTraceTarget, TraceStore } from './trace.js';

export type TestBusInput = SparseBus | Iterable<readonly [signal: SignalId, value: number]>;

export interface TestSessionOptions<Target> {
  readonly resolveNetwork: (target: Target) => NetworkId;
}

export interface SettleOptions {
  readonly maxTicks: number;
}

export interface TestObjectHandle<Name extends string = string> {
  readonly kind: 'test-object';
  readonly id: DeviceId;
  readonly adapterId: string;
  readonly instanceId: string;
  readonly connectors: readonly Name[];
}

function copyBus(values: TestBusInput): SparseBus {
  return values instanceof SparseBus ? values.clone() : new SparseBus(values);
}

function snapshotKey(snapshot: ValueSimulationSnapshot): string {
  return JSON.stringify(
    [...snapshot.networkIds].sort().map((networkId) => {
      const value = snapshot.read(networkId);
      return [networkId, value.kind === 'known' ? value.bus.toJSON() : value];
    }),
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
  readonly traces = new TraceStore();
  readonly #kernel: ValueSimulationKernel;
  readonly #resolveNetwork: (target: Target) => NetworkId;
  readonly #drives = new Map<NetworkId, SparseBus>();
  readonly #pulses = new Map<NetworkId, SparseBus>();
  readonly #scheduled = new Map<number, (() => void)[]>();
  readonly #objects = new WeakMap<object, BoundCircuitObject<string>>();
  readonly #objectIds = new Set<DeviceId>();
  #advancing = false;
  #activeBoundary: number | undefined;

  constructor(kernel: ValueSimulationKernel, options?: TestSessionOptions<Target>) {
    this.#kernel = kernel;
    this.#resolveNetwork =
      options?.resolveNetwork ?? ((target: Target) => target as unknown as NetworkId);

    const externalSource: ValueSynchronousDevice = {
      id: 'testbench:external-source' as DeviceId,
      evaluate: () => [
        ...[...this.#drives].map(([networkId, values]) => ({
          networkId,
          value: knownBus(values),
        })),
        ...[...this.#pulses].map(([networkId, values]) => ({
          networkId,
          value: knownBus(values),
        })),
      ],
    };
    this.#kernel.addDevice(externalSource);
  }

  get snapshot(): ValueSimulationSnapshot {
    return this.#kernel.snapshot;
  }

  get currentTick(): number {
    return this.#kernel.snapshot.tick;
  }

  read(target: Target): SparseBus {
    const value = this.readValue(target);
    if (value.kind === 'unknown') {
      throw new Error(
        `Network is Unknown at tick ${this.currentTick}: ${value.origins
          .map((origin) => origin.description)
          .join(', ')}.`,
      );
    }
    return value.bus;
  }

  readValue(target: Target): BusValue {
    return this.#kernel.snapshot.read(this.#networkId(target));
  }

  signal(target: Target, signal: SignalId): TestSignalTarget<Target> {
    return Object.freeze({ kind: 'test-signal', network: target, signal });
  }

  expect(target: Target): NetworkExpectation;
  expect(target: TestSignalTarget<Target>): SignalExpectation;
  expect(target: Target | TestSignalTarget<Target>): NetworkExpectation | SignalExpectation {
    if (this.#isSignalTarget(target)) {
      return this.expectSignal(target.network, target.signal);
    }
    return new NetworkExpectation(this.#assertionContext(), this.#networkId(target));
  }

  expectSignal(target: Target, signal: SignalId): SignalExpectation {
    return new SignalExpectation(this.#assertionContext(), this.#networkId(target), signal);
  }

  trace(...targets: readonly (Target | TestSignalTarget<Target>)[]): this {
    for (const target of targets) {
      if (this.#isSignalTarget(target)) {
        this.traces.register(
          signalTraceTarget(this.#networkId(target.network), target.signal),
          this.#kernel.snapshot,
        );
      } else {
        this.traces.register(networkTraceTarget(this.#networkId(target)), this.#kernel.snapshot);
      }
    }
    return this;
  }

  adaptObject<Instance, Name extends string>(
    adapter: CircuitObjectAdapter<Instance, Name>,
    instance: Instance,
  ): TestObjectHandle<Name> {
    if (this.currentTick !== 0) {
      throw new Error('Circuit object adapters must be registered before the first tick.');
    }
    const object = bindCircuitObject(adapter, instance);
    if (this.#objectIds.has(object.id)) {
      throw new Error(
        `Duplicate circuit object instance: ${object.adapterId}:${object.instanceId}.`,
      );
    }
    const handle = Object.freeze({
      kind: 'test-object' as const,
      id: object.id,
      adapterId: object.adapterId,
      instanceId: object.instanceId,
      connectors: Object.freeze(object.connectors.map(({ name }) => name)),
    });
    this.#objectIds.add(object.id);
    this.#objects.set(handle, object as BoundCircuitObject<string>);
    const device: ValueSynchronousDevice = {
      id: object.id,
      evaluate: () =>
        object.connectors.flatMap((connector) =>
          connector.defaultOutput === undefined
            ? []
            : connector.outputNetworks.map((networkId) => ({
                networkId,
                value: throughDevice(connector.defaultOutput!, object.id),
              })),
        ),
    };
    this.#kernel.addDevice(device);
    return handle;
  }

  readObjectInput<Name extends string>(target: TestObjectHandle<Name>, connector: Name): BusValue {
    const bound = this.#object(target);
    const descriptor = bound.connectors.find((candidate) => candidate.name === connector);
    if (descriptor === undefined) {
      throw new Error(
        `Object ${bound.adapterId}:${bound.instanceId} has no connector named ${JSON.stringify(connector)}.`,
      );
    }
    return aggregateBusValues(
      descriptor.inputNetworks.map((networkId) => this.#kernel.snapshot.read(networkId)),
    );
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
    const earliestBoundary = this.#activeBoundary ?? this.currentTick;
    if (tick <= earliestBoundary) {
      throw new RangeError(
        this.#activeBoundary === undefined
          ? `scheduled tick ${tick} must be later than current tick ${this.currentTick}.`
          : `scheduled tick ${tick} must be later than active boundary ${this.#activeBoundary}.`,
      );
    }
    const callbacks = this.#scheduled.get(tick) ?? [];
    callbacks.push(callback);
    this.#scheduled.set(tick, callbacks);
    return this;
  }

  tick(count = 1): ValueSimulationSnapshot {
    positiveCount(count, 'tick count');
    return this.#advance(() => {
      let snapshot = this.#kernel.snapshot;
      for (let index = 0; index < count; index += 1) snapshot = this.#advanceOne();
      return snapshot;
    });
  }

  run(count: number): ValueSimulationSnapshot {
    return this.tick(count);
  }

  settle({ maxTicks }: SettleOptions): ValueSimulationSnapshot {
    positiveCount(maxTicks, 'settle maxTicks');
    return this.#advance(() => {
      let previousKey = snapshotKey(this.#kernel.snapshot);
      for (let elapsed = 0; elapsed < maxTicks; elapsed += 1) {
        const snapshot = this.#advanceOne();
        const currentKey = snapshotKey(snapshot);
        if (currentKey === previousKey) return snapshot;
        previousKey = currentKey;
      }
      throw new Error(`Circuit did not settle within ${maxTicks} ticks.`);
    });
  }

  #advance<T>(operation: () => T): T {
    if (this.#advancing) {
      throw new Error('TestSession time cannot be advanced from inside an active boundary.');
    }
    this.#advancing = true;
    try {
      return operation();
    } finally {
      this.#activeBoundary = undefined;
      this.#advancing = false;
    }
  }

  #advanceOne(): ValueSimulationSnapshot {
    const nextTick = this.currentTick + 1;
    this.#activeBoundary = nextTick;
    const callbacks = this.#scheduled.get(nextTick) ?? [];
    this.#scheduled.delete(nextTick);
    for (const callback of callbacks) callback();
    const snapshot = this.#kernel.step();
    this.#pulses.clear();
    this.traces.record(snapshot);
    this.#activeBoundary = undefined;
    return snapshot;
  }

  #networkId(target: Target): NetworkId {
    return this.#resolveNetwork(target);
  }

  #object(target: TestObjectHandle<string>): BoundCircuitObject<string> {
    const object = this.#objects.get(target);
    if (object === undefined) throw new Error('Foreign or invalid test object handle.');
    return object;
  }

  #isSignalTarget(value: Target | TestSignalTarget<Target>): value is TestSignalTarget<Target> {
    return (
      typeof value === 'object' && value !== null && 'kind' in value && value.kind === 'test-signal'
    );
  }

  #assertionContext() {
    const session = this;
    return {
      get currentTick() {
        return session.currentTick;
      },
      readValue(networkId: NetworkId) {
        return session.#kernel.snapshot.read(networkId);
      },
    };
  }
}

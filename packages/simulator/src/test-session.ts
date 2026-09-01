import { SparseBus, type SignalId } from '@comblang/factorio';
import type { DeviceId, NetworkId } from '@comblang/shared';

import {
  aggregateBusValues,
  cloneBusValue,
  knownBus,
  throughDevice,
  unknownBus,
  type BusValue,
} from './bus-value.js';
import {
  bindCircuitObject,
  type BoundCircuitObject,
  type CircuitObjectAdapter,
} from './object-adapter.js';
import {
  ValueSimulationKernel,
  type ValueSimulationReader,
  type ValueSimulationSnapshot,
  type ValueSynchronousDevice,
} from './value-kernel.js';
import {
  NetworkExpectation,
  SignalExpectation,
  type TestSignalTarget,
} from './test-expectation.js';
import { networkTraceTarget, objectTraceTarget, signalTraceTarget, TraceStore } from './trace.js';

export type TestBusInput = SparseBus | Iterable<readonly [signal: SignalId, value: number]>;

export interface TestSessionOptions<Target> {
  readonly resolveNetwork?: (target: Target) => NetworkId;
  readonly objects?: TestObjectDefaults;
}

export interface ObjectOutputPolicyContext {
  readonly objectId: DeviceId;
  readonly adapterId: string;
  readonly instanceId: string;
  readonly connector: string;
  readonly inputNetworks: readonly NetworkId[];
  readonly outputNetworks: readonly NetworkId[];
}

export type ObjectOutputPolicyResult = TestObjectOutput | 'unknown' | 'zero' | undefined;

export type ObjectOutputPolicy =
  'unknown' | 'zero' | ((context: ObjectOutputPolicyContext) => ObjectOutputPolicyResult);

export interface TestObjectDefaults {
  readonly default?: ObjectOutputPolicy;
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

export interface TestObjectTraceTarget<Name extends string = string> {
  readonly kind: 'test-object-input' | 'test-object-output';
  readonly object: TestObjectHandle<Name>;
  readonly connector: Name;
}

export type TestObjectOutput = TestBusInput | BusValue;

export interface ObjectMockController {
  output(values: TestObjectOutput): this;
  clear(): this;
}

export interface ObjectModelContext<State> {
  readonly input: BusValue;
  readonly state: State;
  /** Snapshot T read by the transition that will commit output/state to T+1. */
  readonly tick: number;
}

export interface ObjectModelStep<State> {
  readonly state: State;
  readonly output?: TestObjectOutput;
}

export interface ObjectModelDefinition<State> {
  readonly initialState: State;
  readonly step: (context: ObjectModelContext<State>) => ObjectModelStep<State>;
}

export interface ObjectModelController<State> {
  readonly state: State;
  clear(): this;
}

export interface TestTraceReader {
  timeline(targetId?: string): ReturnType<TraceStore['timeline']>;
  toJSON(): ReturnType<TraceStore['toJSON']>;
}

interface ObjectMockProvider {
  readonly kind: 'mock';
  value: BusValue;
}

interface ObjectModelProvider {
  readonly kind: 'model';
  state: unknown;
  readonly step: (context: ObjectModelContext<unknown>) => ObjectModelStep<unknown>;
}

type ObjectOutputProvider = ObjectMockProvider | ObjectModelProvider;

interface ObjectBindingState {
  readonly object: BoundCircuitObject<string>;
  readonly providers: Map<string, ObjectOutputProvider>;
  readonly fallbackOutputs: ReadonlyMap<string, BusValue>;
  readonly committedOutputs: Map<string, BusValue>;
}

function copyBus(values: TestBusInput): SparseBus {
  return values instanceof SparseBus ? values.clone() : new SparseBus(values);
}

function copyObjectOutput(value: TestObjectOutput): BusValue {
  return typeof value === 'object' && value !== null && 'kind' in value
    ? cloneBusValue(value as BusValue)
    : knownBus(copyBus(value as TestBusInput));
}

function freezeModelState(value: unknown, seen = new WeakSet<object>()): void {
  if (typeof value !== 'object' || value === null || seen.has(value)) return;
  const prototype = Object.getPrototypeOf(value);
  if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(
      'Object model state must contain only literals, arrays, and plain objects.',
    );
  }
  seen.add(value);
  for (const child of Object.values(value)) freezeModelState(child, seen);
  Object.freeze(value);
}

function copyModelState<State>(value: State): State {
  let copy: State;
  try {
    copy = structuredClone(value);
  } catch (error) {
    throw new TypeError('Object model state must be structured-cloneable.', { cause: error });
  }
  freezeModelState(copy);
  return copy;
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
  readonly traces: TestTraceReader;
  readonly #kernel: ValueSimulationKernel;
  readonly #resolveNetwork: (target: Target) => NetworkId;
  readonly #objectOutputPolicy: ObjectOutputPolicy;
  readonly #drives = new Map<NetworkId, SparseBus>();
  readonly #pulses = new Map<NetworkId, SparseBus>();
  readonly #scheduled = new Map<number, (() => void)[]>();
  readonly #objects = new WeakMap<object, ObjectBindingState>();
  readonly #objectIds = new Set<DeviceId>();
  readonly #pendingBoundaryCommits: (() => void)[] = [];
  readonly #traceStore = new TraceStore();
  #advancing = false;
  #evaluatingParticipants = false;
  #finished = false;
  #activeBoundary: number | undefined;

  constructor(kernel: ValueSimulationKernel, options?: TestSessionOptions<Target>) {
    this.#kernel = kernel;
    this.traces = Object.freeze({
      timeline: (targetId?: string) => this.#traceStore.timeline(targetId),
      toJSON: () => this.#traceStore.toJSON(),
    });
    this.#resolveNetwork =
      options?.resolveNetwork ?? ((target: Target) => target as unknown as NetworkId);
    this.#objectOutputPolicy = options?.objects?.default ?? 'unknown';
    if (
      this.#objectOutputPolicy !== 'unknown' &&
      this.#objectOutputPolicy !== 'zero' &&
      typeof this.#objectOutputPolicy !== 'function'
    ) {
      throw new TypeError('Object output default must be "unknown", "zero", or a function.');
    }

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

  objectInput<Name extends string>(
    target: TestObjectHandle<Name>,
    connector?: Name,
  ): TestObjectTraceTarget<Name> {
    return this.#objectPortTarget('test-object-input', target, connector);
  }

  objectOutput<Name extends string>(
    target: TestObjectHandle<Name>,
    connector?: Name,
  ): TestObjectTraceTarget<Name> {
    const traceTarget = this.#objectPortTarget('test-object-output', target, connector);
    const binding = this.#object(target);
    const descriptor = this.#objectConnector(binding.object, traceTarget.connector);
    if (descriptor.outputNetworks.length === 0) {
      throw new Error(
        `Object connector ${binding.object.adapterId}:${binding.object.instanceId}:${descriptor.name} has no output Networks.`,
      );
    }
    return traceTarget;
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

  trace(
    ...targets: readonly (Target | TestSignalTarget<Target> | TestObjectTraceTarget<string>)[]
  ): this {
    this.#assertMutationAllowed('trace');
    for (const target of targets) {
      if (this.#isObjectTraceTarget(target)) {
        const binding = this.#object(target.object);
        const descriptor = this.#objectConnector(binding.object, target.connector);
        const kind = target.kind === 'test-object-input' ? 'object-input' : 'object-output';
        this.#traceStore.register(
          objectTraceTarget(kind, binding.object, descriptor.name),
          this.#kernel.snapshot,
          kind === 'object-input'
            ? (snapshot) => this.#connectorInput(descriptor, snapshot)
            : () => cloneBusValue(binding.committedOutputs.get(descriptor.name) ?? knownBus()),
        );
      } else if (this.#isSignalTarget(target)) {
        this.#traceStore.register(
          signalTraceTarget(this.#networkId(target.network), target.signal),
          this.#kernel.snapshot,
        );
      } else {
        this.#traceStore.register(
          networkTraceTarget(this.#networkId(target)),
          this.#kernel.snapshot,
        );
      }
    }
    return this;
  }

  adaptObject<Instance, Name extends string>(
    adapter: CircuitObjectAdapter<Instance, Name>,
    instance: Instance,
  ): TestObjectHandle<Name> {
    this.#assertMutationAllowed('adaptObject');
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
    const state: ObjectBindingState = {
      object: object as BoundCircuitObject<string>,
      providers: new Map(),
      fallbackOutputs: new Map(
        object.connectors
          .filter((connector) => connector.outputNetworks.length > 0)
          .map((connector) => [
            connector.name,
            connector.instanceDefaultOutput ??
              connector.classDefaultOutput ??
              this.#globalObjectOutput(object, connector),
          ]),
      ),
      committedOutputs: new Map(
        object.connectors
          .filter((connector) => connector.outputNetworks.length > 0)
          .map((connector) => [connector.name, knownBus()]),
      ),
    };
    this.#objectIds.add(object.id);
    this.#objects.set(handle, state);
    const device: ValueSynchronousDevice = {
      id: object.id,
      evaluate: (snapshot) =>
        object.connectors.flatMap((connector) => {
          const provider = state.providers.get(connector.name);
          let output: BusValue | undefined;
          if (provider?.kind === 'mock') {
            output = provider.value;
          } else if (provider?.kind === 'model') {
            const result = provider.step({
              input: this.#connectorInput(connector, snapshot),
              state: provider.state,
              tick: snapshot.tick,
            });
            if (typeof result !== 'object' || result === null || !('state' in result)) {
              throw new TypeError('Object model step must return { state, output? }.');
            }
            const nextState = copyModelState(result.state);
            output = result.output === undefined ? undefined : copyObjectOutput(result.output);
            this.#pendingBoundaryCommits.push(() => {
              if (state.providers.get(connector.name) === provider) {
                provider.state = nextState;
              }
            });
          } else {
            output = state.fallbackOutputs.get(connector.name);
          }
          const committedOutput =
            output === undefined ? knownBus() : throughDevice(output, object.id);
          this.#pendingBoundaryCommits.push(() => {
            state.committedOutputs.set(connector.name, committedOutput);
          });
          return output === undefined
            ? []
            : connector.outputNetworks.map((networkId) => ({
                networkId,
                value: committedOutput,
              }));
        }),
    };
    try {
      this.#kernel.addDevice(device);
    } catch (error) {
      this.#objects.delete(handle);
      this.#objectIds.delete(object.id);
      throw error;
    }
    return handle;
  }

  readObjectInput<Name extends string>(target: TestObjectHandle<Name>, connector: Name): BusValue {
    const bound = this.#object(target).object;
    const descriptor = bound.connectors.find((candidate) => candidate.name === connector);
    if (descriptor === undefined) {
      throw new Error(
        `Object ${bound.adapterId}:${bound.instanceId} has no connector named ${JSON.stringify(connector)}.`,
      );
    }
    return this.#connectorInput(descriptor, this.#kernel.snapshot);
  }

  mock<Name extends string>(
    target: TestObjectHandle<Name>,
    connector?: Name,
  ): ObjectMockController {
    this.#assertMutationAllowed('mock');
    const state = this.#object(target);
    const descriptor = this.#objectConnector(state.object, connector);
    if (descriptor.outputNetworks.length === 0) {
      throw new Error(
        `Object connector ${state.object.adapterId}:${state.object.instanceId}:${descriptor.name} has no output Networks.`,
      );
    }
    const provider: ObjectMockProvider = { kind: 'mock', value: knownBus() };
    const controller: ObjectMockController = {
      output: (values) => {
        this.#assertMutationAllowed('mock.output');
        provider.value = copyObjectOutput(values);
        state.providers.set(descriptor.name, provider);
        return controller;
      },
      clear: () => {
        this.#assertMutationAllowed('mock.clear');
        if (state.providers.get(descriptor.name) === provider) {
          state.providers.delete(descriptor.name);
        }
        return controller;
      },
    };
    return Object.freeze(controller);
  }

  model<Name extends string, State>(
    target: TestObjectHandle<Name>,
    definition: ObjectModelDefinition<State>,
    connector?: Name,
  ): ObjectModelController<State> {
    this.#assertMutationAllowed('model');
    const binding = this.#object(target);
    const descriptor = this.#objectConnector(binding.object, connector);
    if (descriptor.outputNetworks.length === 0) {
      throw new Error(
        `Object connector ${binding.object.adapterId}:${binding.object.instanceId}:${descriptor.name} has no output Networks.`,
      );
    }
    if (typeof definition.step !== 'function') {
      throw new TypeError('Object model requires a step function.');
    }
    const provider: ObjectModelProvider = {
      kind: 'model',
      state: copyModelState(definition.initialState),
      step: definition.step as (context: ObjectModelContext<unknown>) => ObjectModelStep<unknown>,
    };
    binding.providers.set(descriptor.name, provider);
    const controller: ObjectModelController<State> = {
      get state() {
        return provider.state as State;
      },
      clear: () => {
        this.#assertMutationAllowed('model.clear');
        if (binding.providers.get(descriptor.name) === provider) {
          binding.providers.delete(descriptor.name);
        }
        return controller;
      },
    };
    return Object.freeze(controller);
  }

  drive(target: Target, values: TestBusInput): this {
    this.#assertMutationAllowed('drive');
    this.#drives.set(this.#networkId(target), copyBus(values));
    return this;
  }

  clear(target: Target): this {
    this.#assertMutationAllowed('clear');
    const networkId = this.#networkId(target);
    this.#drives.delete(networkId);
    this.#pulses.delete(networkId);
    return this;
  }

  pulse(target: Target, values: TestBusInput): this {
    this.#assertMutationAllowed('pulse');
    this.#pulses.set(this.#networkId(target), copyBus(values));
    return this;
  }

  at(tick: number, callback: () => void): this {
    this.#assertMutationAllowed('at');
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
    this.#assertMutationAllowed('tick');
    positiveCount(count, 'tick count');
    return this.#advance(() => {
      let snapshot = this.#kernel.snapshot;
      for (let index = 0; index < count; index += 1) snapshot = this.#advanceOne();
      return snapshot;
    });
  }

  run(count: number): ValueSimulationSnapshot {
    this.#assertMutationAllowed('run');
    return this.tick(count);
  }

  settle({ maxTicks }: SettleOptions): ValueSimulationSnapshot {
    this.#assertMutationAllowed('settle');
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
    this.#pendingBoundaryCommits.length = 0;
    try {
      this.#evaluatingParticipants = true;
      let snapshot: ValueSimulationSnapshot;
      try {
        snapshot = this.#kernel.step();
      } finally {
        this.#evaluatingParticipants = false;
      }
      for (const commit of this.#pendingBoundaryCommits) commit();
      this.#pulses.clear();
      this.#traceStore.record(snapshot);
      this.#activeBoundary = undefined;
      return snapshot;
    } finally {
      this.#pendingBoundaryCommits.length = 0;
    }
  }

  /** Permanently seals mutating testbench APIs after one test body completes. */
  finish(): void {
    if (this.#finished) return;
    if (this.#evaluatingParticipants || this.#advancing) {
      throw new Error('TestSession cannot finish during an active boundary.');
    }
    this.#finished = true;
  }

  #assertMutationAllowed(operation: string): void {
    if (this.#finished) {
      throw new Error(`TestSession is finished; ${operation} cannot mutate it.`);
    }
    if (this.#evaluatingParticipants) {
      throw new Error(
        `TestSession mutation ${operation} is not allowed during participant evaluation.`,
      );
    }
  }

  #networkId(target: Target): NetworkId {
    return this.#resolveNetwork(target);
  }

  #object(target: TestObjectHandle<string>): ObjectBindingState {
    const state = this.#objects.get(target);
    if (state === undefined) throw new Error('Foreign or invalid test object handle.');
    return state;
  }

  #objectConnector(
    object: BoundCircuitObject<string>,
    connector: string | undefined,
  ): BoundCircuitObject<string>['connectors'][number] {
    if (connector === undefined) {
      if (object.connectors.length !== 1) {
        throw new Error(
          `Object ${object.adapterId}:${object.instanceId} has ${object.connectors.length} connectors; select one explicitly.`,
        );
      }
      return object.connectors[0]!;
    }
    const descriptor = object.connectors.find((candidate) => candidate.name === connector);
    if (descriptor === undefined) {
      throw new Error(
        `Object ${object.adapterId}:${object.instanceId} has no connector named ${JSON.stringify(connector)}.`,
      );
    }
    return descriptor;
  }

  #connectorInput(
    connector: BoundCircuitObject<string>['connectors'][number],
    snapshot: ValueSimulationReader,
  ): BusValue {
    return aggregateBusValues(connector.inputNetworks.map((networkId) => snapshot.read(networkId)));
  }

  #objectPortTarget<Name extends string>(
    kind: TestObjectTraceTarget<Name>['kind'],
    target: TestObjectHandle<Name>,
    connector: Name | undefined,
  ): TestObjectTraceTarget<Name> {
    const binding = this.#object(target);
    const descriptor = this.#objectConnector(binding.object, connector);
    return Object.freeze({ kind, object: target, connector: descriptor.name as Name });
  }

  #globalObjectOutput(
    object: BoundCircuitObject<string>,
    connector: BoundCircuitObject<string>['connectors'][number],
  ): BusValue {
    const context: ObjectOutputPolicyContext = Object.freeze({
      objectId: object.id,
      adapterId: object.adapterId,
      instanceId: object.instanceId,
      connector: connector.name,
      inputNetworks: connector.inputNetworks,
      outputNetworks: connector.outputNetworks,
    });
    const configured =
      typeof this.#objectOutputPolicy === 'function'
        ? this.#objectOutputPolicy(context)
        : this.#objectOutputPolicy;
    if (configured === 'zero') return knownBus();
    if (configured !== undefined && configured !== 'unknown') {
      return copyObjectOutput(configured);
    }
    return unknownBus([
      {
        id: `unmodeled:${object.adapterId}:${object.instanceId}:${connector.name}`,
        description: `Unmodeled output ${object.adapterId}:${object.instanceId}:${connector.name}`,
      },
    ]);
  }

  #isSignalTarget(
    value: Target | TestSignalTarget<Target> | TestObjectTraceTarget<string>,
  ): value is TestSignalTarget<Target> {
    return (
      typeof value === 'object' && value !== null && 'kind' in value && value.kind === 'test-signal'
    );
  }

  #isObjectTraceTarget(
    value: Target | TestSignalTarget<Target> | TestObjectTraceTarget<string>,
  ): value is TestObjectTraceTarget<string> {
    return (
      typeof value === 'object' &&
      value !== null &&
      'kind' in value &&
      (value.kind === 'test-object-input' || value.kind === 'test-object-output')
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

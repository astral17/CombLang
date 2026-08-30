import { sameSignal, Signal, type SignalId } from '@comblang/factorio';
import type {
  DirectElaborationPlan,
  DirectPlanProducer,
  ElaborationJavaScript,
  PlanEntityPlacement,
  PlanArithmeticOperand,
  PlanDeciderCondition,
} from '@comblang/compiler';
import type { Diagnostic, SourceFileId, SourceSpan } from '@comblang/shared';

import { ElaborationExecutionError, ElaborationOperationLimitError } from './elaboration-errors.js';
import {
  RuntimeValueRegistry,
  type ConditionValue,
  type DestinationValue,
  type DslValue,
  type FunctionOwnershipFrame,
  type NetworkOwnershipState,
  type NetworkRuntimeState,
  type NetworkValue,
  type PairSelectedValue,
  type PairValue,
  type ProducerValue,
  type RuntimeObjectKind,
  type RuntimeObjectValue,
  type SelectedValue,
  type SignalHandle,
  type SignalValue,
  type WildcardCountValue,
  type WildcardName,
  type WildcardTokenValue,
} from './elaboration-values.js';
import {
  elaborationOperatorPolicy as operators,
  type ElaborationOperatorDispatchContext,
} from './elaboration-operators.js';
import { createElaborationOwnershipPolicy } from './elaboration-ownership.js';

interface RawSpan {
  readonly start: number;
  readonly end: number;
}

interface BindingDescriptor {
  readonly name: string;
  readonly color?: 'red' | 'green';
  readonly property?: string;
  readonly producerType?: string;
}

export interface ElaborationExecutionOptions {
  readonly dslCallBudget?: number;
  /** @deprecated Use dslCallBudget. */
  readonly operationBudget?: number;
}

export { ElaborationExecutionError, ElaborationOperationLimitError };

function isSignalId(value: unknown): value is SignalId {
  return (
    typeof value === 'object' &&
    value !== null &&
    'type' in value &&
    'name' in value &&
    !('kind' in value)
  );
}

function isRawSpan(value: unknown): value is RawSpan {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as RawSpan).start === 'number' &&
    typeof (value as RawSpan).end === 'number'
  );
}

class ElaborationRecorder {
  readonly #fileId: SourceFileId;
  readonly #networks: DirectElaborationPlan['networks'][number][] = [];
  readonly #networkTransfers: NonNullable<DirectElaborationPlan['networkTransfers']>[number][] = [];
  readonly #networkPairs: NonNullable<DirectElaborationPlan['networkPairs']>[number][] = [];
  readonly #capabilityUses: NonNullable<DirectElaborationPlan['capabilityUses']>[number][] = [];
  readonly #producers: DirectPlanProducer[] = [];
  readonly #diagnostics: Diagnostic[] = [];
  readonly #producerAttachments = new WeakMap<object, SourceSpan>();
  readonly #knownProducers = new Map<object, ProducerValue>();
  readonly #runtimeValues = new RuntimeValueRegistry();
  readonly #ownership = createElaborationOwnershipPolicy((network) => this.#networkState(network));
  #unusedProducersFinalized = false;
  #anonymousOrdinal = 0;
  readonly #networkNameCounts = new Map<string, number>();
  readonly #anonymousLoopCounts = new Map<string, number>();
  readonly #instancePath: string[] = [];
  readonly #ownershipFrames: (FunctionOwnershipFrame | undefined)[] = [];
  readonly #dslCallBudget: number;
  #dslCalls = 0;
  readonly #operatorContext: ElaborationOperatorDispatchContext<RawSpan> = {
    isCircuitDslValue: (value): value is DslValue => this.#isCircuitDslValue(value),
    isSignal: (value): value is SignalId => this.#isSignal(value),
    isSignalId,
    isSelected: (value): value is SelectedValue => this.#isSelected(value),
    isNetwork: (value): value is NetworkValue => this.#isNetwork(value),
    isPair: (value): value is PairValue => this.#isPair(value),
    isWildcardToken: (value): value is WildcardTokenValue => this.#isWildcardToken(value),
    recordDslCall: () => this.#recordDslCall(),
    assertReadable: (value, source) => this.#assertReadableValue(value, source),
    planNetworkRef: (value) => this.#planNetworkRef(value),
    arithmeticOperand: (value, source) => this.#arithmeticOperand(value, source),
    producerMetadata: (source) => ({ source: this.#span(source), instancePath: this.#path() }),
    brand: <T extends RuntimeObjectValue>(value: T): T => this.#runtimeValue(value),
  };

  constructor(fileId: SourceFileId, dslCallBudget: number) {
    this.#fileId = fileId;
    this.#dslCallBudget = dslCallBudget;
  }

  readonly api = Object.freeze({
    enterFunction: (name: string, rawSpan: RawSpan): void => {
      this.#instancePath.push(`function ${name}`);
      this.#ownershipFrames.push({
        owner: Symbol(name),
        source: this.#span(rawSpan),
        borrows: [],
        moves: [],
      });
    },
    enterLoop: (name: string, value: unknown, _rawSpan: RawSpan): void => {
      if (value === undefined) {
        const occurrence = (this.#anonymousLoopCounts.get(name) ?? 0) + 1;
        this.#anonymousLoopCounts.set(name, occurrence);
        this.#instancePath.push(`${name} #${occurrence}`);
      } else {
        this.#instancePath.push(`for ${name}=${String(value)}`);
      }
      this.#ownershipFrames.push(undefined);
    },
    exitInstance: (rawSpan?: RawSpan): void => {
      const frame = this.#ownershipFrames.pop();
      if (this.#instancePath.pop() === undefined) {
        throw new Error('Executed provenance stack underflow.');
      }
      if (frame !== undefined) {
        this.#ownership.releaseFrame(frame, isRawSpan(rawSpan) ? this.#span(rawSpan) : undefined);
      }
    },
    signal: (...args: unknown[]) => {
      this.#recordDslCall();
      const rawSpan = args.at(-1);
      const values = args.slice(0, -1);
      if (!isRawSpan(rawSpan) || values.length < 1 || values.length > 3) {
        throw new Error(
          'Signal(name) or Signal(type, name, quality?) requires one to three arguments.',
        );
      }
      if (!values.every((value) => typeof value === 'string')) {
        throw new Error('Signal(...) arguments must evaluate to strings.');
      }
      if (values.length === 1) return this.#signalHandle(Signal(values[0] as string));
      const [type, name, quality] = values as [SignalId['type'], string, string?];
      return this.#signalHandle(Signal(type, name, quality));
    },
    wildcardToken: (value: WildcardName): WildcardTokenValue =>
      this.#runtimeValue({
        kind: 'wildcard-token',
        value,
      }),
    wildcard: (
      value: WildcardName,
      network: NetworkValue | PairValue,
      rawSpan: RawSpan,
    ): SelectedValue => {
      this.#recordDslCall();
      if (!this.#isNetwork(network) && !this.#isPair(network)) {
        throw new Error('Wildcard selection requires a Network or pair(a, b).');
      }
      this.#assertReadableValue(network, rawSpan);
      return this.#selectedValue(network, value);
    },
    constant: (...args: unknown[]): ProducerValue => {
      this.#recordDslCall();
      const rawSpan = args.at(-1);
      if (!isRawSpan(rawSpan)) throw new Error('Constant combinator is missing provenance.');
      const outputs = args.slice(0, -1);
      if (!outputs.every((value): value is SignalValue => this.#isSignalValue(value))) {
        throw new Error('CC entries must be numeric Signal values.');
      }
      return this.#runtimeValue({
        kind: 'producer',
        identity: {},
        producer: {
          kind: 'constant',
          outputs: outputs.map(({ signal, value }) => ({ signal, value })),
          source: this.#span(rawSpan),
          instancePath: this.#path(),
        },
      });
    },
    network: (
      name: string | undefined,
      fixedColor: 'red' | 'green' | undefined,
      rawSpan: RawSpan,
    ): NetworkValue => {
      return this.#network(name ?? `$network:${++this.#anonymousOrdinal}`, rawSpan, fixedColor);
    },
    pair: (...args: unknown[]): PairValue => {
      this.#recordDslCall();
      const rawSpan = args.at(-1);
      const values = args.slice(0, -1);
      if (!isRawSpan(rawSpan)) throw new Error('pair(a, b) is missing provenance.');
      if (values.length !== 2) {
        throw new ElaborationExecutionError(
          'pair(a, b) requires exactly two Network values.',
          this.#span(rawSpan),
          'RT2020',
        );
      }
      if (!values.every((value): value is NetworkValue => this.#isNetwork(value))) {
        throw new ElaborationExecutionError(
          'pair(a, b) requires two Network values.',
          this.#span(rawSpan),
          'RT2020',
        );
      }
      for (const value of values) this.#assertReadableNetwork(value, rawSpan);
      if (this.#networkState(values[0]!).ownership === this.#networkState(values[1]!).ownership) {
        throw new ElaborationExecutionError(
          'pair(a, b) requires two distinct logical Networks.',
          this.#span(rawSpan),
          'RT2020',
          [{ message: 'The repeated Network is declared here.', span: values[0]!.declaration }],
        );
      }
      const pair: PairValue = this.#runtimeValue({
        kind: 'pair',
        networks: values as [NetworkValue, NetworkValue],
        source: this.#span(rawSpan),
      });
      this.#networkPairs.push({
        networks: [values[0]!.name, values[1]!.name],
        provenance: pair.source,
        instancePath: this.#path(),
      });
      return pair;
    },
    borrowParameter: (
      value: unknown,
      capability: 'readonly' | 'ref',
      parameter: string,
      fixedColor: 'red' | 'green' | undefined,
      rawSpan: RawSpan,
    ): NetworkValue => {
      if (!isRawSpan(rawSpan) || (capability !== 'readonly' && capability !== 'ref')) {
        throw new Error('Invalid Network parameter capability descriptor.');
      }
      if (!this.#isNetwork(value)) {
        throw new ElaborationExecutionError(
          `${capability === 'readonly' ? 'Readonly<Network>' : 'Ref<Network>'} parameter ${parameter} received a non-Network value.`,
          this.#span(rawSpan),
          'RT2015',
        );
      }
      this.#recordDslCall();
      const source = this.#span(rawSpan);
      this.#ownership.assertReadable(value, source);
      if (fixedColor !== undefined)
        this.#requireNetworkColor(value, capability, fixedColor, rawSpan);
      const frame = this.#currentFunctionFrame();
      if (frame === undefined) {
        throw new Error('Network parameter borrow was created outside a function frame.');
      }
      const borrow = this.#ownership.borrow(value, capability, parameter, source, frame);
      this.#capabilityUses.push({
        network: value.name,
        capability,
        parameter,
        ...(fixedColor === undefined ? {} : { fixedColor }),
        provenance: borrow.source,
        instancePath: this.#path(),
      });
      return this.#networkValue(
        {
          kind: 'network',
          name: value.name,
          declaration: value.declaration,
          capability,
          generation: value.generation,
        },
        { ownership: this.#networkState(value).ownership, borrow },
      );
    },
    moveParameter: (
      value: unknown,
      parameter: string,
      fixedColor: 'red' | 'green' | undefined,
      rawSpan: RawSpan,
    ): NetworkValue => {
      if (!isRawSpan(rawSpan)) throw new Error('Invalid Move<Network> parameter descriptor.');
      if (this.#isPair(value) || this.#isPairSelection(value)) {
        throw new ElaborationExecutionError(
          'pair(a, b) is a read-only input view and cannot transfer ownership.',
          this.#span(rawSpan),
          'RT2020',
        );
      }
      if (!this.#isNetwork(value)) {
        throw new ElaborationExecutionError(
          `Move<Network> parameter ${parameter} received a non-Network value.`,
          this.#span(rawSpan),
          'RT2015',
        );
      }
      this.#recordDslCall();
      const source = this.#span(rawSpan);
      this.#ownership.assertConsumable(value, source, 'source');
      const frame = this.#currentFunctionFrame();
      if (frame === undefined) {
        throw new Error('Network ownership transfer was created outside a function frame.');
      }
      if (fixedColor !== undefined) this.#requireNetworkColor(value, 'move', fixedColor, rawSpan);
      const state = this.#networkState(value);
      this.#ownership.moveToFrame(value, source, frame);
      this.#capabilityUses.push({
        network: value.name,
        capability: 'move',
        parameter,
        ...(fixedColor === undefined ? {} : { fixedColor }),
        provenance: source,
        instancePath: this.#path(),
      });
      return this.#networkValue(
        {
          kind: 'network',
          name: value.name,
          declaration: value.declaration,
          capability: 'move',
          generation: state.ownership.generation,
        },
        { ownership: state.ownership },
      );
    },
    producerHandle: (value: unknown, expectedType: unknown, rawSpan: RawSpan): ProducerValue => {
      return this.#producerHandle(value, expectedType, rawSpan);
    },
    returnValue: (value: unknown, rawSpan: RawSpan, producerType?: unknown): unknown => {
      if (producerType !== undefined) return this.#producerHandle(value, producerType, rawSpan);
      return this.#returnOwnedValue(value, rawSpan, new Map());
    },
    take: (...args: unknown[]): unknown => {
      const rawSpan = args.at(-1);
      const destination = args[0];
      const values = args.slice(1, -1);
      if (!isRawSpan(rawSpan)) throw new Error('.take(...) is missing provenance.');
      if (
        this.#isPair(destination) ||
        this.#isPairSelection(destination) ||
        values.some((value) => this.#isPair(value) || this.#isPairSelection(value))
      ) {
        throw new ElaborationExecutionError(
          'pair(a, b) is a read-only input view and cannot participate in .take(...).',
          this.#span(rawSpan),
          'RT2020',
        );
      }
      if (!this.#isNetwork(destination)) {
        if (
          (typeof destination !== 'object' && typeof destination !== 'function') ||
          destination === null ||
          typeof (destination as { take?: unknown }).take !== 'function'
        ) {
          throw new Error(
            '.take(source) requires a destination Network or an ordinary .take method.',
          );
        }
        return (destination as { take: (...items: unknown[]) => unknown }).take(...values);
      }
      this.#recordDslCall();
      if (values.length !== 1) {
        throw new Error('.take(source) requires exactly one source Network.');
      }
      const source = values[0];
      if (!this.#isNetwork(source)) {
        throw new Error('.take(source) requires a source Network.');
      }
      this.#assertConsumableNetwork(destination, rawSpan, 'destination');
      this.#assertConsumableNetwork(source, rawSpan, 'source');
      if (this.#networkState(destination).ownership === this.#networkState(source).ownership) {
        throw new ElaborationExecutionError(
          'A Network cannot take itself.',
          this.#span(rawSpan),
          'RT2013',
          [{ message: 'Network declared here.', span: destination.declaration }],
        );
      }
      const provenance = this.#span(rawSpan);
      this.#networkTransfers.push({
        destination: destination.name,
        source: source.name,
        provenance,
        instancePath: this.#path(),
      });
      this.#ownership.consume(source, provenance);
      return destination;
    },
    materialize: (
      producer: unknown,
      name: string,
      fixedColor: 'red' | 'green' | undefined,
      rawSpan: RawSpan,
    ): unknown => {
      if (!this.#isProducer(producer)) return producer;
      const network = this.#network(name, rawSpan, fixedColor);
      this.#attach(network, producer, rawSpan);
      return network;
    },
    materializeArray: (
      value: unknown,
      descriptors: readonly (BindingDescriptor | null)[],
      rawSpan: RawSpan,
    ): unknown => {
      if (!Array.isArray(descriptors)) throw new Error('Invalid array binding descriptors.');
      const hasProducerBindings = descriptors.some(
        (descriptor) => descriptor?.producerType !== undefined,
      );
      if (!this.#isProducer(value)) {
        if (!hasProducerBindings) return value;
        if (!Array.isArray(value)) {
          throw new ElaborationExecutionError(
            'Producer tuple bindings require an executed array value.',
            this.#span(rawSpan),
            'RT2022',
          );
        }
        const result = [...value];
        for (const [index, descriptor] of descriptors.entries()) {
          if (descriptor?.producerType !== undefined) {
            result[index] = this.#producerHandle(result[index], descriptor.producerType, rawSpan);
          }
        }
        return result;
      }
      if (hasProducerBindings) {
        throw new ElaborationExecutionError(
          'A single Producer cannot be destructured into Producer handles; put handles in an ordinary array first.',
          this.#span(rawSpan),
          'RT2022',
        );
      }
      const bindings = descriptors.map((descriptor) =>
        descriptor === null ? undefined : this.#bindingNetwork(descriptor, rawSpan),
      );
      const networks = bindings.filter((network): network is NetworkValue => network !== undefined);
      this.#attachMany(networks, value, rawSpan);
      return bindings;
    },
    materializeObject: (
      value: unknown,
      descriptors: readonly (BindingDescriptor | null)[],
      rawSpan: RawSpan,
    ): unknown => {
      if (!Array.isArray(descriptors)) throw new Error('Invalid object binding descriptors.');
      const producerDescriptors = descriptors.filter(
        (descriptor): descriptor is BindingDescriptor => descriptor?.producerType !== undefined,
      );
      if (!this.#isProducer(value)) {
        if (producerDescriptors.length === 0) return value;
        if (typeof value !== 'object' || value === null || Array.isArray(value)) {
          throw new ElaborationExecutionError(
            'Producer object bindings require an executed object value.',
            this.#span(rawSpan),
            'RT2022',
          );
        }
        const snapshot = Object.assign({}, value) as Record<string, unknown>;
        for (const descriptor of producerDescriptors) {
          if (descriptor.property === undefined) {
            throw new Error('Producer object bindings require flat named properties.');
          }
          snapshot[descriptor.property] = this.#producerHandle(
            snapshot[descriptor.property],
            descriptor.producerType,
            rawSpan,
          );
        }
        return snapshot;
      }
      if (producerDescriptors.length !== 0) {
        throw new ElaborationExecutionError(
          'A single Producer cannot be destructured into Producer handles; put handles in an ordinary object first.',
          this.#span(rawSpan),
          'RT2022',
        );
      }
      const entries = descriptors.map((descriptor) => {
        if (descriptor === null || descriptor.property === undefined) {
          throw new Error('Producer object binding requires flat named properties.');
        }
        return [descriptor.property, this.#bindingNetwork(descriptor, rawSpan)] as const;
      });
      this.#attachMany(
        entries.map(([, network]) => network),
        value,
        rawSpan,
      );
      return Object.fromEntries(entries);
    },
    discard: (value: unknown, rawSpan: RawSpan): void => {
      if (!this.#isProducer(value) || this.#producerAttachments.has(value.identity)) return;
      this.#discardProducer(value, this.#span(rawSpan));
    },
    compare: (operator: string, left: unknown, right: unknown, rawSpan: RawSpan): unknown => {
      return operators.dispatchComparison(operator, left, right, rawSpan, this.#operatorContext);
    },
    controlTest: (value: unknown, rawSpan: RawSpan): unknown => {
      if (this.#isCondition(value)) {
        throw new ElaborationExecutionError(
          'A circuit Condition cannot be used as a JavaScript control-flow test; use IF(...) or when(...).then(...) to create circuit logic.',
          this.#span(rawSpan),
          'RT2024',
        );
      }
      return value;
    },
    decider: (...args: unknown[]): ProducerValue => {
      this.#recordDslCall();
      const rawSpan = args.at(-1);
      const condition = args[0];
      const outputValues = args.slice(1, -1);
      if (!isRawSpan(rawSpan)) throw new Error('IF/when is missing provenance.');
      if (!this.#isCondition(condition)) throw new Error('IF/when requires a circuit condition.');
      if (outputValues.length === 0) {
        throw new Error('IF/when requires at least one output specification.');
      }
      const outputs = outputValues.map((output) => this.#deciderOutput(output, rawSpan));
      return this.#runtimeValue({
        kind: 'producer',
        identity: {},
        producer: {
          kind: 'decider',
          condition: condition.condition,
          output: outputs[0]!,
          ...(outputs.length === 1 ? {} : { outputs }),
          source: this.#span(rawSpan),
          instancePath: this.#path(),
        },
      });
    },
    logical: (
      operator: 'and' | 'or',
      evaluateLeft: () => unknown,
      evaluateRight: () => unknown,
      _rawSpan: RawSpan,
    ): unknown => {
      const left = evaluateLeft();
      if (!this.#isCondition(left)) {
        return operator === 'and' ? (left ? evaluateRight() : left) : left ? left : evaluateRight();
      }
      this.#recordDslCall();
      const right = evaluateRight();
      if (!this.#isCondition(right)) {
        throw new Error('Cannot mix compile-time booleans with circuit Conditions.');
      }
      return this.#runtimeValue({
        kind: 'condition',
        condition: { kind: operator, conditions: [left.condition, right.condition] },
      });
    },
    not: (value: unknown, _rawSpan: RawSpan): unknown => {
      if (!this.#isCondition(value)) return !value;
      this.#recordDslCall();
      return this.#runtimeValue({
        kind: 'condition',
        condition: operators.invertCondition(value.condition),
      });
    },
    destinations: (...args: unknown[]): DestinationValue => {
      this.#recordDslCall();
      const rawSpan = args.at(-1);
      if (!isRawSpan(rawSpan)) throw new Error('to(...) is missing provenance.');
      const values = args.slice(0, -1);
      if (values.some((value) => this.#isPair(value) || this.#isPairSelection(value))) {
        throw new ElaborationExecutionError(
          'pair(a, b) is a read-only input view and cannot be a to(...) destination.',
          this.#span(rawSpan),
          'RT2020',
        );
      }
      if (!values.every((value): value is NetworkValue => this.#isNetwork(value))) {
        throw new Error('to(...) destinations must be Networks.');
      }
      for (const network of values) this.#assertWritableNetwork(network, rawSpan, 'destination');
      return this.#runtimeValue({
        kind: 'destinations',
        networks: values,
      });
    },
    select: (
      value: NetworkValue | PairValue | DestinationValue,
      signal: SignalId | WildcardTokenValue,
      rawSpan: RawSpan,
    ): SelectedValue | DestinationValue => {
      this.#recordDslCall();
      return this.#select(value, signal, rawSpan);
    },
    element: (value: unknown, key: unknown, rawSpan: RawSpan): unknown => {
      if (this.#isNetwork(value) || this.#isPair(value) || this.#isDestination(value)) {
        this.#recordDslCall();
        return this.#select(value, key, rawSpan);
      }
      if (value === null || value === undefined) {
        throw new TypeError(`Cannot read properties of ${String(value)}.`);
      }
      return (value as Record<PropertyKey, unknown>)[key as PropertyKey];
    },
    bindOutput: (producer: unknown, signal: SignalId, rawSpan: RawSpan): unknown => {
      if (!isRawSpan(rawSpan)) throw new Error('.as(...) is missing provenance.');
      if (!this.#isProducer(producer)) {
        if (
          (typeof producer !== 'object' && typeof producer !== 'function') ||
          producer === null ||
          typeof (producer as { as?: unknown }).as !== 'function'
        ) {
          throw new Error('.as(...) requires a combinator producer or an ordinary .as method.');
        }
        return (producer as { as: (value: unknown) => unknown }).as(signal);
      }
      this.#recordDslCall();
      if (!this.#isSignal(signal)) throw new Error('.as(...) requires a Signal.');
      if (producer.functionReturn !== undefined) {
        throw new ElaborationExecutionError(
          '.as(SIGNAL) cannot cross a function Network return boundary; bind the producer output inside that function.',
          this.#span(rawSpan),
          'RT2021',
          [
            {
              message: 'Producer crossed the Network return boundary here.',
              span: producer.functionReturn,
            },
          ],
        );
      }
      return this.#bindOutputSignal(producer, signal, rawSpan, true);
    },
    place: (...args: unknown[]): unknown => {
      const rawSpan = args.at(-1);
      const producer = args[0];
      const x = args[1];
      const y = args[2];
      const direction = args.length === 5 ? args[3] : undefined;
      if (!isRawSpan(rawSpan)) {
        throw new Error('.at(...) is missing provenance.');
      }
      if (!this.#isProducer(producer)) {
        if (
          (typeof producer !== 'object' && typeof producer !== 'string') ||
          producer === null ||
          typeof (producer as { at?: unknown }).at !== 'function'
        ) {
          throw new Error('.at(...) requires a combinator producer or an ordinary .at method.');
        }
        return (producer as { at: (...values: unknown[]) => unknown }).at(...args.slice(1, -1));
      }
      this.#recordDslCall();
      if (this.#producerAttachments.has(producer.identity)) {
        throw new Error('.at(...) must be applied before .to(...) or another attachment.');
      }
      if (
        typeof x !== 'number' ||
        !Number.isFinite(x) ||
        typeof y !== 'number' ||
        !Number.isFinite(y)
      ) {
        throw new Error('.at(x, y, direction?) requires finite numeric coordinates.');
      }
      if (
        direction !== undefined &&
        (typeof direction !== 'number' ||
          !Number.isInteger(direction) ||
          direction < 0 ||
          direction > 15)
      ) {
        throw new Error('.at(...) direction must be an integer from 0 through 15.');
      }
      const placement: PlanEntityPlacement = {
        x,
        y,
        ...(direction === undefined ? {} : { direction }),
      };
      return this.#runtimeValue({
        kind: 'producer',
        identity: producer.identity,
        producer: { ...producer.producer, placement },
      });
    },
    attachTo: (...args: unknown[]): unknown => {
      const rawSpan = args.at(-1);
      const producer = args[0];
      const values = args.slice(1, -1);
      if (!isRawSpan(rawSpan)) throw new Error('.to(...) is missing provenance.');
      if (!this.#isProducer(producer)) {
        if (
          (typeof producer !== 'object' && typeof producer !== 'function') ||
          producer === null ||
          typeof (producer as { to?: unknown }).to !== 'function'
        ) {
          throw new Error('.to(...) requires a combinator producer or an ordinary .to method.');
        }
        return (producer as { to: (...items: unknown[]) => unknown }).to(...values);
      }
      this.#recordDslCall();
      let outputSignal = this.#isSignal(values.at(-1)) ? (values.pop() as SignalHandle) : undefined;
      let destinations: readonly NetworkValue[];
      if (values.length === 1 && this.#isSelected(values[0])) {
        const selected = values[0];
        if (this.#isPairSelection(selected)) {
          throw new ElaborationExecutionError(
            'pair(a, b) is a read-only input view and cannot be a .to(...) destination.',
            this.#span(rawSpan),
            'RT2020',
          );
        }
        if (outputSignal !== undefined || !isSignalId(selected.selection)) {
          throw new Error('A selected .to(...) destination must bind exactly one concrete Signal.');
        }
        outputSignal = selected.selection;
        destinations = [selected.network];
      } else if (values.every((value): value is NetworkValue => this.#isNetwork(value))) {
        destinations = values;
      } else {
        if (values.some((value) => this.#isPair(value))) {
          throw new ElaborationExecutionError(
            'pair(a, b) is a read-only input view and cannot be a .to(...) destination.',
            this.#span(rawSpan),
            'RT2020',
          );
        }
        throw new Error(
          '.to(...) permits Network[SIGNAL] only for one destination; use .to(first, second, SIGNAL) for fan-out.',
        );
      }
      return this.#attachMany(destinations, producer, rawSpan, outputSignal);
    },
    binary: (operator: string, left: unknown, right: unknown, rawSpan: RawSpan): unknown => {
      return operators.dispatchBinary(operator, left, right, rawSpan, this.#operatorContext);
    },
    addAssign: (
      left: unknown,
      right: unknown,
      assign: (value: unknown) => unknown,
      rawSpan: RawSpan,
    ): unknown => {
      const destination =
        this.#isNetwork(left) ||
        this.#isPair(left) ||
        this.#isSelected(left) ||
        this.#isDestination(left);
      if (destination) this.#assertWritableValue(left, rawSpan);
      if (destination && this.#isProducer(right)) {
        this.api.attach(left, right, rawSpan);
        return left;
      }
      if (destination) {
        throw new Error(
          'Network += requires a combinator producer; constants and Networks are not implicit attachments.',
        );
      }
      if (this.#isProducer(right)) {
        throw new Error('A combinator producer can only be attached to a Network destination.');
      }
      // The casts affect only TypeScript's checker; emitted JavaScript retains its native `+`
      // coercion rules for non-DSL values.
      const result = (left as number) + (right as number);
      assign(result);
      return result;
    },
    attach: (
      destination: NetworkValue | PairValue | SelectedValue | DestinationValue,
      producer: ProducerValue,
      rawSpan: RawSpan,
    ): void => {
      this.#recordDslCall();
      if (this.#isPair(destination) || this.#isPairSelection(destination)) {
        throw new ElaborationExecutionError(
          'pair(a, b) is a read-only input view and cannot receive a producer attachment.',
          this.#span(rawSpan),
          'RT2020',
        );
      }
      const destinations = this.#isDestination(destination)
        ? destination.networks
        : this.#isSelected(destination)
          ? [destination.network]
          : [destination];
      this.#attachMany(
        destinations,
        producer,
        rawSpan,
        this.#isDestination(destination)
          ? destination.signal
          : this.#isSelected(destination)
            ? isSignalId(destination.selection)
              ? destination.selection
              : (() => {
                  throw new Error('A destination can bind only a concrete Signal.');
                })()
            : undefined,
      );
    },
  });

  plan(): DirectElaborationPlan {
    this.#finalizeUnusedProducers();
    return {
      format: 'comblang-direct-plan',
      version: 2,
      networks: Object.freeze([...this.#networks]),
      networkTransfers: Object.freeze([...this.#networkTransfers]),
      networkPairs: Object.freeze([...this.#networkPairs]),
      capabilityUses: Object.freeze([...this.#capabilityUses]),
      producers: Object.freeze([...this.#producers]),
      diagnostics: Object.freeze([...this.#diagnostics]),
    };
  }

  executionApi(): typeof this.api {
    const wrapped = Object.entries(this.api).map(([name, operation]) => [
      name,
      (...args: unknown[]) => {
        try {
          const result = (operation as (...values: unknown[]) => unknown)(...args);
          if (this.#isProducer(result)) this.#knownProducers.set(result.identity, result);
          return result;
        } catch (error) {
          if (
            error instanceof ElaborationOperationLimitError ||
            error instanceof ElaborationExecutionError
          ) {
            throw error;
          }
          const rawSpan = args.at(-1);
          if (error instanceof Error && isRawSpan(rawSpan)) {
            throw new ElaborationExecutionError(
              error.message,
              this.#span(rawSpan),
              'EX1001',
              undefined,
              { cause: error },
            );
          }
          throw error;
        }
      },
    ]);
    return Object.freeze(Object.fromEntries(wrapped)) as typeof this.api;
  }

  #span(raw: RawSpan): SourceSpan {
    return { fileId: this.#fileId, start: raw.start, end: raw.end };
  }

  #finalizeUnusedProducers(): void {
    if (this.#unusedProducersFinalized) return;
    this.#unusedProducersFinalized = true;
    for (const producer of this.#knownProducers.values()) {
      if (!this.#producerAttachments.has(producer.identity)) {
        this.#discardProducer(producer, producer.producer.source);
      }
    }
  }

  #discardProducer(producer: ProducerValue, source: SourceSpan): void {
    this.#recordDslCall();
    const ordinal = this.#diagnostics.filter(({ code }) => code === 'CL2001').length + 1;
    const rawSpan = { start: source.start, end: source.end };
    const sink = this.#network(`$unused:${ordinal}`, rawSpan);
    this.#attach(sink, producer, rawSpan);
    this.#diagnostics.push({
      code: 'CL2001',
      severity: 'warning',
      message:
        'This producer has no destination; its topology is checked, but its output is unused.',
      span: source,
    });
  }

  #network(name: string, rawSpan: RawSpan, fixedColor?: 'red' | 'green'): NetworkValue {
    this.#recordDslCall();
    const occurrence = (this.#networkNameCounts.get(name) ?? 0) + 1;
    this.#networkNameCounts.set(name, occurrence);
    const instanceName = occurrence === 1 ? name : `$instance:${occurrence}:${name}`;
    const declaration = this.#span(rawSpan);
    this.#networks.push({
      name: instanceName,
      ...(fixedColor === undefined ? {} : { fixedColor }),
      source: declaration,
      instancePath: this.#path(),
    });
    const ownership: NetworkOwnershipState = {
      generation: 0,
      owner: this.#currentFunctionFrame()?.owner ?? 'top-level',
      readonlyBorrows: new Set(),
      ...(fixedColor === undefined
        ? {}
        : { colorRequirement: { color: fixedColor, source: declaration } }),
    };
    return this.#networkValue(
      {
        kind: 'network',
        name: instanceName,
        declaration,
        capability: 'owned',
        generation: 0,
      },
      { ownership },
    );
  }

  #bindingNetwork(descriptor: BindingDescriptor, rawSpan: RawSpan): NetworkValue {
    if (
      typeof descriptor !== 'object' ||
      descriptor === null ||
      typeof descriptor.name !== 'string' ||
      (descriptor.color !== undefined && descriptor.color !== 'red' && descriptor.color !== 'green')
    ) {
      throw new Error('Producer destructuring requires flat Network bindings.');
    }
    return this.#network(descriptor.name, rawSpan, descriptor.color);
  }

  #attach(network: NetworkValue, value: ProducerValue, rawSpan: RawSpan): void {
    this.#attachMany([network], value, rawSpan);
  }

  #attachMany(
    networks: readonly NetworkValue[],
    value: ProducerValue,
    rawSpan: RawSpan,
    outputSignal?: SignalId,
  ): ProducerValue {
    if (!networks.every((network) => this.#isNetwork(network)) || !this.#isProducer(value)) {
      throw new Error('Attachment requires a Network and producer.');
    }
    const source = this.#span(rawSpan);
    if (networks.length === 0) {
      throw new ElaborationExecutionError(
        'A producer attachment requires at least one Network destination.',
        source,
        'RT2003',
      );
    }
    const uniqueNames = new Set(networks.map(({ name }) => name));
    if (uniqueNames.size !== networks.length) {
      throw new ElaborationExecutionError(
        'A producer attachment repeats the same Network destination.',
        source,
        'RT2004',
        [...new Map(networks.map((network) => [network.name, network])).values()].map(
          (network) => ({
            message: 'Destination Network was declared here.',
            span: network.declaration,
          }),
        ),
      );
    }
    if (networks.length > 2) {
      throw new ElaborationExecutionError(
        'One Factorio output connector can attach to at most two logical Networks.',
        source,
        'RT2005',
        networks.map((network) => ({
          message: `Destination Network ${network.name} was declared here.`,
          span: network.declaration,
        })),
      );
    }
    const previousAttachment = this.#producerAttachments.get(value.identity);
    if (previousAttachment !== undefined) {
      throw new ElaborationExecutionError(
        'One Producer handle cannot be attached more than once; use one two-destination attachment for physical fan-out.',
        this.#span(rawSpan),
        'RT2006',
        [
          { message: 'Producer was first attached here.', span: previousAttachment },
          { message: 'Physical producer was created here.', span: value.producer.source },
        ],
      );
    }
    for (const network of networks) this.#assertWritableNetwork(network, rawSpan, 'destination');
    const boundValue = this.#bindOutputSignal(value, outputSignal, rawSpan);
    this.#producers.push({
      ...boundValue.producer,
      destinations: networks.map((network) => ({
        network: network.name,
        source,
        instancePath: this.#path(),
      })),
    } as unknown as DirectPlanProducer);
    this.#producerAttachments.set(value.identity, source);
    return boundValue;
  }

  #isNetwork(value: unknown): value is NetworkValue {
    return this.#hasRuntimeKind(value, 'network');
  }

  #networkValue<T extends NetworkValue>(value: T, state: NetworkRuntimeState): T {
    return this.#runtimeValues.brandNetwork(value, state);
  }

  #networkState(value: NetworkValue): NetworkRuntimeState {
    const state = this.#runtimeValues.networkState(value);
    if (state === undefined) throw new Error('Network handle is missing opaque runtime state.');
    return state;
  }

  #assertReadableNetwork(network: NetworkValue, rawSpan: RawSpan, role = 'Network'): void {
    this.#ownership.assertReadable(network, this.#span(rawSpan), role);
  }

  #requireNetworkColor(
    network: NetworkValue,
    capability: 'readonly' | 'ref' | 'move',
    color: 'red' | 'green',
    rawSpan: RawSpan,
  ): void {
    if (!this.#ownership.requireColor(network, capability, color, this.#span(rawSpan))) return;
    const index = this.#networks.findLastIndex(({ name }) => name === network.name);
    const declaration = this.#networks[index];
    if (declaration === undefined) {
      throw new Error(`Cannot find Network descriptor for color requirement: ${network.name}.`);
    }
    this.#networks[index] = { ...declaration, fixedColor: color };
  }

  #assertWritableNetwork(network: NetworkValue, rawSpan: RawSpan, role = 'Network'): void {
    this.#ownership.assertWritable(network, this.#span(rawSpan), role);
  }

  #assertConsumableNetwork(network: NetworkValue, rawSpan: RawSpan, role: string): void {
    this.#ownership.assertConsumable(network, this.#span(rawSpan), role);
  }

  #returnOwnedValue(value: unknown, rawSpan: RawSpan, seen: Map<object, unknown>): unknown {
    if (this.#isProducer(value)) {
      return value.functionReturn === undefined
        ? this.#runtimeValue({ ...value, functionReturn: this.#span(rawSpan) })
        : value;
    }
    if (this.#isPair(value) || this.#isPairSelection(value)) {
      throw new ElaborationExecutionError(
        'pair(a, b) is a read-only input view and cannot carry ownership across a return.',
        this.#span(rawSpan),
        'RT2020',
        this.#isPair(value)
          ? [{ message: 'The pair view was created here.', span: value.source }]
          : undefined,
      );
    }
    if (this.#isNetwork(value)) return this.#returnOwnedNetwork(value, rawSpan);
    if (typeof value !== 'object' || value === null) return value;
    const previous = seen.get(value);
    if (previous !== undefined) return previous;
    if (Array.isArray(value)) {
      const result: unknown[] = [];
      seen.set(value, result);
      let changed = false;
      for (const item of value) {
        const returned = this.#returnOwnedValue(item, rawSpan, seen);
        result.push(returned);
        if (returned !== item) changed = true;
      }
      return changed ? result : value;
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return value;
    const result: Record<string, unknown> = {};
    seen.set(value, result);
    let changed = false;
    for (const [key, item] of Object.entries(value)) {
      const returned = this.#returnOwnedValue(item, rawSpan, seen);
      result[key] = returned;
      if (returned !== item) changed = true;
    }
    return changed ? result : value;
  }

  #producerHandle(value: unknown, expectedType: unknown, rawSpan: RawSpan): ProducerValue {
    const expectedKinds = {
      Producer: undefined,
      DeciderCombinator: 'decider',
      ArithmeticCombinator: 'arithmetic',
      ConstantCombinator: 'constant',
    } as const;
    if (typeof expectedType !== 'string' || !(expectedType in expectedKinds)) {
      throw new Error('Unknown Producer handle annotation.');
    }
    const expectedKind = expectedKinds[expectedType as keyof typeof expectedKinds];
    if (
      !this.#isProducer(value) ||
      (expectedKind !== undefined && value.producer.kind !== expectedKind)
    ) {
      throw new ElaborationExecutionError(
        `${expectedType} requires ${expectedKind === undefined ? 'a combinator producer' : `a ${expectedKind} combinator producer`}.`,
        this.#span(rawSpan),
        'RT2022',
      );
    }
    return value;
  }

  #returnOwnedNetwork(value: NetworkValue, rawSpan: RawSpan): NetworkValue {
    this.#recordDslCall();
    const frame = this.#currentFunctionFrame();
    if (frame === undefined) {
      throw new ElaborationExecutionError(
        `Function cannot return Network ${value.name} because it does not own that value; accept it as Move<Network> first.`,
        this.#span(rawSpan),
        'RT2019',
        [{ message: 'Network declared here.', span: value.declaration }],
      );
    }
    const caller = this.#parentFunctionFrame();
    const state = this.#networkState(value);
    this.#ownership.returnToCaller(value, this.#span(rawSpan), frame, caller);
    return this.#networkValue(
      {
        kind: 'network',
        name: value.name,
        declaration: value.declaration,
        capability: 'owned',
        generation: state.ownership.generation,
      },
      { ownership: state.ownership },
    );
  }

  #path(): readonly string[] {
    return Object.freeze([...this.#instancePath]);
  }

  #currentFunctionFrame(): FunctionOwnershipFrame | undefined {
    return this.#ownershipFrames.findLast((frame) => frame !== undefined);
  }

  #parentFunctionFrame(): FunctionOwnershipFrame | undefined {
    let foundCurrent = false;
    for (let index = this.#ownershipFrames.length - 1; index >= 0; index -= 1) {
      const frame = this.#ownershipFrames[index];
      if (frame === undefined) continue;
      if (!foundCurrent) {
        foundCurrent = true;
        continue;
      }
      return frame;
    }
    return undefined;
  }

  #isSignalValue(value: unknown): value is SignalValue {
    return this.#hasRuntimeKind(value, 'signal-value');
  }

  #isSignal(value: unknown): value is SignalHandle {
    return this.#runtimeValues.hasSignal(value);
  }

  #signalHandle(value: SignalId): SignalHandle {
    return this.#runtimeValues.brandSignal(value);
  }

  #isSelected(value: unknown): value is SelectedValue {
    return this.#hasRuntimeKind(value, 'selected');
  }

  #isPair(value: unknown): value is PairValue {
    return this.#hasRuntimeKind(value, 'pair');
  }

  #isPairSelection(value: unknown): value is PairSelectedValue {
    return this.#isSelected(value) && value.networks !== undefined;
  }

  #isWildcardToken(value: unknown): value is WildcardTokenValue {
    return this.#hasRuntimeKind(value, 'wildcard-token');
  }

  #isWildcardCount(value: unknown): value is WildcardCountValue {
    return this.#hasRuntimeKind(value, 'wildcard-count');
  }

  #isDestination(value: unknown): value is DestinationValue {
    return this.#hasRuntimeKind(value, 'destinations');
  }

  #select(value: unknown, signal: unknown, rawSpan: RawSpan): SelectedValue | DestinationValue {
    const concreteSignal =
      typeof signal === 'string'
        ? Signal('item', signal)
        : this.#isSignal(signal)
          ? signal
          : undefined;
    const selection = concreteSignal ?? (this.#isWildcardToken(signal) ? signal.value : signal);
    const isWildcard =
      selection === 'each' || selection === 'anything' || selection === 'everything';
    if (concreteSignal === undefined && !isWildcard) {
      throw new Error('Network selection requires a Signal or wildcard.');
    }
    if (this.#isDestination(value)) {
      if (concreteSignal === undefined) {
        throw new Error('to(...)[SIGNAL] requires one concrete output Signal.');
      }
      if (value.signal !== undefined && !sameSignal(value.signal, concreteSignal)) {
        throw new Error('A to(...) destination already has a conflicting output Signal.');
      }
      return this.#runtimeValue({ ...value, signal: concreteSignal });
    }
    if (!this.#isNetwork(value) && !this.#isPair(value)) {
      throw new Error('Signal selection requires a Network or pair(a, b).');
    }
    this.#assertReadableValue(value, rawSpan);
    return this.#selectedValue(value, concreteSignal ?? (selection as WildcardName));
  }

  #selectedValue(
    value: NetworkValue | PairValue,
    selection: SignalId | WildcardName,
  ): SelectedValue {
    return this.#isPair(value)
      ? this.#runtimeValue({
          kind: 'selected',
          network: value.networks[0],
          networks: value.networks,
          selection,
        })
      : this.#runtimeValue({ kind: 'selected', network: value, selection });
  }

  #planNetworkRef(value: NetworkValue | PairValue | SelectedValue):
    | {
        readonly refKind: 'single';
        readonly network: string;
      }
    | {
        readonly refKind: 'pair';
        readonly networks: readonly [string, string];
      } {
    if (this.#isPair(value)) {
      return {
        refKind: 'pair',
        networks: [value.networks[0].name, value.networks[1].name],
      };
    }
    if (this.#isNetwork(value)) return { refKind: 'single', network: value.name };
    return value.networks === undefined
      ? { refKind: 'single', network: value.network.name }
      : {
          refKind: 'pair',
          networks: [value.networks[0].name, value.networks[1].name],
        };
  }

  #readableNetworks(value: PairValue | SelectedValue): readonly NetworkValue[] {
    return this.#isPair(value) ? value.networks : (value.networks ?? [value.network]);
  }

  #arithmeticOperand(value: DslValue, rawSpan: RawSpan): PlanArithmeticOperand {
    if (typeof value === 'number') return { kind: 'constant', value };
    if (this.#isNetwork(value)) {
      this.#assertReadableNetwork(value, rawSpan);
      return { kind: 'each', refKind: 'single', network: value.name };
    }
    if (this.#isPair(value)) {
      this.#assertReadableValue(value, rawSpan);
      return { kind: 'each', ...this.#planNetworkRef(value) };
    }
    if (this.#isSelected(value)) {
      this.#assertReadableValue(value, rawSpan);
      if (isSignalId(value.selection)) {
        return { kind: 'signal', ...this.#planNetworkRef(value), signal: value.selection };
      }
      if (value.selection === 'each') return { kind: 'each', ...this.#planNetworkRef(value) };
      throw new Error('Anything/Everything cannot be arithmetic operands.');
    }
    if (this.#isProducer(value)) {
      const temporary = this.#network(`$tmp:${++this.#anonymousOrdinal}`, rawSpan);
      this.#attach(temporary, value, rawSpan);
      return { kind: 'each', refKind: 'single', network: temporary.name };
    }
    throw new Error('Circuit arithmetic currently requires a Network or numeric operand.');
  }

  #isProducer(value: unknown): value is ProducerValue {
    return this.#hasRuntimeKind(value, 'producer');
  }

  #isCondition(value: unknown): value is ConditionValue {
    return this.#hasRuntimeKind(value, 'condition');
  }

  #runtimeValue<T extends RuntimeObjectValue>(value: T): T {
    return this.#runtimeValues.brand(value);
  }

  #hasRuntimeKind(value: unknown, kind: RuntimeObjectKind): boolean {
    return this.#runtimeValues.hasKind(value, kind);
  }

  #deciderOutput(
    output: unknown,
    rawSpan: RawSpan,
  ): Extract<DirectPlanProducer, { kind: 'decider' }>['output'] {
    if (this.#isSignalValue(output)) {
      return { kind: 'signal-constant', signal: output.signal, value: output.value };
    }
    if (this.#isWildcardCount(output)) {
      if (output.wildcard !== 'each') {
        throw new Error('Only EACH supports a constant-count decider output.');
      }
      return { kind: 'each-constant', value: output.value };
    }
    if (this.#isSelected(output)) {
      this.#assertReadableValue(output, rawSpan);
      return isSignalId(output.selection)
        ? { kind: 'signal', ...this.#planNetworkRef(output), signal: output.selection }
        : output.selection === 'each'
          ? { kind: 'each', ...this.#planNetworkRef(output) }
          : {
              kind: 'wildcard',
              ...this.#planNetworkRef(output),
              wildcard: output.selection,
            };
    }
    if (this.#isPair(output)) {
      this.#assertReadableValue(output, rawSpan);
      return { kind: 'each', ...this.#planNetworkRef(output) };
    }
    if (this.#isNetwork(output)) {
      this.#assertReadableNetwork(output, rawSpan);
      return { kind: 'each', refKind: 'single', network: output.name };
    }
    throw new Error('Unsupported decider output specification.');
  }

  #bindOutputSignal(
    value: ProducerValue,
    signal: SignalId | undefined,
    rawSpan: RawSpan,
    explicit = false,
  ): ProducerValue {
    if (signal === undefined) return value;
    if (value.boundOutputSignal !== undefined && !sameSignal(value.boundOutputSignal, signal)) {
      this.#outputBindingFailure(
        'Explicit producer output Signal conflicts with its destination binding.',
        value,
        rawSpan,
      );
    }
    let bound: ProducerValue;
    if (value.producer.kind === 'constant') {
      this.#outputBindingFailure(
        'A constant combinator output cannot be rebound to another Signal.',
        value,
        rawSpan,
      );
    } else if (value.producer.kind === 'arithmetic') {
      bound = this.#runtimeValue({
        kind: 'producer',
        identity: value.identity,
        producer: { ...value.producer, output: { kind: 'signal', signal } },
      });
    } else {
      if ((value.producer.outputs?.length ?? 1) !== 1) {
        this.#outputBindingFailure(
          'A multi-output decider cannot be rebound to one destination Signal.',
          value,
          rawSpan,
        );
      }
      const output = value.producer.output;
      if (output.kind === 'signal') {
        if (!sameSignal(output.signal, signal)) {
          this.#outputBindingFailure(
            'Decider output Signal conflicts with its destination binding.',
            value,
            rawSpan,
          );
        }
        bound = value;
      } else if (output.kind === 'each') {
        bound = this.#runtimeValue({
          kind: 'producer',
          identity: value.identity,
          producer: {
            ...value.producer,
            output: {
              kind: 'signal',
              ...(output.refKind === 'single'
                ? { refKind: 'single' as const, network: output.network }
                : { refKind: 'pair' as const, networks: output.networks }),
              signal,
            },
          },
        });
      } else if (output.kind === 'each-constant') {
        bound = this.#runtimeValue({
          kind: 'producer',
          identity: value.identity,
          producer: {
            ...value.producer,
            output: { kind: 'signal-constant', signal, value: output.value },
          },
        });
      } else {
        this.#outputBindingFailure(
          'Wildcard decider output cannot be rebound to a concrete Signal.',
          value,
          rawSpan,
        );
      }
    }
    return explicit || value.boundOutputSignal !== undefined
      ? this.#runtimeValue({
          ...bound,
          boundOutputSignal: signal,
          boundOutputSource: value.boundOutputSource ?? this.#span(rawSpan),
        })
      : bound;
  }

  #outputBindingFailure(message: string, value: ProducerValue, rawSpan: RawSpan): never {
    const primary = this.#span(rawSpan);
    const related = [
      ...(value.boundOutputSource === undefined
        ? []
        : [
            {
              message: 'Producer output was explicitly bound here.',
              span: value.boundOutputSource,
            },
          ]),
      { message: 'Physical producer was created here.', span: value.producer.source },
    ].filter(
      (entry, index, entries) =>
        entries.findIndex(
          (candidate) =>
            candidate.span.fileId === entry.span.fileId &&
            candidate.span.start === entry.span.start &&
            candidate.span.end === entry.span.end,
        ) === index &&
        !(
          entry.span.fileId === primary.fileId &&
          entry.span.start === primary.start &&
          entry.span.end === primary.end
        ),
    );
    throw new ElaborationExecutionError(message, primary, 'RT2023', related);
  }

  #isCircuitDslValue(value: unknown): value is DslValue {
    return (
      this.#isSignal(value) ||
      this.#isNetwork(value) ||
      this.#isPair(value) ||
      this.#isSelected(value) ||
      this.#isDestination(value) ||
      this.#isSignalValue(value) ||
      this.#isWildcardToken(value) ||
      this.#isWildcardCount(value) ||
      this.#isCondition(value) ||
      this.#isProducer(value)
    );
  }

  #assertReadableValue(value: unknown, rawSpan: RawSpan): void {
    if (this.#isNetwork(value)) this.#assertReadableNetwork(value, rawSpan);
    if (this.#isPair(value)) {
      for (const network of value.networks) this.#assertReadableNetwork(network, rawSpan);
    }
    if (this.#isSelected(value)) {
      for (const network of this.#readableNetworks(value))
        this.#assertReadableNetwork(network, rawSpan);
    }
    if (this.#isDestination(value)) {
      for (const network of value.networks) this.#assertReadableNetwork(network, rawSpan);
    }
  }

  #assertWritableValue(value: unknown, rawSpan: RawSpan): void {
    if (this.#isNetwork(value)) this.#assertWritableNetwork(value, rawSpan);
    if (this.#isPair(value) || this.#isPairSelection(value)) {
      throw new ElaborationExecutionError(
        'pair(a, b) is a read-only input view and cannot receive producer attachments.',
        this.#span(rawSpan),
        'RT2020',
      );
    }
    if (this.#isSelected(value)) this.#assertWritableNetwork(value.network, rawSpan);
    if (this.#isDestination(value)) {
      for (const network of value.networks) this.#assertWritableNetwork(network, rawSpan);
    }
  }

  #recordDslCall(): void {
    this.#dslCalls += 1;
    if (this.#dslCalls > this.#dslCallBudget) {
      throw new ElaborationOperationLimitError(this.#dslCallBudget);
    }
  }
}

/** Must be invoked only inside a disposable, time-bounded worker for untrusted source. */
export function executeElaborationProgram(
  program: ElaborationJavaScript,
  options: ElaborationExecutionOptions = {},
): DirectElaborationPlan {
  if (program.format !== 'comblang-elaboration-js' || program.version !== 1) {
    throw new Error('Unsupported elaboration JavaScript format.');
  }
  const dslCallBudget = options.dslCallBudget ?? options.operationBudget ?? 100_000;
  if (!Number.isSafeInteger(dslCallBudget) || dslCallBudget <= 0) {
    throw new Error('Elaboration DSL call budget must be a positive safe integer.');
  }
  const recorder = new ElaborationRecorder(program.fileId, dslCallBudget);
  Function('__dsl', `"use strict";\n${program.code}`)(recorder.executionApi());
  return recorder.plan();
}

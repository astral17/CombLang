import { Signal, type SignalId } from '@comblang/factorio';
import type {
  DirectElaborationPlan,
  DirectPlanProducer,
  ElaborationJavaScript,
  ArithmeticOperation,
  PlanEntityPlacement,
  PlanArithmeticOperand,
  PlanComparator,
  PlanDeciderCondition,
} from '@comblang/compiler';
import type { Diagnostic, SourceFileId, SourceSpan } from '@comblang/shared';

interface RawSpan {
  readonly start: number;
  readonly end: number;
}

export interface ElaborationExecutionOptions {
  readonly dslCallBudget?: number;
  /** @deprecated Use dslCallBudget. */
  readonly operationBudget?: number;
}

export class ElaborationOperationLimitError extends Error {
  constructor(limit: number) {
    super(
      `Compile-time generator exceeded the safety limit of ${limit} circuit-recording DSL calls.`,
    );
    this.name = 'ElaborationOperationLimitError';
  }
}

export class ElaborationExecutionError extends Error {
  constructor(
    message: string,
    readonly span: SourceSpan,
    readonly code = 'EX1001',
    readonly related: Diagnostic['related'] = undefined,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'ElaborationExecutionError';
  }
}

type RuntimeNetworkCapability = 'owned' | 'readonly' | 'ref' | 'move';

interface NetworkBorrow {
  readonly capability: 'readonly' | 'ref';
  readonly parameter: string;
  readonly source: SourceSpan;
  readonly ownership: NetworkOwnershipState;
  active: boolean;
  releasedAt?: SourceSpan;
}

interface NetworkMove {
  readonly ownership: NetworkOwnershipState;
  readonly source: SourceSpan;
  returned: boolean;
}

interface FunctionOwnershipFrame {
  readonly owner: symbol;
  readonly source: SourceSpan;
  readonly borrows: NetworkBorrow[];
  readonly moves: NetworkMove[];
}

interface NetworkOwnershipState {
  consumedAt?: SourceSpan;
  lastMove?: { readonly source: SourceSpan; readonly generation: number };
  generation: number;
  owner: symbol | 'top-level' | 'lost';
  colorRequirement?: { readonly color: 'red' | 'green'; readonly source: SourceSpan };
  readonlyBorrows: Set<NetworkBorrow>;
  mutableBorrow?: NetworkBorrow;
}

interface NetworkValue {
  readonly kind: 'network';
  readonly name: string;
  readonly declaration: SourceSpan;
  readonly ownership: NetworkOwnershipState;
  readonly capability: RuntimeNetworkCapability;
  readonly generation: number;
  readonly borrow?: NetworkBorrow;
}

interface SignalValue {
  readonly kind: 'signal-value';
  readonly signal: SignalId;
  readonly value: number;
}

interface SelectedValue {
  readonly kind: 'selected';
  readonly network: NetworkValue;
  readonly selection: SignalId | WildcardName;
}

type WildcardName = 'each' | 'anything' | 'everything';

interface WildcardTokenValue {
  readonly kind: 'wildcard-token';
  readonly value: WildcardName;
}

interface WildcardCountValue {
  readonly kind: 'wildcard-count';
  readonly wildcard: WildcardName;
  readonly value: number;
}

interface DestinationValue {
  readonly kind: 'destinations';
  readonly networks: readonly NetworkValue[];
  readonly signal?: SignalId;
}

interface ConditionValue {
  readonly kind: 'condition';
  readonly condition: PlanDeciderCondition;
}

interface BindingDescriptor {
  readonly name: string;
  readonly color?: 'red' | 'green';
  readonly property?: string;
}

type WithoutDestinations<T> = T extends unknown ? Omit<T, 'destinations'> : never;

interface ProducerValue {
  readonly kind: 'producer';
  readonly producer: WithoutDestinations<DirectPlanProducer>;
  /** Explicit `.as(...)` constraint; inferred arithmetic outputs remain overridable. */
  readonly boundOutputSignal?: SignalId;
}

type DslValue =
  | NetworkValue
  | SelectedValue
  | DestinationValue
  | SignalValue
  | WildcardTokenValue
  | WildcardCountValue
  | ConditionValue
  | ProducerValue
  | SignalId
  | number;

const comparatorMap: Readonly<Record<string, PlanComparator>> = {
  '>': '>',
  '<': '<',
  '>=': '>=',
  '<=': '<=',
  '==': '=',
  '===': '=',
  '!=': '!=',
  '!==': '!=',
};

const arithmeticMap: Readonly<Record<string, ArithmeticOperation>> = {
  '+': 'add',
  '-': 'subtract',
  '*': 'multiply',
  '/': 'divide',
  '%': 'modulo',
  '**': 'power',
  '<<': 'left-shift',
  '>>': 'right-shift',
  '&': 'bit-and',
  '|': 'bit-or',
  '^': 'bit-xor',
};

function isSignal(value: unknown): value is SignalId {
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
  readonly #producers: DirectPlanProducer[] = [];
  readonly #diagnostics: Diagnostic[] = [];
  readonly #attachedProducers = new WeakSet<object>();
  #anonymousOrdinal = 0;
  readonly #networkNameCounts = new Map<string, number>();
  readonly #anonymousLoopCounts = new Map<string, number>();
  readonly #instancePath: string[] = [];
  readonly #ownershipFrames: (FunctionOwnershipFrame | undefined)[] = [];
  readonly #dslCallBudget: number;
  #dslCalls = 0;

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
        for (const borrow of frame.borrows.toReversed()) {
          borrow.active = false;
          if (isRawSpan(rawSpan)) borrow.releasedAt = this.#span(rawSpan);
          const ownership = borrow.ownership;
          if (borrow.capability === 'readonly') ownership.readonlyBorrows.delete(borrow);
          else if (ownership.mutableBorrow === borrow) delete ownership.mutableBorrow;
        }
        for (const move of frame.moves.toReversed()) {
          if (
            !move.returned &&
            move.ownership.consumedAt === undefined &&
            move.ownership.owner === frame.owner
          ) {
            move.ownership.generation += 1;
            move.ownership.owner = 'lost';
            move.ownership.lastMove = {
              source: isRawSpan(rawSpan) ? this.#span(rawSpan) : frame.source,
              generation: move.ownership.generation,
            };
          }
        }
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
      if (values.length === 1) return Signal(values[0] as string);
      const [type, name, quality] = values as [SignalId['type'], string, string?];
      return Signal(type, name, quality);
    },
    wildcardToken: (value: WildcardName): WildcardTokenValue => ({
      kind: 'wildcard-token',
      value,
    }),
    wildcard: (value: WildcardName, network: NetworkValue, rawSpan: RawSpan): SelectedValue => {
      this.#recordDslCall();
      if (!this.#isNetwork(network)) throw new Error('Wildcard selection requires a Network.');
      this.#assertReadableNetwork(network, rawSpan);
      return { kind: 'selected', network, selection: value };
    },
    constant: (...args: unknown[]): ProducerValue => {
      this.#recordDslCall();
      const rawSpan = args.at(-1);
      if (!isRawSpan(rawSpan)) throw new Error('Constant combinator is missing provenance.');
      const outputs = args.slice(0, -1);
      if (!outputs.every((value): value is SignalValue => this.#isSignalValue(value))) {
        throw new Error('CC entries must be numeric Signal values.');
      }
      return {
        kind: 'producer',
        producer: {
          kind: 'constant',
          outputs: outputs.map(({ signal, value }) => ({ signal, value })),
          source: this.#span(rawSpan),
          instancePath: this.#path(),
        },
      };
    },
    network: (
      name: string | undefined,
      fixedColor: 'red' | 'green' | undefined,
      rawSpan: RawSpan,
    ): NetworkValue => {
      return this.#network(name ?? `$network:${++this.#anonymousOrdinal}`, rawSpan, fixedColor);
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
      this.#assertReadableNetwork(value, rawSpan);
      if (fixedColor !== undefined)
        this.#requireNetworkColor(value, capability, fixedColor, rawSpan);
      const frame = this.#currentFunctionFrame();
      if (frame === undefined) {
        throw new Error('Network parameter borrow was created outside a function frame.');
      }
      const ownership = value.ownership;
      const conflicting =
        capability === 'readonly'
          ? ownership.mutableBorrow
          : (ownership.mutableBorrow ?? ownership.readonlyBorrows.values().next().value);
      if (conflicting !== undefined) {
        throw new ElaborationExecutionError(
          `Cannot create ${capability === 'readonly' ? 'Readonly<Network>' : 'Ref<Network>'} parameter ${parameter} while Network ${value.name} is already borrowed.`,
          this.#span(rawSpan),
          'RT2016',
          [{ message: 'Conflicting borrow created here.', span: conflicting.source }],
        );
      }
      const borrow: NetworkBorrow = {
        capability,
        parameter,
        source: this.#span(rawSpan),
        ownership,
        active: true,
      };
      if (capability === 'readonly') ownership.readonlyBorrows.add(borrow);
      else ownership.mutableBorrow = borrow;
      frame.borrows.push(borrow);
      return {
        kind: 'network',
        name: value.name,
        declaration: value.declaration,
        ownership,
        capability,
        generation: value.generation,
        borrow,
      };
    },
    moveParameter: (
      value: unknown,
      parameter: string,
      fixedColor: 'red' | 'green' | undefined,
      rawSpan: RawSpan,
    ): NetworkValue => {
      if (!isRawSpan(rawSpan)) throw new Error('Invalid Move<Network> parameter descriptor.');
      if (!this.#isNetwork(value)) {
        throw new ElaborationExecutionError(
          `Move<Network> parameter ${parameter} received a non-Network value.`,
          this.#span(rawSpan),
          'RT2015',
        );
      }
      this.#recordDslCall();
      this.#assertConsumableNetwork(value, rawSpan, 'source');
      const frame = this.#currentFunctionFrame();
      if (frame === undefined) {
        throw new Error('Network ownership transfer was created outside a function frame.');
      }
      if (fixedColor !== undefined) this.#requireNetworkColor(value, 'move', fixedColor, rawSpan);
      const ownership = value.ownership;
      ownership.generation += 1;
      ownership.owner = frame.owner;
      ownership.lastMove = {
        source: this.#span(rawSpan),
        generation: ownership.generation,
      };
      frame.moves.push({ ownership, source: this.#span(rawSpan), returned: false });
      return {
        kind: 'network',
        name: value.name,
        declaration: value.declaration,
        ownership,
        capability: 'move',
        generation: ownership.generation,
      };
    },
    returnValue: (value: unknown, rawSpan: RawSpan): unknown => {
      return this.#returnOwnedValue(value, rawSpan, new Map());
    },
    take: (...args: unknown[]): unknown => {
      const rawSpan = args.at(-1);
      const destination = args[0];
      const values = args.slice(1, -1);
      if (!isRawSpan(rawSpan)) throw new Error('.take(...) is missing provenance.');
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
      if (destination.ownership === source.ownership) {
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
      source.ownership.consumedAt = provenance;
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
      if (!this.#isProducer(value)) return value;
      if (!Array.isArray(descriptors)) throw new Error('Invalid array binding descriptors.');
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
      if (!this.#isProducer(value)) return value;
      if (!Array.isArray(descriptors)) throw new Error('Invalid object binding descriptors.');
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
      if (!this.#isProducer(value) || this.#attachedProducers.has(value)) return;
      this.#recordDslCall();
      const ordinal = this.#diagnostics.filter(({ code }) => code === 'CL2001').length + 1;
      const sink = this.#network(`$unused:${ordinal}`, rawSpan);
      this.#attach(sink, value, rawSpan);
      this.#diagnostics.push({
        code: 'CL2001',
        severity: 'warning',
        message:
          'This producer has no destination; its topology is checked, but its output is unused.',
        span: this.#span(rawSpan),
      });
    },
    compare: (operator: string, left: unknown, right: unknown, rawSpan: RawSpan): unknown => {
      const comparator = comparatorMap[operator];
      if (comparator === undefined) throw new Error(`Unsupported comparator: ${operator}.`);
      if (!this.#isCircuitDslValue(left) && !this.#isCircuitDslValue(right)) {
        return this.#compareJavaScript(operator, left, right);
      }
      this.#recordDslCall();
      this.#assertReadableValue(left, rawSpan);
      this.#assertReadableValue(right, rawSpan);
      if (this.#isSelected(left) && this.#isSelected(right)) {
        if (!isSignal(left.selection) || !isSignal(right.selection)) {
          throw new Error('Signal-to-signal comparison requires concrete Signal selections.');
        }
        return {
          kind: 'condition',
          condition: {
            kind: 'compare-signals',
            left: { network: left.network.name, signal: left.selection },
            comparator,
            right: { network: right.network.name, signal: right.selection },
          },
        };
      }
      const selected = this.#isSelected(left) ? left : this.#isSelected(right) ? right : undefined;
      const selectedConstant =
        typeof left === 'number' ? left : typeof right === 'number' ? right : undefined;
      if (selected !== undefined && selectedConstant !== undefined) {
        const normalized = this.#isSelected(left)
          ? comparator
          : this.#reverseComparator(comparator);
        return {
          kind: 'condition',
          condition: isSignal(selected.selection)
            ? {
                kind: 'compare-signal',
                network: selected.network.name,
                signal: selected.selection,
                comparator: normalized,
                constant: selectedConstant,
              }
            : selected.selection === 'each'
              ? {
                  kind: 'compare-each',
                  network: selected.network.name,
                  comparator: normalized,
                  constant: selectedConstant,
                }
              : {
                  kind: 'compare-wildcard',
                  network: selected.network.name,
                  wildcard: selected.selection,
                  comparator: normalized,
                  constant: selectedConstant,
                },
        };
      }
      const network = this.#isNetwork(left) ? left : this.#isNetwork(right) ? right : undefined;
      const constant =
        typeof left === 'number' ? left : typeof right === 'number' ? right : undefined;
      if (network === undefined || constant === undefined) {
        throw new Error('The first executable comparison slice requires Network vs number.');
      }
      const normalized = this.#isNetwork(left) ? comparator : this.#reverseComparator(comparator);
      return {
        kind: 'condition',
        condition: {
          kind: 'compare-each',
          network: network.name,
          comparator: normalized,
          constant,
        },
      };
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
      return {
        kind: 'producer',
        producer: {
          kind: 'decider',
          condition: condition.condition,
          output: outputs[0]!,
          ...(outputs.length === 1 ? {} : { outputs }),
          source: this.#span(rawSpan),
          instancePath: this.#path(),
        },
      };
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
      return {
        kind: 'condition',
        condition: { kind: operator, conditions: [left.condition, right.condition] },
      };
    },
    not: (value: ConditionValue | boolean, _rawSpan: RawSpan): ConditionValue | boolean => {
      if (typeof value === 'boolean') return !value;
      this.#recordDslCall();
      return { kind: 'condition', condition: this.#invertCondition(value.condition) };
    },
    destinations: (...args: unknown[]): DestinationValue => {
      this.#recordDslCall();
      const rawSpan = args.at(-1);
      if (!isRawSpan(rawSpan)) throw new Error('to(...) is missing provenance.');
      const values = args.slice(0, -1);
      const outputSignal = isSignal(values.at(-1)) ? (values.pop() as SignalId) : undefined;
      if (!values.every((value): value is NetworkValue => this.#isNetwork(value))) {
        throw new Error(
          'to(...) destinations must be Networks; pass an optional output Signal as the final argument.',
        );
      }
      for (const network of values) this.#assertWritableNetwork(network, rawSpan, 'destination');
      return {
        kind: 'destinations',
        networks: values,
        ...(outputSignal === undefined ? {} : { signal: outputSignal }),
      };
    },
    select: (
      value: NetworkValue | DestinationValue,
      signal: SignalId | WildcardTokenValue,
      rawSpan: RawSpan,
    ): SelectedValue | DestinationValue => {
      this.#recordDslCall();
      return this.#select(value, signal, rawSpan);
    },
    element: (value: unknown, key: unknown, rawSpan: RawSpan): unknown => {
      if (this.#isNetwork(value) || this.#isDestination(value)) {
        this.#recordDslCall();
        return this.#select(value, key, rawSpan);
      }
      if (value === null || value === undefined) {
        throw new TypeError(`Cannot read properties of ${String(value)}.`);
      }
      return (value as Record<PropertyKey, unknown>)[key as PropertyKey];
    },
    bindOutput: (producer: ProducerValue, signal: SignalId, _rawSpan: RawSpan): ProducerValue => {
      this.#recordDslCall();
      if (!isSignal(signal)) throw new Error('.as(...) requires a Signal.');
      return this.#bindOutputSignal(producer, signal, true);
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
      if (this.#attachedProducers.has(producer)) {
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
      return {
        kind: 'producer',
        producer: { ...producer.producer, placement },
      };
    },
    attachTo: (...args: unknown[]): ProducerValue => {
      this.#recordDslCall();
      const rawSpan = args.at(-1);
      const producer = args[0];
      const values = args.slice(1, -1);
      let outputSignal = isSignal(values.at(-1)) ? (values.pop() as SignalId) : undefined;
      let destinations: readonly NetworkValue[];
      if (!isRawSpan(rawSpan) || !this.#isProducer(producer)) {
        throw new Error('.to(...) requires a producer and provenance.');
      }
      if (values.length === 1 && this.#isSelected(values[0])) {
        const selected = values[0];
        if (outputSignal !== undefined || !isSignal(selected.selection)) {
          throw new Error('A selected .to(...) destination must bind exactly one concrete Signal.');
        }
        outputSignal = selected.selection;
        destinations = [selected.network];
      } else if (values.every((value): value is NetworkValue => this.#isNetwork(value))) {
        destinations = values;
      } else {
        throw new Error(
          '.to(...) permits Network[SIGNAL] only for one destination; use .to(first, second, SIGNAL) for fan-out.',
        );
      }
      const boundProducer = this.#bindOutputSignal(producer, outputSignal);
      this.#attachMany(destinations, boundProducer, rawSpan);
      return boundProducer;
    },
    binary: (operator: string, left: unknown, right: unknown, rawSpan: RawSpan): unknown => {
      if (!this.#isCircuitDslValue(left) && !this.#isCircuitDslValue(right)) {
        return this.#binaryJavaScript(operator, left, right);
      }
      this.#recordDslCall();
      this.#assertReadableValue(left, rawSpan);
      this.#assertReadableValue(right, rawSpan);
      const signal = isSignal(left) ? left : isSignal(right) ? right : undefined;
      const signalCount =
        typeof left === 'number' ? left : typeof right === 'number' ? right : undefined;
      if (
        signal !== undefined ||
        (signalCount !== undefined && (isSignal(left) || isSignal(right)))
      ) {
        if (operator !== '*' || signal === undefined || signalCount === undefined) {
          throw new Error('A typed Signal value must use numericCount * Signal.');
        }
        return { kind: 'signal-value', signal, value: signalCount };
      }
      const wildcard = this.#isWildcardToken(left)
        ? left
        : this.#isWildcardToken(right)
          ? right
          : undefined;
      const wildcardCount =
        typeof left === 'number' ? left : typeof right === 'number' ? right : undefined;
      if (wildcard !== undefined) {
        if (operator !== '*' || wildcardCount === undefined) {
          throw new Error('A wildcard constant output must use numericCount * WILDCARD.');
        }
        return { kind: 'wildcard-count', wildcard: wildcard.value, value: wildcardCount };
      }
      const operation = arithmeticMap[operator];
      if (operation === undefined) throw new Error(`Unsupported arithmetic operator: ${operator}.`);
      const concreteOutput = this.#firstConcreteSignal(left as DslValue, right as DslValue);
      return {
        kind: 'producer',
        producer: {
          kind: 'arithmetic',
          left: this.#arithmeticOperand(left as DslValue, rawSpan),
          operation,
          right: this.#arithmeticOperand(right as DslValue, rawSpan),
          output:
            concreteOutput === undefined
              ? { kind: 'each' }
              : { kind: 'signal', signal: concreteOutput },
          source: this.#span(rawSpan),
          instancePath: this.#path(),
        },
      };
    },
    addAssign: (
      left: unknown,
      right: unknown,
      assign: (value: unknown) => unknown,
      rawSpan: RawSpan,
    ): unknown => {
      const destination =
        this.#isNetwork(left) || this.#isSelected(left) || this.#isDestination(left);
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
      destination: NetworkValue | SelectedValue | DestinationValue,
      producer: ProducerValue,
      rawSpan: RawSpan,
    ): void => {
      this.#recordDslCall();
      const destinations = this.#isDestination(destination)
        ? destination.networks
        : this.#isSelected(destination)
          ? [destination.network]
          : [destination];
      this.#attachMany(
        destinations,
        this.#bindOutputSignal(
          producer,
          this.#isDestination(destination)
            ? destination.signal
            : this.#isSelected(destination)
              ? isSignal(destination.selection)
                ? destination.selection
                : (() => {
                    throw new Error('A destination can bind only a concrete Signal.');
                  })()
              : undefined,
        ),
        rawSpan,
      );
    },
  });

  plan(): DirectElaborationPlan {
    return {
      format: 'comblang-direct-plan',
      version: 1,
      networks: Object.freeze([...this.#networks]),
      networkTransfers: Object.freeze([...this.#networkTransfers]),
      producers: Object.freeze([...this.#producers]),
      diagnostics: Object.freeze([...this.#diagnostics]),
    };
  }

  executionApi(): typeof this.api {
    const wrapped = Object.entries(this.api).map(([name, operation]) => [
      name,
      (...args: unknown[]) => {
        try {
          return (operation as (...values: unknown[]) => unknown)(...args);
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
    return {
      kind: 'network',
      name: instanceName,
      declaration,
      ownership: {
        generation: 0,
        owner: this.#currentFunctionFrame()?.owner ?? 'top-level',
        readonlyBorrows: new Set(),
        ...(fixedColor === undefined
          ? {}
          : { colorRequirement: { color: fixedColor, source: declaration } }),
      },
      capability: 'owned',
      generation: 0,
    };
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

  #attachMany(networks: readonly NetworkValue[], value: ProducerValue, rawSpan: RawSpan): void {
    if (!networks.every((network) => this.#isNetwork(network)) || value.kind !== 'producer') {
      throw new Error('Attachment requires a Network and producer.');
    }
    if (networks.length === 0 || networks.length > 2) {
      throw new Error('A producer destructuring/attachment requires one or two Network outputs.');
    }
    for (const network of networks) this.#assertWritableNetwork(network, rawSpan, 'destination');
    this.#producers.push({
      ...value.producer,
      destinations: networks.map((network) => ({
        network: network.name,
        source: this.#span(rawSpan),
        instancePath: this.#path(),
      })),
    } as unknown as DirectPlanProducer);
    this.#attachedProducers.add(value);
  }

  #isNetwork(value: unknown): value is NetworkValue {
    return (
      typeof value === 'object' && value !== null && (value as NetworkValue).kind === 'network'
    );
  }

  #assertReadableNetwork(network: NetworkValue, rawSpan: RawSpan, role = 'Network'): void {
    const consumedAt = network.ownership.consumedAt;
    if (consumedAt !== undefined) {
      throw new ElaborationExecutionError(
        `Cannot use moved ${role} ${network.name}.`,
        this.#span(rawSpan),
        'RT2012',
        [
          { message: 'Network was consumed here.', span: consumedAt },
          { message: 'Network was declared here.', span: network.declaration },
        ],
      );
    }
    if (network.generation !== network.ownership.generation) {
      const move = network.ownership.lastMove;
      throw new ElaborationExecutionError(
        network.ownership.owner === 'lost'
          ? `Cannot use Network ${network.name}; its moved ownership was not returned.`
          : `Cannot use moved ${role} ${network.name}.`,
        this.#span(rawSpan),
        network.ownership.owner === 'lost' ? 'RT2019' : 'RT2012',
        [
          ...(move === undefined ? [] : [{ message: 'Ownership moved here.', span: move.source }]),
          { message: 'Network declared here.', span: network.declaration },
        ],
      );
    }
    if (network.borrow !== undefined && !network.borrow.active) {
      throw new ElaborationExecutionError(
        `Cannot use expired ${network.capability === 'readonly' ? 'Readonly<Network>' : 'Ref<Network>'} parameter ${network.borrow.parameter}.`,
        this.#span(rawSpan),
        'RT2017',
        [
          { message: 'Borrow created here.', span: network.borrow.source },
          ...(network.borrow.releasedAt === undefined
            ? []
            : [{ message: 'Borrow ended here.', span: network.borrow.releasedAt }]),
        ],
      );
    }
    const mutableBorrow = network.ownership.mutableBorrow;
    if (mutableBorrow !== undefined && network.borrow !== mutableBorrow) {
      throw new ElaborationExecutionError(
        `Cannot read Network ${network.name} while it is mutably borrowed.`,
        this.#span(rawSpan),
        'RT2016',
        [{ message: 'Mutable borrow created here.', span: mutableBorrow.source }],
      );
    }
  }

  #requireNetworkColor(
    network: NetworkValue,
    capability: 'readonly' | 'ref' | 'move',
    color: 'red' | 'green',
    rawSpan: RawSpan,
  ): void {
    const existing = network.ownership.colorRequirement;
    if (existing?.color === color) return;
    if (existing !== undefined) {
      throw new ElaborationExecutionError(
        `${capability === 'ref' ? 'Ref' : capability === 'move' ? 'Move' : 'Readonly'}<Network<${color === 'red' ? 'R' : 'G'}>> conflicts with the existing ${existing.color} requirement for Network ${network.name}.`,
        this.#span(rawSpan),
        'RT2018',
        [{ message: 'Existing color requirement originates here.', span: existing.source }],
      );
    }
    const requirement = { color, source: this.#span(rawSpan) } as const;
    network.ownership.colorRequirement = requirement;
    const index = this.#networks.findLastIndex(({ name }) => name === network.name);
    const declaration = this.#networks[index];
    if (declaration === undefined) {
      throw new Error(`Cannot find Network descriptor for color requirement: ${network.name}.`);
    }
    this.#networks[index] = { ...declaration, fixedColor: color };
  }

  #assertWritableNetwork(network: NetworkValue, rawSpan: RawSpan, role = 'Network'): void {
    this.#assertReadableNetwork(network, rawSpan, role);
    if (network.capability === 'readonly') {
      throw new ElaborationExecutionError(
        `Cannot attach a producer through Readonly<Network> parameter ${network.borrow?.parameter ?? network.name}.`,
        this.#span(rawSpan),
        'RT2015',
        network.borrow === undefined
          ? undefined
          : [{ message: 'Readonly borrow created here.', span: network.borrow.source }],
      );
    }
    const readonlyBorrow = network.ownership.readonlyBorrows.values().next().value;
    if (readonlyBorrow !== undefined) {
      throw new ElaborationExecutionError(
        `Cannot write Network ${network.name} while it is read-only borrowed.`,
        this.#span(rawSpan),
        'RT2016',
        [{ message: 'Readonly borrow created here.', span: readonlyBorrow.source }],
      );
    }
  }

  #assertConsumableNetwork(network: NetworkValue, rawSpan: RawSpan, role: string): void {
    this.#assertReadableNetwork(network, rawSpan, role);
    if (network.capability !== 'owned' && network.capability !== 'move') {
      throw new ElaborationExecutionError(
        `Cannot consume ${network.capability === 'readonly' ? 'Readonly<Network>' : 'Ref<Network>'} ${role} ${network.name}.`,
        this.#span(rawSpan),
        'RT2015',
        network.borrow === undefined
          ? undefined
          : [{ message: 'Borrow created here.', span: network.borrow.source }],
      );
    }
    const activeBorrow =
      network.ownership.mutableBorrow ?? network.ownership.readonlyBorrows.values().next().value;
    if (activeBorrow !== undefined) {
      throw new ElaborationExecutionError(
        `Cannot consume Network ${network.name} while it is borrowed.`,
        this.#span(rawSpan),
        'RT2016',
        [{ message: 'Borrow created here.', span: activeBorrow.source }],
      );
    }
  }

  #returnOwnedValue(value: unknown, rawSpan: RawSpan, seen: Map<object, unknown>): unknown {
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

  #returnOwnedNetwork(value: NetworkValue, rawSpan: RawSpan): NetworkValue {
    this.#recordDslCall();
    this.#assertReadableNetwork(value, rawSpan);
    if (value.capability === 'readonly' || value.capability === 'ref') {
      throw new ElaborationExecutionError(
        `A ${value.capability === 'readonly' ? 'Readonly<Network>' : 'Ref<Network>'} borrow cannot escape its function.`,
        this.#span(rawSpan),
        'RT2017',
        value.borrow === undefined
          ? undefined
          : [{ message: 'Borrow created here.', span: value.borrow.source }],
      );
    }
    const frame = this.#currentFunctionFrame();
    if (frame === undefined || value.ownership.owner !== frame.owner) {
      throw new ElaborationExecutionError(
        `Function cannot return Network ${value.name} because it does not own that value; accept it as Move<Network> first.`,
        this.#span(rawSpan),
        'RT2019',
        [{ message: 'Network declared here.', span: value.declaration }],
      );
    }
    const move = frame.moves.findLast(({ ownership }) => ownership === value.ownership);
    if (move !== undefined) move.returned = true;
    const caller = this.#parentFunctionFrame();
    value.ownership.generation += 1;
    value.ownership.owner = caller?.owner ?? 'top-level';
    value.ownership.lastMove = {
      source: this.#span(rawSpan),
      generation: value.ownership.generation,
    };
    return {
      kind: 'network',
      name: value.name,
      declaration: value.declaration,
      ownership: value.ownership,
      capability: 'owned',
      generation: value.ownership.generation,
    };
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
    return (
      typeof value === 'object' && value !== null && (value as SignalValue).kind === 'signal-value'
    );
  }

  #isSelected(value: unknown): value is SelectedValue {
    return (
      typeof value === 'object' && value !== null && (value as SelectedValue).kind === 'selected'
    );
  }

  #isWildcardToken(value: unknown): value is WildcardTokenValue {
    return (
      typeof value === 'object' &&
      value !== null &&
      (value as WildcardTokenValue).kind === 'wildcard-token'
    );
  }

  #isWildcardCount(value: unknown): value is WildcardCountValue {
    return (
      typeof value === 'object' &&
      value !== null &&
      (value as WildcardCountValue).kind === 'wildcard-count'
    );
  }

  #isDestination(value: unknown): value is DestinationValue {
    return (
      typeof value === 'object' &&
      value !== null &&
      (value as DestinationValue).kind === 'destinations'
    );
  }

  #select(value: unknown, signal: unknown, rawSpan: RawSpan): SelectedValue {
    const selection =
      typeof signal === 'string'
        ? Signal('item', signal)
        : this.#isWildcardToken(signal)
          ? signal.value
          : signal;
    const isWildcard =
      selection === 'each' || selection === 'anything' || selection === 'everything';
    if (!isSignal(selection) && !isWildcard) {
      throw new Error('Network selection requires a Signal or wildcard.');
    }
    if (this.#isDestination(value)) {
      throw new Error(
        'to(...)[SIGNAL] is not a valid destination; pass SIGNAL as the final to(...) argument.',
      );
    }
    if (!this.#isNetwork(value)) throw new Error('Signal selection requires a Network.');
    this.#assertReadableNetwork(value, rawSpan);
    return { kind: 'selected', network: value, selection: selection as SignalId | WildcardName };
  }

  #arithmeticOperand(value: DslValue, rawSpan: RawSpan): PlanArithmeticOperand {
    if (typeof value === 'number') return { kind: 'constant', value };
    if (this.#isNetwork(value)) {
      this.#assertReadableNetwork(value, rawSpan);
      return { kind: 'each', network: value.name };
    }
    if (this.#isSelected(value)) {
      this.#assertReadableNetwork(value.network, rawSpan);
      if (isSignal(value.selection)) {
        return { kind: 'signal', network: value.network.name, signal: value.selection };
      }
      if (value.selection === 'each') return { kind: 'each', network: value.network.name };
      throw new Error('Anything/Everything cannot be arithmetic operands.');
    }
    if (this.#isProducer(value)) {
      const temporary = this.#network(`$tmp:${++this.#anonymousOrdinal}`, rawSpan);
      this.#attach(temporary, value, rawSpan);
      return { kind: 'each', network: temporary.name };
    }
    throw new Error('Circuit arithmetic currently requires a Network or numeric operand.');
  }

  #isProducer(value: unknown): value is ProducerValue {
    return (
      typeof value === 'object' && value !== null && (value as ProducerValue).kind === 'producer'
    );
  }

  #isCondition(value: unknown): value is ConditionValue {
    return (
      typeof value === 'object' && value !== null && (value as ConditionValue).kind === 'condition'
    );
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
      this.#assertReadableNetwork(output.network, rawSpan);
      return isSignal(output.selection)
        ? { kind: 'signal', network: output.network.name, signal: output.selection }
        : output.selection === 'each'
          ? { kind: 'each', network: output.network.name }
          : {
              kind: 'wildcard',
              network: output.network.name,
              wildcard: output.selection,
            };
    }
    if (this.#isNetwork(output)) {
      this.#assertReadableNetwork(output, rawSpan);
      return { kind: 'each', network: output.name };
    }
    throw new Error('Unsupported decider output specification.');
  }

  #bindOutputSignal(
    value: ProducerValue,
    signal: SignalId | undefined,
    explicit = false,
  ): ProducerValue {
    if (signal === undefined) return value;
    if (
      value.boundOutputSignal !== undefined &&
      !this.#sameSignal(value.boundOutputSignal, signal)
    ) {
      throw new Error('Arithmetic output Signal conflicts with its destination binding.');
    }
    if (value.producer.kind === 'constant') {
      throw new Error('A constant combinator output cannot be rebound to another Signal.');
    }
    if (value.producer.kind === 'arithmetic') {
      return {
        kind: 'producer',
        producer: { ...value.producer, output: { kind: 'signal', signal } },
        ...(explicit || value.boundOutputSignal !== undefined ? { boundOutputSignal: signal } : {}),
      };
    }
    if ((value.producer.outputs?.length ?? 1) !== 1) {
      throw new Error('A multi-output decider cannot be rebound to one destination Signal.');
    }
    const output = value.producer.output;
    if (output.kind === 'signal') {
      if (output.signal.type !== signal.type || output.signal.name !== signal.name) {
        throw new Error('Decider output Signal conflicts with its destination binding.');
      }
      return value;
    }
    if (output.kind === 'each') {
      return {
        kind: 'producer',
        producer: {
          ...value.producer,
          output: { kind: 'signal', network: output.network, signal },
        },
      };
    }
    if (output.kind === 'each-constant') {
      return {
        kind: 'producer',
        producer: {
          ...value.producer,
          output: { kind: 'signal-constant', signal, value: output.value },
        },
      };
    }
    throw new Error('Wildcard decider output cannot be rebound to a concrete Signal.');
  }

  #firstConcreteSignal(...values: readonly DslValue[]): SignalId | undefined {
    for (const value of values) {
      if (this.#isSelected(value) && isSignal(value.selection)) return value.selection;
    }
    return undefined;
  }

  #sameSignal(left: SignalId, right: SignalId): boolean {
    return left.type === right.type && left.name === right.name;
  }

  #isCircuitDslValue(value: unknown): value is DslValue {
    return (
      isSignal(value) ||
      this.#isNetwork(value) ||
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
    if (this.#isSelected(value)) this.#assertReadableNetwork(value.network, rawSpan);
    if (this.#isDestination(value)) {
      for (const network of value.networks) this.#assertReadableNetwork(network, rawSpan);
    }
  }

  #assertWritableValue(value: unknown, rawSpan: RawSpan): void {
    if (this.#isNetwork(value)) this.#assertWritableNetwork(value, rawSpan);
    if (this.#isSelected(value)) this.#assertWritableNetwork(value.network, rawSpan);
    if (this.#isDestination(value)) {
      for (const network of value.networks) this.#assertWritableNetwork(network, rawSpan);
    }
  }

  #binaryJavaScript(operator: string, left: unknown, right: unknown): unknown {
    switch (operator) {
      case '+':
        return (left as number) + (right as number);
      case '-':
        return (left as number) - (right as number);
      case '*':
        return (left as number) * (right as number);
      case '/':
        return (left as number) / (right as number);
      case '%':
        return (left as number) % (right as number);
      case '**':
        return (left as number) ** (right as number);
      case '<<':
        return (left as number) << (right as number);
      case '>>':
        return (left as number) >> (right as number);
      case '&':
        return (left as number) & (right as number);
      case '|':
        return (left as number) | (right as number);
      case '^':
        return (left as number) ^ (right as number);
      default:
        throw new Error(`Unsupported compile-time operator: ${operator}.`);
    }
  }

  #compareJavaScript(operator: string, left: unknown, right: unknown): boolean {
    switch (operator) {
      case '>':
        return (left as number) > (right as number);
      case '<':
        return (left as number) < (right as number);
      case '>=':
        return (left as number) >= (right as number);
      case '<=':
        return (left as number) <= (right as number);
      case '==':
        return left == right;
      case '===':
        return left === right;
      case '!=':
        return left != right;
      case '!==':
        return left !== right;
      default:
        throw new Error(`Unsupported compile-time comparator: ${operator}.`);
    }
  }

  #reverseComparator(value: PlanComparator): PlanComparator {
    return ({ '>': '<', '<': '>', '>=': '<=', '<=': '>=', '=': '=', '!=': '!=' } as const)[value];
  }

  #invertCondition(condition: PlanDeciderCondition): PlanDeciderCondition {
    if (condition.kind === 'and' || condition.kind === 'or') {
      return {
        kind: condition.kind === 'and' ? 'or' : 'and',
        conditions: condition.conditions.map((child) => this.#invertCondition(child)),
      };
    }
    const comparator = (
      { '>': '<=', '<': '>=', '>=': '<', '<=': '>', '=': '!=', '!=': '=' } as const
    )[condition.comparator];
    return { ...condition, comparator };
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

import { ColorConstraintError, solveCircuitColors } from '@comblang/compiler/color-solver';
import type {
  ArithmeticOperation,
  CircuitColor,
  CircuitProducerNode,
  DeciderProducerConfig,
  ElaborationGraph,
  LogicalArithmeticOutput,
  LogicalConditionLeft,
  LogicalDeciderCondition,
  LogicalDeciderOutputSignal,
  LogicalNetworkRef,
  LogicalScalarOperand,
  NativeCircuitIr,
  Provenance,
  EntityPlacement,
} from '@comblang/compiler/ir';
import { SparseBus, type SignalId } from '@comblang/factorio';
import {
  ArithmeticCombinatorDevice,
  ArithmeticValueCombinatorDevice,
  ConstantCombinatorDevice,
  ConstantValueCombinatorDevice,
  DeciderCombinatorDevice,
  DeciderValueCombinatorDevice,
  SimulationKernel,
  TestSession,
  ValueSimulationKernel,
  type ArithmeticCombinatorConfig,
  type ArithmeticOperand,
  type DeciderCombinatorConfig,
  type DeciderCondition,
  type DeciderOutput,
  type ScalarOperand,
  type SynchronousDevice,
  type ValueSynchronousDevice,
} from '@comblang/simulator';
import {
  StableIdAllocator,
  type DeviceId,
  type Diagnostic,
  type NetworkId,
  type ProducerId,
  type SourceSpan,
} from '@comblang/shared';

export interface ExecutionLimits {
  readonly timeoutMs: number;
  readonly operationBudget?: number;
}

export interface ElaborationBundle {
  readonly code: string;
  readonly sourceMap?: string;
}

export interface ElaborationResult {
  readonly ir?: NativeCircuitIr;
  readonly diagnostics: readonly Diagnostic[];
}

export class RuntimeDiagnosticError extends Error {
  readonly diagnostic: Diagnostic;

  constructor(diagnostic: Diagnostic) {
    super(diagnostic.message);
    this.name = 'RuntimeDiagnosticError';
    this.diagnostic = diagnostic;
  }
}

function runtimeFailure(
  code: string,
  message: string,
  span?: SourceSpan,
  related?: Diagnostic['related'],
): never {
  throw new RuntimeDiagnosticError({
    code,
    severity: 'error',
    message,
    ...(span === undefined ? {} : { span }),
    ...(related === undefined || related.length === 0 ? {} : { related }),
  });
}

export interface ElaborationExecutor {
  execute(bundle: ElaborationBundle, limits: ExecutionLimits): Promise<ElaborationResult>;
}

export interface RuntimeNetworkOptions {
  readonly name?: string;
  readonly color?: CircuitColor;
  readonly source?: SourceSpan;
  readonly instancePath?: readonly string[];
  readonly expansionStack?: readonly string[];
}

export interface RuntimePairOptions {
  readonly source?: SourceSpan;
  readonly instancePath?: readonly string[];
  readonly expansionStack?: readonly string[];
}

export interface RuntimeProducerOptions {
  readonly source?: SourceSpan;
  readonly instancePath?: readonly string[];
  readonly expansionStack?: readonly string[];
  readonly placement?: EntityPlacement;
}

export interface RuntimeAttachmentTarget {
  readonly network: NetworkHandle;
  readonly source?: SourceSpan;
  readonly instancePath?: readonly string[];
  readonly expansionStack?: readonly string[];
}

export interface NetworkHandle {
  readonly kind: 'network';
  readonly id: NetworkId;
}

export type RuntimeNetworkRef =
  | { readonly refKind: 'single'; readonly network: NetworkHandle }
  | { readonly refKind: 'pair'; readonly networks: readonly [NetworkHandle, NetworkHandle] };

export interface ProducerHandle {
  readonly kind: 'producer';
  readonly id: ProducerId;
}

export type RuntimeArithmeticOperand =
  | { readonly kind: 'constant'; readonly value: number }
  | ({ readonly kind: 'signal'; readonly signal: SignalId } & RuntimeNetworkRef)
  | ({ readonly kind: 'each' } & RuntimeNetworkRef);

export interface RuntimeArithmeticConfig {
  readonly left: RuntimeArithmeticOperand;
  readonly operation: ArithmeticOperation;
  readonly right: RuntimeArithmeticOperand;
  readonly output: LogicalArithmeticOutput;
}

export type RuntimeScalarOperand =
  | { readonly kind: 'constant'; readonly value: number }
  | ({ readonly kind: 'signal'; readonly signal: SignalId } & RuntimeNetworkRef);

export type RuntimeConditionLeft =
  | Extract<RuntimeScalarOperand, { kind: 'signal' }>
  | ({
      readonly kind: 'wildcard';
      readonly value: 'each' | 'anything' | 'everything';
    } & RuntimeNetworkRef);

export type RuntimeDeciderCondition =
  | {
      readonly kind: 'compare';
      readonly left: RuntimeConditionLeft;
      readonly comparator: '>' | '<' | '=' | '>=' | '<=' | '!=';
      readonly right: RuntimeScalarOperand;
    }
  | { readonly kind: 'and'; readonly conditions: readonly RuntimeDeciderCondition[] }
  | { readonly kind: 'or'; readonly conditions: readonly RuntimeDeciderCondition[] };

export type RuntimeDeciderOutput =
  | {
      readonly mode: 'copy';
      readonly signal: LogicalDeciderOutputSignal;
      readonly input?: RuntimeNetworkRef;
    }
  | {
      readonly mode: 'constant';
      readonly signal: LogicalDeciderOutputSignal;
      readonly value: number;
      readonly input?: RuntimeNetworkRef;
    };

export interface RuntimeDeciderConfig {
  readonly condition: RuntimeDeciderCondition;
  readonly outputs: readonly RuntimeDeciderOutput[];
  readonly elseOutputs?: readonly RuntimeDeciderOutput[];
}

export interface RuntimeConstantConfig {
  readonly outputs: readonly { readonly signal: SignalId; readonly value: number }[];
}

export interface SimulationInitialValue {
  readonly network: NetworkHandle;
  readonly values: SparseBus;
}

export interface ElaboratedCircuit {
  readonly graph: ElaborationGraph;
  readonly ir: NativeCircuitIr;
  createSimulation(initial?: readonly SimulationInitialValue[]): SimulationKernel;
  createTestSession<Target = NetworkHandle>(
    mapTarget?: (target: Target) => NetworkHandle,
  ): TestSession<Target>;
}

interface RuntimeProvenanceOptions {
  readonly source?: SourceSpan;
  readonly instancePath?: readonly string[];
  readonly expansionStack?: readonly string[];
}

function makeProvenance(options: RuntimeProvenanceOptions = {}): Provenance {
  return Object.freeze({
    ...(options.source === undefined ? {} : { source: options.source }),
    instancePath: Object.freeze([...(options.instancePath ?? [])]),
    expansionStack: Object.freeze([...(options.expansionStack ?? [])]),
  });
}

function unique<T>(values: Iterable<T>): T[] {
  return [...new Set(values)];
}

export class DslRuntime {
  readonly #networkIds = new StableIdAllocator('network');
  readonly #producerIds = new StableIdAllocator('producer');
  readonly #networks = new Map<NetworkId, ElaborationGraph['networks'][number]>();
  readonly #producers = new Map<ProducerId, CircuitProducerNode>();
  readonly #attachments = new Map<
    ProducerId,
    readonly { readonly network: NetworkId; readonly provenance: Provenance }[]
  >();
  readonly #pairConstraints: {
    readonly left: NetworkId;
    readonly right: NetworkId;
    readonly source?: SourceSpan;
  }[] = [];
  readonly #networkHandles = new WeakSet<object>();
  readonly #producerHandles = new WeakSet<object>();

  network(options: RuntimeNetworkOptions = {}): NetworkHandle {
    const id = this.#networkIds.allocate() as unknown as NetworkId;
    const provenance = makeProvenance(options);
    this.#networks.set(
      id,
      Object.freeze({
        id,
        ...(options.name === undefined ? {} : { name: options.name }),
        ...(options.color === undefined ? {} : { fixedColor: options.color }),
        provenance,
      }),
    );
    const handle = Object.freeze({ kind: 'network' as const, id });
    this.#networkHandles.add(handle);
    return handle;
  }

  pair(first: NetworkHandle, second: NetworkHandle, options: RuntimePairOptions = {}): void {
    const left = this.#networkId(first);
    const right = this.#networkId(second);
    if (left === right) {
      runtimeFailure(
        'RT2020',
        'pair(a, b) requires two distinct logical Networks.',
        options.source,
      );
    }
    const leftNetwork = this.#networks.get(left)!;
    const rightNetwork = this.#networks.get(right)!;
    if (
      leftNetwork.fixedColor !== undefined &&
      leftNetwork.fixedColor === rightNetwork.fixedColor
    ) {
      runtimeFailure(
        'RT2010',
        `pair(a, b) requires opposite wire colors, but both Networks are fixed ${leftNetwork.fixedColor}.`,
        options.source,
        [leftNetwork, rightNetwork].flatMap((network) =>
          network.provenance.source === undefined
            ? []
            : [
                {
                  message: `Network ${network.name ?? network.id} is declared here.`,
                  span: network.provenance.source,
                },
              ],
        ),
      );
    }
    this.#pairConstraints.push({
      left,
      right,
      ...(options.source === undefined ? {} : { source: options.source }),
    });
  }

  arithmetic(
    config: RuntimeArithmeticConfig,
    options: RuntimeProducerOptions = {},
  ): ProducerHandle {
    const id = this.#producerIds.allocate() as unknown as ProducerId;
    const node: CircuitProducerNode = Object.freeze({
      id,
      kind: 'arithmetic',
      config: Object.freeze({
        left: this.#lowerArithmeticOperand(config.left),
        operation: config.operation,
        right: this.#lowerArithmeticOperand(config.right),
        output: config.output,
      }),
      destinations: Object.freeze([]),
      provenance: makeProvenance(options),
      ...(options.placement === undefined ? {} : { placement: options.placement }),
    });
    this.#producers.set(id, node);
    return this.#makeProducerHandle(id);
  }

  constant(config: RuntimeConstantConfig, options: RuntimeProducerOptions = {}): ProducerHandle {
    const id = this.#producerIds.allocate() as unknown as ProducerId;
    const node: CircuitProducerNode = Object.freeze({
      id,
      kind: 'constant',
      config: Object.freeze({
        outputs: Object.freeze(config.outputs.map((output) => Object.freeze({ ...output }))),
      }),
      destinations: Object.freeze([]),
      provenance: makeProvenance(options),
      ...(options.placement === undefined ? {} : { placement: options.placement }),
    });
    this.#producers.set(id, node);
    return this.#makeProducerHandle(id);
  }

  decider(config: RuntimeDeciderConfig, options: RuntimeProducerOptions = {}): ProducerHandle {
    const id = this.#producerIds.allocate() as unknown as ProducerId;
    const lowered: DeciderProducerConfig = Object.freeze({
      condition: this.#lowerCondition(config.condition, options.source),
      outputs: Object.freeze(config.outputs.map((output) => this.#lowerOutput(output))),
      ...(config.elseOutputs === undefined
        ? {}
        : {
            elseOutputs: Object.freeze(
              config.elseOutputs.map((output) => this.#lowerOutput(output)),
            ),
          }),
    });
    const node: CircuitProducerNode = Object.freeze({
      id,
      kind: 'decider',
      config: lowered,
      destinations: Object.freeze([]),
      provenance: makeProvenance(options),
      ...(options.placement === undefined ? {} : { placement: options.placement }),
    });
    this.#producers.set(id, node);
    return this.#makeProducerHandle(id);
  }

  attach(
    producer: ProducerHandle,
    ...destinations: readonly (NetworkHandle | RuntimeAttachmentTarget)[]
  ): void {
    this.#assertProducer(producer);
    const previous = this.#producers.get(producer.id);
    if (previous === undefined) {
      runtimeFailure('RT2002', `Unknown producer: ${producer.id}.`);
    }
    if (destinations.length === 0) {
      runtimeFailure(
        'RT2003',
        'attach requires at least one destination.',
        previous.provenance.source,
      );
    }
    const targets = destinations.map((destination) =>
      this.#networkHandles.has(destination)
        ? { network: this.#networkId(destination as NetworkHandle) }
        : {
            network: this.#networkId((destination as RuntimeAttachmentTarget).network),
            ...((destination as RuntimeAttachmentTarget).source === undefined
              ? {}
              : { source: (destination as RuntimeAttachmentTarget).source }),
            ...((destination as RuntimeAttachmentTarget).instancePath === undefined
              ? {}
              : { instancePath: (destination as RuntimeAttachmentTarget).instancePath }),
            ...((destination as RuntimeAttachmentTarget).expansionStack === undefined
              ? {}
              : { expansionStack: (destination as RuntimeAttachmentTarget).expansionStack }),
          },
    );
    const ids = targets.map(({ network }) => network);
    const attachmentSource =
      targets.find((target) => target.source !== undefined)?.source ?? previous.provenance.source;
    if (unique(ids).length !== ids.length) {
      runtimeFailure('RT2004', 'Duplicate attachment destination.', attachmentSource);
    }
    if (ids.length > 2) {
      runtimeFailure(
        'RT2005',
        'One Factorio output connector can attach to at most two logical networks.',
        attachmentSource,
      );
    }
    if (previous.destinations.length !== 0) {
      runtimeFailure(
        'RT2006',
        `Producer ${producer.id} is already attached.`,
        previous.provenance.source,
      );
    }
    this.#producers.set(
      producer.id,
      Object.freeze({ ...previous, destinations: Object.freeze(ids) }),
    );
    this.#attachments.set(
      producer.id,
      Object.freeze(
        targets.map((target) =>
          Object.freeze({
            network: target.network,
            provenance:
              target.source === undefined &&
              target.instancePath === undefined &&
              target.expansionStack === undefined
                ? previous.provenance
                : makeProvenance(target),
          }),
        ),
      ),
    );
  }

  elaborate(): ElaboratedCircuit {
    const producers = [...this.#producers.values()];
    for (const producer of producers) {
      if (producer.destinations.length === 0) {
        runtimeFailure(
          'RT2007',
          `Producer ${producer.id} has no output attachment.`,
          producer.provenance.source,
        );
      }
    }
    const colors = this.#solveColors(producers);
    const networks = [...this.#networks.values()];
    const graph: ElaborationGraph = Object.freeze({
      format: 'comblang-eg',
      version: 2,
      networks: Object.freeze(networks),
      producers: Object.freeze(producers),
      attachments: Object.freeze(
        producers.flatMap((producer) =>
          (this.#attachments.get(producer.id) ?? []).map((attachment) =>
            Object.freeze({ producer: producer.id, ...attachment }),
          ),
        ),
      ),
    });
    const ir: NativeCircuitIr = Object.freeze({
      format: 'comblang-ncir',
      version: 2,
      networks: Object.freeze(
        networks.map((network) => Object.freeze({ ...network, color: colors.get(network.id)! })),
      ),
      producers: graph.producers,
    });
    return Object.freeze({
      graph,
      ir,
      createSimulation: (initial: readonly SimulationInitialValue[] = []) =>
        this.#createSimulation(ir, initial),
      createTestSession: <Target = NetworkHandle>(mapTarget?: (target: Target) => NetworkHandle) =>
        new TestSession<Target>(this.#createValueSimulation(ir), {
          resolveNetwork: (target) =>
            this.#networkId(
              mapTarget === undefined ? (target as unknown as NetworkHandle) : mapTarget(target),
            ),
        }),
    });
  }

  #makeProducerHandle(id: ProducerId): ProducerHandle {
    const handle = Object.freeze({ kind: 'producer' as const, id });
    this.#producerHandles.add(handle);
    return handle;
  }

  #assertProducer(handle: ProducerHandle): void {
    if (!this.#producerHandles.has(handle)) {
      runtimeFailure('RT2002', 'Foreign or invalid producer handle.');
    }
  }

  #networkId(handle: NetworkHandle): NetworkId {
    if (!this.#networkHandles.has(handle)) {
      runtimeFailure('RT2001', 'Foreign or invalid network handle.');
    }
    return handle.id;
  }

  #lowerNetworkRef(reference: RuntimeNetworkRef) {
    return reference.refKind === 'single'
      ? ({ refKind: 'single' as const, network: this.#networkId(reference.network) } as const)
      : ({
          refKind: 'pair' as const,
          networks: reference.networks.map((network) => this.#networkId(network)) as [
            NetworkId,
            NetworkId,
          ],
        } as const);
  }

  #lowerArithmeticOperand(operand: RuntimeArithmeticOperand) {
    if (operand.kind === 'constant') return operand;
    const reference = this.#lowerNetworkRef(operand);
    return operand.kind === 'signal'
      ? Object.freeze({ kind: 'signal' as const, signal: operand.signal, ...reference })
      : Object.freeze({ kind: 'each' as const, ...reference });
  }

  #lowerScalar(operand: RuntimeScalarOperand) {
    if (operand.kind === 'constant') return operand;
    return Object.freeze({
      kind: 'signal' as const,
      signal: operand.signal,
      ...this.#lowerNetworkRef(operand),
    });
  }

  #lowerCondition(
    condition: RuntimeDeciderCondition,
    source?: SourceSpan,
  ): LogicalDeciderCondition {
    if (condition.kind === 'and' || condition.kind === 'or') {
      if (condition.conditions.length === 0) {
        runtimeFailure('RT2008', `A ${condition.kind} group cannot be empty.`, source);
      }
      return Object.freeze({
        kind: condition.kind,
        conditions: Object.freeze(
          condition.conditions.map((child) => this.#lowerCondition(child, source)),
        ),
      });
    }
    const left: LogicalConditionLeft =
      condition.left.kind === 'signal'
        ? Object.freeze({
            kind: 'signal' as const,
            signal: condition.left.signal,
            ...this.#lowerNetworkRef(condition.left),
          })
        : Object.freeze({
            kind: 'wildcard' as const,
            value: condition.left.value,
            ...this.#lowerNetworkRef(condition.left),
          });
    return Object.freeze({
      kind: 'compare',
      left,
      comparator: condition.comparator,
      right: this.#lowerScalar(condition.right),
    });
  }

  #lowerOutput(output: RuntimeDeciderOutput): DeciderProducerConfig['outputs'][number] {
    return output.mode === 'constant'
      ? Object.freeze({
          mode: 'constant' as const,
          signal: output.signal,
          value: output.value,
          ...(output.input === undefined ? {} : { input: this.#lowerNetworkRef(output.input) }),
        })
      : Object.freeze({
          mode: 'copy' as const,
          signal: output.signal,
          ...(output.input === undefined ? {} : { input: this.#lowerNetworkRef(output.input) }),
        });
  }

  #producerInputs(producer: CircuitProducerNode): NetworkId[] {
    const result: NetworkId[] = [];
    const add = (network: NetworkId | undefined) => {
      if (network !== undefined) result.push(network);
    };
    const addRef = (value: LogicalNetworkRef) => {
      for (const network of value.refKind === 'single' ? [value.network] : value.networks)
        add(network);
    };
    if (producer.kind === 'arithmetic') {
      if (producer.config.left.kind !== 'constant') addRef(producer.config.left);
      if (producer.config.right.kind !== 'constant') addRef(producer.config.right);
    } else if (producer.kind === 'decider') {
      const walk = (condition: LogicalDeciderCondition) => {
        if (condition.kind === 'and' || condition.kind === 'or') {
          condition.conditions.forEach(walk);
        } else {
          addRef(condition.left);
          if (condition.right.kind === 'signal') addRef(condition.right);
        }
      };
      walk(producer.config.condition);
      producer.config.outputs.forEach((output) => {
        if (output.input !== undefined) addRef(output.input);
      });
      producer.config.elseOutputs?.forEach((output) => {
        if (output.input !== undefined) addRef(output.input);
      });
    }
    return unique(result);
  }

  #solveColors(producers: readonly CircuitProducerNode[]): Map<NetworkId, CircuitColor> {
    const constraints: {
      left: NetworkId;
      right: NetworkId;
      relation: 'different';
      reason: string;
      source?: SourceSpan;
    }[] = [];
    for (const pair of this.#pairConstraints) {
      constraints.push({
        left: pair.left,
        right: pair.right,
        relation: 'different',
        reason: 'pair(a, b) uses both wire colors',
        ...(pair.source === undefined ? {} : { source: pair.source }),
      });
    }
    const constrainConnector = (ids: readonly NetworkId[], label: string, source?: SourceSpan) => {
      if (ids.length > 2) {
        runtimeFailure(
          'RT2009',
          `${label} needs ${ids.length} logical networks on two wires.`,
          source,
        );
      }
      if (ids.length === 2) {
        constraints.push({
          left: ids[0]!,
          right: ids[1]!,
          relation: 'different',
          reason: `${label} uses both wire colors`,
          ...(source === undefined ? {} : { source }),
        });
      }
    };
    for (const producer of producers) {
      constrainConnector(
        this.#producerInputs(producer),
        `Input of ${producer.id}`,
        producer.provenance.source,
      );
      constrainConnector(
        producer.destinations,
        `Output of ${producer.id}`,
        producer.provenance.source,
      );
    }

    try {
      return solveCircuitColors(
        [...this.#networks.keys()],
        constraints,
        [...this.#networks.values()].flatMap((network) =>
          network.fixedColor === undefined
            ? []
            : [
                {
                  id: network.id,
                  color: network.fixedColor,
                  reason: `Network ${network.name ?? network.id} has a fixed color`,
                },
              ],
        ),
      );
    } catch (error) {
      if (!(error instanceof ColorConstraintError)) throw error;
      const constraint = error.constraint as
        | { readonly id: NetworkId }
        | {
            readonly left: NetworkId;
            readonly right: NetworkId;
            readonly source?: SourceSpan;
          };
      const ids = 'id' in constraint ? [constraint.id] : [constraint.left, constraint.right];
      const origins = unique(ids).flatMap((id) => {
        const network = this.#networks.get(id);
        const span = network?.provenance.source;
        return network === undefined || span === undefined ? [] : [{ network, span }];
      });
      const constraintSource = 'source' in constraint ? constraint.source : undefined;
      const primary = constraintSource ?? origins[0]?.span;
      const related = origins
        .slice(constraintSource === undefined ? 1 : 0)
        .map(({ network, span }) => ({
          message: `Conflicting Network ${network.name ?? network.id} is declared here.`,
          span,
        }));
      runtimeFailure('RT2010', error.message, primary, related);
    }
  }

  #createSimulation(
    ir: NativeCircuitIr,
    initial: readonly SimulationInitialValue[],
  ): SimulationKernel {
    const kernel = new SimulationKernel();
    for (const device of this.#simulationDevices(ir).concrete) kernel.addDevice(device);
    for (const value of initial)
      kernel.setInitialNetwork(this.#networkId(value.network), value.values);
    return kernel;
  }

  #createValueSimulation(ir: NativeCircuitIr): ValueSimulationKernel {
    const kernel = new ValueSimulationKernel();
    for (const device of this.#simulationDevices(ir).value) kernel.addDevice(device);
    return kernel;
  }

  #simulationDevices(ir: NativeCircuitIr): {
    readonly concrete: readonly SynchronousDevice[];
    readonly value: readonly ValueSynchronousDevice[];
  } {
    const colors = new Map(ir.networks.map((network) => [network.id, network.color]));
    const selection = (value: LogicalNetworkRef) => {
      const result = { red: false, green: false };
      for (const network of value.refKind === 'single' ? [value.network] : value.networks)
        result[colors.get(network)!] = true;
      return result;
    };
    const inputNetworks = (producer: CircuitProducerNode) => {
      const result: { red?: NetworkId; green?: NetworkId } = {};
      for (const network of this.#producerInputs(producer)) result[colors.get(network)!] = network;
      return result;
    };
    const concrete: SynchronousDevice[] = [];
    const value: ValueSynchronousDevice[] = [];
    for (const producer of ir.producers) {
      if (producer.kind === 'arithmetic') {
        const operand = (value: typeof producer.config.left): ArithmeticOperand =>
          value.kind === 'constant' ? value : { ...value, networks: selection(value) };
        const combinator: ArithmeticCombinatorConfig = {
          left: operand(producer.config.left),
          operation: producer.config.operation,
          right: operand(producer.config.right),
          output: producer.config.output,
        };
        const config = {
          id: producer.id as unknown as DeviceId,
          inputNetworks: inputNetworks(producer),
          outputNetworks: producer.destinations,
          combinator,
        };
        concrete.push(new ArithmeticCombinatorDevice(config));
        value.push(new ArithmeticValueCombinatorDevice(config));
      } else if (producer.kind === 'constant') {
        const config = {
          id: producer.id as unknown as DeviceId,
          outputNetworks: producer.destinations,
          values: new SparseBus(
            producer.config.outputs.map((output) => [output.signal, output.value] as const),
          ),
        };
        concrete.push(new ConstantCombinatorDevice(config));
        value.push(new ConstantValueCombinatorDevice(config));
      } else {
        const scalar = (value: LogicalScalarOperand): ScalarOperand =>
          value.kind === 'constant' ? value : { ...value, networks: selection(value) };
        const condition = (value: LogicalDeciderCondition): DeciderCondition =>
          value.kind === 'and' || value.kind === 'or'
            ? { kind: value.kind, conditions: value.conditions.map(condition) }
            : {
                kind: 'compare',
                left:
                  value.left.kind === 'signal'
                    ? {
                        kind: 'signal',
                        signal: value.left.signal,
                        networks: selection(value.left),
                      }
                    : { ...value.left, networks: selection(value.left) },
                comparator: value.comparator,
                right: scalar(value.right),
              };
        const output = (value: DeciderProducerConfig['outputs'][number]): DeciderOutput =>
          value.mode === 'constant'
            ? {
                mode: 'constant',
                signal: value.signal,
                value: value.value,
                ...(value.input === undefined ? {} : { networks: selection(value.input) }),
              }
            : {
                mode: 'copy',
                signal: value.signal,
                ...(value.input === undefined ? {} : { networks: selection(value.input) }),
              };
        const combinator: DeciderCombinatorConfig = {
          condition: condition(producer.config.condition),
          outputs: producer.config.outputs.map(output),
          ...(producer.config.elseOutputs === undefined
            ? {}
            : { elseOutputs: producer.config.elseOutputs.map(output) }),
        };
        const config = {
          id: producer.id as unknown as DeviceId,
          inputNetworks: inputNetworks(producer),
          outputNetworks: producer.destinations,
          combinator,
        };
        concrete.push(new DeciderCombinatorDevice(config));
        value.push(new DeciderValueCombinatorDevice(config));
      }
    }
    return { concrete, value };
  }
}

import type {
  DirectElaborationPlan,
  PlanDeciderCondition,
  PlanNetworkRef,
} from '@comblang/compiler/direct-plan-schema';
import {
  analyzeCircuitGraph,
  type CircuitGraphMetrics,
} from '@comblang/compiler/circuit-graph-metrics';
import { signal, SparseBus, type SignalId } from '@comblang/factorio';
import type { NetworkId } from '@comblang/shared';
import type { SimulationSnapshot } from '@comblang/simulator';

import {
  createSourceCircuitArtifact,
  type SourceCircuitArtifact,
} from './source-circuit-artifact.js';

export interface NetworkTimelineSample {
  readonly id: NetworkId;
  readonly name: string;
  readonly color: 'red' | 'green';
  readonly signals: readonly { readonly signal: SignalId; readonly value: number }[];
}

export interface CircuitTimelineSample {
  readonly tick: number;
  readonly networks: readonly NetworkTimelineSample[];
}

export interface SourcePlanDemo {
  readonly combinators: number;
  readonly attachments: number;
  readonly stages: number;
  readonly graphMetrics: CircuitGraphMetrics;
  readonly inputNetwork?: string;
  readonly outputNetwork?: string;
  readonly inputValue?: number;
  readonly outputValue?: number;
  readonly colors: readonly { readonly name: string; readonly color: 'red' | 'green' }[];
  readonly waveform: readonly {
    readonly tick: number;
    readonly input: number;
    readonly output: number;
  }[];
  readonly timeline: readonly CircuitTimelineSample[];
}

function isLegacyUnboundOutput(name: string | undefined): boolean {
  return name?.startsWith('$output:') === true;
}

export function captureTimeline(
  snapshot: SimulationSnapshot,
  networks: readonly {
    readonly id: NetworkId;
    readonly name?: string;
    readonly color: 'red' | 'green';
  }[],
  tick = snapshot.tick,
): CircuitTimelineSample {
  return {
    tick,
    networks: networks
      .filter((network) => !isLegacyUnboundOutput(network.name))
      .map((network) => ({
        id: network.id,
        name: network.name ?? network.id,
        color: network.color,
        signals: snapshot
          .read(network.id)
          .entries()
          .map(([signal, value]) => ({ signal, value })),
      })),
  };
}

type DirectExecution = SourceCircuitArtifact['execution'];
type ConcreteSimulation = ReturnType<DirectExecution['circuit']['createSimulation']>;

function sourceFacingColors(
  plan: DirectElaborationPlan,
  executed: DirectExecution,
): SourcePlanDemo['colors'] {
  const aliasesById = new Map<NetworkId, string>();
  for (const alias of plan.networkAliases ?? []) {
    if (alias.instancePath.length !== 0 || alias.moved) continue;
    try {
      const network = executed.network(alias.name);
      if (!aliasesById.has(network.id)) aliasesById.set(network.id, alias.name);
    } catch {
      // Debug-only or expired aliases are deliberately absent from the source-facing preview.
    }
  }
  return executed.circuit.ir.networks
    .filter((network) => !isLegacyUnboundOutput(network.name))
    .map((network) => ({
      name: aliasesById.get(network.id) ?? network.name ?? network.id,
      color: network.color,
    }));
}

/** Mutable browser-only controller over immutable captured circuit snapshots. */
export class SourceSimulationController {
  readonly #execution: DirectExecution;
  #simulation!: ConcreteSimulation;
  #tickOffset = 0;
  #timeline: CircuitTimelineSample[] = [];

  constructor(source: DirectElaborationPlan | SourceCircuitArtifact) {
    this.#execution = isSourceCircuitArtifact(source)
      ? source.execution
      : createSourceCircuitArtifact(source).execution;
    this.reset();
  }

  get timeline(): readonly CircuitTimelineSample[] {
    return this.#timeline;
  }

  get currentTick(): number {
    return this.#timeline.at(-1)?.tick ?? 0;
  }

  reset(): void {
    this.#simulation = this.#execution.circuit.createSimulation();
    this.#tickOffset = 0;
    this.#timeline = [
      captureTimeline(this.#simulation.snapshot, this.#execution.circuit.ir.networks, 0),
    ];
  }

  stepFrom(tick: number, count = 1): void {
    if (!Number.isSafeInteger(count) || count < 1) {
      throw new RangeError('Simulation step count must be a positive safe integer.');
    }
    if (tick !== this.currentTick) this.#rebase(tick);
    for (let index = 0; index < count; index += 1) {
      const snapshot = this.#simulation.step();
      this.#timeline.push(
        captureTimeline(
          snapshot,
          this.#execution.circuit.ir.networks,
          this.#tickOffset + snapshot.tick,
        ),
      );
    }
  }

  setSignalAt(tick: number, networkId: NetworkId, signalId: SignalId, value: number): void {
    this.#rebase(
      tick,
      (buses, networkName) => {
        const bus = buses.get(networkName) ?? new SparseBus();
        bus.set(signalId, value);
        buses.set(networkName, bus);
      },
      networkId,
    );
  }

  clearNetworkAt(tick: number, networkId: NetworkId): void {
    this.#rebase(tick, (buses, networkName) => buses.set(networkName, new SparseBus()), networkId);
  }

  signalValueAt(tick: number, networkName: string, signalId: SignalId): number {
    const sample = this.#sample(tick);
    const network = sample.networks.find(({ name }) => name === networkName);
    return (
      network?.signals.find(({ signal }) => {
        return (
          signal.type === signalId.type &&
          signal.name === signalId.name &&
          signal.quality === signalId.quality
        );
      })?.value ?? 0
    );
  }

  #sample(tick: number): CircuitTimelineSample {
    const sample = this.#timeline.find((candidate) => candidate.tick === tick);
    if (sample === undefined) throw new RangeError(`Tick ${tick} is not present in the timeline.`);
    return sample;
  }

  #rebase(
    tick: number,
    edit?: (buses: Map<string, SparseBus>, networkName: string) => void,
    editedNetworkId?: NetworkId,
  ): void {
    const sample = this.#sample(tick);
    const buses = new Map(
      sample.networks.map(
        (network) =>
          [
            network.name,
            new SparseBus(network.signals.map(({ signal, value }) => [signal, value] as const)),
          ] as const,
      ),
    );
    if (edit !== undefined) {
      const network = sample.networks.find(({ id }) => id === editedNetworkId);
      if (network === undefined)
        throw new RangeError(`Unknown timeline Network: ${editedNetworkId}`);
      edit(buses, network.name);
    }

    const initial = this.#execution.circuit.ir.networks.flatMap((network) => {
      if (network.name === undefined || isLegacyUnboundOutput(network.name)) return [];
      const values = buses.get(network.name);
      return values === undefined
        ? []
        : [{ network: this.#execution.network(network.name), values }];
    });
    this.#simulation = this.#execution.circuit.createSimulation(initial);
    this.#tickOffset = tick;
    const retained = this.#timeline.filter((candidate) => candidate.tick < tick);
    this.#timeline = [
      ...retained,
      captureTimeline(this.#simulation.snapshot, this.#execution.circuit.ir.networks, tick),
    ];
  }
}

function isSourceCircuitArtifact(
  source: DirectElaborationPlan | SourceCircuitArtifact,
): source is SourceCircuitArtifact {
  return 'execution' in source;
}

function networkRefNames(reference: PlanNetworkRef): readonly string[] {
  return reference.refKind === 'single' ? [reference.network] : reference.networks;
}

function firstConditionNetwork(condition: PlanDeciderCondition): string | undefined {
  if (
    condition.kind === 'compare-each' ||
    condition.kind === 'compare-signal' ||
    condition.kind === 'compare-wildcard'
  ) {
    return networkRefNames(condition)[0];
  }
  if (condition.kind === 'compare-signals') return networkRefNames(condition.left)[0];
  for (const child of condition.conditions) {
    const network = firstConditionNetwork(child);
    if (network !== undefined) return network;
  }
  return undefined;
}

export function runSourceCircuitDemo(
  artifact: SourceCircuitArtifact,
  inputValue = 7,
  tickCount?: number,
): SourcePlanDemo {
  const { plan, execution: executed } = artifact;
  const graphMetrics = analyzeCircuitGraph(executed.circuit.ir);
  const firstProducer = plan.producers[0];
  const lastProducer = plan.producers.at(-1);
  if (firstProducer === undefined || lastProducer === undefined) {
    const simulation = executed.circuit.createSimulation();
    return {
      combinators: 0,
      attachments: 0,
      stages: 0,
      graphMetrics,
      colors: sourceFacingColors(plan, executed),
      waveform: [],
      timeline: [captureTimeline(simulation.snapshot, executed.circuit.ir.networks)],
    };
  }
  const inputNetworkName =
    firstProducer.kind === 'decider'
      ? firstConditionNetwork(firstProducer.condition)
      : firstProducer.kind === 'arithmetic'
        ? firstProducer.left.kind === 'each' || firstProducer.left.kind === 'signal'
          ? networkRefNames(firstProducer.left)[0]
          : firstProducer.right.kind === 'each' || firstProducer.right.kind === 'signal'
            ? networkRefNames(firstProducer.right)[0]
            : undefined
        : undefined;
  const outputName = lastProducer.destinations[0]?.network;
  if (
    (inputNetworkName === undefined && firstProducer.kind !== 'constant') ||
    outputName === undefined
  ) {
    throw new Error('The first source producer does not expose an input and output Network.');
  }

  // Producer descriptors retain pre-take names. Preview the surviving physical
  // Network via the shared debug mapping, not a consumed source-level handle.
  const physicalNames = new Map(executed.circuit.ir.networks.map(({ id, name }) => [id, name]));
  const survivingNames = new Map(
    executed.debug.scopes
      .flatMap((scope) => scope.networks)
      .map(({ planName, id }) => [planName, physicalNames.get(id)] as const),
  );
  const survivor = (name: string): string => survivingNames.get(name) ?? name;
  const inputName = inputNetworkName === undefined ? undefined : survivor(inputNetworkName);
  const survivingOutputName = survivor(outputName);
  const input = inputName === undefined ? undefined : executed.network(inputName);
  const output = executed.network(survivingOutputName);
  const A = signal('virtual', 'signal-A');
  const simulation = executed.circuit.createSimulation(
    input === undefined ? [] : [{ network: input, values: new SparseBus([[A, inputValue]]) }],
  );
  const waveform = [
    {
      tick: 0,
      input: input === undefined ? 0 : simulation.snapshot.read(input.id).get(A),
      output: simulation.snapshot.read(output.id).get(A),
    },
  ];
  const timeline = [captureTimeline(simulation.snapshot, executed.circuit.ir.networks)];
  const stages = graphMetrics.depth ?? 0;
  const ticks = tickCount ?? stages;
  let snapshot = simulation.snapshot;
  for (let tick = 1; tick <= ticks; tick += 1) {
    snapshot = simulation.step();
    waveform.push({
      tick: snapshot.tick,
      input: input === undefined ? 0 : snapshot.read(input.id).get(A),
      output: snapshot.read(output.id).get(A),
    });
    timeline.push(captureTimeline(snapshot, executed.circuit.ir.networks));
  }

  return {
    combinators: executed.circuit.graph.producers.length,
    attachments: executed.circuit.graph.attachments.length,
    stages,
    graphMetrics,
    ...(inputName === undefined ? {} : { inputNetwork: inputName, inputValue }),
    outputNetwork: survivingOutputName,
    outputValue: snapshot.read(output.id).get(A),
    colors: sourceFacingColors(plan, executed),
    waveform,
    timeline,
  };
}

/** Compatibility entry point for callers that do not already own an artifact. */
export function runSourcePlanDemo(
  plan: DirectElaborationPlan,
  inputValue = 7,
  tickCount?: number,
): SourcePlanDemo {
  return runSourceCircuitDemo(createSourceCircuitArtifact(plan), inputValue, tickCount);
}

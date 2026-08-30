import type { DirectElaborationPlan, PlanDeciderCondition } from '@comblang/compiler/direct-plan';
import { signal, SparseBus } from '@comblang/factorio';
import { elaborateDirectPlan } from '@comblang/runtime';

export interface SourcePlanDemo {
  readonly combinators: number;
  readonly attachments: number;
  readonly stages: number;
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
}

function firstConditionNetwork(condition: PlanDeciderCondition): string | undefined {
  if (
    condition.kind === 'compare-each' ||
    condition.kind === 'compare-signal' ||
    condition.kind === 'compare-wildcard'
  ) {
    return condition.network;
  }
  if (condition.kind === 'compare-signals') return condition.left.network;
  for (const child of condition.conditions) {
    const network = firstConditionNetwork(child);
    if (network !== undefined) return network;
  }
  return undefined;
}

function conditionNetworks(condition: PlanDeciderCondition): readonly string[] {
  if (
    condition.kind === 'compare-each' ||
    condition.kind === 'compare-signal' ||
    condition.kind === 'compare-wildcard'
  ) {
    return condition.networks ?? [condition.network];
  }
  if (condition.kind === 'compare-signals') {
    return [
      ...(condition.left.networks ?? [condition.left.network]),
      ...(condition.right.networks ?? [condition.right.network]),
    ];
  }
  return condition.conditions.flatMap(conditionNetworks);
}

function producerInputNetworks(
  producer: DirectElaborationPlan['producers'][number],
): readonly string[] {
  if (producer.kind === 'constant') return [];
  if (producer.kind === 'decider') {
    const outputs = producer.outputs ?? [producer.output];
    return [
      ...conditionNetworks(producer.condition),
      ...outputs.flatMap((output) =>
        output.kind === 'each' || output.kind === 'signal' || output.kind === 'wildcard'
          ? (output.networks ?? [output.network])
          : [],
      ),
    ];
  }
  return [producer.left, producer.right]
    .filter((operand) => operand.kind === 'each' || operand.kind === 'signal')
    .flatMap((operand) => operand.networks ?? [operand.network]);
}

function criticalPathStages(plan: DirectElaborationPlan): number {
  const networkDepth = new Map<string, number>();
  let finalDepth = 0;
  for (const producer of plan.producers) {
    const depth =
      1 +
      Math.max(0, ...producerInputNetworks(producer).map((name) => networkDepth.get(name) ?? 0));
    for (const destination of producer.destinations) networkDepth.set(destination.network, depth);
    finalDepth = depth;
  }
  return finalDepth;
}

export function runSourcePlanDemo(plan: DirectElaborationPlan, inputValue = 7): SourcePlanDemo {
  const firstProducer = plan.producers[0];
  const lastProducer = plan.producers.at(-1);
  if (firstProducer === undefined || lastProducer === undefined) {
    const executed = elaborateDirectPlan(plan);
    return {
      combinators: 0,
      attachments: 0,
      stages: 0,
      colors: executed.circuit.ir.networks
        .filter((network) => !network.name?.startsWith('$unused:'))
        .map((network) => ({
          name: network.name ?? network.id,
          color: network.color,
        })),
      waveform: [],
    };
  }
  const inputOperand =
    firstProducer.kind === 'decider'
      ? { network: firstConditionNetwork(firstProducer.condition) }
      : firstProducer.kind === 'arithmetic'
        ? firstProducer.left.kind === 'each' || firstProducer.left.kind === 'signal'
          ? firstProducer.left
          : firstProducer.right.kind === 'each' || firstProducer.right.kind === 'signal'
            ? firstProducer.right
            : undefined
        : undefined;
  const inputNetworkName = inputOperand?.network;
  const outputName = lastProducer.destinations[0]?.network;
  if (
    (inputOperand === undefined && firstProducer.kind !== 'constant') ||
    (inputNetworkName === undefined && firstProducer.kind !== 'constant') ||
    outputName === undefined
  ) {
    throw new Error('The first source producer does not expose an input and output Network.');
  }

  const executed = elaborateDirectPlan(plan);
  const input = inputNetworkName === undefined ? undefined : executed.network(inputNetworkName);
  const output = executed.network(outputName);
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
  const stages = criticalPathStages(plan);
  let snapshot = simulation.snapshot;
  for (let tick = 1; tick <= stages; tick += 1) {
    snapshot = simulation.step();
    waveform.push({
      tick: snapshot.tick,
      input: input === undefined ? 0 : snapshot.read(input.id).get(A),
      output: snapshot.read(output.id).get(A),
    });
  }

  return {
    combinators: executed.circuit.graph.producers.length,
    attachments: executed.circuit.graph.attachments.length,
    stages,
    ...(inputNetworkName === undefined ? {} : { inputNetwork: inputNetworkName, inputValue }),
    outputNetwork: outputName,
    outputValue: snapshot.read(output.id).get(A),
    colors: executed.circuit.ir.networks
      .filter((network) => !network.name?.startsWith('$unused:'))
      .map((network) => ({
        name: network.name ?? network.id,
        color: network.color,
      })),
    waveform,
  };
}

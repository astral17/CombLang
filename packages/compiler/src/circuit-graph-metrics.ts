import type { NetworkId, ProducerId } from '@comblang/shared';

import type { CircuitProducerNode, NativeCircuitIr } from './ir.js';
import { producerInputNetworkIds } from './producer-network-references.js';

export type ProducerLatencyResolver = (producer: CircuitProducerNode) => number | undefined;

export interface CircuitGraphMetrics {
  /**
   * Longest accumulated declared latency through the producer DAG. With feedback,
   * this is measured over the condensed SCC DAG and is not a settle-time claim.
   */
  readonly depth?: number;
  readonly feedback: boolean;
  readonly feedbackComponents: readonly (readonly ProducerId[])[];
  readonly unknownLatency: boolean;
}

function nativeCombinatorLatency(producer: CircuitProducerNode): number | undefined {
  switch (producer.kind) {
    case 'arithmetic':
    case 'constant':
    case 'decider':
    case 'selector':
      return 1;
    default:
      return undefined;
  }
}

function finishingOrder(adjacency: readonly (readonly number[])[]): readonly number[] {
  const visited = new Uint8Array(adjacency.length);
  const order: number[] = [];
  for (let root = 0; root < adjacency.length; root += 1) {
    if (visited[root]) continue;
    const stack: { node: number; expanded: boolean }[] = [{ node: root, expanded: false }];
    while (stack.length > 0) {
      const entry = stack.pop()!;
      if (entry.expanded) {
        order.push(entry.node);
        continue;
      }
      if (visited[entry.node]) continue;
      visited[entry.node] = 1;
      stack.push({ node: entry.node, expanded: true });
      const neighbors = adjacency[entry.node]!;
      for (let index = neighbors.length - 1; index >= 0; index -= 1) {
        const neighbor = neighbors[index]!;
        if (!visited[neighbor]) stack.push({ node: neighbor, expanded: false });
      }
    }
  }
  return order;
}

function stronglyConnectedComponents(
  adjacency: readonly (readonly number[])[],
): readonly (readonly number[])[] {
  const reverse = adjacency.map(() => [] as number[]);
  for (let source = 0; source < adjacency.length; source += 1) {
    for (const destination of adjacency[source]!) reverse[destination]!.push(source);
  }

  const assigned = new Uint8Array(adjacency.length);
  const components: number[][] = [];
  for (const root of finishingOrder(adjacency).toReversed()) {
    if (assigned[root]) continue;
    const component: number[] = [];
    const stack = [root];
    assigned[root] = 1;
    while (stack.length > 0) {
      const node = stack.pop()!;
      component.push(node);
      for (const predecessor of reverse[node]!) {
        if (assigned[predecessor]) continue;
        assigned[predecessor] = 1;
        stack.push(predecessor);
      }
    }
    component.sort((left, right) => left - right);
    components.push(component);
  }
  return components;
}

/** Computes order-independent structural timing and feedback facts from resolved NCIR. */
export function analyzeCircuitGraph(
  circuit: Pick<NativeCircuitIr, 'producers'>,
  latency: ProducerLatencyResolver = nativeCombinatorLatency,
): CircuitGraphMetrics {
  const drivers = new Map<NetworkId, number[]>();
  for (let index = 0; index < circuit.producers.length; index += 1) {
    for (const destination of circuit.producers[index]!.destinations) {
      const entries = drivers.get(destination) ?? [];
      entries.push(index);
      drivers.set(destination, entries);
    }
  }

  const edges = circuit.producers.map(() => new Set<number>());
  for (let consumer = 0; consumer < circuit.producers.length; consumer += 1) {
    for (const input of producerInputNetworkIds(circuit.producers[consumer]!)) {
      for (const driver of drivers.get(input) ?? []) edges[driver]!.add(consumer);
    }
  }
  const adjacency = edges.map((entries) => [...entries].sort((left, right) => left - right));
  const components = stronglyConnectedComponents(adjacency);
  const componentOf = new Int32Array(circuit.producers.length);
  for (let index = 0; index < components.length; index += 1) {
    for (const producer of components[index]!) componentOf[producer] = index;
  }

  const feedbackComponents = components
    .filter(
      (component) => component.length > 1 || adjacency[component[0]!]!.includes(component[0]!),
    )
    .map((component) =>
      Object.freeze(component.map((index) => circuit.producers[index]!.id).toSorted()),
    )
    .toSorted((left, right) => {
      const first = String(left[0]);
      const second = String(right[0]);
      return first < second ? -1 : first > second ? 1 : 0;
    });

  const componentEdges = components.map(() => new Set<number>());
  const indegree = new Uint32Array(components.length);
  for (let source = 0; source < adjacency.length; source += 1) {
    const sourceComponent = componentOf[source]!;
    for (const destination of adjacency[source]!) {
      const destinationComponent = componentOf[destination]!;
      if (
        sourceComponent === destinationComponent ||
        componentEdges[sourceComponent]!.has(destinationComponent)
      ) {
        continue;
      }
      componentEdges[sourceComponent]!.add(destinationComponent);
      indegree[destinationComponent] = (indegree[destinationComponent] ?? 0) + 1;
    }
  }

  let unknownLatency = false;
  const componentLatency = components.map((component): number | undefined => {
    let maximum = 0;
    for (const index of component) {
      const value = latency(circuit.producers[index]!);
      if (value === undefined) {
        unknownLatency = true;
        return undefined;
      }
      if (!Number.isSafeInteger(value) || value < 0) {
        throw new RangeError('Producer latency must be a non-negative safe integer or undefined.');
      }
      maximum = Math.max(maximum, value);
    }
    return maximum;
  });

  const queue: number[] = [];
  for (let index = 0; index < components.length; index += 1) {
    if (indegree[index] === 0) queue.push(index);
  }
  const depths: (number | undefined)[] = Array.from({ length: components.length }, () => 0);
  let visited = 0;
  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    const component = queue[cursor]!;
    visited += 1;
    const ownLatency = componentLatency[component];
    const current = depths[component];
    depths[component] =
      ownLatency === undefined || current === undefined ? undefined : current + ownLatency;
    for (const destination of componentEdges[component]!) {
      const previous = depths[destination];
      const candidate = depths[component];
      depths[destination] =
        previous === undefined || candidate === undefined
          ? undefined
          : Math.max(previous, candidate);
      indegree[destination] = (indegree[destination] ?? 0) - 1;
      if (indegree[destination] === 0) queue.push(destination);
    }
  }
  if (visited !== components.length)
    throw new Error('Condensed circuit graph is unexpectedly cyclic.');

  const depth = depths.some((value) => value === undefined)
    ? undefined
    : Math.max(0, ...(depths as number[]));
  return Object.freeze({
    ...(depth === undefined ? {} : { depth }),
    feedback: feedbackComponents.length > 0,
    feedbackComponents: Object.freeze(feedbackComponents),
    unknownLatency,
  });
}

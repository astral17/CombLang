import type {
  CircuitProducerNode,
  ElaborationGraph,
  EntityPlacement,
  LogicalDeciderCondition,
  LogicalNetworkRef,
} from '@comblang/compiler/ir';
import type { NetworkId, ProducerId } from '@comblang/shared';

import type { DebugNetworkEntry, DebugProducerEntry, DebugScope } from './debug-index.js';

export type ProducerCounts = Partial<Record<DebugProducerEntry['producerKind'], number>>;
export type DebugNetworkSelector = string | DebugNetworkEntry;
export type DebugProducerSelector = string | number | DebugProducerEntry;

export interface StructureAssertionDetails {
  readonly scopePath: readonly string[];
  readonly matcher: string;
  readonly expected?: unknown;
  readonly actual?: unknown;
}

export class StructureAssertionError extends Error {
  readonly code = 'DBG2001';
  readonly details: StructureAssertionDetails;

  constructor(message: string, details: StructureAssertionDetails) {
    super(message);
    this.name = 'StructureAssertionError';
    this.details = Object.freeze({ ...details, scopePath: Object.freeze([...details.scopePath]) });
  }
}

function scopes(root: DebugScope): readonly DebugScope[] {
  return [root, ...root.children.flatMap(scopes)];
}

function scopeLabel(path: readonly string[]): string {
  return path.length === 0 ? '<root>' : path.join(' / ');
}

function display(value: unknown): string {
  if (value === undefined) return 'undefined';
  return JSON.stringify(value);
}

function partialMatch(actual: unknown, expected: unknown): boolean {
  if (Object.is(actual, expected)) return true;
  if (Array.isArray(expected)) {
    return (
      Array.isArray(actual) &&
      actual.length === expected.length &&
      expected.every((item, index) => partialMatch(actual[index], item))
    );
  }
  if (typeof expected !== 'object' || expected === null) return false;
  if (typeof actual !== 'object' || actual === null) return false;
  return Object.entries(expected).every(([key, value]) =>
    partialMatch((actual as Record<string, unknown>)[key], value),
  );
}

/** Physical input dependencies, including pair inputs and both Decider branches. */
export function producerInputNetworks(producer: CircuitProducerNode): ReadonlySet<NetworkId> {
  const result = new Set<NetworkId>();
  const addReference = (reference: LogicalNetworkRef): void => {
    if (reference.refKind === 'single') result.add(reference.network);
    else for (const network of reference.networks) result.add(network);
  };
  const visitCondition = (condition: LogicalDeciderCondition): void => {
    if (condition.kind === 'and' || condition.kind === 'or') {
      for (const child of condition.conditions) visitCondition(child);
      return;
    }
    addReference(condition.left);
    if (condition.right.kind === 'signal') addReference(condition.right);
  };

  if (producer.kind === 'arithmetic') {
    if (producer.config.left.kind !== 'constant') addReference(producer.config.left);
    if (producer.config.right.kind !== 'constant') addReference(producer.config.right);
  } else if (producer.kind === 'decider') {
    visitCondition(producer.config.condition);
    for (const output of [...producer.config.outputs, ...(producer.config.elseOutputs ?? [])]) {
      if (output.input !== undefined) addReference(output.input);
    }
  }
  return result;
}

/** Tick-free structural assertions over one DebugScope and all of its descendants. */
export class DebugStructureExpectation {
  readonly #scope: DebugScope;
  readonly #scopes: readonly DebugScope[];
  readonly #networks: readonly DebugNetworkEntry[];
  readonly #producers: readonly DebugProducerEntry[];
  readonly #graphProducers: ReadonlyMap<ProducerId, CircuitProducerNode>;

  constructor(scope: DebugScope, graph: ElaborationGraph) {
    this.#scope = scope;
    this.#scopes = Object.freeze(scopes(scope));
    this.#networks = Object.freeze(this.#scopes.flatMap((candidate) => candidate.networks));
    this.#producers = Object.freeze(this.#scopes.flatMap((candidate) => candidate.producers));
    this.#graphProducers = new Map(graph.producers.map((producer) => [producer.id, producer]));
    Object.freeze(this);
  }

  toHaveProducerCounts(expected: ProducerCounts): this {
    const actual = { arithmetic: 0, decider: 0, constant: 0 };
    for (const producer of this.#producers) actual[producer.producerKind] += 1;
    for (const [kind, count] of Object.entries(expected) as [keyof ProducerCounts, number][]) {
      if (!Number.isSafeInteger(count) || count < 0) {
        throw new RangeError(`Expected ${kind} count must be a non-negative safe integer.`);
      }
      if (actual[kind] !== count) {
        this.#fail(
          'toHaveProducerCounts',
          `Expected ${scopeLabel(this.#scope.path)} to contain ${count} ${kind} Producers, received ${actual[kind]}.`,
          expected,
          actual,
        );
      }
    }
    return this;
  }

  toHaveNetwork(selector: DebugNetworkSelector): this {
    this.#network(selector);
    return this;
  }

  toHaveProducer(selector: DebugProducerSelector, expected?: unknown): this {
    const producer = this.#producer(selector);
    if (expected !== undefined && !partialMatch(producer, expected)) {
      this.#fail(
        'toHaveProducer',
        `Producer ${this.#producerLabel(producer)} does not match ${display(expected)}.`,
        expected,
        producer,
      );
    }
    return this;
  }

  toHavePlacement(selector: DebugProducerSelector, expected: EntityPlacement | undefined): this {
    const producer = this.#producer(selector);
    const actual = this.#graphProducer(producer).placement;
    if (!partialMatch(actual, expected)) {
      this.#fail(
        'toHavePlacement',
        `Producer ${this.#producerLabel(producer)} has placement ${display(actual)}, expected ${display(expected)}.`,
        expected,
        actual,
      );
    }
    return this;
  }

  toMatchConfiguration(selector: DebugProducerSelector, expected: unknown): this {
    const producer = this.#producer(selector);
    const actual = this.#graphProducer(producer).config;
    if (!partialMatch(actual, expected)) {
      this.#fail(
        'toMatchConfiguration',
        `Producer ${this.#producerLabel(producer)} configuration does not match ${display(expected)}.`,
        expected,
        actual,
      );
    }
    return this;
  }

  toBeZeroTickAlias(first: DebugNetworkSelector, second: DebugNetworkSelector): this {
    const left = this.#network(first);
    const right = this.#network(second);
    if (left.id !== right.id) {
      this.#fail(
        'toBeZeroTickAlias',
        `Networks ${this.#networkLabel(left)} and ${this.#networkLabel(right)} are physically distinct.`,
        left.id,
        right.id,
      );
    }
    return this;
  }

  toHaveTickLatency(
    input: DebugNetworkSelector,
    output: DebugNetworkSelector,
    expectedTicks: number,
  ): this {
    if (!Number.isSafeInteger(expectedTicks) || expectedTicks < 0) {
      throw new RangeError('Expected tick latency must be a non-negative safe integer.');
    }
    const source = this.#network(input, true);
    const destination = this.#network(output, true);
    const actual = this.#shortestLatency(source.id, destination.id);
    if (actual !== expectedTicks) {
      this.#fail(
        'toHaveTickLatency',
        `Expected ${expectedTicks}-tick structural latency from ${this.#networkLabel(source)} to ${this.#networkLabel(destination)}, received ${actual ?? 'no path'}.`,
        expectedTicks,
        actual,
      );
    }
    return this;
  }

  #network(selector: DebugNetworkSelector, allowExternal = false): DebugNetworkEntry {
    if (typeof selector !== 'string') {
      if (allowExternal || this.#networks.includes(selector)) return selector;
      this.#fail(
        'network',
        `Network ${this.#networkLabel(selector)} is outside ${scopeLabel(this.#scope.path)}.`,
      );
    }
    const matches = this.#networks.filter((entry) => !entry.internal && entry.name === selector);
    if (matches.length === 1) return matches[0]!;
    this.#fail(
      'network',
      matches.length === 0
        ? `No Network named ${JSON.stringify(selector)} exists under ${scopeLabel(this.#scope.path)}.`
        : `Network ${JSON.stringify(selector)} is ambiguous under ${scopeLabel(this.#scope.path)}.`,
      selector,
      matches.map((entry) => this.#networkLabel(entry)),
    );
  }

  #producer(selector: DebugProducerSelector): DebugProducerEntry {
    if (typeof selector === 'object') {
      if (this.#producers.includes(selector)) return selector;
      this.#fail(
        'producer',
        `Producer ${this.#producerLabel(selector)} is outside ${scopeLabel(this.#scope.path)}.`,
      );
    }
    if (typeof selector === 'number') {
      if (!Number.isSafeInteger(selector) || selector < 1) {
        throw new RangeError('Structural Producer index must be a positive safe integer.');
      }
      const producer = this.#producers[selector - 1];
      if (producer !== undefined) return producer;
      this.#fail(
        'producer',
        `No Producer exists at recursive index ${selector} under ${scopeLabel(this.#scope.path)}.`,
        selector,
        this.#producers.length,
      );
    }
    const matches = this.#producers.filter((entry) => entry.name === selector);
    if (matches.length === 1) return matches[0]!;
    this.#fail(
      'producer',
      matches.length === 0
        ? `No Producer named ${JSON.stringify(selector)} exists under ${scopeLabel(this.#scope.path)}.`
        : `Producer ${JSON.stringify(selector)} is ambiguous under ${scopeLabel(this.#scope.path)}.`,
      selector,
      matches.map((entry) => this.#producerLabel(entry)),
    );
  }

  #graphProducer(entry: DebugProducerEntry): CircuitProducerNode {
    const producer = this.#graphProducers.get(entry.id);
    if (producer === undefined) throw new Error(`Debug Producer ${entry.id} is absent from EG.`);
    return producer;
  }

  #shortestLatency(source: NetworkId, destination: NetworkId): number | undefined {
    if (source === destination) return 0;
    const distances = new Map<NetworkId, number>([[source, 0]]);
    const queue: NetworkId[] = [source];
    const scoped = this.#producers.map((entry) => this.#graphProducer(entry));
    for (let cursor = 0; cursor < queue.length; cursor += 1) {
      const current = queue[cursor]!;
      const nextDistance = distances.get(current)! + 1;
      for (const producer of scoped) {
        if (!producerInputNetworks(producer).has(current)) continue;
        for (const output of producer.destinations) {
          if (distances.has(output)) continue;
          if (output === destination) return nextDistance;
          distances.set(output, nextDistance);
          queue.push(output);
        }
      }
    }
    return undefined;
  }

  #networkLabel(entry: DebugNetworkEntry): string {
    return `${scopeLabel(entry.instancePath)}:${entry.planName}`;
  }

  #producerLabel(entry: DebugProducerEntry): string {
    return `${scopeLabel(entry.instancePath)}:${entry.name ?? `#${entry.ordinal}`}`;
  }

  #fail(matcher: string, message: string, expected?: unknown, actual?: unknown): never {
    throw new StructureAssertionError(message, {
      scopePath: this.#scope.path,
      matcher,
      ...(expected === undefined ? {} : { expected }),
      ...(actual === undefined ? {} : { actual }),
    });
  }
}

import type { DirectElaborationPlan, DirectPlanProducer } from '@comblang/compiler/direct-plan';
import type { NetworkId, ProducerId, SourceSpan } from '@comblang/shared';

import type { ElaboratedCircuit } from './elaboration.js';

export type DebugQueryCode = 'DBG1001' | 'DBG1002';

export class DebugQueryError extends Error {
  readonly code: DebugQueryCode;
  readonly candidates: readonly string[];

  constructor(code: DebugQueryCode, message: string, candidates: readonly string[] = []) {
    super(message);
    this.name = 'DebugQueryError';
    this.code = code;
    this.candidates = Object.freeze([...candidates]);
  }
}

export interface DebugNetworkEntry {
  readonly kind: 'network';
  /** Source-level binding where one exists; generated internals retain their plan name. */
  readonly name: string;
  readonly planName: string;
  readonly id: NetworkId;
  readonly source: SourceSpan;
  readonly instancePath: readonly string[];
  readonly internal: boolean;
  readonly moved: boolean;
}

export interface DebugProducerEntry {
  readonly kind: 'producer';
  readonly producerKind: DirectPlanProducer['kind'];
  readonly name?: string;
  readonly id: ProducerId;
  /** One-based ordinal among every physical Producer in this exact scope. */
  readonly ordinal: number;
  /** One-based ordinal among Producers of the same kind in this exact scope. */
  readonly kindOrdinal: number;
  readonly source: SourceSpan;
  readonly instancePath: readonly string[];
  readonly descriptor: DirectPlanProducer;
}

interface ScopeContents {
  readonly path: readonly string[];
  readonly networks: readonly DebugNetworkEntry[];
  readonly producers: readonly DebugProducerEntry[];
  readonly children: readonly DebugScope[];
}

function scopeLabel(path: readonly string[]): string {
  return path.length === 0 ? '<root>' : path.join(' / ');
}

function candidateLabel(entry: DebugNetworkEntry): string {
  return `${scopeLabel(entry.instancePath)}: ${entry.planName}`;
}

export class DebugScope {
  readonly path: readonly string[];
  readonly networks: readonly DebugNetworkEntry[];
  readonly producers: readonly DebugProducerEntry[];
  readonly children: readonly DebugScope[];

  constructor(contents: ScopeContents) {
    this.path = Object.freeze([...contents.path]);
    this.networks = Object.freeze([...contents.networks]);
    this.producers = Object.freeze([...contents.producers]);
    this.children = Object.freeze([...contents.children]);
    Object.freeze(this);
  }

  child(name: string): DebugScope {
    const child = this.children.find((candidate) => candidate.path.at(-1) === name);
    if (child !== undefined) return child;
    throw new DebugQueryError(
      'DBG1001',
      `Debug scope ${scopeLabel(this.path)} has no child named ${JSON.stringify(name)}.`,
      this.children.map((candidate) => candidate.path.at(-1)!),
    );
  }

  network(name: string): DebugNetworkEntry {
    const matches = this.networks.filter((entry) => !entry.internal && entry.name === name);
    if (matches.length === 1) return matches[0]!;
    if (matches.length === 0) {
      throw new DebugQueryError(
        'DBG1001',
        `Debug scope ${scopeLabel(this.path)} has no Network named ${JSON.stringify(name)}.`,
        this.networks.filter((entry) => !entry.internal).map(candidateLabel),
      );
    }
    throw new DebugQueryError(
      'DBG1002',
      `Network ${JSON.stringify(name)} is ambiguous in debug scope ${scopeLabel(this.path)}.`,
      matches.map(candidateLabel),
    );
  }

  combinator(index: number): DebugProducerEntry;
  combinator(name: string): DebugProducerEntry;
  combinator(nameOrIndex: string | number): DebugProducerEntry {
    if (typeof nameOrIndex === 'string') {
      const matches = this.producers.filter((entry) => entry.name === nameOrIndex);
      if (matches.length === 1) return matches[0]!;
      if (matches.length === 0) {
        throw new DebugQueryError(
          'DBG1001',
          `Debug scope ${scopeLabel(this.path)} has no combinator named ${JSON.stringify(nameOrIndex)}.`,
          this.producers.flatMap((entry) =>
            entry.name === undefined ? [] : [`${entry.ordinal}: ${entry.name}`],
          ),
        );
      }
      throw new DebugQueryError(
        'DBG1002',
        `Combinator ${JSON.stringify(nameOrIndex)} is ambiguous in debug scope ${scopeLabel(this.path)}.`,
        matches.map((entry) => `${entry.ordinal}: ${entry.name}`),
      );
    }
    const index = nameOrIndex;
    if (!Number.isSafeInteger(index) || index < 1) {
      throw new RangeError('Debug combinator index must be a positive safe integer.');
    }
    const producer = this.producers[index - 1];
    if (producer !== undefined) return producer;
    throw new DebugQueryError(
      'DBG1001',
      `Debug scope ${scopeLabel(this.path)} has no combinator at index ${index}.`,
      this.producers.map((entry) => `${entry.ordinal}: ${entry.producerKind}`),
    );
  }

  combinators(kind?: DebugProducerEntry['producerKind']): readonly DebugProducerEntry[] {
    return kind === undefined
      ? this.producers
      : Object.freeze(this.producers.filter((entry) => entry.producerKind === kind));
  }
}

interface MutableScope {
  readonly path: readonly string[];
  readonly networks: DebugNetworkEntry[];
  readonly producers: DebugProducerEntry[];
  readonly childKeys: string[];
}

function pathKey(path: readonly string[]): string {
  return JSON.stringify(path);
}

function sourceNetworkName(planName: string): {
  readonly name: string;
  readonly internal: boolean;
} {
  const generatedBinding = /^\$(?:local|instance):\d+:(.+)$/.exec(planName);
  if (generatedBinding !== null) return { name: generatedBinding[1]!, internal: false };
  return { name: planName, internal: planName.startsWith('$') };
}

export class DebugIndex {
  readonly root: DebugScope;
  readonly scopes: readonly DebugScope[];
  readonly #byPath: ReadonlyMap<string, DebugScope>;

  private constructor(root: DebugScope, scopes: readonly DebugScope[]) {
    this.root = root;
    this.scopes = Object.freeze([...scopes]);
    this.#byPath = new Map(scopes.map((scope) => [pathKey(scope.path), scope]));
    Object.freeze(this);
  }

  scope(path: readonly string[]): DebugScope {
    const scope = this.#byPath.get(pathKey(path));
    if (scope !== undefined) return scope;
    throw new DebugQueryError(
      'DBG1001',
      `Unknown debug scope ${scopeLabel(path)}.`,
      this.scopes.map((candidate) => scopeLabel(candidate.path)),
    );
  }

  static fromDirectPlan(
    plan: DirectElaborationPlan,
    circuit: ElaboratedCircuit,
    networkId: (planName: string) => NetworkId,
  ): DebugIndex {
    const mutable = new Map<string, MutableScope>();
    const order: MutableScope[] = [];
    const ensure = (path: readonly string[]): MutableScope => {
      const key = pathKey(path);
      const existing = mutable.get(key);
      if (existing !== undefined) return existing;
      const scope: MutableScope = {
        path: Object.freeze([...path]),
        networks: [],
        producers: [],
        childKeys: [],
      };
      mutable.set(key, scope);
      order.push(scope);
      if (path.length > 0) {
        const parent = ensure(path.slice(0, -1));
        parent.childKeys.push(key);
      }
      return scope;
    };
    ensure([]);
    for (const instance of plan.debugInstances ?? []) ensure(instance.path);

    const movedNames = new Set((plan.networkTransfers ?? []).map((transfer) => transfer.source));
    for (const declaration of plan.networks) {
      const sourceName = sourceNetworkName(declaration.name);
      ensure(declaration.instancePath).networks.push(
        Object.freeze({
          kind: 'network',
          ...sourceName,
          planName: declaration.name,
          id: networkId(declaration.name),
          source: declaration.source,
          instancePath: Object.freeze([...declaration.instancePath]),
          moved: movedNames.has(declaration.name),
        }),
      );
    }

    for (const [index, descriptor] of plan.producers.entries()) {
      const scope = ensure(descriptor.instancePath);
      const producerKind = descriptor.kind;
      scope.producers.push(
        Object.freeze({
          kind: 'producer',
          producerKind,
          ...(descriptor.bindingName === undefined ? {} : { name: descriptor.bindingName }),
          id: circuit.graph.producers[index]!.id,
          ordinal: scope.producers.length + 1,
          kindOrdinal:
            scope.producers.filter((entry) => entry.producerKind === producerKind).length + 1,
          source: descriptor.source,
          instancePath: Object.freeze([...descriptor.instancePath]),
          descriptor,
        }),
      );
    }

    const built = new Map<string, DebugScope>();
    const build = (scope: MutableScope): DebugScope => {
      const result = new DebugScope({
        path: scope.path,
        networks: scope.networks,
        producers: scope.producers,
        children: scope.childKeys.map((key) => build(mutable.get(key)!)),
      });
      built.set(pathKey(scope.path), result);
      return result;
    };
    const root = build(mutable.get(pathKey([]))!);
    return new DebugIndex(
      root,
      order.map((scope) => built.get(pathKey(scope.path))!),
    );
  }
}

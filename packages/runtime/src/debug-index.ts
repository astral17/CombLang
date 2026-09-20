import type {
  DirectElaborationPlan,
  DirectPlanProducer,
} from '@comblang/compiler/direct-plan-schema';
import type { DirectElaborationPlanV6, DirectPlanProducerV6 } from '@comblang/compiler/entity-v6';
import type { DirectElaborationPlanV7 } from '@comblang/compiler/entity-v7';
import type { EntityPhysicalRecord } from '@comblang/compiler/entity';
import type { NetworkId, ProducerId, SourceSpan } from '@comblang/shared';

import type { ElaboratedCircuit } from './elaboration.js';

export type DebugQueryCode = 'DBG1001' | 'DBG1002';

export class DebugQueryError extends Error {
  readonly code: DebugQueryCode;
  readonly candidates: readonly string[];
  readonly scopePath?: readonly string[];

  constructor(
    code: DebugQueryCode,
    message: string,
    candidates: readonly string[] = [],
    scopePath?: readonly string[],
  ) {
    super(message);
    this.name = 'DebugQueryError';
    this.code = code;
    this.candidates = Object.freeze([...candidates]);
    if (scopePath !== undefined) this.scopePath = Object.freeze([...scopePath]);
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
  readonly descriptor: DirectPlanProducer | DirectPlanProducerV6;
}

export interface DebugEntityEntry {
  readonly kind: 'entity';
  /** Physical Entity identity; this is not a Producer debug identity. */
  readonly entityId: EntityPhysicalRecord['id'];
  /** Scope-local ordinal used by this DebugScope. */
  readonly ordinal: number;
  /** Global physical ordinal retained from the lowered Entity record. */
  readonly globalOrdinal: number;
  readonly profile: EntityPhysicalRecord['profile'];
  readonly provenance: EntityPhysicalRecord['provenance'];
  readonly placement?: EntityPhysicalRecord['placement'];
  readonly record: EntityPhysicalRecord;
}

interface ScopeContents {
  readonly path: readonly string[];
  readonly networks: readonly DebugNetworkEntry[];
  readonly producers: readonly DebugProducerEntry[];
  readonly entities: readonly DebugEntityEntry[];
  readonly children: readonly DebugScope[];
}

function scopeLabel(path: readonly string[]): string {
  return path.length === 0 ? '<root>' : path.join(' / ');
}

function candidateLabel(entry: DebugNetworkEntry): string {
  return `${scopeLabel(entry.instancePath)}: ${entry.planName}`;
}

function entityCandidateLabel(entry: DebugEntityEntry): string {
  return `${scopeLabel(entry.provenance.instancePath)}: ${entry.entityId} (global ${entry.globalOrdinal})`;
}

export class DebugScope {
  readonly path: readonly string[];
  readonly networks: readonly DebugNetworkEntry[];
  readonly producers: readonly DebugProducerEntry[];
  readonly entities: readonly DebugEntityEntry[];
  readonly children: readonly DebugScope[];

  constructor(contents: ScopeContents) {
    this.path = Object.freeze([...contents.path]);
    this.networks = Object.freeze([...contents.networks]);
    this.producers = Object.freeze([...contents.producers]);
    this.entities = Object.freeze([...contents.entities]);
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
      this.path,
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
        this.path,
      );
    }
    throw new DebugQueryError(
      'DBG1002',
      `Network ${JSON.stringify(name)} is ambiguous in debug scope ${scopeLabel(this.path)}.`,
      matches.map(candidateLabel),
      this.path,
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
          this.path,
        );
      }
      throw new DebugQueryError(
        'DBG1002',
        `Combinator ${JSON.stringify(nameOrIndex)} is ambiguous in debug scope ${scopeLabel(this.path)}.`,
        matches.map((entry) => `${entry.ordinal}: ${entry.name}`),
        this.path,
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
      this.path,
    );
  }

  combinators(kind?: DebugProducerEntry['producerKind']): readonly DebugProducerEntry[] {
    return kind === undefined
      ? this.producers
      : Object.freeze(this.producers.filter((entry) => entry.producerKind === kind));
  }

  entity(index: number): DebugEntityEntry;
  entity(id: EntityPhysicalRecord['id']): DebugEntityEntry;
  entity(idOrIndex: EntityPhysicalRecord['id'] | number): DebugEntityEntry {
    if (typeof idOrIndex === 'string') {
      const matches = this.entities.filter((entry) => entry.entityId === idOrIndex);
      if (matches.length === 1) return matches[0]!;
      if (matches.length === 0) {
        throw new DebugQueryError(
          'DBG1001',
          `Debug scope ${scopeLabel(this.path)} has no Entity named ${JSON.stringify(idOrIndex)}.`,
          this.entities.map(entityCandidateLabel),
          this.path,
        );
      }
      throw new DebugQueryError(
        'DBG1002',
        `Entity ${JSON.stringify(idOrIndex)} is ambiguous in debug scope ${scopeLabel(this.path)}.`,
        matches.map(entityCandidateLabel),
        this.path,
      );
    }
    if (!Number.isSafeInteger(idOrIndex) || idOrIndex < 1) {
      throw new RangeError('Debug Entity index must be a positive safe integer.');
    }
    const entity = this.entities[idOrIndex - 1];
    if (entity !== undefined) return entity;
    throw new DebugQueryError(
      'DBG1001',
      `Debug scope ${scopeLabel(this.path)} has no Entity at index ${idOrIndex}.`,
      this.entities.map((entry) => `${entry.ordinal}: ${entry.entityId}`),
      this.path,
    );
  }

  entityByGlobalOrdinal(globalOrdinal: number): DebugEntityEntry {
    if (!Number.isSafeInteger(globalOrdinal) || globalOrdinal < 1) {
      throw new RangeError('Global Entity ordinal must be a positive safe integer.');
    }
    const matches = this.entities.filter((entry) => entry.globalOrdinal === globalOrdinal);
    if (matches.length === 1) return matches[0]!;
    throw new DebugQueryError(
      'DBG1001',
      `Debug scope ${scopeLabel(this.path)} has no Entity with global ordinal ${globalOrdinal}.`,
      this.entities.map(entityCandidateLabel),
      this.path,
    );
  }

  entityList(): readonly DebugEntityEntry[] {
    return this.entities;
  }
}

interface MutableScope {
  readonly path: readonly string[];
  readonly networks: DebugNetworkEntry[];
  readonly producers: DebugProducerEntry[];
  readonly entities: DebugEntityEntry[];
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
      path,
    );
  }

  static fromDirectPlan(
    plan: DirectElaborationPlan | DirectElaborationPlanV6 | DirectElaborationPlanV7,
    circuit: { readonly graph: { readonly producers: readonly { readonly id: ProducerId }[] } },
    networkId: (planName: string) => NetworkId,
    producerId: (planIndex: number) => ProducerId,
    entities: readonly EntityPhysicalRecord[] = [],
  ): DebugIndex {
    const graphProducerIds = new Set(circuit.graph.producers.map(({ id }) => id));
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
        entities: [],
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
    const physicalEntries = new Set(order.flatMap((scope) => scope.networks));
    for (const alias of plan.networkAliases ?? []) {
      const scope = ensure(alias.instancePath);
      const existingIndex = scope.networks.findIndex(
        (entry) =>
          physicalEntries.has(entry) &&
          !entry.internal &&
          entry.name === alias.name &&
          entry.source?.fileId === alias.source.fileId &&
          entry.source.start >= alias.source.start &&
          entry.source.end <= alias.source.end,
      );
      if (existingIndex >= 0) {
        const existing = scope.networks[existingIndex]!;
        if (existing.planName === alias.network) continue;
        scope.networks[existingIndex] = Object.freeze({
          ...existing,
          name: `$initial:${existing.name}`,
          internal: true,
        });
      }
      scope.networks.push(
        Object.freeze({
          kind: 'network',
          name: alias.name,
          planName: alias.network,
          id: networkId(alias.network),
          source: alias.source,
          instancePath: Object.freeze([...alias.instancePath]),
          internal: false,
          moved: alias.moved,
        }),
      );
    }

    for (const [index, descriptor] of plan.producers.entries()) {
      const scope = ensure(descriptor.instancePath);
      const producerKind = descriptor.kind;
      const id = producerId(index);
      if (!graphProducerIds.has(id)) {
        throw new Error(`Direct-plan Producer ${index + 1} maps to missing EG Producer ${id}.`);
      }
      scope.producers.push(
        Object.freeze({
          kind: 'producer',
          producerKind,
          ...(descriptor.bindingName === undefined ? {} : { name: descriptor.bindingName }),
          id,
          ordinal: scope.producers.length + 1,
          kindOrdinal:
            scope.producers.filter((entry) => entry.producerKind === producerKind).length + 1,
          source: descriptor.source,
          instancePath: Object.freeze([...descriptor.instancePath]),
          descriptor,
        }),
      );
    }

    for (const record of entities) {
      const scope = ensure(record.provenance.instancePath);
      scope.entities.push(
        Object.freeze({
          kind: 'entity',
          entityId: record.id,
          ordinal: scope.entities.length + 1,
          globalOrdinal: record.ordinal,
          profile: record.profile,
          provenance: record.provenance,
          ...(record.placement === undefined ? {} : { placement: record.placement }),
          record,
        }),
      );
    }

    const built = new Map<string, DebugScope>();
    const build = (scope: MutableScope): DebugScope => {
      const result = new DebugScope({
        path: scope.path,
        networks: scope.networks,
        producers: scope.producers,
        entities: scope.entities,
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

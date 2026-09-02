import { Signal, sameSignal, signalKey, SparseBus } from '@comblang/factorio';

import { cloneBusValue, knownBus, unknownBus, type BusValue } from './bus-value.js';
import type { TraceDocument, TraceEvent, TraceTarget } from './trace.js';

export interface TraceSnapshot {
  readonly tick: number;
  readonly values: readonly { readonly target: TraceTarget; readonly value: BusValue }[];
}

export interface TraceReadRange {
  readonly fromTick?: number;
  readonly toTick?: number;
  readonly targets?: readonly string[];
}

function invalid(message: string): never {
  throw new TypeError(`Invalid trace: ${message}`);
}

function tickValue(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function text(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function copyTarget(target: TraceTarget): TraceTarget {
  if (!text(target.id)) invalid('target ID must be a non-empty string.');
  if (target.kind === 'network' || target.kind === 'signal') {
    if (!text(target.networkId)) invalid(`target ${target.id} has no Network ID.`);
    if (target.kind === 'network') return Object.freeze({ ...target });
    const { type, name, quality } = target.signal;
    return Object.freeze({ ...target, signal: Signal(type, name, quality) });
  }
  if (target.kind !== 'object-input' && target.kind !== 'object-output')
    invalid('unknown target kind.');
  if (![target.objectId, target.adapterId, target.instanceId, target.connector].every(text)) {
    invalid(`object target ${target.id} has incomplete metadata.`);
  }
  return Object.freeze({ ...target });
}

function copyEvent(event: TraceEvent, target: TraceTarget): TraceEvent {
  if (!tickValue(event.tick)) invalid('event tick must be a non-negative safe integer.');
  if (event.kind === 'unknown') {
    if (
      !Array.isArray(event.origins) ||
      event.origins.some(
        (origin) =>
          !text(origin.id) ||
          typeof origin.description !== 'string' ||
          !Array.isArray(origin.path) ||
          !origin.path.every(text),
      )
    )
      invalid('malformed Unknown origins.');
    const value = unknownBus(event.origins);
    return Object.freeze({ ...event, origins: value.kind === 'unknown' ? value.origins : [] });
  }
  if (event.kind !== 'known' || typeof event.reset !== 'boolean' || !Array.isArray(event.changes)) {
    invalid('malformed Known event.');
  }
  const signals = new Set<string>();
  const changes = event.changes.map((change) => {
    const signal = Signal(change.signal.type, change.signal.name, change.signal.quality);
    const key = signalKey(signal);
    if (signals.has(key)) invalid(`duplicate signal change in target ${target.id}.`);
    signals.add(key);
    if (
      !Number.isInteger(change.value) ||
      change.value < -2147483648 ||
      change.value > 2147483647
    ) {
      invalid('signal changes must be signed int32 values.');
    }
    if (target.kind === 'signal' && !sameSignal(signal, target.signal)) {
      invalid(`selected-signal target ${target.id} contains a different signal.`);
    }
    return Object.freeze({ signal, value: change.value });
  });
  return Object.freeze({ ...event, changes: Object.freeze(changes) });
}

function applyEvent(previous: BusValue | undefined, event: TraceEvent): BusValue {
  if (event.kind === 'unknown') return unknownBus(event.origins);
  const bus = event.reset || previous?.kind !== 'known' ? new SparseBus() : previous.bus;
  for (const { signal, value } of event.changes) bus.set(signal, value);
  return { kind: 'known', bus };
}

/** Renderer-independent replay of a detached delta document; it never re-runs a circuit. */
export class TraceReader {
  readonly endTick: number;
  readonly hasExplicitEndTick: boolean;
  readonly targets: readonly TraceTarget[];
  readonly #events = new Map<string, readonly TraceEvent[]>();

  constructor(document: TraceDocument) {
    if (
      document.format !== 'comblang-trace' ||
      document.version !== 1 ||
      !Array.isArray(document.targets) ||
      !Array.isArray(document.events)
    )
      invalid('unsupported document.');
    const targets = new Map<string, TraceTarget>();
    const events = new Map<string, TraceEvent[]>();
    for (const source of document.targets) {
      const target = copyTarget(source);
      if (targets.has(target.id)) invalid(`duplicate target ID ${target.id}.`);
      targets.set(target.id, target);
      events.set(target.id, []);
    }
    let lastEventTick = 0;
    for (const source of document.events) {
      const target = targets.get(source.target);
      if (target === undefined) invalid(`event references missing target ${source.target}.`);
      const event = copyEvent(source, target);
      events.get(event.target)!.push(event);
      lastEventTick = Math.max(lastEventTick, event.tick);
    }
    this.hasExplicitEndTick = document.endTick !== undefined;
    this.endTick = document.endTick ?? lastEventTick;
    if (!tickValue(this.endTick) || this.endTick < lastEventTick)
      invalid('endTick precedes captured events or is invalid.');
    this.targets = Object.freeze([...targets.values()].sort((a, b) => a.id.localeCompare(b.id)));
    for (const target of this.targets) {
      const timeline = events.get(target.id)!.sort((a, b) => a.tick - b.tick);
      if (timeline[0]?.tick !== 0) invalid(`target ${target.id} has no tick-zero snapshot.`);
      let previous: TraceEvent | undefined;
      for (const event of timeline) {
        if (event.tick === previous?.tick) invalid(`duplicate tick for target ${target.id}.`);
        if (event.kind === 'known' && !event.reset && previous?.kind !== 'known') {
          invalid(`target ${target.id} requires a Known reset after registration or Unknown.`);
        }
        previous = event;
      }
      this.#events.set(target.id, Object.freeze(timeline));
    }
    Object.freeze(this);
  }

  read(targetId: string, tick: number): BusValue {
    this.#checkTick(tick);
    const events = this.#targetEvents(targetId);
    let value: BusValue | undefined;
    for (const event of events) {
      if (event.tick > tick) break;
      value = applyEvent(value, event);
    }
    return cloneBusValue(value!);
  }

  /** Lazy tick rows; only requested targets are replayed, without expanding the stable tail. */
  *snapshots(range: TraceReadRange = {}): IterableIterator<TraceSnapshot> {
    const from = range.fromTick ?? 0;
    const to = range.toTick ?? this.endTick;
    this.#checkTick(from);
    this.#checkTick(to);
    if (from > to) throw new RangeError('Trace range starts after its end.');
    const requested = range.targets === undefined ? undefined : new Set(range.targets);
    for (const id of requested ?? []) this.#targetEvents(id);
    const cursors = this.targets
      .filter(({ id }) => requested === undefined || requested.has(id))
      .map((target) => ({
        target,
        events: this.#targetEvents(target.id),
        index: 0,
        value: knownBus(),
      }));
    for (let tick = from; tick <= to; tick++) {
      for (const cursor of cursors) {
        while (cursor.index < cursor.events.length && cursor.events[cursor.index]!.tick <= tick) {
          cursor.value = applyEvent(cursor.value, cursor.events[cursor.index++]!);
        }
      }
      yield Object.freeze({
        tick,
        values: Object.freeze(
          cursors.map(({ target, value }) =>
            Object.freeze({ target, value: cloneBusValue(value) }),
          ),
        ),
      });
    }
  }

  #targetEvents(id: string): readonly TraceEvent[] {
    const events = this.#events.get(id);
    if (events === undefined) throw new RangeError(`Unknown trace target: ${id}.`);
    return events;
  }

  #checkTick(tick: number): void {
    if (!tickValue(tick) || tick > this.endTick)
      throw new RangeError(`Trace tick must be in 0..${this.endTick}.`);
  }
}

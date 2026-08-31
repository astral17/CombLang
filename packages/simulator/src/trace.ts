import { signalKey, type CircuitValue, type SignalId } from '@comblang/factorio';
import type { NetworkId } from '@comblang/shared';

import type { BusValue, UnknownOrigin } from './bus-value.js';
import type { ValueSimulationSnapshot } from './value-kernel.js';

export type TraceTarget =
  | {
      readonly id: string;
      readonly kind: 'network';
      readonly networkId: NetworkId;
    }
  | {
      readonly id: string;
      readonly kind: 'signal';
      readonly networkId: NetworkId;
      readonly signal: SignalId;
    };

export interface SignalChange {
  readonly signal: SignalId;
  readonly value: CircuitValue;
}

export type TraceEvent =
  | {
      readonly kind: 'known';
      readonly tick: number;
      readonly target: string;
      /** True after registration or a transition from Unknown to Known. */
      readonly reset: boolean;
      readonly changes: readonly SignalChange[];
    }
  | {
      readonly kind: 'unknown';
      readonly tick: number;
      readonly target: string;
      readonly origins: readonly UnknownOrigin[];
    };

export interface TraceDocument {
  readonly format: 'comblang-trace';
  readonly version: 1;
  readonly targets: readonly TraceTarget[];
  readonly events: readonly TraceEvent[];
}

function targetId(networkId: NetworkId, signal?: SignalId): string {
  return signal === undefined ? `network:${networkId}` : `signal:${networkId}:${signalKey(signal)}`;
}

export function networkTraceTarget(networkId: NetworkId): TraceTarget {
  return Object.freeze({ id: targetId(networkId), kind: 'network' as const, networkId });
}

export function signalTraceTarget(networkId: NetworkId, signal: SignalId): TraceTarget {
  return Object.freeze({
    id: targetId(networkId, signal),
    kind: 'signal' as const,
    networkId,
    signal: Object.freeze({ ...signal }),
  });
}

function valueKey(value: BusValue): string {
  return JSON.stringify(value.kind === 'known' ? value.bus.toJSON() : value.origins);
}

function knownChanges(
  target: TraceTarget,
  previous: BusValue | undefined,
  current: Extract<BusValue, { kind: 'known' }>,
): { readonly reset: boolean; readonly changes: readonly SignalChange[] } {
  const reset = previous === undefined || previous.kind === 'unknown';
  if (target.kind === 'signal') {
    const value = current.bus.get(target.signal);
    const previousValue = previous?.kind === 'known' ? previous.bus.get(target.signal) : undefined;
    return {
      reset,
      changes:
        reset || previousValue !== value ? [Object.freeze({ signal: target.signal, value })] : [],
    };
  }

  const candidates = new Map<string, SignalId>();
  for (const [signal] of current.bus.entries()) candidates.set(signalKey(signal), signal);
  if (previous?.kind === 'known') {
    for (const [signal] of previous.bus.entries()) candidates.set(signalKey(signal), signal);
  }
  const changes = [...candidates]
    .sort(([left], [right]) => left.localeCompare(right))
    .flatMap(([, signal]) => {
      const value = current.bus.get(signal);
      const oldValue = previous?.kind === 'known' ? previous.bus.get(signal) : undefined;
      return reset || value !== oldValue ? [Object.freeze({ signal, value })] : [];
    });
  return { reset, changes: Object.freeze(changes) };
}

function cloneTarget(target: TraceTarget): TraceTarget {
  return target.kind === 'network'
    ? networkTraceTarget(target.networkId)
    : signalTraceTarget(target.networkId, target.signal);
}

function cloneEvent(event: TraceEvent): TraceEvent {
  return event.kind === 'known'
    ? Object.freeze({
        ...event,
        changes: Object.freeze(
          event.changes.map((change) =>
            Object.freeze({ signal: Object.freeze({ ...change.signal }), value: change.value }),
          ),
        ),
      })
    : Object.freeze({
        ...event,
        origins: Object.freeze(
          event.origins.map((origin) =>
            Object.freeze({ ...origin, path: Object.freeze([...origin.path]) }),
          ),
        ),
      });
}

/** Delta-compressed, renderer-independent trace storage. */
export class TraceStore {
  readonly #targets = new Map<string, TraceTarget>();
  readonly #previous = new Map<string, BusValue>();
  readonly #events: TraceEvent[] = [];

  register(target: TraceTarget, snapshot: ValueSimulationSnapshot): void {
    if (snapshot.tick !== 0) {
      throw new Error('Trace targets must be registered at tick 0.');
    }
    if (this.#targets.has(target.id)) return;
    this.#targets.set(target.id, cloneTarget(target));
    this.#recordTarget(target, snapshot);
  }

  record(snapshot: ValueSimulationSnapshot): void {
    for (const target of [...this.#targets.values()].sort((left, right) =>
      left.id.localeCompare(right.id),
    )) {
      this.#recordTarget(target, snapshot);
    }
  }

  timeline(targetId?: string): readonly TraceEvent[] {
    return Object.freeze(
      this.#events
        .filter((event) => targetId === undefined || event.target === targetId)
        .sort((left, right) => left.tick - right.tick || left.target.localeCompare(right.target))
        .map(cloneEvent),
    );
  }

  toJSON(): TraceDocument {
    return Object.freeze({
      format: 'comblang-trace' as const,
      version: 1 as const,
      targets: Object.freeze(
        [...this.#targets.values()]
          .sort((left, right) => left.id.localeCompare(right.id))
          .map(cloneTarget),
      ),
      events: this.timeline(),
    });
  }

  #recordTarget(target: TraceTarget, snapshot: ValueSimulationSnapshot): void {
    const current = snapshot.read(target.networkId);
    const previous = this.#previous.get(target.id);
    if (previous !== undefined && valueKey(previous) === valueKey(current)) return;

    if (current.kind === 'unknown') {
      this.#events.push(
        cloneEvent({
          kind: 'unknown',
          tick: snapshot.tick,
          target: target.id,
          origins: current.origins,
        }),
      );
    } else {
      const { reset, changes } = knownChanges(target, previous, current);
      if (reset || changes.length > 0) {
        this.#events.push(
          cloneEvent({
            kind: 'known',
            tick: snapshot.tick,
            target: target.id,
            reset,
            changes,
          }),
        );
      }
    }
    this.#previous.set(target.id, current);
  }
}

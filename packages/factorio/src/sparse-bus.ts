import { addInt32, int32, type CircuitValue } from './int32.js';
import { signalKey, type SignalId } from './signal.js';

interface BusEntry {
  readonly signal: SignalId;
  readonly value: CircuitValue;
}

export class SparseBus {
  readonly #values: Map<string, BusEntry>;

  constructor(entries: Iterable<readonly [SignalId, number]> = []) {
    this.#values = new Map();
    for (const [id, value] of entries) {
      this.set(id, value);
    }
  }

  get size(): number {
    return this.#values.size;
  }

  get(id: SignalId): CircuitValue {
    return this.#values.get(signalKey(id))?.value ?? 0;
  }

  set(id: SignalId, value: number): this {
    const normalized = int32(value);
    const key = signalKey(id);
    if (normalized === 0) {
      this.#values.delete(key);
    } else {
      this.#values.set(key, { signal: id, value: normalized });
    }
    return this;
  }

  add(id: SignalId, value: number): this {
    return this.set(id, addInt32(this.get(id), int32(value)));
  }

  merge(other: SparseBus): this {
    for (const [id, value] of other.entries()) {
      this.add(id, value);
    }
    return this;
  }

  clone(): SparseBus {
    return new SparseBus(this.entries());
  }

  entries(): readonly (readonly [SignalId, CircuitValue])[] {
    return [...this.#values.entries()]
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([, entry]) => [entry.signal, entry.value] as const);
  }

  toJSON(): readonly { readonly signal: SignalId; readonly value: CircuitValue }[] {
    return this.entries().map(([id, value]) => ({ signal: id, value }));
  }
}

export function aggregateBuses(buses: Iterable<SparseBus>): SparseBus {
  const result = new SparseBus();
  for (const bus of buses) {
    result.merge(bus);
  }
  return result;
}

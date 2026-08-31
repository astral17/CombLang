import { aggregateBuses, SparseBus } from '@comblang/factorio';
import type { DeviceId } from '@comblang/shared';

export interface UnknownOrigin {
  /** Stable identity of the external or unmodeled source. */
  readonly id: string;
  readonly description: string;
  /** Deterministic dependency path from the origin towards the current value. */
  readonly path: readonly DeviceId[];
}

export type BusValue =
  | { readonly kind: 'known'; readonly bus: SparseBus }
  | { readonly kind: 'unknown'; readonly origins: readonly UnknownOrigin[] };

export function knownBus(bus: SparseBus = new SparseBus()): BusValue {
  return Object.freeze({ kind: 'known' as const, bus: bus.clone() });
}

function pathKey(path: readonly DeviceId[]): string {
  return path.join('\u0000');
}

function comparePaths(left: readonly DeviceId[], right: readonly DeviceId[]): number {
  if (left.length !== right.length) return left.length - right.length;
  return pathKey(left).localeCompare(pathKey(right));
}

function compareOrigins(left: UnknownOrigin, right: UnknownOrigin): number {
  const pathOrder = comparePaths(left.path, right.path);
  if (pathOrder !== 0) return pathOrder;
  return left.description < right.description ? -1 : left.description > right.description ? 1 : 0;
}

function canonicalOrigins(origins: Iterable<UnknownOrigin>): readonly UnknownOrigin[] {
  const byId = new Map<string, UnknownOrigin>();
  for (const origin of origins) {
    const candidate = Object.freeze({
      id: origin.id,
      description: origin.description,
      path: Object.freeze([...origin.path]),
    });
    const previous = byId.get(origin.id);
    if (previous === undefined || compareOrigins(candidate, previous) < 0) {
      byId.set(origin.id, candidate);
    }
  }
  return Object.freeze([...byId.values()].sort((left, right) => left.id.localeCompare(right.id)));
}

export function unknownBus(
  origins: Iterable<Omit<UnknownOrigin, 'path'> & { readonly path?: readonly DeviceId[] }>,
): BusValue {
  const canonical = canonicalOrigins(
    [...origins].map((origin) => ({ ...origin, path: origin.path ?? [] })),
  );
  if (canonical.length === 0) {
    throw new Error('An Unknown bus requires at least one origin.');
  }
  return Object.freeze({ kind: 'unknown' as const, origins: canonical });
}

export function cloneBusValue(value: BusValue): BusValue {
  return value.kind === 'known' ? knownBus(value.bus) : unknownBus(value.origins);
}

export function throughDevice(value: BusValue, deviceId: DeviceId): BusValue {
  if (value.kind === 'known') return cloneBusValue(value);
  return unknownBus(
    value.origins.map((origin) => ({ ...origin, path: [...origin.path, deviceId] })),
  );
}

export function aggregateBusValues(values: Iterable<BusValue>): BusValue {
  const known: SparseBus[] = [];
  const unknown: UnknownOrigin[] = [];
  for (const value of values) {
    if (value.kind === 'known') known.push(value.bus);
    else unknown.push(...value.origins);
  }
  return unknown.length === 0 ? knownBus(aggregateBuses(known)) : unknownBus(unknown);
}

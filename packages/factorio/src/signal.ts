export const signalTypes = [
  'item',
  'fluid',
  'virtual',
  'entity',
  'recipe',
  'space-location',
  'asteroid-chunk',
  'quality',
] as const;

export type SignalType = (typeof signalTypes)[number];

export interface SignalId {
  readonly type: SignalType;
  readonly name: string;
  readonly quality?: string;
}

/** Creates the structural SignalID used by Factorio circuit networks. */
export function Signal(name: string): SignalId;
export function Signal(type: SignalType, name: string, quality?: string): SignalId;
export function Signal(typeOrName: SignalType | string, name?: string, quality?: string): SignalId {
  const shorthand = arguments.length === 1;
  const type = shorthand ? 'item' : (typeOrName as SignalType);
  const resolvedName = shorthand ? typeOrName : name;

  if (!signalTypes.includes(type)) {
    throw new TypeError(`Unknown signal type: ${String(type)}.`);
  }
  if (typeof resolvedName !== 'string' || resolvedName.length === 0) {
    throw new TypeError('A signal name cannot be empty.');
  }
  if (quality !== undefined && (typeof quality !== 'string' || quality.length === 0)) {
    throw new TypeError('A signal quality cannot be empty when provided.');
  }

  return Object.freeze(
    quality === undefined ? { type, name: resolvedName } : { type, name: resolvedName, quality },
  );
}

/** Lowercase compatibility alias used by the simulator and early direct-runtime API. */
export function signal(name: string): SignalId;
export function signal(type: SignalType, name: string, quality?: string): SignalId;
export function signal(typeOrName: SignalType | string, name?: string, quality?: string): SignalId {
  return arguments.length === 1
    ? Signal(typeOrName)
    : Signal(typeOrName as SignalType, name as string, quality);
}

export function signalKey(id: SignalId): string {
  return `${id.type}\u0000${id.name}\u0000${id.quality ?? ''}`;
}

export function sameSignal(left: SignalId, right: SignalId): boolean {
  return signalKey(left) === signalKey(right);
}

export function compareSignalIds(left: SignalId, right: SignalId): number {
  const leftKey = signalKey(left);
  const rightKey = signalKey(right);
  return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
}

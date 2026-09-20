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

declare const signalRefBrand: unique symbol;
export type SignalRef = string & {
  readonly [signalRefBrand]: true;
};

function assertWellFormedComponent(value: string, label: string): void {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (index + 1 >= value.length || next < 0xdc00 || next > 0xdfff)
        throw new TypeError(`Signal ${label} contains an unpaired UTF-16 surrogate.`);
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      throw new TypeError(`Signal ${label} contains an unpaired UTF-16 surrogate.`);
    }
  }
}

function encodeSignalComponent(value: string, label: string): string {
  assertWellFormedComponent(value, label);
  return encodeURIComponent(value);
}

function assertSignalId(id: SignalId): void {
  if (!signalTypes.includes(id.type)) {
    throw new TypeError(`Unknown signal type: ${String(id.type)}.`);
  }
  if (typeof id.name !== 'string' || id.name.length === 0) {
    throw new TypeError('A signal name cannot be empty.');
  }
  if (id.quality !== undefined && (typeof id.quality !== 'string' || id.quality.length === 0)) {
    throw new TypeError('A signal quality cannot be empty when provided.');
  }
}

/** Formats the public, reversible SignalRef without changing internal bus keys. */
export function formatSignalRef(id: SignalId): SignalRef {
  assertSignalId(id);
  const name = encodeSignalComponent(id.name, 'name');
  const quality =
    id.quality === undefined || id.quality === 'normal'
      ? undefined
      : encodeSignalComponent(id.quality, 'quality');
  if (quality === undefined) {
    return (id.type === 'item' ? name : `${id.type}/${name}`) as SignalRef;
  }
  return `${id.type}/${name}/${quality}` as SignalRef;
}

function decodeSignalComponent(value: string, label: string): { decoded: string; encoded: string } {
  let decoded: string;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    throw new TypeError(`SignalRef has invalid percent encoding in ${label}.`);
  }
  assertWellFormedComponent(decoded, label);
  const encoded = encodeSignalComponent(decoded, label);
  if (encoded !== value) throw new TypeError(`SignalRef is not canonical in ${label}.`);
  return { decoded, encoded };
}

/** Parses a canonical SignalRef, accepting explicit item and normal-quality spellings. */
export function parseSignalRef(ref: string): SignalId {
  if (typeof ref !== 'string') throw new TypeError('SignalRef must be a string.');
  const segments = ref.split('/');
  if (segments.length < 1 || segments.length > 3) {
    throw new TypeError('SignalRef must contain one, two, or three segments.');
  }
  if (segments.length === 1) {
    const { decoded } = decodeSignalComponent(segments[0]!, 'name');
    if (decoded.length === 0) throw new TypeError('A SignalRef name cannot be empty.');
    return Signal(decoded);
  }

  const [rawType, rawName, rawQuality] = segments as [string, string, string?];
  if (!signalTypes.includes(rawType as SignalType)) {
    throw new TypeError(`Unknown signal type in SignalRef: ${rawType}.`);
  }
  const name = decodeSignalComponent(rawName!, 'name').decoded;
  if (name.length === 0) throw new TypeError('A SignalRef name cannot be empty.');
  if (rawQuality === undefined) return Signal(rawType as SignalType, name);

  const quality = decodeSignalComponent(rawQuality, 'quality').decoded;
  if (quality.length === 0) throw new TypeError('A SignalRef quality cannot be empty.');
  return quality === 'normal'
    ? Signal(rawType as SignalType, name)
    : Signal(rawType as SignalType, name, quality);
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
  const quality = id.quality === undefined || id.quality === 'normal' ? '' : id.quality;
  return `${id.type}\u0000${id.name}\u0000${quality}`;
}

export function sameSignal(left: SignalId, right: SignalId): boolean {
  return signalKey(left) === signalKey(right);
}

export function compareSignalIds(left: SignalId, right: SignalId): number {
  const leftKey = signalKey(left);
  const rightKey = signalKey(right);
  return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
}

export interface BlueprintCodecLimits {
  readonly maxEncodedCharacters: number;
  readonly maxCompressedBytes: number;
  readonly maxDecompressedBytes: number;
  readonly maxJsonDepth: number;
  readonly maxJsonNodes: number;
  readonly maxStringBytes: number;
  readonly maxEmittedBytes: number;
}

export type BlueprintCodecLimitOverrides = Partial<BlueprintCodecLimits>;

export const DEFAULT_BLUEPRINT_CODEC_LIMITS: Readonly<BlueprintCodecLimits> = Object.freeze({
  maxEncodedCharacters: 8_388_608,
  maxCompressedBytes: 6_291_456,
  maxDecompressedBytes: 25_165_824,
  maxJsonDepth: 128,
  maxJsonNodes: 1_000_000,
  maxStringBytes: 4_194_304,
  maxEmittedBytes: 25_165_824,
});

const limitNames = new Set<keyof BlueprintCodecLimits>([
  'maxEncodedCharacters',
  'maxCompressedBytes',
  'maxDecompressedBytes',
  'maxJsonDepth',
  'maxJsonNodes',
  'maxStringBytes',
  'maxEmittedBytes',
]);

/** Returns validated, immutable limits; partial overrides retain the defaults. */
export function resolveBlueprintCodecLimits(
  overrides: BlueprintCodecLimitOverrides = {},
): Readonly<BlueprintCodecLimits> {
  if (
    typeof overrides !== 'object' ||
    overrides === null ||
    Array.isArray(overrides) ||
    (Object.getPrototypeOf(overrides) !== Object.prototype &&
      Object.getPrototypeOf(overrides) !== null)
  ) {
    throw new TypeError('Blueprint codec limits must be a plain object.');
  }

  const resolved: { -readonly [Key in keyof BlueprintCodecLimits]: BlueprintCodecLimits[Key] } = {
    ...DEFAULT_BLUEPRINT_CODEC_LIMITS,
  };
  for (const key of Reflect.ownKeys(overrides)) {
    if (typeof key !== 'string' || !limitNames.has(key as keyof BlueprintCodecLimits)) {
      throw new TypeError(`Unknown blueprint codec limit: ${String(key)}.`);
    }
    const descriptor = Object.getOwnPropertyDescriptor(overrides, key);
    if (descriptor === undefined || !('value' in descriptor)) {
      throw new TypeError(`Blueprint codec limit ${key} must be a data property.`);
    }
    const value: unknown = descriptor.value;
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
      throw new RangeError(`Blueprint codec limit ${key} must be a positive safe integer.`);
    }
    resolved[key as keyof BlueprintCodecLimits] = value;
  }
  return Object.freeze(resolved);
}

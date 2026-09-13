import type { EntityDatabaseRef, EntityProfile, EntityProfileId } from './entity.js';
import { canonicalizeEntityProfile } from './entity-profile.js';

/** The normalized fields needed to decide whether a record can name a blueprint Entity. */
export interface BlueprintEntityPrototypeRecord {
  readonly key: string;
  readonly name: string;
  readonly type: string;
  /** Explicit normalized native fact; omission is not construction authority. */
  readonly blueprintEligible?: boolean;
}

export type EntityProvisioningErrorCode = 'EPV1000' | 'EPV1001' | 'EPV1002';

export class EntityProvisioningError extends Error {
  readonly code: EntityProvisioningErrorCode;
  readonly path: string;

  constructor(code: EntityProvisioningErrorCode, path: string, message: string) {
    super(`${path}: ${message}`);
    this.name = 'EntityProvisioningError';
    this.code = code;
    this.path = path;
  }
}

function invalid(code: EntityProvisioningErrorCode, path: string, message: string): never {
  throw new EntityProvisioningError(code, path, message);
}

type DataRecord = Record<string, unknown>;

function dataRecord(value: unknown, path: string): DataRecord {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    invalid('EPV1000', path, 'expected a normalized prototype record.');
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    invalid('EPV1000', path, 'expected a plain normalized prototype record.');
  }
  const record = Object.create(null) as DataRecord;
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string')
      invalid('EPV1000', `${path}[${String(key)}]`, 'symbol fields are not allowed.');
    const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
    if (!('value' in descriptor))
      invalid('EPV1000', `${path}.${key}`, 'accessors are not allowed.');
    record[key] = descriptor.value;
  }
  return record;
}

function requiredString(record: DataRecord, key: string, path: string): string {
  const value = record[key];
  if (typeof value !== 'string' || value.length === 0) {
    invalid('EPV1000', `${path}.${key}`, 'expected a non-empty string.');
  }
  return value;
}

/**
 * Validates the narrow identity contract shared by normalized providers and
 * blueprint Entity export. The type field is intentionally opaque: unknown
 * modded Entity type names are accepted only when the normalized provider
 * carries an explicit blueprint-eligibility fact.
 */
export function normalizeBlueprintEntityPrototype(
  value: unknown,
  path = '$.prototype',
): BlueprintEntityPrototypeRecord {
  const record = dataRecord(value, path);
  const key = requiredString(record, 'key', path);
  if (!key.startsWith('entity:')) {
    invalid('EPV1001', `${path}.key`, 'expected an Entity prototype key.');
  }
  const name = requiredString(record, 'name', path);
  const type = requiredString(record, 'type', path);
  const blueprintEligible = record.blueprintEligible;
  if (blueprintEligible !== undefined && typeof blueprintEligible !== 'boolean') {
    invalid('EPV1000', `${path}.blueprintEligible`, 'expected a boolean when present.');
  }
  if (key !== `entity:${name}`) {
    invalid(
      'EPV1002',
      `${path}.key`,
      `expected canonical key ${JSON.stringify(`entity:${name}`)}.`,
    );
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) {
    invalid(
      'EPV1002',
      `${path}.name`,
      'prototype name is not exportable as a canonical blueprint Entity name.',
    );
  }
  if (key.length > 128) {
    invalid('EPV1002', `${path}.key`, 'prototype key exceeds the Entity profile identity limit.');
  }
  return Object.freeze({
    key,
    name,
    type,
    ...(blueprintEligible === undefined ? {} : { blueprintEligible }),
  });
}

/** Pure eligibility guard for callers that do not need a diagnostic reason. */
export function isBlueprintEligibleEntityPrototype(
  value: unknown,
): value is BlueprintEntityPrototypeRecord {
  try {
    return normalizeBlueprintEntityPrototype(value).blueprintEligible === true;
  } catch (error) {
    if (error instanceof EntityProvisioningError) return false;
    throw error;
  }
}

function fallbackProfileId(prototypeKey: string): EntityProfileId {
  // Two independent 64-bit FNV-1a lanes keep the bounded identifier stable
  // without making profile generation asynchronous at the browser/Node seam.
  let first = 0xcbf29ce484222325n;
  let second = 0x84222325cbf29ce4n;
  for (let index = 0; index < prototypeKey.length; index += 1) {
    const code = BigInt(prototypeKey.charCodeAt(index));
    first = BigInt.asUintN(64, (first ^ code) * 0x100000001b3n);
    second = BigInt.asUintN(64, (second ^ (code + BigInt(index + 1))) * 0x100000001b3n);
  }
  return `profile:entity-fallback-v1:${first.toString(16).padStart(16, '0')}${second
    .toString(16)
    .padStart(16, '0')}` as EntityProfileId;
}

/**
 * Creates the conservative provider fallback: it makes no connector, default
 * read, callable, configuration, or native-behavior claim. The explicit
 * `connectorStructure: 'unknown'` is distinct from a reviewed empty profile.
 */
export function createEntityFallbackProfile(
  prototype: unknown,
  database: EntityDatabaseRef,
  path = '$.prototype',
): EntityProfile {
  const normalized = normalizeBlueprintEntityPrototype(prototype, path);
  if (normalized.blueprintEligible !== true) {
    invalid(
      'EPV1001',
      `${path}.blueprintEligible`,
      'Entity construction requires an explicit blueprint-eligible fact.',
    );
  }
  return canonicalizeEntityProfile({
    ref: {
      prototypeKey: normalized.key,
      database,
      profileId: fallbackProfileId(normalized.key),
    },
    connectors: [],
    connectorStructure: 'unknown',
    features: [],
    configurationRules: [],
    defaultReadProjection: null,
    synthetic: false,
  });
}

/** Creates a deterministic, canonically ordered fallback set for one database. */
export function createEntityFallbackProfileSet(
  prototypes: readonly unknown[],
  database: EntityDatabaseRef,
  path = '$.entities',
): readonly EntityProfile[] {
  if (!Array.isArray(prototypes)) invalid('EPV1000', path, 'expected an Entity prototype array.');
  const profiles = prototypes.map((prototype, index) =>
    createEntityFallbackProfile(prototype, database, `${path}[${index}]`),
  );
  const keys = new Set<string>();
  for (const [index, profile] of profiles.entries()) {
    if (keys.has(profile.ref.prototypeKey)) {
      invalid(
        'EPV1002',
        `${path}[${index}].key`,
        `duplicate Entity prototype ${JSON.stringify(profile.ref.prototypeKey)}.`,
      );
    }
    keys.add(profile.ref.prototypeKey);
  }
  return Object.freeze(
    [...profiles].sort((left, right) =>
      left.ref.prototypeKey < right.ref.prototypeKey
        ? -1
        : left.ref.prototypeKey > right.ref.prototypeKey
          ? 1
          : 0,
    ),
  );
}

import type {
  EntityDatabaseRef,
  EntityProfile,
  EntityProfileId,
  EntityProfileRef,
  EntityProfileSetId,
  EntityReplayContextSource,
  EntityReplayContextRef,
} from './entity.js';
import { sha256Utf8Hex } from '@comblang/shared';
import { entitySemanticVersion } from './entity.js';
import { canonicalizeEntityProfile } from './entity-profile.js';

export type EntityReplayContextErrorCode = 'ER1000' | 'ER1001' | 'ER1002' | 'ER1003';

export class EntityReplayContextError extends Error {
  readonly code: EntityReplayContextErrorCode;
  readonly path: string;

  constructor(code: EntityReplayContextErrorCode, path: string, message: string) {
    super(`${path}: ${message}`);
    this.name = 'EntityReplayContextError';
    this.code = code;
    this.path = path;
  }
}

export interface EntityReplayContextInput {
  readonly database: EntityDatabaseRef;
  readonly source: EntityReplayContextSource;
  readonly evidenceIdentity: string;
  readonly policyIdentity: string;
  readonly profiles: readonly EntityProfile[];
}

/** Host-owned context shared by replay; no provider methods or full database are transported. */
export interface TrustedEntityReplayContext {
  readonly database: EntityDatabaseRef;
  readonly source: EntityReplayContextSource;
  readonly profileSetIdentity: EntityProfileSetId;
  readonly evidenceIdentity: string;
  readonly policyIdentity: string;
  readonly profiles: readonly EntityProfile[];
}

/** The smallest cloneable context accepted by source, Worker, and CLI seams. */
export interface EntityReplayContextTransport {
  readonly protocolVersion: typeof entitySemanticVersion;
  readonly source: EntityReplayContextSource;
  readonly database: EntityDatabaseRef;
  readonly profileSetIdentity: EntityProfileSetId;
  readonly evidenceIdentity: string;
  readonly policyIdentity: string;
}

function invalid(code: EntityReplayContextErrorCode, path: string, message: string): never {
  throw new EntityReplayContextError(code, path, message);
}

function identity(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    invalid('ER1000', path, 'expected a non-empty identity.');
  }
  return value;
}

function schemaVersion(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    invalid('ER1000', path, 'expected a positive schema version.');
  }
  return value;
}

function source(value: unknown, path: string): EntityReplayContextSource {
  if (value !== 'synthetic' && value !== 'provider') {
    invalid('ER1000', path, 'expected synthetic or provider replay context source.');
  }
  return value;
}

function databaseRef(value: unknown, path: string): EntityDatabaseRef {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    invalid('ER1000', path, 'expected a database reference.');
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (keys.join(',') !== 'identity,schemaVersion') {
    invalid('ER1000', path, 'database reference has unexpected fields.');
  }
  return Object.freeze({
    schemaVersion: schemaVersion(record.schemaVersion, `${path}.schemaVersion`),
    identity: identity(record.identity, `${path}.identity`),
  });
}

function exactTransportKeys(value: Record<string, unknown>): void {
  const keys = Object.keys(value).sort();
  if (
    keys.join(',') !==
    'database,evidenceIdentity,policyIdentity,profileSetIdentity,protocolVersion,source'
  ) {
    invalid('ER1000', '$', 'replay context transport has unexpected fields.');
  }
}

function transportRecord(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    invalid('ER1000', '$', 'expected a replay context transport record.');
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    invalid('ER1000', '$', 'replay context transport must be a plain record.');
  }
  const record = Object.create(null) as Record<string, unknown>;
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string')
      invalid('ER1000', `$[${String(key)}]`, 'symbol keys are not allowed.');
    const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
    if (!('value' in descriptor)) invalid('ER1000', `$.${key}`, 'accessors are not allowed.');
    record[key] = descriptor.value;
  }
  return record;
}

const legacyProfileSetIdentities = new WeakMap<
  TrustedEntityReplayContext,
  ReadonlySet<EntityProfileSetId>
>();

function profileSetIdentity(profiles: readonly EntityProfile[]): EntityProfileSetId {
  const entries = [...profiles]
    .sort((left, right) => {
      if (left.ref.profileId < right.ref.profileId) return -1;
      if (left.ref.profileId > right.ref.profileId) return 1;
      return 0;
    })
    .map((profile) => canonicalizeEntityProfile(profile));
  return `entity-profile-set-v2-sha256:${sha256Utf8Hex(JSON.stringify(entries))}` as EntityProfileSetId;
}

function legacyProfileSetIdentity(profiles: readonly EntityProfile[]): EntityProfileSetId {
  const entries = [...profiles]
    .sort((left, right) => {
      if (left.ref.profileId < right.ref.profileId) return -1;
      if (left.ref.profileId > right.ref.profileId) return 1;
      return 0;
    })
    .map((profile) => {
      const { prototypeType: _prototypeType, ...legacyProfile } = profile;
      return canonicalizeEntityProfile(legacyProfile);
    });
  return `entity-profile-set-v1:${JSON.stringify(entries)}` as EntityProfileSetId;
}

function contextRef(value: unknown): EntityReplayContextRef {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    invalid('ER1000', '$', 'expected a replay context reference.');
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (keys.join(',') !== 'database,evidenceIdentity,policyIdentity,profileSetIdentity') {
    invalid('ER1000', '$', 'replay context reference has unexpected fields.');
  }
  return Object.freeze({
    database: databaseRef(record.database, '$.database'),
    evidenceIdentity: identity(record.evidenceIdentity, '$.evidenceIdentity'),
    policyIdentity: identity(record.policyIdentity, '$.policyIdentity'),
    profileSetIdentity: identity(
      record.profileSetIdentity,
      '$.profileSetIdentity',
    ) as EntityProfileSetId,
  });
}

function profileRef(value: unknown): EntityProfileRef {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    invalid('ER1000', '$', 'expected an Entity profile reference.');
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (keys.join(',') !== 'database,profileId,prototypeKey') {
    invalid('ER1000', '$', 'Entity profile reference has unexpected fields.');
  }
  return Object.freeze({
    prototypeKey: identity(record.prototypeKey, '$.prototypeKey'),
    database: databaseRef(record.database, '$.database'),
    profileId: identity(record.profileId, '$.profileId') as EntityProfileId,
  });
}

/** Binds canonical profiles to one immutable database/evidence/policy identity set. */
export function createTrustedEntityReplayContext(
  input: EntityReplayContextInput,
): TrustedEntityReplayContext {
  const database = databaseRef(input.database, '$.database');
  const contextSource = source(input.source, '$.source');
  const evidenceIdentity = identity(input.evidenceIdentity, '$.evidenceIdentity');
  const policyIdentity = identity(input.policyIdentity, '$.policyIdentity');
  if (!Array.isArray(input.profiles)) invalid('ER1000', '$.profiles', 'expected a profile array.');

  const profiles = input.profiles.map((profile, index) => {
    const canonical = canonicalizeEntityProfile(profile);
    if (
      canonical.ref.database.schemaVersion !== database.schemaVersion ||
      canonical.ref.database.identity !== database.identity
    ) {
      invalid(
        'ER1001',
        `$.profiles[${index}].ref.database`,
        'profile belongs to a different prototype database.',
      );
    }
    return canonical;
  });
  const profileIds = profiles.map(({ ref }) => ref.profileId);
  if (new Set(profileIds).size !== profileIds.length) {
    invalid('ER1002', '$.profiles', 'profile identity must be unique in a replay context.');
  }
  if (contextSource === 'synthetic') {
    const nonSyntheticIndex = profiles.findIndex((profile) => !profile.synthetic);
    if (nonSyntheticIndex >= 0) {
      invalid(
        'ER1003',
        `$.profiles[${nonSyntheticIndex}].synthetic`,
        'synthetic replay contexts may bind only synthetic profiles.',
      );
    }
  }

  const trusted = Object.freeze({
    database,
    source: contextSource,
    profileSetIdentity: profileSetIdentity(profiles),
    evidenceIdentity,
    policyIdentity,
    profiles: Object.freeze(profiles),
  });
  legacyProfileSetIdentities.set(
    trusted,
    new Set<EntityProfileSetId>([legacyProfileSetIdentity(profiles)]),
  );
  return trusted;
}

/** Validates the whole plan context before resolving any individual Entity profile. */
export function resolveEntityReplayContext(
  reference: unknown,
  context: TrustedEntityReplayContext,
): TrustedEntityReplayContext {
  const ref = contextRef(reference);
  if (
    ref.database.schemaVersion !== context.database.schemaVersion ||
    ref.database.identity !== context.database.identity
  ) {
    invalid('ER1001', '$.database', 'plan database reference does not match replay context.');
  }
  const legacyIdentities = legacyProfileSetIdentities.get(context);
  if (
    ref.profileSetIdentity !== context.profileSetIdentity &&
    !legacyIdentities?.has(ref.profileSetIdentity)
  ) {
    invalid('ER1001', '$.profileSetIdentity', 'plan profile set does not match replay context.');
  }
  if (ref.evidenceIdentity !== context.evidenceIdentity) {
    invalid(
      'ER1001',
      '$.evidenceIdentity',
      'plan evidence identity does not match replay context.',
    );
  }
  if (ref.policyIdentity !== context.policyIdentity) {
    invalid('ER1001', '$.policyIdentity', 'plan policy identity does not match replay context.');
  }
  return context;
}

/** Resolves the profile selected by one Entity record, independently of sibling records. */
export function resolveEntityReplayProfile(
  reference: unknown,
  context: TrustedEntityReplayContext,
): EntityProfile {
  const ref = profileRef(reference);
  if (
    ref.database.schemaVersion !== context.database.schemaVersion ||
    ref.database.identity !== context.database.identity
  ) {
    invalid('ER1001', '$.database', 'profile database reference does not match replay context.');
  }
  const profile = context.profiles.find(
    ({ ref: candidate }) => candidate.profileId === ref.profileId,
  );
  if (profile === undefined) {
    invalid('ER1002', '$.profileId', 'profile is missing or stale in replay context.');
  }
  if (profile.ref.prototypeKey !== ref.prototypeKey) {
    invalid('ER1001', '$.prototypeKey', 'prototype does not match the trusted profile.');
  }
  return profile;
}

/** Constructs the identity-only context reference carried by a v3 plan. */
export function entityReplayContextRef(
  context: TrustedEntityReplayContext,
): EntityReplayContextRef {
  return Object.freeze({
    database: context.database,
    profileSetIdentity: context.profileSetIdentity,
    evidenceIdentity: context.evidenceIdentity,
    policyIdentity: context.policyIdentity,
  });
}

/** Creates an identity-only context envelope; profiles and runtime methods stay host-local. */
export function entityReplayContextTransport(
  context: TrustedEntityReplayContext,
): EntityReplayContextTransport {
  return Object.freeze({
    protocolVersion: entitySemanticVersion,
    source: context.source,
    database: context.database,
    profileSetIdentity: context.profileSetIdentity,
    evidenceIdentity: context.evidenceIdentity,
    policyIdentity: context.policyIdentity,
  });
}

/** Revalidates a cloneable context at a process/Worker boundary and returns a detached snapshot. */
export function cloneEntityReplayContextTransport(value: unknown): EntityReplayContextTransport {
  const record = transportRecord(value);
  exactTransportKeys(record);
  if (record.protocolVersion !== entitySemanticVersion) {
    invalid('ER1000', '$.protocolVersion', 'unsupported Entity replay protocol version.');
  }
  return Object.freeze({
    protocolVersion: entitySemanticVersion,
    source: source(record.source, '$.source'),
    database: databaseRef(record.database, '$.database'),
    profileSetIdentity: identity(
      record.profileSetIdentity,
      '$.profileSetIdentity',
    ) as EntityProfileSetId,
    evidenceIdentity: identity(record.evidenceIdentity, '$.evidenceIdentity'),
    policyIdentity: identity(record.policyIdentity, '$.policyIdentity'),
  });
}

/** Cache identity includes every value that can change v3 acceptance. */
export function entityReplayContextIdentity(value: EntityReplayContextTransport): string {
  const context = cloneEntityReplayContextTransport(value);
  return JSON.stringify([
    context.protocolVersion,
    context.source,
    context.profileSetIdentity,
    context.database.schemaVersion,
    context.database.identity,
    context.evidenceIdentity,
    context.policyIdentity,
  ]);
}

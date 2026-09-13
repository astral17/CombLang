import type {
  EntityDatabaseRef,
  EntityProfile,
  TrustedEntityReplayContext,
} from '@comblang/compiler';
import {
  createEntityFallbackProfileSet,
  isBlueprintEligibleEntityPrototype,
} from '@comblang/compiler/entity-provisioning';
import {
  createTrustedEntityReplayContext,
  entityReplayContextTransport,
  type EntityReplayContextTransport,
} from '@comblang/compiler/entity-replay-context';
import type { PrototypeProvider } from '@comblang/prototypes';

import {
  entityPrototypeResolverFromProvider,
  type EntityPrototypeResolver,
} from './entity-registry.js';

/** Host policy identities are pins, not executable capability providers. */
export interface EntityProvisioningPolicy {
  readonly evidenceIdentity: string;
  readonly policyIdentity: string;
}

/** Conservative policy used when a host has selected a normalized provider. */
export const conservativeEntityProvisioningPolicy: EntityProvisioningPolicy = Object.freeze({
  evidenceIdentity: 'comblang-entity-fallback-evidence-v1',
  policyIdentity: 'comblang-entity-fallback-policy-v1',
});

export type EntityProvisioningServiceErrorCode = 'EPS1000' | 'EPS1001';

export class EntityProvisioningServiceError extends Error {
  readonly code: EntityProvisioningServiceErrorCode;
  readonly path: string;

  constructor(code: EntityProvisioningServiceErrorCode, path: string, message: string) {
    super(`${path}: ${message}`);
    this.name = 'EntityProvisioningServiceError';
    this.code = code;
    this.path = path;
  }
}

export interface ProvisionedEntityEnvironment {
  readonly database: EntityDatabaseRef;
  readonly profiles: readonly EntityProfile[];
  readonly trustedEntityReplayContext: TrustedEntityReplayContext;
  readonly entityPrototypeResolver: EntityPrototypeResolver;
  /** Identity-only transport snapshot; it carries no profiles or resolver. */
  readonly entityReplayContext: EntityReplayContextTransport;
}

function invalid(code: EntityProvisioningServiceErrorCode, path: string, message: string): never {
  throw new EntityProvisioningServiceError(code, path, message);
}

function dataRecord(value: unknown, path: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    invalid('EPS1000', path, 'expected a data-only provisioning policy.');
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    invalid('EPS1000', path, 'provisioning policy must be a plain record.');
  }
  const record = Object.create(null) as Record<string, unknown>;
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string')
      invalid('EPS1000', `${path}[${String(key)}]`, 'symbol fields are not allowed.');
    const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
    if (!('value' in descriptor))
      invalid('EPS1000', `${path}.${key}`, 'accessors are not allowed.');
    record[key] = descriptor.value;
  }
  return record;
}

function policySnapshot(value: EntityProvisioningPolicy): EntityProvisioningPolicy {
  const record = dataRecord(value, '$.policy');
  const keys = Object.keys(record).sort();
  if (keys.join(',') !== 'evidenceIdentity,policyIdentity') {
    invalid('EPS1000', '$.policy', 'unexpected provisioning policy field.');
  }
  const evidenceIdentity = record.evidenceIdentity;
  const policyIdentity = record.policyIdentity;
  if (typeof evidenceIdentity !== 'string' || evidenceIdentity.length === 0) {
    invalid('EPS1000', '$.policy.evidenceIdentity', 'expected a non-empty identity.');
  }
  if (typeof policyIdentity !== 'string' || policyIdentity.length === 0) {
    invalid('EPS1000', '$.policy.policyIdentity', 'expected a non-empty identity.');
  }
  return Object.freeze({ evidenceIdentity, policyIdentity });
}

function providerDatabase(provider: PrototypeProvider): EntityDatabaseRef {
  if (
    provider === null ||
    typeof provider !== 'object' ||
    !Object.isFrozen(provider) ||
    !Number.isSafeInteger(provider.schemaVersion) ||
    provider.schemaVersion < 1 ||
    typeof provider.identity !== 'string' ||
    provider.identity.length === 0
  ) {
    invalid('EPS1001', '$.provider', 'expected a selected immutable PrototypeProvider.');
  }
  return Object.freeze({ schemaVersion: provider.schemaVersion, identity: provider.identity });
}

function policyCacheKey(policy: EntityProvisioningPolicy): string {
  return JSON.stringify([policy.evidenceIdentity, policy.policyIdentity]);
}

/**
 * Builds host authority once per selected immutable provider and policy. No
 * profile or resolver is derived from a cloneable replay transport.
 */
export class EntityProvisioningService {
  readonly #cache = new WeakMap<object, Map<string, ProvisionedEntityEnvironment>>();

  provision(
    provider: PrototypeProvider,
    policy: EntityProvisioningPolicy,
  ): ProvisionedEntityEnvironment {
    const database = providerDatabase(provider);
    const snapshot = policySnapshot(policy);
    const providerKey = provider as unknown as object;
    const key = policyCacheKey(snapshot);
    const cached = this.#cache.get(providerKey)?.get(key);
    if (cached !== undefined) return cached;

    const prototypes = Object.values(provider.entity).filter(
      (value) => value !== undefined && isBlueprintEligibleEntityPrototype(value),
    );
    const profiles: readonly EntityProfile[] = createEntityFallbackProfileSet(prototypes, database);
    const trustedEntityReplayContext = createTrustedEntityReplayContext({
      database,
      source: 'provider',
      evidenceIdentity: snapshot.evidenceIdentity,
      policyIdentity: snapshot.policyIdentity,
      profiles,
    });
    const result = Object.freeze({
      database,
      profiles: trustedEntityReplayContext.profiles,
      trustedEntityReplayContext,
      entityPrototypeResolver: entityPrototypeResolverFromProvider(provider),
      entityReplayContext: entityReplayContextTransport(trustedEntityReplayContext),
    });
    const providerCache = this.#cache.get(providerKey) ?? new Map();
    providerCache.set(key, result);
    this.#cache.set(providerKey, providerCache);
    return result;
  }
}

import type {
  EntityConfiguration,
  EntityId,
  EntityProfileRef,
  EntityProvenance,
  EntityRecord,
} from '@comblang/compiler/entity';
import type { EntityPlacement } from '@comblang/compiler/ir';
import { canonicalizeEntityRawJson } from '@comblang/compiler/entity-raw';
import {
  EntityReplayContextError,
  resolveEntityReplayProfile,
  type TrustedEntityReplayContext,
} from '@comblang/compiler/entity-replay-context';
import type { SourceSpan } from '@comblang/shared';
import { StableIdAllocator } from '@comblang/shared';
import type { EntityPrototype, PrototypeProvider } from '@comblang/prototypes';

export type EntityRegistryErrorCode = 'EN1000' | 'EN1001' | 'EN1002' | 'EN1003';

export class EntityRegistryError extends Error {
  readonly code: EntityRegistryErrorCode;
  readonly path: string;

  constructor(code: EntityRegistryErrorCode, path: string, message: string) {
    super(`${path}: ${message}`);
    this.name = 'EntityRegistryError';
    this.code = code;
    this.path = path;
  }
}

export interface EntityConstructionRequest {
  readonly profile: EntityProfileRef;
  readonly configuration?: EntityConfiguration;
  readonly placement?: EntityPlacement;
  readonly source: SourceSpan;
  readonly instancePath: readonly string[];
  readonly expansionStack?: readonly string[];
  readonly creationRevision: number;
}

/** Narrow prototype lookup boundary; production instances are derived from a provider. */
export interface EntityPrototypeResolver {
  readonly database: EntityProfileRef['database'];
  getEntity(nameOrKey: string): EntityPrototype | undefined;
}

/** Adapts the selected host PrototypeProvider without transporting the provider itself. */
export function entityPrototypeResolverFromProvider(
  provider: PrototypeProvider,
): EntityPrototypeResolver {
  return Object.freeze({
    database: Object.freeze({ schemaVersion: provider.schemaVersion, identity: provider.identity }),
    getEntity(nameOrKey: string) {
      return provider.getEntity(nameOrKey);
    },
  });
}

/** Session-local nominal handle; its fields are a snapshot, not a structural guard. */
export interface EntityValue {
  readonly kind: 'entity';
  readonly id: EntityId;
  readonly profile: EntityProfileRef;
  readonly configuration?: EntityConfiguration;
  readonly placement?: EntityPlacement;
}

function invalid(code: EntityRegistryErrorCode, path: string, message: string): never {
  throw new EntityRegistryError(code, path, message);
}

function sourceSnapshot(source: SourceSpan): SourceSpan {
  if (
    typeof source !== 'object' ||
    source === null ||
    typeof source.fileId !== 'string' ||
    !Number.isSafeInteger(source.start) ||
    !Number.isSafeInteger(source.end) ||
    source.start < 0 ||
    source.end < source.start
  ) {
    invalid('EN1000', '$.source', 'expected a valid source span.');
  }
  return Object.freeze({ fileId: source.fileId, start: source.start, end: source.end });
}

function pathSnapshot(path: readonly string[], label: string): readonly string[] {
  if (!Array.isArray(path) || path.some((segment) => typeof segment !== 'string')) {
    invalid('EN1000', `$.${label}`, 'expected a string path.');
  }
  return Object.freeze([...path]);
}

function revision(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    invalid('EN1000', '$.creationRevision', 'expected a positive safe integer.');
  }
  return value;
}

function placementSnapshot(value: EntityPlacement): EntityPlacement {
  if (
    typeof value !== 'object' ||
    value === null ||
    !Number.isFinite(value.x) ||
    !Number.isFinite(value.y) ||
    (value.direction !== undefined && !Number.isFinite(value.direction))
  ) {
    invalid('EN1000', '$.placement', 'placement must contain finite coordinates.');
  }
  return Object.freeze({
    x: value.x,
    y: value.y,
    ...(value.direction === undefined ? {} : { direction: value.direction }),
  });
}

function configurationSnapshot(value: EntityConfiguration): EntityConfiguration {
  const payload = canonicalizeEntityRawJson(value.payload);
  if (value.mode === 'raw' || value.mode === 'typed') {
    return Object.freeze({ mode: value.mode, payload });
  }
  invalid('EN1000', '$.configuration.mode', 'unknown Entity configuration mode.');
}

/** Owns one session's Entity identities and never accepts structural impostors. */
export class EntityRegistry {
  readonly #context: TrustedEntityReplayContext;
  readonly #prototypes: EntityPrototypeResolver;
  readonly #ids = new StableIdAllocator('entity');
  readonly #values = new WeakSet<object>();
  readonly #records = new WeakMap<object, EntityRecord>();
  readonly #allRecords: EntityRecord[] = [];

  constructor(context: TrustedEntityReplayContext, prototypes: EntityPrototypeResolver) {
    this.#context = context;
    this.#prototypes = prototypes;
  }

  create(request: EntityConstructionRequest): EntityValue {
    let profile: ReturnType<typeof resolveEntityReplayProfile>;
    try {
      profile = resolveEntityReplayProfile(request.profile, this.#context);
    } catch (error) {
      if (error instanceof EntityReplayContextError && error.code === 'ER1001') {
        const suffix = error.path === '$' ? '' : error.path.slice(1);
        invalid('EN1002', `$.profile${suffix}`, error.message);
      }
      throw error;
    }
    if (
      this.#prototypes.database.schemaVersion !== this.#context.database.schemaVersion ||
      this.#prototypes.database.identity !== this.#context.database.identity
    ) {
      invalid(
        'EN1003',
        '$.prototypes.database',
        'prototype resolver does not match replay context.',
      );
    }
    let prototype: EntityPrototype | undefined;
    try {
      prototype = this.#prototypes.getEntity(profile.ref.prototypeKey);
    } catch (error) {
      invalid(
        'EN1003',
        '$.profile.prototypeKey',
        error instanceof Error ? error.message : 'prototype lookup failed.',
      );
    }
    if (prototype === undefined) {
      invalid(
        'EN1003',
        '$.profile.prototypeKey',
        `prototype ${profile.ref.prototypeKey} is not available in the selected database.`,
      );
    }

    const source = sourceSnapshot(request.source);
    const instancePath = pathSnapshot(request.instancePath, 'instancePath');
    const expansionStack = pathSnapshot(request.expansionStack ?? [], 'expansionStack');
    const configuration =
      request.configuration === undefined
        ? undefined
        : configurationSnapshot(request.configuration);
    const placement =
      request.placement === undefined ? undefined : placementSnapshot(request.placement);
    const provenance: EntityProvenance = Object.freeze({
      source,
      instancePath,
      expansionStack,
      creationRevision: revision(request.creationRevision),
    });
    const id = this.#ids.allocate() as unknown as EntityId;
    const record: EntityRecord = Object.freeze({
      id,
      profile: profile.ref,
      ...(configuration === undefined ? {} : { configuration }),
      connectorBindings: Object.freeze([]),
      ...(placement === undefined ? {} : { placement }),
      provenance,
      ordinal: this.#allRecords.length + 1,
    });
    const value: EntityValue = Object.freeze({
      kind: 'entity',
      id,
      profile: profile.ref,
      ...(configuration === undefined ? {} : { configuration }),
      ...(placement === undefined ? {} : { placement }),
    });
    this.#values.add(value);
    this.#records.set(value, record);
    this.#allRecords.push(record);
    return value;
  }

  isEntity(value: unknown): value is EntityValue {
    return typeof value === 'object' && value !== null && this.#values.has(value);
  }

  alias(value: unknown): EntityValue {
    if (this.isEntity(value)) return value;
    invalid('EN1001', '$', 'value is not an Entity handle from this session.');
  }

  record(value: unknown): EntityRecord {
    const entity = this.alias(value);
    return this.#records.get(entity)!;
  }

  records(): readonly EntityRecord[] {
    return Object.freeze([...this.#allRecords]);
  }
}

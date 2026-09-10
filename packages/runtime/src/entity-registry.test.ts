import { describe, expect, test } from 'vitest';

import type {
  EntityBehaviorKey,
  EntityLaneKey,
  EntityProfileId,
  EntityProfile,
} from '@comblang/compiler/entity';
import { sourceFileId, sourceSpan } from '@comblang/shared';
import {
  loadPrototypeDatabase,
  syntheticPrototypeDatabase,
  type EntityPrototype,
} from '@comblang/prototypes';

import {
  EntityRegistry,
  EntityRegistryError,
  type EntityConstructionRequest,
  type EntityPrototypeResolver,
  entityPrototypeResolverFromProvider,
} from './entity-registry.js';
import {
  createTrustedEntityReplayContext,
  type TrustedEntityReplayContext,
} from '@comblang/compiler/entity-replay-context';
import {
  syntheticSharedTwoColorEntityProfile,
  syntheticZeroPortEntityProfile,
} from '@comblang/compiler/entity-fixtures';

function context(
  profiles: readonly EntityProfile[] = [syntheticZeroPortEntityProfile],
): TrustedEntityReplayContext {
  return createTrustedEntityReplayContext({
    database: syntheticZeroPortEntityProfile.ref.database,
    source: 'synthetic',
    evidenceIdentity: 'comblang-synthetic-evidence-v1',
    policyIdentity: 'comblang-entity-policy-v1',
    profiles,
  });
}

function request(overrides: Partial<EntityConstructionRequest> = {}): EntityConstructionRequest {
  return {
    profile: syntheticZeroPortEntityProfile.ref,
    source: sourceSpan(sourceFileId('entity.ts'), 4, 18),
    instancePath: ['root', 'Entity:1'],
    creationRevision: 3,
    ...overrides,
  };
}

function createSyntheticEntityPrototypeResolver(
  options: { readonly databaseIdentity?: string; readonly available?: readonly string[] } = {},
): EntityPrototypeResolver {
  const available = new Set(
    options.available ?? [
      syntheticZeroPortEntityProfile.ref.prototypeKey,
      'entity:synthetic-shared-two-color',
    ],
  );
  return {
    database: {
      schemaVersion: 1,
      identity: options.databaseIdentity ?? syntheticZeroPortEntityProfile.ref.database.identity,
    },
    getEntity(nameOrKey) {
      if (!available.has(nameOrKey)) return undefined;
      return {
        key: nameOrKey as EntityPrototype['key'],
        name: nameOrKey.replace('entity:', ''),
        type: 'container',
        tileWidth: 1,
        tileHeight: 1,
      };
    },
  };
}

describe('session-local Entity registry', () => {
  test('creates distinct nominal zero-port descriptors with stable provenance', () => {
    const registry = new EntityRegistry(context(), createSyntheticEntityPrototypeResolver());
    const first = registry.create(request());
    const second = registry.create(request({ instancePath: ['root', 'Entity:2'] }));

    expect(first.id).not.toBe(second.id);
    expect(registry.records()).toHaveLength(2);
    expect(registry.record(first)).toMatchObject({
      id: first.id,
      ordinal: 1,
      provenance: {
        source: { start: 4, end: 18 },
        instancePath: ['root', 'Entity:1'],
        creationRevision: 3,
      },
      connectorBindings: [],
    });
    expect(registry.record(first)).not.toHaveProperty('producer');
  });

  test('preserves aliases and rejects structural or foreign-session impostors', () => {
    const registry = new EntityRegistry(context(), createSyntheticEntityPrototypeResolver());
    const foreign = new EntityRegistry(context(), createSyntheticEntityPrototypeResolver()).create(
      request(),
    );
    const entity = registry.create(request());
    const impostor = { kind: 'entity', id: entity.id, profile: entity.profile };

    expect(registry.alias(entity)).toBe(entity);
    expect(registry.record(entity)).toBe(registry.record(registry.alias(entity)));
    expect(registry.isEntity(foreign)).toBe(false);
    expect(registry.isEntity(structuredClone(entity))).toBe(false);
    expect(structuredClone(entity)).not.toHaveProperty('alias');
    expect(registry.isEntity(impostor)).toBe(false);
    expect(() => registry.alias(foreign)).toThrowError(expect.objectContaining({ code: 'EN1001' }));
    expect(() => registry.record(impostor)).toThrowError(
      expect.objectContaining({ code: 'EN1001' }),
    );
  });

  test('rejects unknown profiles and prototype/profile mismatches', () => {
    const registry = new EntityRegistry(context(), createSyntheticEntityPrototypeResolver());
    expect(() =>
      registry.create(
        request({
          profile: {
            ...syntheticZeroPortEntityProfile.ref,
            profileId: 'profile:missing-v1' as EntityProfileId,
          },
        }),
      ),
    ).toThrowError(expect.objectContaining({ code: 'ER1002' }));
    expect(() =>
      registry.create(
        request({
          profile: { ...syntheticZeroPortEntityProfile.ref, prototypeKey: 'entity:other' },
        }),
      ),
    ).toThrowError(expect.objectContaining({ code: 'EN1002', path: '$.profile.prototypeKey' }));
  });

  test('snapshots configuration and placement without inventing a producer', () => {
    const registry = new EntityRegistry(context(), createSyntheticEntityPrototypeResolver());
    const configuration = {
      mode: 'raw' as const,
      payload: { enabled: false, filter: null },
    };
    const placement = { x: 2, y: 3, direction: 4 };
    const entity = registry.create(request({ configuration, placement }));
    configuration.payload.enabled = true;
    placement.x = 99;

    expect(registry.record(entity).configuration).toEqual({
      mode: 'raw',
      payload: { enabled: false, filter: null },
    });
    expect(registry.record(entity).placement).toEqual({ x: 2, y: 3, direction: 4 });
    expect(Object.isFrozen(registry.record(entity))).toBe(true);
    expect(Object.isFrozen(entity)).toBe(true);
  });

  test('snapshots typed configuration by rule and lanes without resolving physical metadata', () => {
    const registry = new EntityRegistry(
      context([syntheticZeroPortEntityProfile, syntheticSharedTwoColorEntityProfile]),
      createSyntheticEntityPrototypeResolver(),
    );
    const configuration = {
      mode: 'typed' as const,
      rule: 'shared-circuit-condition' as EntityBehaviorKey,
      lanes: ['shared-green' as EntityLaneKey, 'shared-red' as EntityLaneKey],
      condition: {
        kind: 'compare-signal-constant' as const,
        signal: { type: 'virtual' as const, name: 'signal-A' },
        comparator: '!=' as const,
        constant: 4,
      },
    } satisfies NonNullable<EntityConstructionRequest['configuration']>;
    const entity = registry.create(
      request({ profile: syntheticSharedTwoColorEntityProfile.ref, configuration }),
    );
    configuration.lanes.reverse();
    configuration.condition.signal.name = 'mutated-after-create';

    expect(registry.record(entity).configuration).toEqual({
      mode: 'typed',
      rule: 'shared-circuit-condition',
      lanes: ['shared-green', 'shared-red'],
      condition: {
        kind: 'compare-signal-constant',
        signal: { type: 'virtual', name: 'signal-A' },
        comparator: '!=',
        constant: 4,
      },
    });
    expect(registry.records()).toHaveLength(1);
  });

  test('retains the deprecated opaque typed v3 payload without granting capability authority', () => {
    const registry = new EntityRegistry(
      context([syntheticZeroPortEntityProfile, syntheticSharedTwoColorEntityProfile]),
      createSyntheticEntityPrototypeResolver(),
    );
    const configuration = { mode: 'typed' as const, payload: { legacy: false } };
    const entity = registry.create(
      request({ profile: syntheticSharedTwoColorEntityProfile.ref, configuration }),
    );
    configuration.payload.legacy = true;

    expect(registry.record(entity).configuration).toEqual({
      mode: 'typed',
      payload: { legacy: false },
    });
    expect(registry.records()).toHaveLength(1);
  });

  test('reports malformed construction metadata as structured errors', () => {
    const registry = new EntityRegistry(context(), createSyntheticEntityPrototypeResolver());
    try {
      registry.create(request({ creationRevision: 0 }));
      throw new Error('expected invalid revision');
    } catch (error) {
      expect(error).toBeInstanceOf(EntityRegistryError);
      expect(error).toMatchObject({ code: 'EN1000', path: '$.creationRevision' });
    }
  });

  test('requires a matching prototype resolver and verifies the prototype before allocation', () => {
    const missing = new EntityRegistry(
      context(),
      createSyntheticEntityPrototypeResolver({ available: [] }),
    );
    expect(() => missing.create(request())).toThrowError(
      expect.objectContaining({ code: 'EN1003', path: '$.profile.prototypeKey' }),
    );
    expect(missing.records()).toEqual([]);

    const mismatched = new EntityRegistry(
      context(),
      createSyntheticEntityPrototypeResolver({ databaseIdentity: 'database-other' }),
    );
    expect(() => mismatched.create(request())).toThrowError(
      expect.objectContaining({ code: 'EN1003', path: '$.prototypes.database' }),
    );
    expect(mismatched.records()).toEqual([]);
  });

  test('derives the production resolver identity and lookup from the selected provider', async () => {
    const loaded = await loadPrototypeDatabase(syntheticPrototypeDatabase());
    const profile = {
      ...structuredClone(syntheticZeroPortEntityProfile),
      ref: {
        ...syntheticZeroPortEntityProfile.ref,
        database: {
          schemaVersion: loaded.database.schemaVersion,
          identity: loaded.prototypes.identity,
        },
        prototypeKey: 'entity:assembling-machine-3',
      },
    };
    const trusted = createTrustedEntityReplayContext({
      database: profile.ref.database,
      source: 'provider',
      evidenceIdentity: 'provider-evidence-v1',
      policyIdentity: 'provider-policy-v1',
      profiles: [profile],
    });
    const registry = new EntityRegistry(
      trusted,
      entityPrototypeResolverFromProvider(loaded.prototypes),
    );

    expect(registry.create(request({ profile: profile.ref })).profile).toEqual(profile.ref);
    expect(registry.records()).toHaveLength(1);
  });
});

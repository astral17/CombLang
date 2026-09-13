import { describe, expect, test } from 'vitest';

import {
  createEntityFallbackProfile,
  createEntityFallbackProfileSet,
  EntityProvisioningError,
  isBlueprintEligibleEntityPrototype,
  normalizeBlueprintEntityPrototype,
} from './entity-provisioning.js';
import { syntheticZeroPortEntityProfile } from './entity-fixtures.js';

const database = {
  schemaVersion: 1,
  identity: 'comblang-provider-database-v1',
} as const;

const assemblingMachine = {
  key: 'entity:assembling-machine-3',
  name: 'assembling-machine-3',
  type: 'assembling-machine',
  blueprintEligible: true,
  tileWidth: 3,
  tileHeight: 3,
};

describe('Entity construction provisioning contract', () => {
  test('accepts canonical Entity records while keeping unknown type names opaque', () => {
    expect(
      normalizeBlueprintEntityPrototype({ ...assemblingMachine, type: 'modded-machine' }),
    ).toEqual({
      key: 'entity:assembling-machine-3',
      name: 'assembling-machine-3',
      type: 'modded-machine',
      blueprintEligible: true,
    });
    expect(isBlueprintEligibleEntityPrototype(assemblingMachine)).toBe(true);
    expect(
      isBlueprintEligibleEntityPrototype({
        ...assemblingMachine,
        blueprintEligible: false,
      }),
    ).toBe(false);
    expect(
      isBlueprintEligibleEntityPrototype({
        ...assemblingMachine,
        blueprintEligible: undefined,
      }),
    ).toBe(false);
    expect(isBlueprintEligibleEntityPrototype({ key: 'item:iron-plate', name: 'iron-plate' })).toBe(
      false,
    );
  });

  test('creates one deterministic minimal unknown-structure profile per eligible prototype', () => {
    const first = createEntityFallbackProfile(assemblingMachine, database);
    const second = createEntityFallbackProfile(structuredClone(assemblingMachine), database);

    expect(second).toEqual(first);
    expect(first.ref).toEqual({
      prototypeKey: 'entity:assembling-machine-3',
      database,
      profileId: first.ref.profileId,
    });
    expect(first.connectors).toEqual([]);
    expect(first.connectorStructure).toBe('unknown');
    expect(first.features).toEqual([]);
    expect(first.configurationRules).toEqual([]);
    expect(first.defaultReadProjection).toBeNull();
    expect(first).not.toHaveProperty('callProjection');
    expect(first.prototypeType).toBe('assembling-machine');
    expect(first.synthetic).toBe(false);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.ref)).toBe(true);
  });

  test('keeps unknown structure distinct from a complete verified empty profile', () => {
    expect(syntheticZeroPortEntityProfile.connectorStructure).toBe('complete');
    const fallback = createEntityFallbackProfile(assemblingMachine, database);
    expect(fallback.connectorStructure).not.toBe(syntheticZeroPortEntityProfile.connectorStructure);
    expect(fallback.connectors).toEqual(syntheticZeroPortEntityProfile.connectors);
  });

  test('creates one stable sorted fallback profile for every eligible record', () => {
    const profiles = createEntityFallbackProfileSet(
      [
        assemblingMachine,
        {
          key: 'entity:stone-furnace',
          name: 'stone-furnace',
          type: 'furnace',
          blueprintEligible: true,
        },
      ],
      database,
    );

    expect(profiles.map(({ ref }) => ref.prototypeKey)).toEqual([
      'entity:assembling-machine-3',
      'entity:stone-furnace',
    ]);
    expect(profiles.map(({ prototypeType }) => prototypeType)).toEqual([
      'assembling-machine',
      'furnace',
    ]);
    expect(new Set(profiles.map(({ ref }) => ref.profileId)).size).toBe(2);
    expect(Object.isFrozen(profiles)).toBe(true);
  });

  test.each([
    [
      { key: 'entity:wrong-name', name: 'right-name', type: 'container' },
      '$.prototype.key',
      'EPV1002',
    ],
    [
      { key: 'entity:bad name', name: 'bad name', type: 'container' },
      '$.prototype.name',
      'EPV1002',
    ],
    [{ key: 'entity:missing-type', name: 'missing-type' }, '$.prototype.type', 'EPV1000'],
    [
      { key: 'entity:bad/name', name: 'bad/name', type: 'container' },
      '$.prototype.name',
      'EPV1002',
    ],
  ] as const)(
    'rejects non-exportable or incomplete records with a precise diagnostic',
    (value, path, code) => {
      expect(() => normalizeBlueprintEntityPrototype(value)).toThrowError(
        expect.objectContaining({ name: 'EntityProvisioningError', code, path }),
      );
    },
  );

  test('rejects non-Entity normalized records at their canonical key', () => {
    expect(() =>
      normalizeBlueprintEntityPrototype({
        key: 'item:iron-plate',
        name: 'iron-plate',
        type: 'item',
      }),
    ).toThrowError(expect.objectContaining({ code: 'EPV1001', path: '$.prototype.key' }));
    expect(() => normalizeBlueprintEntityPrototype(null)).toThrowError(EntityProvisioningError);
  });

  test('rejects duplicate Entity records instead of producing ambiguous profiles', () => {
    expect(() =>
      createEntityFallbackProfileSet([assemblingMachine, assemblingMachine], database),
    ).toThrowError(expect.objectContaining({ code: 'EPV1002', path: '$.entities[1].key' }));
  });

  test('does not create a fallback profile without explicit eligibility evidence', () => {
    expect(() =>
      createEntityFallbackProfile({ ...assemblingMachine, blueprintEligible: false }, database),
    ).toThrowError(
      expect.objectContaining({ code: 'EPV1001', path: '$.prototype.blueprintEligible' }),
    );
    expect(() =>
      createEntityFallbackProfile({ ...assemblingMachine, blueprintEligible: undefined }, database),
    ).toThrowError(
      expect.objectContaining({ code: 'EPV1001', path: '$.prototype.blueprintEligible' }),
    );
  });

  test('rejects an accessor at the normalized provider type seam without invoking it', () => {
    let called = false;
    const prototype = { ...assemblingMachine } as Record<string, unknown>;
    Object.defineProperty(prototype, 'type', {
      enumerable: true,
      get: () => {
        called = true;
        return 'assembling-machine';
      },
    });

    expect(() => normalizeBlueprintEntityPrototype(prototype)).toThrowError(
      expect.objectContaining({ code: 'EPV1000', path: '$.prototype.type' }),
    );
    expect(called).toBe(false);
  });
});

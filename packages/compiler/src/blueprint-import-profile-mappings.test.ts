import { readFile } from 'node:fs/promises';
import { describe, expect, test } from 'vitest';

import * as publicCompiler from './index.js';
import {
  createTrustedEntityReplayContext,
  EntityReplayContextError,
  type TrustedEntityReplayContext,
} from './entity-replay-context.js';
import {
  syntheticSharedTwoColorEntityProfile,
  syntheticZeroPortEntityProfile,
} from './entity-fixtures.js';
import type { EntityProfile, EntityProfileRef } from './entity.js';
import { projectBlueprintImportProfileMappings } from './blueprint-import-profile-mappings.js';

type MutableProfile = Record<string, any>;

function editableSharedProfile(): MutableProfile {
  return JSON.parse(JSON.stringify(syntheticSharedTwoColorEntityProfile)) as MutableProfile;
}

function context(
  profiles: readonly EntityProfile[] = [syntheticSharedTwoColorEntityProfile],
): TrustedEntityReplayContext {
  return createTrustedEntityReplayContext({
    database: syntheticZeroPortEntityProfile.ref.database,
    source: 'synthetic',
    evidenceIdentity: 'comblang-synthetic-evidence-v1',
    policyIdentity: 'comblang-entity-policy-v1',
    profiles,
  });
}

function entry(
  entityNumber: number,
  profile: EntityProfileRef = syntheticSharedTwoColorEntityProfile.ref,
) {
  return { entityNumber, profile };
}

function withSecondPhysicalConnector(): EntityProfile {
  const profile = editableSharedProfile();
  profile.ref.profileId = 'profile:synthetic-two-connector-v1' as EntityProfile['ref']['profileId'];
  profile.ref.prototypeKey = 'entity:synthetic-two-connector';
  profile.connectors[0]!.direction = 'input';
  delete profile.callProjection;
  profile.features.push({
    key: 'read-alias',
    connector: 'shared',
    defaultLane: 'shared-green',
    allowedLanes: ['shared-green'],
  });
  profile.connectors.push({
    key: 'auxiliary' as EntityProfile['connectors'][number]['key'],
    direction: 'output',
    lanes: (['red', 'green'] as const).map((color) => {
      const lane = `aux-${color}` as EntityProfile['connectors'][number]['lanes'][number]['key'];
      return {
        key: lane,
        color,
        nativeEndpoint: {
          endpoint: { connector: 'auxiliary', lane, color },
          nativeConnector: 2,
        },
      };
    }),
  });
  return profile as EntityProfile;
}

function withNativeOrdinal(nativeConnector: number): EntityProfile {
  const profile = editableSharedProfile();
  profile.connectors[0]!.lanes[0]!.nativeEndpoint!.nativeConnector = nativeConnector;
  return profile as EntityProfile;
}

describe('blueprint import profile endpoint mappings', () => {
  test('projects both physical colors even when feature defaults and call projection select lanes', () => {
    const trusted = context();
    const before = JSON.stringify(trusted);
    const result = projectBlueprintImportProfileMappings([entry(17)], trusted);

    expect(result).toEqual({
      state: 'complete',
      mappings: [
        { entityNumber: 17, connectorId: 1, color: 'red' },
        { entityNumber: 17, connectorId: 2, color: 'green' },
      ],
      diagnostics: [],
    });
    expect(result.mappings.map((mapping) => Object.keys(mapping))).toEqual([
      ['entityNumber', 'connectorId', 'color'],
      ['entityNumber', 'connectorId', 'color'],
    ]);
    expect(JSON.stringify(trusted)).toBe(before);
  });

  test('keeps selected entities distinct and sorts independently of entry order', () => {
    const trusted = context();
    const forward = projectBlueprintImportProfileMappings([entry(20), entry(3)], trusted);
    const reverse = projectBlueprintImportProfileMappings([entry(3), entry(20)], trusted);

    expect(forward).toEqual(reverse);
    expect(forward.mappings).toEqual([
      { entityNumber: 3, connectorId: 1, color: 'red' },
      { entityNumber: 3, connectorId: 2, color: 'green' },
      { entityNumber: 20, connectorId: 1, color: 'red' },
      { entityNumber: 20, connectorId: 2, color: 'green' },
    ]);
  });

  test('projects ordinal two as connector IDs three and four without collapsing ports', () => {
    const multiPort = withSecondPhysicalConnector();
    const result = projectBlueprintImportProfileMappings(
      [entry(8, multiPort.ref)],
      context([multiPort]),
    );

    expect(result.state).toBe('complete');
    expect(result.mappings).toEqual([
      { entityNumber: 8, connectorId: 1, color: 'red' },
      { entityNumber: 8, connectorId: 2, color: 'green' },
      { entityNumber: 8, connectorId: 3, color: 'red' },
      { entityNumber: 8, connectorId: 4, color: 'green' },
    ]);
  });

  test('treats a complete zero-port profile as complete without manufacturing ports', () => {
    const legacy = JSON.parse(JSON.stringify(syntheticZeroPortEntityProfile)) as MutableProfile;
    delete legacy.connectorStructure;
    const legacyProfile = legacy as EntityProfile;
    const result = projectBlueprintImportProfileMappings(
      [entry(9, legacyProfile.ref)],
      context([legacyProfile]),
    );

    expect(result).toEqual({ state: 'complete', mappings: [], diagnostics: [] });
  });

  test('blocks unknown connector structure and reports the profile structure path', () => {
    const profile = editableSharedProfile();
    profile.connectorStructure = 'unknown';
    const canonical = profile as EntityProfile;
    const result = projectBlueprintImportProfileMappings(
      [entry(4, canonical.ref)],
      context([canonical]),
    );

    expect(result.state).toBe('blocked');
    expect(result.mappings).toEqual([]);
    expect(result.diagnostics).toMatchObject([
      {
        category: 'unknown-connector-structure',
        path: '$.entries[0].profile.connectorStructure',
        entityNumber: 4,
      },
    ]);
  });

  test('blocks all rows when any declared lane lacks a native endpoint', () => {
    const incomplete = editableSharedProfile();
    delete incomplete.connectors[0]!.lanes[0]!.nativeEndpoint;
    delete incomplete.connectors[0]!.lanes[1]!.nativeEndpoint;
    incomplete.ref.profileId =
      'profile:synthetic-missing-endpoint-v1' as EntityProfile['ref']['profileId'];
    incomplete.ref.prototypeKey = 'entity:synthetic-missing-endpoint';
    const incompleteProfile = incomplete as EntityProfile;
    const trusted = context([syntheticSharedTwoColorEntityProfile, incompleteProfile]);
    const result = projectBlueprintImportProfileMappings(
      [entry(1), entry(2, incompleteProfile.ref)],
      trusted,
    );

    expect(result.state).toBe('blocked');
    expect(result.mappings).toEqual([]);
    expect(result.diagnostics).toMatchObject([
      {
        category: 'missing-native-endpoint',
        path: '$.entries[1].profile.connectors[0].lanes[0].nativeEndpoint',
        entityNumber: 2,
      },
      {
        category: 'missing-native-endpoint',
        path: '$.entries[1].profile.connectors[0].lanes[1].nativeEndpoint',
        entityNumber: 2,
      },
    ]);
  });

  test('accepts the largest safely encodable ordinal and blocks multiplication overflow', () => {
    const largestSafeOrdinal = Math.floor(Number.MAX_SAFE_INTEGER / 2);
    const boundaryProfile = withNativeOrdinal(largestSafeOrdinal);
    const boundary = projectBlueprintImportProfileMappings(
      [entry(5, boundaryProfile.ref)],
      context([boundaryProfile]),
    );
    expect(boundary.state).toBe('complete');
    expect(boundary.mappings.find(({ color }) => color === 'red')?.connectorId).toBe(
      largestSafeOrdinal * 2 - 1,
    );

    const overflowProfile = withNativeOrdinal(largestSafeOrdinal + 1);
    const overflow = projectBlueprintImportProfileMappings(
      [entry(5, overflowProfile.ref)],
      context([overflowProfile]),
    );
    expect(overflow.state).toBe('blocked');
    expect(overflow.mappings).toEqual([]);
    expect(overflow.diagnostics).toMatchObject([
      {
        category: 'invalid-native-ordinal',
        path: '$.entries[0].profile.connectors[0].lanes[1].nativeEndpoint',
        entityNumber: 5,
      },
    ]);
  });

  test('blocks duplicate emitted endpoint keys instead of merging them', () => {
    const trusted = context();
    const invalidForCanonicalization = editableSharedProfile();
    invalidForCanonicalization.connectors[0]!.lanes.push({
      key: 'duplicate-red' as EntityProfile['connectors'][number]['lanes'][number]['key'],
      color: 'red',
      nativeEndpoint: {
        endpoint: {
          connector: 'shared' as EntityProfile['connectors'][number]['key'],
          lane: 'duplicate-red' as EntityProfile['connectors'][number]['lanes'][number]['key'],
          color: 'red',
        },
        nativeConnector: 1,
      },
    });
    const forgedContext = {
      ...trusted,
      profiles: [invalidForCanonicalization as unknown as EntityProfile],
    } as TrustedEntityReplayContext;
    const result = projectBlueprintImportProfileMappings([entry(6)], forgedContext);

    expect(result.state).toBe('blocked');
    expect(result.mappings).toEqual([]);
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        category: 'duplicate-endpoint',
        entityNumber: 6,
      }),
    );
  });

  test('propagates trusted resolver errors unchanged for stale, wrong-prototype, and wrong-database refs', () => {
    const trusted = context();
    const stale = {
      ...syntheticSharedTwoColorEntityProfile.ref,
      profileId: 'profile:missing-v1',
    } as EntityProfileRef;
    const wrongPrototype = {
      ...syntheticSharedTwoColorEntityProfile.ref,
      prototypeKey: 'entity:other',
    };
    const wrongDatabase = {
      ...syntheticSharedTwoColorEntityProfile.ref,
      database: {
        ...syntheticSharedTwoColorEntityProfile.ref.database,
        identity: 'database:other',
      },
    };

    for (const [reference, expected] of [
      [stale, { code: 'ER1002', path: '$.profileId' }],
      [wrongPrototype, { code: 'ER1001', path: '$.prototypeKey' }],
      [wrongDatabase, { code: 'ER1001', path: '$.database' }],
    ] as const) {
      try {
        projectBlueprintImportProfileMappings([entry(1, reference)], trusted);
        throw new Error('Expected profile resolution to reject this reference.');
      } catch (error) {
        expect(error).toBeInstanceOf(EntityReplayContextError);
        expect(error).toMatchObject({ name: 'EntityReplayContextError', ...expected });
      }
    }
  });

  test('validates exact entry rows, uniqueness, options, and the entry-count budget first', () => {
    const trusted = context([syntheticZeroPortEntityProfile]);

    expect(() => projectBlueprintImportProfileMappings([entry(0)], trusted)).toThrow(TypeError);
    expect(() => projectBlueprintImportProfileMappings([entry(1), entry(1)], trusted)).toThrow(
      /duplicate/i,
    );
    expect(() =>
      projectBlueprintImportProfileMappings(
        [{ ...entry(1, syntheticZeroPortEntityProfile.ref), extra: true } as never],
        trusted,
      ),
    ).toThrow(TypeError);
    const accessorEntry = Object.defineProperty({ entityNumber: 1 }, 'profile', {
      enumerable: true,
      get: () => syntheticZeroPortEntityProfile.ref,
    });
    expect(() => projectBlueprintImportProfileMappings([accessorEntry as never], trusted)).toThrow(
      TypeError,
    );
    expect(() => projectBlueprintImportProfileMappings([], trusted, { maxEndpoints: 0 })).toThrow(
      RangeError,
    );
    expect(() =>
      projectBlueprintImportProfileMappings([], trusted, { unknown: true } as never),
    ).toThrow(TypeError);
    expect(() =>
      projectBlueprintImportProfileMappings(
        [entry(1, {} as EntityProfileRef), entry(2, {} as EntityProfileRef)],
        trusted,
        { maxEndpoints: 1 },
      ),
    ).toThrow(RangeError);
  });

  test('bounds total declared lanes, including lanes without native mappings', () => {
    const incomplete = editableSharedProfile();
    delete incomplete.connectors[0]!.lanes[0]!.nativeEndpoint;
    delete incomplete.connectors[0]!.lanes[1]!.nativeEndpoint;
    const profile = incomplete as EntityProfile;

    expect(() =>
      projectBlueprintImportProfileMappings([entry(1, profile.ref)], context([profile]), {
        maxEndpoints: 1,
      }),
    ).toThrow(RangeError);
  });

  test('supports exact endpoint budget and reports pre-abort as AbortError', () => {
    const trusted = context();
    expect(() =>
      projectBlueprintImportProfileMappings([entry(1)], trusted, { maxEndpoints: 2 }),
    ).not.toThrow();

    const controller = new AbortController();
    controller.abort();
    expect(() =>
      projectBlueprintImportProfileMappings([entry(1)], trusted, { signal: controller.signal }),
    ).toThrowError(expect.objectContaining({ name: 'AbortError' }));
  });

  test('observes cancellation inside synchronous entry/profile iteration', () => {
    const trusted = context();
    let reads = 0;
    const signal = {
      get aborted() {
        reads += 1;
        return reads >= 5;
      },
    } as AbortSignal;

    expect(() =>
      projectBlueprintImportProfileMappings([entry(1), entry(2)], trusted, { signal }),
    ).toThrowError(expect.objectContaining({ name: 'AbortError' }));
    expect(reads).toBeGreaterThanOrEqual(5);
  });

  test('freezes detached rows and stays private to the compiler package boundary', async () => {
    const trusted = context();
    const before = JSON.stringify(trusted);
    const result = projectBlueprintImportProfileMappings([entry(7)], trusted);
    const packageJson = JSON.parse(
      await readFile(new URL('../package.json', import.meta.url), 'utf8'),
    ) as { exports: Record<string, string>; dependencies: Record<string, string> };
    const indexText = await readFile(new URL('./index.ts', import.meta.url), 'utf8');

    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.mappings)).toBe(true);
    expect(result.mappings.every((mapping) => Object.isFrozen(mapping))).toBe(true);
    expect(Object.isFrozen(result.diagnostics)).toBe(true);
    expect(JSON.stringify(trusted)).toBe(before);
    expect(publicCompiler).not.toHaveProperty('projectBlueprintImportProfileMappings');
    expect(indexText).not.toContain('blueprint-import-profile-mappings');
    expect(Object.values(packageJson.exports)).not.toContain(
      './src/blueprint-import-profile-mappings.ts',
    );
    expect(packageJson.dependencies['@comblang/blueprint']).toBe('0.0.0');
  });
});

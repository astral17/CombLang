import { describe, expect, test } from 'vitest';

import { classifyBlueprintDocument } from '@comblang/blueprint/classification';
import { parseLosslessJson, stringifyLosslessJson } from '@comblang/blueprint/document';
import {
  analyzeBlueprintImport,
  type BlueprintImportAnalysis,
} from '@comblang/blueprint/import-analysis';

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
import {
  analyzeProfiledBlueprintImport,
  type ProfiledBlueprintImportResult,
} from './blueprint-import-analysis.js';

type MutableProfile = Record<string, any>;

function sharedProfile(
  prototype: string,
  profileId: string,
  secondConnector = false,
): EntityProfile {
  const profile = JSON.parse(
    JSON.stringify(syntheticSharedTwoColorEntityProfile),
  ) as MutableProfile;
  profile.ref.prototypeKey = `entity:${prototype}`;
  profile.ref.profileId = profileId;
  if (secondConnector) {
    profile.connectors.push({
      key: 'auxiliary',
      direction: 'bidirectional',
      lanes: (['red', 'green'] as const).map((color) => ({
        key: `aux-${color}`,
        color,
        nativeEndpoint: {
          endpoint: { connector: 'auxiliary', lane: `aux-${color}`, color },
          nativeConnector: 2,
        },
      })),
    });
  }
  return profile as EntityProfile;
}

function profileWith(
  profile: EntityProfile,
  mutate: (editable: MutableProfile) => void,
): EntityProfile {
  const editable = JSON.parse(JSON.stringify(profile)) as MutableProfile;
  mutate(editable);
  return editable as EntityProfile;
}

function context(...profiles: EntityProfile[]): TrustedEntityReplayContext {
  return createTrustedEntityReplayContext({
    database: syntheticZeroPortEntityProfile.ref.database,
    source: 'synthetic',
    evidenceIdentity: 'comblang-synthetic-blueprint-import-evidence-v1',
    policyIdentity: 'comblang-blueprint-import-policy-v1',
    profiles,
  });
}

function selection(entityNumber: number, profile: EntityProfileRef) {
  return { entityNumber, profile };
}

function analyze(source: string): BlueprintImportAnalysis {
  return analyzeBlueprintImport(classifyBlueprintDocument(parseLosslessJson(source)));
}

function document(
  entities: readonly { readonly entityNumber: number; readonly name: string }[],
  wires: readonly (readonly number[])[] = [],
): string {
  return JSON.stringify({
    blueprint: {
      entities: entities.map(({ entityNumber, ...entity }) => ({
        entity_number: entityNumber,
        ...entity,
      })),
      wires,
    },
  });
}

function namedAnalysis(...names: string[]): BlueprintImportAnalysis {
  return analyze(document(names.map((name, index) => ({ entityNumber: index + 1, name }))));
}

function expectBlocked(result: ProfiledBlueprintImportResult): void {
  expect(result.state).toBe('blocked');
  expect(result.components).toEqual([]);
}

describe('profiled blueprint import composition', () => {
  test('composes explicit red/green profile mappings into stable components and isolated lanes', () => {
    const firstProfile = sharedProfile('synthetic-a', 'profile:blueprint-a-v1', true);
    const secondProfile = sharedProfile('synthetic-b', 'profile:blueprint-b-v1', true);
    const trusted = context(firstProfile, secondProfile);
    const source = document(
      [
        { entityNumber: 10, name: 'synthetic-a' },
        { entityNumber: 20, name: 'synthetic-b' },
      ],
      [
        [10, 1, 20, 1],
        [20, 2, 10, 2],
      ],
    );
    const analysis = analyze(source);
    const before = stringifyLosslessJson(analysis.document);
    const forward = analyzeProfiledBlueprintImport(
      analysis,
      [selection(10, firstProfile.ref), selection(20, secondProfile.ref)],
      trusted,
    );

    const permutedAnalysis = analyze(
      document(
        [
          { entityNumber: 20, name: 'synthetic-b' },
          { entityNumber: 10, name: 'synthetic-a' },
        ],
        [
          [10, 2, 20, 2],
          [20, 1, 10, 1],
        ],
      ),
    );
    const reverse = analyzeProfiledBlueprintImport(
      permutedAnalysis,
      [selection(20, secondProfile.ref), selection(10, firstProfile.ref)],
      trusted,
    );

    expect(forward.state).toBe('complete');
    expect(forward.analysis).toBe(analysis);
    expect(forward.components).toEqual(reverse.components);
    expect(forward.components).toEqual([
      {
        color: 'red',
        endpoints: [
          { entityNumber: 10, connectorId: 1 },
          { entityNumber: 20, connectorId: 1 },
        ],
      },
      { color: 'red', endpoints: [{ entityNumber: 10, connectorId: 3 }] },
      { color: 'red', endpoints: [{ entityNumber: 20, connectorId: 3 }] },
      {
        color: 'green',
        endpoints: [
          { entityNumber: 10, connectorId: 2 },
          { entityNumber: 20, connectorId: 2 },
        ],
      },
      { color: 'green', endpoints: [{ entityNumber: 10, connectorId: 4 }] },
      { color: 'green', endpoints: [{ entityNumber: 20, connectorId: 4 }] },
    ]);
    expect(forward.diagnostics).toEqual([]);
    expect(stringifyLosslessJson(analysis.document)).toBe(before);
    expect(forward).not.toHaveProperty('profiles');
    expect(forward).not.toHaveProperty('context');
    expect(forward).not.toHaveProperty('mappings');
  });

  test('blocks every component when an unwired imported entity has no profile selection', () => {
    const a = profileWith(
      sharedProfile('synthetic-a', 'profile:missing-selection-a-v1'),
      (profile) => {
        profile.connectorStructure = 'unknown';
      },
    );
    const analysis = namedAnalysis('synthetic-a', 'synthetic-b');
    const result = analyzeProfiledBlueprintImport(analysis, [selection(1, a.ref)], context(a));

    expectBlocked(result);
    expect(result.diagnostics).toMatchObject([
      { category: 'unknown-connector-structure', entityNumber: 1 },
      {
        category: 'missing-profile-selection',
        path: '$.blueprint.entities[1].name',
        entityNumber: 2,
      },
    ]);
  });

  test('blocks a context-valid profile selected for the wrong document prototype', () => {
    const a = sharedProfile('synthetic-a', 'profile:wrong-prototype-a-v1');
    const b = sharedProfile('synthetic-b', 'profile:wrong-prototype-b-v1');
    const result = analyzeProfiledBlueprintImport(
      namedAnalysis('synthetic-a'),
      [selection(1, b.ref)],
      context(a, b),
    );

    expectBlocked(result);
    expect(result.diagnostics).toMatchObject([
      {
        category: 'profile-prototype-mismatch',
        path: '$.blueprint.entities[0].name',
        relatedPath: '$.entries[0].profile.prototypeKey',
        entityNumber: 1,
      },
    ]);
  });

  test('rejects duplicate and out-of-inventory selections as input errors', () => {
    const a = sharedProfile('synthetic-a', 'profile:extra-selection-a-v1');
    const analysis = namedAnalysis('synthetic-a');
    const trusted = context(a);

    expect(() =>
      analyzeProfiledBlueprintImport(analysis, [selection(1, a.ref), selection(1, a.ref)], trusted),
    ).toThrow(/duplicate/i);
    expect(() =>
      analyzeProfiledBlueprintImport(analysis, [selection(1, a.ref), selection(2, a.ref)], trusted),
    ).toThrow(/absent from the inventory/i);
  });

  test('propagates stale profile resolver errors without converting them to coverage', () => {
    const a = sharedProfile('synthetic-a', 'profile:stale-selection-a-v1');
    const stale = { ...a.ref, profileId: 'profile:stale' } as EntityProfileRef;

    expect(() =>
      analyzeProfiledBlueprintImport(
        namedAnalysis('synthetic-a'),
        [selection(1, stale)],
        context(a),
      ),
    ).toThrow(EntityReplayContextError);
  });

  test('retains opaque, partial, legacy, and dangling analysis diagnostics before profile resolution', () => {
    const trusted = context(syntheticZeroPortEntityProfile);
    const invalidSelection = selection(999, {} as EntityProfileRef);
    const analyses = [
      analyze('{"blueprint_book":{"blueprints":[]}}'),
      analyze('{"blueprint":{"entities":[{"entity_number":1,"name":"x","connections":{}}]}}'),
      analyze(document([{ entityNumber: 1, name: 'x' }], [[1, 1, 99, 2]])),
    ];

    for (const analysis of analyses) {
      const result = analyzeProfiledBlueprintImport(analysis, [invalidSelection], trusted);
      expectBlocked(result);
      const originalIssues = [...analysis.diagnostics, ...analysis.coverage];
      expect(originalIssues.length).toBeGreaterThan(0);
      for (const issue of originalIssues) expect(result.diagnostics).toContain(issue);
      expect(result.diagnostics[0]).toBe(originalIssues[0]);
    }
  });

  test('retains mapper diagnostics and suppresses subsets for unknown or unmapped profile endpoints', () => {
    const unknown = profileWith(
      sharedProfile('synthetic-a', 'profile:unknown-connectors-v1'),
      (profile) => {
        profile.connectorStructure = 'unknown';
      },
    );
    const unknownResult = analyzeProfiledBlueprintImport(
      namedAnalysis('synthetic-a'),
      [selection(1, unknown.ref)],
      context(unknown),
    );
    expectBlocked(unknownResult);
    expect(unknownResult.diagnostics[0]).toMatchObject({
      category: 'unknown-connector-structure',
      entityNumber: 1,
    });

    const missing = profileWith(
      sharedProfile('synthetic-a', 'profile:missing-native-endpoint-v1'),
      (profile) => {
        delete profile.connectors[0].lanes[0].nativeEndpoint;
      },
    );
    const missingResult = analyzeProfiledBlueprintImport(
      namedAnalysis('synthetic-a'),
      [selection(1, missing.ref)],
      context(missing),
    );
    expectBlocked(missingResult);
    expect(missingResult.diagnostics[0]).toMatchObject({
      category: 'missing-native-endpoint',
      entityNumber: 1,
    });
  });

  test('blocks complete zero-port and unmapped bridge wires without publishing endpoint subsets', () => {
    const a = sharedProfile('synthetic-a', 'profile:zero-port-wire-a-v1');
    const zeroPortResult = analyzeProfiledBlueprintImport(
      analyze(
        document(
          [
            { entityNumber: 1, name: 'synthetic-a' },
            { entityNumber: 2, name: 'synthetic-zero-port' },
          ],
          [[1, 1, 2, 1]],
        ),
      ),
      [selection(1, a.ref), selection(2, syntheticZeroPortEntityProfile.ref)],
      context(a, syntheticZeroPortEntityProfile),
    );
    expectBlocked(zeroPortResult);
    expect(zeroPortResult.diagnostics).toContainEqual(
      expect.objectContaining({ category: 'unresolved-endpoint', path: '$.blueprint.wires[0][3]' }),
    );

    const c = sharedProfile('synthetic-c', 'profile:bridge-c-v1');
    const bridgeResult = analyzeProfiledBlueprintImport(
      analyze(
        document(
          [
            { entityNumber: 1, name: 'synthetic-a' },
            { entityNumber: 2, name: 'synthetic-zero-port' },
            { entityNumber: 3, name: 'synthetic-c' },
          ],
          [
            [1, 1, 2, 1],
            [2, 1, 3, 1],
          ],
        ),
      ),
      [selection(1, a.ref), selection(2, syntheticZeroPortEntityProfile.ref), selection(3, c.ref)],
      context(a, syntheticZeroPortEntityProfile, c),
    );
    expectBlocked(bridgeResult);
    expect(bridgeResult.diagnostics).toHaveLength(2);
    expect(
      bridgeResult.diagnostics.every((entry) => entry.category === 'unresolved-endpoint'),
    ).toBe(true);
  });

  test('freezes only detached wrappers and preserves lossless source and trusted context', () => {
    const a = sharedProfile('synthetic-a', 'profile:preservation-a-v1');
    const trusted = context(a);
    const source =
      '{"blueprint":{"entities":[{"entity_number":1,"name":"synthetic-a",' +
      '"future":9007199254740993}],"wires":[],"parameters":{"ratio":1.2300}}}';
    const analysis = analyze(source);
    const contextBefore = JSON.stringify(trusted);
    const result = analyzeProfiledBlueprintImport(analysis, [selection(1, a.ref)], trusted);

    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.diagnostics)).toBe(true);
    expect(result.components).toHaveLength(2);
    expect(Object.isFrozen(result.components)).toBe(true);
    expect(result.components.every((component) => Object.isFrozen(component))).toBe(true);
    expect(result.analysis).toBe(analysis);
    expect(stringifyLosslessJson(analysis.document)).toBe(source);
    expect(JSON.stringify(trusted)).toBe(contextBefore);
  });

  test('forwards lane budgets and pre-abort behavior, and checks cancellation in adapter loops', () => {
    const a = sharedProfile('synthetic-a', 'profile:budget-a-v1');
    const trusted = context(a);
    const analysis = namedAnalysis('synthetic-a');
    expect(() =>
      analyzeProfiledBlueprintImport(analysis, [selection(1, a.ref)], trusted, {
        maxEndpoints: 2,
      }),
    ).not.toThrow();
    expect(() =>
      analyzeProfiledBlueprintImport(analysis, [selection(1, a.ref)], trusted, {
        maxEndpoints: 1,
      }),
    ).toThrow(RangeError);

    const aborted = new AbortController();
    aborted.abort();
    expect(() =>
      analyzeProfiledBlueprintImport(analysis, [selection(1, a.ref)], trusted, {
        signal: aborted.signal,
      }),
    ).toThrowError(expect.objectContaining({ name: 'AbortError' }));

    let reads = 0;
    const signal = {
      get aborted() {
        reads += 1;
        return reads >= 10;
      },
    } as AbortSignal;
    const zeroContext = context(syntheticZeroPortEntityProfile);
    expect(() =>
      analyzeProfiledBlueprintImport(
        namedAnalysis('synthetic-zero-port', 'synthetic-zero-port'),
        [
          selection(1, syntheticZeroPortEntityProfile.ref),
          selection(2, syntheticZeroPortEntityProfile.ref),
        ],
        zeroContext,
        { signal },
      ),
    ).toThrowError(expect.objectContaining({ name: 'AbortError' }));
    expect(reads).toBe(10);
  });

  test('keeps the adapter and profile mapper private to compiler exports', async () => {
    const { readFile } = await import('node:fs/promises');
    const manifest = JSON.parse(
      await readFile(new URL('../package.json', import.meta.url), 'utf8'),
    ) as { exports: Record<string, string>; dependencies: Record<string, string> };
    const barrel = await readFile(new URL('./index.ts', import.meta.url), 'utf8');

    expect(manifest.dependencies['@comblang/blueprint']).toBe('0.0.0');
    expect(Object.values(manifest.exports)).not.toContain('./src/blueprint-import-analysis.ts');
    expect(barrel).not.toContain('blueprint-import-analysis');
    expect(barrel).not.toContain('blueprint-import-profile-mappings');
  });
});

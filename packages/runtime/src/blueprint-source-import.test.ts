import { DEFAULT_BLUEPRINT_CODEC_LIMITS } from '@comblang/blueprint';
import {
  createTrustedEntityReplayContext,
  syntheticZeroPortEntityProfile,
} from '@comblang/compiler';
import type { EntityProfile, EntityProfileId } from '@comblang/compiler/entity';
import { loadPrototypeDatabase, syntheticPrototypeDatabase } from '@comblang/prototypes';
import type { Diagnostic } from '@comblang/shared';
import * as sourceCompilation from './source-compilation.js';
import { importCanonicalBlueprintSource } from './blueprint-source-import.js';

import { afterEach, describe, expect, test, vi } from 'vitest';

function arithmeticBehavior(
  signal: string,
  mask: { readonly red: boolean; readonly green: boolean },
) {
  return {
    arithmetic_conditions: {
      first_signal: { type: 'virtual', name: signal },
      first_signal_networks: mask,
      operation: '+',
      second_constant: 2,
      output_signal: { type: 'virtual', name: 'signal-B' },
    },
  };
}

function constantBehavior(multiplier = 0.5) {
  return {
    is_on: true,
    sections: {
      sections: [
        {
          index: 1,
          active: true,
          multiplier,
          filters: [
            {
              index: 1,
              name: 'signal-A',
              type: 'virtual',
              quality: 'normal',
              comparator: '=',
              count: 7,
            },
          ],
        },
      ],
    },
  };
}

function blueprintDocument(
  options: { readonly multiplier?: number; readonly metadata?: boolean } = {},
) {
  return JSON.stringify({
    blueprint: {
      ...(options.metadata ? { item: 'blueprint', label: 'imported label', version: 1 } : {}),
      entities: [
        {
          entity_number: 12,
          name: 'arithmetic-combinator',
          position: { x: 0, y: 4 },
          direction: 4,
          control_behavior: {
            arithmetic_conditions: {
              first_signal: { type: 'virtual', name: 'signal-each' },
              first_signal_networks: { red: true, green: true },
              operation: '+',
              second_constant: 2,
              output_signal: { type: 'virtual', name: 'signal-each' },
            },
          },
        },
        {
          entity_number: 400,
          name: 'constant-combinator',
          position: { x: 8, y: -1 },
          direction: 15,
          control_behavior: constantBehavior(options.multiplier ?? 0.5),
        },
        {
          entity_number: 11,
          name: 'arithmetic-combinator',
          position: { x: -2, y: 1 },
          direction: 0,
          control_behavior: arithmeticBehavior('signal-A', { red: true, green: false }),
        },
        {
          entity_number: 13,
          name: 'constant-combinator',
          position: { x: 7, y: 6 },
          direction: 8,
          control_behavior: constantBehavior(),
        },
      ],
      wires: [
        [400, 1, 11, 1],
        [400, 1, 12, 1],
        [12, 3, 12, 1],
        [12, 4, 12, 2],
      ],
    },
  });
}

function constantDocument(name = 'constant-combinator') {
  return JSON.stringify({
    blueprint: {
      entities: [
        {
          entity_number: 1,
          name,
          position: { x: 0, y: 0 },
          direction: 0,
          control_behavior: constantBehavior(),
        },
      ],
      wires: [],
    },
  });
}

async function canonicalHost() {
  const database = structuredClone(syntheticPrototypeDatabase()) as {
    entities: Array<Record<string, unknown>>;
  };
  const families = ['constant-combinator', 'arithmetic-combinator'] as const;
  database.entities.push(
    ...families.map((family) => ({
      key: `entity:${family}`,
      name: family,
      type: family,
      blueprintEligible: true,
      tileWidth: 1,
      tileHeight: 1,
      circuit: {
        read: false,
        enableDisable: false,
        readContents: false,
        setFilters: false,
        setRequests: false,
        setRecipe: false,
        readRecipe: false,
        readFinishedCraft: false,
        outputSignals: false,
      },
    })),
  );
  const { prototypes } = await loadPrototypeDatabase(database);
  const databaseRef = { schemaVersion: prototypes.schemaVersion, identity: prototypes.identity };
  const profiles = families.map((family, index): EntityProfile => ({
    ...structuredClone(syntheticZeroPortEntityProfile),
    ref: {
      ...syntheticZeroPortEntityProfile.ref,
      database: databaseRef,
      prototypeKey: `entity:${family}` as EntityProfile['ref']['prototypeKey'],
      profileId: `profile:blueprint-source-import-${index}` as EntityProfileId,
    },
    prototypeType: family,
  }));
  const trustedEntityReplayContext = createTrustedEntityReplayContext({
    database: databaseRef,
    source: 'synthetic',
    evidenceIdentity: 'blueprint-source-import-runtime-test-evidence',
    policyIdentity: 'blueprint-source-import-runtime-test-policy',
    profiles,
  });
  return {
    profiles,
    trustedEntityReplayContext,
    environment: { prototypes, trustedEntityReplayContext },
  };
}

const host = await canonicalHost();

afterEach(() => vi.restoreAllMocks());

describe('host-neutral canonical blueprint source import', () => {
  test('assembles, compiles exactly once, and verifies the exact source snapshot', () => {
    const text = blueprintDocument({ metadata: true });
    const compile = vi.spyOn(sourceCompilation, 'compileSourceProgram');
    const result = importCanonicalBlueprintSource(
      text,
      { path: 'synthetic/import.factorio.ts' },
      host.environment,
    );

    expect(result.state).toBe('verified');
    if (result.state !== 'verified') throw new Error('expected verified source');
    expect(compile).toHaveBeenCalledTimes(1);
    expect(compile.mock.calls[0]?.[0]).toBe(result.source);
    expect(result.source.path).toBe('synthetic/import.factorio.ts');
    expect(result.verification).toMatchObject({ state: 'verified', entityCount: 4 });
    expect(result.correspondence.entities.map(({ entityNumber }) => entityNumber)).toEqual([
      12, 400, 11, 13,
    ]);
    const warnings = compile.mock.results[0]?.value.pipelineDiagnostics.filter(
      (diagnostic: Diagnostic) => diagnostic.severity === 'warning',
    );
    expect(result.diagnostics.filter((diagnostic) => 'severity' in diagnostic)).toEqual(warnings);
    expect(
      result.diagnostics.some((diagnostic) => 'code' in diagnostic && diagnostic.code === 'CL2001'),
    ).toBe(true);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.source)).toBe(true);
    expect(Object.isFrozen(result.correspondence)).toBe(true);
    expect(Object.isFrozen(result.correspondence.entities)).toBe(true);
    expect(Object.isFrozen(result.diagnostics)).toBe(true);
    expect(result.diagnostics.every(Object.isFrozen)).toBe(true);
  });

  test('requires trusted authority for empty blueprints and accepts an authorized empty import', () => {
    const text = '{"blueprint":{"entities":[],"wires":[]}}';
    const refused = importCanonicalBlueprintSource(text, { path: 'empty.ts' }, {});
    expect(refused).toMatchObject({
      state: 'blocked',
      diagnostics: [expect.objectContaining({ category: 'missing-trusted-context' })],
    });
    expect(refused).not.toHaveProperty('source');
    expect(refused).not.toHaveProperty('correspondence');

    const allowed = importCanonicalBlueprintSource(text, { path: 'empty.ts' }, host.environment);
    expect(allowed.state).toBe('verified');
    if (allowed.state === 'verified') {
      expect(allowed.verification).toMatchObject({ state: 'verified', entityCount: 0 });
    }
  });

  test('preserves typed document errors, rejects UTF-8 byte overflow, and validates the source path', () => {
    expect(() => importCanonicalBlueprintSource('{', { path: 'bad.ts' }, host.environment)).toThrow(
      expect.objectContaining({ code: 'BPD1001', path: '$' }),
    );
    const overBudgetNonAscii = 'é'.repeat(
      Math.floor(DEFAULT_BLUEPRINT_CODEC_LIMITS.maxDecompressedBytes / 2) + 1,
    );
    expect(overBudgetNonAscii.length).toBeLessThan(
      DEFAULT_BLUEPRINT_CODEC_LIMITS.maxDecompressedBytes,
    );
    expect(() =>
      importCanonicalBlueprintSource(overBudgetNonAscii, { path: 'large.ts' }, host.environment),
    ).toThrow(expect.objectContaining({ code: 'BPD1004', path: '$' }));
    expect(() => importCanonicalBlueprintSource('{}', { path: '   ' }, host.environment)).toThrow(
      'path must be a nonempty string without NUL.',
    );
    expect(() =>
      importCanonicalBlueprintSource('{}', { path: 'bad\0.ts' }, host.environment),
    ).toThrow('path must be a nonempty string without NUL.');
  });

  test('refuses unsupported roots, unknown outer fields, duplicate IDs, and dangling wires', () => {
    const unsupported = importCanonicalBlueprintSource(
      '{"blueprint_book":{}}',
      { path: 'book.ts' },
      host.environment,
    );
    expect(unsupported).toMatchObject({
      state: 'blocked',
      diagnostics: [
        expect.objectContaining({ category: 'unsupported-root', path: '$.blueprint_book' }),
      ],
    });

    const unknown = importCanonicalBlueprintSource(
      '{"blueprint":{"entities":[],"wires":[],"extra":true}}',
      { path: 'outer.ts' },
      host.environment,
    );
    expect(unknown).toMatchObject({
      state: 'blocked',
      diagnostics: [
        expect.objectContaining({
          category: 'unsupported-source-field',
          path: '$.blueprint.extra',
        }),
      ],
    });

    const invalidInventory = importCanonicalBlueprintSource(
      JSON.stringify({
        blueprint: {
          entities: [
            { entity_number: 1, name: 'constant-combinator' },
            { entity_number: 1, name: 'constant-combinator' },
          ],
          wires: [[1, 1, 99, 1]],
        },
      }),
      { path: 'partial.ts' },
      host.environment,
    );
    expect(invalidInventory).toMatchObject({
      state: 'blocked',
      diagnostics: expect.arrayContaining([
        expect.objectContaining({ category: 'duplicate-entity-number' }),
        expect.objectContaining({ category: 'dangling-wire-reference' }),
      ]),
    });
  });

  test('selects one exact trusted profile and refuses missing, ambiguous, or modded profiles', () => {
    const missingContext = createTrustedEntityReplayContext({
      database: host.trustedEntityReplayContext.database,
      source: 'synthetic',
      evidenceIdentity: 'missing-blueprint-import-profile',
      policyIdentity: 'missing-blueprint-import-profile-policy',
      profiles: [host.profiles[1]!],
    });
    const missing = importCanonicalBlueprintSource(
      constantDocument(),
      { path: 'missing.ts' },
      {
        ...host.environment,
        trustedEntityReplayContext: missingContext,
      },
    );
    expect(missing).toMatchObject({
      state: 'blocked',
      diagnostics: [
        expect.objectContaining({
          category: 'missing-profile-selection',
          path: '$.blueprint.entities[0].name',
        }),
      ],
    });

    const duplicateProfile: EntityProfile = {
      ...host.profiles[0]!,
      ref: {
        ...host.profiles[0]!.ref,
        profileId: 'profile:duplicate-blueprint-import' as EntityProfileId,
      },
    };
    const ambiguousContext = createTrustedEntityReplayContext({
      database: host.trustedEntityReplayContext.database,
      source: 'synthetic',
      evidenceIdentity: 'ambiguous-blueprint-import-profile',
      policyIdentity: 'ambiguous-blueprint-import-profile-policy',
      profiles: [...host.profiles, duplicateProfile],
    });
    const ambiguous = importCanonicalBlueprintSource(
      constantDocument(),
      { path: 'ambiguous.ts' },
      {
        ...host.environment,
        trustedEntityReplayContext: ambiguousContext,
      },
    );
    expect(ambiguous).toMatchObject({
      state: 'blocked',
      diagnostics: [expect.objectContaining({ category: 'ambiguous-canonical-profile' })],
    });

    const moddedName = 'modded-constant-combinator';
    const moddedProfile: EntityProfile = {
      ...host.profiles[0]!,
      ref: {
        ...host.profiles[0]!.ref,
        prototypeKey: `entity:${moddedName}` as EntityProfile['ref']['prototypeKey'],
        profileId: 'profile:modded-blueprint-import' as EntityProfileId,
      },
    };
    const moddedContext = createTrustedEntityReplayContext({
      database: host.trustedEntityReplayContext.database,
      source: 'synthetic',
      evidenceIdentity: 'modded-blueprint-import-profile',
      policyIdentity: 'modded-blueprint-import-profile-policy',
      profiles: [moddedProfile],
    });
    const modded = importCanonicalBlueprintSource(
      constantDocument(moddedName),
      { path: 'modded.ts' },
      { ...host.environment, trustedEntityReplayContext: moddedContext },
    );
    expect(modded).toMatchObject({
      state: 'blocked',
      diagnostics: [expect.objectContaining({ category: 'unsupported-canonical-family' })],
    });
  });

  test('blocks assembly refusals and preserves negative-zero verifier locations', () => {
    const unsupportedField = importCanonicalBlueprintSource(
      JSON.stringify({
        blueprint: {
          entities: [
            {
              entity_number: 1,
              name: 'constant-combinator',
              position: { x: 0, y: 0 },
              direction: 0,
              control_behavior: constantBehavior(),
              unsupported_extra: true,
            },
          ],
          wires: [],
        },
      }),
      { path: 'assembly-blocked.ts' },
      host.environment,
    );
    expect(unsupportedField).toMatchObject({
      state: 'blocked',
      diagnostics: [expect.objectContaining({ category: 'unsupported-source-field' })],
    });
    expect(unsupportedField).not.toHaveProperty('diagnosticContext');

    const negativeZero = blueprintDocument().replace('"multiplier":0.5,', '"multiplier":-0,');
    const refused = importCanonicalBlueprintSource(
      negativeZero,
      { path: 'negative-zero.ts' },
      host.environment,
    );
    expect(refused).toMatchObject({
      state: 'blocked',
      diagnostics: expect.arrayContaining([
        expect.objectContaining({
          category: 'source-verification-mismatch',
          path: '$.blueprint.entities[1]',
          source: expect.objectContaining({ start: expect.any(Number), end: expect.any(Number) }),
        }),
      ]),
      diagnosticContext: {
        path: 'negative-zero.ts',
        text: expect.any(String),
        fileId: expect.any(String),
      },
    });
    expect(refused).not.toHaveProperty('source');
    expect(refused).not.toHaveProperty('correspondence');
    expect(JSON.stringify(refused)).not.toContain('resolvedCircuit');
  });

  test('withholds usable output when compilation errors or artifacts are missing', () => {
    const compile = sourceCompilation.compileSourceProgram;
    vi.spyOn(sourceCompilation, 'compileSourceProgram').mockImplementationOnce(
      (source, environment) => {
        const actual = compile(source, environment);
        return {
          ...actual,
          pipelineDiagnostics: Object.freeze([
            ...actual.pipelineDiagnostics,
            Object.freeze({
              code: 'SYNTHETIC',
              severity: 'error',
              message: 'synthetic compile refusal',
            }),
          ]),
        };
      },
    );
    const compileRefusal = importCanonicalBlueprintSource(
      blueprintDocument(),
      { path: 'compile-error.ts' },
      host.environment,
    );
    expect(compileRefusal).toMatchObject({
      state: 'blocked',
      diagnostics: expect.arrayContaining([
        expect.objectContaining({ code: 'SYNTHETIC', severity: 'error' }),
      ]),
      diagnosticContext: { path: 'compile-error.ts' },
    });
    expect(compileRefusal).not.toHaveProperty('source');
    expect(compileRefusal).not.toHaveProperty('correspondence');
    vi.restoreAllMocks();

    vi.spyOn(sourceCompilation, 'compileSourceProgram').mockImplementationOnce(
      (source, environment) => {
        const actual = compile(source, environment);
        const { plan: _plan, ...withoutPlan } = actual;
        return withoutPlan;
      },
    );
    const missingArtifacts = importCanonicalBlueprintSource(
      blueprintDocument(),
      { path: 'missing-artifact.ts' },
      host.environment,
    );
    expect(missingArtifacts).toMatchObject({
      state: 'blocked',
      diagnostics: expect.arrayContaining([
        expect.objectContaining({ category: 'source-verification-mismatch' }),
      ]),
    });
    expect(missingArtifacts).not.toHaveProperty('source');
    expect(missingArtifacts).not.toHaveProperty('correspondence');
  });

  test('returns cloneable detached snapshots without host compilation state', () => {
    const environment = { ...host.environment };
    const originalContext = environment.trustedEntityReplayContext;
    const sourcePath = { path: 'cloneable.ts' };
    const result = importCanonicalBlueprintSource(blueprintDocument(), sourcePath, environment);
    expect(result.state).toBe('verified');
    expect(structuredClone(result)).toEqual(result);
    expect(Object.keys(result)).toEqual([
      'state',
      'source',
      'correspondence',
      'diagnostics',
      'diagnosticContext',
      'verification',
    ]);
    expect(environment.trustedEntityReplayContext).toBe(originalContext);
    expect(Object.isFrozen(environment)).toBe(false);
    expect(Object.isFrozen(sourcePath)).toBe(false);
    expect(sourcePath.path).toBe('cloneable.ts');
    expect(Object.isFrozen(result.diagnosticContext)).toBe(true);
    expect(result).not.toHaveProperty('analysis');
    expect(result).not.toHaveProperty('document');
    expect(result).not.toHaveProperty('execution');
    expect(result).not.toHaveProperty('trustedEntityReplayContext');

    const blocked = importCanonicalBlueprintSource(
      blueprintDocument().replace('"multiplier":0.5,', '"multiplier":-0,'),
      { path: 'blocked-clone.ts' },
      host.environment,
    );
    expect(blocked.state).toBe('blocked');
    expect(structuredClone(blocked)).toEqual(blocked);
    expect(Object.keys(blocked)).toEqual(['state', 'diagnostics', 'diagnosticContext']);
    const mismatch = blocked.diagnostics.find(
      (diagnostic) =>
        'category' in diagnostic && diagnostic.category === 'source-verification-mismatch',
    );
    if (mismatch === undefined || !('source' in mismatch) || mismatch.source === undefined) {
      throw new Error('expected a source-located verifier mismatch');
    }
    expect(Object.isFrozen(blocked.diagnostics)).toBe(true);
    expect(Object.isFrozen(mismatch)).toBe(true);
    expect(Object.isFrozen(mismatch.source)).toBe(true);
  });
});

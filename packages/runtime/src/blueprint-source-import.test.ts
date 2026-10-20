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

// Derived from a Factorio 2.1.23 re-export of a generated numeric-parameter probe.
// Keep two contiguous Constant rows and omitted default flags/multiplier; remove
// parameter/presentation metadata and relocate the device to isolate concrete import.
function nativeOmittedConstantDefaultsDocument() {
  return JSON.stringify({
    blueprint: {
      entities: [
        {
          entity_number: 73,
          name: 'constant-combinator',
          position: { x: 2.5, y: -1.5 },
          direction: 4,
          control_behavior: {
            sections: {
              sections: [
                {
                  index: 1,
                  filters: [
                    {
                      index: 1,
                      name: 'signal-A',
                      type: 'virtual',
                      quality: 'normal',
                      comparator: '=',
                      count: 16,
                    },
                    {
                      index: 2,
                      name: 'signal-B',
                      type: 'virtual',
                      quality: 'normal',
                      comparator: '=',
                      count: 2,
                    },
                  ],
                },
              ],
            },
          },
        },
      ],
      wires: [],
    },
  });
}

function selectorDocument() {
  return JSON.stringify({
    blueprint: {
      entities: [
        {
          entity_number: 10,
          name: 'selector-combinator',
          position: { x: 0, y: 0 },
          direction: 0,
          control_behavior: {
            operation: 'select',
            select_max: true,
            index_signal: { type: 'virtual', name: 'signal-index', quality: 'rare' },
          },
        },
        {
          entity_number: 11,
          name: 'selector-combinator',
          position: { x: 3, y: 0 },
          direction: 0,
          control_behavior: {
            operation: 'count',
            count_signal: { type: 'item', name: 'iron-plate', quality: 'normal' },
          },
        },
        {
          entity_number: 12,
          name: 'selector-combinator',
          position: { x: 6, y: 0 },
          direction: 0,
          control_behavior: {
            operation: 'count',
            count_signal: { type: 'item', name: 'copper-plate', quality: 'normal' },
          },
        },
      ],
      wires: [[10, 3, 11, 1]],
    },
  });
}

function deciderDocument(
  options: { readonly implicitCopyInput?: boolean; readonly wiredUnreadInput?: boolean } = {},
) {
  return JSON.stringify({
    blueprint: {
      entities: [
        {
          entity_number: 42,
          name: 'decider-combinator',
          position: { x: 0, y: 0 },
          direction: 0,
          control_behavior: {
            decider_conditions: {
              conditions: [
                {
                  first_signal: { type: 'virtual', name: 'signal-A' },
                  first_signal_networks: { red: true, green: false },
                  comparator: '>',
                  constant: 0,
                  compare_type: 'and',
                },
              ],
              outputs: [
                {
                  signal: { type: 'virtual', name: 'signal-B' },
                  copy_count_from_input: true,
                  ...(options.implicitCopyInput ? {} : { networks: { red: true, green: false } }),
                },
              ],
            },
          },
        },
        ...(options.wiredUnreadInput
          ? [
              {
                entity_number: 7,
                name: 'constant-combinator',
                position: { x: 4, y: 0 },
                direction: 0,
                control_behavior: constantBehavior(),
              },
            ]
          : []),
      ],
      wires: [[42, 1, 42, 3], ...(options.wiredUnreadInput ? [[7, 2, 42, 2]] : [])],
    },
  });
}

function mixedFamilyDeciderDocument() {
  return JSON.stringify({
    blueprint: {
      entities: [
        {
          entity_number: 1,
          name: 'constant-combinator',
          position: { x: 0, y: 0 },
          direction: 4,
          control_behavior: constantBehavior(),
        },
        {
          entity_number: 2,
          name: 'arithmetic-combinator',
          position: { x: 3, y: 1 },
          direction: 8,
          control_behavior: arithmeticBehavior('signal-A', { red: true, green: false }),
        },
        {
          entity_number: 10,
          name: 'decider-combinator',
          position: { x: 7, y: 2 },
          direction: 12,
          control_behavior: {
            decider_conditions: {
              conditions: [
                {
                  first_signal: { type: 'virtual', name: 'signal-each' },
                  first_signal_networks: { red: true, green: true },
                  comparator: '>',
                  constant: 0,
                  compare_type: 'and',
                },
                {
                  first_signal: { type: 'virtual', name: 'signal-A', quality: 'rare' },
                  first_signal_networks: { red: true, green: false },
                  comparator: '≥',
                  second_signal: { type: 'virtual', name: 'signal-B', quality: 'uncommon' },
                  second_signal_networks: { red: false, green: true },
                  compare_type: 'or',
                },
              ],
              outputs: [
                {
                  signal: { type: 'virtual', name: 'signal-each' },
                  copy_count_from_input: true,
                  networks: { red: true, green: false },
                },
                {
                  signal: { type: 'virtual', name: 'signal-C' },
                  copy_count_from_input: false,
                  constant: 3,
                },
              ],
              else_outputs: [
                {
                  signal: { type: 'virtual', name: 'signal-D' },
                  copy_count_from_input: true,
                  networks: { red: false, green: true },
                },
                {
                  signal: { type: 'virtual', name: 'signal-E' },
                  copy_count_from_input: false,
                  constant: 5,
                },
              ],
            },
          },
        },
        {
          entity_number: 11,
          name: 'decider-combinator',
          position: { x: 12, y: 3 },
          direction: 0,
          control_behavior: {
            decider_conditions: {
              conditions: [
                {
                  first_signal: { type: 'virtual', name: 'signal-A' },
                  first_signal_networks: { red: false, green: true },
                  comparator: '>',
                  constant: 0,
                  compare_type: 'and',
                },
              ],
              outputs: [
                {
                  signal: { type: 'virtual', name: 'signal-B' },
                  copy_count_from_input: false,
                  constant: 1,
                },
              ],
            },
          },
        },
      ],
      wires: [
        [1, 1, 2, 1],
        [2, 3, 10, 1],
        [10, 3, 1, 1],
        [1, 2, 10, 2],
        [10, 4, 1, 2],
      ],
    },
  });
}

async function canonicalHost() {
  const database = structuredClone(syntheticPrototypeDatabase()) as {
    entities: Array<Record<string, unknown>>;
  };
  const families = [
    'constant-combinator',
    'arithmetic-combinator',
    'decider-combinator',
    'selector-combinator',
  ] as const;
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
  test('imports native Constant defaults omitted by Factorio and verifies the original device', () => {
    const compile = vi.spyOn(sourceCompilation, 'compileSourceProgram');
    const sourceText = nativeOmittedConstantDefaultsDocument();
    const result = importCanonicalBlueprintSource(
      sourceText,
      { path: 'native/constant-defaults.factorio.ts' },
      host.environment,
    );

    expect(result.state).toBe('verified');
    if (result.state !== 'verified') throw new Error('Expected verified native Constant source.');
    expect(compile).toHaveBeenCalledOnce();
    expect(compile.mock.calls[0]?.[0]).toEqual(result.source);
    expect(result.source.text).toContain('Constant({isOn:true,sections:[{active:true,multiplier:1');
    expect(result.source.text).toContain('Signal("virtual","signal-A","normal")');
    expect(result.source.text).toContain('value:16');
    expect(result.source.text).toContain('Signal("virtual","signal-B","normal")');
    expect(result.source.text).toContain('value:2');
    expect(result.source.text).toContain('.at(2.5,-1.5,4);');
    expect(result.verification).toEqual({ state: 'verified', entityCount: 1, networkCount: 2 });
    expect(result.correspondence.entities).toMatchObject([
      { entityNumber: 73, family: 'constant' },
    ]);
    expect(JSON.stringify(result)).not.toContain('trustedEntityReplayContext');

    const invalid = importCanonicalBlueprintSource(
      sourceText.replace('"index":1,"filters":', '"index":1,"active":null,"filters":'),
      { path: 'native/constant-invalid-active.factorio.ts' },
      host.environment,
    );
    expect(invalid).toMatchObject({
      state: 'blocked',
      diagnostics: [
        {
          category: 'unsupported-constant-configuration',
          path: '$.blueprint.entities[0].control_behavior.sections.sections[0].active',
        },
      ],
    });
    expect(invalid).not.toHaveProperty('source');
    expect(compile).toHaveBeenCalledOnce();
  });

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

  test('imports exact canonical Decider and still refuses unsupported entity families', () => {
    const compile = vi.spyOn(sourceCompilation, 'compileSourceProgram');
    const result = importCanonicalBlueprintSource(
      deciderDocument(),
      { path: 'synthetic/decider.factorio.ts' },
      host.environment,
    );

    expect(result.state).toBe('verified');
    if (result.state !== 'verified') throw new Error('expected canonical Decider source');
    expect(compile).toHaveBeenCalledOnce();
    expect(compile.mock.calls[0]?.[0]).toBe(result.source);
    expect(result.source.text).toContain('= Decider(');
    expect(result.correspondence.entities).toMatchObject([{ entityNumber: 42, family: 'decider' }]);
    expect(result.verification).toMatchObject({ state: 'verified', entityCount: 1 });

    const selector = importCanonicalBlueprintSource(
      constantDocument('programmable-speaker'),
      { path: 'synthetic/speaker.factorio.ts' },
      host.environment,
    );
    expect(selector).toMatchObject({
      state: 'blocked',
      diagnostics: [expect.objectContaining({ category: 'unsupported-canonical-family' })],
    });
    expect(selector).not.toHaveProperty('source');
    expect(selector).not.toHaveProperty('correspondence');
    expect(compile).toHaveBeenCalledOnce();
  });

  test('imports Select and Count through exact Selector profiles and verifies isolated input lanes', () => {
    const compile = vi.spyOn(sourceCompilation, 'compileSourceProgram');
    const result = importCanonicalBlueprintSource(
      selectorDocument(),
      { path: 'synthetic/selector.factorio.ts' },
      host.environment,
    );

    expect(result.state).toBe('verified');
    if (result.state !== 'verified') throw new Error('Expected verified Selector source.');
    expect(compile).toHaveBeenCalledOnce();
    expect(compile.mock.calls[0]?.[0]).toBe(result.source);
    expect(result.verification).toMatchObject({ state: 'verified', entityCount: 3 });
    expect(result.correspondence.entities).toMatchObject([
      { entityNumber: 10, family: 'selector' },
      { entityNumber: 11, family: 'selector', attachmentSpans: [] },
      { entityNumber: 12, family: 'selector', attachmentSpans: [] },
    ]);
    expect(result.source.text.match(/Selector\(/g)).toHaveLength(3);
    expect(result.source.text).toContain('signal-index');
    expect(result.source.text).toContain('iron-plate');
    expect(result.source.text).toContain('copper-plate');
    const unwiredCount = result.correspondence.entities.find(
      ({ entityNumber }) => entityNumber === 12,
    );
    if (unwiredCount === undefined) throw new Error('Expected the fully unwired Count.');
    const countSource = result.source.text.slice(
      unwiredCount.constructionSpan.start,
      unwiredCount.constructionSpan.end,
    );
    const inputPair = countSource.match(/input:pair\((import_network_\d+),(import_network_\d+)\)/);
    if (inputPair === null) throw new Error('Expected both reconstructed Count input lanes.');
    const inputLaneColors = inputPair.slice(1).map((networkName) => {
      const row = result.correspondence.networks.find(({ name }) => name === networkName);
      if (row === undefined) throw new Error(`Missing source correspondence for ${networkName}.`);
      const declaration = result.source.text.slice(
        row.declarationSpan.start,
        row.declarationSpan.end,
      );
      return declaration.match(/Network<([RG])>/)?.[1];
    });
    expect(inputLaneColors).toEqual(['R', 'G']);

    const unsupported = importCanonicalBlueprintSource(
      selectorDocument().replace(
        '"select_max":true',
        '"select_max":true,"select_highest_quality":true',
      ),
      { path: 'synthetic/selector-new-field.factorio.ts' },
      host.environment,
    );
    expect(unsupported).toMatchObject({
      state: 'blocked',
      diagnostics: [
        expect.objectContaining({
          category: 'unsupported-selector-configuration',
          path: '$.blueprint.entities[0].control_behavior.select_highest_quality',
        }),
      ],
    });
    expect(unsupported).not.toHaveProperty('source');
    expect(unsupported).not.toHaveProperty('correspondence');
    expect(compile).toHaveBeenCalledOnce();

    const negativeZero = importCanonicalBlueprintSource(
      selectorDocument().replace(
        '"index_signal":{"type":"virtual","name":"signal-index","quality":"rare"}',
        '"index_constant":-0',
      ),
      { path: 'synthetic/selector-negative-zero.factorio.ts' },
      host.environment,
    );
    expect(negativeZero).toMatchObject({
      state: 'blocked',
      diagnostics: [
        expect.objectContaining({
          category: 'unsupported-source-configuration',
          path: '$.blueprint.entities[0].control_behavior.index_constant',
          entityNumber: 10,
        }),
      ],
    });
    expect(negativeZero).not.toHaveProperty('source');
    expect(negativeZero).not.toHaveProperty('correspondence');
    expect(compile).toHaveBeenCalledOnce();
  });

  test('requires one exact correctly typed trusted Selector profile', () => {
    const compile = vi.spyOn(sourceCompilation, 'compileSourceProgram');
    const imported = selectorDocument();
    const missingContext = createTrustedEntityReplayContext({
      database: host.trustedEntityReplayContext.database,
      source: 'synthetic',
      evidenceIdentity: 'missing-selector-blueprint-import-profile',
      policyIdentity: 'missing-selector-blueprint-import-profile-policy',
      profiles: host.profiles.slice(0, 3),
    });
    const missing = importCanonicalBlueprintSource(
      imported,
      { path: 'missing-selector.ts' },
      { ...host.environment, trustedEntityReplayContext: missingContext },
    );
    expect(missing).toMatchObject({
      state: 'blocked',
      diagnostics: expect.arrayContaining([
        expect.objectContaining({
          category: 'missing-profile-selection',
          path: '$.blueprint.entities[0].name',
        }),
      ]),
    });

    const duplicateSelector: EntityProfile = {
      ...host.profiles[3]!,
      ref: {
        ...host.profiles[3]!.ref,
        profileId: 'profile:duplicate-selector-blueprint-import' as EntityProfileId,
      },
    };
    const ambiguousContext = createTrustedEntityReplayContext({
      database: host.trustedEntityReplayContext.database,
      source: 'synthetic',
      evidenceIdentity: 'ambiguous-selector-blueprint-import-profile',
      policyIdentity: 'ambiguous-selector-blueprint-import-profile-policy',
      profiles: [...host.profiles, duplicateSelector],
    });
    const ambiguous = importCanonicalBlueprintSource(
      imported,
      { path: 'ambiguous-selector.ts' },
      { ...host.environment, trustedEntityReplayContext: ambiguousContext },
    );
    expect(ambiguous).toMatchObject({
      state: 'blocked',
      diagnostics: expect.arrayContaining([
        expect.objectContaining({ category: 'ambiguous-canonical-profile' }),
      ]),
    });

    const wrongTypeProfile: EntityProfile = {
      ...host.profiles[3]!,
      prototypeType: 'decider-combinator',
    };
    const wrongTypeContext = createTrustedEntityReplayContext({
      database: host.trustedEntityReplayContext.database,
      source: 'synthetic',
      evidenceIdentity: 'wrong-type-selector-blueprint-import-profile',
      policyIdentity: 'wrong-type-selector-blueprint-import-profile-policy',
      profiles: [...host.profiles.slice(0, 3), wrongTypeProfile],
    });
    const wrongType = importCanonicalBlueprintSource(
      imported,
      { path: 'wrong-type-selector.ts' },
      { ...host.environment, trustedEntityReplayContext: wrongTypeContext },
    );
    expect(wrongType.state).toBe('blocked');
    expect(wrongType).not.toHaveProperty('source');
    expect(wrongType).not.toHaveProperty('correspondence');

    const moddedName = 'modded-selector-combinator';
    const modded = importCanonicalBlueprintSource(
      imported.replaceAll('selector-combinator', moddedName),
      { path: 'modded-selector.ts' },
      host.environment,
    );
    expect(modded).toMatchObject({
      state: 'blocked',
      diagnostics: expect.arrayContaining([
        expect.objectContaining({ category: 'unsupported-canonical-family' }),
      ]),
    });
    for (const refusal of [missing, ambiguous, wrongType, modded]) {
      expect(refusal).not.toHaveProperty('source');
      expect(refusal).not.toHaveProperty('correspondence');
    }
    expect(compile).not.toHaveBeenCalled();
  });

  test('verifies mixed-family topology with both Decider colors and ordered output branches', () => {
    const compile = vi.spyOn(sourceCompilation, 'compileSourceProgram');
    const result = importCanonicalBlueprintSource(
      mixedFamilyDeciderDocument(),
      { path: 'synthetic/mixed-decider.factorio.ts' },
      host.environment,
    );

    expect(result.state).toBe('verified');
    if (result.state !== 'verified') throw new Error('expected mixed-family Decider source');
    expect(compile).toHaveBeenCalledOnce();
    expect(compile.mock.calls[0]?.[0]).toBe(result.source);
    expect(result.verification).toMatchObject({ state: 'verified', entityCount: 4 });
    expect(result.correspondence.entities.map(({ entityNumber }) => entityNumber)).toEqual([
      1, 2, 10, 11,
    ]);
    expect(result.source.text.match(/= Decider\(/g)).toHaveLength(2);
    expect(result.source.text).toContain('= Constant(');
    expect(result.source.text).toContain('= Arithmetic(');
    for (const signal of ['signal-C', 'signal-D', 'signal-E']) {
      expect(result.source.text).toContain(signal);
    }
    expect(result.source.text.indexOf('signal-C')).toBeLessThan(
      result.source.text.indexOf('signal-D'),
    );
    expect(result.source.text.indexOf('signal-D')).toBeLessThan(
      result.source.text.indexOf('signal-E'),
    );
  });

  test('refuses a physically wired Decider input lane that its configuration does not read', () => {
    const compile = vi.spyOn(sourceCompilation, 'compileSourceProgram');
    const result = importCanonicalBlueprintSource(
      deciderDocument({ wiredUnreadInput: true }),
      { path: 'synthetic/unread-decider.factorio.ts' },
      host.environment,
    );

    expect(result).toMatchObject({
      state: 'blocked',
      diagnostics: [
        expect.objectContaining({
          category: 'unsupported-unread-decider-input',
          path: '$.blueprint.wires[1][3]',
          entityNumber: 42,
        }),
      ],
    });
    expect(result).not.toHaveProperty('source');
    expect(result).not.toHaveProperty('correspondence');
    expect(compile).not.toHaveBeenCalled();
  });

  test('imports an omitted Decider copy-input mask using the native both-color default', () => {
    const compile = vi.spyOn(sourceCompilation, 'compileSourceProgram');
    const result = importCanonicalBlueprintSource(
      deciderDocument({ implicitCopyInput: true }),
      { path: 'synthetic/implicit-mask-decider.factorio.ts' },
      host.environment,
    );

    expect(result).toMatchObject({
      state: 'verified',
      verification: { state: 'verified', entityCount: 1 },
    });
    expect(result).toHaveProperty('source');
    expect(result).toHaveProperty('correspondence');
    expect(compile).toHaveBeenCalledOnce();
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
    const compile = vi.spyOn(sourceCompilation, 'compileSourceProgram');
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

    const missingDeciderContext = createTrustedEntityReplayContext({
      database: host.trustedEntityReplayContext.database,
      source: 'synthetic',
      evidenceIdentity: 'missing-decider-blueprint-import-profile',
      policyIdentity: 'missing-decider-blueprint-import-profile-policy',
      profiles: host.profiles.slice(0, 2),
    });
    const missingDecider = importCanonicalBlueprintSource(
      deciderDocument(),
      { path: 'missing-decider.ts' },
      { ...host.environment, trustedEntityReplayContext: missingDeciderContext },
    );
    expect(missingDecider).toMatchObject({
      state: 'blocked',
      diagnostics: [
        expect.objectContaining({
          category: 'missing-profile-selection',
          path: '$.blueprint.entities[0].name',
        }),
      ],
    });

    const duplicateDeciderProfile: EntityProfile = {
      ...host.profiles[2]!,
      ref: {
        ...host.profiles[2]!.ref,
        profileId: 'profile:duplicate-decider-blueprint-import' as EntityProfileId,
      },
    };
    const ambiguousDeciderContext = createTrustedEntityReplayContext({
      database: host.trustedEntityReplayContext.database,
      source: 'synthetic',
      evidenceIdentity: 'ambiguous-decider-blueprint-import-profile',
      policyIdentity: 'ambiguous-decider-blueprint-import-profile-policy',
      profiles: [...host.profiles, duplicateDeciderProfile],
    });
    const ambiguousDecider = importCanonicalBlueprintSource(
      deciderDocument(),
      { path: 'ambiguous-decider.ts' },
      { ...host.environment, trustedEntityReplayContext: ambiguousDeciderContext },
    );
    expect(ambiguousDecider).toMatchObject({
      state: 'blocked',
      diagnostics: [expect.objectContaining({ category: 'ambiguous-canonical-profile' })],
    });

    const moddedDeciderName = 'modded-decider-combinator';
    const sameTypeModdedDecider: EntityProfile = {
      ...host.profiles[2]!,
      ref: {
        ...host.profiles[2]!.ref,
        prototypeKey: `entity:${moddedDeciderName}` as EntityProfile['ref']['prototypeKey'],
        profileId: 'profile:modded-decider-blueprint-import' as EntityProfileId,
      },
    };
    const moddedDeciderContext = createTrustedEntityReplayContext({
      database: host.trustedEntityReplayContext.database,
      source: 'synthetic',
      evidenceIdentity: 'modded-decider-blueprint-import-profile',
      policyIdentity: 'modded-decider-blueprint-import-profile-policy',
      profiles: [sameTypeModdedDecider],
    });
    const moddedDecider = importCanonicalBlueprintSource(
      deciderDocument().replace('decider-combinator', moddedDeciderName),
      { path: 'modded-decider.ts' },
      { ...host.environment, trustedEntityReplayContext: moddedDeciderContext },
    );
    expect(moddedDecider).toMatchObject({
      state: 'blocked',
      diagnostics: [expect.objectContaining({ category: 'unsupported-canonical-family' })],
    });
    expect(compile).not.toHaveBeenCalled();
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

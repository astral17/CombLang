import { analyzeBlueprintImport } from '@comblang/blueprint/import-analysis';
import { classifyBlueprintDocument } from '@comblang/blueprint/classification';
import { parseLosslessJson, stringifyLosslessJson } from '@comblang/blueprint/document';
import type { EntityProfile, EntityProfileId } from './entity.js';
import { syntheticZeroPortEntityProfile } from './entity-fixtures.js';
import {
  createTrustedEntityReplayContext,
  EntityReplayContextError,
  type TrustedEntityReplayContext,
} from './entity-replay-context.js';
import { analyzeCanonicalBlueprintImport } from './blueprint-import-canonical-families.js';
import type { BlueprintImportProfileMappingEntry } from './blueprint-import-profile-mappings.js';

import { describe, expect, test } from 'vitest';

function canonicalProfile(
  family: 'constant' | 'arithmetic' | 'decider' | 'selector',
  profileId = `profile:canonical-${family}-test`,
): EntityProfile {
  const prototypeName = `${family}-combinator`;
  return {
    ...syntheticZeroPortEntityProfile,
    ref: {
      ...syntheticZeroPortEntityProfile.ref,
      prototypeKey: `entity:${prototypeName}`,
      profileId: profileId as EntityProfileId,
    },
    prototypeType: prototypeName,
  };
}

const constantProfile = canonicalProfile('constant');
const arithmeticProfile = canonicalProfile('arithmetic');
const deciderProfile = canonicalProfile('decider');
const selectorProfile = canonicalProfile('selector');

function contextFor(
  profiles: readonly EntityProfile[] = [
    constantProfile,
    arithmeticProfile,
    deciderProfile,
    selectorProfile,
  ],
): TrustedEntityReplayContext {
  return createTrustedEntityReplayContext({
    database: syntheticZeroPortEntityProfile.ref.database,
    source: 'synthetic',
    evidenceIdentity: 'comblang-canonical-blueprint-test-evidence',
    policyIdentity: 'comblang-canonical-blueprint-test-policy',
    profiles,
  });
}

function constantBehavior() {
  return {
    is_on: true,
    sections: {
      sections: [
        {
          index: 1,
          active: false,
          multiplier: 1.25,
          group: 'first',
          filters: [
            {
              index: 1,
              name: 'iron-plate',
              quality: 'uncommon',
              comparator: '=',
              count: 17,
            },
          ],
        },
        { index: 2, active: true, multiplier: -0.5, filters: [] },
      ],
    },
  };
}

function arithmeticBehavior(
  options: {
    readonly red?: boolean;
    readonly green?: boolean;
    readonly second?: 'constant' | 'green' | 'pair' | 'red';
  } = {},
) {
  const { red = true, green = false, second = 'constant' } = options;
  const conditions: Record<string, unknown> = {
    first_signal: { name: 'signal-A' },
    first_signal_networks: { red, green },
    operation: '+',
    output_signal: { name: 'signal-B' },
  };
  if (second === 'constant') {
    conditions.second_constant = 7;
  } else {
    conditions.second_signal = { name: 'signal-C' };
    conditions.second_signal_networks = {
      red: second === 'red' || second === 'pair',
      green: second === 'green' || second === 'pair',
    };
  }
  return { arithmetic_conditions: conditions };
}

function deciderBehavior(
  options: {
    readonly conditionRed?: boolean;
    readonly conditionGreen?: boolean;
    readonly outputNetworks?: { readonly red: boolean; readonly green: boolean };
    readonly elseOutputs?: readonly unknown[];
  } = {},
) {
  return {
    decider_conditions: {
      conditions: [
        {
          first_signal: { type: 'virtual', name: 'signal-A', quality: 'rare' },
          first_signal_networks: {
            red: options.conditionRed ?? true,
            green: options.conditionGreen ?? false,
          },
          comparator: '>',
          constant: 2,
          compare_type: 'and',
        },
      ],
      outputs: [
        {
          signal: { type: 'virtual', name: 'signal-B' },
          copy_count_from_input: options.outputNetworks !== undefined,
          ...(options.outputNetworks === undefined ? {} : { networks: options.outputNetworks }),
          ...(options.outputNetworks === undefined ? { constant: 0 } : {}),
        },
      ],
      ...(options.elseOutputs === undefined ? {} : { else_outputs: options.elseOutputs }),
    },
  };
}

interface FixtureEntity {
  readonly entity_number: number;
  readonly name: string;
  readonly control_behavior: unknown;
}

type FixtureWire = readonly [number, number, number, number];

function fixtureSource(
  entities: readonly FixtureEntity[],
  wires: readonly FixtureWire[] = [],
): string {
  return JSON.stringify({ blueprint: { entities, wires } });
}

function analysisFrom(source: string) {
  return analyzeBlueprintImport(classifyBlueprintDocument(parseLosslessJson(source)));
}

function entry(entityNumber: number, profile = constantProfile.ref) {
  return { entityNumber, profile } satisfies BlueprintImportProfileMappingEntry;
}

function selectionsFor(entities: readonly FixtureEntity[]): BlueprintImportProfileMappingEntry[] {
  return entities.map(({ entity_number, name }) =>
    entry(
      entity_number,
      name === 'arithmetic-combinator'
        ? arithmeticProfile.ref
        : name === 'decider-combinator'
          ? deciderProfile.ref
          : name === 'selector-combinator'
            ? selectorProfile.ref
            : constantProfile.ref,
    ),
  );
}

function constantEntity(entity_number: number): FixtureEntity {
  return { entity_number, name: 'constant-combinator', control_behavior: constantBehavior() };
}

function arithmeticEntity(entity_number: number, behavior = arithmeticBehavior()): FixtureEntity {
  return { entity_number, name: 'arithmetic-combinator', control_behavior: behavior };
}

function deciderEntity(entity_number: number, behavior = deciderBehavior()): FixtureEntity {
  return { entity_number, name: 'decider-combinator', control_behavior: behavior };
}

function selectorEntity(entity_number: number, behavior: unknown): FixtureEntity {
  return { entity_number, name: 'selector-combinator', control_behavior: behavior };
}

function idsFor(result: ReturnType<typeof analyzeCanonicalBlueprintImport>) {
  return new Map(
    result.networks.flatMap(({ network, component }) =>
      component.endpoints.map(
        ({ entityNumber, connectorId }) => [`${entityNumber}:${connectorId}`, network] as const,
      ),
    ),
  );
}

describe('canonical blueprint family bridge', () => {
  test('requires a unique trusted canonical selection and accepts zero-port canonical profiles', () => {
    const entities = [constantEntity(1)];
    const analysis = analysisFrom(fixtureSource(entities));
    const context = contextFor();

    const missing = analyzeCanonicalBlueprintImport(analysis, [], context);
    expect(missing.state).toBe('blocked');
    expect(missing.diagnostics).toContainEqual(
      expect.objectContaining({
        category: 'missing-profile-selection',
        path: '$.blueprint.entities[0].name',
      }),
    );
    expect(missing.components).toEqual([]);
    expect(missing.networks).toEqual([]);
    expect(missing.entities).toEqual([]);

    const wrongFamily = analyzeCanonicalBlueprintImport(
      analysis,
      [entry(1, arithmeticProfile.ref)],
      context,
    );
    expect(wrongFamily.diagnostics).toContainEqual(
      expect.objectContaining({ category: 'canonical-family-mismatch', entityNumber: 1 }),
    );

    const wrongPrototypeType = {
      ...canonicalProfile('constant', 'profile:wrong-type-constant-test'),
      prototypeType: 'arithmetic-combinator',
    };
    const wrongTypeResult = analyzeCanonicalBlueprintImport(
      analysis,
      [entry(1, wrongPrototypeType.ref)],
      contextFor([wrongPrototypeType, arithmeticProfile]),
    );
    expect(wrongTypeResult.diagnostics).toContainEqual(
      expect.objectContaining({ category: 'canonical-family-mismatch', entityNumber: 1 }),
    );

    const modded = canonicalProfile('constant', 'profile:modded-constant-test');
    const moddedContext = contextFor([
      constantProfile,
      arithmeticProfile,
      {
        ...modded,
        ref: { ...modded.ref, prototypeKey: 'entity:my-constant-combinator' },
      },
    ]);
    const moddedResult = analyzeCanonicalBlueprintImport(
      analysis,
      [entry(1, { ...modded.ref, prototypeKey: 'entity:my-constant-combinator' })],
      moddedContext,
    );
    expect(moddedResult.diagnostics).toContainEqual(
      expect.objectContaining({ category: 'canonical-family-mismatch' }),
    );

    const unsupportedEntity: FixtureEntity = {
      entity_number: 2,
      name: 'programmable-speaker',
      control_behavior: {},
    };
    const unsupported = analyzeCanonicalBlueprintImport(
      analysisFrom(fixtureSource([unsupportedEntity])),
      [entry(2)],
      context,
    );
    expect(unsupported.diagnostics).toContainEqual(
      expect.objectContaining({
        category: 'unsupported-canonical-family',
        path: '$.blueprint.entities[0].name',
      }),
    );

    expect(() => analyzeCanonicalBlueprintImport(analysis, [entry(1), entry(1)], context)).toThrow(
      /Duplicate blueprint entity_number/,
    );
    expect(() => analyzeCanonicalBlueprintImport(analysis, [entry(99)], context)).toThrow(
      /absent from the inventory/,
    );

    const staleRef = {
      ...constantProfile.ref,
      profileId: 'profile:stale-canonical-test' as EntityProfileId,
    };
    expect(() =>
      analyzeCanonicalBlueprintImport(analysis, [entry(1, staleRef)], context),
    ).toThrowError(
      expect.objectContaining({ code: 'ER1002' } satisfies Partial<EntityReplayContextError>),
    );
    const foreignRef = {
      ...constantProfile.ref,
      database: { schemaVersion: 1, identity: 'foreign-database' },
    };
    expect(() =>
      analyzeCanonicalBlueprintImport(analysis, [entry(1, foreignRef)], context),
    ).toThrowError(expect.objectContaining({ code: 'ER1001' }));

    const ambiguous = canonicalProfile('constant', 'profile:canonical-constant-second');
    const ambiguousResult = analyzeCanonicalBlueprintImport(
      analysis,
      [entry(1)],
      contextFor([constantProfile, ambiguous, arithmeticProfile]),
    );
    expect(ambiguousResult.diagnostics).toContainEqual(
      expect.objectContaining({ category: 'ambiguous-canonical-profile' }),
    );

    const accepted = analyzeCanonicalBlueprintImport(analysis, [entry(1)], context);
    expect(accepted.state).toBe('complete');
    expect(accepted.entities[0]).toMatchObject({ entityNumber: 1, family: 'constant' });
    expect(constantProfile.connectors).toEqual([]);
  });

  test('bridges only trusted Selector profiles and keeps both isolated input lanes explicit', () => {
    const selectNumeric = { operation: 'select', select_max: false, index_constant: 3 };
    const isolated = selectorEntity(20, selectNumeric);
    const isolatedResult = analyzeCanonicalBlueprintImport(
      analysisFrom(fixtureSource([isolated])),
      selectionsFor([isolated]),
      contextFor(),
    );
    expect(isolatedResult.state).toBe('complete');
    expect(isolatedResult.networks).toHaveLength(4);
    expect(isolatedResult.entities[0]).toMatchObject({
      family: 'selector',
      inputNetworks: {
        red: 'network:blueprint-import:1',
        green: 'network:blueprint-import:3',
      },
      configuration: {
        operation: 'select',
        input: {
          refKind: 'pair',
          networks: ['network:blueprint-import:1', 'network:blueprint-import:3'],
        },
        selectMax: false,
        index: 3,
      },
      outputNetworks: {},
    });
    expect(isolatedResult.networks.map(({ component }) => component.color)).toEqual([
      'red',
      'red',
      'green',
      'green',
    ]);

    const signalSelect = selectorEntity(20, {
      operation: 'select',
      select_max: true,
      index_signal: { type: 'virtual', name: 'signal-index', quality: 'rare' },
    });
    const redInputFixture = [constantEntity(1), signalSelect];
    const redInput = analyzeCanonicalBlueprintImport(
      analysisFrom(fixtureSource(redInputFixture, [[1, 1, 20, 1]])),
      selectionsFor(redInputFixture),
      contextFor(),
    );
    expect(redInput.state).toBe('complete');
    const redOnly = redInput.entities.find((candidate) => candidate.entityNumber === 20);
    if (redOnly?.family !== 'selector') throw new Error('Expected a bridged Selector.');
    expect(redOnly.configuration).toMatchObject({
      operation: 'select',
      input: { refKind: 'pair' },
      selectMax: true,
      index: { type: 'virtual', name: 'signal-index', quality: 'rare' },
    });
    expect(
      redInput.networks.find(({ network }) => network === redOnly.inputNetworks.red)?.component
        .endpoints,
    ).toEqual([
      { entityNumber: 1, connectorId: 1 },
      { entityNumber: 20, connectorId: 1 },
    ]);
    expect(
      redInput.networks.find(({ network }) => network === redOnly.inputNetworks.green)?.component
        .endpoints,
    ).toEqual([{ entityNumber: 20, connectorId: 2 }]);

    const count = selectorEntity(20, {
      operation: 'count',
      count_signal: { name: 'iron-plate', quality: 'normal' },
    });
    const bothInputFixture = [constantEntity(1), constantEntity(2), count];
    const bothInputs = analyzeCanonicalBlueprintImport(
      analysisFrom(
        fixtureSource(bothInputFixture, [
          [1, 1, 20, 1],
          [2, 2, 20, 2],
        ]),
      ),
      selectionsFor(bothInputFixture),
      contextFor(),
    );
    expect(bothInputs.state).toBe('complete');
    const countEntity = bothInputs.entities.find((candidate) => candidate.entityNumber === 20);
    if (countEntity?.family !== 'selector') throw new Error('Expected a bridged Count Selector.');
    expect(countEntity.configuration).toMatchObject({
      operation: 'count',
      input: {
        refKind: 'pair',
        networks: [countEntity.inputNetworks.red, countEntity.inputNetworks.green],
      },
      output: { type: 'item', name: 'iron-plate', quality: 'normal' },
    });
    if (countEntity.configuration.operation !== 'count') {
      throw new Error('Expected the decoded Selector Count configuration.');
    }
    expect(Object.hasOwn(countEntity.configuration.output, 'quality')).toBe(true);

    const feedback = selectorEntity(30, selectNumeric);
    const feedbackResult = analyzeCanonicalBlueprintImport(
      analysisFrom(
        fixtureSource(
          [feedback],
          [
            [30, 3, 30, 1],
            [30, 4, 30, 2],
          ],
        ),
      ),
      selectionsFor([feedback]),
      contextFor(),
    );
    expect(feedbackResult.state).toBe('complete');
    const feedbackEntity = feedbackResult.entities[0];
    if (feedbackEntity?.family !== 'selector') throw new Error('Expected a feedback Selector.');
    expect(feedbackEntity.inputNetworks.red).toBe(feedbackEntity.outputNetworks.red);
    expect(feedbackEntity.inputNetworks.green).toBe(feedbackEntity.outputNetworks.green);
  });

  test('rejects ambiguous, mismatched, modded, and unsupported Selector profiles atomically', () => {
    const selector = selectorEntity(9, {
      operation: 'count',
      count_signal: { name: 'iron-plate' },
    });
    const analysis = analysisFrom(fixtureSource([selector]));
    const wrongFamily = analyzeCanonicalBlueprintImport(
      analysis,
      [entry(9, arithmeticProfile.ref)],
      contextFor(),
    );
    expect(wrongFamily.diagnostics).toContainEqual(
      expect.objectContaining({ category: 'canonical-family-mismatch', entityNumber: 9 }),
    );

    const wrongType = {
      ...canonicalProfile('selector', 'profile:selector-wrong-type'),
      prototypeType: 'decider-combinator',
    };
    const wrongTypeResult = analyzeCanonicalBlueprintImport(
      analysis,
      [entry(9, wrongType.ref)],
      contextFor([wrongType, arithmeticProfile]),
    );
    expect(wrongTypeResult.diagnostics).toContainEqual(
      expect.objectContaining({ category: 'canonical-family-mismatch', entityNumber: 9 }),
    );

    const duplicate = canonicalProfile('selector', 'profile:selector-duplicate');
    const ambiguous = analyzeCanonicalBlueprintImport(
      analysis,
      [entry(9)],
      contextFor([constantProfile, selectorProfile, duplicate]),
    );
    expect(ambiguous.diagnostics).toContainEqual(
      expect.objectContaining({ category: 'ambiguous-canonical-profile', entityNumber: 9 }),
    );

    const modded = canonicalProfile('selector', 'profile:selector-modded');
    const moddedRef = { ...modded.ref, prototypeKey: 'entity:my-selector-combinator' };
    const moddedResult = analyzeCanonicalBlueprintImport(
      analysis,
      [entry(9, moddedRef)],
      contextFor([selectorProfile, { ...modded, ref: moddedRef }]),
    );
    expect(moddedResult.diagnostics).toContainEqual(
      expect.objectContaining({ category: 'canonical-family-mismatch', entityNumber: 9 }),
    );

    for (const behavior of [
      { operation: 'random' },
      { operation: 'select', select_max: true, index_constant: 2, select_highest_quality: true },
    ]) {
      const rejected = analyzeCanonicalBlueprintImport(
        analysisFrom(fixtureSource([selectorEntity(9, behavior)])),
        [entry(9, selectorProfile.ref)],
        contextFor(),
      );
      expect(rejected.state).toBe('blocked');
      expect(rejected.components).toEqual([]);
      expect(rejected.networks).toEqual([]);
      expect(rejected.entities).toEqual([]);
      expect(rejected.diagnostics).toContainEqual(
        expect.objectContaining({ category: 'unsupported-selector-configuration' }),
      );
    }
  });

  test('uses explicit family endpoint tables and existing deterministic connectivity', () => {
    const entities = [constantEntity(20), arithmeticEntity(10)];
    const analysis = analysisFrom(fixtureSource(entities, [[20, 1, 10, 1]]));
    const result = analyzeCanonicalBlueprintImport(analysis, selectionsFor(entities), contextFor());

    expect(result.state).toBe('complete');
    expect(result.entities.map(({ entityNumber }) => entityNumber)).toEqual([20, 10]);
    expect(result.networks.map(({ network }) => network)).toEqual([
      'network:blueprint-import:1',
      'network:blueprint-import:2',
      'network:blueprint-import:3',
      'network:blueprint-import:4',
      'network:blueprint-import:5',
    ]);
    expect(result.networks[0]?.component.endpoints).toEqual([
      { entityNumber: 10, connectorId: 1 },
      { entityNumber: 20, connectorId: 1 },
    ]);
    expect(result.networks.map(({ component }) => component.color)).toEqual([
      'red',
      'red',
      'green',
      'green',
      'green',
    ]);
    expect(result.entities[1]).toMatchObject({
      family: 'arithmetic',
      inputNetworks: {
        red: 'network:blueprint-import:1',
        green: 'network:blueprint-import:3',
      },
    });

    const unknown = analysisFrom(fixtureSource(entities, [[20, 99, 10, 1]]));
    const unknownResult = analyzeCanonicalBlueprintImport(
      unknown,
      selectionsFor(entities),
      contextFor(),
    );
    expect(unknownResult.state).toBe('blocked');
    expect(unknownResult.components).toEqual([]);
    expect(unknownResult.diagnostics).toContainEqual(
      expect.objectContaining({
        category: 'unresolved-endpoint',
        path: '$.blueprint.wires[0][1]',
      }),
    );

    const colorConflict = analysisFrom(fixtureSource(entities, [[20, 1, 10, 2]]));
    const conflictResult = analyzeCanonicalBlueprintImport(
      colorConflict,
      selectionsFor(entities),
      contextFor(),
    );
    expect(conflictResult.state).toBe('blocked');
    expect(conflictResult.diagnostics).toContainEqual(
      expect.objectContaining({ category: 'incompatible-mapping' }),
    );
  });

  test('requires explicit trusted Decider authority and maps isolated input/output color lanes', () => {
    const rows = [deciderEntity(10)];
    const analysis = analysisFrom(fixtureSource(rows));
    const accepted = analyzeCanonicalBlueprintImport(analysis, selectionsFor(rows), contextFor());
    expect(accepted.state).toBe('complete');
    expect(accepted.networks).toHaveLength(4);
    expect(accepted.networks.map(({ component }) => component.color)).toEqual([
      'red',
      'red',
      'green',
      'green',
    ]);
    expect(accepted.entities[0]).toMatchObject({
      entityNumber: 10,
      family: 'decider',
      inputNetworks: {
        red: 'network:blueprint-import:1',
        green: 'network:blueprint-import:3',
      },
      configuration: {
        condition: {
          kind: 'compare',
          left: {
            kind: 'signal',
            signal: { type: 'virtual', name: 'signal-A', quality: 'rare' },
            refKind: 'single',
            network: 'network:blueprint-import:1',
          },
          comparator: '>',
          right: { kind: 'constant', value: 2 },
        },
      },
    });
    const importedDecider = accepted.entities[0]!;
    expect(Object.isFrozen(accepted)).toBe(true);
    expect(Object.isFrozen(accepted.entities)).toBe(true);
    expect(Object.isFrozen(importedDecider)).toBe(true);
    if (importedDecider.family !== 'decider') throw new Error('Expected a Decider bridge entity.');
    expect(Object.isFrozen(importedDecider.configuration)).toBe(true);
    expect(Object.isFrozen(importedDecider.configuration.condition)).toBe(true);
    expect(Object.isFrozen(importedDecider.configuration.outputs)).toBe(true);

    const malformedEntity: FixtureEntity = {
      entity_number: 21,
      name: 'decider-combinator',
      control_behavior: {
        decider_conditions: {
          ...deciderBehavior().decider_conditions,
          outputs: null,
        },
      },
    };
    const malformed = analyzeCanonicalBlueprintImport(
      analysisFrom(fixtureSource([malformedEntity])),
      selectionsFor([malformedEntity]),
      contextFor(),
    );
    expect(malformed.state).toBe('blocked');
    expect(malformed.networks).toEqual([]);
    expect(malformed.entities).toEqual([]);
    expect(malformed.diagnostics).toContainEqual(
      expect.objectContaining({
        category: 'unsupported-decider-configuration',
        path: '$.blueprint.entities[0].control_behavior.decider_conditions.outputs',
      }),
    );

    const missing = analyzeCanonicalBlueprintImport(analysis, [], contextFor());
    expect(missing.diagnostics).toContainEqual(
      expect.objectContaining({ category: 'missing-profile-selection', entityNumber: 10 }),
    );
    const mismatched = analyzeCanonicalBlueprintImport(
      analysis,
      [entry(10, arithmeticProfile.ref)],
      contextFor(),
    );
    expect(mismatched.diagnostics).toContainEqual(
      expect.objectContaining({ category: 'canonical-family-mismatch', entityNumber: 10 }),
    );
    const duplicate = canonicalProfile('decider', 'profile:duplicate-decider-test');
    const ambiguous = analyzeCanonicalBlueprintImport(
      analysis,
      selectionsFor(rows),
      contextFor([deciderProfile, duplicate]),
    );
    expect(ambiguous.diagnostics).toContainEqual(
      expect.objectContaining({ category: 'ambiguous-canonical-profile', entityNumber: 10 }),
    );

    const mixed = [
      constantEntity(1),
      constantEntity(2),
      deciderEntity(
        10,
        deciderBehavior({
          conditionRed: true,
          conditionGreen: true,
          outputNetworks: { red: false, green: true },
        }),
      ),
    ];
    const topology = analyzeCanonicalBlueprintImport(
      analysisFrom(
        fixtureSource(mixed, [
          [1, 1, 10, 1],
          [2, 2, 10, 2],
          [10, 3, 10, 1],
          [10, 4, 2, 2],
        ]),
      ),
      selectionsFor(mixed),
      contextFor(),
    );
    expect(topology.state).toBe('complete');
    const decider = topology.entities.find((candidate) => candidate.entityNumber === 10);
    expect(decider).toMatchObject({
      family: 'decider',
      outputNetworks: {
        red: 'network:blueprint-import:1',
        green: 'network:blueprint-import:4',
      },
    });
  });

  test('decodes configurations with entity paths and host component IDs without rewriting lossless input', () => {
    const source =
      '{"blueprint":{"entities":[' +
      '{"entity_number":8,"name":"constant-combinator","control_behavior":' +
      '{"is_on":false,"sections":{"sections":[{"index":1,"active":false,' +
      '"multiplier":1.2300,"group":"","filters":[{"index":1,"name":"iron-plate",' +
      '"quality":"uncommon","comparator":"=","count":17}]},' +
      '{"index":2,"active":true,"multiplier":-0.5,"filters":[]}]}}},' +
      '{"entity_number":3,"name":"arithmetic-combinator","control_behavior":' +
      '{"arithmetic_conditions":{"first_signal":{"name":"signal-A"},' +
      '"first_signal_networks":{"red":true,"green":false},"operation":"+",' +
      '"second_signal":{"name":"signal-C"},"second_signal_networks":' +
      '{"red":true,"green":true},"output_signal":{"name":"signal-B"}}}}],' +
      '"wires":[[8,1,3,1]]}}';
    const analysis = analysisFrom(source);
    const before = stringifyLosslessJson(analysis.document);
    const entities = [constantEntity(8), arithmeticEntity(3)];
    const result = analyzeCanonicalBlueprintImport(analysis, selectionsFor(entities), contextFor());

    expect(result.state).toBe('complete');
    expect(result.analysis).toBe(analysis);
    expect(stringifyLosslessJson(analysis.document)).toBe(before);
    expect(result.entities[0]).toMatchObject({
      entityNumber: 8,
      family: 'constant',
      configuration: {
        isOn: false,
        sections: [
          {
            active: false,
            group: '',
            multiplier: 1.23,
            filters: [
              { signal: { type: 'item', name: 'iron-plate', quality: 'uncommon' }, value: 17 },
            ],
          },
          { active: true, multiplier: -0.5, filters: [] },
        ],
      },
    });
    expect(
      Object.is(
        (result.entities[0] as Extract<(typeof result.entities)[number], { family: 'constant' }>)
          .configuration.sections[1]?.multiplier,
        -0.5,
      ),
    ).toBe(true);

    const arithmetic = result.entities[1];
    expect(arithmetic).toMatchObject({
      entityNumber: 3,
      family: 'arithmetic',
      configuration: {
        operation: 'add',
        left: { kind: 'signal', refKind: 'single', network: 'network:blueprint-import:1' },
        right: {
          kind: 'signal',
          refKind: 'pair',
          networks: ['network:blueprint-import:1', 'network:blueprint-import:3'],
        },
      },
      inputNetworks: {
        red: 'network:blueprint-import:1',
        green: 'network:blueprint-import:3',
      },
    });
    expect(arithmetic?.family === 'arithmetic' && Object.isFrozen(arithmetic.inputNetworks)).toBe(
      true,
    );

    const unsupportedSource = fixtureSource([
      { ...constantEntity(1), control_behavior: { is_on: true } },
    ]);
    const unsupported = analyzeCanonicalBlueprintImport(
      analysisFrom(unsupportedSource),
      [entry(1)],
      contextFor(),
    );
    expect(unsupported.state).toBe('blocked');
    expect(unsupported.entities).toEqual([]);
    expect(unsupported.networks).toEqual([]);
    expect(unsupported.diagnostics).toContainEqual(
      expect.objectContaining({
        category: 'unsupported-constant-configuration',
        path: '$.blueprint.entities[0].control_behavior.sections',
      }),
    );
  });

  test('keeps feedback, fanout, color lanes and output-only physical attachments as components', () => {
    const rows = [
      arithmeticEntity(40, arithmeticBehavior({ red: true, green: false, second: 'green' })),
      constantEntity(10),
      arithmeticEntity(30, arithmeticBehavior({ red: true, green: false, second: 'green' })),
      constantEntity(99),
    ];
    const wires: FixtureWire[] = [
      [10, 1, 40, 1],
      [10, 1, 30, 1],
      [40, 3, 40, 1],
      [40, 4, 30, 2],
      [10, 2, 40, 2],
      [40, 3, 30, 3],
    ];
    const first = analyzeCanonicalBlueprintImport(
      analysisFrom(fixtureSource(rows, wires)),
      selectionsFor(rows),
      contextFor(),
    );
    const permutedRows = [...rows].reverse();
    const second = analyzeCanonicalBlueprintImport(
      analysisFrom(fixtureSource(permutedRows, [...wires].reverse())),
      selectionsFor(permutedRows),
      contextFor(),
    );

    expect(first.state).toBe('complete');
    expect(first.entities.map(({ entityNumber }) => entityNumber)).toEqual([40, 10, 30, 99]);
    expect(second.entities.map(({ entityNumber }) => entityNumber)).toEqual([99, 30, 10, 40]);
    expect(first.networks).toEqual(second.networks);
    const ids = idsFor(first);
    expect(ids.get('10:1')).toBe(ids.get('40:1'));
    expect(ids.get('10:1')).toBe(ids.get('30:1'));
    expect(ids.get('40:1')).toBe(ids.get('40:3'));
    expect(ids.get('40:3')).toBe(ids.get('30:3'));
    expect(ids.get('10:2')).toBe(ids.get('40:2'));
    expect(ids.get('40:4')).toBe(ids.get('30:2'));

    const constant10 = first.entities.find((candidate) => candidate.entityNumber === 10);
    const constant99 = first.entities.find((candidate) => candidate.entityNumber === 99);
    const arithmetic40 = first.entities.find((candidate) => candidate.entityNumber === 40);
    const arithmetic30 = first.entities.find((candidate) => candidate.entityNumber === 30);
    expect(constant10?.outputNetworks.red).toBe(ids.get('10:1'));
    expect(constant10?.outputNetworks.green).toBe(ids.get('10:2'));
    expect(constant99?.outputNetworks).toEqual({});
    expect(arithmetic40?.outputNetworks).toEqual({
      red: ids.get('40:3'),
      green: ids.get('40:4'),
    });
    expect(arithmetic30?.outputNetworks).toEqual({ red: ids.get('30:3') });
    expect(first.entities).not.toHaveProperty('producers');
  });

  test('rejects a physically wired unread lane but permits paired and unwired lane references', () => {
    const sourceEntity = constantEntity(5);
    const unreadEntity = arithmeticEntity(10, arithmeticBehavior({ red: true, green: false }));
    const unreadRows = [sourceEntity, unreadEntity];
    const unread = analyzeCanonicalBlueprintImport(
      analysisFrom(fixtureSource(unreadRows, [[5, 2, 10, 2]])),
      selectionsFor(unreadRows),
      contextFor(),
    );
    expect(unread.state).toBe('blocked');
    expect(unread.components).toEqual([]);
    expect(unread.networks).toEqual([]);
    expect(unread.entities).toEqual([]);
    expect(unread.diagnostics).toContainEqual(
      expect.objectContaining({
        category: 'unsupported-unread-arithmetic-input',
        path: '$.blueprint.wires[0][3]',
        entityNumber: 10,
      }),
    );

    const pairedEntity = arithmeticEntity(
      10,
      arithmeticBehavior({ red: true, green: false, second: 'pair' }),
    );
    const pairedRows = [sourceEntity, pairedEntity];
    const paired = analyzeCanonicalBlueprintImport(
      analysisFrom(fixtureSource(pairedRows, [[5, 2, 10, 2]])),
      selectionsFor(pairedRows),
      contextFor(),
    );
    expect(paired.state).toBe('complete');
    const pairedArithmetic = paired.entities.find(({ entityNumber }) => entityNumber === 10);
    expect(
      pairedArithmetic?.family === 'arithmetic' &&
        pairedArithmetic.configuration.right.kind === 'signal' &&
        pairedArithmetic.configuration.right.refKind === 'pair',
    ).toBe(true);

    const disconnectedRows = [arithmeticEntity(10, arithmeticBehavior())];
    const disconnected = analyzeCanonicalBlueprintImport(
      analysisFrom(fixtureSource(disconnectedRows)),
      selectionsFor(disconnectedRows),
      contextFor(),
    );
    expect(disconnected.state).toBe('complete');
    const disconnectedArithmetic = disconnected.entities[0];
    expect(
      disconnectedArithmetic?.family === 'arithmetic' && disconnectedArithmetic.inputNetworks,
    ).toMatchObject({
      red: 'network:blueprint-import:1',
      green: 'network:blueprint-import:3',
    });
  });

  test('counts Decider output masks as input use and refuses only wired unread color lanes', () => {
    const conditionOnly = [constantEntity(1), deciderEntity(10)];
    const conditionResult = analyzeCanonicalBlueprintImport(
      analysisFrom(fixtureSource(conditionOnly, [[1, 1, 10, 1]])),
      selectionsFor(conditionOnly),
      contextFor(),
    );
    expect(conditionResult.state).toBe('complete');

    const copyOutputOnly = [
      constantEntity(1),
      deciderEntity(10, deciderBehavior({ outputNetworks: { red: false, green: true } })),
    ];
    const copyOutputResult = analyzeCanonicalBlueprintImport(
      analysisFrom(fixtureSource(copyOutputOnly, [[1, 2, 10, 2]])),
      selectionsFor(copyOutputOnly),
      contextFor(),
    );
    expect(copyOutputResult.state).toBe('complete');

    const paired = [
      constantEntity(1),
      deciderEntity(10, deciderBehavior({ conditionRed: true, conditionGreen: true })),
    ];
    const pairedResult = analyzeCanonicalBlueprintImport(
      analysisFrom(
        fixtureSource(paired, [
          [1, 1, 10, 1],
          [1, 2, 10, 2],
        ]),
      ),
      selectionsFor(paired),
      contextFor(),
    );
    expect(pairedResult.state).toBe('complete');

    const unread = analyzeCanonicalBlueprintImport(
      analysisFrom(fixtureSource(conditionOnly, [[1, 2, 10, 2]])),
      selectionsFor(conditionOnly),
      contextFor(),
    );
    expect(unread.state).toBe('blocked');
    expect(unread.components).toEqual([]);
    expect(unread.entities).toEqual([]);
    expect(unread.diagnostics).toContainEqual(
      expect.objectContaining({
        category: 'unsupported-unread-decider-input',
        path: '$.blueprint.wires[0][3]',
        entityNumber: 10,
        message: expect.stringContaining('connector 2'),
      }),
    );
  });

  test('returns detached frozen snapshots and observes pre-abort and own-loop cancellation', () => {
    const rows = [constantEntity(1)];
    const analysis = analysisFrom(fixtureSource(rows));
    const before = stringifyLosslessJson(analysis.document);
    const result = analyzeCanonicalBlueprintImport(analysis, selectionsFor(rows), contextFor());

    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.components)).toBe(true);
    expect(Object.isFrozen(result.networks)).toBe(true);
    expect(Object.isFrozen(result.networks[0])).toBe(true);
    expect(Object.isFrozen(result.entities)).toBe(true);
    expect(Object.isFrozen(result.entities[0])).toBe(true);
    expect(Object.isFrozen(result.entities[0]?.outputNetworks)).toBe(true);
    expect(Object.isFrozen(result.diagnostics)).toBe(true);
    expect(stringifyLosslessJson(analysis.document)).toBe(before);

    const aborted = new AbortController();
    aborted.abort();
    expect(() =>
      analyzeCanonicalBlueprintImport(analysis, selectionsFor(rows), contextFor(), {
        signal: aborted.signal,
      }),
    ).toThrowError(expect.objectContaining({ code: 'BPI1002' }));

    let reads = 0;
    const observedSignal = {
      get aborted() {
        reads += 1;
        return reads >= 6;
      },
    } as AbortSignal;
    expect(() =>
      analyzeCanonicalBlueprintImport(analysis, selectionsFor(rows), contextFor(), {
        signal: observedSignal,
      }),
    ).toThrowError(expect.objectContaining({ code: 'BPI1002' }));
    expect(reads).toBe(6);

    expect(() =>
      analyzeCanonicalBlueprintImport(analysis, selectionsFor(rows), contextFor(), {
        maxEndpoints: 1,
      }),
    ).toThrowError(expect.objectContaining({ code: 'BPI1001' }));
  });
});

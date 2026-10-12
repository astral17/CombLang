import { classifyBlueprintDocument } from '@comblang/blueprint/classification';
import { parseLosslessJson } from '@comblang/blueprint/document';
import { generateCanonicalBlueprintSource } from '@comblang/compiler/blueprint-import-source-assembly';
import { verifyCanonicalBlueprintSourceRoundTrip } from '@comblang/compiler/blueprint-import-source-verification';
import { analyzeCanonicalBlueprintImport } from '../../compiler/src/blueprint-import-canonical-families.js';
import { syntheticZeroPortEntityProfile } from '@comblang/compiler/entity-fixtures';
import { createTrustedEntityReplayContext } from '@comblang/compiler/entity-replay-context';
import type { EntityProfile, EntityProfileId } from '@comblang/compiler/entity';
import type { NativeCircuitIr, SelectorProducerConfig } from '@comblang/compiler/ir';
import type { ResolvedCircuit } from '@comblang/compiler/resolved-circuit';
import type { EntityPrototype } from '@comblang/prototypes';

import { analyzeBlueprintImport } from '@comblang/blueprint/import-analysis';
import type { EntityPrototypeResolver } from './entity-registry.js';
import { compileSourceProgram } from './source-compilation.js';

import { beforeAll, describe, expect, test } from 'vitest';

const families = [
  ['constant-combinator', 'constant-combinator'],
  ['arithmetic-combinator', 'arithmetic-combinator'],
  ['decider-combinator', 'decider-combinator'],
  ['selector-combinator', 'selector-combinator'],
] as const;

const profiles: readonly EntityProfile[] = families.map(([name, prototypeType], index) => ({
  ...syntheticZeroPortEntityProfile,
  prototypeType,
  ref: {
    ...syntheticZeroPortEntityProfile.ref,
    prototypeKey: `entity:${name}`,
    profileId: `profile:blueprint-import-selector-integration-${index}` as EntityProfileId,
  },
}));

const trustedEntityReplayContext = createTrustedEntityReplayContext({
  database: profiles[0]!.ref.database,
  source: 'synthetic',
  evidenceIdentity: 'blueprint-import-selector-integration-evidence',
  policyIdentity: 'blueprint-import-selector-integration-policy',
  profiles,
});

const prototypes: EntityPrototype[] = families.map(([name, type]) => ({
  key: `entity:${name}`,
  name,
  type,
  tileWidth: 1,
  tileHeight: 1,
}));

const entityPrototypeResolver: EntityPrototypeResolver = {
  database: trustedEntityReplayContext.database,
  getEntity(nameOrKey) {
    return prototypes.find(({ key, name }) => nameOrKey === key || nameOrKey === name);
  },
};

const inputDocument = JSON.stringify({
  blueprint: {
    entities: [
      {
        entity_number: 1,
        name: 'constant-combinator',
        position: { x: 0, y: 0 },
        direction: 4,
        control_behavior: {
          is_on: true,
          sections: {
            sections: [
              {
                index: 1,
                active: true,
                multiplier: 1,
                filters: [
                  {
                    index: 1,
                    name: 'signal-A',
                    type: 'virtual',
                    quality: 'normal',
                    comparator: '=',
                    count: 3,
                  },
                ],
              },
            ],
          },
        },
      },
      {
        entity_number: 2,
        name: 'arithmetic-combinator',
        position: { x: 3, y: 0 },
        direction: 8,
        control_behavior: {
          arithmetic_conditions: {
            first_signal: { type: 'virtual', name: 'signal-A' },
            first_signal_networks: { red: true, green: false },
            operation: '+',
            second_constant: 2,
            output_signal: { type: 'virtual', name: 'signal-B' },
          },
        },
      },
      {
        entity_number: 3,
        name: 'decider-combinator',
        position: { x: 6, y: 1 },
        direction: 12,
        control_behavior: {
          decider_conditions: {
            conditions: [
              {
                first_signal: { type: 'virtual', name: 'signal-each' },
                first_signal_networks: { red: true, green: false },
                comparator: '>',
                constant: 0,
                compare_type: 'and',
              },
            ],
            outputs: [
              {
                signal: { type: 'virtual', name: 'signal-each' },
                copy_count_from_input: true,
                networks: { red: true, green: false },
              },
            ],
          },
        },
      },
      {
        entity_number: 10,
        name: 'selector-combinator',
        position: { x: 9, y: 2 },
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
        position: { x: 12, y: 3 },
        direction: 4,
        control_behavior: {
          operation: 'count',
          count_signal: { name: 'iron-plate', quality: 'normal' },
        },
      },
      {
        entity_number: 12,
        name: 'selector-combinator',
        position: { x: 15, y: 4 },
        direction: 8,
        control_behavior: {
          operation: 'select',
          select_max: false,
          index_constant: 0,
        },
      },
      {
        entity_number: 13,
        name: 'selector-combinator',
        position: { x: 18, y: 5 },
        direction: 12,
        control_behavior: {
          operation: 'select',
          select_max: false,
          index_signal: { type: 'virtual', name: 'signal-index-default' },
        },
      },
    ],
    wires: [
      [1, 1, 2, 1],
      [2, 3, 3, 1],
      [3, 3, 10, 1],
      [10, 3, 10, 1],
      [1, 2, 10, 2],
      [3, 3, 11, 1],
      [10, 4, 11, 2],
      [3, 3, 12, 1],
      [3, 3, 13, 1],
    ],
  },
});

function compileFixture(source = inputDocument) {
  const analysis = analyzeBlueprintImport(classifyBlueprintDocument(parseLosslessJson(source)));
  const selections = (analysis.entities ?? []).map(({ entityNumber, name }) => ({
    entityNumber,
    profile: profiles.find(({ prototypeType }) => prototypeType === name)!.ref,
  }));
  const assembled = generateCanonicalBlueprintSource(
    analysis,
    selections,
    trustedEntityReplayContext,
    { path: 'selector-import-integration.factorio.ts' },
  );
  return { analysis, selections, assembled };
}

function compileSourceFixture(source = inputDocument) {
  const fixture = compileFixture(source);
  const assembled = fixture.assembled;
  if (assembled.state !== 'complete') {
    throw new Error(`Expected Selector source assembly: ${JSON.stringify(assembled.diagnostics)}`);
  }
  const compilation = compileSourceProgram(assembled.source, {
    trustedEntityReplayContext,
    entityPrototypeResolver,
  });
  const compiled = {
    source: assembled.source,
    ...(compilation.plan === undefined ? {} : { plan: compilation.plan }),
    ...(compilation.resolvedCircuit === undefined
      ? {}
      : { resolvedCircuit: compilation.resolvedCircuit }),
    diagnostics: compilation.pipelineDiagnostics,
  };
  return {
    analysis: fixture.analysis,
    selections: fixture.selections,
    assembled,
    compilation,
    compiled,
  };
}

function verify(
  fixture: ReturnType<typeof compileSourceFixture>,
  compiled = fixture.compiled,
  assembled = fixture.assembled,
) {
  return verifyCanonicalBlueprintSourceRoundTrip(
    assembled,
    compiled,
    fixture.selections,
    trustedEntityReplayContext,
  );
}

function withResolvedCircuit(
  fixture: ReturnType<typeof compileSourceFixture>,
  transform: (ir: NativeCircuitIr) => NativeCircuitIr,
) {
  const resolvedCircuit = fixture.compiled.resolvedCircuit;
  if (resolvedCircuit === undefined) throw new Error('Expected a resolved circuit.');
  return {
    ...fixture.compiled,
    resolvedCircuit: { ...resolvedCircuit, ir: transform(resolvedCircuit.ir) } as ResolvedCircuit,
  };
}

function mutateSelector(
  ir: NativeCircuitIr,
  operation: SelectorProducerConfig['operation'],
  mutate: (configuration: SelectorProducerConfig) => SelectorProducerConfig,
  includePhysical = true,
): NativeCircuitIr {
  const matched = ir.producers.filter(
    (producer) => producer.kind === 'selector' && producer.config.operation === operation,
  );
  if (matched.length === 0) throw new Error(`Expected a linked Selector ${operation}.`);
  const ids = new Set(matched.flatMap((producer) => producer.entityId ?? []));
  return {
    ...ir,
    producers: ir.producers.map((producer) =>
      producer.kind === 'selector' && producer.config.operation === operation
        ? { ...producer, config: mutate(producer.config) }
        : producer,
    ),
    ...(includePhysical
      ? {
          entities: ir.entities.map((entity) => {
            if (!ids.has(entity.id) || entity.configuration?.mode !== 'selector') return entity;
            const { mode: _mode, ...configuration } = entity.configuration;
            return {
              ...entity,
              configuration: { mode: 'selector' as const, ...mutate(configuration) },
            };
          }),
        }
      : {}),
  };
}

function blockedWithoutAssociations(result: ReturnType<typeof verify>, label: string): void {
  expect(result.state, label).toBe('blocked');
  expect(result.entities, label).toEqual([]);
  expect(result.networks, label).toEqual([]);
}

describe('compiler-side canonical Selector import integration', () => {
  let fixture: ReturnType<typeof compileSourceFixture>;

  beforeAll(() => {
    fixture = compileSourceFixture();
  });

  test('assembles, compiles, reprojects and verifies mixed families, Select, Count, and isolated lanes', () => {
    expect(
      fixture.compilation.pipelineDiagnostics.filter(({ severity }) => severity === 'error'),
    ).toEqual([]);
    const resolved = fixture.compilation.resolvedCircuit;
    if (resolved === undefined) throw new Error('Expected ordinary compilation output.');
    const result = verify(fixture);
    expect(result.state, JSON.stringify(result.diagnostics)).toBe('verified');
    expect(result.entities.map(({ entityNumber }) => entityNumber)).toEqual([
      1, 2, 3, 10, 11, 12, 13,
    ]);
    expect(result.networks).toHaveLength(fixture.assembled.correspondence.networks.length);
    expect(fixture.assembled.correspondence.entities.map(({ family }) => family)).toEqual([
      'constant',
      'arithmetic',
      'decider',
      'selector',
      'selector',
      'selector',
      'selector',
    ]);
    expect(fixture.assembled.source.text).toContain('operation:"select"');
    expect(fixture.assembled.source.text).toContain('operation:"count"');

    const bridge = analyzeCanonicalBlueprintImport(
      fixture.analysis,
      fixture.selections,
      trustedEntityReplayContext,
    );
    if (bridge.state !== 'complete')
      throw new Error('Expected canonical Selector family projection.');
    const feedback = bridge.entities.find(({ entityNumber }) => entityNumber === 10);
    const redOnly = bridge.entities.find(({ entityNumber }) => entityNumber === 13);
    const outputlessCount = bridge.entities.find(({ entityNumber }) => entityNumber === 11);
    if (
      feedback?.family !== 'selector' ||
      redOnly?.family !== 'selector' ||
      outputlessCount?.family !== 'selector'
    ) {
      throw new Error('Expected imported Selector configurations.');
    }
    expect(feedback.inputNetworks.red).toBe(feedback.outputNetworks.red);
    expect(outputlessCount.outputNetworks).toEqual({});
    const redOnlyRed = bridge.networks.find(({ network }) => network === redOnly.inputNetworks.red);
    const redOnlyGreen = bridge.networks.find(
      ({ network }) => network === redOnly.inputNetworks.green,
    );
    expect(redOnlyRed?.component.endpoints).toContainEqual({ entityNumber: 13, connectorId: 1 });
    expect(redOnlyGreen?.component.endpoints).toEqual([{ entityNumber: 13, connectorId: 2 }]);

    const selectors = resolved.ir.producers.filter((producer) => producer.kind === 'selector');
    expect(selectors).toHaveLength(4);
    const signalSelect = selectors.find(
      (producer) =>
        producer.kind === 'selector' &&
        producer.config.operation === 'select' &&
        producer.config.selectMax,
    );
    const count = selectors.find(
      (producer) => producer.kind === 'selector' && producer.config.operation === 'count',
    );
    const numericRedOnly = selectors.find(
      (producer) =>
        producer.kind === 'selector' &&
        producer.config.operation === 'select' &&
        !producer.config.selectMax,
    );
    const omittedQuality = selectors.find(
      (producer) =>
        producer.kind === 'selector' &&
        producer.config.operation === 'select' &&
        typeof producer.config.index !== 'number' &&
        producer.config.index.name === 'signal-index-default',
    );
    if (
      signalSelect?.kind !== 'selector' ||
      signalSelect.config.operation !== 'select' ||
      count?.kind !== 'selector' ||
      count.config.operation !== 'count' ||
      numericRedOnly?.kind !== 'selector' ||
      numericRedOnly.config.operation !== 'select' ||
      omittedQuality?.kind !== 'selector' ||
      omittedQuality.config.operation !== 'select'
    ) {
      throw new Error('Expected all Selector integration cases.');
    }
    expect(signalSelect.config.input.refKind).toBe('pair');
    expect(
      signalSelect.config.input.refKind === 'pair' && signalSelect.config.input.networks,
    ).toHaveLength(2);
    expect(signalSelect.config.index).toMatchObject({ name: 'signal-index', quality: 'rare' });
    expect(count.config.input.refKind).toBe('pair');
    expect(count.config.output).toMatchObject({ name: 'iron-plate', quality: 'normal' });
    expect(Object.hasOwn(count.config.output, 'quality')).toBe(true);
    expect(numericRedOnly.config.input.refKind).toBe('pair');
    if (numericRedOnly.config.operation === 'select') expect(numericRedOnly.config.index).toBe(0);
    if (
      omittedQuality.config.operation !== 'select' ||
      typeof omittedQuality.config.index === 'number'
    ) {
      throw new Error('Expected signal index with omitted quality.');
    }
    expect(Object.hasOwn(omittedQuality.config.index, 'quality')).toBe(false);
    const omittedQualityInputs = fixture.assembled.analysis.entities;
    expect(omittedQualityInputs).toHaveLength(7);

    const countCorrespondence = fixture.assembled.correspondence.entities.find(
      ({ entityNumber }) => entityNumber === 11,
    );
    expect(countCorrespondence?.attachmentSpans).toEqual([]);
    expect(result.entities).toHaveLength(7);
    for (const { producerId, entityId } of result.entities) {
      const producer = resolved.ir.producers.find(({ id }) => id === producerId);
      const physical = resolved.ir.entities.find(({ id }) => id === entityId);
      if (producer?.kind === 'selector') {
        expect(physical).toMatchObject({
          prototypeName: 'selector-combinator',
          configuration: { mode: 'selector', ...producer.config },
        });
      }
    }
  });

  test('blocks Selector producer, linked physical, profile, placement, topology and correspondence tampering atomically', () => {
    const cases: readonly [string, (ir: NativeCircuitIr) => NativeCircuitIr][] = [
      [
        'Select index and selectMax',
        (ir) =>
          mutateSelector(ir, 'select', (config) =>
            config.operation === 'select' && config.selectMax
              ? { ...config, selectMax: false, index: { type: 'virtual', name: 'signal-other' } }
              : config,
          ),
      ],
      [
        'Count output signal quality presence',
        (ir) =>
          mutateSelector(ir, 'count', (config) =>
            config.operation === 'count'
              ? { ...config, output: { type: config.output.type, name: config.output.name } }
              : config,
          ),
      ],
      [
        'lost input lane participation',
        (ir) =>
          mutateSelector(
            ir,
            'select',
            (config) =>
              config.operation === 'select' && config.selectMax && config.input.refKind === 'pair'
                ? { ...config, input: { refKind: 'single', network: config.input.networks[0] } }
                : config,
            false,
          ),
      ],
      [
        'swapped input color references',
        (ir) =>
          mutateSelector(ir, 'select', (config) =>
            config.operation === 'select' && config.selectMax && config.input.refKind === 'pair'
              ? {
                  ...config,
                  input: {
                    refKind: 'pair',
                    networks: [config.input.networks[1], config.input.networks[0]],
                  },
                }
              : config,
          ),
      ],
      [
        'linked physical Selector configuration',
        (ir) => {
          const producer = ir.producers.find(
            (candidate) => candidate.kind === 'selector' && candidate.entityId !== undefined,
          );
          if (producer?.kind !== 'selector' || producer.entityId === undefined)
            throw new Error('Expected linked Selector.');
          return {
            ...ir,
            entities: ir.entities.map((entity) =>
              entity.id === producer.entityId && entity.configuration?.mode === 'selector'
                ? {
                    ...entity,
                    configuration:
                      entity.configuration.operation === 'select'
                        ? { ...entity.configuration, selectMax: !entity.configuration.selectMax }
                        : entity.configuration,
                  }
                : entity,
            ),
          };
        },
      ],
      [
        'linked prototype',
        (ir) => {
          const producer = ir.producers.find(
            (candidate) => candidate.kind === 'selector' && candidate.entityId !== undefined,
          );
          if (producer?.kind !== 'selector' || producer.entityId === undefined)
            throw new Error('Expected linked Selector.');
          return {
            ...ir,
            entities: ir.entities.map((entity) =>
              entity.id === producer.entityId
                ? { ...entity, prototypeName: 'decider-combinator' }
                : entity,
            ),
          };
        },
      ],
      [
        'exact placement',
        (ir) => {
          const producer = ir.producers.find(
            (candidate) => candidate.kind === 'selector' && candidate.entityId !== undefined,
          );
          if (producer?.kind !== 'selector' || producer.entityId === undefined)
            throw new Error('Expected linked Selector.');
          return {
            ...ir,
            entities: ir.entities.map((entity) =>
              entity.id === producer.entityId && entity.placement !== undefined
                ? { ...entity, placement: { ...entity.placement, x: entity.placement.x + 0.25 } }
                : entity,
            ),
          };
        },
      ],
    ];
    for (const [label, mutate] of cases) {
      blockedWithoutAssociations(verify(fixture, withResolvedCircuit(fixture, mutate)), label);
    }

    const staleFamily = {
      ...fixture.assembled,
      correspondence: {
        ...fixture.assembled.correspondence,
        entities: fixture.assembled.correspondence.entities.map((entity) =>
          entity.entityNumber === 10 ? { ...entity, family: 'decider' as const } : entity,
        ),
      },
    };
    blockedWithoutAssociations(
      verify(fixture, fixture.compiled, staleFamily),
      'stale family correspondence',
    );
    const staleSource = {
      ...fixture.assembled,
      source: {
        ...fixture.assembled.source,
        text: `${fixture.assembled.source.text}\n// stale snapshot`,
      },
    };
    blockedWithoutAssociations(
      verify(fixture, fixture.compiled, staleSource),
      'stale source snapshot',
    );
  });

  test('refuses negative-zero Select and newer Selector fields without source or correspondence', () => {
    const negativeZero = inputDocument.replace('"index_constant":0', '"index_constant":-0');
    const negativeZeroFixture = compileFixture(negativeZero);
    expect(negativeZeroFixture.assembled.state).toBe('blocked');
    if (negativeZeroFixture.assembled.state !== 'blocked') throw new Error('Expected -0 refusal.');
    expect(negativeZeroFixture.assembled.source).toBeUndefined();
    expect(negativeZeroFixture.assembled.correspondence).toBeUndefined();
    expect(negativeZeroFixture.assembled.diagnostics).toContainEqual(
      expect.objectContaining({
        category: 'unsupported-source-configuration',
        path: '$.blueprint.entities[5].control_behavior.index_constant',
        entityNumber: 12,
      }),
    );

    const unsupported = inputDocument.replace(
      '"index_constant":0',
      '"index_constant":0,"select_highest_quality":true',
    );
    const unsupportedFixture = compileFixture(unsupported);
    expect(unsupportedFixture.assembled.state).toBe('blocked');
    if (unsupportedFixture.assembled.state !== 'blocked')
      throw new Error('Expected newer-field refusal.');
    expect(unsupportedFixture.assembled.source).toBeUndefined();
    expect(unsupportedFixture.assembled.correspondence).toBeUndefined();
  });
});

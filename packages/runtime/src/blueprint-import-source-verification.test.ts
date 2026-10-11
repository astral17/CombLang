import { classifyBlueprintDocument } from '@comblang/blueprint/classification';
import { parseLosslessJson } from '@comblang/blueprint/document';
import { analyzeBlueprintImport } from '@comblang/blueprint/import-analysis';
import {
  generateCanonicalBlueprintSource,
  type BlueprintSourceEntityCorrespondence,
} from '@comblang/compiler/blueprint-import-source-assembly';
import { verifyCanonicalBlueprintSourceRoundTrip } from '@comblang/compiler/blueprint-import-source-verification';
import { syntheticZeroPortEntityProfile } from '@comblang/compiler/entity-fixtures';
import type {
  EntityPhysicalRecord,
  EntityProfile,
  EntityProfileId,
} from '@comblang/compiler/entity';
import { createTrustedEntityReplayContext } from '@comblang/compiler/entity-replay-context';
import type { ArithmeticProducerConfig, NativeCircuitIr } from '@comblang/compiler/ir';
import type { ResolvedCircuit } from '@comblang/compiler/resolved-circuit';
import type { EntityPrototype } from '@comblang/prototypes';
import { Signal } from '@comblang/factorio';
import type { NetworkId } from '@comblang/shared';

import type { EntityPrototypeResolver } from './entity-registry.js';
import { compileSourceProgram } from './source-compilation.js';

import { describe, expect, test } from 'vitest';

function trustedCanonicalHost(): {
  readonly profiles: readonly EntityProfile[];
  readonly trustedEntityReplayContext: ReturnType<typeof createTrustedEntityReplayContext>;
  readonly entityPrototypeResolver: EntityPrototypeResolver;
} {
  const families = [
    ['constant-combinator', 'constant-combinator'],
    ['arithmetic-combinator', 'arithmetic-combinator'],
  ] as const;
  const profiles = families.map(([name, prototypeType], index) => ({
    ...syntheticZeroPortEntityProfile,
    prototypeType,
    ref: {
      ...syntheticZeroPortEntityProfile.ref,
      prototypeKey: `entity:${name}` as EntityProfile['ref']['prototypeKey'],
      profileId: `profile:source-verification-${index}` as EntityProfileId,
    },
  }));
  const prototypes = families.map(([name, type]) => ({
    key: `entity:${name}`,
    name,
    type,
  })) as EntityPrototype[];
  const trustedEntityReplayContext = createTrustedEntityReplayContext({
    database: profiles[0]!.ref.database,
    source: 'synthetic',
    evidenceIdentity: 'blueprint-source-verification-runtime-test-evidence',
    policyIdentity: 'blueprint-source-verification-runtime-test-policy',
    profiles,
  });
  const entityPrototypeResolver: EntityPrototypeResolver = {
    database: profiles[0]!.ref.database,
    getEntity(nameOrKey) {
      return prototypes.find(({ key, name }) => nameOrKey === key || nameOrKey === name);
    },
  };
  return { profiles, trustedEntityReplayContext, entityPrototypeResolver };
}

const host = trustedCanonicalHost();

function constantBehavior() {
  return {
    is_on: true,
    sections: {
      sections: [
        {
          index: 1,
          active: true,
          multiplier: 0.5,
          group: '',
          filters: [
            {
              index: 1,
              name: 'signal-A',
              type: 'virtual',
              quality: 'normal',
              comparator: '=',
              count: 7,
            },
            {
              index: 2,
              name: 'signal-A',
              type: 'virtual',
              quality: 'normal',
              comparator: '=',
              count: 0,
            },
            {
              index: 3,
              name: 'signal-B',
              type: 'virtual',
              quality: 'uncommon',
              comparator: '=',
              count: -3,
            },
          ],
        },
      ],
    },
  };
}

function arithmeticBehavior(mask: { readonly red: boolean; readonly green: boolean }) {
  return {
    arithmetic_conditions: {
      first_signal: { type: 'virtual', name: 'signal-A' },
      first_signal_networks: mask,
      operation: '+',
      second_constant: 2,
      output_signal: { type: 'virtual', name: 'signal-B' },
    },
  };
}

const sourceDocument = JSON.stringify({
  blueprint: {
    entities: [
      {
        entity_number: 12,
        name: 'arithmetic-combinator',
        position: { x: 0, y: 4 },
        direction: 4,
        control_behavior: arithmeticBehavior({ red: true, green: true }),
      },
      {
        entity_number: 400,
        name: 'constant-combinator',
        position: { x: 8, y: -1 },
        direction: 15,
        control_behavior: constantBehavior(),
      },
      {
        entity_number: 11,
        name: 'arithmetic-combinator',
        position: { x: 0, y: 4 },
        direction: 0,
        control_behavior: arithmeticBehavior({ red: true, green: false }),
      },
      {
        entity_number: 13,
        name: 'arithmetic-combinator',
        position: { x: 0, y: 4 },
        direction: 8,
        control_behavior: arithmeticBehavior({ red: true, green: false }),
      },
    ],
    wires: [
      [400, 1, 11, 1],
      [400, 1, 12, 1],
      [12, 3, 12, 1],
      [12, 4, 12, 2],
    ],
  },
})
  .replace('"x":8,"y":-1', '"x":-0,"y":-1')
  .replace('"multiplier":0.5', '"multiplier":0');

function compileFixture(documentText = sourceDocument) {
  const analysis = analyzeBlueprintImport(
    classifyBlueprintDocument(parseLosslessJson(documentText)),
  );
  const selections = (analysis.entities ?? []).map(({ entityNumber, name }) => ({
    entityNumber,
    profile: host.profiles.find(({ prototypeType }) => prototypeType === name)!.ref,
  }));
  const assembled = generateCanonicalBlueprintSource(
    analysis,
    selections,
    host.trustedEntityReplayContext,
    { path: 'verified-round-trip.factorio.ts' },
  );
  if (assembled.state !== 'complete') {
    throw new Error(`Expected source assembly: ${JSON.stringify(assembled.diagnostics)}`);
  }
  const compilation = compileSourceProgram(assembled.source, {
    trustedEntityReplayContext: host.trustedEntityReplayContext,
    entityPrototypeResolver: host.entityPrototypeResolver,
  });
  const compiled = {
    source: assembled.source,
    ...(compilation.plan === undefined ? {} : { plan: compilation.plan }),
    ...(compilation.resolvedCircuit === undefined
      ? {}
      : { resolvedCircuit: compilation.resolvedCircuit }),
    diagnostics: compilation.pipelineDiagnostics,
  };
  return { analysis, selections, assembled, compilation, compiled };
}

function withResolvedCircuit<T extends ReturnType<typeof compileFixture>>(
  fixture: T,
  transform: (ir: NativeCircuitIr) => NativeCircuitIr,
): T['compiled'] {
  const resolvedCircuit = fixture.compiled.resolvedCircuit;
  if (resolvedCircuit === undefined) throw new Error('Fixture compilation has no ResolvedCircuit.');
  const mutated: ResolvedCircuit = {
    ...resolvedCircuit,
    ir: transform(resolvedCircuit.ir),
  };
  return { ...fixture.compiled, resolvedCircuit: mutated };
}

function verify(fixture: ReturnType<typeof compileFixture>, compiled = fixture.compiled) {
  return verifyCanonicalBlueprintSourceRoundTrip(
    fixture.assembled,
    compiled,
    fixture.selections,
    host.trustedEntityReplayContext,
  );
}

function sourceFor(entities: readonly BlueprintSourceEntityCorrespondence[], entityNumber: number) {
  return entities.find(({ entityNumber: candidate }) => candidate === entityNumber)!
    .constructionSpan;
}

describe('ordinary runtime compilation of assembled blueprints through round-trip verification', () => {
  test('accepts fractional multipliers but reports negative-zero normalization by native JSON', () => {
    const fractional = compileFixture(sourceDocument.replace('"multiplier":0', '"multiplier":0.5'));
    const fractionalResult = verify(fractional);
    expect(fractionalResult.state, JSON.stringify(fractionalResult.diagnostics)).toBe('verified');

    const negativeZero = compileFixture(
      sourceDocument.replace('"multiplier":0', '"multiplier":-0'),
    );
    expect(
      negativeZero.compilation.pipelineDiagnostics.filter(({ severity }) => severity === 'error'),
    ).toEqual([]);
    const result = verify(negativeZero);
    expect(result.state).toBe('blocked');
    expect(result.entities).toEqual([]);
    expect(result.networks).toEqual([]);
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        category: 'source-verification-mismatch',
        entityNumber: 400,
        message:
          'Reprojected native configuration or Arithmetic input mask differs from the imported source.',
        source: sourceFor(negativeZero.assembled.correspondence.entities, 400),
      }),
    );
  });

  test('verifies Each Arithmetic input and output through ordinary compilation and native re-import', () => {
    const eachDocument = sourceDocument
      .replace(
        '"first_signal":{"type":"virtual","name":"signal-A"}',
        '"first_signal":{"type":"virtual","name":"signal-each"}',
      )
      .replace(
        '"output_signal":{"type":"virtual","name":"signal-B"}',
        '"output_signal":{"type":"virtual","name":"signal-each"}',
      );
    const fixture = compileFixture(eachDocument);
    const eachSource = sourceFor(fixture.assembled.correspondence.entities, 12);
    const resolved = fixture.compiled.resolvedCircuit;
    if (resolved === undefined) throw new Error('Fixture compilation has no ResolvedCircuit.');
    const arithmetic = resolved.ir.producers.find(
      ({ kind, provenance }) =>
        kind === 'arithmetic' && provenance.source?.start === eachSource.start,
    );
    if (arithmetic?.kind !== 'arithmetic' || arithmetic.entityId === undefined) {
      throw new Error('Fixture has no linked Each Arithmetic producer.');
    }
    expect(arithmetic.config).toMatchObject({
      left: { kind: 'each', refKind: 'pair' },
      output: { kind: 'each' },
    });
    const physical = resolved.ir.entities.find(({ id }) => id === arithmetic.entityId);
    expect(physical?.configuration).toMatchObject({
      mode: 'arithmetic',
      left: { kind: 'each', refKind: 'pair' },
      output: { kind: 'each' },
    });

    const result = verify(fixture);
    expect(result.state, JSON.stringify(result.diagnostics)).toBe('verified');
    expect(result.entities.find(({ entityNumber }) => entityNumber === 12)).toBeDefined();
  });

  test('verifies shuffled IDs, repeated placement, fanout, feedback, dual outputs, singleton inputs, and warnings', () => {
    const fixture = compileFixture();
    const sourceBefore = fixture.assembled.source.text;
    const resolvedBefore = JSON.stringify(fixture.compiled.resolvedCircuit);
    const result = verify(fixture);

    expect(fixture.compilation.pipelineDiagnostics).toContainEqual(
      expect.objectContaining({ code: 'CL2001', severity: 'warning' }),
    );
    expect(result.state, JSON.stringify(result.diagnostics)).toBe('verified');
    expect(result.entities.map(({ entityNumber }) => entityNumber)).toEqual([12, 400, 11, 13]);
    expect(result.networks.length).toBeGreaterThan(1);
    const resolved = fixture.compiled.resolvedCircuit;
    if (resolved === undefined) throw new Error('Fixture compilation has no ResolvedCircuit.');
    expect(resolved.ir.networks.length).toBeGreaterThan(result.networks.length);
    const negativeZeroPlacement = resolved.ir.entities.find(
      ({ provenance }) =>
        provenance.source?.start ===
        sourceFor(fixture.assembled.correspondence.entities, 400).start,
    )?.placement;
    expect(negativeZeroPlacement).toBeDefined();
    expect(Object.is(negativeZeroPlacement?.x, -0)).toBe(true);
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({ code: 'CL2001', severity: 'warning' }),
    );
    expect(fixture.assembled.source.text).toBe(sourceBefore);
    expect(JSON.stringify(fixture.compiled.resolvedCircuit)).toBe(resolvedBefore);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.entities[0])).toBe(true);
    expect(Object.isFrozen(result.networks[0])).toBe(true);
  });

  test('rejects producer, profile, and physical placement mismatches without partial associations', () => {
    const fixture = compileFixture();
    const resolved = fixture.compiled.resolvedCircuit;
    if (resolved === undefined) throw new Error('Fixture compilation has no ResolvedCircuit.');
    const arithmetic = resolved.ir.producers.find(({ kind }) => kind === 'arithmetic');
    if (arithmetic?.kind !== 'arithmetic' || arithmetic.entityId === undefined) {
      throw new Error('Fixture has no linked Arithmetic producer.');
    }

    const changedConfiguration = withResolvedCircuit(fixture, (ir) => ({
      ...ir,
      producers: ir.producers.map((producer) =>
        producer.id === arithmetic.id && producer.kind === 'arithmetic'
          ? { ...producer, config: { ...producer.config, operation: 'multiply' as const } }
          : producer,
      ),
      entities: ir.entities.map((entity) =>
        entity.id === arithmetic.entityId && entity.configuration?.mode === 'arithmetic'
          ? {
              ...entity,
              configuration: { ...entity.configuration, operation: 'multiply' as const },
            }
          : entity,
      ),
    }));
    const wrongConfiguration = verify(fixture, changedConfiguration);
    expect(wrongConfiguration.state).toBe('blocked');
    expect(wrongConfiguration.entities).toEqual([]);
    expect(wrongConfiguration.networks).toEqual([]);
    expect(wrongConfiguration.diagnostics).toContainEqual(
      expect.objectContaining({
        category: 'source-verification-mismatch',
        path: '$.blueprint.entities[0]',
        entityNumber: 12,
        message:
          'Compiled Arithmetic producer configuration or Network references differ from the import.',
        source: sourceFor(fixture.assembled.correspondence.entities, 12),
      }),
    );

    const changedProfile = withResolvedCircuit(fixture, (ir) => ({
      ...ir,
      entities: ir.entities.map((entity) =>
        entity.id === arithmetic.entityId
          ? {
              ...entity,
              profile: {
                ...entity.profile,
                profileId: 'profile:other-arithmetic' as EntityProfileId,
              },
            }
          : entity,
      ),
    }));
    expect(verify(fixture, changedProfile)).toMatchObject({
      state: 'blocked',
      entities: [],
      networks: [],
    });

    const changedPlacement = withResolvedCircuit(fixture, (ir) => ({
      ...ir,
      entities: ir.entities.map((entity) =>
        entity.id === arithmetic.entityId && entity.placement !== undefined
          ? { ...entity, placement: { ...entity.placement, x: entity.placement.x + 1 } }
          : entity,
      ),
    }));
    expect(verify(fixture, changedPlacement)).toMatchObject({
      state: 'blocked',
      entities: [],
      networks: [],
    });
  });

  test('accepts normal-quality aliases and allows unused logical output views', () => {
    const fixture = compileFixture();
    const resolved = fixture.compiled.resolvedCircuit;
    if (resolved === undefined) throw new Error('Fixture compilation has no ResolvedCircuit.');
    const constant = resolved.ir.producers.find(({ kind }) => kind === 'constant');
    if (
      constant?.kind !== 'constant' ||
      !('configuration' in constant.config) ||
      constant.entityId === undefined
    ) {
      throw new Error('Fixture has no linked exact Constant producer.');
    }

    const normalAlias = withResolvedCircuit(fixture, (ir) => ({
      ...ir,
      producers: ir.producers.map((producer) =>
        producer.id === constant.id &&
        producer.kind === 'constant' &&
        'configuration' in producer.config
          ? {
              ...producer,
              config: {
                configuration: {
                  ...producer.config.configuration,
                  sections: producer.config.configuration.sections.map((section) => ({
                    ...section,
                    filters: section.filters.map((filter) => ({
                      ...filter,
                      signal:
                        filter.signal.quality === 'normal'
                          ? Signal(filter.signal.type, filter.signal.name)
                          : filter.signal,
                    })),
                  })),
                },
              },
            }
          : producer,
      ),
      entities: ir.entities.map((entity) =>
        entity.id === constant.entityId && entity.configuration?.mode === 'constant'
          ? {
              ...entity,
              configuration: {
                ...entity.configuration,
                value: {
                  ...entity.configuration.value,
                  sections: entity.configuration.value.sections.map((section) => ({
                    ...section,
                    filters: section.filters.map((filter) => ({
                      ...filter,
                      signal:
                        filter.signal.quality === 'normal'
                          ? Signal(filter.signal.type, filter.signal.name)
                          : filter.signal,
                    })),
                  })),
                },
              },
            }
          : entity,
      ),
    }));
    expect(verify(fixture, normalAlias).state).toBe('verified');

    const changedConstant = withResolvedCircuit(fixture, (ir) => ({
      ...ir,
      producers: ir.producers.map((producer) =>
        producer.id === constant.id &&
        producer.kind === 'constant' &&
        'configuration' in producer.config
          ? {
              ...producer,
              config: {
                configuration: {
                  ...producer.config.configuration,
                  sections: producer.config.configuration.sections.map((section) => ({
                    ...section,
                    multiplier: -0,
                    filters: section.filters.filter((_, index) => index !== 1),
                  })),
                },
              },
            }
          : producer,
      ),
      entities: ir.entities.map((entity) =>
        entity.id === constant.entityId && entity.configuration?.mode === 'constant'
          ? {
              ...entity,
              configuration: {
                ...entity.configuration,
                value: {
                  ...entity.configuration.value,
                  sections: entity.configuration.value.sections.map((section) => ({
                    ...section,
                    multiplier: -0,
                    filters: section.filters.filter((_, index) => index !== 1),
                  })),
                },
              },
            }
          : entity,
      ),
    }));
    const changedConstantResult = verify(fixture, changedConstant);
    expect(changedConstantResult.state).toBe('blocked');
    expect(changedConstantResult.diagnostics).toContainEqual(
      expect.objectContaining({
        category: 'source-verification-mismatch',
        entityNumber: 400,
      }),
    );

    const foreignOutput = withResolvedCircuit(fixture, (ir) => ({
      ...ir,
      producers: ir.producers.map((producer) =>
        producer.id === constant.id && producer.kind === 'constant'
          ? {
              ...producer,
              destinations: [
                ...producer.destinations,
                ir.networks.find(({ id }) => !producer.destinations.includes(id))!.id,
              ],
            }
          : producer,
      ),
    }));
    const unexpectedParticipation = verify(fixture, foreignOutput);
    expect(unexpectedParticipation).toMatchObject({
      state: 'blocked',
      entities: [],
      networks: [],
    });
    expect(unexpectedParticipation.diagnostics).toContainEqual(
      expect.objectContaining({
        code: 'RSC1001',
        message: expect.stringContaining('opposite colors'),
      }),
    );
  });

  test('rejects added physical endpoint participation after native projection', () => {
    const fixture = compileFixture();
    const baseline = verify(fixture);
    expect(baseline.state, JSON.stringify(baseline.diagnostics)).toBe('verified');
    const constant = baseline.entities.find(({ entityNumber }) => entityNumber === 400);
    const singletonArithmetic = baseline.entities.find(({ entityNumber }) => entityNumber === 13);
    if (constant === undefined || singletonArithmetic === undefined) {
      throw new Error('Fixture lacks expected physical entity associations.');
    }

    const extraNetwork = 'network:source-verification-foreign-wire' as NetworkId;
    const bindRedEndpoint = (entity: EntityPhysicalRecord) => ({
      endpoint: {
        connector:
          'connector:verification' as EntityPhysicalRecord['connectorBindings'][number]['endpoint']['connector'],
        lane: 'lane:verification-red' as EntityPhysicalRecord['connectorBindings'][number]['endpoint']['lane'],
        color: 'red' as const,
      },
      network: extraNetwork,
      nativeConnector: 1,
      generation: 0,
      direction: 'output' as const,
      provenance: {
        source: entity.provenance.source,
        instancePath: [],
        operationOrdinal: 1,
      },
    });
    const withForeignWire = withResolvedCircuit(fixture, (ir) => ({
      ...ir,
      networks: [
        ...ir.networks,
        {
          id: extraNetwork,
          color: 'red' as const,
          fixedColor: 'red' as const,
          provenance: { instancePath: [], expansionStack: [] },
        },
      ],
      entities: ir.entities.map((entity) =>
        entity.id === constant.entityId || entity.id === singletonArithmetic.entityId
          ? { ...entity, connectorBindings: [...entity.connectorBindings, bindRedEndpoint(entity)] }
          : entity,
      ),
    }));

    const result = verify(fixture, withForeignWire);
    expect(result.state).toBe('blocked');
    expect(result.entities).toEqual([]);
    expect(result.networks).toEqual([]);
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        category: 'source-verification-mismatch',
        path: '$.nativeProjection.networks',
        message: expect.stringContaining('partition'),
      }),
    );
  });

  test('preserves pair order and rejects missing or duplicate source provenance and extra Entities', () => {
    const fixture = compileFixture();
    const resolved = fixture.compiled.resolvedCircuit;
    if (resolved === undefined) throw new Error('Fixture compilation has no ResolvedCircuit.');
    const arithmetic = resolved.ir.producers.find(({ kind }) => kind === 'arithmetic');
    if (arithmetic?.kind !== 'arithmetic' || arithmetic.entityId === undefined) {
      throw new Error('Fixture has no linked Arithmetic producer.');
    }
    const physical = resolved.ir.entities.find(({ id }) => id === arithmetic.entityId);
    if (physical?.configuration?.mode !== 'arithmetic') {
      throw new Error('Fixture has no typed Arithmetic Entity configuration.');
    }
    const reversePair = (config: ArithmeticProducerConfig): ArithmeticProducerConfig => {
      const operand = config.left;
      if (operand.kind !== 'signal' || operand.refKind !== 'pair') return config;
      return {
        ...config,
        left: { ...operand, networks: [operand.networks[1], operand.networks[0]] },
      };
    };
    const reversedPair = withResolvedCircuit(fixture, (ir) => ({
      ...ir,
      producers: ir.producers.map((producer) =>
        producer.id === arithmetic.id && producer.kind === 'arithmetic'
          ? { ...producer, config: reversePair(producer.config) }
          : producer,
      ),
      entities: ir.entities.map((entity) =>
        entity.id === physical.id && entity.configuration?.mode === 'arithmetic'
          ? {
              ...entity,
              configuration: {
                ...entity.configuration,
                ...reversePair(entity.configuration),
              },
            }
          : entity,
      ),
    }));
    const pairResult = verify(fixture, reversedPair);
    expect(pairResult.state).toBe('blocked');
    expect(pairResult.diagnostics).toContainEqual(
      expect.objectContaining({
        category: 'source-verification-mismatch',
        message: expect.stringContaining('configuration'),
      }),
    );

    const changedFamily = withResolvedCircuit(fixture, (ir) => ({
      ...ir,
      producers: ir.producers.map((producer) =>
        producer.id === arithmetic.id
          ? ({ ...producer, kind: 'constant', config: { outputs: [] } } as typeof producer)
          : producer,
      ),
    }));
    expect(verify(fixture, changedFamily).state).toBe('blocked');

    const { entityId: _linkedEntityId, ...unlinkedArithmetic } = arithmetic;
    const extraProducer = {
      ...unlinkedArithmetic,
      id: 'producer:source-verification-extra' as typeof arithmetic.id,
    };
    const extraProducerResult = verify(
      fixture,
      withResolvedCircuit(fixture, (ir) => ({
        ...ir,
        producers: [...ir.producers, extraProducer],
      })),
    );
    expect(extraProducerResult.state).toBe('blocked');
    expect(extraProducerResult.diagnostics).toContainEqual(
      expect.objectContaining({
        category: 'source-verification-mismatch',
        path: '$.resolvedCircuit.ir.producers',
      }),
    );

    const arithmeticRows = resolved.ir.producers.filter(({ kind }) => kind === 'arithmetic');
    if (arithmeticRows.length < 2) throw new Error('Fixture needs repeated Arithmetic producers.');
    const [first, second] = arithmeticRows;
    const firstSource = first?.provenance.source;
    const secondSource = second?.provenance.source;
    if (
      first === undefined ||
      second === undefined ||
      firstSource === undefined ||
      secondSource === undefined
    ) {
      throw new Error('Fixture Arithmetic provenance is missing.');
    }
    const missingSource = withResolvedCircuit(fixture, (ir) => ({
      ...ir,
      producers: ir.producers.map((producer) =>
        producer.id === first.id && producer.provenance.source !== undefined
          ? {
              ...producer,
              provenance: {
                ...producer.provenance,
                source: {
                  ...firstSource,
                  start: firstSource.start + 1,
                },
              },
            }
          : producer,
      ),
    }));
    expect(verify(fixture, missingSource).state).toBe('blocked');

    const duplicateSource = withResolvedCircuit(fixture, (ir) => ({
      ...ir,
      producers: ir.producers.map((producer) =>
        producer.id === second.id
          ? { ...producer, provenance: { ...producer.provenance, source: firstSource } }
          : producer,
      ),
    }));
    expect(verify(fixture, duplicateSource).state).toBe('blocked');

    const extraEntity = withResolvedCircuit(fixture, (ir) => {
      const { configuration: _configuration, ...unconfiguredEntity } = ir.entities[0]!;
      return {
        ...ir,
        entities: [
          ...ir.entities,
          {
            ...unconfiguredEntity,
            id: 'entity:source-verification-extra' as (typeof ir.entities)[number]['id'],
            ordinal: Math.max(...ir.entities.map(({ ordinal }) => ordinal)) + 1,
          },
        ],
      };
    });
    const extraEntityResult = verify(fixture, extraEntity);
    expect(extraEntityResult.state).toBe('blocked');
    expect(extraEntityResult.diagnostics).toContainEqual(
      expect.objectContaining({
        category: 'source-verification-mismatch',
        path: '$.resolvedCircuit.ir.entities',
      }),
    );
  });

  test('keeps physically wired unread Arithmetic inputs as an upstream import refusal', () => {
    const unreadDocument = sourceDocument.replace(
      '"wires":[[400,1,11,1]',
      '"wires":[[400,2,11,2],[400,1,11,1]',
    );
    const analysis = analyzeBlueprintImport(
      classifyBlueprintDocument(parseLosslessJson(unreadDocument)),
    );
    const selections = (analysis.entities ?? []).map(({ entityNumber, name }) => ({
      entityNumber,
      profile: host.profiles.find(({ prototypeType }) => prototypeType === name)!.ref,
    }));
    const assembled = generateCanonicalBlueprintSource(
      analysis,
      selections,
      host.trustedEntityReplayContext,
      { path: 'wired-unread.factorio.ts' },
    );
    expect(assembled.state).toBe('blocked');
    expect(assembled.diagnostics).toContainEqual(
      expect.objectContaining({
        category: 'unsupported-unread-arithmetic-input',
        path: '$.blueprint.wires[0][3]',
        entityNumber: 11,
      }),
    );
  });
});

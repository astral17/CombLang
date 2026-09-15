import { describe, expect, test } from 'vitest';
import { signal } from '@comblang/factorio';
import type { EntityId, EntityProfile } from '@comblang/compiler/entity';
import {
  assertResolvedEntityV5CircuitMatchesPlan,
  parseResolvedEntityV5Circuit,
} from '@comblang/compiler/resolved-entity-v5';
import {
  createTrustedEntityReplayContext,
  entityReplayContextRef,
} from '@comblang/compiler/entity-replay-context';
import { syntheticZeroPortEntityProfile } from '@comblang/compiler/entity-fixtures';
import type { DirectElaborationPlanV5 } from '@comblang/compiler/entity-v5';
import { sourceFileId, sourceSpan } from '@comblang/shared';
import { tryElaborateEntityV5DirectPlan } from './entity-v5.js';
import { hydrateResolvedEntityV5Circuit } from './resolved-entity-v5.js';

const source = sourceSpan(sourceFileId('resolved-entity-v5.ts'), 0, 1);

function fixture(): {
  context: ReturnType<typeof createTrustedEntityReplayContext>;
  plan: DirectElaborationPlanV5;
} {
  const profile: EntityProfile = {
    ...structuredClone(syntheticZeroPortEntityProfile),
    ref: {
      ...syntheticZeroPortEntityProfile.ref,
      prototypeKey: 'entity:fixture-arithmetic',
      profileId: 'profile:fixture-arithmetic-v5' as EntityProfile['ref']['profileId'],
    },
    prototypeType: 'arithmetic-combinator',
  };
  const context = createTrustedEntityReplayContext({
    database: profile.ref.database,
    source: 'synthetic',
    evidenceIdentity: 'resolved-v5-evidence',
    policyIdentity: 'resolved-v5-policy',
    profiles: [profile],
  });
  const configuration = {
    mode: 'arithmetic' as const,
    left: { kind: 'constant' as const, value: 2 },
    operation: 'multiply' as const,
    right: { kind: 'constant' as const, value: 3 },
    output: { kind: 'signal' as const, signal: signal('virtual', 'signal-A') },
  };
  const { mode: _mode, ...producerConfiguration } = configuration;
  return {
    context,
    plan: {
      format: 'comblang-direct-plan',
      version: 5,
      context: entityReplayContextRef(context),
      networks: [{ name: 'out', fixedColor: 'red', generation: 0, source, instancePath: [] }],
      producers: [
        {
          kind: 'arithmetic',
          entityId: 'entity:1' as EntityId,
          ...producerConfiguration,
          destinations: [{ network: 'out', source, instancePath: ['Arithmetic'] }],
          source,
          instancePath: ['Arithmetic'],
        },
      ],
      entities: [
        {
          id: 'entity:1' as EntityId,
          profile: profile.ref,
          configuration,
          connectorBindings: [],
          placement: { x: 3, y: 4 },
          provenance: {
            source,
            instancePath: ['Entity:1'],
            expansionStack: [],
            creationRevision: 1,
          },
          ordinal: 1,
        },
      ],
    },
  };
}

describe('resolved Entity v5 transport', () => {
  test('round-trips a detached linked Arithmetic snapshot and hydrates it', () => {
    const { context, plan } = fixture();
    const result = tryElaborateEntityV5DirectPlan(plan, context);
    expect(result.diagnostics).toEqual([]);
    const artifact = result.resolvedCircuit!;
    const snapshot = parseResolvedEntityV5Circuit(artifact);

    expect(structuredClone(snapshot)).toEqual(snapshot);
    expect(snapshot.ir.version).toBe(5);
    expect(snapshot.ir.entities[0]?.configuration).toMatchObject({ mode: 'arithmetic' });
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.ir)).toBe(true);
    const arithmeticProducer = snapshot.ir.producers[0];
    if (arithmeticProducer?.kind !== 'arithmetic')
      throw new Error('Expected an arithmetic producer.');
    const arithmeticEntity = snapshot.ir.entities[0]?.configuration;
    if (arithmeticEntity?.mode !== 'arithmetic')
      throw new Error('Expected an arithmetic Entity configuration.');
    expect(Object.isFrozen(arithmeticProducer.config.left)).toBe(true);
    expect(Object.isFrozen(arithmeticEntity.left)).toBe(true);
    expect(Reflect.set(arithmeticEntity.left as object, 'value', 99)).toBe(false);
    expect((arithmeticEntity.left as unknown as { value: number }).value).toBe(2);
    expect(Object.isFrozen(snapshot.ir.entities[0]?.placement)).toBe(true);
    expect(Object.isFrozen(snapshot.ir.entities[0]?.provenance.instancePath)).toBe(true);
    expect(Object.isFrozen(snapshot.ir.entities[0])).toBe(true);
    expect(() => assertResolvedEntityV5CircuitMatchesPlan(plan, snapshot)).not.toThrow();

    const callerOwnedArtifact = structuredClone(artifact) as typeof artifact;
    const reparsed = parseResolvedEntityV5Circuit(callerOwnedArtifact);
    expect(Object.isFrozen(callerOwnedArtifact.ir)).toBe(false);
    expect(Object.isFrozen(callerOwnedArtifact.ir.entities[0]?.configuration)).toBe(false);
    const reparsedConfiguration = reparsed.ir.entities[0]?.configuration;
    if (reparsedConfiguration?.mode !== 'arithmetic')
      throw new Error('Expected a reparsed arithmetic Entity configuration.');
    expect(Object.isFrozen(reparsedConfiguration.left)).toBe(true);

    const runtime = hydrateResolvedEntityV5Circuit(artifact);
    expect(runtime.ir.version).toBe(5);
    expect(runtime.networks).toHaveLength(1);
    const hydratedConfiguration = runtime.artifact.ir.entities[0]?.configuration;
    if (hydratedConfiguration?.mode !== 'arithmetic')
      throw new Error('Expected a hydrated arithmetic Entity configuration.');
    expect(Object.isFrozen(hydratedConfiguration.left)).toBe(true);
    expect(runtime.ir.producers).toHaveLength(1);
    expect(runtime.ir.producers[0]?.kind).toBe('arithmetic');
    expect(
      runtime
        .createSimulation()
        .step()
        .read(runtime.networks[0]!.id)
        .get(signal('virtual', 'signal-A')),
    ).toBe(6);
  });

  test('rejects cross-version, stale, unknown-field, association, and configuration tampering', () => {
    const { context, plan } = fixture();
    const result = tryElaborateEntityV5DirectPlan(plan, context);
    const artifact = result.resolvedCircuit!;

    expect(() =>
      parseResolvedEntityV5Circuit({ ...artifact, format: 'comblang-resolved-source-circuit' }),
    ).toThrow();
    expect(() =>
      parseResolvedEntityV5Circuit({ ...artifact, ir: { ...artifact.ir, version: 4 } }),
    ).toThrow(/version/);
    expect(() =>
      parseResolvedEntityV5Circuit({
        ...artifact,
        ir: {
          ...artifact.ir,
          entities: artifact.ir.entities.map((entity) => ({ ...entity, unexpected: true })),
        },
      }),
    ).toThrow(/unknown resolved/);
    expect(() =>
      parseResolvedEntityV5Circuit({
        ...artifact,
        ir: {
          ...artifact.ir,
          producers: artifact.ir.producers.map((producer) => ({
            ...producer,
            entityId: 'entity:missing',
          })),
        },
      }),
    ).toThrow(/does not exist/);
    expect(() =>
      parseResolvedEntityV5Circuit({
        ...artifact,
        ir: {
          ...artifact.ir,
          entities: artifact.ir.entities.map((entity) => ({
            ...entity,
            configuration: { ...entity.configuration!, operation: 'add' },
          })),
        },
      }),
    ).toThrow(/does not match/);
    expect(() =>
      assertResolvedEntityV5CircuitMatchesPlan(
        { ...plan, context: { ...plan.context, evidenceIdentity: 'stale' } },
        artifact,
      ),
    ).toThrow(/fingerprint/);
  });
});

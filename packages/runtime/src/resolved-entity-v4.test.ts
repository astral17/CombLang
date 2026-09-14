import { describe, expect, test } from 'vitest';
import { signal } from '@comblang/factorio';
import { sourceFileId, sourceSpan } from '@comblang/shared';
import type { EntityId, EntityProfile } from '@comblang/compiler/entity';
import type { DirectElaborationPlanV4 } from '@comblang/compiler/entity-v4';
import {
  createTrustedEntityReplayContext,
  entityReplayContextRef,
} from '@comblang/compiler/entity-replay-context';
import { syntheticZeroPortEntityProfile } from '@comblang/compiler/entity-fixtures';
import {
  parseResolvedEntityV4Circuit,
  assertResolvedEntityV4CircuitMatchesPlan,
} from '@comblang/compiler/resolved-entity-v4';
import { parseResolvedSourceCircuit } from '@comblang/compiler/resolved-source-circuit';
import { tryElaborateEntityV4DirectPlan } from './entity-v4.js';
import { hydrateResolvedEntityV4Circuit } from './resolved-entity-v4.js';

const source = sourceSpan(sourceFileId('resolved-v4.ts'), 0, 1);

function artifactFixture() {
  const profile: EntityProfile = {
    ...structuredClone(syntheticZeroPortEntityProfile),
    ref: {
      ...syntheticZeroPortEntityProfile.ref,
      prototypeKey: 'entity:fixture-constant',
      profileId: 'profile:fixture-constant-v1' as EntityProfile['ref']['profileId'],
    },
    prototypeType: 'constant-combinator',
  };
  const context = createTrustedEntityReplayContext({
    database: profile.ref.database,
    source: 'synthetic',
    evidenceIdentity: 'resolved-v4-evidence',
    policyIdentity: 'resolved-v4-policy',
    profiles: [profile],
  });
  const plan: DirectElaborationPlanV4 = {
    format: 'comblang-direct-plan' as const,
    version: 4 as const,
    context: entityReplayContextRef(context),
    networks: [
      { name: 'out', fixedColor: 'red' as const, generation: 0, source, instancePath: [] },
    ],
    producers: [
      {
        kind: 'constant' as const,
        entityId: 'entity:1' as EntityId,
        outputs: [{ signal: signal('virtual', 'signal-A'), value: 7 }],
        destinations: [{ network: 'out', source, instancePath: ['Constant'] }],
        source,
        instancePath: ['Constant'],
      },
    ],
    entities: [
      {
        id: 'entity:1' as EntityId,
        profile: profile.ref,
        configuration: {
          mode: 'constant' as const,
          value: {
            isOn: true,
            sections: [
              {
                active: true,
                multiplier: 1,
                filters: [{ signal: signal('virtual', 'signal-A'), value: 7 }],
              },
            ],
          },
        },
        connectorBindings: [],
        placement: { x: 10, y: 20 },
        provenance: { source, instancePath: ['Entity:1'], expansionStack: [], creationRevision: 1 },
        ordinal: 1,
      },
    ],
  };
  const result = tryElaborateEntityV4DirectPlan(plan, context);
  if (!result.execution || result.resolvedCircuit === undefined)
    throw new Error(result.diagnostics[0]?.message ?? 'fixture failed');
  return {
    plan,
    artifact: result.resolvedCircuit,
  };
}

describe('resolved Entity v4 transport', () => {
  test('parses a detached profile-free snapshot and hydrates existing simulation semantics', () => {
    const { artifact } = artifactFixture();
    const snapshot = parseResolvedEntityV4Circuit(artifact);
    expect(structuredClone(snapshot)).toEqual(snapshot);
    expect(snapshot.ir.version).toBe(4);
    expect(snapshot.ir.entities[0]?.configuration).toMatchObject({ mode: 'constant' });
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.ir.entities[0])).toBe(true);
    assertResolvedEntityV4CircuitMatchesPlan(artifactFixture().plan, snapshot);

    const runtime = hydrateResolvedEntityV4Circuit(artifact);
    const network = runtime.network(runtime.ir.networks[0]!.id);
    expect(
      runtime.createSimulation().step().read(network.id).get(signal('virtual', 'signal-A')),
    ).toBe(7);
    expect(runtime.networks[0]).toBe(network);
  });

  test('rejects cross-version envelopes and tampered linked configuration', () => {
    const { artifact, plan } = artifactFixture();
    expect(() =>
      parseResolvedEntityV4Circuit({
        ...artifact,
        format: 'comblang-resolved-source-circuit',
      }),
    ).toThrow();
    expect(() => parseResolvedSourceCircuit(artifact)).toThrow(/format/);
    expect(() =>
      parseResolvedEntityV4Circuit({
        ...artifact,
        ir: { ...artifact.ir, version: 3 },
      }),
    ).toThrow(/version/);
    expect(() =>
      parseResolvedEntityV4Circuit({
        ...artifact,
        ir: {
          ...artifact.ir,
          entities: artifact.ir.entities.map((entity) => ({
            ...entity,
            configuration: { mode: 'constant', value: { isOn: true, sections: [] } },
          })),
        },
      }),
    ).toThrow(/outputs/);
    expect(() =>
      assertResolvedEntityV4CircuitMatchesPlan(
        { ...plan, context: { ...plan.context, evidenceIdentity: 'stale' } },
        parseResolvedEntityV4Circuit(artifact),
      ),
    ).toThrow(/fingerprint/);
    expect(() =>
      assertResolvedEntityV4CircuitMatchesPlan(
        plan,
        parseResolvedEntityV4Circuit({ ...artifact, planFingerprint: 'v4-ffffffffffffffff' }),
      ),
    ).toThrow(/fingerprint/);
    expect(() =>
      parseResolvedEntityV4Circuit({
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
      parseResolvedEntityV4Circuit({
        ...artifact,
        ir: {
          ...artifact.ir,
          entities: artifact.ir.entities.map((entity) => ({ ...entity, extra: true })),
        },
      }),
    ).toThrow(/unknown resolved v4 field/);

    const moved = parseResolvedEntityV4Circuit({
      ...artifact,
      ir: {
        ...artifact.ir,
        entities: artifact.ir.entities.map((entity) => ({
          ...entity,
          placement: { x: 999, y: 20 },
        })),
      },
    });
    expect(() => assertResolvedEntityV4CircuitMatchesPlan(plan, moved)).not.toThrow();
  });
});

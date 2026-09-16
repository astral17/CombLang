import { describe, expect, test } from 'vitest';
import { signal } from '@comblang/factorio';
import type { EntityId, EntityProfile } from '@comblang/compiler/entity';
import {
  createTrustedEntityReplayContext,
  entityReplayContextRef,
} from '@comblang/compiler/entity-replay-context';
import { syntheticZeroPortEntityProfile } from '@comblang/compiler/entity-fixtures';
import type { DirectElaborationPlanV6 } from '@comblang/compiler/entity-v6';
import {
  parseResolvedEntityV6Circuit,
  assertResolvedEntityV6CircuitMatchesPlan,
  resolvedEntityV6CircuitPlanFingerprint,
} from '@comblang/compiler/resolved-entity-v6';
import type { NativeCircuitIrV6 } from '@comblang/compiler/entity-v6';
import { sourceFileId, sourceSpan, type NetworkId, type ProducerId } from '@comblang/shared';

import { validateEntityV6DirectPlan } from './entity-v6-validation.js';

const source = sourceSpan(sourceFileId('entity-v6-validation.ts'), 0, 1);
const inputId = 'network:input' as NetworkId;
const outputId = 'network:output' as NetworkId;
const producerId = 'producer:1' as ProducerId;

function profile(): EntityProfile {
  return {
    ...structuredClone(syntheticZeroPortEntityProfile),
    ref: {
      ...syntheticZeroPortEntityProfile.ref,
      prototypeKey: 'entity:decider-combinator',
      profileId: 'profile:fixture-decider-v6' as EntityProfile['ref']['profileId'],
    },
    prototypeType: 'decider-combinator',
  };
}

function fixture(): {
  context: ReturnType<typeof createTrustedEntityReplayContext>;
  plan: DirectElaborationPlanV6;
  ir: NativeCircuitIrV6;
} {
  const trustedProfile = profile();
  const context = createTrustedEntityReplayContext({
    database: trustedProfile.ref.database,
    source: 'synthetic',
    evidenceIdentity: 'v6-validation-evidence',
    policyIdentity: 'v6-validation-policy',
    profiles: [trustedProfile],
  });
  const condition = {
    kind: 'compare-each' as const,
    refKind: 'single' as const,
    network: 'input',
    comparator: '>' as const,
    constant: 0,
  };
  const output = { kind: 'each' as const, refKind: 'single' as const, network: 'input' };
  const origin = {
    branch: 'normal' as const,
    ordinal: 0,
    source,
    instancePath: ['when'],
    syntaxIntent: 'implicit-each-copy' as const,
  };
  const plan: DirectElaborationPlanV6 = {
    format: 'comblang-direct-plan',
    version: 6,
    context: entityReplayContextRef(context),
    networks: [
      { name: 'input', generation: 0, source, instancePath: ['input'] },
      { name: 'output', generation: 0, source, instancePath: ['output'] },
    ],
    producers: [
      {
        kind: 'decider',
        entityId: 'entity:decider' as EntityId,
        condition,
        output,
        outputs: [output],
        outputOrigins: [origin],
        destinations: [{ network: 'output', source, instancePath: ['when'] }],
        source,
        instancePath: ['when'],
      },
    ],
    entities: [
      {
        id: 'entity:decider' as EntityId,
        profile: trustedProfile.ref,
        configuration: { mode: 'decider', condition, outputs: [output] },
        connectorBindings: [],
        placement: { x: 3, y: 4 },
        provenance: {
          source,
          instancePath: ['Entity:decider'],
          expansionStack: [],
          creationRevision: 1,
        },
        ordinal: 1,
      },
    ],
  };
  const physicalCondition = {
    kind: 'compare' as const,
    left: {
      kind: 'wildcard' as const,
      value: 'each' as const,
      refKind: 'single' as const,
      network: inputId,
    },
    comparator: '>' as const,
    right: { kind: 'constant' as const, value: 0 },
  };
  const physicalOutput = {
    mode: 'copy' as const,
    signal: { kind: 'wildcard' as const, value: 'each' as const },
    input: { refKind: 'single' as const, network: inputId },
  };
  const ir: NativeCircuitIrV6 = {
    format: 'comblang-ncir',
    version: 6,
    context: entityReplayContextRef(context),
    networks: [
      {
        id: inputId,
        name: 'input',
        color: 'red',
        provenance: { source, instancePath: ['input'], expansionStack: [] },
      },
      {
        id: outputId,
        name: 'output',
        color: 'red',
        provenance: { source, instancePath: ['output'], expansionStack: [] },
      },
    ],
    producers: [
      {
        id: producerId,
        kind: 'decider',
        config: { condition: physicalCondition, outputs: [physicalOutput] },
        destinations: [outputId],
        provenance: { source, instancePath: ['when'], expansionStack: [] },
        entityId: 'entity:decider' as EntityId,
        outputOrigins: [origin],
      },
    ],
    entities: [
      {
        id: 'entity:decider' as EntityId,
        profile: trustedProfile.ref,
        prototypeName: 'decider-combinator',
        configuration: {
          mode: 'decider',
          condition: physicalCondition,
          outputs: [physicalOutput],
        },
        connectorBindings: [],
        placement: { x: 3, y: 4 },
        provenance: {
          source,
          instancePath: ['Entity:decider'],
          expansionStack: [],
          creationRevision: 1,
        },
        ordinal: 1,
      },
    ],
  };
  return { context, plan, ir };
}

describe('Entity v6 computation transport', () => {
  test('requires an exact-base linked Decider rather than v6-shaped data alone', () => {
    const { context, plan } = fixture();
    const unlinked = {
      ...plan,
      producers: plan.producers.map(({ entityId: _entityId, ...producer }) => producer),
      entities: [],
    } as unknown as DirectElaborationPlanV6;
    expect(validateEntityV6DirectPlan(unlinked, context).diagnostics[0]).toMatchObject({
      code: 'RT6002',
      message: expect.stringContaining('at least one Decider producer'),
    });

    const substitutedProfile: EntityProfile = {
      ...profile(),
      ref: {
        ...profile().ref,
        prototypeKey: 'entity:modded-decider',
      },
    };
    const substitutedContext = createTrustedEntityReplayContext({
      database: substitutedProfile.ref.database,
      source: 'synthetic',
      evidenceIdentity: 'v6-validation-modded-evidence',
      policyIdentity: 'v6-validation-modded-policy',
      profiles: [substitutedProfile],
    });
    const substituted = {
      ...plan,
      context: entityReplayContextRef(substitutedContext),
      entities: [{ ...plan.entities[0]!, profile: substitutedProfile.ref }],
    } as DirectElaborationPlanV6;
    expect(
      validateEntityV6DirectPlan(substituted, substitutedContext).diagnostics[0],
    ).toMatchObject({
      code: 'RT6002',
      message: expect.stringContaining('exact entity:decider-combinator base key'),
    });
  });

  test('validates a linked Decider and isolates immutable row origins', () => {
    const { context, plan } = fixture();
    const result = validateEntityV6DirectPlan(plan, context);

    expect(result.diagnostics).toEqual([]);
    expect(result.value?.plan.version).toBe(6);
    const producer = result.value?.plan.producers[0];
    if (producer?.kind !== 'decider') throw new Error('Expected a linked Decider producer.');
    expect(producer).toMatchObject({
      kind: 'decider',
      entityId: 'entity:decider',
      outputOrigins: [{ branch: 'normal', ordinal: 0, syntaxIntent: 'implicit-each-copy' }],
    });
    expect(Object.isFrozen(result.value?.plan)).toBe(true);
    expect(Object.isFrozen(producer.outputOrigins)).toBe(true);
    expect(Object.isFrozen(producer.outputOrigins[0]?.source)).toBe(true);

    const callerOwned = structuredClone(plan) as DirectElaborationPlanV6;
    const callerOwnedProducer = callerOwned.producers[0]!;
    if (callerOwnedProducer.kind !== 'decider')
      throw new Error('Expected a Decider producer copy.');
    (callerOwnedProducer.outputOrigins[0]!.source as { start: number }).start = 99;
    expect(producer.outputOrigins[0]?.source.start).toBe(0);
  });

  test('round-trips physical Decider configuration and rejects origin tampering', () => {
    const { plan, ir } = fixture();
    const artifact = parseResolvedEntityV6Circuit({
      format: 'comblang-resolved-entity-v6',
      version: 1,
      planFingerprint: resolvedEntityV6CircuitPlanFingerprint(plan),
      ir,
    });

    expect(artifact.ir.version).toBe(6);
    expect(artifact.ir.entities[0]?.configuration).toMatchObject({ mode: 'decider' });
    const producer = artifact.ir.producers[0];
    if (producer?.kind !== 'decider') throw new Error('Expected a physical Decider producer.');
    expect(producer).toMatchObject({
      entityId: 'entity:decider',
      outputOrigins: [{ branch: 'normal', ordinal: 0 }],
    });
    expect(Object.isFrozen(artifact)).toBe(true);
    expect(Object.isFrozen(producer.outputOrigins)).toBe(true);
    expect(() => assertResolvedEntityV6CircuitMatchesPlan(plan, artifact)).not.toThrow();
    expect(() =>
      parseResolvedEntityV6Circuit({ ...artifact, format: 'comblang-resolved-entity-v5' }),
    ).toThrow();

    const tampered = structuredClone(artifact);
    const tamperedProducer = tampered.ir.producers[0]!;
    if (tamperedProducer.kind !== 'decider') throw new Error('Expected a Decider producer copy.');
    (tamperedProducer.outputOrigins[0] as { ordinal: number }).ordinal = 1;
    expect(() => parseResolvedEntityV6Circuit(tampered)).toThrow(/dense ordinal/);
  });

  test('requires a linked Decider and exact physical identity in resolved v6', () => {
    const { plan, ir } = fixture();
    const unlinked = {
      ...ir,
      producers: ir.producers.map(({ entityId: _entityId, ...producer }) => producer),
      entities: [],
    } as unknown as NativeCircuitIrV6;
    expect(() =>
      parseResolvedEntityV6Circuit({
        format: 'comblang-resolved-entity-v6',
        version: 1,
        planFingerprint: resolvedEntityV6CircuitPlanFingerprint(plan),
        ir: unlinked,
      }),
    ).toThrow(/at least one linked Decider producer/);

    const wrongName = {
      ...ir,
      entities: ir.entities.map((entity, index) =>
        index === 0 ? { ...entity, prototypeName: 'constant-combinator' } : entity,
      ),
    } as NativeCircuitIrV6;
    expect(() =>
      parseResolvedEntityV6Circuit({
        format: 'comblang-resolved-entity-v6',
        version: 1,
        planFingerprint: resolvedEntityV6CircuitPlanFingerprint(plan),
        ir: wrongName,
      }),
    ).toThrow(/does not match the profile key/);

    const wrongKey = {
      ...ir,
      entities: ir.entities.map((entity, index) =>
        index === 0
          ? {
              ...entity,
              prototypeName: 'modded-decider',
              profile: { ...entity.profile, prototypeKey: 'entity:modded-decider' },
            }
          : entity,
      ),
    } as NativeCircuitIrV6;
    expect(() =>
      parseResolvedEntityV6Circuit({
        format: 'comblang-resolved-entity-v6',
        version: 1,
        planFingerprint: resolvedEntityV6CircuitPlanFingerprint(plan),
        ir: wrongKey,
      }),
    ).toThrow(/decider-combinator family/);
  });
});

import { describe, expect, test } from 'vitest';

import {
  entityReplayContextRef,
  createTrustedEntityReplayContext,
  type TrustedEntityReplayContext,
} from '@comblang/compiler/entity-replay-context';
import {
  syntheticSharedTwoColorEntityProfile,
  syntheticZeroPortEntityProfile,
} from '@comblang/compiler/entity-fixtures';
import type {
  EntityConnectorKey,
  EntityLaneKey,
  EntityProfile,
  EntityRecord,
} from '@comblang/compiler/entity';
import type { DirectElaborationPlan } from '@comblang/compiler/direct-plan-schema';
import { sourceFileId, sourceSpan, type NetworkId } from '@comblang/shared';

import {
  adaptProducerOnlyPlanV2ToV3,
  EntityPlanValidationError,
  validateEntityDirectPlan,
} from './entity-plan-validation.js';
import { tryElaborateDirectPlan } from './direct-plan.js';

function contextFor(
  profile: EntityProfile = syntheticZeroPortEntityProfile,
  profiles: readonly EntityProfile[] = [profile],
): TrustedEntityReplayContext {
  return createTrustedEntityReplayContext({
    database: profile.ref.database,
    source: 'synthetic',
    evidenceIdentity: 'comblang-synthetic-evidence-v1',
    policyIdentity: 'comblang-entity-policy-v1',
    profiles,
  });
}

function entityFor(profile: EntityProfile = syntheticZeroPortEntityProfile): EntityRecord {
  return {
    id: 'entity:1' as EntityRecord['id'],
    profile: profile.ref,
    connectorBindings: [],
    provenance: {
      source: sourceSpan(sourceFileId('entity.ts'), 0, 1),
      instancePath: ['Entity:1'],
      expansionStack: [],
      creationRevision: 1,
    },
    ordinal: 1,
  };
}

function jsonCopy(value: unknown): any {
  return JSON.parse(JSON.stringify(value));
}

function planFor(
  context: TrustedEntityReplayContext,
  entity: EntityRecord = entityFor(context.profiles[0]),
): any {
  const reference = entityReplayContextRef(context);
  return {
    format: 'comblang-direct-plan',
    version: 3,
    context: reference,
    networks: [],
    producers: [],
    entities: [entity],
  };
}

describe('v3 Entity plan validation and v2 migration', () => {
  test('validates a zero-port Entity before allocation and returns a frozen canonical plan', () => {
    const context = contextFor();
    const result = validateEntityDirectPlan(planFor(context), context);

    expect(result.diagnostics).toEqual([]);
    expect(result.value?.plan.version).toBe(3);
    expect(result.value?.plan.entities).toHaveLength(1);
    expect(Object.isFrozen(result.value?.plan)).toBe(true);
    expect(Object.isFrozen(result.value?.plan.entities)).toBe(true);
  });

  test('rejects forged profile capabilities, duplicate IDs/ordinals, and missing references', () => {
    const context = contextFor();
    const forged = jsonCopy(planFor(context));
    forged.entities[0].profile.connectors = [];
    expect(validateEntityDirectPlan(forged, context).diagnostics[0]).toMatchObject({
      code: 'RT3000',
      message: expect.stringContaining('$.entities[0].profile.connectors'),
    });

    const duplicate = jsonCopy(planFor(context));
    duplicate.entities.push({ ...duplicate.entities[0] });
    expect(validateEntityDirectPlan(duplicate, context).diagnostics[0]).toMatchObject({
      code: 'RT3003',
      message: expect.stringContaining('Entity IDs must be unique'),
    });

    const missingReference = jsonCopy(planFor(context));
    missingReference.entities[0]!.profile = {
      ...missingReference.entities[0]!.profile,
      profileId: 'profile:missing-v1',
    };
    expect(validateEntityDirectPlan(missingReference, context).diagnostics[0]).toMatchObject({
      code: 'RT3002',
      message: expect.stringContaining('$.entities[0].profile.profileId'),
    });
  });

  test('rejects environment identity mismatches before graph work', () => {
    const context = contextFor();
    const wrongEnvironment = jsonCopy(planFor(context));
    wrongEnvironment.context.evidenceIdentity = 'evidence-other-v1';
    expect(validateEntityDirectPlan(wrongEnvironment, context).diagnostics[0]).toMatchObject({
      code: 'RT3001',
      message: expect.stringContaining('$.context'),
    });
  });

  test('validates shared connector endpoints against the trusted profile', () => {
    const context = contextFor(syntheticSharedTwoColorEntityProfile);
    const entity: EntityRecord = {
      ...entityFor(syntheticSharedTwoColorEntityProfile),
      connectorBindings: [
        {
          endpoint: {
            connector: 'shared' as EntityConnectorKey,
            lane: 'shared-red' as EntityLaneKey,
            color: 'red',
          },
          network: 'input' as NetworkId,
        },
      ],
    };
    const plan = jsonCopy(planFor(context, entity));
    plan.networks = [
      {
        name: 'input',
        source: sourceSpan(sourceFileId('entity.ts'), 0, 1),
        instancePath: [],
      },
    ];
    expect(validateEntityDirectPlan(plan, context).diagnostics).toEqual([]);
  });

  test('validates two Entity profiles in one plan and reports a missing sibling at its path', () => {
    const context = contextFor(syntheticZeroPortEntityProfile, [
      syntheticZeroPortEntityProfile,
      syntheticSharedTwoColorEntityProfile,
    ]);
    const second = {
      ...entityFor(syntheticSharedTwoColorEntityProfile),
      id: 'entity:2' as EntityRecord['id'],
      ordinal: 2,
    };
    const plan = jsonCopy(planFor(context, entityFor(syntheticZeroPortEntityProfile)));
    plan.entities.push(second);
    expect(validateEntityDirectPlan(plan, context).diagnostics).toEqual([]);

    const missingContext = contextFor(syntheticZeroPortEntityProfile);
    const missingPlan = jsonCopy(
      planFor(missingContext, entityFor(syntheticZeroPortEntityProfile)),
    );
    missingPlan.entities.push(second);
    expect(validateEntityDirectPlan(missingPlan, missingContext).diagnostics[0]).toMatchObject({
      code: 'RT3002',
      message: expect.stringContaining('$.entities[1].profile.profileId'),
    });
  });

  test('adapts only validated producer-only v2 and never invents Entity capabilities', () => {
    const context = contextFor();
    const v2: DirectElaborationPlan = {
      format: 'comblang-direct-plan',
      version: 2,
      networks: [],
      producers: [],
    };
    const v3 = adaptProducerOnlyPlanV2ToV3(v2, context);

    expect(v3.entities).toEqual([]);
    expect(v3.producers).toEqual(v2.producers);
    expect(validateEntityDirectPlan(v3, context).diagnostics).toEqual([]);
    expect(() => adaptProducerOnlyPlanV2ToV3(v3, context)).toThrowError(
      expect.objectContaining({ code: 'RT1001', path: '$.version' }),
    );
    expect(
      tryElaborateDirectPlan(v3 as unknown as DirectElaborationPlan).diagnostics[0],
    ).toMatchObject({
      code: 'RT1001',
    });
  });

  test('returns structured validation errors for malformed mandatory v3 fields', () => {
    const context = contextFor();
    const malformed = planFor(context);
    delete malformed.entities;
    const result = validateEntityDirectPlan(malformed, context);
    expect(result.diagnostics[0]).toMatchObject({ code: 'RT3000' });

    try {
      adaptProducerOnlyPlanV2ToV3({ version: 3 }, context);
      throw new Error('expected adapter failure');
    } catch (error) {
      expect(error).toBeInstanceOf(EntityPlanValidationError);
    }
  });
});

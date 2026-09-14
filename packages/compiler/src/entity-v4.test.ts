import { Signal } from '@comblang/factorio';
import { sourceFileId, sourceSpan } from '@comblang/shared';
import { describe, expect, test } from 'vitest';

import type {
  DirectElaborationPlanV4,
  DirectPlanProducerV4,
  EntityV4ConstantConfiguration,
  NativeCircuitIrV4,
} from './entity-v4.js';
import { entityComputationSemanticVersion } from './entity-v4.js';
import { entitySemanticVersion } from './entity.js';
import type { EntityId, EntityProfileId, EntityProfileSetId } from './entity.js';

const configuration: EntityV4ConstantConfiguration = {
  mode: 'constant',
  value: {
    isOn: true,
    sections: [
      {
        active: true,
        multiplier: 1,
        filters: [{ signal: Signal('virtual', 'signal-A'), value: 7 }],
      },
    ],
  },
};

describe('Entity v4 schema vocabulary', () => {
  test('keeps v4 versioned types distinct from v2 and v3', () => {
    const plan: DirectElaborationPlanV4 = {
      format: 'comblang-direct-plan',
      version: entityComputationSemanticVersion,
      context: {
        database: { schemaVersion: 1, identity: 'database:synthetic' },
        profileSetIdentity: 'entity-profile-set-v2-sha256:current' as EntityProfileSetId,
        evidenceIdentity: 'evidence:synthetic',
        policyIdentity: 'policy:synthetic',
      },
      networks: [],
      producers: [],
      entities: [],
    };
    const ir: NativeCircuitIrV4 = {
      format: 'comblang-ncir',
      version: entityComputationSemanticVersion,
      context: plan.context,
      networks: [],
      producers: [],
      entities: [],
    };

    expect(plan.version).toBe(4);
    expect(ir.version).toBe(4);
    expect(entitySemanticVersion).toBe(3);
    expect(configuration.mode).toBe('constant');
    expect(configuration.value.sections[0]?.filters[0]?.value).toBe(7);
  });

  test('models an optional Entity association without introducing a second placement field', () => {
    const producer: DirectElaborationPlanV4['producers'][number] = {
      kind: 'constant',
      entityId: 'entity:1' as EntityId,
      outputs: [],
      destinations: [],
      source: sourceSpan(sourceFileId('file:v4.ts'), 0, 1),
      instancePath: [],
    };
    const entity: DirectElaborationPlanV4['entities'][number] = {
      id: 'entity:1' as EntityId,
      profile: {
        prototypeKey: 'entity:fixture-constant',
        database: { schemaVersion: 1, identity: 'database:synthetic' },
        profileId: 'profile:fixture-constant-v1' as EntityProfileId,
      },
      configuration,
      connectorBindings: [],
      placement: { x: 2, y: 3 },
      provenance: {
        source: sourceSpan(sourceFileId('file:v4.ts'), 0, 1),
        instancePath: [],
        expansionStack: [],
        creationRevision: 1,
      },
      ordinal: 1,
    };

    expect(producer.entityId).toBe(entity.id);
    expect(producer).not.toHaveProperty('placement');
    expect(entity.configuration).toEqual(configuration);
  });

  test('admits physical Entity association only on the Constant producer variant', () => {
    const common = {
      destinations: [],
      source: sourceSpan(sourceFileId('file:v4-types.ts'), 0, 1),
      instancePath: [],
    };
    const constant: DirectPlanProducerV4 = {
      ...common,
      kind: 'constant',
      entityId: 'entity:1' as EntityId,
      outputs: [],
    };

    type ArithmeticEntityId = Extract<
      DirectPlanProducerV4,
      { readonly kind: 'arithmetic' }
    >['entityId'];
    // @ts-expect-error Arithmetic producers cannot own a physical Entity in the v4 slice.
    const arithmeticEntityId: ArithmeticEntityId = 'entity:1' as EntityId;

    expect(constant.entityId).toBe('entity:1');
    expect(arithmeticEntityId).toBe('entity:1');
  });
});

import type { DirectElaborationPlan } from './direct-plan-schema.js';
import { describe, expect, test } from 'vitest';
import {
  entityRawJsonLimits,
  type EntityConnectorKey,
  type EntityPhysicalConnectorBinding,
  type EntityPhysicalRecord,
  type EntityId,
  type EntityLaneKey,
  type EntityPlanConnectorBinding,
  type EntityPlanRecord,
  type EntityReplayContextRef,
} from './entity.js';
import type { ElaborationGraph, NativeCircuitIr } from './ir.js';
import {
  syntheticSharedTwoColorEntityProfile,
  syntheticZeroPortEntityProfile,
} from './entity-fixtures.js';
import { sourceFileId, sourceSpan, type NetworkId } from '@comblang/shared';

const context: EntityReplayContextRef = {
  database: {
    schemaVersion: 1,
    identity: 'comblang-synthetic-database-v1',
  },
  profileSetIdentity: 'entity-profile-set:test' as EntityReplayContextRef['profileSetIdentity'],
  evidenceIdentity: 'comblang-synthetic-evidence-v1',
  policyIdentity: 'comblang-entity-policy-v1',
};

const endpoint = {
  connector: 'shared' as EntityConnectorKey,
  lane: 'shared-red' as EntityLaneKey,
  color: 'red' as const,
};

const provenance = {
  source: sourceSpan(sourceFileId('entity.ts'), 0, 1),
  instancePath: ['Entity:1'],
  operationOrdinal: 1,
};

const planBinding: EntityPlanConnectorBinding = {
  endpoint,
  network: 'input',
  generation: 0,
  direction: 'input',
  provenance,
};

const physicalBinding: EntityPhysicalConnectorBinding = {
  endpoint,
  network: 'network:1' as NetworkId,
  nativeConnector: 1,
  generation: 0,
  direction: 'input',
  provenance,
};

// @ts-expect-error Declaration names are not physical Network IDs.
const planBindingInPhysicalDomain: EntityPhysicalConnectorBinding = planBinding;

const planEntity: EntityPlanRecord = {
  id: 'entity:1' as EntityId,
  profile: syntheticZeroPortEntityProfile.ref,
  connectorBindings: [planBinding],
  provenance: { ...provenance, expansionStack: [], creationRevision: 1 },
  ordinal: 1,
};

const physicalEntity: EntityPhysicalRecord = {
  id: planEntity.id,
  profile: planEntity.profile,
  provenance: planEntity.provenance,
  ordinal: planEntity.ordinal,
  prototypeName: 'synthetic-zero-port',
  connectorBindings: [physicalBinding],
};

const v2Plan = {
  format: 'comblang-direct-plan',
  version: 2,
  networks: [],
  producers: [],
  entities: [],
};

const canonicalPlan: DirectElaborationPlan = {
  format: 'comblang-direct-plan',
  context,
  networks: [],
  producers: [],
  entities: [planEntity],
};

const canonicalGraph: ElaborationGraph = {
  format: 'comblang-eg',
  context,
  networks: [],
  producers: [],
  attachments: [],
  entities: [physicalEntity],
};

const canonicalIr: NativeCircuitIr = {
  format: 'comblang-ncir',
  context,
  networks: [],
  producers: [],
  entities: [physicalEntity],
};

describe('compiler-owned Entity vocabulary', () => {
  test('keeps the canonical transport separate from historical envelopes', () => {
    expect(v2Plan.version).toBe(2);
    expect(canonicalPlan).not.toHaveProperty('version');
    expect(canonicalGraph).not.toHaveProperty('version');
    expect(canonicalIr).not.toHaveProperty('version');
    expect(canonicalPlan.entities).toHaveLength(1);
  });

  test('keeps declaration-name and physical-ID Entity binding domains distinct', () => {
    expect(planEntity.connectorBindings[0]?.network).toBe('input');
    expect(physicalEntity.connectorBindings[0]?.network).toBe('network:1');
    expect(planBindingInPhysicalDomain).toBe(planBinding);
  });

  test('provides deterministic zero-port and shared two-color synthetic profiles', () => {
    expect(syntheticZeroPortEntityProfile.synthetic).toBe(true);
    expect(syntheticZeroPortEntityProfile.connectors).toHaveLength(0);
    expect(syntheticZeroPortEntityProfile.features).toHaveLength(0);

    const connector = syntheticSharedTwoColorEntityProfile.connectors[0]!;
    expect(connector.key).toBe('shared');
    expect(connector.lanes.map(({ color }) => color)).toEqual(['red', 'green']);
    expect(connector.lanes.map(({ nativeEndpoint }) => nativeEndpoint?.nativeConnector)).toEqual([
      1, 1,
    ]);
    expect(syntheticSharedTwoColorEntityProfile.features[0]?.defaultLane).toBe('shared-red');
    expect(syntheticSharedTwoColorEntityProfile.defaultReadProjection).toEqual({
      feature: 'read',
      connector: 'shared',
      lane: 'shared-red',
    });
    expect(syntheticZeroPortEntityProfile.ref.profileId).not.toBe(
      syntheticSharedTwoColorEntityProfile.ref.profileId,
    );
  });

  test('freezes fixture data while leaving validation to the profile card', () => {
    expect(Object.isFrozen(syntheticZeroPortEntityProfile)).toBe(true);
    expect(Object.isFrozen(syntheticSharedTwoColorEntityProfile.connectors[0])).toBe(true);
    expect(Object.isFrozen(syntheticSharedTwoColorEntityProfile.connectors[0]?.lanes)).toBe(true);
    expect(entityRawJsonLimits).toEqual({ maxDepth: 32, maxNodes: 4096, maxBytes: 262144 });
  });
});

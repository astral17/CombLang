import type { ConstantConfiguration } from '@comblang/factorio';
import type {
  DirectPlanCapabilityUse,
  DirectPlanDebugInstance,
  DirectPlanNetworkAlias,
  DirectPlanNetworkPair,
  DirectPlanNetworkTransfer,
  DirectPlanNetworkV3,
  DirectPlanProducer,
} from './direct-plan-schema.js';
import type { CircuitProducerNode, CircuitNetworkNode, ResolvedCircuitNetworkNode } from './ir.js';
import type {
  EntityId,
  EntityConfiguration,
  EntityPhysicalConfiguration,
  EntityPhysicalRecord,
  EntityPlanDebugInstance,
  EntityPlanRecord,
  EntityReplayContextRef,
  EntityProfileRef,
} from './entity.js';
import type { Diagnostic } from '@comblang/shared';

/** Computation-bearing Entity plans are a separate envelope from v2/v3. */
export const entityComputationSemanticVersion = 4 as const;

/** The only computation-bearing Entity configuration admitted by the first v4 batch. */
export interface EntityV4ConstantConfiguration {
  readonly mode: 'constant';
  readonly value: ConstantConfiguration;
}

/**
 * V4 adds one exact Constant form without taking away the existing v3 plan
 * configuration vocabulary.
 */
export type EntityV4PlanConfiguration = EntityConfiguration | EntityV4ConstantConfiguration;

/** The physical v4 IR keeps v3's resolved typed configuration form intact. */
export type EntityV4PhysicalConfiguration =
  EntityPhysicalConfiguration | EntityV4ConstantConfiguration;

export interface EntityPlanRecordV4 extends Omit<EntityPlanRecord, 'configuration'> {
  readonly configuration?: EntityV4PlanConfiguration;
}

export interface DirectPlanArithmeticV4 extends Extract<
  DirectPlanProducer,
  { readonly kind: 'arithmetic' }
> {
  readonly entityId?: never;
}

export interface DirectPlanDeciderV4 extends Extract<
  DirectPlanProducer,
  { readonly kind: 'decider' }
> {
  readonly entityId?: never;
}

export interface DirectPlanConstantV4 extends Extract<
  DirectPlanProducer,
  { readonly kind: 'constant' }
> {
  /** Output view used by the topology engine; a linked Entity must match it exactly. */
  readonly entityId?: EntityId;
}

export type DirectPlanProducerV4 =
  DirectPlanArithmeticV4 | DirectPlanDeciderV4 | DirectPlanConstantV4;

/** Physical producer view restored after v2 topology projection. */
export type CircuitProducerNodeV4 =
  | (Extract<CircuitProducerNode, { readonly kind: 'constant' }> & {
      readonly entityId?: EntityId;
    })
  | (Exclude<CircuitProducerNode, { readonly kind: 'constant' }> & {
      readonly entityId?: never;
    });

export interface EntityPhysicalRecordV4 extends Omit<EntityPhysicalRecord, 'configuration'> {
  readonly configuration?: EntityV4PhysicalConfiguration;
}

export interface DirectElaborationPlanV4 {
  readonly format: 'comblang-direct-plan';
  readonly version: typeof entityComputationSemanticVersion;
  readonly context: EntityReplayContextRef;
  readonly networks: readonly DirectPlanNetworkV3[];
  readonly networkAliases?: readonly DirectPlanNetworkAlias[];
  readonly networkTransfers?: readonly DirectPlanNetworkTransfer[];
  readonly networkPairs?: readonly DirectPlanNetworkPair[];
  readonly capabilityUses?: readonly DirectPlanCapabilityUse[];
  readonly debugInstances?: readonly EntityPlanDebugInstance[];
  readonly producers: readonly DirectPlanProducerV4[];
  readonly entities: readonly EntityPlanRecordV4[];
  readonly diagnostics?: readonly Diagnostic[];
}

export interface ElaborationGraphV4 {
  readonly format: 'comblang-eg';
  readonly version: typeof entityComputationSemanticVersion;
  readonly context: EntityReplayContextRef;
  readonly networks: readonly CircuitNetworkNode[];
  readonly producers: readonly CircuitProducerNodeV4[];
  readonly attachments: readonly {
    readonly producer: CircuitProducerNodeV4['id'];
    readonly network: CircuitNetworkNode['id'];
    readonly provenance: CircuitProducerNodeV4['provenance'];
  }[];
  readonly entities: readonly EntityPhysicalRecordV4[];
}

export interface NativeCircuitIrV4 {
  readonly format: 'comblang-ncir';
  readonly version: typeof entityComputationSemanticVersion;
  readonly context: EntityReplayContextRef;
  readonly networks: readonly ResolvedCircuitNetworkNode[];
  readonly producers: readonly CircuitProducerNodeV4[];
  readonly entities: readonly EntityPhysicalRecordV4[];
}

/** v4 debug aliases retain Entity identity without widening the v2 debug vocabulary. */
export type EntityPlanDebugInstanceV4 = EntityPlanDebugInstance;
export type EntityProfileRefV4 = EntityProfileRef;
export type EntityIdV4 = EntityId;

import type { Diagnostic, NetworkId } from '@comblang/shared';

import type {
  DeciderOutputOrigin,
  DirectPlanCapabilityUse,
  DirectPlanDecider,
  DirectPlanNetworkAlias,
  DirectPlanNetworkPair,
  DirectPlanNetworkTransfer,
  DirectPlanProducer,
  DirectPlanNetworkV3,
  PlanDeciderCondition,
} from './direct-plan-schema.js';
import type {
  CircuitNetworkNode,
  CircuitProducerNode,
  LogicalDeciderCondition,
  LogicalDeciderOutput,
  ResolvedCircuitNetworkNode,
} from './ir.js';
import type {
  EntityConfiguration,
  EntityId,
  EntityPhysicalConfiguration,
  EntityPhysicalRecord,
  EntityPlanDebugInstance,
  EntityPlanRecord,
  EntityReplayContextRef,
} from './entity.js';
import type { EntityV4ConstantConfiguration } from './entity-v4.js';
import type {
  EntityV5ArithmeticConfiguration,
  EntityV5ArithmeticPhysicalConfiguration,
} from './entity-v5.js';

/** Cumulative computation-bearing envelope for linked Constant, Arithmetic, and Decider producers. */
export const entityComputationSemanticVersionV6 = 6 as const;

/** Exact Decider configuration retained on a linked plan Entity. */
export interface EntityV6DeciderConfiguration {
  readonly mode: 'decider';
  readonly condition: PlanDeciderCondition;
  readonly outputs: readonly DirectPlanDecider['output'][];
  readonly elseOutputs?: readonly DirectPlanDecider['output'][];
}

/** Physical counterpart of the linked Decider configuration. */
export interface EntityV6DeciderPhysicalConfiguration {
  readonly mode: 'decider';
  readonly condition: LogicalDeciderCondition;
  readonly outputs: readonly LogicalDeciderOutput[];
  readonly elseOutputs?: readonly LogicalDeciderOutput[];
}

export type EntityV6PlanConfiguration =
  | EntityConfiguration
  | EntityV4ConstantConfiguration
  | EntityV5ArithmeticConfiguration
  | EntityV6DeciderConfiguration;

export type EntityV6PhysicalConfiguration =
  | EntityPhysicalConfiguration
  | EntityV4ConstantConfiguration
  | EntityV5ArithmeticPhysicalConfiguration
  | EntityV6DeciderPhysicalConfiguration;

export interface EntityPlanRecordV6 extends Omit<EntityPlanRecord, 'configuration'> {
  readonly configuration?: EntityV6PlanConfiguration;
}

export interface DirectPlanConstantV6 extends Extract<
  DirectPlanProducer,
  { readonly kind: 'constant' }
> {
  readonly entityId?: EntityId;
}

export interface DirectPlanArithmeticV6 extends Extract<
  DirectPlanProducer,
  { readonly kind: 'arithmetic' }
> {
  readonly entityId?: EntityId;
}

export interface DirectPlanDeciderV6 extends Extract<
  DirectPlanProducer,
  { readonly kind: 'decider' }
> {
  readonly entityId?: EntityId;
  /** Canonical normal-branch origins aligned one-to-one with `outputs`. */
  readonly outputOrigins: readonly DeciderOutputOrigin[];
  /** Canonical false-branch origins aligned one-to-one with `elseOutputs`, when present. */
  readonly elseOutputOrigins?: readonly DeciderOutputOrigin[];
}

export type DirectPlanProducerV6 =
  DirectPlanConstantV6 | DirectPlanArithmeticV6 | DirectPlanDeciderV6;

export type CircuitProducerNodeV6 =
  | (Extract<CircuitProducerNode, { readonly kind: 'constant' }> & { readonly entityId?: EntityId })
  | (Extract<CircuitProducerNode, { readonly kind: 'arithmetic' }> & {
      readonly entityId?: EntityId;
    })
  | (Extract<CircuitProducerNode, { readonly kind: 'decider' }> & {
      readonly entityId?: EntityId;
      readonly outputOrigins: readonly DeciderOutputOrigin[];
      readonly elseOutputOrigins?: readonly DeciderOutputOrigin[];
    });

export interface EntityPhysicalRecordV6 extends Omit<EntityPhysicalRecord, 'configuration'> {
  readonly configuration?: EntityV6PhysicalConfiguration;
}

export interface DirectElaborationPlanV6 {
  readonly format: 'comblang-direct-plan';
  readonly version: typeof entityComputationSemanticVersionV6;
  readonly context: EntityReplayContextRef;
  readonly networks: readonly DirectPlanNetworkV3[];
  readonly networkAliases?: readonly DirectPlanNetworkAlias[];
  readonly networkTransfers?: readonly DirectPlanNetworkTransfer[];
  readonly networkPairs?: readonly DirectPlanNetworkPair[];
  readonly capabilityUses?: readonly DirectPlanCapabilityUse[];
  readonly debugInstances?: readonly EntityPlanDebugInstance[];
  readonly producers: readonly DirectPlanProducerV6[];
  readonly entities: readonly EntityPlanRecordV6[];
  readonly diagnostics?: readonly Diagnostic[];
}

export interface ElaborationGraphV6 {
  readonly format: 'comblang-eg';
  readonly version: typeof entityComputationSemanticVersionV6;
  readonly context: EntityReplayContextRef;
  readonly networks: readonly CircuitNetworkNode[];
  readonly producers: readonly CircuitProducerNodeV6[];
  readonly attachments: readonly {
    readonly producer: CircuitProducerNodeV6['id'];
    readonly network: NetworkId;
    readonly provenance: CircuitProducerNodeV6['provenance'];
  }[];
  readonly entities: readonly EntityPhysicalRecordV6[];
}

export interface NativeCircuitIrV6 {
  readonly format: 'comblang-ncir';
  readonly version: typeof entityComputationSemanticVersionV6;
  readonly context: EntityReplayContextRef;
  readonly networks: readonly ResolvedCircuitNetworkNode[];
  readonly producers: readonly CircuitProducerNodeV6[];
  readonly entities: readonly EntityPhysicalRecordV6[];
}

export type EntityV6Circuit = ElaborationGraphV6 | NativeCircuitIrV6;

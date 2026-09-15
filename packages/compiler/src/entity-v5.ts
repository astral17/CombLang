import type { Diagnostic, NetworkId } from '@comblang/shared';

import type {
  ArithmeticOperation,
  CircuitNetworkNode,
  CircuitProducerNode,
  EntityPlacement,
  LogicalArithmeticOperand,
  LogicalArithmeticOutput,
  ResolvedCircuitNetworkNode,
} from './ir.js';
import type {
  DirectPlanCapabilityUse,
  DirectPlanNetworkAlias,
  DirectPlanNetworkPair,
  DirectPlanNetworkTransfer,
  DirectPlanProducer,
  DirectPlanNetworkV3,
  PlanArithmeticOperand,
} from './direct-plan-schema.js';
import type {
  EntityConfiguration,
  EntityId,
  EntityPhysicalConfiguration,
  EntityPhysicalRecord,
  EntityPlanDebugInstance,
  EntityPlanRecord,
  EntityReplayContextRef,
} from './entity.js';

/** Cumulative computation-bearing envelope for linked Constant and Arithmetic producers. */
export const entityComputationSemanticVersionV5 = 5 as const;

/** Exact Arithmetic configuration retained on the linked Entity record. */
export interface EntityV5ArithmeticConfiguration {
  readonly mode: 'arithmetic';
  readonly left: PlanArithmeticOperand;
  readonly operation: ArithmeticOperation;
  readonly right: PlanArithmeticOperand;
  readonly output: LogicalArithmeticOutput;
}

/** Physical counterpart of the linked Arithmetic configuration. */
export interface EntityV5ArithmeticPhysicalConfiguration {
  readonly mode: 'arithmetic';
  readonly left: LogicalArithmeticOperand;
  readonly operation: ArithmeticOperation;
  readonly right: LogicalArithmeticOperand;
  readonly output: LogicalArithmeticOutput;
}

export type EntityV5PlanConfiguration =
  | EntityConfiguration
  | import('./entity-v4.js').EntityV4ConstantConfiguration
  | EntityV5ArithmeticConfiguration;

export type EntityV5PhysicalConfiguration =
  | EntityPhysicalConfiguration
  | import('./entity-v4.js').EntityV4ConstantConfiguration
  | EntityV5ArithmeticPhysicalConfiguration;

export interface EntityPlanRecordV5 extends Omit<EntityPlanRecord, 'configuration'> {
  readonly configuration?: EntityV5PlanConfiguration;
}

export interface DirectPlanArithmeticV5 extends Extract<
  DirectPlanProducer,
  { readonly kind: 'arithmetic' }
> {
  readonly entityId?: EntityId;
}

export interface DirectPlanConstantV5 extends Extract<
  DirectPlanProducer,
  { readonly kind: 'constant' }
> {
  readonly entityId?: EntityId;
}

export interface DirectPlanDeciderV5 extends Extract<
  DirectPlanProducer,
  { readonly kind: 'decider' }
> {
  readonly entityId?: never;
}

export type DirectPlanProducerV5 =
  DirectPlanArithmeticV5 | DirectPlanDeciderV5 | DirectPlanConstantV5;

export type CircuitProducerNodeV5 =
  | (Extract<CircuitProducerNode, { readonly kind: 'arithmetic' }> & {
      readonly entityId?: EntityId;
    })
  | (Extract<CircuitProducerNode, { readonly kind: 'constant' }> & { readonly entityId?: EntityId })
  | (Exclude<CircuitProducerNode, { readonly kind: 'arithmetic' | 'constant' }> & {
      readonly entityId?: never;
    });

export interface EntityPhysicalRecordV5 extends Omit<EntityPhysicalRecord, 'configuration'> {
  readonly configuration?: EntityV5PhysicalConfiguration;
}

export interface DirectElaborationPlanV5 {
  readonly format: 'comblang-direct-plan';
  readonly version: typeof entityComputationSemanticVersionV5;
  readonly context: EntityReplayContextRef;
  readonly networks: readonly DirectPlanNetworkV3[];
  readonly networkAliases?: readonly DirectPlanNetworkAlias[];
  readonly networkTransfers?: readonly DirectPlanNetworkTransfer[];
  readonly networkPairs?: readonly DirectPlanNetworkPair[];
  readonly capabilityUses?: readonly DirectPlanCapabilityUse[];
  readonly debugInstances?: readonly EntityPlanDebugInstance[];
  readonly producers: readonly DirectPlanProducerV5[];
  readonly entities: readonly EntityPlanRecordV5[];
  readonly diagnostics?: readonly Diagnostic[];
}

export interface ElaborationGraphV5 {
  readonly format: 'comblang-eg';
  readonly version: typeof entityComputationSemanticVersionV5;
  readonly context: EntityReplayContextRef;
  readonly networks: readonly CircuitNetworkNode[];
  readonly producers: readonly CircuitProducerNodeV5[];
  readonly attachments: readonly {
    readonly producer: CircuitProducerNodeV5['id'];
    readonly network: NetworkId;
    readonly provenance: CircuitProducerNodeV5['provenance'];
  }[];
  readonly entities: readonly EntityPhysicalRecordV5[];
}

export interface NativeCircuitIrV5 {
  readonly format: 'comblang-ncir';
  readonly version: typeof entityComputationSemanticVersionV5;
  readonly context: EntityReplayContextRef;
  readonly networks: readonly ResolvedCircuitNetworkNode[];
  readonly producers: readonly CircuitProducerNodeV5[];
  readonly entities: readonly EntityPhysicalRecordV5[];
}

export type EntityV5Circuit = ElaborationGraphV5 | NativeCircuitIrV5;

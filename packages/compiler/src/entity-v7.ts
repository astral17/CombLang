import type { SignalId } from '@comblang/factorio';
import type { Diagnostic, NetworkId } from '@comblang/shared';

import type {
  DirectPlanCapabilityUse,
  DirectPlanNetworkAlias,
  DirectPlanNetworkPair,
  DirectPlanNetworkTransfer,
  DirectPlanProducer,
  DirectPlanNetworkV3,
} from './direct-plan-schema.js';
import type { DirectPlanSelector } from './direct-plan-schema.js';
import type {
  CircuitNetworkNode,
  CircuitProducerNode,
  LogicalNetworkRef,
  ResolvedCircuitNetworkNode,
} from './ir.js';
import type {
  EntityId,
  EntityPhysicalRecord,
  EntityPlanDebugInstance,
  EntityPlanRecord,
  EntityReplayContextRef,
} from './entity.js';
import type {
  DirectPlanProducerV6,
  EntityV6PhysicalConfiguration,
  EntityV6PlanConfiguration,
  EntityPhysicalRecordV6,
} from './entity-v6.js';

type SelectorPlanNetworkRef = DirectPlanSelector['input'];

/** Cumulative computation-bearing envelope for linked Selector producers. */
export const entityComputationSemanticVersionV7 = 7 as const;

export type EntityV7SelectorConfiguration =
  | {
      readonly mode: 'selector';
      readonly operation: 'select';
      readonly input: SelectorPlanNetworkRef;
      readonly selectMax: boolean;
      readonly index: number | SignalId;
    }
  | {
      readonly mode: 'selector';
      readonly operation: 'count';
      readonly input: SelectorPlanNetworkRef;
      readonly output: SignalId;
    };

export type EntityV7SelectorPhysicalConfiguration =
  | {
      readonly mode: 'selector';
      readonly operation: 'select';
      readonly input: LogicalNetworkRef;
      readonly selectMax: boolean;
      readonly index: number | SignalId;
    }
  | {
      readonly mode: 'selector';
      readonly operation: 'count';
      readonly input: LogicalNetworkRef;
      readonly output: SignalId;
    };

export type EntityV7PlanConfiguration = EntityV6PlanConfiguration | EntityV7SelectorConfiguration;
export type EntityV7PhysicalConfiguration =
  EntityV6PhysicalConfiguration | EntityV7SelectorPhysicalConfiguration;

export interface EntityPlanRecordV7 extends Omit<EntityPlanRecord, 'configuration'> {
  readonly configuration?: EntityV7PlanConfiguration;
}

export type DirectPlanSelectorV7 = Extract<DirectPlanProducer, { readonly kind: 'selector' }> & {
  readonly entityId?: EntityId;
};

export type DirectPlanProducerV7 = DirectPlanProducerV6 | DirectPlanSelectorV7;

export type CircuitProducerNodeV7 =
  | Exclude<CircuitProducerNode, { readonly kind: 'selector' }>
  | (Extract<CircuitProducerNode, { readonly kind: 'selector' }> & {
      readonly entityId?: EntityId;
    });

export interface EntityPhysicalRecordV7 extends Omit<EntityPhysicalRecord, 'configuration'> {
  readonly configuration?: EntityV7PhysicalConfiguration;
}

export interface DirectElaborationPlanV7 {
  readonly format: 'comblang-direct-plan';
  readonly version: typeof entityComputationSemanticVersionV7;
  readonly context: EntityReplayContextRef;
  readonly networks: readonly DirectPlanNetworkV3[];
  readonly networkAliases?: readonly DirectPlanNetworkAlias[];
  readonly networkTransfers?: readonly DirectPlanNetworkTransfer[];
  readonly networkPairs?: readonly DirectPlanNetworkPair[];
  readonly capabilityUses?: readonly DirectPlanCapabilityUse[];
  readonly debugInstances?: readonly EntityPlanDebugInstance[];
  readonly producers: readonly DirectPlanProducerV7[];
  readonly entities: readonly EntityPlanRecordV7[];
  readonly diagnostics?: readonly Diagnostic[];
}

export interface ElaborationGraphV7 {
  readonly format: 'comblang-eg';
  readonly version: typeof entityComputationSemanticVersionV7;
  readonly context: EntityReplayContextRef;
  readonly networks: readonly CircuitNetworkNode[];
  readonly producers: readonly CircuitProducerNodeV7[];
  readonly attachments: readonly {
    readonly producer: CircuitProducerNodeV7['id'];
    readonly network: NetworkId;
    readonly provenance: CircuitProducerNodeV7['provenance'];
  }[];
  readonly entities: readonly EntityPhysicalRecordV7[];
}

export interface NativeCircuitIrV7 {
  readonly format: 'comblang-ncir';
  readonly version: typeof entityComputationSemanticVersionV7;
  readonly context: EntityReplayContextRef;
  readonly networks: readonly ResolvedCircuitNetworkNode[];
  readonly producers: readonly CircuitProducerNodeV7[];
  readonly entities: readonly EntityPhysicalRecordV7[];
}

export type EntityV7Circuit = ElaborationGraphV7 | NativeCircuitIrV7;

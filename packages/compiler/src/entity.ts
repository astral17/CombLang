import type { SignalId } from '@comblang/factorio';
import type { Brand, Diagnostic, NetworkId, SourceSpan } from '@comblang/shared';

import type {
  CircuitProducerNode,
  CircuitNetworkNode,
  NativeCircuitIr,
  ElaborationGraph,
  EntityPlacement,
  ResolvedCircuitNetworkNode,
} from './ir.js';
import type {
  DirectPlanDebugInstance,
  DirectPlanCapabilityUse,
  DirectPlanNetworkV3,
  DirectPlanNetworkAlias,
  DirectPlanNetworkPair,
  DirectPlanNetworkTransfer,
  DirectPlanProducer,
} from './direct-plan-schema.js';

/** Semantic Entity transport is incompatible with the circuit-only v2 envelopes. */
export const entitySemanticVersion = 3 as const;

export type EntityId = Brand<string, 'EntityId'>;
export type EntityProfileId = Brand<string, 'EntityProfileId'>;
export type EntityProfileSetId = Brand<string, 'EntityProfileSetId'>;
export type EntityConnectorKey = Brand<string, 'EntityConnectorKey'>;
export type EntityLaneKey = Brand<string, 'EntityLaneKey'>;
export type EntityFeatureKey = Brand<string, 'EntityFeatureKey'>;
export type EntityBehaviorKey = Brand<string, 'EntityBehaviorKey'>;

export type EntityEvidenceAuthority = 'synthetic' | 'unverified' | 'verified';
export type EntityReplayContextSource = 'synthetic' | 'provider';

export interface EntityDatabaseRef {
  readonly schemaVersion: number;
  readonly identity: string;
}

/** The profile identity is separate from the prototype/database identity. */
export interface EntityProfileRef {
  readonly prototypeKey: string;
  readonly database: EntityDatabaseRef;
  readonly profileId: EntityProfileId;
}

/** Identities required by host-side replay; a plan cannot use these as capabilities. */
export interface EntityReplayContextRef {
  readonly database: EntityDatabaseRef;
  readonly profileSetIdentity: EntityProfileSetId;
  readonly evidenceIdentity: string;
  readonly policyIdentity: string;
}

export type EntityConnectorDirection = 'input' | 'output' | 'bidirectional';

/** A schema connector is a physical object; it is not a feature or a Network. */
export interface EntityConnectorRef {
  readonly key: EntityConnectorKey;
}

/** A lane is one concrete color endpoint on a physical connector. */
export interface EntityLaneEndpoint {
  readonly connector: EntityConnectorKey;
  readonly lane: EntityLaneKey;
  readonly color: 'red' | 'green';
}

export interface EntityNativeEndpoint {
  readonly endpoint: EntityLaneEndpoint;
  readonly nativeConnector: number;
}

export interface EntityLaneProfile {
  readonly key: EntityLaneKey;
  readonly color: 'red' | 'green';
  readonly nativeEndpoint?: EntityNativeEndpoint;
}

export interface EntityConnectorProfile {
  readonly key: EntityConnectorKey;
  readonly direction: EntityConnectorDirection;
  readonly lanes: readonly EntityLaneProfile[];
}

/** Features refer to declared connector/lane views; they do not create ports. */
export interface EntityFeatureProfile {
  readonly key: EntityFeatureKey;
  readonly connector: EntityConnectorKey;
  readonly defaultLane?: EntityLaneKey;
  readonly allowedLanes: readonly EntityLaneKey[];
}

/** A profile-level default is explicit; null means that implicit projection is unavailable. */
export interface EntityDefaultReadProjection {
  readonly feature: EntityFeatureKey;
  readonly connector: EntityConnectorKey;
  readonly lane: EntityLaneKey;
}

export type EntityEvidenceState =
  | { readonly status: 'unknown' }
  | { readonly status: 'unverified'; readonly value: boolean }
  | {
      readonly status: 'verified';
      readonly value: boolean;
      readonly sourceIds: readonly string[];
    };

export type EntityConfigurationMode = 'raw' | 'typed';

/** Capability-specific configuration evidence; structure and evidence stay separate. */
export interface EntityConfigurationRule {
  readonly key: EntityBehaviorKey;
  readonly kind: 'native-single-condition';
  readonly modes: readonly EntityConfigurationMode[];
  readonly evidence: EntityEvidenceState;
}

export interface EntityProfile {
  readonly ref: EntityProfileRef;
  readonly connectors: readonly EntityConnectorProfile[];
  readonly features: readonly EntityFeatureProfile[];
  readonly configurationRules: readonly EntityConfigurationRule[];
  readonly defaultReadProjection: EntityDefaultReadProjection | null;
  readonly synthetic: boolean;
}

/** Candidate raw input shape; canonicalization supplies bounds and validation. */
export type EntityRawJson =
  | null
  | boolean
  | number
  | string
  | readonly EntityRawJson[]
  | { readonly [key: string]: EntityRawJson };

export type EntityRawJsonObject = { readonly [key: string]: EntityRawJson };

export interface EntityRawJsonLimits {
  readonly maxDepth: number;
  readonly maxNodes: number;
  readonly maxBytes: number;
}

/** Conservative transport defaults for raw Entity data. */
export const entityRawJsonLimits: EntityRawJsonLimits = Object.freeze({
  maxDepth: 32,
  maxNodes: 4096,
  maxBytes: 262144,
});

/** Raw native data is separate from compiler-owned identity, topology, and placement. */
export interface EntityRawPayload {
  readonly prototype: string;
  readonly native: EntityRawJsonObject;
  readonly entityNumber?: number;
  readonly placement?: EntityPlacement;
}

export type EntityConfiguration =
  | { readonly mode: 'raw'; readonly payload: EntityRawJson }
  | { readonly mode: 'typed'; readonly payload: EntityRawJson };

export interface EntityConnectorBindingProvenance {
  readonly source: SourceSpan;
  readonly instancePath: readonly string[];
  readonly operationOrdinal: number;
}

/** A Direct Plan Network reference is its declaration name, not a physical ID. */
export type EntityPlanNetworkName = string;

export interface EntityConnectorBindingBase {
  readonly endpoint: EntityLaneEndpoint;
  /** Ownership generation captured by this endpoint facet. */
  readonly generation: number;
  readonly direction: 'input' | 'output';
  readonly provenance: EntityConnectorBindingProvenance;
}

/** Transport binding whose optional Network reference names a Direct Plan declaration. */
export interface EntityPlanConnectorBinding extends EntityConnectorBindingBase {
  readonly network?: EntityPlanNetworkName;
}

/** Lowered graph binding whose optional Network reference is an allocated physical ID. */
export type EntityPhysicalConnectorBinding = EntityConnectorBindingBase &
  (
    | { readonly network: NetworkId; readonly nativeConnector: number }
    | { readonly network?: never; readonly nativeConnector?: never }
  );

export interface EntityProvenance {
  readonly source: SourceSpan;
  readonly instancePath: readonly string[];
  readonly expansionStack: readonly string[];
  readonly creationRevision: number;
}

interface EntityRecordBase {
  readonly id: EntityId;
  readonly profile: EntityProfileRef;
  readonly configuration?: EntityConfiguration;
  readonly placement?: EntityPlacement;
  readonly provenance: EntityProvenance;
  readonly ordinal: number;
}

export interface EntityPlanRecord extends EntityRecordBase {
  readonly connectorBindings: readonly EntityPlanConnectorBinding[];
}

export interface EntityPhysicalRecord extends EntityRecordBase {
  readonly prototypeName: string;
  readonly connectorBindings: readonly EntityPhysicalConnectorBinding[];
}

export type EntityNativeComparator = '>' | '<' | '=' | '>=' | '<=' | '!=';

/** The initial native-enable vocabulary: one concrete Signal/int32 comparison. */
export interface EntityNativeSingleCondition {
  readonly kind: 'compare-signal-constant';
  readonly signal: SignalId;
  readonly comparator: EntityNativeComparator;
  readonly constant: number;
  readonly connector: EntityLaneEndpoint;
}

/** Direct Plan v3 is a separate envelope; v2 remains circuit-only and unchanged. */
export interface DirectElaborationPlanV3 {
  readonly format: 'comblang-direct-plan';
  readonly version: typeof entitySemanticVersion;
  readonly context: EntityReplayContextRef;
  readonly networks: readonly DirectPlanNetworkV3[];
  readonly networkAliases?: readonly DirectPlanNetworkAlias[];
  readonly networkTransfers?: readonly DirectPlanNetworkTransfer[];
  readonly networkPairs?: readonly DirectPlanNetworkPair[];
  readonly capabilityUses?: readonly DirectPlanCapabilityUse[];
  readonly debugInstances?: readonly DirectPlanDebugInstance[];
  readonly producers: readonly DirectPlanProducer[];
  readonly entities: readonly EntityPlanRecord[];
  readonly diagnostics?: readonly Diagnostic[];
}

/** Entity graph and NCIR versions use physical Network IDs, unlike Direct Plan names. */
export type ElaborationGraphV3 = Omit<ElaborationGraph, 'version'> & {
  readonly version: typeof entitySemanticVersion;
  readonly context: EntityReplayContextRef;
  readonly entities: readonly EntityPhysicalRecord[];
};

export type NativeCircuitIrV3 = Omit<NativeCircuitIr, 'version'> & {
  readonly version: typeof entitySemanticVersion;
  readonly context: EntityReplayContextRef;
  readonly entities: readonly EntityPhysicalRecord[];
};

/** Kept as named aliases so the migration inventory can refer to every v2 reader seam. */
export type EntityCircuitNetworkNodeV3 = CircuitNetworkNode;
export type EntityResolvedCircuitNetworkNodeV3 = ResolvedCircuitNetworkNode;
export type EntityCircuitProducerNodeV3 = CircuitProducerNode;

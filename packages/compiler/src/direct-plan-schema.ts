import type { SignalId } from '@comblang/factorio';
import type { Diagnostic, SourceSpan } from '@comblang/shared';
import type { EntityId, EntityPlanRecord, EntityReplayContextRef } from './entity.js';
import type { ConstantConfiguration } from '@comblang/factorio';

import type { ArithmeticOperation, CircuitColor, LogicalArithmeticOutput } from './ir.js';

/** Stable, transport-neutral schema emitted by elaboration and consumed by the runtime. */
export type PlanNetworkRef =
  | { readonly refKind: 'single'; readonly network: string }
  | { readonly refKind: 'pair'; readonly networks: readonly [string, string] };

export interface PlanAttachment {
  readonly network: string;
  readonly source: SourceSpan;
  readonly instancePath: readonly string[];
}

export interface PlanEntityPlacement {
  readonly x: number;
  readonly y: number;
  readonly direction?: number;
}

export type PlanArithmeticOperand =
  | { readonly kind: 'constant'; readonly value: number }
  | ({ readonly kind: 'signal'; readonly signal: SignalId } & PlanNetworkRef)
  | ({ readonly kind: 'each' } & PlanNetworkRef);

export type PlanComparator = '>' | '<' | '=' | '>=' | '<=' | '!=';

export type PlanDeciderCondition =
  | ({
      readonly kind: 'compare-each';
      readonly comparator: PlanComparator;
      readonly constant: number;
    } & PlanNetworkRef)
  | ({
      readonly kind: 'compare-signal';
      readonly signal: SignalId;
      readonly comparator: PlanComparator;
      readonly constant: number;
    } & PlanNetworkRef)
  | ({
      readonly kind: 'compare-wildcard';
      readonly wildcard: 'anything' | 'everything';
      readonly comparator: PlanComparator;
      readonly constant: number;
    } & PlanNetworkRef)
  | {
      readonly kind: 'compare-signals';
      readonly left: PlanNetworkRef & { readonly signal: SignalId };
      readonly comparator: PlanComparator;
      readonly right: PlanNetworkRef & { readonly signal: SignalId };
    }
  | {
      readonly kind: 'compare-wildcard-signal';
      readonly left: PlanNetworkRef & {
        readonly wildcard: 'each' | 'anything' | 'everything';
      };
      readonly comparator: PlanComparator;
      readonly right: PlanNetworkRef & { readonly signal: SignalId };
    }
  | {
      readonly kind: 'and';
      readonly conditions: readonly PlanDeciderCondition[];
    }
  | {
      readonly kind: 'or';
      readonly conditions: readonly PlanDeciderCondition[];
    };

export interface DirectPlanNetwork {
  readonly name: string;
  readonly fixedColor?: CircuitColor;
  readonly source: SourceSpan;
  readonly instancePath: readonly string[];
  /** Ownership generation is present when replay authority is attached. */
  readonly generation?: number;
  /** A consumed physical Network cannot be used by an Entity facet. */
  readonly consumedAt?: SourceSpan;
}

/** Final executed source binding for an existing physical Network; creates no hardware. */
export interface DirectPlanNetworkAlias {
  readonly name: string;
  readonly network: string;
  readonly source: SourceSpan;
  readonly instancePath: readonly string[];
  readonly moved: boolean;
}

/** A zero-tick physical union. `source` is consumed and `destination` survives. */
export interface DirectPlanNetworkTransfer {
  readonly destination: string;
  readonly source: string;
  readonly provenance: SourceSpan;
  readonly instancePath: readonly string[];
}

/** A read-only input connector view whose members must use opposite wire colors. */
export interface DirectPlanNetworkPair {
  readonly networks: readonly [string, string];
  readonly provenance: SourceSpan;
  readonly instancePath: readonly string[];
}

/** An executed function-boundary capability use. This is audit metadata, not hardware. */
export interface DirectPlanCapabilityUse {
  readonly network: string;
  readonly capability: 'readonly' | 'ref' | 'move';
  readonly parameter: string;
  readonly fixedColor?: CircuitColor;
  readonly provenance: SourceSpan;
  readonly instancePath: readonly string[];
}

export interface DirectPlanArithmetic {
  readonly kind: 'arithmetic';
  readonly entityId?: EntityId;
  /** Explicit source Producer binding retained for debug queries. */
  readonly bindingName?: string;
  readonly debugCaptureIds?: readonly string[];
  readonly left: PlanArithmeticOperand;
  readonly operation: ArithmeticOperation;
  readonly right: PlanArithmeticOperand;
  readonly output: LogicalArithmeticOutput;
  readonly destinations: readonly PlanAttachment[];
  readonly source: SourceSpan;
  readonly instancePath: readonly string[];
  readonly placement?: PlanEntityPlacement;
}

export interface DirectPlanDecider {
  readonly kind: 'decider';
  readonly entityId?: EntityId;
  /** Explicit source Producer binding retained for debug queries. */
  readonly bindingName?: string;
  readonly debugCaptureIds?: readonly string[];
  readonly condition: PlanDeciderCondition;
  readonly output:
    | ({ readonly kind: 'each' } & PlanNetworkRef)
    | { readonly kind: 'each-constant'; readonly value: number }
    | { readonly kind: 'signal-constant'; readonly signal: SignalId; readonly value: number }
    | ({
        readonly kind: 'wildcard';
        readonly wildcard: 'anything' | 'everything';
      } & PlanNetworkRef)
    | ({ readonly kind: 'signal'; readonly signal: SignalId } & PlanNetworkRef);
  /** Multiple native Factorio 2.x output filters. `output` remains the first-filter compatibility view. */
  readonly outputs?: readonly DirectPlanDecider['output'][];
  /** Native Factorio 2.x false-branch output filters. */
  readonly elseOutputs?: readonly DirectPlanDecider['output'][];
  readonly destinations: readonly PlanAttachment[];
  readonly source: SourceSpan;
  readonly instancePath: readonly string[];
  readonly placement?: PlanEntityPlacement;
  readonly outputOrigins?: readonly DeciderOutputOrigin[];
  readonly elseOutputOrigins?: readonly DeciderOutputOrigin[];
}

/** Internal row identity retained through canonical computation transport. */
export type DeciderOutputSyntaxIntent =
  | 'implicit-concrete-copy'
  | 'implicit-each-copy'
  | 'explicit-wildcard-copy'
  | 'explicit-constant'
  | 'exact';

export interface DeciderOutputOrigin {
  readonly branch: 'normal' | 'else';
  readonly ordinal: number;
  readonly source: SourceSpan;
  readonly instancePath: readonly string[];
  readonly syntaxIntent: DeciderOutputSyntaxIntent;
}

interface DirectPlanConstantBase {
  readonly kind: 'constant';
  readonly entityId?: EntityId;
  /** Explicit source Producer binding retained for debug queries. */
  readonly bindingName?: string;
  readonly debugCaptureIds?: readonly string[];
  readonly destinations: readonly PlanAttachment[];
  readonly source: SourceSpan;
  readonly instancePath: readonly string[];
  readonly placement?: PlanEntityPlacement;
}

/** Legacy CC transport: its ordered output rows are the authoritative data. */
export interface DirectPlanLegacyConstant extends DirectPlanConstantBase {
  readonly outputs: readonly { readonly signal: SignalId; readonly value: number }[];
  readonly configuration?: never;
}

/** Exact Constant transport: the semantic configuration is authoritative. */
export interface DirectPlanExactConstant extends DirectPlanConstantBase {
  readonly configuration: ConstantConfiguration;
  readonly outputs?: never;
}

export type DirectPlanConstant = DirectPlanLegacyConstant | DirectPlanExactConstant;

interface DirectPlanSelectorBase {
  readonly kind: 'selector';
  readonly entityId?: EntityId;
  readonly input: PlanNetworkRef;
  readonly destinations: readonly PlanAttachment[];
  readonly source: SourceSpan;
  readonly instancePath: readonly string[];
  readonly placement?: PlanEntityPlacement;
  /** Explicit source Producer binding retained for debug queries. */
  readonly bindingName?: string;
  readonly debugCaptureIds?: readonly string[];
}

export type DirectPlanSelector =
  | (DirectPlanSelectorBase & {
      readonly operation: 'select';
      readonly selectMax: boolean;
      readonly index: number | SignalId;
    })
  | (DirectPlanSelectorBase & {
      readonly operation: 'count';
      readonly output: SignalId;
    });

export type DirectPlanProducer =
  DirectPlanArithmetic | DirectPlanDecider | DirectPlanConstant | DirectPlanSelector;

export type DirectPlanDebugValue =
  | { readonly kind: 'network'; readonly network: string }
  | { readonly kind: 'producer'; readonly captureId: string }
  | { readonly kind: 'entity'; readonly entityId: EntityId }
  | { readonly kind: 'literal'; readonly value: string | number | boolean | null }
  | { readonly kind: 'undefined' }
  | { readonly kind: 'array'; readonly values: readonly DirectPlanDebugValue[] }
  | {
      readonly kind: 'object';
      readonly entries: readonly {
        readonly key: string;
        readonly value: DirectPlanDebugValue;
      }[];
    };

export interface DirectPlanDebugInstance {
  readonly name: string;
  readonly path: readonly string[];
  readonly source: SourceSpan;
  readonly value: DirectPlanDebugValue;
}

export interface DirectElaborationPlan {
  readonly format: 'comblang-direct-plan';
  readonly context?: EntityReplayContextRef;
  readonly networks: readonly DirectPlanNetwork[];
  readonly networkAliases?: readonly DirectPlanNetworkAlias[];
  readonly networkTransfers?: readonly DirectPlanNetworkTransfer[];
  readonly networkPairs?: readonly DirectPlanNetworkPair[];
  readonly capabilityUses?: readonly DirectPlanCapabilityUse[];
  readonly debugInstances?: readonly DirectPlanDebugInstance[];
  readonly producers: readonly DirectPlanProducer[];
  readonly entities: readonly EntityPlanRecord[];
  readonly diagnostics?: readonly Diagnostic[];
}

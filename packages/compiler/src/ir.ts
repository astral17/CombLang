import type { CircuitValue, ConstantConfiguration, SignalId } from '@comblang/factorio';
import type { NetworkId, ProducerId, SourceSpan } from '@comblang/shared';
import type { DeciderOutputOrigin } from './direct-plan-schema.js';
import type { EntityId, EntityPhysicalRecord, EntityReplayContextRef } from './entity.js';

export type CircuitColor = 'red' | 'green';

/** Concrete Phase 4 configuration domains; Phase 8 may add symbolic variants above this seam. */
export type ConcreteConfigSignal = SignalId;
export type ConcreteConfigNumber = CircuitValue;

export interface Provenance {
  readonly source?: SourceSpan;
  readonly instancePath: readonly string[];
  readonly expansionStack: readonly string[];
}

export interface EntityPlacement {
  readonly x: number;
  readonly y: number;
  readonly direction?: number;
}

export interface CircuitNetworkNode {
  readonly id: NetworkId;
  readonly name?: string;
  readonly fixedColor?: CircuitColor;
  readonly provenance: Provenance;
}

export type LogicalNetworkRef =
  | { readonly refKind: 'single'; readonly network: NetworkId }
  | { readonly refKind: 'pair'; readonly networks: readonly [NetworkId, NetworkId] };

export type LogicalArithmeticOperand =
  | { readonly kind: 'constant'; readonly value: ConcreteConfigNumber }
  | ({ readonly kind: 'signal'; readonly signal: ConcreteConfigSignal } & LogicalNetworkRef)
  | ({ readonly kind: 'each' } & LogicalNetworkRef);

export type LogicalArithmeticOutput =
  { readonly kind: 'signal'; readonly signal: ConcreteConfigSignal } | { readonly kind: 'each' };

export type ArithmeticOperation =
  | 'add'
  | 'subtract'
  | 'multiply'
  | 'divide'
  | 'modulo'
  | 'power'
  | 'left-shift'
  | 'right-shift'
  | 'bit-and'
  | 'bit-or'
  | 'bit-xor';

export interface ArithmeticProducerConfig {
  readonly left: LogicalArithmeticOperand;
  readonly operation: ArithmeticOperation;
  readonly right: LogicalArithmeticOperand;
  readonly output: LogicalArithmeticOutput;
}

/** Legacy CC transport: its ordered output rows are the authoritative data. */
export interface LegacyConstantProducerConfig {
  readonly outputs: readonly {
    readonly signal: ConcreteConfigSignal;
    readonly value: ConcreteConfigNumber;
  }[];
  readonly configuration?: never;
}

/** Exact Constant transport: the semantic configuration is authoritative. */
export interface ExactConstantProducerConfig {
  readonly configuration: ConstantConfiguration;
  readonly outputs?: never;
}

export type ConstantProducerConfig = LegacyConstantProducerConfig | ExactConstantProducerConfig;

export type SelectorIndex = ConcreteConfigNumber | ConcreteConfigSignal;

export type SelectorProducerConfig =
  | {
      readonly operation: 'select';
      readonly input: LogicalNetworkRef;
      readonly selectMax: boolean;
      readonly index: SelectorIndex;
    }
  | {
      readonly operation: 'count';
      readonly input: LogicalNetworkRef;
      readonly output: ConcreteConfigSignal;
    };

export type Comparator = '>' | '<' | '=' | '>=' | '<=' | '!=';
export type Quantifier = 'each' | 'anything' | 'everything';

export type LogicalScalarOperand =
  | { readonly kind: 'constant'; readonly value: ConcreteConfigNumber }
  | ({ readonly kind: 'signal'; readonly signal: ConcreteConfigSignal } & LogicalNetworkRef);

export type LogicalConditionLeft =
  | Extract<LogicalScalarOperand, { kind: 'signal' }>
  | ({ readonly kind: 'wildcard'; readonly value: Quantifier } & LogicalNetworkRef);

export type LogicalDeciderCondition =
  | {
      readonly kind: 'compare';
      readonly left: LogicalConditionLeft;
      readonly comparator: Comparator;
      readonly right: LogicalScalarOperand;
    }
  | { readonly kind: 'and'; readonly conditions: readonly LogicalDeciderCondition[] }
  | { readonly kind: 'or'; readonly conditions: readonly LogicalDeciderCondition[] };

export type LogicalDeciderOutputSignal =
  | { readonly kind: 'signal'; readonly signal: ConcreteConfigSignal }
  | { readonly kind: 'wildcard'; readonly value: Quantifier };

export type LogicalDeciderOutput =
  | {
      readonly mode: 'copy';
      readonly signal: LogicalDeciderOutputSignal;
      readonly input?: LogicalNetworkRef;
    }
  | {
      readonly mode: 'constant';
      readonly signal: LogicalDeciderOutputSignal;
      readonly value: ConcreteConfigNumber;
      readonly input?: LogicalNetworkRef;
    };

export type ConcreteConfigCondition = LogicalDeciderCondition;

export interface DeciderProducerConfig {
  readonly condition: ConcreteConfigCondition;
  readonly outputs: readonly LogicalDeciderOutput[];
  readonly elseOutputs?: readonly LogicalDeciderOutput[];
}

export type CircuitProducerNode =
  | {
      readonly id: ProducerId;
      readonly kind: 'arithmetic';
      readonly entityId?: EntityId;
      readonly config: ArithmeticProducerConfig;
      readonly destinations: readonly NetworkId[];
      readonly provenance: Provenance;
      readonly placement?: EntityPlacement;
    }
  | {
      readonly id: ProducerId;
      readonly kind: 'constant';
      readonly entityId?: EntityId;
      readonly config: ConstantProducerConfig;
      readonly destinations: readonly NetworkId[];
      readonly provenance: Provenance;
      readonly placement?: EntityPlacement;
    }
  | {
      readonly id: ProducerId;
      readonly kind: 'decider';
      readonly entityId?: EntityId;
      readonly config: DeciderProducerConfig;
      readonly outputOrigins?: readonly DeciderOutputOrigin[];
      readonly elseOutputOrigins?: readonly DeciderOutputOrigin[];
      readonly destinations: readonly NetworkId[];
      readonly provenance: Provenance;
      readonly placement?: EntityPlacement;
    }
  | {
      readonly id: ProducerId;
      readonly kind: 'selector';
      readonly entityId?: EntityId;
      readonly config: SelectorProducerConfig;
      readonly destinations: readonly NetworkId[];
      readonly provenance: Provenance;
      readonly placement?: EntityPlacement;
    };

export interface CircuitAttachment {
  readonly producer: ProducerId;
  readonly network: NetworkId;
  readonly provenance: Provenance;
}

export interface ElaborationGraph {
  readonly format: 'comblang-eg';
  readonly context?: EntityReplayContextRef;
  readonly networks: readonly CircuitNetworkNode[];
  readonly producers: readonly CircuitProducerNode[];
  readonly attachments: readonly CircuitAttachment[];
  readonly entities: readonly EntityPhysicalRecord[];
}

export interface ResolvedCircuitNetworkNode extends CircuitNetworkNode {
  readonly color: CircuitColor;
}

export interface NativeCircuitIr {
  readonly format: 'comblang-ncir';
  readonly context?: EntityReplayContextRef;
  readonly networks: readonly ResolvedCircuitNetworkNode[];
  readonly producers: readonly CircuitProducerNode[];
  readonly entities: readonly EntityPhysicalRecord[];
}

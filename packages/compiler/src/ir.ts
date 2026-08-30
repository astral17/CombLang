import type { SignalId } from '@comblang/factorio';
import type { NetworkId, ProducerId, SourceSpan } from '@comblang/shared';

export type CircuitColor = 'red' | 'green';

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
  | { readonly kind: 'constant'; readonly value: number }
  | ({ readonly kind: 'signal'; readonly signal: SignalId } & LogicalNetworkRef)
  | ({ readonly kind: 'each' } & LogicalNetworkRef);

export type LogicalArithmeticOutput =
  { readonly kind: 'signal'; readonly signal: SignalId } | { readonly kind: 'each' };

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

export interface ConstantProducerConfig {
  readonly outputs: readonly {
    readonly signal: SignalId;
    readonly value: number;
  }[];
}

export type Comparator = '>' | '<' | '=' | '>=' | '<=' | '!=';
export type Quantifier = 'each' | 'anything' | 'everything';

export type LogicalScalarOperand =
  | { readonly kind: 'constant'; readonly value: number }
  | ({ readonly kind: 'signal'; readonly signal: SignalId } & LogicalNetworkRef);

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
  | { readonly kind: 'signal'; readonly signal: SignalId }
  | { readonly kind: 'wildcard'; readonly value: Quantifier };

export interface LogicalDeciderOutput {
  readonly signal: LogicalDeciderOutputSignal;
  readonly input?: LogicalNetworkRef;
  readonly copyCountFromInput?: boolean;
  readonly constant?: number;
}

export interface DeciderProducerConfig {
  readonly condition: LogicalDeciderCondition;
  readonly outputs: readonly LogicalDeciderOutput[];
  readonly elseOutputs?: readonly LogicalDeciderOutput[];
}

export type CircuitProducerNode =
  | {
      readonly id: ProducerId;
      readonly kind: 'arithmetic';
      readonly config: ArithmeticProducerConfig;
      readonly destinations: readonly NetworkId[];
      readonly provenance: Provenance;
      readonly placement?: EntityPlacement;
    }
  | {
      readonly id: ProducerId;
      readonly kind: 'constant';
      readonly config: ConstantProducerConfig;
      readonly destinations: readonly NetworkId[];
      readonly provenance: Provenance;
      readonly placement?: EntityPlacement;
    }
  | {
      readonly id: ProducerId;
      readonly kind: 'decider';
      readonly config: DeciderProducerConfig;
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
  readonly version: 2;
  readonly networks: readonly CircuitNetworkNode[];
  readonly producers: readonly CircuitProducerNode[];
  readonly attachments: readonly CircuitAttachment[];
}

export interface ResolvedCircuitNetworkNode extends CircuitNetworkNode {
  readonly color: CircuitColor;
}

export interface NativeCircuitIr {
  readonly format: 'comblang-ncir';
  readonly version: 2;
  readonly networks: readonly ResolvedCircuitNetworkNode[];
  readonly producers: readonly CircuitProducerNode[];
}

import type {
  DeciderOutputOrigin,
  DeciderOutputSyntaxIntent,
  DirectPlanProducer,
  PlanDeciderCondition,
  PlanNetworkRef,
} from '@comblang/compiler/direct-plan-schema';
import type { EntityNativeSingleCondition } from '@comblang/compiler/entity';
import type { EntityValue } from './entity-registry.js';
import type {
  ConstantConfiguration,
  ConstantConfigurationSection,
  SignalId,
} from '@comblang/factorio';
import type { SourceSpan } from '@comblang/shared';
import type { ConstantConfigurationTemplate } from '../../compiler/src/constant-configuration-template.js';
import type { ArithmeticConfigurationTemplate } from '../../compiler/src/arithmetic-configuration-template.js';
import type { SelectorConfigurationTemplate } from '../../compiler/src/selector-configuration-template.js';
import type { DeciderConfigurationTemplate } from '../../compiler/src/decider-configuration-template.js';
import type { BlueprintNumberParameterHandle } from '../../compiler/src/blueprint-parameters.js';

export type RuntimeNetworkCapability = 'owned' | 'readonly' | 'ref' | 'move';

export interface NetworkBorrow {
  readonly capability: 'readonly' | 'ref';
  readonly parameter: string;
  readonly source: SourceSpan;
  readonly ownership: NetworkOwnershipState;
  active: boolean;
  releasedAt?: SourceSpan;
}

export interface NetworkMove {
  readonly ownership: NetworkOwnershipState;
  readonly source: SourceSpan;
  returned: boolean;
}

export interface FunctionOwnershipFrame {
  readonly owner: symbol;
  readonly source: SourceSpan;
  readonly borrows: NetworkBorrow[];
  readonly moves: NetworkMove[];
}

export interface NetworkOwnershipState {
  consumedAt?: SourceSpan;
  lastMove?: { readonly source: SourceSpan; readonly generation: number };
  generation: number;
  owner: symbol | 'top-level' | 'lost';
  colorRequirement?: { readonly color: 'red' | 'green'; readonly source: SourceSpan };
  readonlyBorrows: Set<NetworkBorrow>;
  mutableBorrow?: NetworkBorrow;
}

export interface NetworkValue {
  readonly kind: 'network';
  readonly name: string;
  readonly declaration: SourceSpan;
  readonly capability: RuntimeNetworkCapability;
  readonly generation: number;
}

/** Mutable Network state kept outside the source-visible, frozen handle. */
export interface NetworkRuntimeState {
  readonly ownership: NetworkOwnershipState;
  readonly borrow?: NetworkBorrow;
  /** Direct call-site provenance carried into the callee's capability check. */
  readonly callArgument?: SourceSpan;
}

export interface SignalValue {
  readonly kind: 'signal-value';
  readonly signal: SignalId;
  readonly value: number;
}

export type ParameterDeciderOutputSelection =
  | { readonly kind: 'signal'; readonly signal: SignalId }
  | { readonly kind: 'each' }
  | { readonly kind: 'anything' }
  | { readonly kind: 'everything' };

/** Internal Decider constant output whose value is resolved at the host binding boundary. */
export interface ParameterSignalValue {
  readonly kind: 'parameter-signal-value';
  readonly selection: ParameterDeciderOutputSelection;
  readonly parameter: BlueprintNumberParameterHandle;
}

/** Session-nominal Constant configuration fragment; it is not a Producer or Network. */
export interface SectionValue {
  readonly kind: 'section';
  readonly section: ConstantConfigurationSection;
  /** Tracks syntax-level scaling even when the multiplier remains exactly one. */
  readonly scaled: boolean;
  readonly source: SourceSpan;
}

/** Source-visible Signal identity registered by one executed elaboration session. */
export interface SignalHandle extends SignalId {
  [Symbol.toPrimitive]?(hint: 'string' | 'number' | 'default'): string;
}

export type WildcardName = 'each' | 'anything' | 'everything';

export interface SelectedValue {
  readonly kind: 'selected';
  /** Public projection present only on a concrete single-Network selection. */
  readonly signal?: SignalHandle;
  /** Public readonly projection present only on a concrete single-Network selection. */
  readonly network?: NetworkValue;
}

export interface PairSelectedValue extends SelectedValue {}

/** Recorder-owned state for a concrete single-Network selection. */
export interface ConcreteSelectedRuntimeState {
  readonly kind: 'concrete';
  readonly network: NetworkValue;
  readonly selection: SignalHandle;
  readonly readonlyNetwork: NetworkValue;
}

/** Recorder-owned state for pair and wildcard selections. */
export interface NonConcreteSelectedRuntimeState {
  readonly kind: 'pair' | 'wildcard';
  readonly network: NetworkValue;
  readonly networks?: readonly [NetworkValue, NetworkValue];
  readonly selection: SignalHandle | WildcardName;
}

/** Recorder-owned state for a selected value; none of these fields are source-visible. */
export type SelectedRuntimeState = ConcreteSelectedRuntimeState | NonConcreteSelectedRuntimeState;

export interface PairValue {
  readonly kind: 'pair';
  readonly networks: readonly [NetworkValue, NetworkValue];
  readonly source: SourceSpan;
}

export interface WildcardTokenValue {
  readonly kind: 'wildcard-token';
  readonly value: WildcardName;
}

export interface WildcardCountValue {
  readonly kind: 'wildcard-count';
  readonly wildcard: WildcardName;
  readonly value: number;
}

export interface DestinationValue {
  readonly kind: 'destinations';
  readonly networks: readonly NetworkValue[];
  readonly signal?: SignalId;
}

export interface ConditionValue {
  readonly kind: 'condition';
  readonly condition: RuntimeDeciderCondition;
}

/** Session-nominal source configuration handle; deliberately not a circuit Condition. */
export interface NativeConditionValue {
  readonly kind: 'native-condition';
  readonly condition: EntityNativeSingleCondition;
}

type WithoutDestinations<T> = T extends unknown ? Omit<T, 'destinations'> : never;

type CompleteCombinatorDescriptor = WithoutDestinations<DirectPlanProducer>;
type CompleteDeciderDescriptor = Extract<
  CompleteCombinatorDescriptor,
  { readonly kind: 'decider' }
>;
type CompleteExactConstantDescriptor = Extract<
  CompleteCombinatorDescriptor,
  { readonly kind: 'constant'; readonly configuration: ConstantConfiguration }
>;
type CompleteArithmeticDescriptor = Extract<
  CompleteCombinatorDescriptor,
  { readonly kind: 'arithmetic' }
>;
type CompleteSelectorDescriptor = Extract<
  CompleteCombinatorDescriptor,
  { readonly kind: 'selector' }
>;
type CompleteSelectSelectorDescriptor = Extract<
  CompleteSelectorDescriptor,
  { readonly operation: 'select' }
>;
type CompleteCountSelectorDescriptor = Extract<
  CompleteSelectorDescriptor,
  { readonly operation: 'count' }
>;
type SelectSelectorConfigurationTemplate = Extract<
  SelectorConfigurationTemplate,
  { readonly operation: 'select' }
>;
type CountSelectorConfigurationTemplate = Extract<
  SelectorConfigurationTemplate,
  { readonly operation: 'count' }
>;

/** Internal recorder state before an exact parameterized Constant is installed. */
type PendingConstantDescriptor = Omit<CompleteExactConstantDescriptor, 'configuration'> & {
  readonly configuration?: never;
  readonly pendingConfiguration: ConstantConfigurationTemplate;
};

export type PendingArithmeticOperand =
  | { readonly kind: 'constant' }
  | ({ readonly kind: 'signal'; readonly signal: SignalId } & PlanNetworkRef)
  | ({ readonly kind: 'each' } & PlanNetworkRef);

type PendingArithmeticDescriptor = Omit<
  CompleteArithmeticDescriptor,
  'left' | 'right' | 'output'
> & {
  readonly left: PendingArithmeticOperand;
  readonly right: PendingArithmeticOperand;
  readonly output?: never;
  readonly pendingConfiguration: ArithmeticConfigurationTemplate;
};

type PendingSelectSelectorDescriptor = Omit<CompleteSelectSelectorDescriptor, 'index'> & {
  readonly index?: never;
  readonly pendingConfiguration: SelectSelectorConfigurationTemplate;
};

type PendingCountSelectorDescriptor = Omit<CompleteCountSelectorDescriptor, 'output'> & {
  readonly output?: never;
  readonly pendingConfiguration: CountSelectorConfigurationTemplate;
};

type PendingSelectorDescriptor = PendingSelectSelectorDescriptor | PendingCountSelectorDescriptor;

/** Numeric RHS slots are represented without placeholder values until installation. */
export type PendingDeciderCondition =
  | ({
      readonly kind: 'compare-each';
      readonly comparator: Extract<PlanDeciderCondition, { kind: 'compare-each' }>['comparator'];
      readonly constant: { readonly kind: 'constant' };
    } & PlanNetworkRef)
  | ({
      readonly kind: 'compare-signal';
      readonly signal: Extract<PlanDeciderCondition, { kind: 'compare-signal' }>['signal'];
      readonly comparator: Extract<PlanDeciderCondition, { kind: 'compare-signal' }>['comparator'];
      readonly constant: { readonly kind: 'constant' };
    } & PlanNetworkRef)
  | ({
      readonly kind: 'compare-wildcard';
      readonly wildcard: Extract<PlanDeciderCondition, { kind: 'compare-wildcard' }>['wildcard'];
      readonly comparator: Extract<
        PlanDeciderCondition,
        { kind: 'compare-wildcard' }
      >['comparator'];
      readonly constant: { readonly kind: 'constant' };
    } & PlanNetworkRef)
  | Extract<PlanDeciderCondition, { kind: 'compare-signals' | 'compare-wildcard-signal' }>
  | {
      readonly kind: 'and';
      readonly conditions: readonly PendingDeciderCondition[];
    }
  | {
      readonly kind: 'or';
      readonly conditions: readonly PendingDeciderCondition[];
    };

export type RuntimeDeciderCondition =
  | Exclude<PlanDeciderCondition, { readonly kind: 'and' | 'or' }>
  | Exclude<PendingDeciderCondition, { readonly kind: 'and' | 'or' }>
  | {
      readonly kind: 'and';
      readonly conditions: readonly RuntimeDeciderCondition[];
    }
  | {
      readonly kind: 'or';
      readonly conditions: readonly RuntimeDeciderCondition[];
    };

type PendingDeciderDescriptor = Omit<
  CompleteDeciderDescriptor,
  'condition' | 'output' | 'outputs' | 'elseOutputs'
> & {
  readonly condition: PendingDeciderCondition;
  readonly output?: RuntimeDeciderOutput;
  readonly outputs?: readonly RuntimeDeciderOutput[];
  readonly elseOutputs?: readonly RuntimeDeciderOutput[];
  readonly outputOrigins?: readonly DeciderOutputOrigin[];
  readonly elseOutputOrigins?: readonly DeciderOutputOrigin[];
  readonly pendingConfiguration: DeciderConfigurationTemplate;
};

export type PendingDeciderOutput = {
  readonly kind: 'parameter-signal-constant';
  readonly selection: ParameterDeciderOutputSelection;
  readonly parameter: BlueprintNumberParameterHandle;
};
type RuntimeDeciderOutput = CompleteDeciderDescriptor['output'] | PendingDeciderOutput;

export type {
  DeciderOutputOrigin,
  DeciderOutputSyntaxIntent,
} from '@comblang/compiler/direct-plan-schema';

export type CombinatorDescriptor =
  | Exclude<
      CompleteCombinatorDescriptor,
      { readonly kind: 'decider' } | { readonly kind: 'selector' }
    >
  | CompleteSelectorDescriptor
  | PendingArithmeticDescriptor
  | PendingConstantDescriptor
  | PendingSelectorDescriptor
  | PendingDeciderDescriptor
  | (Omit<CompleteDeciderDescriptor, 'condition' | 'output' | 'outputs' | 'elseOutputs'> & {
      readonly condition: RuntimeDeciderCondition;
      readonly output?: RuntimeDeciderOutput;
      readonly outputs?: readonly RuntimeDeciderOutput[];
      readonly elseOutputs?: readonly RuntimeDeciderOutput[];
      readonly outputOrigins?: readonly DeciderOutputOrigin[];
      readonly elseOutputOrigins?: readonly DeciderOutputOrigin[];
    });

/** Source-visible handle for one physical combinator. Its Network facet lives in the registry. */
export interface CombinatorValue {
  readonly kind: 'combinator';
  readonly identity: object;
  /** Scoped Network view used by a typed Combinator parameter. */
  readonly networkFacet?: NetworkValue;
  /** Original caller handle restored when a scoped parameter crosses the return boundary. */
  readonly unrestrictedHandle?: CombinatorValue;
}

export type DslValue =
  | EntityValue
  | NetworkValue
  | PairValue
  | SelectedValue
  | DestinationValue
  | SignalValue
  | ParameterSignalValue
  | SectionValue
  | WildcardTokenValue
  | WildcardCountValue
  | ConditionValue
  | CombinatorValue
  | SignalHandle
  | number;

export type RuntimeObjectValue = Exclude<DslValue, SignalHandle | number> | NativeConditionValue;
export type RuntimeObjectKind = RuntimeObjectValue['kind'];

/** Nominal, session-local identity for runtime-only DSL values. */
export class RuntimeValueRegistry {
  readonly #kinds = new WeakMap<object, RuntimeObjectKind>();
  readonly #networks = new WeakMap<NetworkValue, NetworkRuntimeState>();
  readonly #signals = new WeakSet<object>();
  readonly #selected = new WeakMap<SelectedValue, SelectedRuntimeState>();

  brand<T extends RuntimeObjectValue>(value: T): T {
    if (value.kind === 'network') {
      throw new Error('Network handles require opaque runtime state.');
    }
    this.#kinds.set(value, value.kind);
    return value;
  }

  brandNetwork<T extends NetworkValue>(value: T, state: NetworkRuntimeState): T {
    this.#kinds.set(value, 'network');
    this.#networks.set(value, state);
    Object.freeze(value.declaration);
    return Object.freeze(value);
  }

  networkState(value: NetworkValue): NetworkRuntimeState | undefined {
    return this.#networks.get(value);
  }

  brandSignal<T extends SignalHandle>(value: T): T {
    this.#signals.add(value);
    return value;
  }

  brandSection<T extends SectionValue>(value: T): T {
    this.#kinds.set(value, 'section');
    return Object.freeze(value);
  }

  hasSignal(value: unknown): value is SignalHandle {
    return typeof value === 'object' && value !== null && this.#signals.has(value);
  }

  brandSelected<T extends SelectedValue>(value: T, state: SelectedRuntimeState): T {
    this.#kinds.set(value, value.kind);
    this.#selected.set(value, state);
    return Object.freeze(value);
  }

  selectedState(value: SelectedValue): SelectedRuntimeState | undefined {
    return this.#selected.get(value);
  }

  hasKind<K extends RuntimeObjectKind>(
    value: unknown,
    kind: K,
  ): value is Extract<RuntimeObjectValue, { readonly kind: K }> {
    return typeof value === 'object' && value !== null && this.#kinds.get(value) === kind;
  }
}

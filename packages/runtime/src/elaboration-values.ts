import type {
  DeciderOutputOrigin,
  DeciderOutputSyntaxIntent,
  DirectPlanProducer,
  PlanDeciderCondition,
} from '@comblang/compiler/direct-plan-schema';
import type { EntityNativeSingleCondition } from '@comblang/compiler/entity';
import type { EntityValue } from './entity-registry.js';
import type { ConstantConfigurationSection, SignalId } from '@comblang/factorio';
import type { SourceSpan } from '@comblang/shared';

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
  readonly condition: PlanDeciderCondition;
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

export type {
  DeciderOutputOrigin,
  DeciderOutputSyntaxIntent,
} from '@comblang/compiler/direct-plan-schema';

export type CombinatorDescriptor =
  | Exclude<CompleteCombinatorDescriptor, { readonly kind: 'decider' }>
  | (Omit<CompleteDeciderDescriptor, 'output'> & {
      readonly output?: CompleteDeciderDescriptor['output'];
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

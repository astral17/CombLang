import type { DirectPlanProducer, PlanDeciderCondition } from '@comblang/compiler';
import type { SignalId } from '@comblang/factorio';
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
  /** A producer materialized only to satisfy a function Network return may adopt its caller binding. */
  returnBindingAvailable?: boolean;
  /** Direct call-site provenance carried into the callee's capability check. */
  readonly callArgument?: SourceSpan;
}

export interface SignalValue {
  readonly kind: 'signal-value';
  readonly signal: SignalId;
  readonly value: number;
}

/** Source-visible Signal identity registered by one executed elaboration session. */
export interface SignalHandle extends SignalId {}

export type WildcardName = 'each' | 'anything' | 'everything';

export interface SelectedValue {
  readonly kind: 'selected';
  readonly network: NetworkValue;
  readonly networks?: readonly [NetworkValue, NetworkValue];
  readonly selection: SignalId | WildcardName;
}

export interface PairSelectedValue extends SelectedValue {
  readonly networks: readonly [NetworkValue, NetworkValue];
}

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

type WithoutDestinations<T> = T extends unknown ? Omit<T, 'destinations'> : never;

export interface ProducerValue {
  readonly kind: 'producer';
  /** Shared identity of one physical entity across fluent wrapper values. */
  readonly identity: object;
  readonly producer: WithoutDestinations<DirectPlanProducer>;
}

export type DslValue =
  | NetworkValue
  | PairValue
  | SelectedValue
  | DestinationValue
  | SignalValue
  | WildcardTokenValue
  | WildcardCountValue
  | ConditionValue
  | ProducerValue
  | SignalHandle
  | number;

export type RuntimeObjectValue = Exclude<DslValue, SignalHandle | number>;
export type RuntimeObjectKind = RuntimeObjectValue['kind'];

/** Nominal, session-local identity for runtime-only DSL values. */
export class RuntimeValueRegistry {
  readonly #kinds = new WeakMap<object, RuntimeObjectKind>();
  readonly #networks = new WeakMap<NetworkValue, NetworkRuntimeState>();
  readonly #signals = new WeakSet<object>();

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

  hasSignal(value: unknown): value is SignalHandle {
    return typeof value === 'object' && value !== null && this.#signals.has(value);
  }

  hasKind<K extends RuntimeObjectKind>(
    value: unknown,
    kind: K,
  ): value is Extract<RuntimeObjectValue, { readonly kind: K }> {
    return typeof value === 'object' && value !== null && this.#kinds.get(value) === kind;
  }
}

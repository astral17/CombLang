import {
  circuitConstant,
  constantConfigurationFromOutputs,
  constantConfigurationToSparseBus,
  formatSignalRef,
  parseSignalRef,
  sameSignal,
  Signal,
  type SignalId,
} from '@comblang/factorio';
import type {
  DirectElaborationPlanV3,
  DirectElaborationPlanV4,
  DirectElaborationPlanV5,
  DirectElaborationPlanV6,
  ElaborationJavaScript,
  EntityBehaviorKey,
  EntityConfiguration,
  EntityConnectorBindingProvenance,
  EntityConnectorProfile,
  EntityLaneEndpoint,
  EntityLaneKey,
  EntityNativeComparator,
  EntityNativeSingleCondition,
  EntityPlanDebugInstance,
  EntityPlanDebugValue,
  EntityProfile,
  EntityProfileRef,
  EntityId,
} from '@comblang/compiler';
import type { EntityV4ConstantConfiguration } from '@comblang/compiler/entity-v4';
import type { EntityV5ArithmeticConfiguration } from '@comblang/compiler/entity-v5';
import type {
  DirectPlanProducerV6,
  EntityPlanRecordV6,
  EntityV6DeciderConfiguration,
} from '@comblang/compiler/entity-v6';
import type { EntityPlanRecordV5 } from '@comblang/compiler/entity-v5';
import { entityFamilyDslNames, type DslParameterContract } from '@comblang/language';
import type {
  DirectElaborationPlan,
  DirectPlanArithmetic,
  DirectPlanDebugInstance,
  DirectPlanDebugValue,
  DirectPlanProducer,
  PlanEntityPlacement,
  PlanArithmeticOperand,
  PlanDeciderCondition,
} from '@comblang/compiler/direct-plan-schema';
import { canonicalizeEntityRawObject, EntityRawJsonError } from '@comblang/compiler/entity-raw';
import {
  resolveBlueprintEntitySchema,
  validateBlueprintEntityFragmentAgainstSchema,
  type EntityPrototype,
  type PrototypeProvider,
} from '@comblang/prototypes';
import type { Diagnostic, NetworkId, SourceFileId, SourceSpan } from '@comblang/shared';

import {
  ElaborationExecutionError,
  ElaborationOperationLimitError,
  RecoverableElaborationExecutionError,
} from './elaboration-errors.js';
import { ElaborationColorConstraints } from './elaboration-color-constraints.js';
import { ElaborationProvenanceFormatter } from './elaboration-provenance.js';
import { CombinatorRegistry, type CombinatorRegistrySnapshot } from './combinator-registry.js';
import { normalizeSignalValueSources } from './constant-signal-values.js';
import {
  ConstantConfigurationSourceError,
  normalizeConstantConfigurationSource,
} from './constant-configuration-source.js';
import {
  RuntimeValueRegistry,
  type CombinatorDescriptor,
  type CombinatorValue,
  type ConditionValue,
  type DestinationValue,
  type DeciderOutputOrigin,
  type DeciderOutputSyntaxIntent,
  type DslValue,
  type FunctionOwnershipFrame,
  type NetworkBorrow,
  type NetworkOwnershipState,
  type NetworkRuntimeState,
  type NetworkValue,
  type NativeConditionValue,
  type PairSelectedValue,
  type PairValue,
  type RuntimeObjectKind,
  type RuntimeObjectValue,
  type SelectedRuntimeState,
  type SelectedValue,
  type SignalHandle,
  type SignalValue,
  type WildcardCountValue,
  type WildcardName,
  type WildcardTokenValue,
} from './elaboration-values.js';
import {
  elaborationOperatorPolicy as operators,
  type ElaborationOperatorDispatchContext,
} from './elaboration-operators.js';
import { createElaborationOwnershipPolicy } from './elaboration-ownership.js';
import { resolveNetworkArgument } from './network-argument-policy.js';
import { selectCombinatorMoveLanes, selectCombinatorMoveNetwork } from './network-move-policy.js';
import {
  bindNetworkParameter,
  bindNetworkReferenceParameter,
  type NetworkParameterCapability,
} from './network-parameter-policy.js';
import { bindParameterContract } from './parameter-contract-policy.js';
import { returnNetworkValue } from './network-return-policy.js';
import { validateCombinatorAttachment } from './combinator-attachment-policy.js';
import { bindCombinatorHandle } from './combinator-handle-policy.js';
import { returnOwnedValue } from './return-owned-value-policy.js';
import {
  EntityRegistry,
  EntityRegistryError,
  entityPrototypeResolverFromProvider,
  type EntityRegistrySnapshot,
  type EntityValue,
  type EntityPrototypeResolver,
} from './entity-registry.js';
import {
  entityReplayContextRef,
  resolveEntityReplayProfile,
  type TrustedEntityReplayContext,
} from '@comblang/compiler/entity-replay-context';
import type { EntityPlacement } from '@comblang/compiler/ir';
import type { ArithmeticOperation, LogicalArithmeticOutput } from '@comblang/compiler/ir';
import {
  BlueprintEntitySignalConversionError,
  detachBlueprintEntitySignalHandles,
} from './entity-blueprint-fragment.js';

interface RawSpan {
  readonly start: number;
  readonly end: number;
}

interface CallArgument {
  readonly value: unknown;
  readonly source: RawSpan;
  readonly fieldSources?: Readonly<{
    readonly outputs?: RawSpan;
    readonly elseOutputs?: RawSpan;
  }>;
}

type PlanDeciderOutput = Extract<DirectPlanProducer, { kind: 'decider' }>['output'];

interface DeciderOutputCandidate {
  readonly output: PlanDeciderOutput;
  readonly source: SourceSpan;
  readonly instancePath: readonly string[];
  readonly syntaxIntent: DeciderOutputSyntaxIntent;
}

function conditionUsesEach(condition: PlanDeciderCondition): boolean {
  if (condition.kind === 'and' || condition.kind === 'or') {
    return condition.conditions.some(conditionUsesEach);
  }
  return condition.kind === 'compare-each';
}

const entityFamilyConstructionTypes = Object.freeze({
  Lamp: 'lamp',
  Roboport: 'roboport',
  Constant: 'constant-combinator',
} as const) satisfies typeof entityFamilyDslNames;

interface Invocation {
  readonly callable: unknown;
  readonly arguments: readonly CallArgument[];
  readonly source: RawSpan;
  readonly defaultNetworks: Set<NetworkOwnershipState>;
  entered: boolean;
  segment?: string;
}

interface PreparedInvocation {
  readonly callable: unknown;
  readonly receiver: unknown;
  readonly deciderBranch?: 'then' | 'else';
}

interface BindingDescriptor {
  readonly name: string;
  readonly color?: 'red' | 'green';
  readonly property?: string;
  readonly producerType?: string;
}

interface PendingDebugInstance {
  readonly segment: string;
  path?: readonly string[];
}

interface PendingNetworkAlias {
  readonly name: string;
  readonly source: SourceSpan;
  readonly instancePath: readonly string[];
  readonly read: () => unknown;
}

interface ExecutionApiFrame {
  dslDomain: boolean;
}

interface NetworkOwnershipSnapshot {
  readonly state: NetworkOwnershipState;
  readonly generation: number;
  readonly owner: NetworkOwnershipState['owner'];
  readonly consumedAt?: SourceSpan;
  readonly lastMove?: NetworkOwnershipState['lastMove'];
  readonly colorRequirement?: NetworkOwnershipState['colorRequirement'];
  readonly readonlyBorrows: readonly NetworkBorrow[];
  readonly mutableBorrow?: NetworkOwnershipState['mutableBorrow'];
}

interface TopologySnapshot {
  readonly networksLength: number;
  readonly networkStates: ReadonlyMap<string, NetworkRuntimeState>;
  readonly networkNameCounts: ReadonlyMap<string, number>;
  readonly networkTransfersLength: number;
  readonly combinatorOrdinal: number;
  readonly combinatorByOutput: ReadonlyMap<NetworkOwnershipState, CombinatorValue>;
  readonly combinators: CombinatorRegistrySnapshot;
  readonly ownership: readonly NetworkOwnershipSnapshot[];
  readonly colors: ElaborationColorConstraints;
  readonly entityRegistry?: EntityRegistrySnapshot;
  readonly entityRevision: number;
  readonly entityAuthoritiesLength: number;
  readonly linkedProducersLength: number;
}

interface EntityFacetAuthority {
  readonly endpoint: EntityLaneEndpoint;
  readonly direction: 'input' | 'output';
  readonly provenance: EntityConnectorBindingProvenance;
  readonly source: SourceSpan;
  network: NetworkValue;
  locallyOwned: boolean;
}

interface EntityAuthorityView {
  readonly entity: EntityValue;
  owner: symbol | 'top-level' | 'retired';
  retiredAt?: SourceSpan;
  readonly facets: Map<string, EntityFacetAuthority>;
}

interface LinkedConstantAssociation {
  readonly kind: 'constant';
  readonly entity: EntityValue;
  readonly configuration: import('@comblang/factorio').ConstantConfiguration;
}

interface LinkedArithmeticAssociation {
  readonly kind: 'arithmetic';
  readonly entity: EntityValue;
  readonly configuration: EntityV5ArithmeticConfiguration;
}

interface LinkedDeciderAssociation {
  readonly kind: 'decider';
  readonly entity: EntityValue;
  readonly configuration: EntityV6DeciderConfiguration;
}

type LinkedProducerAssociation =
  LinkedConstantAssociation | LinkedArithmeticAssociation | LinkedDeciderAssociation;

export interface ElaborationExecutionOptions {
  readonly dslCallBudget?: number;
  /** Explicit immutable prototype environment exposed to source as `prototypes`. */
  readonly prototypes?: PrototypeProvider;
  /** Host-only v3 profile context; never exposed to executed source. */
  readonly trustedEntityReplayContext?: TrustedEntityReplayContext;
  /** Narrow prototype lookup used by internal Entity construction tests. */
  readonly entityPrototypeResolver?: EntityPrototypeResolver;
  /** @deprecated Use dslCallBudget. */
  readonly operationBudget?: number;
}

export { ElaborationExecutionError, ElaborationOperationLimitError };

function isSignalId(value: unknown): value is SignalId {
  return (
    typeof value === 'object' &&
    value !== null &&
    'type' in value &&
    'name' in value &&
    !('kind' in value)
  );
}

function isRawSpan(value: unknown): value is RawSpan {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as RawSpan).start === 'number' &&
    typeof (value as RawSpan).end === 'number'
  );
}

const exactArithmeticOperations = Object.freeze([
  'add',
  'subtract',
  'multiply',
  'divide',
  'modulo',
  'power',
  'left-shift',
  'right-shift',
  'bit-and',
  'bit-or',
  'bit-xor',
] as const satisfies readonly ArithmeticOperation[]);

function isPlainDataRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  return Reflect.ownKeys(value).every((key) => {
    if (typeof key !== 'string') return false;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor !== undefined && 'value' in descriptor;
  });
}

class ElaborationRecorder {
  readonly #fileId: SourceFileId;
  readonly #networks: DirectElaborationPlan['networks'][number][] = [];
  readonly #networkStates = new Map<string, NetworkRuntimeState>();
  readonly #networkTransfers: NonNullable<DirectElaborationPlan['networkTransfers']>[number][] = [];
  readonly #networkAliases = new Map<string, PendingNetworkAlias>();
  readonly #transparentNetworkParameters = new WeakMap<
    FunctionOwnershipFrame,
    Set<NetworkOwnershipState>
  >();
  readonly #networkPairs: NonNullable<DirectElaborationPlan['networkPairs']>[number][] = [];
  readonly #capabilityUses: NonNullable<DirectElaborationPlan['capabilityUses']>[number][] = [];
  readonly #debugInstances: (DirectPlanDebugInstance | EntityPlanDebugInstance)[] = [];
  readonly #diagnostics: Diagnostic[] = [];
  readonly #implicitBorrowWarnings = new Set<string>();
  readonly #combinators = new CombinatorRegistry();
  readonly #combinatorByOutput = new Map<NetworkOwnershipState, CombinatorValue>();
  readonly #runtimeValues = new RuntimeValueRegistry();
  readonly #deciderMemberAliases = new WeakMap<
    Function,
    {
      readonly receiver: unknown;
      readonly branch: 'then' | 'else';
    }
  >();
  readonly #ownership = createElaborationOwnershipPolicy((network) => this.#networkState(network));
  readonly #colors = new ElaborationColorConstraints();
  readonly #executionApiFrames: ExecutionApiFrame[] = [];
  #status: 'active' | 'failed' | 'sealed' = 'active';
  #firstFailure: unknown;
  #anonymousOrdinal = 0;
  #combinatorOrdinal = 0;
  readonly #networkNameCounts = new Map<string, number>();
  readonly #functionCallCounts = new Map<string, number>();
  readonly #debugInstanceCounts = new Map<string, number>();
  readonly #anonymousLoopCounts = new Map<string, number>();
  readonly #provenanceFormatter = new ElaborationProvenanceFormatter();
  readonly #instancePath: string[] = [];
  readonly #ownershipFrames: (FunctionOwnershipFrame | undefined)[] = [];
  readonly #invocations: Invocation[] = [];
  readonly #functionCalls = new WeakMap<
    FunctionOwnershipFrame,
    {
      readonly name: string;
      readonly invocation?: Invocation;
    }
  >();
  #pendingDebugInstance: PendingDebugInstance | undefined;
  readonly #dslCallBudget: number;
  readonly #prototypes: PrototypeProvider | undefined;
  readonly #entityContext: TrustedEntityReplayContext | undefined;
  readonly #entityPrototypeResolver: EntityPrototypeResolver | undefined;
  readonly #entityRegistry: EntityRegistry | undefined;
  readonly #entityAuthorities = new WeakMap<object, EntityAuthorityView>();
  readonly #entityAuthorityList: EntityAuthorityView[] = [];
  readonly #linkedProducerByIdentity = new WeakMap<object, LinkedProducerAssociation>();
  readonly #linkedProducers: {
    readonly producer: CombinatorValue;
    readonly association: LinkedProducerAssociation;
  }[] = [];
  #entityRevision = 0;
  #entityOperationOrdinal = 0;
  #dslCalls = 0;
  readonly #operatorContext: ElaborationOperatorDispatchContext<RawSpan> = {
    isCircuitDslValue: (value): value is DslValue => this.#isCircuitDslValue(value),
    isSignal: (value): value is SignalId => this.#isSignal(value),
    isSignalId,
    isSelected: (value): value is SelectedValue => this.#isSelected(value),
    selectedSelection: (value) => this.#selectedSelection(value),
    isNetwork: (value): value is NetworkValue => this.#isNetwork(value),
    networkFacet: (value) => this.#networkFacet(value),
    readableNetworkFacet: (value, source) => this.#readableNetworkFacet(value, source),
    isPair: (value): value is PairValue => this.#isPair(value),
    isWildcardToken: (value): value is WildcardTokenValue => this.#isWildcardToken(value),
    recordDslCall: () => this.#recordDslCall(),
    assertReadable: (value, source) => this.#assertReadableValue(value, source),
    planNetworkRef: (value) => this.#planNetworkRef(value),
    arithmeticOperand: (value, source) => this.#arithmeticOperand(value, source),
    producerMetadata: (source) => ({ source: this.#span(source), instancePath: this.#path() }),
    createCombinator: (descriptor, source) => this.#createCombinator(descriptor, source),
    brand: <T extends RuntimeObjectValue>(value: T): T => this.#runtimeValue(value),
  };

  constructor(
    fileId: SourceFileId,
    dslCallBudget: number,
    prototypes: PrototypeProvider | undefined,
    entityContext: TrustedEntityReplayContext | undefined,
    entityPrototypeResolver: EntityPrototypeResolver | undefined,
  ) {
    this.#fileId = fileId;
    this.#dslCallBudget = dslCallBudget;
    this.#prototypes = prototypes;
    this.#entityContext = entityContext;
    this.#entityPrototypeResolver = entityPrototypeResolver;
    this.#entityRegistry =
      entityContext === undefined || entityPrototypeResolver === undefined
        ? undefined
        : new EntityRegistry(entityContext, entityPrototypeResolver);
  }

  readonly api = Object.freeze({
    prototypeEnvironment: (rawSpan: RawSpan): PrototypeProvider => {
      if (this.#prototypes === undefined) {
        throw new ElaborationExecutionError(
          'This compilation has no prototype environment; provide a Prototype DB before using prototypes.',
          this.#span(rawSpan),
          'EX1004',
        );
      }
      return this.#prototypes;
    },
    invoke: (callable: unknown, args: readonly CallArgument[], rawSpan: RawSpan): unknown => {
      return this.#invoke(callable, undefined, args, rawSpan);
    },
    prepareMember: (receiver: unknown, key: PropertyKey, rawSpan: RawSpan): PreparedInvocation => {
      // Resolve the member before evaluating arguments, but leave those arguments in
      // their original lexical environment (not a thunk: eval and yield depend on it).
      if (this.#isCircuitDslValue(receiver)) {
        const property = Reflect.ownKeys({ [key]: undefined })[0]!;
        if (property === 'then' || property === 'else') {
          return { callable: undefined, receiver, deciderBranch: property };
        }
        const operations: Record<string, ((...values: unknown[]) => unknown) | undefined> = {
          to: (...values) => this.api.attachTo(receiver, ...values, rawSpan),
          take: (...values) => this.api.take(receiver, ...values, rawSpan),
          at: (...values) => this.api.place(receiver, ...values, rawSpan),
          as: (...values) => this.api.bindOutput(receiver, values[0] as SignalId, rawSpan),
          then: (...values) => this.api.appendDecider(receiver, 'then', values, rawSpan),
          else: (...values) => this.api.appendDecider(receiver, 'else', values, rawSpan),
        };
        if (this.#isEntity(receiver)) {
          operations.port = (...values) => {
            if (values.length !== 2) {
              throw new ElaborationExecutionError(
                'Entity.port(connector, lane) requires exactly two arguments.',
                this.#span(rawSpan),
                'RT2027',
              );
            }
            return this.api.entityFacet(receiver, values[0], values[1], rawSpan);
          };
          operations.bind = (...values) => {
            if (values.length !== 4) {
              throw new ElaborationExecutionError(
                'Entity.bind(connector, lane, network, direction) requires exactly four arguments.',
                this.#span(rawSpan),
                'RT2027',
              );
            }
            return this.api.bindEntity(
              receiver,
              values[0],
              values[1],
              values[2],
              values[3],
              rawSpan,
            );
          };
        }
        const operation =
          typeof property === 'string' && Object.hasOwn(operations, property)
            ? operations[property]
            : undefined;
        if (operation !== undefined) return { callable: operation, receiver };
        return { callable: this.api.element(receiver, property, rawSpan), receiver };
      }
      return { callable: this.api.element(receiver, key, rawSpan), receiver };
    },
    member: (receiver: unknown, key: PropertyKey, rawSpan: RawSpan): unknown =>
      this.#member(receiver, key, rawSpan),
    invokePrepared: (
      prepared: PreparedInvocation,
      args: readonly CallArgument[],
      rawSpan: RawSpan,
    ): unknown =>
      prepared.deciderBranch === undefined
        ? this.#invoke(prepared.callable, prepared.receiver, args, rawSpan)
        : this.#appendDeciderArguments(prepared.receiver, prepared.deciderBranch, args, rawSpan),
    invokeMember: (
      receiver: unknown,
      key: PropertyKey,
      evaluateArguments: () => readonly CallArgument[],
      rawSpan: RawSpan,
    ): unknown => {
      // Compatibility with already-generated v2 programs using argument thunks.
      const prepared = this.api.prepareMember(receiver, key, rawSpan);
      return this.api.invokePrepared(prepared, evaluateArguments(), rawSpan);
    },
    spreadCallArguments: (values: Iterable<unknown>, rawSpan: RawSpan): readonly CallArgument[] => {
      const result: CallArgument[] = [];
      for (const value of values) result.push({ value, source: rawSpan });
      return result;
    },
    parameterSource: (index: number, rawSpan: RawSpan): RawSpan => {
      const frame = this.#currentFunctionFrame();
      const invocation =
        frame === undefined ? undefined : this.#functionCalls.get(frame)?.invocation;
      return invocation?.arguments[index]?.source ?? invocation?.source ?? rawSpan;
    },
    enterFunction: (name: string, callableOrSpan: unknown, source?: RawSpan): void => {
      // The two-argument form keeps already-generated v2 programs executable.
      const rawSpan = source ?? (callableOrSpan as RawSpan);
      const callable = source === undefined ? undefined : callableOrSpan;
      const pending = this.#pendingDebugInstance;
      const invocation = this.#invocations.at(-1);
      const matches =
        invocation !== undefined && !invocation.entered && invocation.callable === callable;
      let segment: string;
      if (pending !== undefined) {
        segment = pending.segment;
        pending.path = Object.freeze([...this.#instancePath, segment]);
        this.#pendingDebugInstance = undefined;
      } else if (matches && invocation.segment !== undefined) {
        segment = invocation.segment;
      } else {
        segment = this.#allocateFunctionSegment(name);
      }
      this.#instancePath.push(segment);
      const frame: FunctionOwnershipFrame = {
        owner: Symbol(name),
        source: this.#span(rawSpan),
        borrows: [],
        moves: [],
      };
      if (matches) {
        for (const ownership of invocation.defaultNetworks) {
          if (ownership.consumedAt === undefined && ownership.owner !== 'lost') {
            ownership.owner = frame.owner;
          }
        }
      }
      this.#ownershipFrames.push(frame);
      if (matches) {
        invocation.entered = true;
        invocation.segment ??= segment;
      }
      this.#functionCalls.set(frame, { name, ...(matches ? { invocation } : {}) });
    },
    enterLoop: (name: string, value: unknown, _rawSpan: RawSpan): void => {
      if (value === undefined) {
        const occurrence = (this.#anonymousLoopCounts.get(name) ?? 0) + 1;
        this.#anonymousLoopCounts.set(name, occurrence);
        this.#instancePath.push(`${name} #${occurrence}`);
      } else {
        this.#instancePath.push(`for ${name}=${this.#provenanceFormatter.format(value)}`);
      }
      this.#ownershipFrames.push(undefined);
    },
    exitInstance: (rawSpan?: RawSpan): void => {
      const frame = this.#ownershipFrames.pop();
      if (this.#instancePath.pop() === undefined) {
        throw new Error('Executed provenance stack underflow.');
      }
      if (frame !== undefined) {
        this.#ownership.releaseFrame(frame, isRawSpan(rawSpan) ? this.#span(rawSpan) : undefined);
      }
    },
    instantiate: (...args: unknown[]): unknown => {
      this.#recordDslCall();
      const rawSpan = args.at(-1);
      const bindingName = args[0];
      const factory = args[1];
      const values = args.slice(2, -1);
      if (!isRawSpan(rawSpan)) throw new Error('t.instantiate(...) is missing provenance.');
      if (typeof bindingName !== 'string' || bindingName.length === 0) {
        throw new Error('t.instantiate(...) requires a stable instance name.');
      }
      if (typeof factory !== 'function') {
        throw new ElaborationExecutionError(
          't.instantiate(fn, ...args) requires a function as its first argument.',
          this.#span(rawSpan),
          'RT2026',
        );
      }
      if (this.#pendingDebugInstance !== undefined) {
        throw new Error('A debug instance factory entered another capture before function entry.');
      }
      const key = JSON.stringify([...this.#instancePath, bindingName]);
      const occurrence = (this.#debugInstanceCounts.get(key) ?? 0) + 1;
      this.#debugInstanceCounts.set(key, occurrence);
      const capture: PendingDebugInstance = {
        segment: `DUT ${bindingName}${occurrence === 1 ? '' : ` #${occurrence}`}`,
      };
      this.#pendingDebugInstance = capture;
      let value: unknown;
      try {
        value = (factory as (...factoryArgs: unknown[]) => unknown)(...values);
      } finally {
        if (this.#pendingDebugInstance === capture) this.#pendingDebugInstance = undefined;
      }
      if (capture.path === undefined) {
        throw new ElaborationExecutionError(
          't.instantiate(...) requires an instrumented function declaration.',
          this.#span(rawSpan),
          'RT2026',
        );
      }
      this.#debugInstances.push({
        name: bindingName,
        path: capture.path,
        source: this.#span(rawSpan),
        value: this.#debugValue(value, rawSpan, new Set()),
      });
      return Object.freeze({
        value,
        $: Object.freeze({ kind: 'debug-scope-token', name: bindingName, path: capture.path }),
      });
    },
    signal: (...args: unknown[]) => {
      this.#recordDslCall();
      const rawSpan = args.at(-1);
      const values = args.slice(0, -1);
      if (!isRawSpan(rawSpan) || values.length < 1 || values.length > 3) {
        throw new Error(
          'Signal(name) or Signal(type, name, quality?) requires one to three arguments.',
        );
      }
      if (!values.every((value) => typeof value === 'string')) {
        throw new Error('Signal(...) arguments must evaluate to strings.');
      }
      if (values.length === 1) return this.#signalHandle(Signal(values[0] as string));
      const [type, name, quality] = values as [SignalId['type'], string, string?];
      return this.#signalHandle(Signal(type, name, quality));
    },
    entity: (
      profile: unknown,
      configuration: unknown,
      placement: unknown,
      rawSpan: RawSpan,
    ): EntityValue => this.#constructEntity(profile, configuration, placement, rawSpan),
    entityFromPrototype: (arguments_: readonly CallArgument[], rawSpan: RawSpan): EntityValue =>
      this.#withTopologyTransaction(rawSpan, () =>
        this.#constructEntityFromPrototype(arguments_, rawSpan),
      ),
    entityFamilyFromPrototype: (
      constructorName: unknown,
      arguments_: readonly CallArgument[],
      rawSpan: RawSpan,
    ): EntityValue =>
      this.#withTopologyTransaction(rawSpan, () => {
        if (
          typeof constructorName !== 'string' ||
          !Object.prototype.hasOwnProperty.call(entityFamilyConstructionTypes, constructorName)
        ) {
          throw new ElaborationExecutionError(
            'Unknown Entity family constructor.',
            this.#span(rawSpan),
            'RT2027',
          );
        }
        const expectedType =
          entityFamilyConstructionTypes[
            constructorName as keyof typeof entityFamilyConstructionTypes
          ];
        return this.#constructEntityFromPrototype(
          arguments_,
          rawSpan,
          expectedType,
          constructorName,
        );
      }),
    nativeCondition: (
      arguments_: readonly CallArgument[],
      rawSpan: RawSpan,
    ): NativeConditionValue => this.#constructNativeCondition(arguments_, rawSpan),
    entityFacet: (
      value: unknown,
      connector: unknown,
      lane: unknown,
      rawSpan: RawSpan,
    ): NetworkValue => this.#projectEntity(value, connector, lane, rawSpan),
    bindEntity: (
      value: unknown,
      connector: unknown,
      lane: unknown,
      network: unknown,
      direction: unknown,
      rawSpan: RawSpan,
    ): EntityValue => this.#bindEntity(value, connector, lane, network, direction, rawSpan),
    wildcardToken: (value: WildcardName): WildcardTokenValue =>
      this.#runtimeValue({
        kind: 'wildcard-token',
        value,
      }),
    wildcard: (
      value: WildcardName,
      network: NetworkValue | CombinatorValue | PairValue,
      rawSpan: RawSpan,
    ): SelectedValue => {
      this.#recordDslCall();
      const facet = this.#rawNetworkFacet(network);
      const readable = facet ?? network;
      if (!this.#isNetwork(readable) && !this.#isPair(readable)) {
        throw new Error('Wildcard selection requires a Network or pair(a, b).');
      }
      this.#assertReadableValue(readable, rawSpan);
      return this.#selectedValue(readable, value);
    },
    constant: (...args: unknown[]): CombinatorValue => {
      const rawSpan = args.at(-1);
      if (!isRawSpan(rawSpan)) throw new Error('Constant combinator is missing provenance.');
      return this.#withTopologyTransaction(rawSpan, () => {
        this.#recordDslCall();
        const outputs = normalizeSignalValueSources(args.slice(0, -1), {
          isSignal: (value): value is SignalHandle => this.#isSignal(value),
          isSignalValue: (value): value is SignalValue => this.#isSignalValue(value),
        });
        const configuration = constantConfigurationFromOutputs(
          outputs.map(({ signal, value }) => ({ signal: this.#signalSnapshot(signal), value })),
        );
        return this.#createConstantProducer(
          configuration,
          rawSpan,
          outputs.map(({ signal, value }) => ({ signal, value })),
          false,
        );
      });
    },
    constantOverload: (
      arguments_: readonly CallArgument[],
      rawSpan: RawSpan,
    ): CombinatorValue | EntityValue =>
      this.#withTopologyTransaction(rawSpan, () => {
        this.#recordDslCall();
        if (!Array.isArray(arguments_)) {
          throw new ElaborationExecutionError(
            'Constant(...) arguments must be an evaluated argument list.',
            this.#span(rawSpan),
            'RT2027',
          );
        }
        const first = arguments_[0];
        const structural =
          first !== undefined &&
          (typeof first.value === 'string' || this.#isTrustedPrototypeRecord(first.value));
        if (
          structural ||
          arguments_.length === 0 ||
          arguments_.length > 2 ||
          arguments_.length === 2
        ) {
          return this.#constructEntityFromPrototype(
            arguments_,
            rawSpan,
            'constant-combinator',
            'Constant',
            false,
          );
        }
        if (arguments_.length !== 1) {
          throw new ElaborationExecutionError(
            'Constant(configuration) requires exactly one configuration argument, or use Constant(prototype, configuration?) for an Entity.',
            this.#span(rawSpan),
            'RT2027',
          );
        }
        let configuration;
        try {
          configuration = normalizeConstantConfigurationSource(
            first!.value,
            {
              isSignal: (value): value is SignalHandle => this.#isSignal(value),
              isSignalValue: (value): value is SignalValue => this.#isSignalValue(value),
            },
            '$.configuration',
          );
        } catch (error) {
          if (error instanceof ConstantConfigurationSourceError) {
            throw new ElaborationExecutionError(
              error.message,
              this.#span(first!.source),
              'RT2027',
              undefined,
              { cause: error },
            );
          }
          throw error;
        }
        const outputs = constantConfigurationToSparseBus(configuration).toJSON();
        return this.#createConstantProducer(configuration, rawSpan, outputs, true);
      }),
    arithmeticOverload: (arguments_: readonly CallArgument[], rawSpan: RawSpan): CombinatorValue =>
      this.#withTopologyTransaction(rawSpan, () => {
        this.#recordDslCall();
        if (!Array.isArray(arguments_) || arguments_.length !== 1) {
          throw new ElaborationExecutionError(
            'Arithmetic(configuration) requires exactly one configuration argument.',
            this.#span(rawSpan),
            'RT2027',
          );
        }
        const argument = arguments_[0]!;
        const configuration = this.#normalizeArithmeticConfigurationSource(
          argument.value,
          argument.source,
        );
        if (this.#resolveCanonicalArithmeticProfile(rawSpan) === undefined) {
          throw new ElaborationExecutionError(
            'Exact Arithmetic configuration requires a trusted base entity:arithmetic-combinator Entity profile.',
            this.#span(rawSpan),
            'RT2027',
          );
        }
        return this.#createCombinator(
          {
            kind: 'arithmetic',
            ...configuration,
            source: this.#span(rawSpan),
            instancePath: this.#path(),
          },
          rawSpan,
        );
      }),
    deciderOverload: (arguments_: readonly CallArgument[], rawSpan: RawSpan): CombinatorValue =>
      this.#withTopologyTransaction(rawSpan, () => {
        this.#recordDslCall();
        if (!Array.isArray(arguments_) || arguments_.length !== 1) {
          throw new ElaborationExecutionError(
            'Decider(configuration) requires exactly one configuration argument.',
            this.#span(rawSpan),
            'RT2027',
          );
        }
        const profile = this.#resolveCanonicalDeciderProfile(rawSpan);
        if (profile === undefined) {
          throw new ElaborationExecutionError(
            'Exact Decider configuration requires a trusted base entity:decider-combinator Entity profile.',
            this.#span(rawSpan),
            'RT2027',
          );
        }
        const configuration = this.#normalizeDeciderConfigurationSource(
          arguments_[0]!.value,
          arguments_[0]!.source,
          arguments_[0]!.fieldSources,
        );
        const instancePath = this.#path();
        const normal = this.#deciderRowsWithOrigins(
          configuration.outputs.map((row) => ({ ...row, instancePath })),
          'normal',
        );
        const alternate = this.#deciderRowsWithOrigins(
          (configuration.elseOutputs ?? []).map((row) => ({ ...row, instancePath })),
          'else',
        );
        const producer = this.#createCombinator(
          {
            kind: 'decider',
            condition: configuration.condition,
            output: normal.outputs[0] ?? alternate.outputs[0]!,
            outputs: normal.outputs,
            outputOrigins: normal.origins,
            ...(alternate.outputs.length === 0
              ? {}
              : { elseOutputs: alternate.outputs, elseOutputOrigins: alternate.origins }),
            source: this.#span(rawSpan),
            instancePath,
          },
          rawSpan,
        );
        // #createCombinator records the exact Decider association after the
        // descriptor is complete; exact and ergonomic forms share one link.
        return producer;
      }),
    network: (
      name: string | undefined,
      fixedColor: 'red' | 'green' | undefined,
      rawSpan: RawSpan,
      readBinding?: () => unknown,
    ): NetworkValue => {
      const value = this.#network(
        name ?? `$network:${++this.#anonymousOrdinal}`,
        rawSpan,
        fixedColor,
      );
      if (name !== undefined && readBinding !== undefined) {
        this.#captureNetworkAlias(name, readBinding, rawSpan);
      }
      return value;
    },
    pair: (...args: unknown[]): PairValue => {
      this.#recordDslCall();
      const rawSpan = args.at(-1);
      const values = args.slice(0, -1);
      if (!isRawSpan(rawSpan)) throw new Error('pair(a, b) is missing provenance.');
      if (values.length !== 2) {
        throw new ElaborationExecutionError(
          'pair(a, b) requires exactly two Network values.',
          this.#span(rawSpan),
          'RT2020',
        );
      }
      const networks = values.map((value) => this.#rawNetworkFacet(value));
      if (networks.some((value) => value === undefined)) {
        throw new ElaborationExecutionError(
          'pair(a, b) requires two Network values.',
          this.#span(rawSpan),
          'RT2020',
        );
      }
      const pairNetworks = networks as [NetworkValue, NetworkValue];
      for (const value of pairNetworks) this.#assertReadableNetwork(value, rawSpan);
      if (
        this.#networkState(pairNetworks[0]).ownership ===
        this.#networkState(pairNetworks[1]).ownership
      ) {
        throw new ElaborationExecutionError(
          'pair(a, b) requires two distinct logical Networks.',
          this.#span(rawSpan),
          'RT2020',
          [
            {
              message: 'The repeated Network is declared here.',
              span: pairNetworks[0].declaration,
            },
          ],
        );
      }
      this.#colors.different(
        this.#networkState(pairNetworks[0]).ownership,
        this.#networkState(pairNetworks[1]).ownership,
        this.#span(rawSpan),
        'pair(a, b) uses both wire colors',
      );
      const pair: PairValue = this.#runtimeValue({
        kind: 'pair',
        networks: pairNetworks,
        source: this.#span(rawSpan),
      });
      this.#networkPairs.push({
        networks: [pairNetworks[0].name, pairNetworks[1].name],
        provenance: pair.source,
        instancePath: this.#path(),
      });
      return pair;
    },
    join: (...args: unknown[]): NetworkValue => {
      this.#recordDslCall();
      const rawSpan = args.at(-1);
      if (!isRawSpan(rawSpan)) throw new Error('join(...) is missing provenance.');
      return this.#withTopologyTransaction(rawSpan, () =>
        this.#joinNetworks(args.slice(0, -1), rawSpan),
      );
    },
    implicitNetworkParameter: (
      value: unknown,
      parameter: string,
      fixedColor: 'red' | 'green' | undefined,
      declarationSpan: RawSpan,
      argumentSpan: RawSpan,
      requiresNetwork: boolean,
    ): unknown => {
      // Untyped functions remain ordinary JavaScript for non-Network values.
      // In particular, do not turn generic Producer arguments into Networks.
      if (!requiresNetwork && !this.#isNetwork(value)) return value;
      const network = bindNetworkReferenceParameter(
        value,
        {
          functionName: this.#currentFunctionName(),
          parameter,
          requiredType: 'Network',
          ...(fixedColor === undefined ? {} : { fixedColor }),
          source: this.#span(argumentSpan),
        },
        {
          networkFacet: (candidate) => this.#readableNetworkFacet(candidate, argumentSpan),
          recordDslCall: () => this.#recordDslCall(),
          acceptUnrestricted: (candidate) =>
            this.#acceptUnrestrictedNetwork(candidate, declarationSpan, parameter),
          requireColor: (candidate, color, source) =>
            this.#requireNetworkColor(candidate, 'readonly', color, {
              start: source.start,
              end: source.end,
            }),
        },
      );
      this.#recordUnrestrictedReferenceWarning(declarationSpan, parameter);
      return network;
    },
    parameterContract: (
      value: unknown,
      contract: DslParameterContract,
      parameter: string,
      declarationSpan: RawSpan,
      argumentSpan: RawSpan,
    ): unknown => {
      if (
        !isRawSpan(declarationSpan) ||
        !isRawSpan(argumentSpan) ||
        typeof parameter !== 'string'
      ) {
        throw new Error('Invalid executed parameter contract.');
      }
      const result = bindParameterContract(
        value,
        contract,
        {
          functionName: this.#currentFunctionName(),
          parameter,
          source: this.#span(argumentSpan),
          frame: this.#currentFunctionFrame(),
        },
        {
          networkFacet: (candidate) => this.#networkFacet(candidate),
          readableNetworkFacet: (candidate, source) =>
            this.#readableNetworkFacet(candidate, source),
          isConcreteNetworkSignal: (candidate) => this.#isConcreteNetworkSignal(candidate),
          bindNetworkSignal: (candidate, parameter, source) =>
            this.#networkSignalParameter(candidate, parameter, this.#rawSpan(source)),
          isNetwork: (candidate): candidate is NetworkValue => this.#isNetwork(candidate),
          isCombinator: (candidate): candidate is CombinatorValue => this.#isCombinator(candidate),
          selectCombinatorMove: (candidate, source) =>
            this.#selectCombinatorMove(candidate, source),
          isPair: (candidate): candidate is PairValue => this.#isPair(candidate),
          isPairSelection: (candidate): candidate is PairSelectedValue =>
            this.#isPairSelection(candidate),
          recordDslCall: () => this.#recordDslCall(),
          stateFor: (network) => this.#networkState(network),
          assertReadable: (network, source) => this.#ownership.assertReadable(network, source),
          assertConsumable: (network, source, role) =>
            this.#ownership.assertConsumable(network, source, role),
          requireColor: (network, capability, color, source) =>
            this.#requireNetworkColor(network, capability, color, {
              start: source.start,
              end: source.end,
            }),
          borrow: (network, capability, name, source, frame) =>
            this.#ownership.borrow(network, capability, name, source, frame),
          moveToFrame: (network, source, frame) =>
            this.#ownership.moveToFrame(network, source, frame),
          brandNetwork: (network, state) => this.#networkValue(network, state),
          bindCombinator: (candidate, producerType, _name, source) =>
            this.#combinatorHandle(candidate, producerType, source),
          bindNetwork: (candidate, capability, name, color, source) =>
            this.#networkParameter(candidate, capability, name, color, {
              start: source.start,
              end: source.end,
            }),
          acceptUnrestricted: (network) =>
            this.#acceptUnrestrictedNetwork(network, declarationSpan, parameter),
        },
      );
      return result;
    },
    borrowParameter: (
      value: unknown,
      capability: 'readonly' | 'ref',
      parameter: string,
      fixedColor: 'red' | 'green' | undefined,
      rawSpan: RawSpan,
    ): NetworkValue => {
      if (!isRawSpan(rawSpan) || (capability !== 'readonly' && capability !== 'ref')) {
        throw new Error('Invalid Network parameter capability descriptor.');
      }
      return this.#networkParameter(value, capability, parameter, fixedColor, rawSpan);
    },
    moveParameter: (
      value: unknown,
      parameter: string,
      fixedColor: 'red' | 'green' | undefined,
      rawSpan: RawSpan,
    ): NetworkValue => {
      if (!isRawSpan(rawSpan)) throw new Error('Invalid Move<Network> parameter descriptor.');
      return this.#networkParameter(value, 'move', parameter, fixedColor, rawSpan);
    },
    producerHandle: (
      value: unknown,
      expectedType: unknown,
      bindingName: unknown,
      rawSpan: RawSpan,
    ): CombinatorValue => {
      return this.#combinatorHandle(value, expectedType, rawSpan, bindingName);
    },
    combinatorParameter: (
      value: unknown,
      expectedType: unknown,
      parameter: unknown,
      rawSpan: RawSpan,
    ): CombinatorValue => {
      if (typeof parameter !== 'string') {
        throw new Error('Combinator parameter name must be a string.');
      }
      const combinator = this.#combinatorHandle(value, expectedType, rawSpan);
      const networkFacet = this.#networkParameter(
        combinator,
        'readonly',
        parameter,
        undefined,
        rawSpan,
      );
      return this.#runtimeValue({
        kind: 'combinator',
        identity: combinator.identity,
        networkFacet,
        unrestrictedHandle: combinator.unrestrictedHandle ?? combinator,
      });
    },
    returnValue: (value: unknown, rawSpan: RawSpan, producerType?: unknown): unknown => {
      if (producerType !== undefined) {
        const combinator = this.#combinatorHandle(value, producerType, rawSpan);
        return this.#returnCombinator(combinator, rawSpan);
      }
      return this.#returnOwnedValue(value, rawSpan);
    },
    returnNetwork: (
      value: unknown,
      capability: unknown,
      fixedColor: unknown,
      rawSpan: RawSpan,
    ): NetworkValue => {
      if (
        !isRawSpan(rawSpan) ||
        (capability !== 'owned' && capability !== 'readonly') ||
        (fixedColor !== undefined && fixedColor !== 'red' && fixedColor !== 'green')
      ) {
        throw new Error(
          'A function Network return must be Network or Readonly<Network>, optionally with R/G.',
        );
      }
      return returnNetworkValue(
        value,
        {
          capability,
          ...(fixedColor === undefined ? {} : { fixedColor }),
          source: this.#span(rawSpan),
        },
        {
          networkFacet: (candidate) => this.#networkFacet(candidate),
          requireColor: (network, requiredCapability, color) =>
            this.#requireNetworkColor(network, requiredCapability, color, rawSpan),
          transferToCaller: (network) => this.#returnOwnedNetwork(network, rawSpan),
          assertReadable: (network, source) => this.#ownership.assertReadable(network, source),
          isTransparentAlias: (network) => this.#isTransparentNetwork(network),
          returnTransparent: (network) => network,
          stateFor: (network) => this.#networkState(network),
          brandNetwork: (network, state) => this.#networkValue(network, state),
        },
      );
    },
    networkArgument: (
      value: unknown,
      functionName: unknown,
      parameter: unknown,
      capability: unknown,
      fixedColor: unknown,
      rawSpan: RawSpan,
    ): NetworkValue => {
      if (
        !isRawSpan(rawSpan) ||
        typeof functionName !== 'string' ||
        typeof parameter !== 'string' ||
        !['owned', 'readonly', 'ref', 'move'].includes(String(capability)) ||
        (fixedColor !== undefined && fixedColor !== 'red' && fixedColor !== 'green')
      ) {
        throw new Error('Invalid Network call-argument descriptor.');
      }
      return resolveNetworkArgument(
        value,
        {
          functionName,
          parameter,
          capability: capability as NetworkValue['capability'],
          ...(fixedColor === undefined ? {} : { fixedColor }),
          source: this.#span(rawSpan),
        },
        {
          networkFacet: (candidate) =>
            capability === 'readonly'
              ? this.#readableNetworkFacet(candidate, rawSpan)
              : this.#networkFacet(candidate),
          assertReadable: (network, source, role) =>
            this.#ownership.assertReadable(network, source, role),
          stateFor: (network) => this.#networkState(network),
          brandNetwork: (network, state) => this.#networkValue(network, state),
        },
      );
    },
    take: (...args: unknown[]): unknown => {
      const rawSpan = args.at(-1);
      const destination = args[0];
      const values = args.slice(1, -1);
      if (!isRawSpan(rawSpan)) throw new Error('.take(...) is missing provenance.');
      if (
        this.#isPair(destination) ||
        this.#isPairSelection(destination) ||
        values.some((value) => this.#isPair(value) || this.#isPairSelection(value))
      ) {
        throw new ElaborationExecutionError(
          'pair(a, b) is a read-only input view and cannot participate in .take(...).',
          this.#span(rawSpan),
          'RT2020',
        );
      }
      const destinationNetwork = this.#resolveNetworkFacet(destination, rawSpan, 'destination');
      if (destinationNetwork === undefined) {
        if (
          (typeof destination !== 'object' && typeof destination !== 'function') ||
          destination === null ||
          typeof (destination as { take?: unknown }).take !== 'function'
        ) {
          throw new Error(
            '.take(source) requires a destination Network or an ordinary .take method.',
          );
        }
        return (destination as { take: (...items: unknown[]) => unknown }).take(...values);
      }
      this.#recordDslCall();
      if (values.length !== 1) {
        throw new Error('.take(source) requires exactly one source Network.');
      }
      const source = values[0];
      const sourceNetwork = this.#resolveNetworkFacet(source, rawSpan, 'source');
      if (sourceNetwork === undefined) {
        throw new Error('.take(source) requires a source Network.');
      }
      this.#assertConsumableNetwork(destinationNetwork, rawSpan, 'destination');
      this.#transferNetwork(destinationNetwork, sourceNetwork, rawSpan);
      return destination;
    },
    bind: (
      value: unknown,
      name: string,
      fixedColor: 'red' | 'green' | undefined,
      networkNarrowing: boolean,
      rawSpan: RawSpan,
      readBinding?: () => unknown,
    ): unknown => {
      let result: unknown;
      if (this.#isCombinator(value)) {
        const network = this.#rawNetworkFacet(value)!;
        this.#combinators.bindName(value, name);
        if (fixedColor !== undefined) {
          this.#requireNetworkColor(network, 'readonly', fixedColor, rawSpan);
        }
        result = networkNarrowing ? network : value;
      } else {
        if (this.#isNetwork(value) && fixedColor !== undefined) {
          this.#requireNetworkColor(value, 'readonly', fixedColor, rawSpan);
        }
        result = value;
      }
      if (readBinding !== undefined) this.#captureNetworkAlias(name, readBinding, rawSpan);
      return result;
    },
    narrowNetwork: (
      value: unknown,
      fixedColor: 'red' | 'green' | undefined,
      rawSpan: RawSpan,
    ): NetworkValue => {
      this.#recordDslCall();
      if (
        !isRawSpan(rawSpan) ||
        (fixedColor !== undefined && !['red', 'green'].includes(fixedColor))
      ) {
        throw new Error('Invalid explicit Network narrowing descriptor.');
      }
      const network = this.#networkFacet(value);
      if (network === undefined) {
        throw new ElaborationExecutionError(
          'A Network assertion requires a Network or physical Combinator value.',
          this.#span(rawSpan),
          'RT2015',
        );
      }
      if (fixedColor !== undefined)
        this.#requireNetworkColor(network, 'readonly', fixedColor, rawSpan);
      return network;
    },
    bindArray: (
      value: unknown,
      descriptors: readonly (BindingDescriptor | null)[],
      rawSpan: RawSpan,
    ): unknown => {
      if (!Array.isArray(descriptors)) throw new Error('Invalid array binding descriptors.');
      if (this.#isSelected(value)) {
        throw new ElaborationExecutionError(
          'A Network selection cannot be destructured; use .signal or .network explicitly.',
          this.#span(rawSpan),
          'RT2022',
        );
      }
      if (this.#isNetwork(value)) {
        throw new ElaborationExecutionError(
          'A Network value cannot be destructured; return an explicit array of Networks.',
          this.#span(rawSpan),
          'RT2022',
        );
      }
      const hasProducerBindings = descriptors.some(
        (descriptor) => descriptor?.producerType !== undefined,
      );
      if (!this.#isCombinator(value)) {
        if (!hasProducerBindings) return value;
        if (!Array.isArray(value)) {
          throw new ElaborationExecutionError(
            'Combinator tuple bindings require an executed array value.',
            this.#span(rawSpan),
            'RT2022',
          );
        }
        const result = [...value];
        for (const [index, descriptor] of descriptors.entries()) {
          if (descriptor?.producerType !== undefined) {
            result[index] = this.#combinatorHandle(
              result[index],
              descriptor.producerType,
              rawSpan,
              descriptor.name,
            );
          }
        }
        return result;
      }
      if (hasProducerBindings) {
        throw new ElaborationExecutionError(
          'A single Combinator cannot be destructured into Combinator handles; put handles in an ordinary array first.',
          this.#span(rawSpan),
          'RT2022',
        );
      }
      const bindings = descriptors.map((descriptor, index) =>
        descriptor === null
          ? undefined
          : this.#projectCombinatorOutput(value, index, descriptor, rawSpan),
      );
      return bindings;
    },
    bindObject: (
      value: unknown,
      descriptors: readonly (BindingDescriptor | null)[],
      rawSpan: RawSpan,
    ): unknown => {
      if (!Array.isArray(descriptors)) throw new Error('Invalid object binding descriptors.');
      if (this.#isSelected(value)) {
        const state = this.#selectedState(value);
        if (state.kind !== 'concrete') {
          throw new ElaborationExecutionError(
            'A pair or wildcard Network selection cannot be destructured; use an explicit selection member.',
            this.#span(rawSpan),
            'RT2022',
          );
        }
        const entries = descriptors.map((descriptor) => {
          if (
            descriptor === null ||
            descriptor.property === undefined ||
            descriptor.producerType !== undefined ||
            (descriptor.property !== 'signal' && descriptor.property !== 'network')
          ) {
            throw new ElaborationExecutionError(
              'A concrete Network selection only supports flat signal and network destructuring.',
              this.#span(rawSpan),
              'RT2022',
            );
          }
          return [
            descriptor.property,
            descriptor.property === 'signal' ? state.selection : state.readonlyNetwork,
          ] as const;
        });
        return Object.fromEntries(entries);
      }
      if (this.#isNetwork(value)) {
        throw new ElaborationExecutionError(
          'A Network value cannot be destructured; return an explicit object of Networks.',
          this.#span(rawSpan),
          'RT2022',
        );
      }
      const producerDescriptors = descriptors.filter(
        (descriptor): descriptor is BindingDescriptor => descriptor?.producerType !== undefined,
      );
      if (!this.#isCombinator(value)) {
        if (producerDescriptors.length === 0) return value;
        if (typeof value !== 'object' || value === null || Array.isArray(value)) {
          throw new ElaborationExecutionError(
            'Combinator object bindings require an executed object value.',
            this.#span(rawSpan),
            'RT2022',
          );
        }
        const snapshot = Object.assign({}, value) as Record<string, unknown>;
        for (const descriptor of producerDescriptors) {
          if (descriptor.property === undefined) {
            throw new Error('Combinator object bindings require flat named properties.');
          }
          snapshot[descriptor.property] = this.#combinatorHandle(
            snapshot[descriptor.property],
            descriptor.producerType,
            rawSpan,
            descriptor.name,
          );
        }
        return snapshot;
      }
      if (producerDescriptors.length !== 0) {
        throw new ElaborationExecutionError(
          'A single Combinator cannot be destructured into Combinator handles; put handles in an ordinary object first.',
          this.#span(rawSpan),
          'RT2022',
        );
      }
      const entries = descriptors.map((descriptor, index) => {
        if (descriptor === null || descriptor.property === undefined) {
          throw new Error('Combinator object binding requires flat named properties.');
        }
        return [
          descriptor.property,
          this.#projectCombinatorOutput(value, index, descriptor, rawSpan),
        ] as const;
      });
      return Object.fromEntries(entries);
    },
    compare: (operator: string, left: unknown, right: unknown, rawSpan: RawSpan): unknown => {
      return operators.dispatchComparison(operator, left, right, rawSpan, this.#operatorContext);
    },
    controlTest: (value: unknown, rawSpan: RawSpan): unknown => {
      if (this.#isCondition(value)) {
        throw new ElaborationExecutionError(
          'A circuit Condition cannot be used as a JavaScript control-flow test; use IF(...) or when(...).then(...) to create circuit logic.',
          this.#span(rawSpan),
          'RT2024',
        );
      }
      return value;
    },
    decider: (...args: unknown[]): CombinatorValue => {
      const rawSpan = args.at(-1);
      const condition = args[0];
      const outputValues = args.slice(1, -1);
      if (!isRawSpan(rawSpan)) throw new Error('IF/when is missing provenance.');
      return this.#withTopologyTransaction(rawSpan, () => {
        this.#recordDslCall();
        if (!this.#isCondition(condition)) throw new Error('IF/when requires a circuit condition.');
        if (outputValues.length === 0) {
          throw new Error('IF/when requires at least one output specification.');
        }
        const instancePath = this.#path();
        const rows = outputValues.map((output) =>
          this.#deciderOutputCandidate(output, rawSpan, instancePath),
        );
        const normal = this.#deciderRowsWithOrigins(rows, 'normal');
        return this.#createCombinator(
          {
            kind: 'decider',
            condition: condition.condition,
            output: normal.outputs[0]!,
            outputs: normal.outputs,
            outputOrigins: normal.origins,
            source: this.#span(rawSpan),
            instancePath: instancePath,
          },
          rawSpan,
        );
      });
    },
    deciderStart: (condition: unknown, rawSpan: RawSpan): CombinatorValue => {
      if (!isRawSpan(rawSpan)) throw new Error('when(...) is missing provenance.');
      return this.#withTopologyTransaction(rawSpan, () => {
        this.#recordDslCall();
        if (!this.#isCondition(condition))
          throw new Error('when(...) requires a circuit condition.');
        return this.#createCombinator(
          {
            kind: 'decider',
            condition: condition.condition,
            source: this.#span(rawSpan),
            instancePath: this.#path(),
          },
          rawSpan,
        );
      });
    },
    appendDecider: (
      value: unknown,
      branch: 'then' | 'else',
      outputs: readonly unknown[],
      rawSpan: RawSpan,
    ): CombinatorValue =>
      this.#appendDecider(
        value,
        branch,
        outputs.flatMap((output) => this.#deciderOutputs(output, rawSpan)),
        rawSpan,
      ),
    appendDeciderArguments: (
      value: unknown,
      branch: 'then' | 'else',
      outputs: readonly CallArgument[],
      rawSpan: RawSpan,
    ): CombinatorValue => this.#appendDeciderArguments(value, branch, outputs, rawSpan),
    deciderBranches: (
      condition: unknown,
      thenValue: unknown,
      elseValue: unknown,
      rawSpan?: RawSpan,
    ): CombinatorValue => {
      const branchArguments =
        rawSpan === undefined &&
        isRawSpan(elseValue) &&
        Array.isArray(thenValue) &&
        thenValue.every(
          (argument): argument is CallArgument =>
            typeof argument === 'object' && argument !== null && isRawSpan(argument.source),
        )
          ? thenValue
          : undefined;
      const actualRawSpan = branchArguments === undefined ? rawSpan : elseValue;
      if (!isRawSpan(actualRawSpan)) throw new Error('IF/when is missing provenance.');
      return this.#withTopologyTransaction(actualRawSpan, () => {
        this.#recordDslCall();
        if (!this.#isCondition(condition)) throw new Error('IF/when requires a circuit condition.');
        if (
          branchArguments !== undefined &&
          (branchArguments.length < 1 || branchArguments.length > 2)
        ) {
          throw new Error('IF requires one or two branch output arguments.');
        }
        const thenRows =
          branchArguments === undefined
            ? this.#deciderOutputs(thenValue, actualRawSpan)
            : this.#deciderOutputs(
                branchArguments[0]!.value,
                actualRawSpan,
                branchArguments[0]!.source,
              );
        const elseRows =
          branchArguments === undefined
            ? this.#deciderOutputs(elseValue, actualRawSpan)
            : branchArguments.length === 1
              ? []
              : this.#deciderOutputs(
                  branchArguments[1]!.value,
                  actualRawSpan,
                  branchArguments[1]!.source,
                );
        if (thenRows.length === 0 && elseRows.length === 0) {
          throw new Error('IF/when requires at least one output specification.');
        }
        const normal = this.#deciderRowsWithOrigins(thenRows, 'normal');
        const alternate = this.#deciderRowsWithOrigins(elseRows, 'else');
        return this.#createCombinator(
          {
            kind: 'decider',
            condition: condition.condition,
            output: normal.outputs[0] ?? alternate.outputs[0]!,
            outputs: normal.outputs,
            outputOrigins: normal.origins,
            ...(alternate.outputs.length === 0
              ? {}
              : { elseOutputs: alternate.outputs, elseOutputOrigins: alternate.origins }),
            source: this.#span(actualRawSpan),
            instancePath: this.#path(),
          },
          actualRawSpan,
        );
      });
    },
    logical: (
      operator: 'and' | 'or',
      evaluateLeft: () => unknown,
      evaluateRight: () => unknown,
      _rawSpan: RawSpan,
    ): unknown => {
      const left = evaluateLeft();
      if (!this.#isCondition(left)) {
        return operator === 'and' ? (left ? evaluateRight() : left) : left ? left : evaluateRight();
      }
      this.#recordDslCall();
      const right = evaluateRight();
      if (!this.#isCondition(right)) {
        throw new Error('Cannot mix compile-time booleans with circuit Conditions.');
      }
      return this.#runtimeValue({
        kind: 'condition',
        condition: { kind: operator, conditions: [left.condition, right.condition] },
      });
    },
    not: (value: unknown, _rawSpan: RawSpan): unknown => {
      if (!this.#isCondition(value)) return !value;
      this.#recordDslCall();
      return this.#runtimeValue({
        kind: 'condition',
        condition: operators.invertCondition(value.condition),
      });
    },
    destinations: (...args: unknown[]): DestinationValue => {
      const rawSpan = args.at(-1);
      if (!isRawSpan(rawSpan)) throw new Error('to(...) is missing provenance.');
      return this.#withTopologyTransaction(rawSpan, () => {
        this.#recordDslCall();
        const values = args.slice(0, -1);
        const source = this.#span(rawSpan);
        if (values.some((value) => this.#isPair(value) || this.#isPairSelection(value))) {
          throw new ElaborationExecutionError(
            'pair(a, b) is a read-only input view and cannot be a to(...) destination.',
            source,
            'RT2020',
          );
        }
        const selected = values.length === 1 && this.#isSelected(values[0]) ? values[0] : undefined;
        const selectedValue =
          selected === undefined ? undefined : this.#selectedSelection(selected);
        const selectedSignal =
          selectedValue === undefined || !isSignalId(selectedValue) ? undefined : selectedValue;
        if (values.some((value) => this.#isSelected(value)) && selectedSignal === undefined) {
          throw new ElaborationExecutionError(
            '.to(...) permits Network[SIGNAL] only for one destination; use .to(first, second, SIGNAL) for fan-out.',
            source,
            'RT2003',
          );
        }
        const selectedNetwork =
          selected === undefined
            ? undefined
            : this.#resolveWritableNetwork(selected, rawSpan, 'destination');
        const networks =
          selectedNetwork === undefined
            ? values.map((value) => this.#resolveWritableNetwork(value, rawSpan, 'destination'))
            : [selectedNetwork];
        if (!networks.every((value): value is NetworkValue => value !== undefined)) {
          throw new ElaborationExecutionError(
            'to(...) destinations must be Networks.',
            source,
            'RT2015',
          );
        }
        return this.#runtimeValue({
          kind: 'destinations',
          networks,
          ...(selectedSignal === undefined ? {} : { signal: selectedSignal }),
        });
      });
    },
    select: (
      value: NetworkValue | PairValue | DestinationValue,
      signal: SignalId | WildcardTokenValue,
      rawSpan: RawSpan,
    ): SelectedValue | DestinationValue => {
      this.#recordDslCall();
      return this.#select(value, signal, rawSpan);
    },
    element: (value: unknown, key: unknown, rawSpan: RawSpan): unknown => {
      if (this.#isSelected(value)) {
        this.#recordDslCall();
        return this.#selectedMember(value, key);
      }
      if (this.#isCombinator(value) && (key === 'then' || key === 'else')) {
        return this.#member(value, key, rawSpan);
      }
      if (
        this.#isNetwork(value) ||
        this.#isCombinator(value) ||
        this.#isPair(value) ||
        this.#isDestination(value)
      ) {
        this.#recordDslCall();
        return this.#select(value, key, rawSpan);
      }
      if (value === null || value === undefined) {
        throw new TypeError(`Cannot read properties of ${String(value)}.`);
      }
      return (value as Record<PropertyKey, unknown>)[key as PropertyKey];
    },
    bindOutput: (producer: unknown, signal: SignalId, rawSpan: RawSpan): unknown => {
      if (!isRawSpan(rawSpan)) throw new Error('.as(...) is missing provenance.');
      if (this.#isNetwork(producer) || this.#isCombinator(producer)) {
        throw new ElaborationExecutionError(
          '.as(...) is not part of the Combinator API; bind an arithmetic output through destination[SIGNAL] or combinator.to(destination, SIGNAL).',
          this.#span(rawSpan),
          'RT2021',
        );
      }
      if (
        (typeof producer !== 'object' && typeof producer !== 'function') ||
        producer === null ||
        typeof (producer as { as?: unknown }).as !== 'function'
      ) {
        throw new Error('.as(...) requires an ordinary .as method; DSL values do not support it.');
      }
      return (producer as { as: (value: unknown) => unknown }).as(signal);
    },
    place: (...args: unknown[]): unknown => {
      const rawSpan = args.at(-1);
      const producer = args[0];
      const x = args[1];
      const y = args[2];
      const direction = args.length === 5 ? args[3] : undefined;
      if (!isRawSpan(rawSpan)) {
        throw new Error('.at(...) is missing provenance.');
      }
      const entityLike =
        this.#isEntity(producer) ||
        (typeof producer === 'object' &&
          producer !== null &&
          (producer as { kind?: unknown }).kind === 'entity' &&
          typeof (producer as { at?: unknown }).at !== 'function');
      if (entityLike) {
        this.#recordDslCall();
        const source = this.#span(rawSpan);
        const authority = this.#entityAuthority(producer, source);
        if (args.length !== 4 && args.length !== 5) {
          throw new ElaborationExecutionError(
            'Entity.at(x, y, direction?) requires two or three arguments.',
            source,
            'RT2027',
          );
        }
        if (
          typeof x !== 'number' ||
          !Number.isFinite(x) ||
          typeof y !== 'number' ||
          !Number.isFinite(y)
        ) {
          throw new ElaborationExecutionError(
            'Entity.at(x, y, direction?) requires finite numeric coordinates.',
            source,
            'RT2027',
          );
        }
        if (
          direction !== undefined &&
          (typeof direction !== 'number' ||
            !Number.isInteger(direction) ||
            direction < 0 ||
            direction > 15)
        ) {
          throw new ElaborationExecutionError(
            'Entity.at(...) direction must be an integer from 0 through 15.',
            source,
            'RT2027',
          );
        }
        const placement: EntityPlacement = {
          x,
          y,
          ...(direction === undefined ? {} : { direction }),
        };
        const registry = this.#entityRegistry;
        if (registry === undefined) {
          throw new ElaborationExecutionError(
            'Entity placement requires a trusted v3 context and prototype resolver.',
            source,
            'RT2027',
          );
        }
        try {
          registry.replacePlacement(authority.entity, placement);
        } catch (error) {
          throw new ElaborationExecutionError(
            error instanceof Error ? error.message : 'Entity placement failed.',
            source,
            'RT2027',
            undefined,
            { cause: error },
          );
        }
        return producer;
      }
      if (!this.#isCombinator(producer)) {
        if (
          (typeof producer !== 'object' && typeof producer !== 'string') ||
          producer === null ||
          typeof (producer as { at?: unknown }).at !== 'function'
        ) {
          throw new Error('.at(...) requires a combinator producer or an ordinary .at method.');
        }
        return (producer as { at: (...values: unknown[]) => unknown }).at(...args.slice(1, -1));
      }
      const linked = this.#linkedProducerByIdentity.get(producer.identity);
      if (linked !== undefined) {
        this.#recordDslCall();
        if (args.length !== 4 && args.length !== 5) {
          throw new ElaborationExecutionError(
            '.at(x, y, direction?) requires two or three arguments.',
            this.#span(rawSpan),
            'RT2027',
          );
        }
        if (
          typeof x !== 'number' ||
          !Number.isFinite(x) ||
          typeof y !== 'number' ||
          !Number.isFinite(y)
        ) {
          throw new ElaborationExecutionError(
            '.at(x, y, direction?) requires finite numeric coordinates.',
            this.#span(rawSpan),
            'RT2027',
          );
        }
        if (
          direction !== undefined &&
          (typeof direction !== 'number' ||
            !Number.isInteger(direction) ||
            direction < 0 ||
            direction > 15)
        ) {
          throw new ElaborationExecutionError(
            '.at(...) direction must be an integer from 0 through 15.',
            this.#span(rawSpan),
            'RT2027',
          );
        }
        const registry = this.#entityRegistry;
        if (registry === undefined) {
          throw new ElaborationExecutionError(
            'Linked combinator placement requires a trusted Entity registry.',
            this.#span(rawSpan),
            'RT2027',
          );
        }
        try {
          registry.replacePlacement(linked.entity, {
            x,
            y,
            ...(direction === undefined ? {} : { direction }),
          });
        } catch (error) {
          throw new ElaborationExecutionError(
            error instanceof Error ? error.message : 'Linked combinator placement failed.',
            this.#span(rawSpan),
            'RT2027',
            undefined,
            { cause: error },
          );
        }
        return producer;
      }
      this.#recordDslCall();
      if (args.length !== 4 && args.length !== 5) {
        throw new Error('.at(x, y, direction?) requires two or three arguments.');
      }
      if (
        typeof x !== 'number' ||
        !Number.isFinite(x) ||
        typeof y !== 'number' ||
        !Number.isFinite(y)
      ) {
        throw new Error('.at(x, y, direction?) requires finite numeric coordinates.');
      }
      if (
        direction !== undefined &&
        (typeof direction !== 'number' ||
          !Number.isInteger(direction) ||
          direction < 0 ||
          direction > 15)
      ) {
        throw new Error('.at(...) direction must be an integer from 0 through 15.');
      }
      const placement: PlanEntityPlacement = {
        x,
        y,
        ...(direction === undefined ? {} : { direction }),
      };
      const state = this.#combinators.stateFor(producer);
      this.#combinators.update(producer, { ...state.descriptor, placement });
      return producer;
    },
    attachTo: (...args: unknown[]): unknown => {
      const rawSpan = args.at(-1);
      const producer = args[0];
      const values = args.slice(1, -1);
      if (!isRawSpan(rawSpan)) throw new Error('.to(...) is missing provenance.');
      if (!this.#isCombinator(producer)) {
        if (
          (typeof producer !== 'object' && typeof producer !== 'function') ||
          producer === null ||
          typeof (producer as { to?: unknown }).to !== 'function'
        ) {
          throw new Error('.to(...) requires a combinator producer or an ordinary .to method.');
        }
        return (producer as { to: (...items: unknown[]) => unknown }).to(...values);
      }
      return this.#withTopologyTransaction(rawSpan, () => {
        this.#recordDslCall();
        return this.#attachToCombinator(producer, values, rawSpan);
      });
    },
    binary: (operator: string, left: unknown, right: unknown, rawSpan: RawSpan): unknown => {
      return operators.dispatchBinary(operator, left, right, rawSpan, this.#operatorContext);
    },
    addAssign: (
      left: unknown,
      right: unknown,
      assign: (value: unknown) => unknown,
      rawSpan: RawSpan,
    ): unknown => {
      const destination =
        this.#isNetwork(left) ||
        this.#isCombinator(left) ||
        this.#isPair(left) ||
        this.#isSelected(left) ||
        this.#isDestination(left);
      const entityRight = this.#isEntity(right);
      const operation = (): unknown => {
        if (destination) this.#assertWritableValue(left, rawSpan);
        if (entityRight) {
          return this.#bindEntityOutput(left, right as EntityValue, rawSpan);
        }
        if (destination && this.#isCombinator(right)) {
          this.#recordDslCall();
          this.#attachDestination(
            left as NetworkValue | CombinatorValue | PairValue | SelectedValue | DestinationValue,
            right,
            rawSpan,
          );
          return left;
        }
        if (destination) {
          throw new ElaborationExecutionError(
            'Network += requires a combinator producer; constants and Networks are not implicit attachments.',
            this.#span(rawSpan),
            'RT2015',
          );
        }
        if (this.#isCombinator(right)) {
          throw new ElaborationExecutionError(
            'A combinator producer can only be attached to a Network destination.',
            this.#span(rawSpan),
            'RT2015',
          );
        }
        // The casts affect only TypeScript's checker; emitted JavaScript retains its native `+`
        // coercion rules for non-DSL values.
        const result = (left as number) + (right as number);
        assign(result);
        return result;
      };
      return destination || entityRight || this.#isCombinator(right)
        ? this.#withTopologyTransaction(rawSpan, operation)
        : operation();
    },
    attach: (
      destination: NetworkValue | CombinatorValue | PairValue | SelectedValue | DestinationValue,
      producer: CombinatorValue,
      rawSpan: RawSpan,
    ): void => {
      this.#withTopologyTransaction(rawSpan, () => {
        this.#recordDslCall();
        this.#attachDestination(destination, producer, rawSpan);
      });
    },
  });

  plan():
    | DirectElaborationPlan
    | DirectElaborationPlanV3
    | DirectElaborationPlanV4
    | DirectElaborationPlanV5
    | DirectElaborationPlanV6 {
    if (this.#status === 'failed') throw this.#firstFailure;
    if (this.#status === 'sealed') {
      throw new Error('The elaboration runtime has already been sealed.');
    }
    try {
      const hasLinkedDecider = this.#linkedProducers.some(
        ({ association }) => association.kind === 'decider',
      );
      const hasLinkedArithmetic = this.#linkedProducers.some(
        ({ association }) => association.kind === 'arithmetic',
      );
      this.#finalizeUnusedCombinators();
      this.#validateFinalDeciderModes();
      const declarations = new Map(this.#networks.map((network) => [network.name, network]));
      const common = {
        format: 'comblang-direct-plan' as const,
        networks: Object.freeze([...this.#networks]),
        networkAliases: Object.freeze(
          [...this.#networkAliases.values()].flatMap(({ read, ...alias }) => {
            const value = read();
            const network = this.#rawNetworkFacet(value);
            if (network === undefined) return [];
            const state = this.#networkState(network);
            // Borrowed local views expire with their call frame. Physical declarations
            // remain in the index independently of their original source handles.
            if (state.borrow !== undefined) return [];
            const declaration = declarations.get(network.name);
            if (
              declaration !== undefined &&
              declaration.name === alias.name &&
              JSON.stringify(declaration.instancePath) === JSON.stringify(alias.instancePath) &&
              alias.source.start <= declaration.source.start &&
              alias.source.end >= declaration.source.end
            )
              return [];
            return [
              Object.freeze({
                ...alias,
                network: network.name,
                moved:
                  network.generation !== state.ownership.generation ||
                  state.ownership.consumedAt !== undefined,
              }),
            ];
          }),
        ),
        networkTransfers: Object.freeze([...this.#networkTransfers]),
        networkPairs: Object.freeze([...this.#networkPairs]),
        capabilityUses: Object.freeze([...this.#capabilityUses]),
        producers: Object.freeze(
          this.#combinators.states().map((state) => {
            const producer = this.#combinators.toPlan(state);
            const v6Producer =
              hasLinkedDecider && producer.kind === 'decider' && state.descriptor.kind === 'decider'
                ? {
                    ...producer,
                    outputs:
                      state.descriptor.outputs ??
                      (state.descriptor.output === undefined ? [] : [state.descriptor.output]),
                    outputOrigins: state.descriptor.outputOrigins ?? [],
                    ...(state.descriptor.elseOutputs === undefined
                      ? {}
                      : {
                          elseOutputs: state.descriptor.elseOutputs,
                          elseOutputOrigins: state.descriptor.elseOutputOrigins ?? [],
                        }),
                  }
                : producer;
            const linked = this.#linkedProducerByIdentity.get(state.identity);
            return linked === undefined
              ? v6Producer
              : Object.freeze({ ...v6Producer, entityId: linked.entity.id });
          }),
        ),
        diagnostics: Object.freeze([...this.#diagnostics]),
      };
      for (const authority of this.#entityAuthorityList) {
        if (authority.owner === 'retired') continue;
        for (const facet of authority.facets.values()) {
          this.#assertReadableNetworkAt(facet.network, facet.source, 'Entity facet');
        }
      }
      const entities = this.#entityRegistry?.records() ?? [];
      const v4Entities = entities.map((entity) => {
        const linked = this.#linkedProducers.find(
          ({ association }) =>
            association.kind === 'constant' && association.entity.id === entity.id,
        );
        if (linked === undefined || linked.association.kind !== 'constant') return entity;
        return Object.freeze({
          ...entity,
          configuration: {
            mode: 'constant' as const,
            value: linked.association.configuration,
          } satisfies EntityV4ConstantConfiguration,
        });
      });
      const v5Entities = entities.map((entity) => {
        const linked = this.#linkedProducers.find(
          ({ association }) => association.entity.id === entity.id,
        );
        return linked === undefined
          ? entity
          : linked.association.kind === 'constant'
            ? Object.freeze({
                ...entity,
                configuration: {
                  mode: 'constant' as const,
                  value: linked.association.configuration,
                } satisfies EntityV4ConstantConfiguration,
              })
            : Object.freeze({
                ...entity,
                configuration: linked.association.configuration,
              });
      });
      const v6Entities = entities.map((entity) => {
        const linked = this.#linkedProducers.find(
          ({ association }) => association.entity.id === entity.id,
        );
        if (linked === undefined) return entity;
        return linked.association.kind === 'constant'
          ? Object.freeze({
              ...entity,
              configuration: {
                mode: 'constant' as const,
                value: linked.association.configuration,
              } satisfies EntityV4ConstantConfiguration,
            })
          : linked.association.kind === 'arithmetic'
            ? Object.freeze({ ...entity, configuration: linked.association.configuration })
            : Object.freeze({ ...entity, configuration: linked.association.configuration });
      });
      const entityCommon = () => ({
        ...common,
        debugInstances: Object.freeze([
          ...this.#debugInstances,
        ]) as readonly EntityPlanDebugInstance[],
        context: entityReplayContextRef(this.#entityContext!),
        networks: Object.freeze(
          this.#networks.map((network) => {
            const state = this.#networkStates.get(network.name);
            return Object.freeze({
              ...network,
              generation: state?.ownership.generation ?? 0,
              ...(state?.ownership.consumedAt === undefined
                ? {}
                : { consumedAt: state.ownership.consumedAt }),
            });
          }),
        ),
      });
      const plan:
        | DirectElaborationPlan
        | DirectElaborationPlanV3
        | DirectElaborationPlanV4
        | DirectElaborationPlanV5
        | DirectElaborationPlanV6 = hasLinkedDecider
        ? ({
            ...entityCommon(),
            version: 6 as const,
            producers: common.producers as readonly DirectPlanProducerV6[],
            entities: Object.freeze(v6Entities) as readonly EntityPlanRecordV6[],
          } satisfies DirectElaborationPlanV6)
        : hasLinkedArithmetic
          ? {
              ...entityCommon(),
              version: 5 as const,
              entities: Object.freeze(v5Entities) as readonly EntityPlanRecordV5[],
            }
          : this.#linkedProducers.some(({ association }) => association.kind === 'constant')
            ? { ...entityCommon(), version: 4 as const, entities: Object.freeze(v4Entities) }
            : entities.length === 0
              ? {
                  ...common,
                  version: 2 as const,
                  debugInstances: Object.freeze([
                    ...this.#debugInstances,
                  ]) as readonly DirectPlanDebugInstance[],
                }
              : { ...entityCommon(), version: 3 as const, entities: Object.freeze([...entities]) };
      this.#status = 'sealed';
      return plan;
    } catch (error) {
      this.#poison(error);
      throw this.#firstFailure;
    }
  }

  executionApi(): typeof this.api {
    const wrapped = Object.entries(this.api).map(([name, operation]) => [
      name,
      (...args: unknown[]) => {
        const frame: ExecutionApiFrame = { dslDomain: false };
        this.#executionApiFrames.push(frame);
        const rawSpan =
          (name === 'network' || name === 'bind') && typeof args.at(-1) === 'function'
            ? args.at(-2)
            : args.at(-1);
        try {
          if (this.#status === 'sealed') {
            if (isRawSpan(rawSpan)) {
              throw new ElaborationExecutionError(
                'The elaboration runtime is sealed; delayed asynchronous DSL calls cannot mutate a completed plan.',
                this.#span(rawSpan),
                'RT2025',
              );
            }
            throw new Error(
              'The elaboration runtime is sealed; delayed asynchronous DSL calls cannot mutate a completed plan.',
            );
          }
          const result = (operation as (...values: unknown[]) => unknown)(...args);
          return result;
        } catch (error) {
          const recoverable = error instanceof RecoverableElaborationExecutionError;
          const domainFailure =
            !recoverable &&
            (frame.dslDomain ||
              error instanceof ElaborationOperationLimitError ||
              error instanceof ElaborationExecutionError);
          let normalized: unknown = error;
          if (
            !(error instanceof ElaborationExecutionError) &&
            !(error instanceof ElaborationOperationLimitError) &&
            error instanceof Error &&
            isRawSpan(rawSpan)
          ) {
            normalized = new ElaborationExecutionError(
              error.message,
              this.#span(rawSpan),
              'EX1001',
              undefined,
              { cause: error },
            );
          }
          if (domainFailure && this.#status !== 'sealed') this.#poison(normalized);
          throw normalized;
        } finally {
          const popped = this.#executionApiFrames.pop();
          if (popped !== frame) {
            throw new Error('Elaboration execution API frame stack is unbalanced.');
          }
        }
      },
    ]);
    return Object.freeze(Object.fromEntries(wrapped)) as typeof this.api;
  }

  closeAfterExecution(): void {
    if (this.#status === 'active') this.#status = 'sealed';
  }

  #poison(error: unknown): void {
    if (this.#status === 'failed') return;
    this.#status = 'failed';
    this.#firstFailure = error;
  }

  #span(raw: RawSpan): SourceSpan {
    return { fileId: this.#fileId, start: raw.start, end: raw.end };
  }

  #sourceSpan(source: RawSpan | SourceSpan): SourceSpan {
    return isRawSpan(source) ? this.#span(source) : source;
  }

  #rawSpan(source: RawSpan | SourceSpan): RawSpan {
    return { start: source.start, end: source.end };
  }

  #invoke(
    callable: unknown,
    receiver: unknown,
    args: readonly CallArgument[],
    rawSpan: RawSpan,
  ): unknown {
    if (typeof callable === 'function') {
      const deciderAlias = this.#deciderMemberAliases.get(callable);
      if (deciderAlias !== undefined) {
        return this.#appendDeciderArguments(
          deciderAlias.receiver,
          deciderAlias.branch,
          args,
          rawSpan,
        );
      }
    }
    if (this.#isEntity(callable)) return this.#invokeEntity(callable, args, rawSpan);
    if (typeof callable !== 'function') throw new TypeError('Called value is not a function.');
    const invocation: Invocation = {
      callable,
      arguments: args,
      source: rawSpan,
      defaultNetworks: new Set(),
      entered: false,
    };
    this.#invocations.push(invocation);
    try {
      return Reflect.apply(
        callable,
        receiver,
        args.map(({ value }) => value),
      );
    } finally {
      this.#invocations.pop();
    }
  }

  #member(receiver: unknown, key: PropertyKey, rawSpan: RawSpan): unknown {
    if (this.#isCombinator(receiver) && (key === 'then' || key === 'else')) {
      const callable = (() => undefined) as Function;
      this.#deciderMemberAliases.set(callable, { receiver, branch: key });
      return callable;
    }
    return this.api.element(receiver, key, rawSpan);
  }

  #invokeEntity(entity: EntityValue, args: readonly CallArgument[], rawSpan: RawSpan): EntityValue {
    const source = this.#span(rawSpan);
    const profile = this.#entityProfile(entity, source);
    if (profile.callProjection === undefined) {
      throw new ElaborationExecutionError(
        `Entity profile ${JSON.stringify(profile.ref.prototypeKey)} has no callable projection.`,
        source,
        'RT2027',
      );
    }
    if (args.length !== 1) {
      throw new ElaborationExecutionError(
        'Callable Entity invocation requires exactly one argument.',
        source,
        'RT2027',
      );
    }
    const argument = args[0]!;
    const readable = this.#readableNetworkFacet(argument.value, argument.source);
    if (readable === undefined) {
      throw new ElaborationExecutionError(
        'Callable Entity input requires a readable Network or Producer output.',
        this.#span(argument.source),
        'RT2015',
      );
    }
    return this.#bindEntity(
      entity,
      profile.callProjection.input.connector,
      profile.callProjection.input.lane,
      readable,
      'input',
      rawSpan,
    );
  }

  #entityProfile(entity: EntityValue, source: SourceSpan): EntityProfile {
    this.#entityAuthority(entity, source);
    const context = this.#entityContext;
    const registry = this.#entityRegistry;
    if (context === undefined || registry === undefined) {
      throw new ElaborationExecutionError(
        'Entity operation requires a trusted v3 context and prototype resolver.',
        source,
        'RT2027',
      );
    }
    let profile: EntityProfile;
    try {
      profile = resolveEntityReplayProfile(registry.record(entity).profile, context);
    } catch (error) {
      throw new ElaborationExecutionError(
        error instanceof Error ? error.message : 'Entity profile is unavailable.',
        source,
        'RT2027',
        undefined,
        { cause: error },
      );
    }
    return profile;
  }

  #bindEntityOutput(destination: unknown, entity: EntityValue, rawSpan: RawSpan): EntityValue {
    const source = this.#span(rawSpan);
    const profile = this.#entityProfile(entity, source);
    if (profile.callProjection === undefined) {
      throw new ElaborationExecutionError(
        `Entity profile ${JSON.stringify(profile.ref.prototypeKey)} has no callable projection.`,
        source,
        'RT2027',
      );
    }
    const network = this.#resolveWritableNetwork(destination, rawSpan, 'Entity output destination');
    if (network === undefined) {
      throw new ElaborationExecutionError(
        'Callable Entity output requires a writable Network destination.',
        source,
        'RT2015',
      );
    }
    return this.#bindEntity(
      entity,
      profile.callProjection.output.connector,
      profile.callProjection.output.lane,
      network,
      'output',
      rawSpan,
    );
  }

  #debugValue(
    value: unknown,
    rawSpan: RawSpan,
    seen: Set<object>,
  ): DirectPlanDebugValue | EntityPlanDebugValue {
    if (this.#isNetwork(value)) {
      this.#assertReadableNetwork(value, rawSpan);
      return { kind: 'network', network: value.name };
    }
    if (this.#isCombinator(value)) {
      const { captureId } = this.#combinators.capture(value);
      return { kind: 'producer', captureId };
    }
    if (this.#isEntity(value)) return { kind: 'entity', entityId: value.id };
    if (value === undefined) return { kind: 'undefined' };
    if (
      value === null ||
      typeof value === 'string' ||
      typeof value === 'number' ||
      typeof value === 'boolean'
    ) {
      return { kind: 'literal', value };
    }
    if (typeof value !== 'object') {
      throw new ElaborationExecutionError(
        't.instantiate(...) cannot retain this function return value for the test runtime.',
        this.#span(rawSpan),
        'RT2026',
      );
    }
    if (seen.has(value)) {
      throw new ElaborationExecutionError(
        't.instantiate(...) cannot retain a cyclic function return value.',
        this.#span(rawSpan),
        'RT2026',
      );
    }
    seen.add(value);
    try {
      if (Array.isArray(value)) {
        return {
          kind: 'array',
          values: value.map((item) => this.#debugValue(item, rawSpan, seen)),
        };
      }
      const prototype = Object.getPrototypeOf(value);
      if (prototype === Object.prototype || prototype === null) {
        return {
          kind: 'object',
          entries: Object.entries(value).map(([key, item]) => ({
            key,
            value: this.#debugValue(item, rawSpan, seen),
          })),
        };
      }
    } finally {
      seen.delete(value);
    }
    throw new ElaborationExecutionError(
      't.instantiate(...) can retain only Networks, Producers, literals, arrays, and plain objects.',
      this.#span(rawSpan),
      'RT2026',
    );
  }

  #finalizeUnusedCombinators(): void {
    for (const state of this.#combinators.states()) {
      if (state.descriptor.kind === 'decider' && state.descriptor.output === undefined) {
        throw new ElaborationExecutionError(
          'when(condition) must configure at least one .then(...) or .else(...) output.',
          state.descriptor.source,
          'RT2022',
        );
      }
      if (state.outputUsed) continue;
      this.#diagnostics.push({
        code: 'CL2001',
        severity: 'warning',
        message: 'This combinator output is never read or connected.',
        span: state.descriptor.source,
      });
    }
  }

  #validateFinalDeciderModes(): void {
    for (const state of this.#combinators.states()) {
      if (state.descriptor.kind !== 'decider') continue;
      const descriptor = state.descriptor;
      const usesEach = conditionUsesEach(descriptor.condition);
      const branches = [
        {
          outputs:
            descriptor.outputs ??
            (descriptor.output === undefined || descriptor.elseOutputs !== undefined
              ? []
              : [descriptor.output]),
          origins: descriptor.outputOrigins,
        },
        { outputs: descriptor.elseOutputs ?? [], origins: descriptor.elseOutputOrigins },
      ] as const;
      for (const { outputs, origins } of branches) {
        for (const [index, output] of outputs.entries()) {
          const eachOutput = output.kind === 'each';
          const everythingOutput = output.kind === 'wildcard' && output.wildcard === 'everything';
          const origin = origins?.[index];
          const diagnosticSource = origin?.source ?? descriptor.source;
          const related = [
            { message: 'Physical combinator was created here.', span: descriptor.source },
          ].filter(
            (entry, entryIndex, entries) =>
              entries.findIndex(
                (candidate) =>
                  candidate.span.fileId === entry.span.fileId &&
                  candidate.span.start === entry.span.start &&
                  candidate.span.end === entry.span.end,
              ) === entryIndex &&
              !(
                entry.span.fileId === diagnosticSource.fileId &&
                entry.span.start === diagnosticSource.start &&
                entry.span.end === diagnosticSource.end
              ),
          );
          if (eachOutput && !usesEach) {
            throw new ElaborationExecutionError(
              'A Decider Each output requires a final condition set that uses Each.',
              diagnosticSource,
              'RT2027',
              related,
            );
          }
          if (everythingOutput && usesEach) {
            throw new ElaborationExecutionError(
              'A Decider Everything output is invalid when the final condition set uses Each.',
              diagnosticSource,
              'RT2027',
              related,
            );
          }
        }
      }
    }
  }

  #network(name: string, rawSpan: RawSpan, fixedColor?: 'red' | 'green'): NetworkValue {
    this.#recordDslCall();
    const occurrence = (this.#networkNameCounts.get(name) ?? 0) + 1;
    this.#networkNameCounts.set(name, occurrence);
    const instanceName = occurrence === 1 ? name : `$instance:${occurrence}:${name}`;
    const declaration = this.#span(rawSpan);
    this.#networks.push({
      name: instanceName,
      ...(fixedColor === undefined ? {} : { fixedColor }),
      source: declaration,
      instancePath: this.#path(),
    });
    const ownership: NetworkOwnershipState = {
      generation: 0,
      owner: this.#currentFunctionFrame()?.owner ?? 'top-level',
      readonlyBorrows: new Set(),
      ...(fixedColor === undefined
        ? {}
        : { colorRequirement: { color: fixedColor, source: declaration } }),
    };
    const invocation = this.#invocations.at(-1);
    if (invocation !== undefined && !invocation.entered) {
      invocation.defaultNetworks.add(ownership);
    }
    this.#colors.registerNetwork(ownership, instanceName, declaration, fixedColor);
    return this.#networkValue(
      {
        kind: 'network',
        name: instanceName,
        declaration,
        capability: 'owned',
        generation: 0,
      },
      { ownership },
    );
  }

  #captureNetworkAlias(name: string, read: () => unknown, rawSpan: RawSpan): void {
    const instancePath = this.#path();
    const key = JSON.stringify([instancePath, name, rawSpan.start]);
    this.#networkAliases.set(key, {
      name,
      read,
      source: this.#span(rawSpan),
      instancePath,
    });
  }

  #captureNetworkAliasValue(name: string, network: NetworkValue, rawSpan: RawSpan): void {
    this.#captureNetworkAlias(name, () => network, rawSpan);
  }

  #acceptUnrestrictedNetwork(
    network: NetworkValue,
    declarationSpan: RawSpan,
    parameter: string,
  ): void {
    const frame = this.#currentFunctionFrame();
    if (frame === undefined) {
      throw new Error('An unrestricted Network reference was created outside a function frame.');
    }
    const ownership = this.#networkState(network).ownership;
    if (ownership.owner !== frame.owner) {
      const references = this.#transparentNetworkParameters.get(frame) ?? new Set();
      references.add(ownership);
      this.#transparentNetworkParameters.set(frame, references);
    }
    this.#recordUnrestrictedReferenceWarning(declarationSpan, parameter);
  }

  #isTransparentNetwork(network: NetworkValue, frame = this.#currentFunctionFrame()): boolean {
    const ownership = this.#networkState(network).ownership;
    return (
      frame !== undefined &&
      ownership.owner !== frame.owner &&
      this.#transparentNetworkParameters.get(frame)?.has(ownership) === true
    );
  }

  #recordUnrestrictedReferenceWarning(declarationSpan: RawSpan, parameter: string): void {
    const key = `${declarationSpan.start}:${declarationSpan.end}`;
    if (this.#implicitBorrowWarnings.has(key)) return;
    this.#implicitBorrowWarnings.add(key);
    this.#diagnostics.push({
      code: 'CL2002',
      severity: 'warning',
      message: `Parameter ${parameter} uses an unrestricted Network reference. Use Readonly<Network> for read-only access, Ref<Network> for mutable borrowing, or Move<Network> for ownership transfer.`,
      span: this.#span(declarationSpan),
    });
  }

  #projectCombinatorOutput(
    value: CombinatorValue,
    index: number,
    descriptor: BindingDescriptor,
    rawSpan: RawSpan,
  ): NetworkValue | undefined {
    if (
      typeof descriptor !== 'object' ||
      descriptor === null ||
      typeof descriptor.name !== 'string' ||
      (descriptor.color !== undefined && descriptor.color !== 'red' && descriptor.color !== 'green')
    ) {
      throw new Error('Combinator output projection requires flat Network bindings.');
    }
    if (index > 1) return undefined;
    const network =
      index === 0 ? this.#combinators.primary(value) : this.#ensureSecondaryOutput(value, rawSpan);
    if (descriptor.color !== undefined) {
      this.#requireNetworkColor(network, 'readonly', descriptor.color, rawSpan);
    }
    this.#captureNetworkAliasValue(descriptor.name, network, rawSpan);
    return network;
  }

  #createCombinator(descriptor: CombinatorDescriptor, rawSpan: RawSpan): CombinatorValue {
    // A provider-backed arithmetic producer is the ergonomic spelling of the
    // exact Arithmetic constructor. Resolve its trusted base before creating
    // any topology so malformed or ambiguous authority cannot fall through to
    // a modded profile.
    const arithmeticProfile =
      descriptor.kind === 'arithmetic'
        ? this.#resolveCanonicalArithmeticProfile(rawSpan)
        : undefined;
    const deciderProfile =
      descriptor.kind === 'decider' &&
      ((descriptor.outputs?.length ?? 0) > 0 || (descriptor.elseOutputs?.length ?? 0) > 0)
        ? this.#resolveCanonicalDeciderProfile(rawSpan)
        : undefined;
    const ordinal = ++this.#combinatorOrdinal;
    const primary = this.#network(`$combinator:${ordinal}:primary`, rawSpan);
    const value = this.#runtimeValue<CombinatorValue>({ kind: 'combinator', identity: {} });
    this.#combinators.register(value, descriptor, primary, {
      network: primary.name,
      source: this.#span(rawSpan),
      instancePath: this.#path(),
    });
    this.#combinatorByOutput.set(this.#networkState(primary).ownership, value);
    this.#colors.registerCombinatorInputs(value.identity, descriptor);
    if (arithmeticProfile !== undefined && descriptor.kind === 'arithmetic') {
      const entity = this.#allocateEntity(arithmeticProfile.ref, undefined, undefined, rawSpan);
      const association = {
        kind: 'arithmetic' as const,
        entity,
        configuration: {
          mode: 'arithmetic' as const,
          left: this.#canonicalArithmeticOperand(descriptor.left),
          operation: descriptor.operation,
          right: this.#canonicalArithmeticOperand(descriptor.right),
          output:
            descriptor.output.kind === 'signal'
              ? { kind: 'signal' as const, signal: this.#signalSnapshot(descriptor.output.signal) }
              : descriptor.output,
        },
      } satisfies LinkedArithmeticAssociation;
      this.#linkedProducerByIdentity.set(value.identity, association);
      this.#linkedProducers.push({ producer: value, association });
    }
    if (
      descriptor.kind === 'decider' &&
      ((descriptor.outputs?.length ?? 0) > 0 || (descriptor.elseOutputs?.length ?? 0) > 0)
    ) {
      this.#linkDeciderCombinator(value, descriptor, rawSpan, deciderProfile);
    }
    return value;
  }

  #linkDeciderCombinator(
    producer: CombinatorValue,
    descriptor: Extract<CombinatorDescriptor, { kind: 'decider' }>,
    rawSpan: RawSpan,
    resolvedProfile?: EntityProfile,
  ): void {
    const profile = resolvedProfile ?? this.#resolveCanonicalDeciderProfile(rawSpan);
    if (profile === undefined) return;
    const outputs =
      descriptor.outputs ?? (descriptor.output === undefined ? [] : [descriptor.output]);
    if (outputs.length === 0 && (descriptor.elseOutputs?.length ?? 0) === 0) return;
    const configuration: EntityV6DeciderConfiguration = {
      mode: 'decider',
      condition: descriptor.condition,
      outputs,
      ...(descriptor.elseOutputs === undefined ? {} : { elseOutputs: descriptor.elseOutputs }),
    };
    const existing = this.#linkedProducerByIdentity.get(producer.identity);
    if (existing?.kind === 'decider') {
      const association = { ...existing, configuration } satisfies LinkedDeciderAssociation;
      const entry = this.#linkedProducers.findIndex(
        ({ producer: candidate }) => candidate.identity === producer.identity,
      );
      if (entry >= 0) this.#linkedProducers[entry] = { producer, association };
      this.#linkedProducerByIdentity.set(producer.identity, association);
      return;
    }
    if (existing !== undefined) return;
    const entity = this.#allocateEntity(profile.ref, undefined, descriptor.placement, rawSpan);
    if (descriptor.placement !== undefined) {
      const { placement: _placement, ...withoutPlacement } = descriptor;
      this.#combinators.update(producer, withoutPlacement);
    }
    const association = {
      kind: 'decider' as const,
      entity,
      configuration,
    } satisfies LinkedDeciderAssociation;
    this.#linkedProducerByIdentity.set(producer.identity, association);
    this.#linkedProducers.push({ producer, association });
  }

  #ensureSecondaryOutput(value: CombinatorValue, rawSpan: RawSpan): NetworkValue {
    const existing = this.#combinators.secondary(value);
    if (existing !== undefined) return existing;
    const primary = this.#combinators.primary(value);
    const name = primary.name.endsWith(':primary')
      ? `${primary.name.slice(0, -':primary'.length)}:secondary`
      : `$combinator:${++this.#combinatorOrdinal}:secondary`;
    const secondary = this.#network(name, rawSpan);
    const source = this.#span(rawSpan);
    this.#colors.different(
      this.#networkState(primary).ownership,
      this.#networkState(secondary).ownership,
      source,
      'Combinator output connector uses both wire colors',
    );
    this.#combinators.addSecondary(value, secondary, {
      network: secondary.name,
      source,
      instancePath: this.#path(),
    });
    this.#combinatorByOutput.set(this.#networkState(secondary).ownership, value);
    return secondary;
  }

  #takeOutputLanes(
    value: CombinatorValue,
    count: number,
    rawSpan: RawSpan,
  ): readonly NetworkValue[] {
    if (value.networkFacet !== undefined) {
      this.#assertConsumableNetwork(value.networkFacet, rawSpan, 'combinator output');
    }
    return selectCombinatorMoveLanes(value, count, this.#span(rawSpan), {
      lanes: (candidate) => {
        const state = this.#combinators.stateFor(candidate);
        return [state.outputPort.primary.network, state.outputPort.secondary?.network].filter(
          (network): network is NetworkValue => network !== undefined,
        );
      },
      ensureSecondary: (candidate) => this.#ensureSecondaryOutput(candidate, rawSpan),
      assertConsumable: (network, source) =>
        this.#ownership.assertConsumable(network, source, 'combinator output'),
      exhausted: (candidate, source) => {
        const state = this.#combinators.stateFor(candidate);
        throw new ElaborationExecutionError(
          'This combinator output connector already uses both logical Networks.',
          source,
          'RT2028',
          [{ message: 'Physical combinator was created here.', span: state.descriptor.source }],
        );
      },
    });
  }

  #selectCombinatorMove(value: CombinatorValue, source: SourceSpan): NetworkValue {
    return this.#withTopologyTransaction({ start: source.start, end: source.end }, () =>
      selectCombinatorMoveNetwork(value, source, {
        lanes: (candidate) => {
          const state = this.#combinators.stateFor(candidate);
          return [state.outputPort.primary.network, state.outputPort.secondary?.network].filter(
            (network): network is NetworkValue => network !== undefined,
          );
        },
        ensureSecondary: (candidate) =>
          this.#ensureSecondaryOutput(candidate, { start: source.start, end: source.end }),
        assertConsumable: (network, candidateSource) =>
          this.#ownership.assertConsumable(network, candidateSource, 'combinator output'),
        exhausted: (candidate, candidateSource) => {
          const state = this.#combinators.stateFor(candidate);
          throw new ElaborationExecutionError(
            'This combinator output connector already uses both logical Networks.',
            candidateSource,
            'RT2028',
            [{ message: 'Physical combinator was created here.', span: state.descriptor.source }],
          );
        },
      }),
    );
  }

  #transferNetwork(
    destination: NetworkValue,
    sourceNetwork: NetworkValue,
    rawSpan: RawSpan,
    sourceRole = 'source',
    conflictKind: 'transfer' | 'connector' = 'transfer',
  ): void {
    this.#assertConsumableNetwork(sourceNetwork, rawSpan, sourceRole);
    const destinationState = this.#networkState(destination);
    const sourceState = this.#networkState(sourceNetwork);
    if (destinationState.ownership === sourceState.ownership) {
      throw new ElaborationExecutionError(
        'A Network cannot take itself.',
        this.#span(rawSpan),
        'RT2013',
        [{ message: 'Network declared here.', span: destination.declaration }],
      );
    }
    const provenance = this.#span(rawSpan);
    const destinationColor = destinationState.ownership.colorRequirement?.color;
    const sourceColor = sourceState.ownership.colorRequirement?.color;
    const fixedColorConflict =
      destinationColor !== undefined &&
      sourceColor !== undefined &&
      destinationColor !== sourceColor;
    this.#colors.same(
      destinationState.ownership,
      sourceState.ownership,
      provenance,
      '.take(source) unifies both physical Networks',
      conflictKind === 'connector' ? 'RT2010' : fixedColorConflict ? 'RT2014' : 'RT2020',
      conflictKind === 'connector'
        ? 'Combinator connector cannot satisfy the required circuit-wire colors.'
        : fixedColorConflict
          ? 'Network transfer unifies contradictory red/green color requirements.'
          : 'Network transfer collapses Networks required to use opposite wire colors.',
    );
    this.#networkTransfers.push({
      destination: destination.name,
      source: sourceNetwork.name,
      provenance,
      instancePath: this.#path(),
    });
    this.#markOutputUsed(destination);
    this.#markOutputUsed(sourceNetwork);
    this.#ownership.consume(sourceNetwork, provenance);
  }

  #preflightNetworkTransfers(
    destinations: readonly NetworkValue[],
    sources: readonly NetworkValue[],
    rawSpan: RawSpan,
    sourceRole: string,
    conflictKind: 'transfer' | 'connector',
  ): void {
    if (destinations.length !== 1 && destinations.length !== sources.length) {
      throw new Error('Network transfer preflight requires matching destinations and sources.');
    }
    const colors = this.#colors.clone();
    const provenance = this.#span(rawSpan);
    let broadcastColor =
      destinations.length === 1
        ? this.#networkState(destinations[0]!).ownership.colorRequirement?.color
        : undefined;
    for (const [index, sourceNetwork] of sources.entries()) {
      const destination = destinations.length === 1 ? destinations[0]! : destinations[index]!;
      this.#assertConsumableNetwork(sourceNetwork, rawSpan, sourceRole);
      const destinationState = this.#networkState(destination);
      const sourceState = this.#networkState(sourceNetwork);
      if (destinationState.ownership === sourceState.ownership) {
        throw new ElaborationExecutionError('A Network cannot take itself.', provenance, 'RT2013', [
          { message: 'Network declared here.', span: destination.declaration },
        ]);
      }
      const destinationColor = destinationState.ownership.colorRequirement?.color;
      const sourceColor = sourceState.ownership.colorRequirement?.color;
      const fixedColorConflict =
        destinationColor !== undefined &&
        sourceColor !== undefined &&
        destinationColor !== sourceColor;
      if (conflictKind !== 'connector' && destinations.length === 1) {
        if (
          broadcastColor !== undefined &&
          sourceColor !== undefined &&
          broadcastColor !== sourceColor
        ) {
          throw new ElaborationExecutionError(
            'Network transfer unifies contradictory red/green color requirements.',
            provenance,
            'RT2014',
          );
        }
        broadcastColor ??= sourceColor;
      }
      colors.same(
        destinationState.ownership,
        sourceState.ownership,
        provenance,
        '.take(source) unifies both physical Networks',
        conflictKind === 'connector' ? 'RT2010' : fixedColorConflict ? 'RT2014' : 'RT2020',
        conflictKind === 'connector'
          ? 'Combinator connector cannot satisfy the required circuit-wire colors.'
          : fixedColorConflict
            ? 'Network transfer unifies contradictory red/green color requirements.'
            : 'Network transfer collapses Networks required to use opposite wire colors.',
      );
    }
  }

  #attach(network: NetworkValue, value: CombinatorValue, rawSpan: RawSpan): void {
    this.#attachMany([network], value, rawSpan);
  }

  #attachToCombinator(
    producer: CombinatorValue,
    values: unknown[],
    rawSpan: RawSpan,
  ): CombinatorValue {
    const source = this.#span(rawSpan);
    let outputSignal = this.#isSignal(values.at(-1)) ? (values.pop() as SignalHandle) : undefined;
    let destinations: readonly NetworkValue[];
    if (values.length === 1 && this.#isSelected(values[0])) {
      const selected = values[0];
      if (this.#isPairSelection(selected)) {
        throw new ElaborationExecutionError(
          'pair(a, b) is a read-only input view and cannot be a .to(...) destination.',
          source,
          'RT2020',
        );
      }
      const selectedValue = this.#selectedSelection(selected);
      if (outputSignal !== undefined || !isSignalId(selectedValue)) {
        throw new ElaborationExecutionError(
          'A selected .to(...) destination must bind exactly one concrete Signal.',
          source,
          'RT2003',
        );
      }
      outputSignal = selectedValue;
      const destination = this.#resolveWritableNetwork(selected, rawSpan, 'destination');
      if (destination === undefined) {
        throw new ElaborationExecutionError(
          '.to(...) destination must be a Network.',
          source,
          'RT2015',
        );
      }
      destinations = [destination];
    } else {
      if (values.some((value) => this.#isPair(value))) {
        throw new ElaborationExecutionError(
          'pair(a, b) is a read-only input view and cannot be a .to(...) destination.',
          source,
          'RT2020',
        );
      }
      if (values.some((value) => this.#isSelected(value))) {
        throw new ElaborationExecutionError(
          '.to(...) permits Network[SIGNAL] only for one destination; use .to(first, second, SIGNAL) for fan-out.',
          source,
          'RT2003',
        );
      }
      const resolved = values.map((value) =>
        this.#resolveWritableNetwork(value, rawSpan, 'destination'),
      );
      if (!resolved.every((value): value is NetworkValue => value !== undefined)) {
        throw new ElaborationExecutionError(
          '.to(...) permits Network[SIGNAL] only for one destination; use .to(first, second, SIGNAL) for fan-out.',
          source,
          'RT2015',
        );
      }
      destinations = resolved;
    }
    return this.#attachMany(destinations, producer, rawSpan, outputSignal);
  }

  #attachDestination(
    destination: NetworkValue | CombinatorValue | PairValue | SelectedValue | DestinationValue,
    producer: CombinatorValue,
    rawSpan: RawSpan,
  ): void {
    const source = this.#span(rawSpan);
    if (this.#isPair(destination) || this.#isPairSelection(destination)) {
      throw new ElaborationExecutionError(
        'pair(a, b) is a read-only input view and cannot receive a producer attachment.',
        source,
        'RT2020',
      );
    }
    const destinations = this.#isDestination(destination)
      ? destination.networks
      : [this.#resolveWritableNetwork(destination, rawSpan, 'destination')];
    if (!destinations.every((value): value is NetworkValue => value !== undefined)) {
      throw new ElaborationExecutionError(
        'A combinator producer can only be attached to a Network destination.',
        source,
        'RT2015',
      );
    }
    const outputSignal = this.#isDestination(destination)
      ? destination.signal
      : this.#isSelected(destination)
        ? (() => {
            const selection = this.#selectedSelection(destination);
            if (isSignalId(selection)) return selection;
            throw new ElaborationExecutionError(
              'A destination can bind only a concrete Signal.',
              source,
              'RT2003',
            );
          })()
        : undefined;
    this.#attachMany(destinations, producer, rawSpan, outputSignal);
  }

  #attachMany(
    networks: readonly NetworkValue[],
    value: CombinatorValue,
    rawSpan: RawSpan,
    outputSignal?: SignalId,
  ): CombinatorValue {
    return this.#withTopologyTransaction(rawSpan, () => {
      if (!networks.every((network) => this.#isNetwork(network)) || !this.#isCombinator(value)) {
        throw new Error('Attachment requires a Network and combinator.');
      }
      const source = this.#span(rawSpan);
      validateCombinatorAttachment(networks, source, {
        assertWritable: (network) => this.#assertWritableNetwork(network, rawSpan, 'destination'),
      });
      if (outputSignal !== undefined) {
        this.#combinators.validateOutput(value, outputSignal, source);
      }
      const lanes = this.#takeOutputLanes(value, networks.length, rawSpan);
      this.#preflightNetworkTransfers(networks, lanes, rawSpan, 'combinator output', 'connector');
      for (const [index, network] of networks.entries()) {
        this.#transferNetwork(network, lanes[index]!, rawSpan, 'combinator output', 'connector');
      }
      if (outputSignal !== undefined) this.#combinators.bindOutput(value, outputSignal, source);
      this.#combinators.markOutputUsed(value);
      return value;
    });
  }

  #joinNetworks(values: readonly unknown[], rawSpan: RawSpan): NetworkValue {
    const source = this.#span(rawSpan);
    if (values.length === 0) {
      throw new ElaborationExecutionError(
        'join(...) requires at least one input.',
        source,
        'RT2003',
      );
    }
    const combinatorCounts = new Map<CombinatorValue, number>();
    const networkNames = new Set<string>();
    for (const value of values) {
      if (this.#isNetwork(value)) {
        if (networkNames.has(value.name)) {
          throw new ElaborationExecutionError(
            'join(...) repeats the same exact Network input.',
            source,
            'RT2004',
            [{ message: 'Network was first supplied here.', span: value.declaration }],
          );
        }
        networkNames.add(value.name);
        this.#assertConsumableNetwork(value, rawSpan, 'join input');
        continue;
      }
      if (this.#isCombinator(value)) {
        combinatorCounts.set(value, (combinatorCounts.get(value) ?? 0) + 1);
        continue;
      }
      if (this.#isPair(value) || this.#isPairSelection(value) || this.#isSelected(value)) {
        throw new ElaborationExecutionError(
          'join(...) accepts owned Networks and physical Combinators, not pair or selection views.',
          source,
          'RT2020',
        );
      }
      throw new ElaborationExecutionError(
        'join(...) accepts owned Networks and physical Combinators only.',
        source,
        'RT2015',
      );
    }

    const selected = new Map<CombinatorValue, readonly NetworkValue[]>();
    for (const [combinator, count] of combinatorCounts) {
      selected.set(combinator, this.#takeOutputLanes(combinator, count, rawSpan));
    }
    const cursors = new Map<CombinatorValue, number>();
    const inputs = values.map((value) => {
      if (this.#isNetwork(value)) return value;
      const lanes = selected.get(value as CombinatorValue)!;
      const index = cursors.get(value as CombinatorValue) ?? 0;
      cursors.set(value as CombinatorValue, index + 1);
      return lanes[index]!;
    });
    const result = this.#network('$join', rawSpan);
    this.#preflightNetworkTransfers([result], inputs, rawSpan, 'join input', 'transfer');
    for (const input of inputs) {
      this.#transferNetwork(result, input, rawSpan, 'join input');
    }
    return result;
  }

  #topologySnapshot(): TopologySnapshot {
    const ownership = new Map<NetworkOwnershipState, NetworkOwnershipSnapshot>();
    for (const state of this.#networkStates.values()) {
      const current = state.ownership;
      if (ownership.has(current)) continue;
      ownership.set(current, {
        state: current,
        generation: current.generation,
        owner: current.owner,
        ...(current.consumedAt === undefined ? {} : { consumedAt: current.consumedAt }),
        ...(current.lastMove === undefined ? {} : { lastMove: current.lastMove }),
        ...(current.colorRequirement === undefined
          ? {}
          : { colorRequirement: current.colorRequirement }),
        readonlyBorrows: [...current.readonlyBorrows],
        ...(current.mutableBorrow === undefined ? {} : { mutableBorrow: current.mutableBorrow }),
      });
    }
    return {
      networksLength: this.#networks.length,
      networkStates: new Map(this.#networkStates),
      networkNameCounts: new Map(this.#networkNameCounts),
      networkTransfersLength: this.#networkTransfers.length,
      combinatorOrdinal: this.#combinatorOrdinal,
      combinatorByOutput: new Map(this.#combinatorByOutput),
      combinators: this.#combinators.snapshot(),
      ownership: [...ownership.values()],
      colors: this.#colors.clone(),
      ...(this.#entityRegistry === undefined
        ? {}
        : { entityRegistry: this.#entityRegistry.snapshot() }),
      entityRevision: this.#entityRevision,
      entityAuthoritiesLength: this.#entityAuthorityList.length,
      linkedProducersLength: this.#linkedProducers.length,
    };
  }

  #restoreTopology(snapshot: TopologySnapshot): void {
    this.#networks.length = snapshot.networksLength;
    this.#networkTransfers.length = snapshot.networkTransfersLength;
    this.#networkStates.clear();
    for (const [name, state] of snapshot.networkStates) this.#networkStates.set(name, state);
    this.#networkNameCounts.clear();
    for (const [name, count] of snapshot.networkNameCounts)
      this.#networkNameCounts.set(name, count);
    this.#combinatorOrdinal = snapshot.combinatorOrdinal;
    this.#combinatorByOutput.clear();
    for (const [ownership, combinator] of snapshot.combinatorByOutput) {
      this.#combinatorByOutput.set(ownership, combinator);
    }
    this.#combinators.restore(snapshot.combinators);
    for (const saved of snapshot.ownership) {
      const state = saved.state;
      state.generation = saved.generation;
      state.owner = saved.owner;
      if (saved.consumedAt === undefined) delete state.consumedAt;
      else state.consumedAt = saved.consumedAt;
      if (saved.lastMove === undefined) delete state.lastMove;
      else state.lastMove = saved.lastMove;
      if (saved.colorRequirement === undefined) delete state.colorRequirement;
      else state.colorRequirement = saved.colorRequirement;
      state.readonlyBorrows.clear();
      for (const borrow of saved.readonlyBorrows) state.readonlyBorrows.add(borrow);
      if (saved.mutableBorrow === undefined) delete state.mutableBorrow;
      else state.mutableBorrow = saved.mutableBorrow;
    }
    this.#colors.restore(snapshot.colors);
    if (this.#entityRegistry !== undefined && snapshot.entityRegistry !== undefined) {
      this.#entityRegistry.restore(snapshot.entityRegistry);
    }
    this.#entityRevision = snapshot.entityRevision;
    this.#entityAuthorityList.length = snapshot.entityAuthoritiesLength;
    while (this.#linkedProducers.length > snapshot.linkedProducersLength) {
      const removed = this.#linkedProducers.pop();
      if (removed !== undefined) this.#linkedProducerByIdentity.delete(removed.producer.identity);
    }
  }

  #withTopologyTransaction<T>(rawSpan: RawSpan, operation: () => T): T {
    const snapshot = this.#topologySnapshot();
    try {
      return operation();
    } catch (error) {
      this.#restoreTopology(snapshot);
      if (error instanceof ElaborationOperationLimitError) throw error;
      if (error instanceof RecoverableElaborationExecutionError) throw error;
      if (error instanceof ElaborationExecutionError) {
        throw new RecoverableElaborationExecutionError(
          error.message,
          error.span,
          error.code,
          error.related,
          { cause: error },
        );
      }
      throw error;
    }
  }

  #isNetwork(value: unknown): value is NetworkValue {
    return this.#hasRuntimeKind(value, 'network');
  }

  #isCombinator(value: unknown): value is CombinatorValue {
    return this.#hasRuntimeKind(value, 'combinator');
  }

  #rawNetworkFacet(value: unknown): NetworkValue | undefined {
    if (this.#isNetwork(value)) return value;
    return this.#isCombinator(value)
      ? (value.networkFacet ?? this.#combinators.primary(value))
      : undefined;
  }

  #networkFacet(value: unknown): NetworkValue | undefined {
    return this.#rawNetworkFacet(value);
  }

  #networkValue<T extends NetworkValue>(value: T, state: NetworkRuntimeState): T {
    this.#networkStates.set(value.name, state);
    return this.#runtimeValues.brandNetwork(value, state);
  }

  #networkState(value: NetworkValue): NetworkRuntimeState {
    const state = this.#runtimeValues.networkState(value);
    if (state === undefined) throw new Error('Network handle is missing opaque runtime state.');
    return state;
  }

  #assertReadableNetwork(network: NetworkValue, rawSpan: RawSpan, role = 'Network'): void {
    this.#assertReadableNetworkAt(network, this.#span(rawSpan), role);
  }

  #assertReadableNetworkAt(network: NetworkValue, source: SourceSpan, role = 'Network'): void {
    this.#ownership.assertReadable(network, source, role);
    this.#markOutputUsed(network);
  }

  #markOutputUsed(network: NetworkValue): void {
    const combinator = this.#combinatorByOutput.get(this.#networkState(network).ownership);
    if (combinator !== undefined) this.#combinators.markOutputUsed(combinator);
  }

  #requireNetworkColor(
    network: NetworkValue,
    capability: 'readonly' | 'ref' | 'move',
    color: 'red' | 'green',
    rawSpan: RawSpan,
  ): void {
    const source = this.#span(rawSpan);
    const ownership = this.#networkState(network).ownership;
    if (ownership.colorRequirement !== undefined && ownership.colorRequirement.color !== color) {
      this.#ownership.requireColor(network, capability, color, source);
    }
    this.#colors.requireColor(this.#networkState(network).ownership, network.name, color, source);
    if (!this.#ownership.requireColor(network, capability, color, source)) return;
    const index = this.#networks.findLastIndex(({ name }) => name === network.name);
    const declaration = this.#networks[index];
    if (declaration === undefined) {
      throw new Error(`Cannot find Network descriptor for color requirement: ${network.name}.`);
    }
    this.#networks[index] = { ...declaration, fixedColor: color };
  }

  #assertWritableNetwork(network: NetworkValue, rawSpan: RawSpan, role = 'Network'): void {
    this.#ownership.assertWritable(network, this.#span(rawSpan), role);
  }

  #assertConsumableNetwork(network: NetworkValue, rawSpan: RawSpan, role: string): void {
    this.#ownership.assertConsumable(network, this.#span(rawSpan), role);
  }

  #networkParameter(
    value: unknown,
    capability: NetworkParameterCapability,
    parameter: string,
    fixedColor: 'red' | 'green' | undefined,
    rawSpan: RawSpan,
  ): NetworkValue {
    const bind = () =>
      bindNetworkParameter(
        value,
        {
          functionName: this.#currentFunctionName(),
          parameter,
          capability,
          ...(fixedColor === undefined ? {} : { fixedColor }),
          source: this.#span(rawSpan),
          frame: this.#currentFunctionFrame(),
        },
        {
          networkFacet: (candidate) =>
            capability === 'readonly'
              ? this.#readableNetworkFacet(candidate, rawSpan)
              : this.#networkFacet(candidate),
          isNetwork: (candidate): candidate is NetworkValue => this.#isNetwork(candidate),
          isCombinator: (candidate): candidate is CombinatorValue => this.#isCombinator(candidate),
          selectCombinatorMove: (candidate, source) =>
            this.#selectCombinatorMove(candidate, source),
          isPair: (candidate): candidate is PairValue => this.#isPair(candidate),
          isPairSelection: (candidate): candidate is PairSelectedValue =>
            this.#isPairSelection(candidate),
          recordDslCall: () => this.#recordDslCall(),
          stateFor: (network) => this.#networkState(network),
          assertReadable: (network, source) => this.#ownership.assertReadable(network, source),
          assertConsumable: (network, source, role) =>
            this.#ownership.assertConsumable(network, source, role),
          requireColor: (network, requiredCapability, color, source) =>
            this.#requireNetworkColor(network, requiredCapability, color, {
              start: source.start,
              end: source.end,
            }),
          borrow: (network, borrowCapability, name, source, frame) =>
            this.#ownership.borrow(network, borrowCapability, name, source, frame),
          moveToFrame: (network, source, frame) =>
            this.#ownership.moveToFrame(network, source, frame),
          brandNetwork: (network, state) => this.#networkValue(network, state),
        },
      );
    const bound = capability === 'move' ? this.#withTopologyTransaction(rawSpan, bind) : bind();
    this.#capabilityUses.push({
      network: bound.value.name,
      capability,
      parameter,
      ...(fixedColor === undefined ? {} : { fixedColor }),
      provenance: bound.provenance,
      instancePath: this.#path(),
    });
    return bound.value;
  }

  #returnOwnedValue(value: unknown, rawSpan: RawSpan): unknown {
    const source = this.#span(rawSpan);
    const frame = this.#currentFunctionFrame();
    return returnOwnedValue(value, source, {
      isEntity: (item): item is EntityValue => this.#isEntity(item),
      entityNetworks: (entity) => {
        const authority = this.#entityAuthority(entity, source);
        return [...authority.facets.values()]
          .filter(({ locallyOwned }) => locallyOwned)
          .map(({ network }) => network);
      },
      assertEntityReturnable: (entity) => this.#assertEntityReturnable(entity, source, frame),
      returnEntity: (entity) => this.#returnEntity(entity, rawSpan, frame),
      isCombinator: (item): item is CombinatorValue => this.#isCombinator(item),
      isNetwork: (item): item is NetworkValue => this.#isNetwork(item),
      isPair: (item): item is PairValue => this.#isPair(item),
      isPairSelection: (item): item is PairSelectedValue => this.#isPairSelection(item),
      isSelected: (item): item is SelectedValue => this.#isSelected(item),
      assertReturnable: (network) => this.#ownership.assertReturnable(network, source, frame),
      assertReadable: (network) => this.#ownership.assertReadable(network, source),
      ownershipOf: (network) => this.#networkState(network).ownership,
      combinatorNetworks: (combinator) => {
        const state = this.#combinators.stateFor(combinator);
        return [state.outputPort.primary.network, state.outputPort.secondary?.network].filter(
          (network): network is NetworkValue => network !== undefined,
        );
      },
      normalizeCombinator: (combinator) => combinator.unrestrictedHandle ?? combinator,
      isConsumed: (network) => this.#networkState(network).ownership.consumedAt !== undefined,
      isOwnedByReturnFrame: (network) =>
        frame !== undefined && this.#networkState(network).ownership.owner === frame.owner,
      isTransparentAlias: (network) => this.#isTransparentNetwork(network, frame),
      updateCombinatorNetwork: (combinator, original, returned) => {
        const state = this.#combinators.stateFor(combinator);
        if (state.outputPort.primary.network === original) {
          this.#combinators.setPrimary(combinator, returned);
        } else if (state.outputPort.secondary?.network === original) {
          this.#combinators.setSecondary(combinator, returned);
        }
      },
      chargeTransfer: () => this.#recordDslCall(),
      returnNetwork: (network) => this.#returnOwnedNetwork(network, rawSpan, false),
    });
  }

  #assertEntityReturnable(
    entity: EntityValue,
    source: SourceSpan,
    frame: FunctionOwnershipFrame | undefined,
  ): void {
    const authority = this.#entityAuthority(entity, source);
    if (frame === undefined || authority.owner !== frame.owner) return;
    for (const facet of authority.facets.values()) {
      if (facet.locallyOwned && facet.network.capability === 'ref') {
        throw new ElaborationExecutionError(
          'A borrowed Entity facet cannot escape its function.',
          source,
          'RT2017',
          [{ message: 'Entity facet was bound here.', span: facet.source }],
        );
      }
      if (facet.locallyOwned) this.#ownership.assertReturnable(facet.network, source, frame);
      else {
        const state = this.#networkState(facet.network);
        if (state.borrow !== undefined) {
          throw new ElaborationExecutionError(
            'A borrowed Entity connection cannot escape its function.',
            source,
            'RT2017',
            [{ message: 'Entity connection borrowed here.', span: state.borrow.source }],
          );
        }
        this.#ownership.assertReadable(facet.network, source, 'Entity connection');
      }
    }
  }

  #returnEntity(
    entity: EntityValue,
    rawSpan: RawSpan,
    frame: FunctionOwnershipFrame | undefined,
  ): EntityValue {
    const source = this.#span(rawSpan);
    const authority = this.#entityAuthority(entity, source);
    if (frame === undefined || authority.owner !== frame.owner) return entity;
    this.#assertEntityReturnable(entity, source, frame);
    const registry = this.#entityRegistry;
    if (registry === undefined) throw new Error('Entity registry is unavailable.');
    const returnedEntity = registry.createView(entity);
    const returnedAuthority: EntityAuthorityView = {
      entity: returnedEntity,
      owner: this.#parentFunctionFrame()?.owner ?? 'top-level',
      facets: new Map(),
    };
    for (const facet of authority.facets.values()) {
      const network = facet.locallyOwned
        ? this.#returnOwnedNetwork(facet.network, rawSpan, false, false)
        : this.#networkValue(
            {
              kind: 'network',
              name: facet.network.name,
              declaration: facet.network.declaration,
              capability: 'readonly',
              generation: facet.network.generation,
            },
            { ownership: this.#networkState(facet.network).ownership },
          );
      returnedAuthority.facets.set(this.#entityEndpointKey(facet.endpoint), {
        ...facet,
        network,
      });
    }
    authority.owner = 'retired';
    authority.retiredAt = source;
    this.#entityAuthorities.set(returnedEntity, returnedAuthority);
    this.#entityAuthorityList.push(returnedAuthority);
    this.#syncEntityBindings(returnedAuthority);
    return returnedEntity;
  }

  #combinatorHandle(
    value: unknown,
    expectedType: unknown,
    rawSpan: RawSpan,
    bindingName?: unknown,
  ): CombinatorValue {
    const combinator = bindCombinatorHandle(value, expectedType, bindingName, this.#span(rawSpan), {
      isCombinator: (candidate): candidate is CombinatorValue => this.#isCombinator(candidate),
      kindOf: (candidate) => this.#combinators.stateFor(candidate).descriptor.kind,
      bindName: (candidate, name) => this.#combinators.bindName(candidate, name),
    });
    if (typeof bindingName === 'string') {
      this.#captureNetworkAliasValue(bindingName, this.#rawNetworkFacet(combinator)!, rawSpan);
    }
    return combinator;
  }

  #returnCombinator(value: CombinatorValue, rawSpan: RawSpan): CombinatorValue {
    const frame = this.#currentFunctionFrame();
    if (frame === undefined)
      throw new Error('Combinator return was created outside a function frame.');
    const state = this.#combinators.stateFor(value);
    const transfer = (network: NetworkValue, lane: 'primary' | 'secondary'): void => {
      const ownership = this.#networkState(network).ownership;
      if (ownership.consumedAt !== undefined || ownership.owner !== frame.owner) return;
      const returned = this.#returnOwnedNetwork(network, rawSpan, false, false);
      if (lane === 'primary') this.#combinators.setPrimary(value, returned);
      else this.#combinators.setSecondary(value, returned);
    };
    transfer(state.outputPort.primary.network, 'primary');
    if (state.outputPort.secondary !== undefined) {
      transfer(state.outputPort.secondary.network, 'secondary');
    }
    return value.unrestrictedHandle ?? value;
  }

  #returnOwnedNetwork(
    value: NetworkValue,
    rawSpan: RawSpan,
    recordCall = true,
    markUsed = true,
  ): NetworkValue {
    if (recordCall) this.#recordDslCall();
    if (markUsed) this.#markOutputUsed(value);
    const frame = this.#currentFunctionFrame();
    if (frame === undefined) {
      throw new ElaborationExecutionError(
        `Function cannot return Network ${value.name} because it does not own that value; accept it as Move<Network> first.`,
        this.#span(rawSpan),
        'RT2019',
        [{ message: 'Network declared here.', span: value.declaration }],
      );
    }
    const caller = this.#parentFunctionFrame();
    const state = this.#networkState(value);
    this.#ownership.returnToCaller(value, this.#span(rawSpan), frame, caller);
    return this.#networkValue(
      {
        kind: 'network',
        name: value.name,
        declaration: value.declaration,
        capability: 'owned',
        generation: state.ownership.generation,
      },
      {
        ownership: state.ownership,
        ...(state.borrow === undefined ? {} : { borrow: state.borrow }),
      },
    );
  }

  #path(): readonly string[] {
    const invocation = this.#invocations.at(-1);
    if (
      invocation === undefined ||
      invocation.entered ||
      typeof invocation.callable !== 'function'
    ) {
      return Object.freeze([...this.#instancePath]);
    }
    invocation.segment ??= this.#allocateFunctionSegment(invocation.callable.name || '<anonymous>');
    return Object.freeze([...this.#instancePath, invocation.segment]);
  }

  #allocateFunctionSegment(name: string): string {
    const key = JSON.stringify([...this.#instancePath, name]);
    const occurrence = (this.#functionCallCounts.get(key) ?? 0) + 1;
    this.#functionCallCounts.set(key, occurrence);
    return `function ${name}${occurrence === 1 ? '' : ` #${occurrence}`}`;
  }

  #currentFunctionFrame(): FunctionOwnershipFrame | undefined {
    return this.#ownershipFrames.findLast((frame) => frame !== undefined);
  }

  #currentFunctionName(): string {
    const frame = this.#currentFunctionFrame();
    return frame === undefined
      ? '<indirect>'
      : (this.#functionCalls.get(frame)?.name ?? '<indirect>');
  }

  #parentFunctionFrame(): FunctionOwnershipFrame | undefined {
    let foundCurrent = false;
    for (let index = this.#ownershipFrames.length - 1; index >= 0; index -= 1) {
      const frame = this.#ownershipFrames[index];
      if (frame === undefined) continue;
      if (!foundCurrent) {
        foundCurrent = true;
        continue;
      }
      return frame;
    }
    return undefined;
  }

  #isSignalValue(value: unknown): value is SignalValue {
    return this.#hasRuntimeKind(value, 'signal-value');
  }

  #isSignal(value: unknown): value is SignalHandle {
    return this.#runtimeValues.hasSignal(value);
  }

  #signalHandle(value: SignalId): SignalHandle {
    const propertyKey = formatSignalRef(value);
    const handle = Object.create(Object.getPrototypeOf(value), {
      ...Object.getOwnPropertyDescriptors(value),
      [Symbol.toPrimitive]: {
        configurable: false,
        enumerable: false,
        writable: false,
        value: (hint: 'string' | 'number' | 'default') => {
          if (hint !== 'string') {
            throw new TypeError(
              'A source Signal can only be coerced to a string property key; numeric/default coercion is not supported.',
            );
          }
          return propertyKey;
        },
      },
    }) as SignalHandle;
    Object.freeze(handle);
    return this.#runtimeValues.brandSignal(handle);
  }

  #signalSnapshot(value: SignalId): SignalId {
    return Object.freeze({
      type: value.type,
      name: value.name,
      ...(value.quality === undefined ? {} : { quality: value.quality }),
    });
  }

  #isTrustedPrototypeRecord(value: unknown): boolean {
    if (
      this.#prototypes === undefined ||
      value === null ||
      typeof value !== 'object' ||
      typeof (value as { key?: unknown }).key !== 'string'
    ) {
      return false;
    }
    return this.#prototypes.getEntity((value as { key: string }).key) === value;
  }

  #normalizeArithmeticConfigurationSource(
    value: unknown,
    source: RawSpan,
  ): Omit<
    Extract<DirectPlanArithmetic, { readonly kind: 'arithmetic' }>,
    | 'kind'
    | 'destinations'
    | 'source'
    | 'instancePath'
    | 'bindingName'
    | 'debugCaptureIds'
    | 'placement'
  > {
    if (!isPlainDataRecord(value)) {
      throw new ElaborationExecutionError(
        'Arithmetic configuration must be a plain data record.',
        this.#span(source),
        'RT2027',
      );
    }
    const allowed = new Set(['left', 'operation', 'right', 'output']);
    const keys = Reflect.ownKeys(value);
    if (keys.some((key) => typeof key !== 'string' || !allowed.has(key))) {
      throw new ElaborationExecutionError(
        'Arithmetic configuration must contain exactly left, operation, right, and output fields.',
        this.#span(source),
        'RT2027',
      );
    }
    for (const key of allowed) {
      if (!Object.prototype.hasOwnProperty.call(value, key)) {
        throw new ElaborationExecutionError(
          `Arithmetic configuration is missing required field ${JSON.stringify(key)}.`,
          this.#span(source),
          'RT2027',
        );
      }
    }
    const operation = value.operation;
    if (
      typeof operation !== 'string' ||
      !exactArithmeticOperations.includes(operation as (typeof exactArithmeticOperations)[number])
    ) {
      throw new ElaborationExecutionError(
        `Arithmetic configuration operation must be one of ${exactArithmeticOperations.join(', ')}.`,
        this.#span(source),
        'RT2027',
      );
    }
    let left: PlanArithmeticOperand;
    let right: PlanArithmeticOperand;
    try {
      left = this.#arithmeticOperand(value.left as DslValue, source);
      right = this.#arithmeticOperand(value.right as DslValue, source);
    } catch (error) {
      if (error instanceof ElaborationExecutionError) throw error;
      throw new ElaborationExecutionError(
        error instanceof Error ? error.message : 'Invalid Arithmetic operand.',
        this.#span(source),
        'RT2027',
        undefined,
        { cause: error },
      );
    }
    const outputValue = value.output;
    let output: LogicalArithmeticOutput;
    if (this.#isSignal(outputValue)) {
      output = { kind: 'signal', signal: this.#signalSnapshot(outputValue) };
    } else if (this.#isWildcardToken(outputValue) && outputValue.value === 'each') {
      output = { kind: 'each' };
    } else {
      throw new ElaborationExecutionError(
        'Arithmetic configuration output must be a concrete Signal or Each/EACH.',
        this.#span(source),
        'RT2027',
      );
    }
    return { left, operation: operation as ArithmeticOperation, right, output };
  }

  #normalizeDeciderConfigurationSource(
    value: unknown,
    source: RawSpan,
    fieldSources?: CallArgument['fieldSources'],
  ): {
    readonly condition: PlanDeciderCondition;
    readonly outputs: readonly DeciderOutputCandidate[];
    readonly elseOutputs?: readonly DeciderOutputCandidate[];
  } {
    if (!isPlainDataRecord(value)) {
      throw new ElaborationExecutionError(
        'Decider configuration must be a plain data record.',
        this.#span(source),
        'RT2027',
      );
    }
    const allowed = new Set(['condition', 'outputs', 'elseOutputs']);
    if (Reflect.ownKeys(value).some((key) => typeof key !== 'string' || !allowed.has(key))) {
      throw new ElaborationExecutionError(
        'Decider configuration must contain exactly condition, outputs, and optional elseOutputs fields.',
        this.#span(source),
        'RT2027',
      );
    }
    if (!Object.prototype.hasOwnProperty.call(value, 'condition')) {
      throw new ElaborationExecutionError(
        'Decider configuration is missing required field "condition".',
        this.#span(source),
        'RT2027',
      );
    }
    const conditionValue = value.condition;
    if (!this.#isCondition(conditionValue)) {
      throw new ElaborationExecutionError(
        'Decider configuration condition must be a circuit Condition.',
        this.#span(source),
        'RT2027',
      );
    }
    const normal =
      Object.prototype.hasOwnProperty.call(value, 'outputs') && value.outputs !== undefined
        ? this.#deciderConfigurationRows(value.outputs, fieldSources?.outputs ?? source, 'outputs')
        : [];
    const alternate =
      Object.prototype.hasOwnProperty.call(value, 'elseOutputs') && value.elseOutputs !== undefined
        ? this.#deciderConfigurationRows(
            value.elseOutputs,
            fieldSources?.elseOutputs ?? source,
            'elseOutputs',
          )
        : [];
    if (normal.length === 0 && alternate.length === 0) {
      throw new ElaborationExecutionError(
        'Decider configuration requires at least one output row.',
        this.#span(source),
        'RT2027',
      );
    }
    return {
      condition: conditionValue.condition,
      outputs: normal,
      ...(alternate.length === 0 ? {} : { elseOutputs: alternate }),
    };
  }

  #deciderConfigurationRows(
    value: unknown,
    source: RawSpan,
    field: 'outputs' | 'elseOutputs',
  ): readonly DeciderOutputCandidate[] {
    this.#assertDeciderOutputContainer(value, new Set(), source);
    try {
      return this.#deciderOutputs(value, source, source, this.#path()).map((row) => ({
        ...row,
        syntaxIntent: 'exact' as const,
      }));
    } catch (error) {
      if (error instanceof ElaborationExecutionError) throw error;
      throw new ElaborationExecutionError(
        error instanceof Error ? error.message : `Invalid Decider configuration ${field}.`,
        this.#span(source),
        'RT2027',
        undefined,
        { cause: error },
      );
    }
  }

  #assertDeciderOutputContainer(value: unknown, seen: Set<object>, source: RawSpan): void {
    if (
      this.#isSignalValue(value) ||
      this.#isWildcardCount(value) ||
      this.#isSelected(value) ||
      this.#isPair(value) ||
      this.#rawNetworkFacet(value) !== undefined
    )
      return;
    if (value === null || typeof value !== 'object') return;
    if (seen.has(value)) {
      throw new ElaborationExecutionError(
        'Decider configuration output containers cannot be cyclic.',
        this.#span(source),
        'RT2027',
      );
    }
    seen.add(value);
    try {
      if (Array.isArray(value)) {
        if (Object.getPrototypeOf(value) !== Array.prototype)
          throw new ElaborationExecutionError(
            'Decider configuration output arrays must be plain arrays.',
            this.#span(source),
            'RT2027',
          );
        for (const key of Reflect.ownKeys(value)) {
          if (typeof key !== 'string' || (key !== 'length' && !/^(0|[1-9][0-9]*)$/.test(key)))
            throw new ElaborationExecutionError(
              'Decider configuration output arrays cannot contain custom or symbol fields.',
              this.#span(source),
              'RT2027',
            );
          const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
          if (!('value' in descriptor))
            throw new ElaborationExecutionError(
              'Decider configuration output containers cannot contain accessors.',
              this.#span(source),
              'RT2027',
            );
        }
        for (let index = 0; index < value.length; index += 1) {
          if (!Object.prototype.hasOwnProperty.call(value, String(index)))
            throw new ElaborationExecutionError(
              'Decider configuration output arrays cannot contain holes.',
              this.#span(source),
              'RT2027',
            );
          this.#assertDeciderOutputContainer(value[index], seen, source);
        }
        return;
      }
      const prototype = Object.getPrototypeOf(value);
      if (prototype !== Object.prototype && prototype !== null) return;
      for (const key of Reflect.ownKeys(value)) {
        if (typeof key !== 'string')
          throw new ElaborationExecutionError(
            'Decider configuration output records cannot contain symbol fields.',
            this.#span(source),
            'RT2027',
          );
        const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
        if (!('value' in descriptor))
          throw new ElaborationExecutionError(
            'Decider configuration output containers cannot contain accessors.',
            this.#span(source),
            'RT2027',
          );
        this.#assertDeciderOutputContainer(descriptor.value, seen, source);
      }
    } finally {
      seen.delete(value);
    }
  }

  #resolveCanonicalArithmeticProfile(rawSpan: RawSpan): EntityProfile | undefined {
    const context = this.#entityContext;
    const resolver = this.#entityPrototypeResolver;
    if (context === undefined || resolver === undefined) return undefined;
    const candidates = context.profiles.filter(
      ({ ref }) => ref.prototypeKey === 'entity:arithmetic-combinator',
    );
    if (candidates.length === 0) return undefined;
    if (candidates.length > 1) {
      throw new ElaborationExecutionError(
        'The trusted provider exposes ambiguous base arithmetic-combinator profiles.',
        this.#span(rawSpan),
        'RT2027',
      );
    }
    const profile = candidates[0]!;
    if (profile.prototypeType !== 'arithmetic-combinator') {
      throw new ElaborationExecutionError(
        'The trusted base arithmetic-combinator profile does not assert prototypeType "arithmetic-combinator".',
        this.#span(rawSpan),
        'RT2027',
      );
    }
    let prototype: EntityPrototype | undefined;
    try {
      prototype = resolver.getEntity(profile.ref.prototypeKey);
    } catch (error) {
      throw new ElaborationExecutionError(
        error instanceof Error ? error.message : 'Arithmetic prototype lookup failed.',
        this.#span(rawSpan),
        'RT2027',
        undefined,
        { cause: error },
      );
    }
    if (prototype === undefined) {
      throw new ElaborationExecutionError(
        `Trusted Arithmetic profile ${JSON.stringify(profile.ref.prototypeKey)} is not available in the selected provider.`,
        this.#span(rawSpan),
        'RT2027',
      );
    }
    if (
      prototype.key !== profile.ref.prototypeKey ||
      prototype.name !== 'arithmetic-combinator' ||
      prototype.type !== 'arithmetic-combinator'
    ) {
      throw new ElaborationExecutionError(
        `Trusted Arithmetic profile ${JSON.stringify(profile.ref.prototypeKey)} does not match base provider prototype data.`,
        this.#span(rawSpan),
        'RT2027',
      );
    }
    return profile;
  }

  #resolveCanonicalDeciderProfile(rawSpan: RawSpan): EntityProfile | undefined {
    const context = this.#entityContext;
    const resolver = this.#entityPrototypeResolver;
    if (context === undefined || resolver === undefined) return undefined;
    const candidates = context.profiles.filter(
      ({ ref }) => ref.prototypeKey === 'entity:decider-combinator',
    );
    if (candidates.length === 0) return undefined;
    if (candidates.length > 1) {
      throw new ElaborationExecutionError(
        'The trusted provider exposes ambiguous base decider-combinator profiles.',
        this.#span(rawSpan),
        'RT2027',
      );
    }
    const profile = candidates[0]!;
    if (profile.prototypeType !== 'decider-combinator') {
      throw new ElaborationExecutionError(
        'The trusted base decider-combinator profile does not assert prototypeType "decider-combinator".',
        this.#span(rawSpan),
        'RT2027',
      );
    }
    let prototype: EntityPrototype | undefined;
    try {
      prototype = resolver.getEntity(profile.ref.prototypeKey);
    } catch (error) {
      throw new ElaborationExecutionError(
        error instanceof Error ? error.message : 'Decider prototype lookup failed.',
        this.#span(rawSpan),
        'RT2027',
        undefined,
        { cause: error },
      );
    }
    if (prototype === undefined) {
      throw new ElaborationExecutionError(
        `Trusted Decider profile ${JSON.stringify(profile.ref.prototypeKey)} is not available in the selected provider.`,
        this.#span(rawSpan),
        'RT2027',
      );
    }
    if (
      prototype.key !== profile.ref.prototypeKey ||
      prototype.name !== 'decider-combinator' ||
      prototype.type !== 'decider-combinator'
    ) {
      throw new ElaborationExecutionError(
        `Trusted Decider profile ${JSON.stringify(profile.ref.prototypeKey)} does not match base provider prototype data.`,
        this.#span(rawSpan),
        'RT2027',
      );
    }
    return profile;
  }

  #resolveCanonicalConstantProfile(rawSpan: RawSpan): EntityProfile | undefined {
    const context = this.#entityContext;
    const resolver = this.#entityPrototypeResolver;
    if (context === undefined || resolver === undefined) return undefined;
    const candidates = context.profiles.filter(
      ({ ref }) => ref.prototypeKey === 'entity:constant-combinator',
    );
    if (candidates.length === 0) return undefined;
    if (candidates.length > 1) {
      throw new ElaborationExecutionError(
        'The trusted provider exposes ambiguous base constant-combinator profiles.',
        this.#span(rawSpan),
        'RT2027',
      );
    }
    const profile = candidates[0]!;
    if (profile.prototypeType !== 'constant-combinator') {
      throw new ElaborationExecutionError(
        'The trusted base constant-combinator profile does not assert prototypeType "constant-combinator".',
        this.#span(rawSpan),
        'RT2027',
      );
    }
    let prototype: EntityPrototype | undefined;
    try {
      prototype = resolver.getEntity(profile.ref.prototypeKey);
    } catch (error) {
      throw new ElaborationExecutionError(
        error instanceof Error ? error.message : 'Constant prototype lookup failed.',
        this.#span(rawSpan),
        'RT2027',
        undefined,
        { cause: error },
      );
    }
    if (prototype === undefined) {
      throw new ElaborationExecutionError(
        `Trusted Constant profile ${JSON.stringify(profile.ref.prototypeKey)} is not available in the selected provider.`,
        this.#span(rawSpan),
        'RT2027',
      );
    }
    if (
      prototype.key !== profile.ref.prototypeKey ||
      prototype.name !== 'constant-combinator' ||
      prototype.type !== 'constant-combinator'
    ) {
      throw new ElaborationExecutionError(
        `Trusted Constant profile ${JSON.stringify(profile.ref.prototypeKey)} does not match base provider prototype data.`,
        this.#span(rawSpan),
        'RT2027',
      );
    }
    return profile;
  }

  #createConstantProducer(
    configuration: import('@comblang/factorio').ConstantConfiguration,
    rawSpan: RawSpan,
    outputs: readonly { readonly signal: SignalId; readonly value: number }[],
    exact: boolean,
  ): CombinatorValue {
    const profile = this.#resolveCanonicalConstantProfile(rawSpan);
    if (profile === undefined && exact) {
      throw new ElaborationExecutionError(
        'Exact Constant configuration requires a trusted base entity:constant-combinator Entity profile.',
        this.#span(rawSpan),
        'RT2027',
      );
    }
    const entity =
      profile === undefined
        ? undefined
        : this.#allocateEntity(profile.ref, undefined, undefined, rawSpan);
    const producer = this.#createCombinator(
      {
        kind: 'constant',
        outputs: outputs.map(({ signal, value }) => ({
          signal: this.#signalSnapshot(signal),
          value,
        })),
        source: this.#span(rawSpan),
        instancePath: this.#path(),
      },
      rawSpan,
    );
    if (entity !== undefined) {
      const association = {
        kind: 'constant' as const,
        entity,
        configuration,
      } satisfies LinkedConstantAssociation;
      this.#linkedProducerByIdentity.set(producer.identity, association);
      this.#linkedProducers.push({ producer, association });
    }
    return producer;
  }

  #constructEntity(
    profile: unknown,
    configuration: unknown,
    placement: unknown,
    rawSpan: RawSpan,
  ): EntityValue {
    this.#recordDslCall();
    return this.#allocateEntity(profile, configuration, placement, rawSpan);
  }

  #allocateEntity(
    profile: unknown,
    configuration: unknown,
    placement: unknown,
    rawSpan: RawSpan,
  ): EntityValue {
    if (!isRawSpan(rawSpan)) throw new Error('t.entity(...) is missing provenance.');
    const registry = this.#entityRegistry;
    if (registry === undefined || this.#entityContext === undefined) {
      throw new ElaborationExecutionError(
        'Entity construction requires a trusted v3 context and prototype resolver.',
        this.#span(rawSpan),
        'RT2027',
      );
    }
    try {
      const creationRevision = this.#entityRevision + 1;
      const entity = registry.create({
        profile: profile as EntityProfileRef,
        ...(configuration === undefined
          ? {}
          : { configuration: configuration as EntityConfiguration }),
        ...(placement === undefined ? {} : { placement: placement as EntityPlacement }),
        source: this.#span(rawSpan),
        instancePath: this.#path(),
        expansionStack: [],
        creationRevision,
      });
      this.#entityRevision = creationRevision;
      const authority = {
        entity,
        owner: this.#currentFunctionFrame()?.owner ?? 'top-level',
        facets: new Map(),
      } satisfies EntityAuthorityView;
      this.#entityAuthorities.set(entity, authority);
      this.#entityAuthorityList.push(authority);
      return entity;
    } catch (error) {
      const code =
        error instanceof EntityRegistryError && error.code.length > 0 ? error.code : 'RT2027';
      throw new ElaborationExecutionError(
        error instanceof Error ? error.message : 'Entity construction failed.',
        this.#span(rawSpan),
        code,
        undefined,
        { cause: error },
      );
    }
  }

  #constructEntityFromPrototype(
    arguments_: readonly CallArgument[],
    rawSpan: RawSpan,
    expectedType?: string,
    constructorName?: string,
    recordCall = true,
  ): EntityValue {
    if (recordCall) this.#recordDslCall();
    if (!isRawSpan(rawSpan)) throw new Error('t.entityFromPrototype(...) is missing provenance.');
    const publicConstructorName = constructorName ?? 'Entity';
    if (!Array.isArray(arguments_) || (arguments_.length !== 1 && arguments_.length !== 2)) {
      throw new ElaborationExecutionError(
        `${publicConstructorName}(prototype, configuration?) requires one or two arguments.`,
        this.#span(rawSpan),
        'RT2027',
      );
    }
    const { prototype, profile } = this.#resolveEntityConstructionTarget(
      arguments_[0]!,
      rawSpan,
      expectedType,
      publicConstructorName,
    );
    const configuration =
      arguments_.length === 2 && arguments_[1]!.value !== undefined
        ? this.#publicEntityConfiguration(arguments_[1]!.value, arguments_[1]!.source, prototype)
        : undefined;
    return this.#allocateEntity(profile.ref, configuration, undefined, rawSpan);
  }

  #resolveEntityConstructionTarget(
    argument: CallArgument,
    rawSpan: RawSpan,
    expectedType?: string,
    constructorName?: string,
  ): { readonly prototype: EntityPrototype; readonly profile: EntityProfile } {
    const prototypeValue = argument.value;
    const context = this.#entityContext;
    const resolver = this.#entityPrototypeResolver;
    if (context === undefined || resolver === undefined) {
      throw new ElaborationExecutionError(
        'Entity construction requires a trusted v3 context and prototype resolver.',
        this.#span(rawSpan),
        'RT2027',
      );
    }

    let prototype: EntityPrototype | undefined;
    if (typeof prototypeValue === 'string') {
      if (prototypeValue.length === 0) {
        throw new ElaborationExecutionError(
          'Entity prototype name must be a non-empty string.',
          this.#span(rawSpan),
          'RT2027',
        );
      }
      try {
        prototype = resolver.getEntity(prototypeValue);
      } catch (error) {
        throw new ElaborationExecutionError(
          error instanceof Error ? error.message : 'Entity prototype lookup failed.',
          this.#span(rawSpan),
          'RT2027',
          undefined,
          { cause: error },
        );
      }
    } else if (typeof prototypeValue === 'object' && prototypeValue !== null) {
      if (this.#prototypes === undefined) {
        throw new ElaborationExecutionError(
          'Entity prototype records require the selected host prototype provider.',
          this.#span(rawSpan),
          'RT2027',
        );
      }
      const candidate = prototypeValue as Partial<EntityPrototype>;
      if (typeof candidate.key !== 'string') {
        throw new ElaborationExecutionError(
          'Entity prototype record has no canonical key.',
          this.#span(rawSpan),
          'RT2027',
        );
      }
      try {
        const selected = this.#prototypes.getEntity(candidate.key);
        if (selected === undefined || selected !== prototypeValue) {
          throw new ElaborationExecutionError(
            'Entity prototype record is foreign or not owned by the selected host provider.',
            this.#span(rawSpan),
            'RT2027',
          );
        }
        prototype = selected;
      } catch (error) {
        if (error instanceof ElaborationExecutionError) throw error;
        throw new ElaborationExecutionError(
          error instanceof Error ? error.message : 'Entity prototype lookup failed.',
          this.#span(rawSpan),
          'RT2027',
          undefined,
          { cause: error },
        );
      }
    } else {
      throw new ElaborationExecutionError(
        'Entity prototype must be a name or a record from the selected host provider.',
        this.#span(rawSpan),
        'RT2027',
      );
    }

    if (
      prototype === undefined ||
      typeof prototype.key !== 'string' ||
      typeof prototype.name !== 'string' ||
      typeof prototype.type !== 'string' ||
      !/^entity:[^:\s]+$/.test(prototype.key) ||
      prototype.key !== `entity:${prototype.name}`
    ) {
      throw new ElaborationExecutionError(
        'Entity prototype is malformed or unavailable in the selected host database.',
        this.#span(rawSpan),
        'RT2027',
      );
    }
    if (expectedType !== undefined && prototype.type !== expectedType) {
      throw new ElaborationExecutionError(
        `${constructorName ?? 'Entity'} requires provider Entity type ${JSON.stringify(expectedType)}, but prototype ${JSON.stringify(prototype.key)} has actual type ${JSON.stringify(prototype.type)}.`,
        this.#span(argument.source),
        'RT2027',
      );
    }
    const matches = context.profiles.filter(({ ref }) => ref.prototypeKey === prototype.key);
    if (matches.length === 0) {
      throw new ElaborationExecutionError(
        `No trusted Entity profile matches prototype ${JSON.stringify(prototype.key)}.`,
        this.#span(rawSpan),
        'RT2027',
      );
    }
    if (matches.length > 1) {
      throw new ElaborationExecutionError(
        `Entity prototype ${JSON.stringify(prototype.key)} has ambiguous trusted profiles.`,
        this.#span(rawSpan),
        'RT2027',
      );
    }
    return { prototype, profile: matches[0]! };
  }

  #publicEntityConfiguration(
    value: unknown,
    rawSpan: RawSpan,
    prototype: EntityPrototype,
  ): EntityConfiguration {
    const source = this.#span(rawSpan);
    if (
      value === null ||
      typeof value !== 'object' ||
      Array.isArray(value) ||
      (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)
    ) {
      throw new ElaborationExecutionError(
        'Entity configuration must be a plain object.',
        source,
        'RT2027',
      );
    }
    const record = Object.create(null) as Record<string, unknown>;
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== 'string') {
        throw new ElaborationExecutionError(
          'Entity configuration cannot contain symbol fields.',
          source,
          'RT2027',
        );
      }
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined || !('value' in descriptor)) {
        throw new ElaborationExecutionError(
          `Entity configuration field ${JSON.stringify(key)} must be data-only.`,
          source,
          'RT2027',
        );
      }
      record[key] = descriptor.value;
    }
    const keys = Object.keys(record);
    const isExactRaw = keys.length === 1 && keys[0] === 'raw';
    const isExactTyped =
      keys.length === 3 &&
      keys.includes('rule') &&
      keys.includes('lanes') &&
      keys.includes('condition');
    if (isExactRaw) {
      try {
        return {
          mode: 'raw',
          payload: canonicalizeEntityRawObject(record.raw, undefined, '$.raw'),
        };
      } catch (error) {
        if (error instanceof EntityRawJsonError) {
          throw new ElaborationExecutionError(error.message, source, 'RT2027', undefined, {
            cause: error,
          });
        }
        throw error;
      }
    }
    if (isExactTyped) {
      const condition = record.condition;
      if (!this.#isNativeCondition(condition)) {
        throw new ElaborationExecutionError(
          'Entity configuration condition must be a NativeCondition from this execution session.',
          source,
          'RT2027',
        );
      }
      return {
        mode: 'typed',
        rule: record.rule as EntityBehaviorKey,
        lanes: record.lanes as readonly EntityLaneKey[],
        condition: condition.condition,
      };
    }
    if (keys.some((key) => ['raw', 'rule', 'lanes', 'condition'].includes(key))) {
      throw new ElaborationExecutionError(
        'Entity configuration envelope fields raw, rule, lanes, and condition must use one exact legacy form.',
        source,
        'RT2027',
      );
    }
    let schema;
    try {
      schema = resolveBlueprintEntitySchema(prototype);
    } catch (error) {
      throw new ElaborationExecutionError(
        error instanceof Error ? error.message : 'Entity Blueprint schema resolution failed.',
        source,
        'RT2027',
      );
    }
    let detached: unknown;
    try {
      detached = detachBlueprintEntitySignalHandles(
        value,
        { kind: 'object', fields: schema.fields },
        schema,
        (candidate) => this.#isSignal(candidate),
      );
    } catch (error) {
      if (error instanceof BlueprintEntitySignalConversionError) {
        throw new ElaborationExecutionError(error.message, source, 'RT2027', undefined, {
          cause: error,
        });
      }
      throw error;
    }
    const validation = validateBlueprintEntityFragmentAgainstSchema(detached, schema);
    if (validation.status !== 'valid') {
      const detail =
        validation.status === 'unassessed'
          ? `${validation.path}: ${validation.message} ${validation.rawSuggestion}`
          : `${validation.path}: ${validation.message}`;
      throw new ElaborationExecutionError(
        `Entity checked Blueprint configuration is not accepted. ${detail}`,
        source,
        'RT2027',
      );
    }
    try {
      return {
        mode: 'raw',
        payload: canonicalizeEntityRawObject(detached, undefined, '$.configuration'),
      };
    } catch (error) {
      if (error instanceof EntityRawJsonError) {
        throw new ElaborationExecutionError(error.message, source, 'RT2027', undefined, {
          cause: error,
        });
      }
      throw error;
    }
  }

  #constructNativeCondition(
    arguments_: readonly CallArgument[],
    rawSpan: RawSpan,
  ): NativeConditionValue {
    this.#recordDslCall();
    if (!isRawSpan(rawSpan)) throw new Error('t.nativeCondition(...) is missing provenance.');
    if (!Array.isArray(arguments_) || arguments_.length !== 3) {
      throw new ElaborationExecutionError(
        'NativeCondition(signal, comparator, constant) requires exactly three arguments.',
        this.#span(rawSpan),
        'RT2027',
      );
    }
    const signalArgument = arguments_[0]!;
    const comparatorArgument = arguments_[1]!;
    const constantArgument = arguments_[2]!;
    if (!this.#isSignal(signalArgument.value)) {
      throw new ElaborationExecutionError(
        'NativeCondition requires a concrete Signal from this execution session.',
        this.#span(signalArgument.source),
        'RT2027',
      );
    }
    const comparator = comparatorArgument.value;
    if (
      comparator !== '>' &&
      comparator !== '<' &&
      comparator !== '=' &&
      comparator !== '>=' &&
      comparator !== '<=' &&
      comparator !== '!='
    ) {
      throw new ElaborationExecutionError(
        'NativeCondition comparator must be one of >, <, =, >=, <=, !=.',
        this.#span(comparatorArgument.source),
        'RT2027',
      );
    }
    const constant = constantArgument.value;
    if (typeof constant !== 'number' || !Number.isSafeInteger(constant)) {
      throw new ElaborationExecutionError(
        'NativeCondition constant must be a finite safe integer.',
        this.#span(constantArgument.source),
        'RT2027',
      );
    }
    const signal = signalArgument.value;
    const condition: EntityNativeSingleCondition = Object.freeze({
      kind: 'compare-signal-constant',
      signal:
        signal.quality === undefined
          ? Signal(signal.type, signal.name)
          : Signal(signal.type, signal.name, signal.quality),
      comparator: comparator as EntityNativeComparator,
      constant: circuitConstant(constant),
    });
    return this.#runtimeValue(Object.freeze({ kind: 'native-condition', condition }));
  }

  #isEntity(value: unknown): value is EntityValue {
    return this.#entityRegistry?.isEntity(value) === true;
  }

  #isNativeCondition(value: unknown): value is NativeConditionValue {
    return this.#hasRuntimeKind(value, 'native-condition');
  }

  #entityAuthority(value: unknown, source: SourceSpan): EntityAuthorityView {
    if (!this.#isEntity(value)) {
      throw new ElaborationExecutionError(
        'Entity operation requires an Entity handle from this execution session.',
        source,
        'RT2027',
      );
    }
    const authority = this.#entityAuthorities.get(value);
    if (authority === undefined) {
      throw new ElaborationExecutionError(
        'Entity handle has no authority view in this execution session.',
        source,
        'RT2027',
      );
    }
    if (authority.owner === 'retired') {
      throw new ElaborationExecutionError(
        'The Entity view was transferred to its caller and is stale.',
        source,
        'RT2012',
        authority.retiredAt === undefined
          ? undefined
          : [{ message: 'Entity view was transferred here.', span: authority.retiredAt }],
      );
    }
    return authority;
  }

  #entityEndpoint(
    value: unknown,
    connectorValue: unknown,
    laneValue: unknown,
    source: SourceSpan,
  ): {
    readonly authority: EntityAuthorityView;
    readonly profile: EntityProfile;
    readonly connector: EntityConnectorProfile;
    readonly endpoint: EntityLaneEndpoint;
  } {
    const authority = this.#entityAuthority(value, source);
    const context = this.#entityContext;
    const registry = this.#entityRegistry;
    if (context === undefined || registry === undefined) {
      throw new ElaborationExecutionError(
        'Entity operation requires a trusted v3 context and prototype resolver.',
        source,
        'RT2027',
      );
    }
    if (typeof connectorValue !== 'string' || typeof laneValue !== 'string') {
      throw new ElaborationExecutionError(
        'Entity connector and lane keys must be strings.',
        source,
        'RT2031',
      );
    }
    let profile: EntityProfile;
    try {
      profile = resolveEntityReplayProfile(registry.record(authority.entity).profile, context);
    } catch (error) {
      throw new ElaborationExecutionError(
        error instanceof Error ? error.message : 'Entity profile is unavailable.',
        source,
        'RT2027',
        undefined,
        { cause: error },
      );
    }
    const connector = profile.connectors.find(({ key }) => key === connectorValue);
    if (connector === undefined) {
      throw new ElaborationExecutionError(
        `Unknown Entity connector ${JSON.stringify(connectorValue)}.`,
        source,
        'RT2031',
      );
    }
    const lane = connector.lanes.find(({ key }) => key === laneValue);
    if (lane === undefined) {
      throw new ElaborationExecutionError(
        `Unknown Entity lane ${JSON.stringify(laneValue)} on connector ${JSON.stringify(connectorValue)}.`,
        source,
        'RT2031',
      );
    }
    return {
      authority,
      profile,
      connector,
      endpoint: { connector: connector.key, lane: lane.key, color: lane.color },
    };
  }

  #entityEndpointKey(endpoint: EntityLaneEndpoint): string {
    return `${endpoint.connector}/${endpoint.lane}/${endpoint.color}`;
  }

  #entityBindingProvenance(rawSpan: RawSpan): EntityConnectorBindingProvenance {
    return Object.freeze({
      source: this.#span(rawSpan),
      instancePath: this.#path(),
      operationOrdinal: ++this.#entityOperationOrdinal,
    });
  }

  #projectionDirection(connector: EntityConnectorProfile): 'input' | 'output' {
    return connector.direction === 'output' ? 'output' : 'input';
  }

  #syncEntityBindings(authority: EntityAuthorityView): void {
    this.#entityRegistry?.replaceConnectorBindings(
      authority.entity,
      [...authority.facets.values()].map(({ endpoint, network, direction, provenance }) => ({
        endpoint,
        network: network.name,
        generation: network.generation,
        direction,
        provenance,
      })),
    );
  }

  #projectEntity(
    value: unknown,
    connectorValue: unknown,
    laneValue: unknown,
    rawSpan: RawSpan,
  ): NetworkValue {
    this.#recordDslCall();
    if (!isRawSpan(rawSpan)) throw new Error('t.entityFacet(...) is missing provenance.');
    const source = this.#span(rawSpan);
    const { authority, connector, endpoint } = this.#entityEndpoint(
      value,
      connectorValue,
      laneValue,
      source,
    );
    const key = this.#entityEndpointKey(endpoint);
    const existing = authority.facets.get(key);
    if (existing !== undefined) {
      this.#assertReadableNetworkAt(existing.network, source, 'Entity facet');
      return existing.network;
    }
    const direction = this.#projectionDirection(connector);
    const provenance = this.#entityBindingProvenance(rawSpan);
    const network = this.#network(`$entity:${authority.entity.id}:${key}`, rawSpan, endpoint.color);
    authority.facets.set(key, {
      endpoint,
      direction,
      provenance,
      source,
      network,
      locallyOwned: true,
    });
    this.#syncEntityBindings(authority);
    return network;
  }

  #bindEntity(
    value: unknown,
    connectorValue: unknown,
    laneValue: unknown,
    networkValue: unknown,
    directionValue: unknown,
    rawSpan: RawSpan,
  ): EntityValue {
    this.#recordDslCall();
    if (!isRawSpan(rawSpan)) throw new Error('t.bindEntity(...) is missing provenance.');
    const source = this.#span(rawSpan);
    if (directionValue !== 'input' && directionValue !== 'output') {
      throw new ElaborationExecutionError(
        'Entity binding direction must be input or output.',
        source,
        'RT2031',
      );
    }
    const { authority, connector, endpoint } = this.#entityEndpoint(
      value,
      connectorValue,
      laneValue,
      source,
    );
    if (
      (directionValue === 'input' && connector.direction === 'output') ||
      (directionValue === 'output' && connector.direction === 'input')
    ) {
      throw new ElaborationExecutionError(
        `Entity connector ${connector.key} cannot be used as an ${directionValue} endpoint.`,
        source,
        'RT2031',
      );
    }
    const network = this.#networkFacet(networkValue);
    if (network === undefined) {
      throw new ElaborationExecutionError(
        'Entity binding requires an existing readable Network.',
        source,
        'RT2015',
      );
    }
    if (directionValue === 'output') {
      this.#assertWritableNetwork(network, rawSpan, 'Entity output binding Network');
    }
    this.#assertReadableNetworkAt(network, source, 'Entity binding Network');
    this.#requireNetworkColor(network, 'ref', endpoint.color, rawSpan);
    const key = this.#entityEndpointKey(endpoint);
    const existing = authority.facets.get(key);
    if (existing !== undefined) {
      if (
        this.#networkState(existing.network).ownership === this.#networkState(network).ownership &&
        existing.direction === directionValue
      ) {
        return authority.entity;
      }
      if (existing.direction !== directionValue) {
        throw new ElaborationExecutionError(
          `Entity endpoint ${key} is already bound with direction ${existing.direction}.`,
          source,
          'RT2030',
          [{ message: 'The first Entity binding originates here.', span: existing.source }],
        );
      }
      throw new ElaborationExecutionError(
        `Entity endpoint ${key} is already bound to a different logical Network.`,
        source,
        'RT2030',
        [{ message: 'The first Entity binding originates here.', span: existing.source }],
      );
    }
    const state = this.#networkState(network);
    const facet = this.#networkValue(
      {
        kind: 'network',
        name: network.name,
        declaration: network.declaration,
        capability: 'ref',
        generation: network.generation,
      },
      {
        ownership: state.ownership,
        ...(state.borrow === undefined ? {} : { borrow: state.borrow }),
      },
    );
    authority.facets.set(key, {
      endpoint,
      direction: directionValue,
      provenance: this.#entityBindingProvenance(rawSpan),
      source,
      network: facet,
      locallyOwned: false,
    });
    this.#syncEntityBindings(authority);
    return authority.entity;
  }

  #readableNetworkFacet(value: unknown, source: RawSpan | SourceSpan): NetworkValue | undefined {
    if (this.#isEntity(value)) {
      const profile = this.#entityContext?.profiles.find(
        ({ ref }) => ref.profileId === value.profile.profileId,
      );
      const projection = profile?.defaultReadProjection;
      if (projection === null || projection === undefined) {
        throw new ElaborationExecutionError(
          'Entity has no unambiguous default read projection; select an explicit facet.',
          this.#sourceSpan(source),
          'RT2032',
        );
      }
      return this.#projectEntity(
        value,
        projection.connector,
        projection.lane,
        this.#rawSpan(source),
      );
    }
    return this.#networkFacet(value);
  }

  #isSelected(value: unknown): value is SelectedValue {
    return this.#hasRuntimeKind(value, 'selected');
  }

  #isConcreteNetworkSignal(value: unknown): value is SelectedValue {
    return this.#isSelected(value) && this.#selectedState(value).kind === 'concrete';
  }

  #networkSignalParameter(value: unknown, parameter: string, rawSpan: RawSpan): SelectedValue {
    if (!this.#isConcreteNetworkSignal(value)) {
      throw new ElaborationExecutionError(
        `NetworkSignal parameter ${parameter} requires a concrete single-Network Signal selection.`,
        this.#span(rawSpan),
        'RT2015',
      );
    }
    const state = this.#selectedState(value);
    const borrowed = this.#networkParameter(
      state.network,
      'readonly',
      parameter,
      undefined,
      rawSpan,
    );
    return this.#selectedValue(borrowed, state.selection);
  }

  #isPair(value: unknown): value is PairValue {
    return this.#hasRuntimeKind(value, 'pair');
  }

  #isPairSelection(value: unknown): value is PairSelectedValue {
    return this.#isSelected(value) && this.#selectedState(value).kind === 'pair';
  }

  #isWildcardToken(value: unknown): value is WildcardTokenValue {
    return this.#hasRuntimeKind(value, 'wildcard-token');
  }

  #isWildcardCount(value: unknown): value is WildcardCountValue {
    return this.#hasRuntimeKind(value, 'wildcard-count');
  }

  #isDestination(value: unknown): value is DestinationValue {
    return this.#hasRuntimeKind(value, 'destinations');
  }

  #select(value: unknown, signal: unknown, rawSpan: RawSpan): SelectedValue | DestinationValue {
    const concreteSignal =
      typeof signal === 'string'
        ? this.#signalHandle(parseSignalRef(signal))
        : this.#isSignal(signal)
          ? signal
          : undefined;
    const selection = concreteSignal ?? (this.#isWildcardToken(signal) ? signal.value : signal);
    const isWildcard =
      selection === 'each' || selection === 'anything' || selection === 'everything';
    if (concreteSignal === undefined && !isWildcard) {
      throw new Error('Network selection requires a Signal or wildcard.');
    }
    if (this.#isDestination(value)) {
      if (concreteSignal === undefined) {
        throw new Error('to(...)[SIGNAL] requires one concrete output Signal.');
      }
      if (value.signal !== undefined && !sameSignal(value.signal, concreteSignal)) {
        throw new Error('A to(...) destination already has a conflicting output Signal.');
      }
      return this.#runtimeValue({ ...value, signal: concreteSignal });
    }
    const readable = this.#rawNetworkFacet(value) ?? value;
    if (!this.#isNetwork(readable) && !this.#isPair(readable)) {
      throw new Error('Signal selection requires a Network or pair(a, b).');
    }
    this.#assertReadableValue(readable, rawSpan);
    return this.#selectedValue(readable, concreteSignal ?? (selection as WildcardName));
  }

  #selectedValue(
    value: NetworkValue | PairValue,
    selection: SignalHandle | WildcardName,
  ): SelectedValue {
    if (this.#isPair(value)) {
      const selected = { kind: 'selected' as const };
      return this.#runtimeValues.brandSelected(selected, {
        kind: 'pair',
        network: value.networks[0],
        networks: value.networks,
        selection,
      });
    }
    if (isSignalId(selection)) {
      const readonlyNetwork = this.#readonlyNetwork(value);
      const selected = {
        kind: 'selected' as const,
        signal: selection,
        network: readonlyNetwork,
      };
      return this.#runtimeValues.brandSelected(selected, {
        kind: 'concrete',
        network: value,
        selection,
        readonlyNetwork,
      });
    }
    const selected = { kind: 'selected' as const };
    return this.#runtimeValues.brandSelected(selected, {
      kind: 'wildcard',
      network: value,
      selection,
    });
  }

  #selectedState(value: SelectedValue): SelectedRuntimeState {
    const state = this.#runtimeValues.selectedState(value);
    if (state === undefined) throw new Error('Selected value is missing opaque runtime state.');
    return state;
  }

  #selectedSelection(value: SelectedValue): SignalHandle | WildcardName {
    return this.#selectedState(value).selection;
  }

  #selectedNetwork(value: SelectedValue): NetworkValue {
    return this.#selectedState(value).network;
  }

  #readonlyNetwork(value: NetworkValue): NetworkValue {
    const state = this.#networkState(value);
    return this.#runtimeValues.brandNetwork(
      {
        kind: 'network',
        name: value.name,
        declaration: value.declaration,
        capability: 'readonly',
        generation: value.generation,
      },
      state,
    );
  }

  #selectedMember(value: SelectedValue, key: unknown): unknown {
    const state = this.#selectedState(value);
    if (state.kind !== 'concrete') return undefined;
    if (key === 'signal') return value.signal;
    if (key === 'network') return value.network;
    return undefined;
  }

  #planNetworkRef(value: NetworkValue | PairValue | SelectedValue):
    | {
        readonly refKind: 'single';
        readonly network: string;
      }
    | {
        readonly refKind: 'pair';
        readonly networks: readonly [string, string];
      } {
    if (this.#isPair(value)) {
      return {
        refKind: 'pair',
        networks: [value.networks[0].name, value.networks[1].name],
      };
    }
    if (this.#isNetwork(value)) return { refKind: 'single', network: value.name };
    const state = this.#selectedState(value);
    return state.kind === 'concrete' || state.networks === undefined
      ? { refKind: 'single', network: state.network.name }
      : {
          refKind: 'pair',
          networks: [state.networks[0].name, state.networks[1].name],
        };
  }

  #readableNetworks(value: PairValue | SelectedValue): readonly NetworkValue[] {
    if (this.#isPair(value)) return value.networks;
    const state = this.#selectedState(value);
    return state.kind === 'concrete' || state.networks === undefined
      ? [state.network]
      : state.networks;
  }

  #arithmeticOperand(value: DslValue, rawSpan: RawSpan): PlanArithmeticOperand {
    if (typeof value === 'number') return { kind: 'constant', value: circuitConstant(value) };
    if (this.#isEntity(value)) {
      const network = this.#readableNetworkFacet(value, rawSpan);
      if (network === undefined) throw new Error('Entity read projection is unavailable.');
      this.#assertReadableNetwork(network, rawSpan);
      return { kind: 'each', refKind: 'single', network: network.name };
    }
    if (this.#isNetwork(value)) {
      this.#assertReadableNetwork(value, rawSpan);
      return { kind: 'each', refKind: 'single', network: value.name };
    }
    if (this.#isPair(value)) {
      this.#assertReadableValue(value, rawSpan);
      return { kind: 'each', ...this.#planNetworkRef(value) };
    }
    if (this.#isSelected(value)) {
      this.#assertReadableValue(value, rawSpan);
      const selection = this.#selectedSelection(value);
      if (isSignalId(selection)) {
        return { kind: 'signal', ...this.#planNetworkRef(value), signal: selection };
      }
      if (selection === 'each') return { kind: 'each', ...this.#planNetworkRef(value) };
      throw new Error('Anything/Everything cannot be arithmetic operands.');
    }
    if (this.#isCombinator(value)) {
      const network = this.#resolveNetworkFacet(value, rawSpan, 'arithmetic operand');
      if (network === undefined) {
        throw new Error('Circuit arithmetic currently requires a Network or numeric operand.');
      }
      this.#assertReadableNetwork(network, rawSpan);
      return { kind: 'each', refKind: 'single', network: network.name };
    }
    throw new Error('Circuit arithmetic currently requires a Network or numeric operand.');
  }

  #canonicalArithmeticOperand(value: PlanArithmeticOperand): PlanArithmeticOperand {
    return value.kind === 'signal'
      ? { ...value, signal: this.#signalSnapshot(value.signal) }
      : value;
  }

  #isCondition(value: unknown): value is ConditionValue {
    return this.#hasRuntimeKind(value, 'condition');
  }

  #runtimeValue<T extends RuntimeObjectValue>(value: T): T {
    return this.#runtimeValues.brand(value);
  }

  #hasRuntimeKind(value: unknown, kind: RuntimeObjectKind): boolean {
    return this.#runtimeValues.hasKind(value, kind);
  }

  #appendDecider(
    value: unknown,
    branch: 'then' | 'else',
    appended: readonly DeciderOutputCandidate[],
    rawSpan: RawSpan,
  ): CombinatorValue {
    return this.#withTopologyTransaction(rawSpan, () =>
      this.#appendDeciderMutation(value, branch, appended, rawSpan),
    );
  }

  #appendDeciderMutation(
    value: unknown,
    branch: 'then' | 'else',
    appended: readonly DeciderOutputCandidate[],
    rawSpan: RawSpan,
  ): CombinatorValue {
    if (!isRawSpan(rawSpan) || (branch !== 'then' && branch !== 'else')) {
      throw new Error('Invalid when(...).then/else mutation descriptor.');
    }
    if (!this.#isCombinator(value)) {
      throw new Error(`.${branch}(...) requires a DeciderCombinator.`);
    }
    const state = this.#combinators.stateFor(value);
    if (state.descriptor.kind !== 'decider') {
      throw new ElaborationExecutionError(
        `.${branch}(...) requires a DeciderCombinator.`,
        this.#span(rawSpan),
        'RT2022',
        [{ message: 'Physical combinator was created here.', span: state.descriptor.source }],
      );
    }
    if (appended.length === 0) {
      throw new Error(`.${branch}(output, ...) requires at least one output specification.`);
    }
    const thenRows = this.#deciderRowsForDescriptor(state.descriptor, 'normal');
    const elseRows = this.#deciderRowsForDescriptor(state.descriptor, 'else');
    const nextThen = branch === 'then' ? [...thenRows, ...appended] : thenRows;
    const nextElse = branch === 'else' ? [...elseRows, ...appended] : elseRows;
    const normal = this.#deciderRowsWithOrigins(nextThen, 'normal');
    const alternate = this.#deciderRowsWithOrigins(nextElse, 'else');
    const descriptor: CombinatorDescriptor = {
      ...state.descriptor,
      output: normal.outputs[0] ?? alternate.outputs[0]!,
      outputs: normal.outputs,
      outputOrigins: normal.origins,
      ...(alternate.outputs.length === 0
        ? {}
        : { elseOutputs: alternate.outputs, elseOutputOrigins: alternate.origins }),
    };
    this.#combinators.update(value, descriptor, this.#span(rawSpan));
    this.#colors.registerCombinatorInputs(
      value.identity,
      this.#combinators.stateFor(value).descriptor,
      this.#span(rawSpan),
    );
    this.#linkDeciderCombinator(
      value,
      this.#combinators.stateFor(value).descriptor as Extract<
        CombinatorDescriptor,
        { kind: 'decider' }
      >,
      rawSpan,
    );
    return value;
  }

  #appendDeciderArguments(
    value: unknown,
    branch: 'then' | 'else',
    outputs: readonly CallArgument[],
    rawSpan: RawSpan,
  ): CombinatorValue {
    if (
      !Array.isArray(outputs) ||
      outputs.some(
        (output) =>
          typeof output !== 'object' ||
          output === null ||
          !isRawSpan((output as CallArgument).source),
      )
    ) {
      throw new Error('Invalid when(...).then/else argument descriptors.');
    }
    return this.#appendDecider(
      value,
      branch,
      outputs.flatMap((output) => this.#deciderOutputs(output.value, rawSpan, output.source)),
      rawSpan,
    );
  }

  #deciderRowsForDescriptor(
    descriptor: Extract<CombinatorDescriptor, { kind: 'decider' }>,
    branch: 'normal' | 'else',
  ): readonly DeciderOutputCandidate[] {
    const outputs =
      branch === 'normal'
        ? (descriptor.outputs ??
          (descriptor.output === undefined || descriptor.elseOutputs !== undefined
            ? []
            : [descriptor.output]))
        : (descriptor.elseOutputs ?? []);
    if (outputs.length === 0) return [];
    const origins = branch === 'normal' ? descriptor.outputOrigins : descriptor.elseOutputOrigins;
    if (origins === undefined || origins.length !== outputs.length) {
      throw new Error('Decider output rows are missing aligned origins.');
    }
    return outputs.map((output, ordinal) => {
      const origin = origins[ordinal]!;
      return {
        output,
        source: origin.source,
        instancePath: origin.instancePath,
        syntaxIntent: origin.syntaxIntent,
      };
    });
  }

  #deciderRowsWithOrigins(
    rows: readonly DeciderOutputCandidate[],
    branch: 'normal' | 'else',
  ): {
    readonly outputs: readonly PlanDeciderOutput[];
    readonly origins: readonly DeciderOutputOrigin[];
  } {
    return {
      outputs: Object.freeze(rows.map(({ output }) => output)),
      origins: Object.freeze(
        rows.map((row, ordinal) =>
          Object.freeze({
            branch,
            ordinal,
            source: Object.freeze({ ...row.source }),
            instancePath: Object.freeze([...row.instancePath]),
            syntaxIntent: row.syntaxIntent,
          }),
        ),
      ),
    };
  }

  #deciderOutputCandidate(
    output: unknown,
    source: RawSpan,
    instancePath: readonly string[] = this.#path(),
  ): DeciderOutputCandidate {
    return {
      output: this.#deciderOutput(output, source),
      source: this.#span(source),
      instancePath,
      syntaxIntent: this.#deciderOutputSyntaxIntent(output),
    };
  }

  #deciderOutputSyntaxIntent(output: unknown): DeciderOutputSyntaxIntent {
    if (this.#isSignalValue(output) || this.#isWildcardCount(output)) return 'explicit-constant';
    if (this.#isSelected(output)) {
      const selection = this.#selectedSelection(output);
      return isSignalId(selection)
        ? 'implicit-concrete-copy'
        : selection === 'each'
          ? 'implicit-each-copy'
          : 'explicit-wildcard-copy';
    }
    if (this.#isPair(output) || this.#rawNetworkFacet(output) !== undefined) {
      return 'implicit-each-copy';
    }
    throw new Error('Unsupported decider output specification.');
  }

  #deciderOutput(
    output: unknown,
    rawSpan: RawSpan,
  ): Extract<DirectPlanProducer, { kind: 'decider' }>['output'] {
    if (this.#isSignalValue(output)) {
      return { kind: 'signal-constant', signal: output.signal, value: output.value };
    }
    if (this.#isWildcardCount(output)) {
      if (output.wildcard !== 'each') {
        throw new Error('Only EACH supports a constant-count decider output.');
      }
      return { kind: 'each-constant', value: output.value };
    }
    if (this.#isSelected(output)) {
      this.#assertReadableValue(output, rawSpan);
      const selection = this.#selectedSelection(output);
      return isSignalId(selection)
        ? { kind: 'signal', ...this.#planNetworkRef(output), signal: selection }
        : selection === 'each'
          ? { kind: 'each', ...this.#planNetworkRef(output) }
          : {
              kind: 'wildcard',
              ...this.#planNetworkRef(output),
              wildcard: selection,
            };
    }
    if (this.#isPair(output)) {
      this.#assertReadableValue(output, rawSpan);
      return { kind: 'each', ...this.#planNetworkRef(output) };
    }
    const network = this.#rawNetworkFacet(output);
    if (network !== undefined) {
      this.#assertReadableNetwork(network, rawSpan);
      return { kind: 'each', refKind: 'single', network: network.name };
    }
    throw new Error('Unsupported decider output specification.');
  }

  #deciderOutputs(
    value: unknown,
    rawSpan: RawSpan,
    source: RawSpan = rawSpan,
    instancePath: readonly string[] = this.#path(),
  ): readonly DeciderOutputCandidate[] {
    const visit = (candidate: unknown, seen: Set<object>): readonly DeciderOutputCandidate[] => {
      if (candidate === undefined) return [];
      if (
        this.#isSignalValue(candidate) ||
        this.#isWildcardCount(candidate) ||
        this.#isSelected(candidate) ||
        this.#isPair(candidate) ||
        this.#rawNetworkFacet(candidate) !== undefined
      ) {
        return [this.#deciderOutputCandidate(candidate, source, instancePath)];
      }
      if (typeof candidate !== 'object' || candidate === null) {
        return [this.#deciderOutputCandidate(candidate, source, instancePath)];
      }
      if (seen.has(candidate)) throw new Error('IF/when output containers cannot be cyclic.');
      seen.add(candidate);
      try {
        if (Array.isArray(candidate)) {
          return candidate.flatMap((item) => visit(item, seen));
        }
        const prototype = Object.getPrototypeOf(candidate);
        if (prototype === Object.prototype || prototype === null) {
          return Object.values(candidate).flatMap((item) => visit(item, seen));
        }
        return [this.#deciderOutputCandidate(candidate, source, instancePath)];
      } finally {
        seen.delete(candidate);
      }
    };
    return visit(value, new Set());
  }

  #isCircuitDslValue(value: unknown): value is DslValue {
    return (
      this.#isEntity(value) ||
      this.#isSignal(value) ||
      this.#isNetwork(value) ||
      this.#isPair(value) ||
      this.#isSelected(value) ||
      this.#isDestination(value) ||
      this.#isSignalValue(value) ||
      this.#isWildcardToken(value) ||
      this.#isWildcardCount(value) ||
      this.#isCondition(value) ||
      this.#isCombinator(value)
    );
  }

  #assertReadableValue(value: unknown, rawSpan: RawSpan): void {
    const network = this.#readableNetworkFacet(value, rawSpan);
    if (network !== undefined && !this.#isSelected(value)) {
      this.#assertReadableNetwork(network, rawSpan);
    }
    if (this.#isPair(value)) {
      for (const network of value.networks) this.#assertReadableNetwork(network, rawSpan);
    }
    if (this.#isSelected(value)) {
      for (const network of this.#readableNetworks(value))
        this.#assertReadableNetwork(network, rawSpan);
    }
    if (this.#isDestination(value)) {
      for (const network of value.networks) this.#assertReadableNetwork(network, rawSpan);
    }
  }

  #assertWritableValue(value: unknown, rawSpan: RawSpan): void {
    if (this.#isPair(value) || this.#isPairSelection(value)) {
      throw new ElaborationExecutionError(
        'pair(a, b) is a read-only input view and cannot receive producer attachments.',
        this.#span(rawSpan),
        'RT2020',
      );
    }
    if (this.#isDestination(value)) {
      for (const network of value.networks) this.#assertWritableNetwork(network, rawSpan);
      return;
    }
    const network = this.#resolveNetworkFacet(value, rawSpan);
    if (network !== undefined) this.#assertWritableNetwork(network, rawSpan);
  }

  #resolveNetworkFacet(
    value: unknown,
    _rawSpan: RawSpan,
    _role = 'Network',
  ): NetworkValue | undefined {
    if (this.#isPair(value) || this.#isPairSelection(value)) return undefined;
    if (this.#isSelected(value)) return this.#selectedNetwork(value);
    return this.#rawNetworkFacet(value);
  }

  #resolveWritableNetwork(
    value: unknown,
    rawSpan: RawSpan,
    role = 'Network',
  ): NetworkValue | undefined {
    if (this.#isPair(value) || this.#isPairSelection(value)) {
      throw new ElaborationExecutionError(
        'pair(a, b) is a read-only input view and cannot receive producer attachments.',
        this.#span(rawSpan),
        'RT2020',
      );
    }
    const network = this.#resolveNetworkFacet(value, rawSpan, role);
    if (network !== undefined) this.#assertWritableNetwork(network, rawSpan, role);
    return network;
  }

  #recordDslCall(): void {
    const frame = this.#executionApiFrames.at(-1);
    if (frame !== undefined) frame.dslDomain = true;
    if (this.#status === 'failed') throw this.#firstFailure;
    if (this.#status === 'sealed') {
      throw new Error(
        'The elaboration runtime is sealed; delayed asynchronous DSL calls cannot mutate a completed plan.',
      );
    }
    this.#dslCalls += 1;
    if (this.#dslCalls > this.#dslCallBudget) {
      throw new ElaborationOperationLimitError(this.#dslCallBudget);
    }
  }
}

/** Must be invoked only inside a disposable, time-bounded worker for untrusted source. */
function executeElaborationProgramInternal(
  program: ElaborationJavaScript,
  options: ElaborationExecutionOptions = {},
):
  | DirectElaborationPlan
  | DirectElaborationPlanV3
  | DirectElaborationPlanV4
  | DirectElaborationPlanV5
  | DirectElaborationPlanV6 {
  if (program.format !== 'comblang-elaboration-js' || program.version !== 2) {
    throw new Error('Unsupported elaboration JavaScript format.');
  }
  if (!/^[$A-Z_a-z][$0-9A-Z_a-z]*$/.test(program.runtimeParameter)) {
    throw new Error('Invalid elaboration runtime parameter.');
  }
  if (program.containsUnsupportedAsync) {
    throw new Error('Asynchronous syntax is not supported by synchronous elaboration.');
  }
  const dslCallBudget = options.dslCallBudget ?? options.operationBudget ?? 100_000;
  if (!Number.isSafeInteger(dslCallBudget) || dslCallBudget <= 0) {
    throw new Error('Elaboration DSL call budget must be a positive safe integer.');
  }
  const recorder = new ElaborationRecorder(
    program.fileId,
    dslCallBudget,
    options.prototypes,
    options.trustedEntityReplayContext,
    options.entityPrototypeResolver ??
      (options.prototypes === undefined
        ? undefined
        : entityPrototypeResolverFromProvider(options.prototypes)),
  );
  try {
    Function(program.runtimeParameter, `"use strict";\n${program.code}`)(recorder.executionApi());
  } catch (error) {
    recorder.closeAfterExecution();
    throw error;
  }
  return recorder.plan();
}

/** Executes the legacy source path and preserves its producer-only v2 contract. */
export function executeElaborationProgram(
  program: ElaborationJavaScript,
  options: ElaborationExecutionOptions = {},
): DirectElaborationPlan {
  const {
    trustedEntityReplayContext: _context,
    entityPrototypeResolver: _resolver,
    ...legacy
  } = options;
  return executeElaborationProgramInternal(program, legacy) as DirectElaborationPlan;
}

/** Internal host/test boundary for execution sessions that may construct Entity records. */
export function executeElaborationProgramV3(
  program: ElaborationJavaScript,
  options: ElaborationExecutionOptions & {
    readonly trustedEntityReplayContext: TrustedEntityReplayContext;
    readonly entityPrototypeResolver?: EntityPrototypeResolver;
  },
):
  | DirectElaborationPlan
  | DirectElaborationPlanV3
  | DirectElaborationPlanV4
  | DirectElaborationPlanV5
  | DirectElaborationPlanV6 {
  return executeElaborationProgramInternal(program, options);
}

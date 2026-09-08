import {
  circuitConstant,
  encodeSignalPropertyKey,
  sameSignal,
  Signal,
  type SignalId,
} from '@comblang/factorio';
import type {
  DirectElaborationPlanV3,
  ElaborationJavaScript,
  EntityConfiguration,
  EntityConnectorBindingProvenance,
  EntityConnectorProfile,
  EntityLaneEndpoint,
  EntityProfile,
  EntityProfileRef,
} from '@comblang/compiler';
import type { DslParameterContract } from '@comblang/language';
import type {
  DirectElaborationPlan,
  DirectPlanDebugValue,
  DirectPlanProducer,
  PlanEntityPlacement,
  PlanArithmeticOperand,
  PlanDeciderCondition,
} from '@comblang/compiler/direct-plan-schema';
import type { PrototypeProvider } from '@comblang/prototypes';
import type { Diagnostic, NetworkId, SourceFileId, SourceSpan } from '@comblang/shared';

import { ElaborationExecutionError, ElaborationOperationLimitError } from './elaboration-errors.js';
import { ElaborationColorConstraints } from './elaboration-color-constraints.js';
import { ElaborationProvenanceFormatter } from './elaboration-provenance.js';
import { CombinatorRegistry } from './combinator-registry.js';
import { normalizeSignalValueSources } from './constant-signal-values.js';
import {
  RuntimeValueRegistry,
  type CombinatorDescriptor,
  type CombinatorValue,
  type ConditionValue,
  type DestinationValue,
  type DslValue,
  type FunctionOwnershipFrame,
  type NetworkOwnershipState,
  type NetworkRuntimeState,
  type NetworkValue,
  type PairSelectedValue,
  type PairValue,
  type RuntimeObjectKind,
  type RuntimeObjectValue,
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
  type EntityValue,
  type EntityPrototypeResolver,
} from './entity-registry.js';
import {
  entityReplayContextRef,
  resolveEntityReplayProfile,
  type TrustedEntityReplayContext,
} from '@comblang/compiler/entity-replay-context';
import type { EntityPlacement } from '@comblang/compiler/ir';

interface RawSpan {
  readonly start: number;
  readonly end: number;
}

interface CallArgument {
  readonly value: unknown;
  readonly source: RawSpan;
}

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
  readonly #debugInstances: NonNullable<DirectElaborationPlan['debugInstances']>[number][] = [];
  readonly #diagnostics: Diagnostic[] = [];
  readonly #implicitBorrowWarnings = new Set<string>();
  readonly #combinators = new CombinatorRegistry();
  readonly #combinatorByOutput = new Map<NetworkOwnershipState, CombinatorValue>();
  readonly #runtimeValues = new RuntimeValueRegistry();
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
  readonly #entityRegistry: EntityRegistry | undefined;
  readonly #entityAuthorities = new WeakMap<object, EntityAuthorityView>();
  readonly #entityAuthorityList: EntityAuthorityView[] = [];
  #entityRevision = 0;
  #entityOperationOrdinal = 0;
  #dslCalls = 0;
  readonly #operatorContext: ElaborationOperatorDispatchContext<RawSpan> = {
    isCircuitDslValue: (value): value is DslValue => this.#isCircuitDslValue(value),
    isSignal: (value): value is SignalId => this.#isSignal(value),
    isSignalId,
    isSelected: (value): value is SelectedValue => this.#isSelected(value),
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
        const operations: Record<string, ((...values: unknown[]) => unknown) | undefined> = {
          to: (...values) => this.api.attachTo(receiver, ...values, rawSpan),
          take: (...values) => this.api.take(receiver, ...values, rawSpan),
          at: (...values) => this.api.place(receiver, ...values, rawSpan),
          as: (...values) => this.api.bindOutput(receiver, values[0] as SignalId, rawSpan),
          then: (...values) => this.api.appendDecider(receiver, 'then', values, rawSpan),
          else: (...values) => this.api.appendDecider(receiver, 'else', values, rawSpan),
        };
        const operation =
          typeof property === 'string' && Object.hasOwn(operations, property)
            ? operations[property]
            : undefined;
        if (operation !== undefined) return { callable: operation, receiver };
        return { callable: this.api.element(receiver, property, rawSpan), receiver };
      }
      return { callable: this.api.element(receiver, key, rawSpan), receiver };
    },
    invokePrepared: (
      prepared: PreparedInvocation,
      args: readonly CallArgument[],
      rawSpan: RawSpan,
    ): unknown => this.#invoke(prepared.callable, prepared.receiver, args, rawSpan),
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
      this.#recordDslCall();
      const rawSpan = args.at(-1);
      if (!isRawSpan(rawSpan)) throw new Error('Constant combinator is missing provenance.');
      const outputs = normalizeSignalValueSources(args.slice(0, -1), {
        isSignal: (value): value is SignalHandle => this.#isSignal(value),
        isSignalValue: (value): value is SignalValue => this.#isSignalValue(value),
      });
      return this.#createCombinator(
        {
          kind: 'constant',
          outputs: outputs.map(({ signal, value }) => ({ signal, value })),
          source: this.#span(rawSpan),
          instancePath: this.#path(),
        },
        rawSpan,
      );
    },
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
          isNetwork: (candidate): candidate is NetworkValue => this.#isNetwork(candidate),
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
          isCombinator: (candidate): candidate is CombinatorValue => this.#isCombinator(candidate),
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
    bindArray: (
      value: unknown,
      descriptors: readonly (BindingDescriptor | null)[],
      rawSpan: RawSpan,
    ): unknown => {
      if (!Array.isArray(descriptors)) throw new Error('Invalid array binding descriptors.');
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
      this.#recordDslCall();
      const rawSpan = args.at(-1);
      const condition = args[0];
      const outputValues = args.slice(1, -1);
      if (!isRawSpan(rawSpan)) throw new Error('IF/when is missing provenance.');
      if (!this.#isCondition(condition)) throw new Error('IF/when requires a circuit condition.');
      if (outputValues.length === 0) {
        throw new Error('IF/when requires at least one output specification.');
      }
      const outputs = outputValues.map((output) => this.#deciderOutput(output, rawSpan));
      return this.#createCombinator(
        {
          kind: 'decider',
          condition: condition.condition,
          output: outputs[0]!,
          ...(outputs.length === 1 ? {} : { outputs }),
          source: this.#span(rawSpan),
          instancePath: this.#path(),
        },
        rawSpan,
      );
    },
    deciderStart: (condition: unknown, rawSpan: RawSpan): CombinatorValue => {
      this.#recordDslCall();
      if (!isRawSpan(rawSpan)) throw new Error('when(...) is missing provenance.');
      if (!this.#isCondition(condition)) throw new Error('when(...) requires a circuit condition.');
      return this.#createCombinator(
        {
          kind: 'decider',
          condition: condition.condition,
          source: this.#span(rawSpan),
          instancePath: this.#path(),
        },
        rawSpan,
      );
    },
    appendDecider: (
      value: unknown,
      branch: 'then' | 'else',
      outputs: readonly unknown[],
      rawSpan: RawSpan,
    ): CombinatorValue => {
      this.#recordDslCall();
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
      const appended = outputs.flatMap((output) => this.#deciderOutputs(output, rawSpan));
      if (appended.length === 0) {
        throw new Error(`.${branch}(output, ...) requires at least one output specification.`);
      }
      const thenOutputs =
        state.descriptor.outputs ??
        (state.descriptor.output === undefined || state.descriptor.elseOutputs !== undefined
          ? []
          : [state.descriptor.output]);
      const elseOutputs = state.descriptor.elseOutputs ?? [];
      const nextThen = branch === 'then' ? [...thenOutputs, ...appended] : thenOutputs;
      const nextElse = branch === 'else' ? [...elseOutputs, ...appended] : elseOutputs;
      const descriptor: CombinatorDescriptor = {
        ...state.descriptor,
        output: nextThen[0] ?? nextElse[0]!,
        outputs: nextThen,
        ...(nextElse.length === 0 ? {} : { elseOutputs: nextElse }),
      };
      this.#combinators.update(value, descriptor, this.#span(rawSpan));
      this.#colors.registerCombinatorInputs(
        value.identity,
        this.#combinators.stateFor(value).descriptor,
        this.#span(rawSpan),
      );
      return value;
    },
    deciderBranches: (
      condition: unknown,
      thenValue: unknown,
      elseValue: unknown,
      rawSpan: RawSpan,
    ): CombinatorValue => {
      this.#recordDslCall();
      if (!isRawSpan(rawSpan)) throw new Error('IF/when is missing provenance.');
      if (!this.#isCondition(condition)) throw new Error('IF/when requires a circuit condition.');
      const thenOutputs = this.#deciderOutputs(thenValue, rawSpan);
      const elseOutputs = this.#deciderOutputs(elseValue, rawSpan);
      if (thenOutputs.length === 0 && elseOutputs.length === 0) {
        throw new Error('IF/when requires at least one output specification.');
      }
      return this.#createCombinator(
        {
          kind: 'decider',
          condition: condition.condition,
          output: thenOutputs[0] ?? elseOutputs[0]!,
          outputs: thenOutputs,
          ...(elseOutputs.length === 0 ? {} : { elseOutputs }),
          source: this.#span(rawSpan),
          instancePath: this.#path(),
        },
        rawSpan,
      );
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
      this.#recordDslCall();
      const rawSpan = args.at(-1);
      if (!isRawSpan(rawSpan)) throw new Error('to(...) is missing provenance.');
      const values = args.slice(0, -1);
      if (values.some((value) => this.#isPair(value) || this.#isPairSelection(value))) {
        throw new ElaborationExecutionError(
          'pair(a, b) is a read-only input view and cannot be a to(...) destination.',
          this.#span(rawSpan),
          'RT2020',
        );
      }
      const selected = values.length === 1 && this.#isSelected(values[0]) ? values[0] : undefined;
      const selectedSignal =
        selected === undefined || !isSignalId(selected.selection) ? undefined : selected.selection;
      if (values.some((value) => this.#isSelected(value)) && selectedSignal === undefined) {
        throw new Error(
          '.to(...) permits Network[SIGNAL] only for one destination; use .to(first, second, SIGNAL) for fan-out.',
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
        throw new Error('to(...) destinations must be Networks.');
      }
      return this.#runtimeValue({
        kind: 'destinations',
        networks,
        ...(selectedSignal === undefined ? {} : { signal: selectedSignal }),
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
      this.#recordDslCall();
      let outputSignal = this.#isSignal(values.at(-1)) ? (values.pop() as SignalHandle) : undefined;
      let destinations: readonly NetworkValue[];
      if (values.length === 1 && this.#isSelected(values[0])) {
        const selected = values[0];
        if (this.#isPairSelection(selected)) {
          throw new ElaborationExecutionError(
            'pair(a, b) is a read-only input view and cannot be a .to(...) destination.',
            this.#span(rawSpan),
            'RT2020',
          );
        }
        if (outputSignal !== undefined || !isSignalId(selected.selection)) {
          throw new Error('A selected .to(...) destination must bind exactly one concrete Signal.');
        }
        outputSignal = selected.selection;
        const destination = this.#resolveWritableNetwork(selected, rawSpan, 'destination');
        if (destination === undefined) throw new Error('.to(...) destination must be a Network.');
        destinations = [destination];
      } else {
        if (values.some((value) => this.#isPair(value))) {
          throw new ElaborationExecutionError(
            'pair(a, b) is a read-only input view and cannot be a .to(...) destination.',
            this.#span(rawSpan),
            'RT2020',
          );
        }
        if (values.some((value) => this.#isSelected(value))) {
          throw new Error(
            '.to(...) permits Network[SIGNAL] only for one destination; use .to(first, second, SIGNAL) for fan-out.',
          );
        }
        const resolved = values.map((value) =>
          this.#resolveWritableNetwork(value, rawSpan, 'destination'),
        );
        if (!resolved.every((value): value is NetworkValue => value !== undefined)) {
          throw new Error(
            '.to(...) permits Network[SIGNAL] only for one destination; use .to(first, second, SIGNAL) for fan-out.',
          );
        }
        destinations = resolved;
      }
      return this.#attachMany(destinations, producer, rawSpan, outputSignal);
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
      if (destination) this.#assertWritableValue(left, rawSpan);
      if (destination && this.#isCombinator(right)) {
        this.api.attach(
          left as NetworkValue | CombinatorValue | PairValue | SelectedValue | DestinationValue,
          right,
          rawSpan,
        );
        return left;
      }
      if (destination) {
        throw new Error(
          'Network += requires a combinator producer; constants and Networks are not implicit attachments.',
        );
      }
      if (this.#isCombinator(right)) {
        throw new Error('A combinator producer can only be attached to a Network destination.');
      }
      // The casts affect only TypeScript's checker; emitted JavaScript retains its native `+`
      // coercion rules for non-DSL values.
      const result = (left as number) + (right as number);
      assign(result);
      return result;
    },
    attach: (
      destination: NetworkValue | CombinatorValue | PairValue | SelectedValue | DestinationValue,
      producer: CombinatorValue,
      rawSpan: RawSpan,
    ): void => {
      this.#recordDslCall();
      if (this.#isPair(destination) || this.#isPairSelection(destination)) {
        throw new ElaborationExecutionError(
          'pair(a, b) is a read-only input view and cannot receive a producer attachment.',
          this.#span(rawSpan),
          'RT2020',
        );
      }
      const destinations = this.#isDestination(destination)
        ? destination.networks
        : [this.#resolveWritableNetwork(destination, rawSpan, 'destination')!];
      this.#attachMany(
        destinations,
        producer,
        rawSpan,
        this.#isDestination(destination)
          ? destination.signal
          : this.#isSelected(destination)
            ? isSignalId(destination.selection)
              ? destination.selection
              : (() => {
                  throw new Error('A destination can bind only a concrete Signal.');
                })()
            : undefined,
      );
    },
  });

  plan(): DirectElaborationPlan | DirectElaborationPlanV3 {
    if (this.#status === 'failed') throw this.#firstFailure;
    if (this.#status === 'sealed') {
      throw new Error('The elaboration runtime has already been sealed.');
    }
    try {
      this.#finalizeUnusedCombinators();
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
        debugInstances: Object.freeze([...this.#debugInstances]),
        producers: Object.freeze(
          this.#combinators.states().map((state) => this.#combinators.toPlan(state)),
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
      const plan: DirectElaborationPlan | DirectElaborationPlanV3 =
        entities.length === 0
          ? { ...common, version: 2 as const }
          : {
              ...common,
              version: 3 as const,
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
              entities: Object.freeze([...entities]),
            };
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
          const domainFailure =
            frame.dslDomain ||
            error instanceof ElaborationOperationLimitError ||
            error instanceof ElaborationExecutionError;
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

  #debugValue(value: unknown, rawSpan: RawSpan, seen: Set<object>): DirectPlanDebugValue {
    if (this.#isNetwork(value)) {
      this.#assertReadableNetwork(value, rawSpan);
      return { kind: 'network', network: value.name };
    }
    if (this.#isCombinator(value)) {
      const { captureId } = this.#combinators.capture(value);
      return { kind: 'producer', captureId };
    }
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
    return value;
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
    const available = (): NetworkValue[] => {
      const state = this.#combinators.stateFor(value);
      return [state.outputPort.primary.network, state.outputPort.secondary?.network].filter(
        (network): network is NetworkValue =>
          network !== undefined && this.#networkState(network).ownership.consumedAt === undefined,
      );
    };
    let lanes = available();
    if (lanes.length < count && this.#combinators.secondary(value) === undefined) {
      this.#ensureSecondaryOutput(value, rawSpan);
      lanes = available();
    }
    if (lanes.length < count) {
      const state = this.#combinators.stateFor(value);
      throw new ElaborationExecutionError(
        'This combinator output connector already uses both logical Networks.',
        this.#span(rawSpan),
        'RT2028',
        [{ message: 'Physical combinator was created here.', span: state.descriptor.source }],
      );
    }
    return lanes.slice(0, count);
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

  #attach(network: NetworkValue, value: CombinatorValue, rawSpan: RawSpan): void {
    this.#attachMany([network], value, rawSpan);
  }

  #attachMany(
    networks: readonly NetworkValue[],
    value: CombinatorValue,
    rawSpan: RawSpan,
    outputSignal?: SignalId,
  ): CombinatorValue {
    if (!networks.every((network) => this.#isNetwork(network)) || !this.#isCombinator(value)) {
      throw new Error('Attachment requires a Network and combinator.');
    }
    const source = this.#span(rawSpan);
    validateCombinatorAttachment(networks, source, {
      assertWritable: (network) => this.#assertWritableNetwork(network, rawSpan, 'destination'),
    });
    const state = this.#combinators.stateFor(value);
    if (outputSignal !== undefined) this.#combinators.bindOutput(value, outputSignal, source);
    const lanes = this.#takeOutputLanes(value, networks.length, rawSpan);
    for (const [index, network] of networks.entries()) {
      this.#transferNetwork(network, lanes[index]!, rawSpan, 'combinator output', 'connector');
    }
    this.#combinators.markOutputUsed(value);
    return value;
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
    const bound = bindNetworkParameter(
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
    const propertyKey = encodeSignalPropertyKey(value);
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

  #constructEntity(
    profile: unknown,
    configuration: unknown,
    placement: unknown,
    rawSpan: RawSpan,
  ): EntityValue {
    this.#recordDslCall();
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
      const entity = registry.create({
        profile: profile as EntityProfileRef,
        ...(configuration === undefined
          ? {}
          : { configuration: configuration as EntityConfiguration }),
        ...(placement === undefined ? {} : { placement: placement as EntityPlacement }),
        source: this.#span(rawSpan),
        instancePath: this.#path(),
        expansionStack: [],
        creationRevision: ++this.#entityRevision,
      });
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

  #isEntity(value: unknown): value is EntityValue {
    return this.#entityRegistry?.isEntity(value) === true;
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

  #isPair(value: unknown): value is PairValue {
    return this.#hasRuntimeKind(value, 'pair');
  }

  #isPairSelection(value: unknown): value is PairSelectedValue {
    return this.#isSelected(value) && value.networks !== undefined;
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
        ? Signal('item', signal)
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
    selection: SignalId | WildcardName,
  ): SelectedValue {
    return this.#isPair(value)
      ? this.#runtimeValue({
          kind: 'selected',
          network: value.networks[0],
          networks: value.networks,
          selection,
        })
      : this.#runtimeValue({ kind: 'selected', network: value, selection });
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
    return value.networks === undefined
      ? { refKind: 'single', network: value.network.name }
      : {
          refKind: 'pair',
          networks: [value.networks[0].name, value.networks[1].name],
        };
  }

  #readableNetworks(value: PairValue | SelectedValue): readonly NetworkValue[] {
    return this.#isPair(value) ? value.networks : (value.networks ?? [value.network]);
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
      if (isSignalId(value.selection)) {
        return { kind: 'signal', ...this.#planNetworkRef(value), signal: value.selection };
      }
      if (value.selection === 'each') return { kind: 'each', ...this.#planNetworkRef(value) };
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

  #isCondition(value: unknown): value is ConditionValue {
    return this.#hasRuntimeKind(value, 'condition');
  }

  #runtimeValue<T extends RuntimeObjectValue>(value: T): T {
    return this.#runtimeValues.brand(value);
  }

  #hasRuntimeKind(value: unknown, kind: RuntimeObjectKind): boolean {
    return this.#runtimeValues.hasKind(value, kind);
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
      return isSignalId(output.selection)
        ? { kind: 'signal', ...this.#planNetworkRef(output), signal: output.selection }
        : output.selection === 'each'
          ? { kind: 'each', ...this.#planNetworkRef(output) }
          : {
              kind: 'wildcard',
              ...this.#planNetworkRef(output),
              wildcard: output.selection,
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
    seen: Set<object> = new Set(),
  ): readonly Extract<DirectPlanProducer, { kind: 'decider' }>['output'][] {
    if (value === undefined) return [];
    if (
      this.#isSignalValue(value) ||
      this.#isWildcardCount(value) ||
      this.#isSelected(value) ||
      this.#isPair(value) ||
      this.#rawNetworkFacet(value) !== undefined
    ) {
      return [this.#deciderOutput(value, rawSpan)];
    }
    if (typeof value !== 'object' || value === null) {
      return [this.#deciderOutput(value, rawSpan)];
    }
    if (seen.has(value)) throw new Error('IF/when output containers cannot be cyclic.');
    seen.add(value);
    try {
      if (Array.isArray(value)) {
        return value.flatMap((item) => this.#deciderOutputs(item, rawSpan, seen));
      }
      const prototype = Object.getPrototypeOf(value);
      if (prototype === Object.prototype || prototype === null) {
        return Object.values(value).flatMap((item) => this.#deciderOutputs(item, rawSpan, seen));
      }
      return [this.#deciderOutput(value, rawSpan)];
    } finally {
      seen.delete(value);
    }
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
    if (this.#isSelected(value)) return value.network;
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
): DirectElaborationPlan | DirectElaborationPlanV3 {
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
): DirectElaborationPlan | DirectElaborationPlanV3 {
  return executeElaborationProgramInternal(program, options);
}

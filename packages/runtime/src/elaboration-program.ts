import {
  circuitConstant,
  canonicalizeConstantConfiguration,
  constantConfigurationFromOutputs,
  formatSignalRef,
  parseSignalRef,
  sameSignal,
  Signal,
  type ConstantConfiguration,
  type SignalId,
} from '@comblang/factorio';
import type {
  ElaborationJavaScript,
  EntityBehaviorKey,
  EntityArithmeticConfiguration,
  EntityConstantConfiguration,
  EntityConfiguration,
  EntityConnectorBindingProvenance,
  EntityConnectorProfile,
  EntityDeciderConfiguration,
  EntityLaneEndpoint,
  EntityLaneKey,
  EntityNativeComparator,
  EntityNativeSingleCondition,
  EntityPlanDebugInstance,
  EntityPlanDebugValue,
  EntityPlanSharedConnectorAttachment,
  EntityProfile,
  EntityProfileRef,
  EntitySelectorConfiguration,
} from '@comblang/compiler';
import { entityFamilyDslNames, type DslParameterContract } from '@comblang/language';
import type {
  DirectElaborationPlan,
  DirectPlanArithmetic,
  DirectPlanDebugInstance,
  DirectPlanDebugValue,
  DirectPlanProducer,
  DirectPlanSelector,
  PlanEntityPlacement,
  PlanNetworkRef,
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
import {
  diagnosticRuleRegistry,
  type Diagnostic,
  type NetworkId,
  type SourceFileId,
  type SourceSpan,
} from '@comblang/shared';

import {
  ElaborationExecutionError,
  ElaborationOperationLimitError,
  RecoverableElaborationExecutionError,
} from './elaboration-errors.js';
import { ElaborationColorConstraints } from './elaboration-color-constraints.js';
import { ElaborationProvenanceFormatter } from './elaboration-provenance.js';
import { CombinatorRegistry, type CombinatorRegistrySnapshot } from './combinator-registry.js';
import { normalizeSignalValueSources, SignalValueSourceError } from './constant-signal-values.js';
import {
  ConstantConfigurationSourceError,
  normalizeConstantConfigurationSourceWithParameters,
  prepareConstantConfigurationSource,
  type ConstantConfigurationSourceContext,
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
  type PendingArithmeticOperand,
  type PendingDeciderCondition,
  type PendingDeciderOutput,
  type ParameterDeciderOutputSelection,
  type ParameterSignalValue,
  type RuntimeDeciderCondition,
  type RuntimeObjectKind,
  type RuntimeObjectValue,
  type SelectedRuntimeState,
  type SelectedValue,
  type SectionValue,
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
import type {
  EntityPlacement,
  LogicalDeciderCondition,
  LogicalDeciderOutput,
  LogicalNetworkRef,
  SelectorProducerConfig,
} from '@comblang/compiler/ir';
import type { ArithmeticOperation } from '@comblang/compiler/ir';
import {
  BlueprintEntitySignalConversionError,
  detachBlueprintEntitySignalHandles,
} from './entity-blueprint-fragment.js';
import {
  BlueprintParameterCapture,
  type CapturedBlueprintParameter,
} from './blueprint-parameter-capture.js';
import {
  createArithmeticConfigurationTemplate,
  type ArithmeticConfigurationTemplate,
  type ArithmeticTemplateOperand,
} from '../../compiler/src/arithmetic-configuration-template.js';
import {
  ArithmeticConfigurationSourceError,
  bindPreparedArithmeticConfigurationSource,
  prepareArithmeticConfigurationSource,
  type PreparedArithmeticConfigurationSource,
} from './arithmetic-configuration-source.js';
import { bindArithmeticConfigurationTemplate } from '../../compiler/src/arithmetic-configuration-binding.js';
import {
  inspectConstantConfigurationTemplate,
  type ConstantConfigurationTemplate,
} from '../../compiler/src/constant-configuration-template.js';
import { bindConstantConfigurationTemplate } from '../../compiler/src/constant-configuration-binding.js';
import {
  createDeciderConfigurationTemplate,
  type DeciderConfigurationTemplate,
  type DeciderTemplateCondition,
  type DeciderTemplateOutput,
} from '../../compiler/src/decider-configuration-template.js';
import { bindDeciderConfigurationTemplate } from '../../compiler/src/decider-configuration-binding.js';
import { type SelectorConfigurationTemplate } from '../../compiler/src/selector-configuration-template.js';
import {
  inspectBlueprintRecipeIngredientReference,
  projectBlueprintRecipeIngredientReference,
} from '../../compiler/src/blueprint-recipe-ingredient-reference.js';
import {
  createBlueprintParameterSourceView,
  canonicalBlueprintParameterHandle,
  findBlueprintParameterHandle,
  BlueprintParameterError,
  type BlueprintNumberParameterHandle,
  type BlueprintParameterHandle,
  type BlueprintParameterSession,
  type BlueprintSignalParameterHandle,
} from '../../compiler/src/blueprint-parameters.js';
import {
  assertBlueprintNumericFunctionArity,
  createBlueprintNumericExpression,
  resolveBlueprintNumericFunctionName,
  type BlueprintNumericExpression,
} from '../../compiler/src/blueprint-numeric-expression.js';
import {
  isBlueprintParameterShaped,
  lookupBlueprintParameterSlot,
} from '../../compiler/src/blueprint-parameter-validation.js';
import { createProducerNumberDefaultContext } from './source-producer-number-defaults.js';
import type { SourceResolvedNumberDefaultContext } from './source-resolved-number-defaults.js';
import {
  createSourceSignalTemplateContext,
  type SourceSignalTemplateContext,
} from './source-signal-template.js';
import {
  createSourceNumericExpressionView,
  findSourceNumericExpressionView,
} from './source-numeric-expressions.js';
import { bindSelectorConfigurationTemplate } from '../../compiler/src/selector-configuration-binding.js';
import {
  bindPreparedSelectorConfigurationSource,
  prepareSelectorConfigurationSource,
  SelectorConfigurationSourceError,
} from './selector-configuration-source.js';
import {
  bindPreparedDeciderComparisonSource,
  DeciderComparisonSourceError,
  prepareDeciderComparisonSource,
  type PreparedDeciderComparisonSource,
} from './decider-comparison-source.js';
import { resolveConstantRecipeIngredientReferences } from './recipe-ingredient-dependencies.js';

interface RawSpan {
  readonly start: number;
  readonly end: number;
}

interface CallArgument {
  readonly value: unknown;
  readonly source: RawSpan;
  readonly fieldSources?: Readonly<Record<string, RawSpan>>;
}

interface CapturedArithmeticConfigurationTemplate {
  readonly captureId: string;
  readonly template: ArithmeticConfigurationTemplate;
  readonly source: SourceSpan;
}

interface EffectiveArithmeticConfigurationTemplateCapture extends CapturedArithmeticConfigurationTemplate {
  readonly producer: CombinatorValue;
  readonly rawTemplate: ArithmeticConfigurationTemplate;
  readonly ownerDescriptor: Extract<CombinatorDescriptor, { readonly kind: 'arithmetic' }>;
}

interface PendingArithmeticConfigurationTemplateCapture extends CapturedArithmeticConfigurationTemplate {
  readonly producer: CombinatorValue;
}

interface CapturedConstantConfigurationTemplate {
  readonly captureId: string;
  readonly template: ConstantConfigurationTemplate;
  readonly source: SourceSpan;
}

interface CapturedDeciderConfigurationTemplate {
  readonly captureId: string;
  readonly template: DeciderConfigurationTemplate;
  readonly source: SourceSpan;
}

interface PendingDeciderTemplateCapture {
  readonly producer: CombinatorValue;
  readonly captureId: string;
  readonly template: DeciderConfigurationTemplate;
}

interface CapturedSelectorConfigurationTemplate {
  readonly captureId: string;
  readonly template: SelectorConfigurationTemplate;
  readonly source: SourceSpan;
}

type PlanDeciderOutput = Extract<DirectPlanProducer, { kind: 'decider' }>['output'];
type RuntimeDeciderOutput = PlanDeciderOutput | PendingDeciderOutput;

type ExactArithmeticConfiguration = Omit<
  Extract<DirectPlanArithmetic, { readonly kind: 'arithmetic' }>,
  | 'kind'
  | 'destinations'
  | 'source'
  | 'instancePath'
  | 'bindingName'
  | 'debugCaptureIds'
  | 'placement'
>;

type PendingCombinatorConfiguration =
  | {
      readonly kind: 'arithmetic';
      readonly configuration?: ExactArithmeticConfiguration;
      readonly template?: ArithmeticConfigurationTemplate;
    }
  | {
      readonly kind: 'selector';
      readonly configuration?: SelectorProducerConfig;
      readonly template?: SelectorConfigurationTemplate;
    };

function pendingDeciderCondition(condition: RuntimeDeciderCondition): PendingDeciderCondition {
  if (condition.kind === 'and' || condition.kind === 'or') {
    return { kind: condition.kind, conditions: condition.conditions.map(pendingDeciderCondition) };
  }
  if (
    condition.kind === 'compare-each' ||
    condition.kind === 'compare-signal' ||
    condition.kind === 'compare-wildcard'
  ) {
    return { ...condition, constant: { kind: 'constant' } };
  }
  return condition;
}

function planDeciderConditionFromLogical(condition: LogicalDeciderCondition): PlanDeciderCondition {
  const networkReference = (reference: LogicalNetworkRef): PlanNetworkRef =>
    reference.refKind === 'single'
      ? { refKind: 'single', network: reference.network as NetworkId }
      : {
          refKind: 'pair',
          networks: [reference.networks[0] as NetworkId, reference.networks[1] as NetworkId],
        };
  if (condition.kind === 'and' || condition.kind === 'or') {
    return {
      kind: condition.kind,
      conditions: condition.conditions.map(planDeciderConditionFromLogical),
    };
  }
  const left = condition.left;
  if (condition.right.kind === 'signal') {
    const right = { ...networkReference(condition.right), signal: condition.right.signal };
    return left.kind === 'signal'
      ? {
          kind: 'compare-signals',
          left: { ...networkReference(left), signal: left.signal },
          comparator: condition.comparator,
          right,
        }
      : {
          kind: 'compare-wildcard-signal',
          left: { ...networkReference(left), wildcard: left.value },
          comparator: condition.comparator,
          right,
        };
  }
  const reference = networkReference(left);
  return left.kind === 'signal'
    ? {
        kind: 'compare-signal',
        ...reference,
        signal: left.signal,
        comparator: condition.comparator,
        constant: condition.right.value,
      }
    : left.value === 'each'
      ? {
          kind: 'compare-each',
          ...reference,
          comparator: condition.comparator,
          constant: condition.right.value,
        }
      : {
          kind: 'compare-wildcard',
          ...reference,
          wildcard: left.value,
          comparator: condition.comparator,
          constant: condition.right.value,
        };
}

function pendingArithmeticOperand(value: PlanArithmeticOperand): PendingArithmeticOperand {
  if (value.kind === 'constant') return { kind: 'constant' };
  const reference =
    value.refKind === 'single'
      ? { refKind: 'single' as const, network: value.network }
      : { refKind: 'pair' as const, networks: value.networks };
  return value.kind === 'signal'
    ? { kind: 'signal', signal: value.signal, ...reference }
    : { kind: 'each', ...reference };
}

interface BoundArithmeticConfigurationSource {
  readonly configuration?: ExactArithmeticConfiguration;
  readonly prepared: PreparedArithmeticConfigurationSource;
}

interface NormalizedDeciderConfiguration {
  readonly condition: RuntimeDeciderCondition;
  readonly outputs: readonly DeciderOutputCandidate[];
  readonly elseOutputs?: readonly DeciderOutputCandidate[];
}

interface DeciderOutputCandidate {
  readonly output: RuntimeDeciderOutput;
  readonly source: SourceSpan;
  readonly instancePath: readonly string[];
  readonly syntaxIntent: DeciderOutputSyntaxIntent;
}

function conditionUsesEach(condition: PlanDeciderCondition): boolean {
  if (condition.kind === 'and' || condition.kind === 'or') {
    return condition.conditions.some(conditionUsesEach);
  }
  return (
    condition.kind === 'compare-each' ||
    (condition.kind === 'compare-wildcard-signal' && condition.left.wildcard === 'each')
  );
}

function hasPendingDeciderConstant(condition: RuntimeDeciderCondition): boolean {
  if (condition.kind === 'and' || condition.kind === 'or') {
    return condition.conditions.some(hasPendingDeciderConstant);
  }
  return (
    (condition.kind === 'compare-each' ||
      condition.kind === 'compare-signal' ||
      condition.kind === 'compare-wildcard') &&
    typeof condition.constant !== 'number'
  );
}

const entityFamilyConstructionTypes = Object.freeze({
  Lamp: 'lamp',
  Roboport: 'roboport',
  Constant: 'constant-combinator',
  Selector: 'selector-combinator',
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
  readonly operation: string;
  dslDomain: boolean;
  forwardedNativeUnaryThrow?: { readonly value: unknown };
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
  readonly networks: DirectElaborationPlan['networks'];
  readonly networkStates: ReadonlyMap<string, NetworkRuntimeState>;
  readonly networkValues: ReadonlyMap<string, NetworkValue>;
  readonly networkNameCounts: ReadonlyMap<string, number>;
  readonly networkAliases: ReadonlyMap<string, PendingNetworkAlias>;
  readonly networkTransfersLength: number;
  readonly combinatorOrdinal: number;
  readonly combinatorByOutput: ReadonlyMap<NetworkOwnershipState, CombinatorValue>;
  readonly combinators: CombinatorRegistrySnapshot;
  readonly arithmeticTemplatesLength: number;
  readonly constantTemplatesLength: number;
  readonly pendingDeciderTemplateCapturesLength: number;
  readonly selectorTemplatesLength: number;
  readonly debugInstancesLength: number;
  readonly debugInstanceCounts: ReadonlyMap<string, number>;
  readonly ownership: readonly NetworkOwnershipSnapshot[];
  readonly colors: ElaborationColorConstraints;
  readonly entityRegistry?: EntityRegistrySnapshot;
  readonly entityRevision: number;
  readonly entityAuthoritiesLength: number;
  readonly entityFacets: readonly {
    readonly authority: EntityAuthorityView;
    readonly owner: EntityAuthorityView['owner'];
    readonly retiredAt?: SourceSpan;
    readonly facets: ReadonlyMap<string, EntityFacetAuthority>;
    readonly bindings: ReturnType<EntityRegistry['record']>['connectorBindings'];
    readonly sharedAttachments: readonly EntitySharedAttachmentAuthority[];
    readonly sharedConnectorAttachments: ReturnType<
      EntityRegistry['record']
    >['sharedConnectorAttachments'];
  }[];
  readonly entityOperationOrdinal: number;
  readonly entityInvocations: ReadonlyMap<EntityValue['id'], SourceSpan>;
  readonly linkedProducersLength: number;
  readonly pendingCombinatorInstallationsLength: number;
  readonly pendingDeciderConditions: ReadonlyMap<object, RuntimeDeciderCondition>;
}

interface EntityFacetAuthority {
  readonly endpoint: EntityLaneEndpoint;
  readonly direction: 'input' | 'output';
  readonly provenance: EntityConnectorBindingProvenance;
  readonly source: SourceSpan;
  network: NetworkValue;
  locallyOwned: boolean;
}

interface EntitySharedAttachmentAuthority {
  readonly connector: EntityPlanSharedConnectorAttachment['connector'];
  readonly direction: 'input' | 'output';
  readonly provenance: EntityConnectorBindingProvenance;
  readonly source: SourceSpan;
  readonly logicalNetwork: NetworkValue;
  network: NetworkValue;
  locallyOwned: boolean;
}

interface EntityAuthorityView {
  readonly entity: EntityValue;
  owner: symbol | 'top-level' | 'retired';
  retiredAt?: SourceSpan;
  readonly facets: Map<string, EntityFacetAuthority>;
  readonly sharedAttachments: EntitySharedAttachmentAuthority[];
}

interface LinkedConstantAssociation {
  readonly kind: 'constant';
  readonly entity: EntityValue;
  readonly configuration: ConstantConfiguration;
}

interface LinkedPendingConstantAssociation {
  readonly kind: 'pending-constant';
  readonly entity: EntityValue;
}

interface LinkedPendingSelectorAssociation {
  readonly kind: 'pending-selector';
  readonly entity: EntityValue;
}

interface LinkedPendingArithmeticAssociation {
  readonly kind: 'pending-arithmetic';
  readonly entity: EntityValue;
}

interface LinkedPendingDeciderAssociation {
  readonly kind: 'pending-decider';
  readonly entity: EntityValue;
}

interface LinkedArithmeticAssociation {
  readonly kind: 'arithmetic';
  readonly entity: EntityValue;
  readonly configuration: EntityArithmeticConfiguration;
}

interface LinkedDeciderAssociation {
  readonly kind: 'decider';
  readonly entity: EntityValue;
  readonly configuration: EntityDeciderConfiguration;
}

interface LinkedSelectorAssociation {
  readonly kind: 'selector';
  readonly entity: EntityValue;
  readonly configuration: EntitySelectorConfiguration;
}

type LinkedProducerAssociation =
  | LinkedConstantAssociation
  | LinkedPendingConstantAssociation
  | LinkedPendingArithmeticAssociation
  | LinkedPendingSelectorAssociation
  | LinkedPendingDeciderAssociation
  | LinkedArithmeticAssociation
  | LinkedDeciderAssociation
  | LinkedSelectorAssociation;

type PendingCombinatorInstallation =
  | {
      readonly kind: 'constant';
      readonly producer: CombinatorValue;
      readonly entity: EntityValue;
      readonly configuration?: ConstantConfiguration;
      readonly template?: ConstantConfigurationTemplate;
    }
  | {
      readonly kind: 'arithmetic';
      readonly producer: CombinatorValue;
      readonly entity: EntityValue;
      readonly configuration?: ExactArithmeticConfiguration;
      readonly template?: ArithmeticConfigurationTemplate;
    }
  | {
      readonly kind: 'selector';
      readonly producer: CombinatorValue;
      readonly entity?: EntityValue;
      readonly configuration?: SelectorProducerConfig;
      readonly template?: SelectorConfigurationTemplate;
    }
  | {
      readonly kind: 'decider';
      readonly producer: CombinatorValue;
      readonly entity: EntityValue;
      readonly condition?: PlanDeciderCondition;
      readonly template?: DeciderConfigurationTemplate;
    };

export interface ElaborationExecutionOptions {
  readonly dslCallBudget?: number;
  /** Explicit immutable prototype environment exposed to source as `prototypes`. */
  readonly prototypes?: PrototypeProvider;
  /** Host-only profile context; never exposed to executed source. */
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
  readonly #networkValues = new Map<string, NetworkValue>();
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
  readonly #arithmeticTemplates: PendingArithmeticConfigurationTemplateCapture[] = [];
  readonly #constantTemplates: CapturedConstantConfigurationTemplate[] = [];
  readonly #pendingDeciderTemplateCaptures: PendingDeciderTemplateCapture[] = [];
  readonly #selectorTemplates: CapturedSelectorConfigurationTemplate[] = [];
  readonly #deciderParameterSlots = new WeakMap<
    object,
    BlueprintNumberParameterHandle | BlueprintNumericExpression
  >();
  readonly #combinatorByOutput = new Map<NetworkOwnershipState, CombinatorValue>();
  readonly #runtimeValues = new RuntimeValueRegistry();
  readonly #deciderMemberAliases = new WeakMap<
    Function,
    {
      readonly receiver: unknown;
      readonly branch: 'then' | 'else';
    }
  >();
  readonly #recipeIngredientMethods = new WeakMap<Function, BlueprintParameterHandle>();
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
  readonly #loopValueCounts = new Map<string, number>();
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
  readonly #parameterCapture: BlueprintParameterCapture | undefined;
  readonly #entityAuthorities = new WeakMap<object, EntityAuthorityView>();
  readonly #entityAuthorityList: EntityAuthorityView[] = [];
  readonly #linkedProducerByIdentity = new WeakMap<object, LinkedProducerAssociation>();
  readonly #linkedProducers: {
    readonly producer: CombinatorValue;
    readonly association: LinkedProducerAssociation;
  }[] = [];
  readonly #pendingCombinatorInstallations: PendingCombinatorInstallation[] = [];
  readonly #pendingDeciderConditions = new Map<object, RuntimeDeciderCondition>();
  #resolvedNumberDefaultContext: SourceResolvedNumberDefaultContext | undefined;
  #resolvedSignalTemplateContext: SourceSignalTemplateContext | undefined;
  #entityRevision = 0;
  #entityOperationOrdinal = 0;
  readonly #entityInvocations = new Map<EntityValue['id'], SourceSpan>();
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
    isSection: (value): value is SectionValue => this.#isSection(value),
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
    parameterCapture: BlueprintParameterCapture | undefined,
  ) {
    this.#fileId = fileId;
    this.#dslCallBudget = dslCallBudget;
    this.#prototypes = prototypes;
    this.#entityContext = entityContext;
    this.#entityPrototypeResolver = entityPrototypeResolver;
    this.#parameterCapture = parameterCapture;
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
      if (key === 'ingredient' && findBlueprintParameterHandle(receiver) !== undefined) {
        const parameter = canonicalBlueprintParameterHandle(receiver);
        if (parameter !== undefined) {
          const callable = (() => undefined) as Function;
          this.#recipeIngredientMethods.set(callable, parameter);
          return { callable, receiver };
        }
      }
      if (this.#isCircuitDslValue(receiver)) {
        const property = Reflect.ownKeys({ [key]: undefined })[0]!;
        if (property === 'then' || property === 'else') {
          return { callable: undefined, receiver, deciderBranch: property };
        }
        const operations: Record<string, ((...values: unknown[]) => unknown) | undefined> = {
          to: (...values) => this.api.attachTo(receiver, ...values, rawSpan),
          take: (...values) => this.api.take(receiver, ...values, rawSpan),
          at: (...values) => this.api.place(receiver, ...values, rawSpan),
          as: (...values) => this.api.bindOutput(receiver, values, rawSpan),
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
      // Compatibility with previously generated programs using argument thunks.
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
      // The two-argument form keeps previously generated programs executable.
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
    enterLoop: (name: string, value: unknown, rawSpan: RawSpan): void => {
      if (value === undefined) {
        const occurrence = (this.#anonymousLoopCounts.get(name) ?? 0) + 1;
        this.#anonymousLoopCounts.set(name, occurrence);
        this.#instancePath.push(`${name} #${occurrence}`);
      } else {
        const formatted = this.#provenanceFormatter.format(value);
        const key = JSON.stringify({
          parent: this.#instancePath,
          name,
          source: this.#span(rawSpan),
          value: formatted,
        });
        const occurrence = (this.#loopValueCounts.get(key) ?? 0) + 1;
        this.#loopValueCounts.set(key, occurrence);
        this.#instancePath.push(
          `for ${name}=${formatted}${occurrence === 1 ? '' : `#${occurrence}`}`,
        );
      }
      this.#ownershipFrames.push(undefined);
    },
    exitInstance: (rawSpan?: RawSpan): void => {
      const frame = this.#ownershipFrames.pop();
      if (this.#instancePath.pop() === undefined) {
        throw new Error('Executed provenance stack underflow.');
      }
      if (frame !== undefined) {
        const releasedAt = isRawSpan(rawSpan) ? this.#span(rawSpan) : undefined;
        const movedOwnerships = new Set(frame.moves.map(({ ownership }) => ownership));
        this.#ownership.releaseFrame(frame, releasedAt);
        for (const ownership of movedOwnerships) {
          if (ownership.owner === 'lost' && ownership.consumedAt === undefined) {
            this.#refreshEntityConnectionsForOwnership(ownership);
          }
        }
      }
    },
    instantiate: (...args: unknown[]): unknown => {
      const rawSpan = args.at(-1);
      if (!isRawSpan(rawSpan)) throw new Error('t.instantiate(...) is missing provenance.');
      return this.#withTopologyTransaction(rawSpan, () => {
        this.#recordDslCall();
        const bindingName = args[0];
        const factory = args[1];
        const values = args.slice(2, -1);
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
          throw new Error(
            'A debug instance factory entered another capture before function entry.',
          );
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
    constantCall: (arguments_: readonly CallArgument[], rawSpan: RawSpan): CombinatorValue =>
      this.#withTopologyTransaction(rawSpan, () => {
        this.#recordDslCall();
        return this.#createConstantFromCallArguments(arguments_, rawSpan);
      }),
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
        let configuration: ConstantConfiguration | undefined;
        let template: ConstantConfigurationTemplate | undefined;
        try {
          const context: ConstantConfigurationSourceContext = {
            isSignal: (value): value is SignalHandle => this.#isSignal(value),
            isSignalValue: (value): value is SignalValue => this.#isSignalValue(value),
          };
          if (this.#hasAutomaticNumberDefaults()) {
            const prepared = prepareConstantConfigurationSource(
              first!.value,
              context,
              this.#parameterCapture!.session,
              '$.configuration',
            );
            if (prepared.hasParameterSlots) template = prepared.template;
            else configuration = bindConstantConfigurationTemplate(prepared.template);
          } else if (this.#hasDefaultFreeSignalParameters()) {
            const prepared = prepareConstantConfigurationSource(
              first!.value,
              context,
              this.#parameterCapture!.session,
              '$.configuration',
            );
            if (prepared.hasParameterSlots) {
              template = prepared.template;
              const inspected = inspectConstantConfigurationTemplate(
                prepared.template,
                '$.configuration',
              );
              const hasRequiredSignal = inspected.usedParameters.some(
                (parameter) => parameter.kind === 'signal' && parameter.defaultValue === undefined,
              );
              if (!hasRequiredSignal) {
                const recipeIngredientBindings = resolveConstantRecipeIngredientReferences(
                  [prepared.template],
                  this.#prototypes,
                );
                configuration = bindConstantConfigurationTemplate(
                  prepared.template,
                  [],
                  recipeIngredientBindings,
                );
              }
            } else {
              configuration = bindConstantConfigurationTemplate(prepared.template);
            }
          } else {
            const normalized = normalizeConstantConfigurationSourceWithParameters(
              first!.value,
              context,
              this.#parameterCapture?.session,
              '$.configuration',
              (constantTemplate) =>
                resolveConstantRecipeIngredientReferences([constantTemplate], this.#prototypes),
            );
            configuration = normalized.configuration;
            template = normalized.template;
          }
        } catch (error) {
          if (error instanceof ConstantConfigurationSourceError) {
            throw new ElaborationExecutionError(
              error.message,
              error.span ?? this.#span(rawSpan),
              'RT2027',
              undefined,
              { cause: error },
            );
          }
          throw error;
        }
        const producer = this.#createConstantProducer(
          configuration,
          rawSpan,
          undefined,
          true,
          template,
        );
        if (template !== undefined && this.#parameterCapture !== undefined) {
          const { captureId } = this.#combinators.capture(producer);
          this.#constantTemplates.push(
            Object.freeze({
              captureId,
              template,
              source: Object.freeze({ ...this.#span(rawSpan) }),
            }),
          );
        }
        return producer;
      }),
    sectionOverload: (arguments_: readonly CallArgument[], rawSpan: RawSpan): SectionValue =>
      this.#withTopologyTransaction(rawSpan, () => {
        this.#recordDslCall();
        return this.#createSectionValue(arguments_, rawSpan);
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
        const normalized = this.#prepareArithmeticConfigurationSource(
          argument.value,
          argument.source,
          rawSpan,
        );
        if (this.#resolveCanonicalProfile('Arithmetic', rawSpan) === undefined) {
          throw new ElaborationExecutionError(
            'Exact Arithmetic configuration requires a trusted base entity:arithmetic-combinator Entity profile.',
            this.#span(rawSpan),
            'RT2027',
          );
        }
        let descriptor: CombinatorDescriptor;
        let pendingConfiguration: PendingCombinatorConfiguration | undefined;
        if (normalized.prepared.hasParameterSlots && 'template' in normalized.prepared) {
          const template = normalized.prepared.template;
          if (template.operation !== (normalized.configuration?.operation ?? template.operation)) {
            throw new Error('Prepared Arithmetic template changed its operation before capture.');
          }
          descriptor = {
            kind: 'arithmetic',
            left:
              normalized.configuration === undefined
                ? this.#pendingArithmeticTemplateOperand(template.left)
                : pendingArithmeticOperand(normalized.configuration.left),
            operation: template.operation,
            right:
              normalized.configuration === undefined
                ? this.#pendingArithmeticTemplateOperand(template.right)
                : pendingArithmeticOperand(normalized.configuration.right),
            pendingConfiguration: template,
            source: this.#span(rawSpan),
            instancePath: this.#path(),
          };
          pendingConfiguration =
            normalized.configuration === undefined
              ? { kind: 'arithmetic', template }
              : { kind: 'arithmetic', configuration: normalized.configuration };
        } else {
          if (normalized.configuration === undefined) {
            throw new Error('A concrete Arithmetic configuration was not prepared.');
          }
          descriptor = {
            kind: 'arithmetic',
            ...normalized.configuration,
            source: this.#span(rawSpan),
            instancePath: this.#path(),
          };
        }
        const producer = this.#createCombinator(descriptor, rawSpan, pendingConfiguration);
        if (normalized.prepared.hasParameterSlots && 'template' in normalized.prepared) {
          const { captureId } = this.#combinators.capture(producer);
          this.#captureArithmeticTemplate(producer, captureId, normalized.prepared.template);
        }
        return producer;
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
        const profile = this.#resolveCanonicalProfile('Decider', rawSpan);
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
    selectorOverload: (
      arguments_: readonly CallArgument[],
      rawSpan: RawSpan,
    ): CombinatorValue | EntityValue =>
      this.#withTopologyTransaction(rawSpan, () => {
        this.#recordDslCall();
        if (!Array.isArray(arguments_)) {
          throw new ElaborationExecutionError(
            'Selector(...) arguments must be an evaluated argument list.',
            this.#span(rawSpan),
            'RT2027',
          );
        }
        const first = arguments_[0];
        const structural =
          first !== undefined &&
          (typeof first.value === 'string' || this.#isPrototypeRecordCandidate(first.value));
        if (
          structural ||
          arguments_.length === 0 ||
          arguments_.length > 2 ||
          arguments_.length === 2
        ) {
          return this.#constructEntityFromPrototype(
            arguments_,
            rawSpan,
            'selector-combinator',
            'Selector',
            false,
          );
        }
        if (arguments_.length !== 1) {
          throw new ElaborationExecutionError(
            'Selector(configuration) requires exactly one configuration argument, or use Selector(prototype, configuration?) for an Entity.',
            this.#span(rawSpan),
            'RT2027',
          );
        }
        const sourceSpanFor = (path: string): SourceSpan => {
          const field = /^\$\.(input|operation|selectMax|index|output)(?:\.|\[|$)/.exec(path)?.[1];
          const fieldSource = field === undefined ? undefined : first!.fieldSources?.[field];
          return this.#span(fieldSource ?? first!.source);
        };
        const diagnosticMessage = (error: SelectorConfigurationSourceError): string =>
          error.cause instanceof BlueprintParameterError ||
          !error.message.startsWith(`${error.path}: `)
            ? error.message
            : error.message.slice(error.path.length + 2);
        let prepared: ReturnType<typeof prepareSelectorConfigurationSource>;
        try {
          prepared = prepareSelectorConfigurationSource(
            first!.value,
            {
              normalizeInput: (candidate, inputSource) => {
                if (!this.#isNetwork(candidate) && !this.#isPair(candidate)) {
                  throw new ElaborationExecutionError(
                    'Selector configuration input must be a Network or pair(a, b).',
                    this.#span(inputSource),
                    'RT2027',
                  );
                }
                this.#assertReadableValue(candidate, inputSource);
                return this.#planNetworkRef(
                  candidate,
                ) as unknown as SelectorConfigurationTemplate['input'];
              },
              isSignal: (candidate): candidate is SignalId => this.#isSignal(candidate),
              snapshotSignal: (candidate) => this.#signalSnapshot(candidate),
            },
            this.#parameterCapture?.session,
            first!.source,
            first!.fieldSources,
          );
        } catch (error) {
          if (error instanceof SelectorConfigurationSourceError) {
            throw new ElaborationExecutionError(
              diagnosticMessage(error),
              error.configurationShape ? this.#span(first!.source) : sourceSpanFor(error.path),
              'RT2027',
              undefined,
              { cause: error.cause ?? error },
            );
          }
          throw error;
        }
        const pendingTemplate =
          prepared.hasParameterSlots &&
          'template' in prepared &&
          this.#parameterCapture !== undefined
            ? prepared.template
            : undefined;
        let descriptorConfiguration:
          ReturnType<typeof bindPreparedSelectorConfigurationSource> | undefined;
        if (
          !(this.#hasAutomaticNumberDefaults() || this.#hasDefaultFreeSignalParameters()) ||
          pendingTemplate === undefined
        ) {
          try {
            descriptorConfiguration = bindPreparedSelectorConfigurationSource(prepared);
          } catch (error) {
            if (error instanceof SelectorConfigurationSourceError) {
              throw new ElaborationExecutionError(
                diagnosticMessage(error),
                error.configurationShape ? this.#span(first!.source) : sourceSpanFor(error.path),
                'RT2027',
                undefined,
                { cause: error.cause ?? error },
              );
            }
            throw error;
          }
        }
        let selectorDescriptor: CombinatorDescriptor;
        if (pendingTemplate === undefined) {
          if (descriptorConfiguration === undefined) {
            throw new Error('A concrete Selector configuration was not prepared.');
          }
          selectorDescriptor = {
            kind: 'selector',
            ...descriptorConfiguration,
            source: this.#span(rawSpan),
            instancePath: this.#path(),
          };
        } else if ((descriptorConfiguration?.operation ?? pendingTemplate.operation) === 'select') {
          if (pendingTemplate.operation !== 'select') {
            throw new Error('Prepared Selector template changed its operation before capture.');
          }
          selectorDescriptor = {
            kind: 'selector',
            operation: 'select',
            input: descriptorConfiguration?.input ?? pendingTemplate.input,
            selectMax:
              descriptorConfiguration?.operation === 'select'
                ? descriptorConfiguration.selectMax
                : pendingTemplate.selectMax,
            pendingConfiguration: pendingTemplate,
            source: this.#span(rawSpan),
            instancePath: this.#path(),
          };
        } else {
          if (pendingTemplate.operation !== 'count') {
            throw new Error('Prepared Selector template changed its operation before capture.');
          }
          selectorDescriptor = {
            kind: 'selector',
            operation: 'count',
            input: descriptorConfiguration?.input ?? pendingTemplate.input,
            pendingConfiguration: pendingTemplate,
            source: this.#span(rawSpan),
            instancePath: this.#path(),
          };
        }
        const producer = this.#createCombinator(
          selectorDescriptor,
          rawSpan,
          pendingTemplate === undefined
            ? undefined
            : descriptorConfiguration === undefined
              ? { kind: 'selector', template: pendingTemplate }
              : { kind: 'selector', configuration: descriptorConfiguration },
        );
        if (pendingTemplate !== undefined) {
          const { captureId } = this.#combinators.capture(producer);
          this.#captureSelectorTemplate(producer, captureId, pendingTemplate);
        }
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
      return this.#withEntityReadTransaction(value, argumentSpan, () => {
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
      });
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
      return this.#withEntityReadTransaction(value, argumentSpan, () =>
        bindParameterContract(
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
            isCombinator: (candidate): candidate is CombinatorValue =>
              this.#isCombinator(candidate),
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
              this.#moveNetworkToFrame(network, source, frame),
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
        ),
      );
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
      return this.#withEntityReadTransaction(value, rawSpan, () =>
        returnNetworkValue(
          value,
          {
            capability,
            ...(fixedColor === undefined ? {} : { fixedColor }),
            source: this.#span(rawSpan),
          },
          {
            networkFacet: (candidate) => this.#readableNetworkFacet(candidate, rawSpan),
            requireColor: (network, requiredCapability, color) =>
              this.#requireNetworkColor(network, requiredCapability, color, rawSpan),
            transferToCaller: (network) => this.#returnOwnedNetwork(network, rawSpan),
            assertReadable: (network, source) => this.#ownership.assertReadable(network, source),
            readonlyAliasState: (network) => {
              const frame = this.#currentFunctionFrame();
              const state = this.#networkState(network);
              if (
                frame === undefined ||
                network.capability !== 'readonly' ||
                state.borrow?.capability === 'ref' ||
                state.ownership.owner === frame.owner ||
                (state.ownership.owner !== 'top-level' &&
                  !this.#ownershipFrames.some(
                    (ancestor) => ancestor?.owner === state.ownership.owner,
                  ))
              ) {
                return undefined;
              }
              // The source was validated before this seam. Do not alter its borrow token:
              // closures retain the original view and still expire on frame release.
              const { borrow, ...aliasState } = state;
              return borrow !== undefined && !frame.borrows.includes(borrow)
                ? { ...aliasState, borrow }
                : aliasState;
            },
            isTransparentAlias: (network) => this.#isTransparentNetwork(network),
            returnTransparent: (network) => network,
            stateFor: (network) => this.#networkState(network),
            brandNetwork: (network, state) => this.#networkValue(network, state),
          },
        ),
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
      return this.#withEntityReadTransaction(value, rawSpan, () =>
        resolveNetworkArgument(
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
        ),
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
      const bind = (): unknown => {
        let result: unknown;
        if (this.#isCombinator(value)) {
          const network = this.#rawNetworkFacet(value)!;
          this.#combinators.bindName(value, name);
          if (fixedColor !== undefined) {
            this.#requireNetworkColor(network, 'readonly', fixedColor, rawSpan);
          }
          result = networkNarrowing ? network : value;
        } else if (this.#isEntity(value) && networkNarrowing) {
          const network = this.#readableNetworkFacet(value, rawSpan);
          if (network === undefined) {
            throw new ElaborationExecutionError(
              'Entity has no readable Network projection.',
              this.#span(rawSpan),
              'RT2032',
            );
          }
          if (fixedColor !== undefined) {
            this.#requireNetworkColor(network, 'readonly', fixedColor, rawSpan);
          }
          result = network;
        } else {
          if (this.#isNetwork(value) && fixedColor !== undefined) {
            this.#requireNetworkColor(value, 'readonly', fixedColor, rawSpan);
          }
          result = value;
        }
        if (readBinding !== undefined) this.#captureNetworkAlias(name, readBinding, rawSpan);
        return result;
      };
      return this.#isEntity(value) && networkNarrowing
        ? this.#withTopologyTransaction(rawSpan, bind)
        : bind();
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
      this.#rejectDerivedNumericExpression(left, rawSpan);
      const rightExpression = findSourceNumericExpressionView(right);
      if (rightExpression === undefined) this.#rejectDerivedNumericExpression(right, rawSpan);
      let rightIsParameter = findBlueprintParameterHandle(right) !== undefined;
      let leftIsParameter = findBlueprintParameterHandle(left) !== undefined;
      if (this.#parameterCapture !== undefined) {
        try {
          rightIsParameter ||= rightExpression === undefined && isBlueprintParameterShaped(right);
          leftIsParameter ||= isBlueprintParameterShaped(left);
        } catch (error) {
          throw new ElaborationExecutionError(
            error instanceof Error ? error.message : 'Invalid Decider numeric source value.',
            this.#span(rawSpan),
            'RT2027',
            undefined,
            { cause: error },
          );
        }
      }
      const rightIsSymbolic = rightExpression !== undefined || rightIsParameter;
      if (rightIsSymbolic || leftIsParameter) {
        if (!rightIsSymbolic || leftIsParameter || !this.#isCircuitDslValue(left)) {
          throw new ElaborationExecutionError(
            rightExpression !== undefined
              ? 'A source numeric expression is supported only as the right constant of a Decider condition.'
              : 'A source number parameter is supported only as the direct right constant of a Decider condition.',
            this.#span(rawSpan),
            'RT2027',
          );
        }
        const head = operators.prepareConstantComparisonHead(
          operator,
          left,
          right,
          rawSpan,
          this.#operatorContext,
        );
        let prepared: PreparedDeciderComparisonSource;
        try {
          prepared = prepareDeciderComparisonSource(head, right, this.#parameterCapture?.session, {
            snapshotSignal: (signal) => this.#signalSnapshot(signal),
          });
        } catch (error) {
          const comparisonError =
            error instanceof DeciderComparisonSourceError
              ? error
              : error instanceof Error &&
                  error.name === 'DeciderComparisonSourceError' &&
                  typeof (error as { readonly path?: unknown }).path === 'string'
                ? (error as DeciderComparisonSourceError)
                : undefined;
          if (comparisonError === undefined) throw error;
          const message = comparisonError.message.startsWith(`${comparisonError.path}: `)
            ? comparisonError.message.slice(comparisonError.path.length + 2)
            : comparisonError.message;
          throw new ElaborationExecutionError(message, this.#span(rawSpan), 'RT2027', undefined, {
            cause: comparisonError,
          });
        }
        let result: ConditionValue;
        if (this.#hasAutomaticNumberDefaults() || this.#hasDefaultFreeSignalParameters()) {
          const constant = { kind: 'constant' as const };
          const condition: PendingDeciderCondition =
            head.kind === 'compare-signal'
              ? { ...head, constant }
              : head.kind === 'compare-each'
                ? { ...head, constant }
                : { ...head, constant };
          result = this.#runtimeValue({ kind: 'condition', condition });
        } else {
          let value: number;
          try {
            value = bindPreparedDeciderComparisonSource(prepared);
          } catch (error) {
            const comparisonError =
              error instanceof DeciderComparisonSourceError
                ? error
                : error instanceof Error &&
                    error.name === 'DeciderComparisonSourceError' &&
                    typeof (error as { readonly path?: unknown }).path === 'string'
                  ? (error as DeciderComparisonSourceError)
                  : undefined;
            if (comparisonError === undefined) throw error;
            const message = comparisonError.message.startsWith(`${comparisonError.path}: `)
              ? comparisonError.message.slice(comparisonError.path.length + 2)
              : comparisonError.message;
            throw new ElaborationExecutionError(message, this.#span(rawSpan), 'RT2027', undefined, {
              cause: comparisonError,
            });
          }
          result = operators.constantComparisonCondition(head, value, this.#operatorContext);
        }
        this.#deciderParameterSlots.set(result.condition as object, prepared.root);
        return result;
      }
      return this.#withEntityReadOperandsTransaction(left, right, rawSpan, () =>
        operators.dispatchComparison(operator, left, right, rawSpan, this.#operatorContext),
      );
    },
    controlTest: (value: unknown, rawSpan: RawSpan): unknown => {
      this.#rejectParameterControlValue(value, rawSpan);
      if (this.#isCondition(value)) {
        throw new ElaborationExecutionError(
          'A circuit Condition cannot be used as a JavaScript control-flow test; use IF(...) or when(...).then(...) to create circuit logic.',
          this.#span(rawSpan),
          'RT2024',
        );
      }
      return value;
    },
    controlValue: (value: unknown, rawSpan: RawSpan): unknown => {
      this.#rejectParameterControlValue(value, rawSpan);
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
      rawSpan: RawSpan,
    ): unknown => {
      const left = evaluateLeft();
      this.#rejectParameterControlValue(left, rawSpan);
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
    not: (value: unknown, rawSpan: RawSpan): unknown => {
      this.#rejectParameterControlValue(value, rawSpan);
      if (!this.#isCondition(value)) return !value;
      this.#assertNoParameterizedNegatedCondition(value.condition, rawSpan);
      this.#recordDslCall();
      return this.#runtimeValue({
        kind: 'condition',
        condition: operators.invertCondition(
          this.#requireConcreteDeciderCondition(value.condition),
        ),
      });
    },
    unaryMinus: (value: unknown, rawSpan: RawSpan): unknown => {
      const ingredientReference = inspectBlueprintRecipeIngredientReference(value);
      if (ingredientReference !== undefined) {
        throw new BlueprintParameterError(
          'CP1001',
          '$.ingredient.unaryOperand',
          'recipe ingredient references cannot be used in unary numeric expressions.',
          this.#span(rawSpan),
        );
      }
      const expressionView = findSourceNumericExpressionView(value);
      const parameterLike =
        expressionView === undefined && findBlueprintParameterHandle(value) !== undefined;
      if (expressionView === undefined && !parameterLike) {
        try {
          return -(value as number);
        } catch (error) {
          const frame = this.#executionApiFrames.at(-1);
          if (frame?.operation === 'unaryMinus') {
            frame.forwardedNativeUnaryThrow = { value: error };
          }
          throw error;
        }
      }
      try {
        if (this.#parameterCapture === undefined) {
          throw new Error('Source numeric expressions require an owning parameter session.');
        }
        this.#recordDslCall();
        const operand = this.#numericExpressionOperand(value, '$.operand');
        const expression = createBlueprintNumericExpression(this.#parameterCapture.session, {
          kind: 'negate',
          operand,
        });
        return createSourceNumericExpressionView(
          this.#parameterCapture.session,
          expression,
          this.#span(rawSpan),
        );
      } catch (error) {
        throw new ElaborationExecutionError(
          error instanceof Error ? error.message : 'Invalid source numeric negation.',
          this.#span(rawSpan),
          'RT2027',
          undefined,
          { cause: error },
        );
      }
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
      const ingredientLeaf = projectBlueprintRecipeIngredientReference(
        value,
        key,
        this.#span(rawSpan),
      );
      if (ingredientLeaf !== undefined) return ingredientLeaf;
      if (this.#isSelected(value)) {
        this.#recordDslCall();
        return this.#selectedMember(value, key);
      }
      if (this.#isCombinator(value) && (key === 'then' || key === 'else')) {
        return this.#member(value, key, rawSpan);
      }
      if (this.#isEntity(value) && (this.#isSignal(key) || this.#isWildcardToken(key))) {
        const profile = this.#entityProfile(value, this.#span(rawSpan));
        if (profile.sharedCallConnector !== undefined) {
          return this.#withEntityReadTransaction(value, rawSpan, () => {
            this.#recordDslCall();
            const network = this.#readableNetworkFacet(value, rawSpan);
            if (network === undefined) {
              throw new ElaborationExecutionError(
                'Shared Entity selection requires one unambiguous output Network.',
                this.#span(rawSpan),
                'RT2032',
              );
            }
            return this.#select(network, key, rawSpan);
          });
        }
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
    property: (value: unknown, key: PropertyKey, rawSpan: RawSpan): unknown => {
      const ingredientReference = inspectBlueprintRecipeIngredientReference(value);
      if (ingredientReference?.slot !== undefined) {
        throw new BlueprintParameterError(
          'CP1001',
          '$.ingredient.field',
          'projected recipe ingredient fields cannot be inspected or chained.',
          this.#span(rawSpan),
        );
      }
      const ingredientLeaf = projectBlueprintRecipeIngredientReference(
        value,
        key,
        this.#span(rawSpan),
      );
      if (ingredientLeaf !== undefined) return ingredientLeaf;
      if (value === null || value === undefined) {
        throw new TypeError(`Cannot read properties of ${String(value)}.`);
      }
      return (value as Record<PropertyKey, unknown>)[key];
    },
    bindOutput: (producer: unknown, values: readonly unknown[], rawSpan: RawSpan): unknown => {
      if (!isRawSpan(rawSpan)) throw new Error('.as(...) is missing provenance.');
      if (this.#isNetwork(producer) || this.#isCombinator(producer)) {
        const source = this.#span(rawSpan);
        this.#recordDslCall();
        if (values.length !== 1) {
          throw new ElaborationExecutionError(
            '.as(SIGNAL) requires exactly one output Signal.',
            source,
            'RT2027',
          );
        }
        if (
          !this.#isCombinator(producer) ||
          this.#combinators.stateFor(producer).descriptor.kind !== 'arithmetic'
        ) {
          throw new ElaborationExecutionError(
            '.as(SIGNAL) is available only on a physical Arithmetic combinator.',
            source,
            'RT2021',
          );
        }
        const signal = values[0];
        if (!this.#isSignal(signal)) {
          throw new ElaborationExecutionError(
            '.as(SIGNAL) requires a current-source concrete Signal handle.',
            source,
            'RT2027',
          );
        }
        return this.#withTopologyTransaction(rawSpan, () => {
          this.#combinators.bindOutput(producer, signal, source);
          return producer;
        });
      }
      if (
        (typeof producer !== 'object' && typeof producer !== 'function') ||
        producer === null ||
        typeof (producer as { as?: unknown }).as !== 'function'
      ) {
        throw new Error('.as(...) requires an ordinary .as method; DSL values do not support it.');
      }
      return (producer as { as: (...args: readonly unknown[]) => unknown }).as(...values);
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
            'Entity placement requires a trusted replay context and prototype resolver.',
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
    binary: (
      operator: string,
      left: unknown,
      right: unknown,
      sourceExpressionOrSpan: RawSpan | boolean,
      sourceExpressionSpan?: RawSpan,
    ): unknown => {
      const sourceExpression =
        typeof sourceExpressionOrSpan === 'boolean' && sourceExpressionOrSpan;
      const rawSpan =
        typeof sourceExpressionOrSpan === 'boolean' ? sourceExpressionSpan : sourceExpressionOrSpan;
      if (!isRawSpan(rawSpan)) throw new Error('binary is missing source provenance.');
      if (
        inspectBlueprintRecipeIngredientReference(left) !== undefined ||
        inspectBlueprintRecipeIngredientReference(right) !== undefined
      ) {
        throw new BlueprintParameterError(
          'CP1001',
          '$.ingredient.binaryOperand',
          'recipe ingredient references cannot be used in JavaScript or circuit binary expressions.',
          this.#span(rawSpan),
        );
      }
      if (!sourceExpression) {
        return this.#withEntityReadOperandsTransaction(left, right, rawSpan, () =>
          operators.dispatchBinary(operator, left, right, rawSpan, this.#operatorContext),
        );
      }
      if (operator === '*' && this.#parameterCapture !== undefined) {
        const leftParameter = findBlueprintParameterHandle(left);
        const rightParameter = findBlueprintParameterHandle(right);
        const parameterHandle = leftParameter ?? rightParameter;
        const parameterValue = leftParameter === undefined ? right : left;
        const selection =
          leftParameter !== undefined
            ? this.#parameterDeciderOutputSelection(right)
            : rightParameter !== undefined
              ? this.#parameterDeciderOutputSelection(left)
              : undefined;
        if (parameterHandle !== undefined && selection !== undefined) {
          try {
            const slot = lookupBlueprintParameterSlot(
              parameterValue,
              'number',
              this.#parameterCapture.session,
              '$.deciderOutput.value',
            );
            if (slot === undefined) throw new Error('Numeric parameter handle was not registered.');
            this.#recordDslCall();
            return this.#runtimeValue<ParameterSignalValue>(
              Object.freeze({
                kind: 'parameter-signal-value',
                selection,
                parameter: slot.handle as BlueprintNumberParameterHandle,
              }),
            );
          } catch (error) {
            throw new ElaborationExecutionError(
              error instanceof Error ? error.message : 'Invalid parameterized Decider output.',
              this.#span(rawSpan),
              'RT2027',
              undefined,
              { cause: error },
            );
          }
        }
      }
      const leftExpression = findSourceNumericExpressionView(left);
      const rightExpression = findSourceNumericExpressionView(right);
      const leftParameterLike =
        leftExpression === undefined && findBlueprintParameterHandle(left) !== undefined;
      const rightParameterLike =
        rightExpression === undefined && findBlueprintParameterHandle(right) !== undefined;
      if (
        leftExpression === undefined &&
        rightExpression === undefined &&
        !leftParameterLike &&
        !rightParameterLike
      ) {
        return this.#withEntityReadOperandsTransaction(left, right, rawSpan, () =>
          operators.dispatchBinary(operator, left, right, rawSpan, this.#operatorContext),
        );
      }
      try {
        if (this.#parameterCapture === undefined) {
          throw new Error('Source numeric expressions require an owning parameter session.');
        }
        const expressionOperator =
          operator === '+'
            ? 'add'
            : operator === '-'
              ? 'subtract'
              : operator === '*'
                ? 'multiply'
                : operator === '/'
                  ? 'divide'
                  : operator === '**'
                    ? 'power'
                    : undefined;
        if (expressionOperator === undefined) {
          throw new Error('Source numeric expressions support only +, -, *, /, and ** operators.');
        }
        this.#recordDslCall();
        const expression = createBlueprintNumericExpression(this.#parameterCapture.session, {
          kind: 'binary',
          operator: expressionOperator,
          left: this.#numericExpressionOperand(left, '$.left'),
          right: this.#numericExpressionOperand(right, '$.right'),
        });
        return createSourceNumericExpressionView(
          this.#parameterCapture.session,
          expression,
          this.#span(rawSpan),
        );
      } catch (error) {
        throw new ElaborationExecutionError(
          error instanceof Error ? error.message : 'Invalid source numeric expression.',
          this.#span(rawSpan),
          'RT2027',
          undefined,
          { cause: error },
        );
      }
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

  plan(): DirectElaborationPlan {
    if (this.#status === 'failed') throw this.#firstFailure;
    if (this.#status === 'sealed') {
      throw new Error('The elaboration runtime has already been sealed.');
    }
    try {
      const hasLinkedDecider = this.#linkedProducers.some(
        ({ association }) =>
          association.kind === 'decider' || association.kind === 'pending-decider',
      );
      this.#finalizeUnusedCombinators();
      const producerDescriptors = this.#preparePendingDeciderTemplates();
      const capturedDeclarations = this.#parameterCapture?.declarations() ?? [];
      const missingSignal = capturedDeclarations.find(
        ({ registration }) =>
          registration.kind === 'signal' && registration.defaultValue === undefined,
      );
      if (missingSignal !== undefined && this.#parameterCapture !== undefined) {
        const arithmeticTemplateCaptures = this.#effectiveArithmeticTemplateCaptures();
        this.#resolvedSignalTemplateContext = createSourceSignalTemplateContext(
          this.#parameterCapture.session,
          capturedDeclarations,
          producerDescriptors,
          {
            constants: this.#constantTemplates,
            arithmetics: arithmeticTemplateCaptures,
            deciders: this.#pendingDeciderTemplateCaptures.map(
              ({ producer, captureId, template }) => {
                const descriptor = this.#combinators.stateFor(producer).descriptor;
                return { captureId, template, source: descriptor.source };
              },
            ),
            selectors: this.#selectorTemplates,
          },
        );
      }
      if (this.#hasAutomaticNumberDefaults()) {
        this.#validateAutomaticNumberEntityCoverage();
        this.#resolvedNumberDefaultContext = createProducerNumberDefaultContext(
          this.#parameterCapture!.session,
          this.#parameterCapture!.declarations(),
          producerDescriptors,
        );
      }
      this.#installPendingCombinatorConfigurations();
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
        debugInstances: Object.freeze([
          ...this.#debugInstances,
        ]) as readonly DirectPlanDebugInstance[],
        producers: Object.freeze(
          this.#combinators.states().map((state) => {
            const producer = this.#combinators.toPlan(state);
            let canonicalProducer = producer;
            if (
              hasLinkedDecider &&
              producer.kind === 'decider' &&
              state.descriptor.kind === 'decider'
            ) {
              const outputs = (
                state.descriptor.outputs ??
                (state.descriptor.output === undefined ? [] : [state.descriptor.output])
              ).map((output) => this.#requireConcreteDeciderOutput(output));
              const elseOutputs = (state.descriptor.elseOutputs ?? []).map((output) =>
                this.#requireConcreteDeciderOutput(output),
              );
              canonicalProducer = {
                ...producer,
                outputs,
                outputOrigins: state.descriptor.outputOrigins ?? [],
                ...(state.descriptor.elseOutputs === undefined
                  ? {}
                  : {
                      elseOutputs,
                      elseOutputOrigins: state.descriptor.elseOutputOrigins ?? [],
                    }),
              };
            }
            const linked = this.#linkedProducerByIdentity.get(state.identity);
            return linked === undefined
              ? canonicalProducer
              : Object.freeze({ ...canonicalProducer, entityId: linked.entity.id });
          }),
        ),
        diagnostics: Object.freeze([...this.#diagnostics]),
      };
      for (const authority of this.#entityAuthorityList) {
        if (authority.owner === 'retired') continue;
        for (const facet of authority.facets.values()) {
          this.#assertPhysicalEntityConnectionAtFinalization(
            facet.network,
            facet.source,
            'Entity facet',
          );
        }
        for (const attachment of authority.sharedAttachments) {
          const state = this.#networkState(attachment.network);
          if (state.ownership.consumedAt === undefined) {
            this.#assertPhysicalEntityConnectionAtFinalization(
              attachment.network,
              attachment.source,
              'Entity connector attachment',
            );
          } else if (
            attachment.network.generation !== state.ownership.generation ||
            !this.#networkTransfers.some(({ source }) => source === attachment.network.name)
          ) {
            this.#assertPhysicalEntityConnectionAtFinalization(
              attachment.network,
              attachment.source,
              'Entity connector attachment',
            );
          }
        }
      }
      const entities = this.#entityRegistry?.records() ?? [];
      const canonicalEntities = entities.map((entity) => {
        const linked = this.#linkedProducers.find(
          ({ association }) => association.entity.id === entity.id,
        );
        if (linked === undefined) return entity;
        if (
          linked.association.kind === 'pending-constant' ||
          linked.association.kind === 'pending-arithmetic' ||
          linked.association.kind === 'pending-selector' ||
          linked.association.kind === 'pending-decider'
        ) {
          throw new Error(
            'A pending combinator Entity was not installed before plan construction.',
          );
        }
        if (linked.association.kind === 'constant') {
          return Object.freeze({
            ...entity,
            configuration: {
              mode: 'constant' as const,
              value: linked.association.configuration,
            } satisfies EntityConstantConfiguration,
          });
        }
        if (linked.association.kind === 'arithmetic') {
          const descriptor = this.#combinators.stateFor(linked.producer).descriptor;
          if (descriptor.kind !== 'arithmetic' || 'pendingConfiguration' in descriptor) {
            throw new Error('A linked Arithmetic Entity lost its producer descriptor.');
          }
          const output =
            descriptor.output.kind === 'signal'
              ? {
                  kind: 'signal' as const,
                  signal: this.#signalSnapshot(descriptor.output.signal),
                }
              : descriptor.output;
          return Object.freeze({
            ...entity,
            configuration: {
              ...linked.association.configuration,
              output,
            } satisfies EntityArithmeticConfiguration,
          });
        }
        return Object.freeze({
          ...entity,
          configuration: linked.association.configuration,
        });
      });
      this.#assertNoPendingCombinatorArtifacts(common.producers, canonicalEntities);
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
      const plan: DirectElaborationPlan = {
        ...(entities.length === 0 ? common : entityCommon()),
        entities: Object.freeze([...canonicalEntities]),
      };
      this.#status = 'sealed';
      this.#parameterCapture?.seal();
      return plan;
    } catch (error) {
      this.#parameterCapture?.seal();
      this.#poison(error);
      throw this.#firstFailure;
    }
  }

  arithmeticTemplates(): readonly CapturedArithmeticConfigurationTemplate[] {
    return Object.freeze(
      this.#effectiveArithmeticTemplateCaptures().map(({ captureId, template, source }) =>
        Object.freeze({ captureId, template, source }),
      ),
    );
  }

  #effectiveArithmeticTemplateCaptures(): readonly EffectiveArithmeticConfigurationTemplateCapture[] {
    const session = this.#parameterCapture?.session;
    if (session === undefined) return Object.freeze([]);
    return Object.freeze(
      this.#arithmeticTemplates.map(({ producer, captureId, template, source }) => {
        const ownerDescriptor = this.#combinators.stateFor(producer).descriptor;
        if (ownerDescriptor.kind !== 'arithmetic') {
          throw new Error('A captured Arithmetic template lost its producer descriptor.');
        }
        return Object.freeze({
          captureId,
          producer,
          rawTemplate: template,
          ownerDescriptor,
          template: this.#effectiveArithmeticTemplate(producer, template, session),
          source,
        });
      }),
    );
  }

  #effectiveArithmeticTemplate(
    producer: CombinatorValue,
    template: ArithmeticConfigurationTemplate,
    session = this.#parameterCapture?.session,
  ): ArithmeticConfigurationTemplate {
    if (session === undefined) {
      throw new Error('A captured Arithmetic template has no owning parameter session.');
    }
    const outputBinding = this.#combinators.stateFor(producer).outputBinding;
    return outputBinding === undefined
      ? template
      : createArithmeticConfigurationTemplate(session, {
          left: template.left,
          operation: template.operation,
          right: template.right,
          output: {
            kind: 'signal',
            signal: Signal(
              outputBinding.signal.type,
              outputBinding.signal.name,
              outputBinding.signal.quality,
            ),
          },
        });
  }

  arithmeticOutputBindingCaptureIds(): readonly string[] {
    return Object.freeze(
      this.#arithmeticTemplates
        .filter(({ producer }) => this.#combinators.stateFor(producer).outputBinding !== undefined)
        .map(({ captureId }) => captureId),
    );
  }

  constantTemplates(): readonly CapturedConstantConfigurationTemplate[] {
    return Object.freeze([...this.#constantTemplates]);
  }

  deciderTemplates(): readonly CapturedDeciderConfigurationTemplate[] {
    const parameterCapture = this.#parameterCapture;
    if (parameterCapture === undefined) return Object.freeze([]);
    return Object.freeze(
      this.#pendingDeciderTemplateCaptures.map(({ producer, captureId, template }) => {
        const descriptor = this.#combinators.stateFor(producer).descriptor;
        if (descriptor.kind !== 'decider' || 'pendingConfiguration' in descriptor) {
          throw new Error('A captured Decider template lost its producer descriptor.');
        }
        return Object.freeze({
          captureId,
          template,
          source: Object.freeze({ ...descriptor.source }),
        });
      }),
    );
  }

  #preparePendingDeciderTemplates(): readonly CombinatorDescriptor[] {
    const session = this.#parameterCapture?.session;
    return Object.freeze(
      this.#combinators.states().map(({ identity, descriptor }) => {
        if (descriptor.kind !== 'decider' || !('pendingConfiguration' in descriptor)) {
          return descriptor;
        }
        if (session === undefined) {
          throw new Error('A pending Decider template has no owning parameter session.');
        }
        const outputs =
          descriptor.outputs ??
          (descriptor.output === undefined || descriptor.elseOutputs !== undefined
            ? []
            : [descriptor.output]);
        const template = createDeciderConfigurationTemplate(session, {
          condition: descriptor.pendingConfiguration.condition,
          outputs: outputs.map((output) => this.#deciderTemplateOutput(output)),
          ...(descriptor.elseOutputs === undefined
            ? {}
            : {
                elseOutputs: descriptor.elseOutputs.map((output) =>
                  this.#deciderTemplateOutput(output),
                ),
              }),
        });
        const installationIndex = this.#pendingCombinatorInstallations.findIndex(
          (candidate) => candidate.kind === 'decider' && candidate.producer.identity === identity,
        );
        if (installationIndex >= 0) {
          const installation = this.#pendingCombinatorInstallations[installationIndex]!;
          if (installation.kind !== 'decider') {
            throw new Error('Pending Decider installation changed kind.');
          }
          this.#pendingCombinatorInstallations[installationIndex] = { ...installation, template };
        }
        const captureIndex = this.#pendingDeciderTemplateCaptures.findIndex(
          (candidate) => candidate.producer.identity === identity,
        );
        if (captureIndex >= 0) {
          const capture = this.#pendingDeciderTemplateCaptures[captureIndex]!;
          this.#pendingDeciderTemplateCaptures[captureIndex] = { ...capture, template };
        }
        return { ...descriptor, pendingConfiguration: template };
      }),
    );
  }

  selectorTemplates(): readonly CapturedSelectorConfigurationTemplate[] {
    return Object.freeze([...this.#selectorTemplates]);
  }

  resolvedNumberDefaults(): SourceResolvedNumberDefaultContext | undefined {
    return this.#resolvedNumberDefaultContext;
  }

  resolvedSignalTemplates(): SourceSignalTemplateContext | undefined {
    return this.#resolvedSignalTemplateContext;
  }

  executionApi(): typeof this.api {
    const executionOperations: Record<string, unknown> = { ...this.api };
    if (this.#parameterCapture !== undefined) {
      executionOperations.declareBlueprintNumberParameter = (...args: unknown[]) => {
        if (args.length !== 4 || !isRawSpan(args[3])) {
          throw new Error(
            'Internal number parameter declarations require label, default, metadata, and source span.',
          );
        }
        this.#recordDslCall();
        const handle = this.#parameterCapture!.number(
          args[0],
          args[1],
          args[2],
          this.#span(args[3]),
        );
        return createBlueprintParameterSourceView(this.#parameterCapture!.session, handle);
      };
      executionOperations.declareBlueprintSignalParameter = (...args: unknown[]) => {
        if (args.length !== 4 || !isRawSpan(args[3])) {
          throw new Error(
            'Internal Signal parameter declarations require label, default, metadata, and source span.',
          );
        }
        this.#recordDslCall();
        if (args[1] !== undefined && !this.#isSignal(args[1])) {
          throw new Error('Signal defaults must come from Signal(...) in this execution session.');
        }
        const handle = this.#parameterCapture!.signal(
          args[0],
          args[1] === undefined ? undefined : this.#signalSnapshot(args[1]),
          args[2],
          this.#span(args[3]),
        );
        return createBlueprintParameterSourceView(this.#parameterCapture!.session, handle);
      };
    }
    const wrapped = Object.entries(executionOperations).map(([name, operation]) => [
      name,
      (...args: unknown[]) => {
        const frame: ExecutionApiFrame = { operation: name, dslDomain: false };
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
          if (
            frame.operation === 'unaryMinus' &&
            frame.forwardedNativeUnaryThrow !== undefined &&
            Object.is(frame.forwardedNativeUnaryThrow.value, error)
          ) {
            throw error;
          }
          const recoverable = error instanceof RecoverableElaborationExecutionError;
          const domainFailure =
            !recoverable &&
            (frame.dslDomain ||
              error instanceof ElaborationOperationLimitError ||
              error instanceof ElaborationExecutionError);
          let normalized: unknown = error;
          if (error instanceof BlueprintParameterError) {
            const source = error.span ?? (isRawSpan(rawSpan) ? this.#span(rawSpan) : undefined);
            if (source !== undefined) {
              normalized = new ElaborationExecutionError(
                error.message,
                source,
                error.code,
                undefined,
                { cause: error },
              );
            }
          }
          if (
            !(error instanceof BlueprintParameterError) &&
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
    this.#parameterCapture?.seal();
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
      const ingredientParameter = this.#recipeIngredientMethods.get(callable);
      if (ingredientParameter !== undefined) {
        this.#recordDslCall();
        if (args.length !== 1) {
          throw new BlueprintParameterError(
            'CP1000',
            '$.ingredient.arguments',
            'ingredient(index) requires exactly one non-spread argument.',
            this.#span(rawSpan),
          );
        }
        if (this.#parameterCapture === undefined) {
          throw new BlueprintParameterError(
            'CP1001',
            '$.ingredient.session',
            'recipe ingredient references require their owning source parameter capture.',
            this.#span(rawSpan),
          );
        }
        return this.#parameterCapture.ingredientReference(
          ingredientParameter,
          args[0]!.value,
          this.#span(rawSpan),
        );
      }
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
    const numericFunction = resolveBlueprintNumericFunctionName(callable);
    const hasDirectNumericOperand = args.some(
      ({ value }) =>
        findBlueprintParameterHandle(value) !== undefined ||
        findSourceNumericExpressionView(value) !== undefined,
    );
    if (numericFunction !== undefined && hasDirectNumericOperand) {
      this.#recordDslCall();
      try {
        assertBlueprintNumericFunctionArity(numericFunction, args.length, '$.expression.arguments');
      } catch (error) {
        throw new ElaborationExecutionError(
          error instanceof Error ? error.message : 'Invalid source numeric function arity.',
          this.#span(rawSpan),
          'RT2027',
          undefined,
          { cause: error },
        );
      }
      if (this.#parameterCapture === undefined) {
        throw new ElaborationExecutionError(
          'Source numeric expressions require an owning parameter session.',
          this.#span(rawSpan),
          'RT2027',
        );
      }
      const session = this.#parameterCapture.session;
      const operands: unknown[] = [];
      for (let index = 0; index < args.length; index += 1) {
        const argument = args[index]!;
        try {
          operands.push(this.#numericExpressionOperand(argument.value, `$.arguments[${index}]`));
        } catch (error) {
          throw new ElaborationExecutionError(
            error instanceof Error ? error.message : 'Invalid source numeric function argument.',
            this.#span(argument.source),
            'RT2027',
            undefined,
            { cause: error },
          );
        }
      }
      try {
        const expression = createBlueprintNumericExpression(session, {
          kind: 'call',
          function: numericFunction,
          arguments: operands,
        });
        return createSourceNumericExpressionView(session, expression, this.#span(rawSpan));
      } catch (error) {
        throw new ElaborationExecutionError(
          error instanceof Error ? error.message : 'Invalid source numeric function call.',
          this.#span(rawSpan),
          'RT2027',
          undefined,
          { cause: error },
        );
      }
    }
    const parameterDeclaration =
      findBlueprintParameterHandle(receiver) ??
      args
        .map(({ value }) => findBlueprintParameterHandle(value))
        .find((declaration) => declaration !== undefined);
    if (parameterDeclaration !== undefined) {
      throw new ElaborationExecutionError(
        `Blueprint parameter "${parameterDeclaration.label}" cannot be passed to or invoked as an arbitrary JavaScript function; use it only in a supported direct configuration slot.`,
        this.#span(rawSpan),
        'RT2029',
      );
    }
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
    return this.#withTopologyTransaction(rawSpan, () => {
      const firstInvocation = this.#entityInvocations.get(entity.id);
      if (firstInvocation !== undefined) {
        throw new ElaborationExecutionError(
          'A physical Entity may be invoked only once; reuse its returned view for outputs.',
          source,
          'RT2030',
          [{ message: 'The first Entity invocation originates here.', span: firstInvocation }],
        );
      }
      if (profile.callProjection === undefined && profile.sharedCallConnector === undefined) {
        throw new ElaborationExecutionError(
          `Entity profile ${JSON.stringify(profile.ref.prototypeKey)} has no callable projection.`,
          source,
          'RT2027',
        );
      }
      const sharedConnector = profile.sharedCallConnector;
      if (sharedConnector === undefined ? args.length !== 1 : args.length === 0) {
        throw new ElaborationExecutionError(
          sharedConnector === undefined
            ? 'Callable Entity invocation requires exactly one argument.'
            : 'Shared-call Entity invocation requires at least one input argument.',
          source,
          'RT2027',
        );
      }
      if (sharedConnector === undefined) {
        const argument = args[0]!;
        const readable = this.#readableNetworkFacet(argument.value, argument.source);
        if (readable === undefined) {
          throw new ElaborationExecutionError(
            'Callable Entity input requires a readable Network or Producer output.',
            this.#span(argument.source),
            'RT2015',
          );
        }
        const result = this.#bindEntity(
          entity,
          profile.callProjection!.input.connector,
          profile.callProjection!.input.lane,
          readable,
          'input',
          rawSpan,
        );
        this.#entityInvocations.set(entity.id, source);
        return result;
      }
      for (const argument of args) {
        const readable = this.#readableNetworkFacet(argument.value, argument.source);
        if (readable === undefined) {
          throw new ElaborationExecutionError(
            'Callable Entity input requires a readable Network or Producer output.',
            this.#span(argument.source),
            'RT2015',
          );
        }
        this.#attachSharedEntity(
          entity,
          sharedConnector,
          readable,
          'input',
          this.#rawSpan(argument.source),
        );
      }
      this.#entityInvocations.set(entity.id, source);
      return entity;
    });
  }

  #entityProfile(entity: EntityValue, source: SourceSpan): EntityProfile {
    this.#entityAuthority(entity, source);
    const context = this.#entityContext;
    const registry = this.#entityRegistry;
    if (context === undefined || registry === undefined) {
      throw new ElaborationExecutionError(
        'Entity operation requires a trusted replay context and prototype resolver.',
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
    if (profile.sharedCallConnector !== undefined) {
      return this.#withTopologyTransaction(rawSpan, () => {
        const network = this.#resolveWritableNetwork(
          destination,
          rawSpan,
          'Entity output destination',
        );
        if (network === undefined) {
          throw new ElaborationExecutionError(
            'Callable Entity output requires a writable Network destination.',
            source,
            'RT2015',
          );
        }
        return this.#attachSharedEntity(
          entity,
          profile.sharedCallConnector!,
          network,
          'output',
          rawSpan,
        );
      });
    }
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

  #attachSharedEntity(
    value: unknown,
    connectorKey: EntityPlanSharedConnectorAttachment['connector'],
    network: NetworkValue,
    direction: 'input' | 'output',
    rawSpan: RawSpan,
  ): EntityValue {
    this.#recordDslCall();
    if (!isRawSpan(rawSpan)) throw new Error('t.attachSharedEntity(...) is missing provenance.');
    const source = this.#span(rawSpan);
    const authority = this.#entityAuthority(value, source);
    const profile = this.#entityProfile(authority.entity, source);
    const connector = profile.connectors.find(({ key }) => key === connectorKey);
    if (
      profile.sharedCallConnector !== connectorKey ||
      connector === undefined ||
      connector.direction !== 'bidirectional'
    ) {
      throw new ElaborationExecutionError(
        'Entity profile does not authorize this shared connector attachment.',
        source,
        'RT2031',
      );
    }
    if (direction === 'output') {
      this.#assertWritableNetwork(network, rawSpan, 'Entity output binding Network');
    }
    this.#assertReadableNetworkAt(network, source, 'Entity binding Network');
    const state = this.#networkState(network);
    const ownership = state.ownership;
    const existing = authority.sharedAttachments.find(
      (attachment) =>
        attachment.connector === connectorKey &&
        attachment.direction === direction &&
        this.#networkState(attachment.network).ownership === ownership,
    );
    if (existing !== undefined) {
      if (existing.network.generation !== network.generation) {
        throw new ElaborationExecutionError(
          'Entity connector attachment uses a stale Network generation.',
          source,
          'RT2012',
          [{ message: 'The existing Entity attachment originates here.', span: existing.source }],
        );
      }
      return authority.entity;
    }
    const frame = this.#currentFunctionFrame();
    const locallyOwned =
      frame !== undefined &&
      ownership.owner === frame.owner &&
      network.capability !== 'readonly' &&
      network.capability !== 'ref';
    const attachmentNetwork = locallyOwned
      ? network
      : this.#networkValue(
          {
            kind: 'network',
            name: network.name,
            declaration: network.declaration,
            capability: 'ref',
            generation: network.generation,
          },
          { ownership, ...(state.borrow === undefined ? {} : { borrow: state.borrow }) },
        );
    authority.sharedAttachments.push({
      connector: connectorKey,
      direction,
      provenance: this.#entityBindingProvenance(rawSpan),
      source,
      logicalNetwork: network,
      network: attachmentNetwork,
      locallyOwned,
    });
    this.#syncEntitySharedAttachments(authority);
    return authority.entity;
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
    if (this.#isParameterSignalValue(value)) {
      throw new ElaborationExecutionError(
        't.instantiate(...) cannot retain a pending numeric Decider output value.',
        this.#span(rawSpan),
        'RT2026',
      );
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

  #captureArithmeticTemplate(
    value: CombinatorValue,
    captureId: string,
    template: ArithmeticConfigurationTemplate,
  ): void {
    if (this.#parameterCapture === undefined) return;
    const descriptor = this.#combinators.stateFor(value).descriptor;
    if (descriptor.kind !== 'arithmetic') {
      throw new Error('Arithmetic parameter slots were associated with a non-Arithmetic producer.');
    }
    this.#arithmeticTemplates.push(
      Object.freeze({
        producer: value,
        captureId,
        template,
        source: Object.freeze({ ...descriptor.source }),
      }),
    );
  }

  #hasAutomaticNumberDefaults(): boolean {
    return (
      this.#parameterCapture
        ?.declarations()
        .some(
          ({ registration }) =>
            registration.kind === 'number' && registration.defaultValue === undefined,
        ) ?? false
    );
  }

  #hasDefaultFreeSignalParameters(): boolean {
    return (
      this.#parameterCapture
        ?.declarations()
        .some(
          ({ registration }) =>
            registration.kind === 'signal' && registration.defaultValue === undefined,
        ) ?? false
    );
  }

  #validateAutomaticNumberEntityCoverage(): void {
    const entities = this.#entityRegistry?.records() ?? [];
    const seenEntityIds = new Set<string>();
    const linkedByEntityId = new Map<
      string,
      { readonly producer: CombinatorValue; readonly association: LinkedProducerAssociation }[]
    >();
    for (const linked of this.#linkedProducers) {
      const entityId = linked.association.entity.id;
      const matches = linkedByEntityId.get(entityId) ?? [];
      matches.push(linked);
      linkedByEntityId.set(entityId, matches);
    }

    const expectedFamily = (kind: LinkedProducerAssociation['kind']): string => {
      switch (kind) {
        case 'constant':
        case 'pending-constant':
          return 'constant-combinator';
        case 'arithmetic':
        case 'pending-arithmetic':
          return 'arithmetic-combinator';
        case 'decider':
        case 'pending-decider':
          return 'decider-combinator';
        case 'selector':
        case 'pending-selector':
          return 'selector-combinator';
      }
    };

    for (const [index, entity] of entities.entries()) {
      const path = `$.entities[${index}]`;
      if (seenEntityIds.has(entity.id)) {
        throw new BlueprintParameterError(
          'CP1002',
          path,
          'automatic numeric allocation requires unique physical Entity identities.',
          entity.provenance.source,
        );
      }
      seenEntityIds.add(entity.id);
      const matches = linkedByEntityId.get(entity.id) ?? [];
      if (matches.length !== 1) {
        throw new BlueprintParameterError(
          'CP1002',
          path,
          `automatic numeric allocation requires exactly one supported linked producer for each live Entity; found ${matches.length}.`,
          entity.provenance.source,
        );
      }
      const { producer, association } = matches[0]!;
      const descriptor = this.#combinators.stateFor(producer).descriptor;
      const family = expectedFamily(association.kind);
      if (
        entity.profile.prototypeKey !== `entity:${family}` ||
        descriptor.kind !== family.slice(0, family.indexOf('-'))
      ) {
        throw new BlueprintParameterError(
          'CP1002',
          path,
          'automatic numeric allocation supports only exactly linked Constant, Arithmetic, Decider, and Selector producer Entities.',
          entity.provenance.source,
        );
      }
    }

    for (const [entityId, matches] of linkedByEntityId) {
      if (!seenEntityIds.has(entityId) || matches.length !== 1) {
        const entity = matches[0]?.association.entity;
        throw new BlueprintParameterError(
          'CP1002',
          '$.entities',
          'automatic numeric allocation found a linked producer without exactly one live physical Entity.',
          entity === undefined ? undefined : this.#entityRegistry?.record(entity).provenance.source,
        );
      }
    }
  }

  #installPendingCombinatorConfigurations(): void {
    for (const pending of this.#pendingCombinatorInstallations) {
      const current = this.#linkedProducerByIdentity.get(pending.producer.identity);
      const index = this.#linkedProducers.findIndex(
        ({ producer }) => producer.identity === pending.producer.identity,
      );

      if (pending.kind === 'constant') {
        if (current?.kind !== 'pending-constant' || current.entity !== pending.entity) {
          throw new Error('Pending Constant installation lost its linked Entity association.');
        }
        if (index < 0) {
          throw new Error('Pending Constant installation lost its registration order entry.');
        }
        const constantBindings =
          pending.template === undefined
            ? []
            : [
                ...(this.#resolvedNumberDefaultContext?.bindingsForConstantTemplate(
                  pending.template,
                ) ?? []),
                ...(this.#resolvedSignalTemplateContext?.bindingsForConstantTemplate(
                  pending.template,
                ) ?? []),
              ];
        const skippedParameters = new Set(
          this.#resolvedSignalTemplateContext?.requiredParameters ?? [],
        );
        const recipeIngredientBindings =
          pending.template === undefined
            ? []
            : [
                ...resolveConstantRecipeIngredientReferences(
                  [pending.template],
                  this.#prototypes,
                  [],
                  skippedParameters,
                ),
                ...(this.#resolvedSignalTemplateContext?.bindingsForRecipeIngredientReferences(
                  pending.template,
                ) ?? []),
              ];
        const configuration =
          pending.configuration ??
          (pending.template === undefined
            ? undefined
            : bindConstantConfigurationTemplate(
                pending.template,
                constantBindings,
                recipeIngredientBindings,
              ));
        if (configuration === undefined) {
          throw new Error('Pending Constant installation has no resolved configuration.');
        }
        this.#combinators.installPendingConstant(pending.producer, configuration);
        const association: LinkedConstantAssociation = {
          kind: 'constant',
          entity: pending.entity,
          configuration,
        };
        this.#linkedProducerByIdentity.set(pending.producer.identity, association);
        this.#linkedProducers[index] = { producer: pending.producer, association };
        continue;
      }

      if (pending.kind === 'arithmetic') {
        if (current?.kind !== 'pending-arithmetic' || current.entity !== pending.entity) {
          throw new Error('Pending Arithmetic installation lost its linked Entity association.');
        }
        if (index < 0) {
          throw new Error('Pending Arithmetic installation lost its registration order entry.');
        }
        const arithmeticConfiguration =
          pending.configuration ??
          (pending.template === undefined
            ? undefined
            : (() => {
                const template = this.#effectiveArithmeticTemplate(
                  pending.producer,
                  pending.template,
                );
                return bindArithmeticConfigurationTemplate(template, [
                  ...(this.#resolvedNumberDefaultContext?.bindingsForArithmeticTemplate(template) ??
                    []),
                  ...(this.#resolvedSignalTemplateContext?.bindingsForArithmeticTemplate(
                    template,
                  ) ?? []),
                ]);
              })());
        if (arithmeticConfiguration === undefined) {
          throw new Error('Pending Arithmetic installation has no resolved configuration.');
        }
        this.#combinators.installPendingArithmetic(pending.producer, arithmeticConfiguration);
        const installed = this.#combinators.stateFor(pending.producer).descriptor;
        if (installed.kind !== 'arithmetic' || 'pendingConfiguration' in installed) {
          throw new Error('Pending Arithmetic installation did not produce a concrete descriptor.');
        }
        const configuration: EntityArithmeticConfiguration = {
          mode: 'arithmetic',
          left: this.#canonicalArithmeticOperand(installed.left),
          operation: installed.operation,
          right: this.#canonicalArithmeticOperand(installed.right),
          output:
            installed.output.kind === 'signal'
              ? { kind: 'signal', signal: this.#signalSnapshot(installed.output.signal) }
              : installed.output,
        };
        const association: LinkedArithmeticAssociation = {
          kind: 'arithmetic',
          entity: pending.entity,
          configuration,
        };
        this.#linkedProducerByIdentity.set(pending.producer.identity, association);
        this.#linkedProducers[index] = { producer: pending.producer, association };
        continue;
      }

      if (pending.kind === 'decider') {
        if (current?.kind !== 'pending-decider' || current.entity !== pending.entity) {
          throw new Error('Pending Decider installation lost its linked Entity association.');
        }
        if (index < 0) {
          throw new Error('Pending Decider installation lost its registration order entry.');
        }
        let boundConfiguration: ReturnType<typeof bindDeciderConfigurationTemplate> | undefined;
        if (pending.template !== undefined) {
          try {
            boundConfiguration = bindDeciderConfigurationTemplate(
              pending.template,
              this.#resolvedNumberDefaultContext?.bindingsForDeciderTemplate(pending.template) ??
                [],
            );
          } catch (error) {
            const parameterError =
              error instanceof BlueprintParameterError
                ? error
                : error instanceof Error &&
                    error.name === 'BlueprintParameterError' &&
                    typeof (error as { readonly path?: unknown }).path === 'string'
                  ? (error as BlueprintParameterError)
                  : undefined;
            if (parameterError === undefined) throw error;
            const message = parameterError.message.startsWith(`${parameterError.path}: `)
              ? parameterError.message.slice(parameterError.path.length + 2)
              : parameterError.message;
            throw new ElaborationExecutionError(
              message,
              parameterError.span ?? this.#combinators.stateFor(pending.producer).descriptor.source,
              'RT2027',
              undefined,
              { cause: parameterError },
            );
          }
        }
        const condition =
          boundConfiguration === undefined
            ? pending.condition
            : planDeciderConditionFromLogical(boundConfiguration.condition);
        if (condition === undefined) {
          throw new Error('Pending Decider installation has no resolved condition.');
        }
        const resolvedOutputs = boundConfiguration?.outputs.map((output) =>
          this.#planDeciderOutputFromLogical(output),
        );
        const resolvedElseOutputs = boundConfiguration?.elseOutputs?.map((output) =>
          this.#planDeciderOutputFromLogical(output),
        );
        this.#combinators.installPendingDecider(
          pending.producer,
          condition,
          resolvedOutputs,
          resolvedElseOutputs,
        );
        const installed = this.#combinators.stateFor(pending.producer).descriptor;
        if (installed.kind !== 'decider' || 'pendingConfiguration' in installed) {
          throw new Error('Pending Decider installation did not produce a concrete descriptor.');
        }
        const installedCondition = this.#requireConcreteDeciderCondition(installed.condition);
        const outputs = (
          installed.outputs ?? (installed.output === undefined ? [] : [installed.output])
        ).map((output) => this.#requireConcreteDeciderOutput(output));
        const elseOutputs = (installed.elseOutputs ?? []).map((output) =>
          this.#requireConcreteDeciderOutput(output),
        );
        const configuration: EntityDeciderConfiguration = {
          mode: 'decider',
          condition: installedCondition,
          outputs,
          ...(elseOutputs.length === 0 ? {} : { elseOutputs }),
        };
        const association: LinkedDeciderAssociation = {
          kind: 'decider',
          entity: pending.entity,
          configuration,
        };
        this.#linkedProducerByIdentity.set(pending.producer.identity, association);
        this.#linkedProducers[index] = { producer: pending.producer, association };
        continue;
      }

      if (pending.entity === undefined) {
        if (current !== undefined || index >= 0) {
          throw new Error(
            'Pending Selector installation found an unexpected linked Entity association.',
          );
        }
      } else {
        if (current?.kind !== 'pending-selector' || current.entity !== pending.entity) {
          throw new Error('Pending Selector installation lost its linked Entity association.');
        }
        if (index < 0) {
          throw new Error('Pending Selector installation lost its registration order entry.');
        }
      }

      const selectorConfiguration =
        pending.configuration ??
        (pending.template === undefined
          ? undefined
          : bindSelectorConfigurationTemplate(pending.template, [
              ...(this.#resolvedNumberDefaultContext?.bindingsForSelectorTemplate(
                pending.template,
              ) ?? []),
              ...(this.#resolvedSignalTemplateContext?.bindingsForSelectorTemplate(
                pending.template,
              ) ?? []),
            ]));
      if (selectorConfiguration === undefined) {
        throw new Error('Pending Selector installation has no resolved configuration.');
      }
      this.#combinators.installPendingSelector(pending.producer, selectorConfiguration);
      if (pending.entity !== undefined) {
        const entityConfiguration: EntitySelectorConfiguration =
          selectorConfiguration.operation === 'select'
            ? {
                mode: 'selector',
                operation: 'select',
                input: selectorConfiguration.input,
                selectMax: selectorConfiguration.selectMax,
                index: selectorConfiguration.index,
              }
            : {
                mode: 'selector',
                operation: 'count',
                input: selectorConfiguration.input,
                output: selectorConfiguration.output,
              };
        const association: LinkedSelectorAssociation = {
          kind: 'selector',
          entity: pending.entity,
          configuration: entityConfiguration,
        };
        this.#linkedProducerByIdentity.set(pending.producer.identity, association);
        this.#linkedProducers[index] = { producer: pending.producer, association };
      }
    }
    this.#pendingCombinatorInstallations.length = 0;
  }

  #assertNoPendingCombinatorArtifacts(
    producers: readonly DirectPlanProducer[],
    entities: readonly { readonly configuration?: unknown }[],
  ): void {
    const hasPendingConfiguration = (value: unknown): boolean =>
      typeof value === 'object' && value !== null && Object.hasOwn(value, 'pendingConfiguration');
    const pendingInRuntime =
      this.#pendingCombinatorInstallations.length > 0 ||
      this.#linkedProducers.some(
        ({ association }) =>
          association.kind === 'pending-constant' ||
          association.kind === 'pending-arithmetic' ||
          association.kind === 'pending-selector' ||
          association.kind === 'pending-decider',
      ) ||
      this.#pendingDeciderConditions.size > 0 ||
      this.#combinators.states().some(({ descriptor }) => hasPendingConfiguration(descriptor));
    const pendingInArtifacts =
      producers.some(hasPendingConfiguration) ||
      entities.some(({ configuration }) => hasPendingConfiguration(configuration));
    if (pendingInRuntime || pendingInArtifacts) {
      throw new Error('A pending combinator template or cache escaped into plan artifacts.');
    }
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
        code: diagnosticRuleRegistry['producer.unused-output'].code,
        severity: diagnosticRuleRegistry['producer.unused-output'].defaultSeverity,
        message: 'This combinator output is never read or connected.',
        span: state.descriptor.source,
        ruleId: diagnosticRuleRegistry['producer.unused-output'].ruleId,
        category: diagnosticRuleRegistry['producer.unused-output'].category,
        ...(state.descriptor.instancePath.length === 0
          ? {}
          : { instancePath: state.descriptor.instancePath }),
      });
    }
  }

  #validateFinalDeciderModes(): void {
    for (const state of this.#combinators.states()) {
      if (state.descriptor.kind !== 'decider') continue;
      if ('pendingConfiguration' in state.descriptor) {
        throw new Error('A pending Decider reached final mode validation.');
      }
      const descriptor = state.descriptor;
      const usesEach = conditionUsesEach(
        this.#requireConcreteDeciderCondition(descriptor.condition),
      );
      const branches = [
        {
          outputs: (
            descriptor.outputs ??
            (descriptor.output === undefined || descriptor.elseOutputs !== undefined
              ? []
              : [descriptor.output])
          ).map((output) => this.#requireConcreteDeciderOutput(output)),
          origins: descriptor.outputOrigins,
        },
        {
          outputs: (descriptor.elseOutputs ?? []).map((output) =>
            this.#requireConcreteDeciderOutput(output),
          ),
          origins: descriptor.elseOutputOrigins,
        },
      ] as const;
      for (const { outputs, origins } of branches) {
        for (const [index, output] of outputs.entries()) {
          const eachOutput = output.kind === 'each';
          const everythingOutput =
            (output.kind === 'wildcard-constant' && output.wildcard === 'everything') ||
            (output.kind === 'wildcard' && output.wildcard === 'everything');
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
      code: diagnosticRuleRegistry['function.unrestricted-network-parameter'].code,
      severity: diagnosticRuleRegistry['function.unrestricted-network-parameter'].defaultSeverity,
      message: `Parameter ${parameter} uses an unrestricted Network reference. Use Readonly<Network> for read-only access, Ref<Network> for mutable borrowing, or Move<Network> for ownership transfer.`,
      span: this.#span(declarationSpan),
      ruleId: diagnosticRuleRegistry['function.unrestricted-network-parameter'].ruleId,
      category: diagnosticRuleRegistry['function.unrestricted-network-parameter'].category,
      instancePath: this.#path(),
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

  #createCombinator(
    descriptor: CombinatorDescriptor,
    rawSpan: RawSpan,
    pendingConfiguration?: PendingCombinatorConfiguration,
  ): CombinatorValue {
    if (descriptor.kind === 'decider' && 'pendingConfiguration' in descriptor) {
      throw new Error('Pending Decider descriptors can only be created by the recorder.');
    }
    // A provider-backed arithmetic producer is the ergonomic spelling of the
    // exact Arithmetic constructor. Resolve its trusted base before creating
    // any topology so malformed or ambiguous authority cannot fall through to
    // a modded profile.
    const arithmeticProfile =
      descriptor.kind === 'arithmetic'
        ? this.#resolveCanonicalProfile('Arithmetic', rawSpan)
        : undefined;
    const deciderProfile =
      descriptor.kind === 'decider' &&
      ((descriptor.outputs?.length ?? 0) > 0 || (descriptor.elseOutputs?.length ?? 0) > 0)
        ? this.#resolveCanonicalProfile('Decider', rawSpan)
        : undefined;
    const selectorProfile =
      descriptor.kind === 'selector'
        ? this.#resolveCanonicalProfile('Selector', rawSpan)
        : undefined;
    let registeredDescriptor: CombinatorDescriptor = descriptor;
    let pendingDeciderConditionValue: RuntimeDeciderCondition | undefined;
    const deciderOutputRows =
      descriptor.kind === 'decider'
        ? (descriptor.outputs ??
          (descriptor.output === undefined || descriptor.elseOutputs !== undefined
            ? []
            : [descriptor.output]))
        : [];
    const hasParameterizedDeciderOutput =
      descriptor.kind === 'decider' &&
      [...deciderOutputRows, ...(descriptor.elseOutputs ?? [])].some(
        (output) => output.kind === 'parameter-signal-constant',
      );
    if (
      descriptor.kind === 'decider' &&
      (this.#conditionHasNumberParameter(descriptor.condition) || hasParameterizedDeciderOutput)
    ) {
      const conditionTemplate = this.#deciderConditionTemplate(descriptor.condition);
      if (
        this.#conditionHasNumberParameter(descriptor.condition) &&
        !conditionTemplate.hasNumberParameter
      ) {
        throw new Error('Parameterized Decider condition lost its captured numeric root.');
      }
      const session = this.#parameterCapture?.session;
      if (session === undefined) {
        throw new ElaborationExecutionError(
          'Parameterized Decider construction requires an owning parameter session.',
          this.#span(rawSpan),
          'RT2027',
        );
      }
      const pendingConfiguration = createDeciderConfigurationTemplate(session, {
        condition: conditionTemplate.value,
        outputs: deciderOutputRows.map((output) => this.#deciderTemplateOutput(output)),
        ...(descriptor.elseOutputs === undefined
          ? {}
          : {
              elseOutputs: descriptor.elseOutputs.map((output) =>
                this.#deciderTemplateOutput(output),
              ),
            }),
      });
      pendingDeciderConditionValue = descriptor.condition;
      registeredDescriptor = {
        ...descriptor,
        condition: pendingDeciderCondition(descriptor.condition),
        pendingConfiguration,
      };
    }
    if (
      descriptor.kind === 'selector' &&
      (this.#entityContext !== undefined || this.#entityPrototypeResolver !== undefined) &&
      selectorProfile === undefined
    ) {
      throw new ElaborationExecutionError(
        'Exact Selector configuration requires a trusted base entity:selector-combinator Entity profile.',
        this.#span(rawSpan),
        'RT2027',
      );
    }
    const ordinal = ++this.#combinatorOrdinal;
    const primary = this.#network(`$combinator:${ordinal}:primary`, rawSpan);
    const value = this.#runtimeValue<CombinatorValue>({ kind: 'combinator', identity: {} });
    this.#combinators.register(value, registeredDescriptor, primary, {
      network: primary.name,
      source: this.#span(rawSpan),
      instancePath: this.#path(),
    });
    if (pendingDeciderConditionValue !== undefined) {
      this.#pendingDeciderConditions.set(value.identity, pendingDeciderConditionValue);
    }
    this.#combinatorByOutput.set(this.#networkState(primary).ownership, value);
    this.#colors.registerCombinatorInputs(value.identity, registeredDescriptor);
    let linkedArithmeticEntity: EntityValue | undefined;
    if (arithmeticProfile !== undefined && descriptor.kind === 'arithmetic') {
      const entity = this.#allocateEntity(arithmeticProfile.ref, undefined, undefined, rawSpan);
      linkedArithmeticEntity = entity;
      const association: LinkedProducerAssociation =
        'pendingConfiguration' in descriptor
          ? { kind: 'pending-arithmetic', entity }
          : {
              kind: 'arithmetic',
              entity,
              configuration: {
                mode: 'arithmetic',
                left: this.#canonicalArithmeticOperand(descriptor.left),
                operation: descriptor.operation,
                right: this.#canonicalArithmeticOperand(descriptor.right),
                output:
                  descriptor.output.kind === 'signal'
                    ? {
                        kind: 'signal',
                        signal: this.#signalSnapshot(descriptor.output.signal),
                      }
                    : descriptor.output,
              },
            };
      this.#linkedProducerByIdentity.set(value.identity, association);
      this.#linkedProducers.push({ producer: value, association });
    }
    if (
      registeredDescriptor.kind === 'decider' &&
      ((registeredDescriptor.outputs?.length ?? 0) > 0 ||
        (registeredDescriptor.elseOutputs?.length ?? 0) > 0)
    ) {
      this.#linkDeciderCombinator(value, registeredDescriptor, rawSpan, deciderProfile);
    }
    let linkedSelectorEntity: EntityValue | undefined;
    if (selectorProfile !== undefined && descriptor.kind === 'selector') {
      const entity = this.#allocateEntity(
        selectorProfile.ref,
        undefined,
        descriptor.placement,
        rawSpan,
      );
      linkedSelectorEntity = entity;
      if (descriptor.placement !== undefined) {
        const { placement: _placement, ...withoutPlacement } = descriptor;
        this.#combinators.update(value, withoutPlacement);
      }
      const association: LinkedProducerAssociation =
        'pendingConfiguration' in descriptor
          ? { kind: 'pending-selector', entity }
          : {
              kind: 'selector',
              entity,
              configuration:
                descriptor.operation === 'select'
                  ? {
                      mode: 'selector',
                      operation: 'select',
                      input: descriptor.input,
                      selectMax: descriptor.selectMax,
                      index: descriptor.index,
                    }
                  : {
                      mode: 'selector',
                      operation: 'count',
                      input: descriptor.input,
                      output: descriptor.output,
                    },
            };
      this.#linkedProducerByIdentity.set(value.identity, association);
      this.#linkedProducers.push({ producer: value, association });
    }
    if (descriptor.kind === 'selector' && 'pendingConfiguration' in descriptor) {
      if (
        pendingConfiguration?.kind !== 'selector' ||
        (pendingConfiguration.configuration === undefined &&
          pendingConfiguration.template === undefined)
      ) {
        throw new Error('Pending Selector construction did not retain its prepared configuration.');
      }
      this.#pendingCombinatorInstallations.push({
        kind: 'selector',
        producer: value,
        ...(linkedSelectorEntity === undefined ? {} : { entity: linkedSelectorEntity }),
        ...(pendingConfiguration.configuration === undefined
          ? { template: pendingConfiguration.template! }
          : { configuration: pendingConfiguration.configuration }),
      });
    } else if (pendingConfiguration?.kind === 'selector') {
      throw new Error('A concrete Selector cannot retain a pending configuration cache.');
    }
    if (descriptor.kind === 'arithmetic' && 'pendingConfiguration' in descriptor) {
      if (
        pendingConfiguration?.kind !== 'arithmetic' ||
        linkedArithmeticEntity === undefined ||
        (pendingConfiguration.configuration === undefined &&
          pendingConfiguration.template === undefined)
      ) {
        throw new Error(
          'Pending Arithmetic construction did not retain its bound configuration and Entity.',
        );
      }
      this.#pendingCombinatorInstallations.push({
        kind: 'arithmetic',
        producer: value,
        entity: linkedArithmeticEntity,
        ...(pendingConfiguration.configuration === undefined
          ? { template: pendingConfiguration.template! }
          : { configuration: pendingConfiguration.configuration }),
      });
    } else if (pendingConfiguration?.kind === 'arithmetic') {
      throw new Error('A concrete Arithmetic cannot retain a pending configuration cache.');
    }
    return value;
  }

  #linkDeciderCombinator(
    producer: CombinatorValue,
    descriptor: Extract<CombinatorDescriptor, { kind: 'decider' }>,
    rawSpan: RawSpan,
    resolvedProfile?: EntityProfile,
  ): void {
    const profile = resolvedProfile ?? this.#resolveCanonicalProfile('Decider', rawSpan);
    const outputs =
      descriptor.outputs ?? (descriptor.output === undefined ? [] : [descriptor.output]);
    if (outputs.length === 0 && (descriptor.elseOutputs?.length ?? 0) === 0) return;
    const hasNumberParameter =
      'pendingConfiguration' in descriptor
        ? true
        : this.#conditionHasNumberParameter(descriptor.condition) ||
          [...outputs, ...(descriptor.elseOutputs ?? [])].some(
            (output) => output.kind === 'parameter-signal-constant',
          );
    if (profile === undefined) {
      if (hasNumberParameter) {
        throw new ElaborationExecutionError(
          'Parameterized Decider construction requires a trusted canonical entity:decider-combinator profile.',
          this.#span(rawSpan),
          'RT2027',
        );
      }
      return;
    }
    const existing = this.#linkedProducerByIdentity.get(producer.identity);
    if ('pendingConfiguration' in descriptor) {
      let entity: EntityValue;
      if (existing?.kind === 'decider' || existing?.kind === 'pending-decider') {
        entity = existing.entity;
      } else {
        if (existing !== undefined) return;
        const condition = this.#pendingDeciderConditions.get(producer.identity);
        if (condition === undefined) {
          throw new Error('Pending Decider lost its validated concrete condition before linking.');
        }
        entity = this.#allocateEntity(profile.ref, undefined, descriptor.placement, rawSpan);
        if (descriptor.placement !== undefined) {
          const { placement: _placement, ...withoutPlacement } = descriptor;
          this.#combinators.update(producer, withoutPlacement);
        }
      }
      this.#pendingDeciderConditions.delete(producer.identity);
      const association: LinkedPendingDeciderAssociation = { kind: 'pending-decider', entity };
      this.#linkedProducerByIdentity.set(producer.identity, association);
      const linkedIndex = this.#linkedProducers.findIndex(
        ({ producer: candidate }) => candidate.identity === producer.identity,
      );
      if (linkedIndex >= 0) this.#linkedProducers[linkedIndex] = { producer, association };
      else this.#linkedProducers.push({ producer, association });
      const installationIndex = this.#pendingCombinatorInstallations.findIndex(
        (candidate) =>
          candidate.kind === 'decider' && candidate.producer.identity === producer.identity,
      );
      if (installationIndex < 0) {
        this.#pendingCombinatorInstallations.push({
          kind: 'decider',
          producer,
          entity,
          template: descriptor.pendingConfiguration,
        });
      }
      if (this.#parameterCapture !== undefined) {
        const captureIndex = this.#pendingDeciderTemplateCaptures.findIndex(
          (candidate) => candidate.producer.identity === producer.identity,
        );
        if (captureIndex < 0) {
          const { captureId } = this.#combinators.capture(producer);
          this.#pendingDeciderTemplateCaptures.push({
            producer,
            captureId,
            template: descriptor.pendingConfiguration,
          });
        }
      }
      return;
    }
    const condition = this.#requireConcreteDeciderCondition(descriptor.condition);
    const concreteOutputs = outputs.map((output) => this.#requireConcreteDeciderOutput(output));
    const concreteElseOutputs = (descriptor.elseOutputs ?? []).map((output) =>
      this.#requireConcreteDeciderOutput(output),
    );
    if (existing?.kind === 'decider') {
      const configuration: EntityDeciderConfiguration = {
        mode: 'decider',
        condition,
        outputs: concreteOutputs,
        ...(descriptor.elseOutputs === undefined ? {} : { elseOutputs: concreteElseOutputs }),
      };
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
    const configuration: EntityDeciderConfiguration = {
      mode: 'decider',
      condition,
      outputs: concreteOutputs,
      ...(descriptor.elseOutputs === undefined ? {} : { elseOutputs: concreteElseOutputs }),
    };
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
      // Color requirements replace existing declarations as well as adding Networks.
      networks: [...this.#networks],
      networkStates: new Map(this.#networkStates),
      networkValues: new Map(this.#networkValues),
      networkNameCounts: new Map(this.#networkNameCounts),
      networkAliases: new Map(this.#networkAliases),
      networkTransfersLength: this.#networkTransfers.length,
      combinatorOrdinal: this.#combinatorOrdinal,
      combinatorByOutput: new Map(this.#combinatorByOutput),
      combinators: this.#combinators.snapshot(),
      arithmeticTemplatesLength: this.#arithmeticTemplates.length,
      constantTemplatesLength: this.#constantTemplates.length,
      pendingDeciderTemplateCapturesLength: this.#pendingDeciderTemplateCaptures.length,
      selectorTemplatesLength: this.#selectorTemplates.length,
      debugInstancesLength: this.#debugInstances.length,
      debugInstanceCounts: new Map(this.#debugInstanceCounts),
      ownership: [...ownership.values()],
      colors: this.#colors.clone(),
      ...(this.#entityRegistry === undefined
        ? {}
        : { entityRegistry: this.#entityRegistry.snapshot() }),
      entityRevision: this.#entityRevision,
      entityAuthoritiesLength: this.#entityAuthorityList.length,
      entityFacets: this.#entityAuthorityList.map((authority) => ({
        authority,
        owner: authority.owner,
        ...(authority.retiredAt === undefined ? {} : { retiredAt: authority.retiredAt }),
        facets: new Map([...authority.facets].map(([key, facet]) => [key, { ...facet }])),
        bindings: this.#entityRegistry!.record(authority.entity).connectorBindings,
        sharedAttachments: authority.sharedAttachments.map((attachment) => ({ ...attachment })),
        sharedConnectorAttachments: this.#entityRegistry!.record(authority.entity)
          .sharedConnectorAttachments,
      })),
      entityOperationOrdinal: this.#entityOperationOrdinal,
      entityInvocations: new Map(this.#entityInvocations),
      linkedProducersLength: this.#linkedProducers.length,
      pendingCombinatorInstallationsLength: this.#pendingCombinatorInstallations.length,
      pendingDeciderConditions: new Map(this.#pendingDeciderConditions),
    };
  }

  #restoreTopology(snapshot: TopologySnapshot): void {
    this.#networks.length = 0;
    for (const network of snapshot.networks) this.#networks.push(network);
    this.#networkTransfers.length = snapshot.networkTransfersLength;
    this.#networkStates.clear();
    for (const [name, state] of snapshot.networkStates) this.#networkStates.set(name, state);
    this.#networkValues.clear();
    for (const [name, value] of snapshot.networkValues) this.#networkValues.set(name, value);
    this.#networkNameCounts.clear();
    for (const [name, count] of snapshot.networkNameCounts)
      this.#networkNameCounts.set(name, count);
    this.#networkAliases.clear();
    for (const [key, alias] of snapshot.networkAliases) this.#networkAliases.set(key, alias);
    this.#combinatorOrdinal = snapshot.combinatorOrdinal;
    this.#combinatorByOutput.clear();
    for (const [ownership, combinator] of snapshot.combinatorByOutput) {
      this.#combinatorByOutput.set(ownership, combinator);
    }
    this.#combinators.restore(snapshot.combinators);
    this.#arithmeticTemplates.length = snapshot.arithmeticTemplatesLength;
    this.#constantTemplates.length = snapshot.constantTemplatesLength;
    this.#pendingDeciderTemplateCaptures.length = snapshot.pendingDeciderTemplateCapturesLength;
    this.#selectorTemplates.length = snapshot.selectorTemplatesLength;
    this.#debugInstances.length = snapshot.debugInstancesLength;
    this.#debugInstanceCounts.clear();
    for (const [key, count] of snapshot.debugInstanceCounts)
      this.#debugInstanceCounts.set(key, count);
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
    for (const authority of this.#entityAuthorityList.slice(snapshot.entityAuthoritiesLength)) {
      authority.owner = 'retired';
    }
    this.#entityAuthorityList.length = snapshot.entityAuthoritiesLength;
    for (const saved of snapshot.entityFacets) {
      saved.authority.owner = saved.owner;
      if (saved.retiredAt === undefined) delete saved.authority.retiredAt;
      else saved.authority.retiredAt = saved.retiredAt;
      saved.authority.facets.clear();
      for (const [key, facet] of saved.facets) saved.authority.facets.set(key, facet);
      saved.authority.sharedAttachments.splice(0, saved.authority.sharedAttachments.length);
      saved.authority.sharedAttachments.push(...saved.sharedAttachments);
      this.#entityRegistry!.replaceConnectorBindings(saved.authority.entity, saved.bindings);
      this.#entityRegistry!.replaceSharedConnectorAttachments(
        saved.authority.entity,
        saved.sharedConnectorAttachments ?? [],
      );
    }
    this.#entityOperationOrdinal = snapshot.entityOperationOrdinal;
    this.#entityInvocations.clear();
    for (const [id, source] of snapshot.entityInvocations) this.#entityInvocations.set(id, source);
    while (this.#linkedProducers.length > snapshot.linkedProducersLength) {
      const removed = this.#linkedProducers.pop();
      if (removed !== undefined) this.#linkedProducerByIdentity.delete(removed.producer.identity);
    }
    this.#pendingCombinatorInstallations.length = snapshot.pendingCombinatorInstallationsLength;
    this.#pendingDeciderConditions.clear();
    for (const [identity, condition] of snapshot.pendingDeciderConditions) {
      this.#pendingDeciderConditions.set(identity, condition);
    }
  }

  #withEntityReadTransaction<T>(
    value: unknown,
    source: RawSpan | SourceSpan,
    operation: () => T,
  ): T {
    return this.#isEntity(value)
      ? this.#withTopologyTransaction(this.#rawSpan(source), operation)
      : operation();
  }

  #withEntityReadOperandsTransaction<T>(
    left: unknown,
    right: unknown,
    rawSpan: RawSpan,
    operation: () => T,
  ): T {
    return this.#isEntity(left) || this.#isEntity(right)
      ? this.#withTopologyTransaction(rawSpan, operation)
      : operation();
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
    if (value.capability === 'owned') this.#networkValues.set(value.name, value);
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

  #assertPhysicalEntityConnectionAtFinalization(
    network: NetworkValue,
    source: SourceSpan,
    role: string,
  ): void {
    const state = this.#networkState(network);
    if (
      network.capability === 'ref' &&
      state.ownership.owner === 'lost' &&
      state.ownership.consumedAt === undefined &&
      network.generation === state.ownership.generation
    ) {
      this.#markOutputUsed(network);
      return;
    }
    this.#assertReadableNetworkAt(network, source, role);
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
          moveToFrame: (network, source, frame) => this.#moveNetworkToFrame(network, source, frame),
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
      isOpaqueReturnValue: (item) => findSourceNumericExpressionView(item) !== undefined,
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
    this.#rebaseTransferredSharedAttachments(authority, frame);
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
    for (const attachment of authority.sharedAttachments) {
      if (attachment.locallyOwned && attachment.network.capability === 'ref') {
        throw new ElaborationExecutionError(
          'A borrowed Entity connector attachment cannot escape its function.',
          source,
          'RT2017',
          [{ message: 'Entity connector attached here.', span: attachment.source }],
        );
      }
      if (attachment.locallyOwned)
        this.#ownership.assertReturnable(attachment.network, source, frame);
      else {
        const state = this.#networkState(attachment.network);
        if (state.borrow !== undefined) {
          throw new ElaborationExecutionError(
            'A borrowed Entity connector cannot escape its function.',
            source,
            'RT2017',
            [{ message: 'Entity connector borrowed here.', span: state.borrow.source }],
          );
        }
        this.#ownership.assertReadable(attachment.network, source, 'Entity connector');
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
      sharedAttachments: [],
    };
    const returnedNetworks = new Map<NetworkOwnershipState, NetworkValue>();
    const returnConnectionNetwork = (network: NetworkValue): NetworkValue => {
      const ownership = this.#networkState(network).ownership;
      const existing = returnedNetworks.get(ownership);
      if (existing !== undefined) return existing;
      const returned = this.#returnOwnedNetwork(network, rawSpan, false, false);
      returnedNetworks.set(ownership, returned);
      return returned;
    };
    for (const facet of authority.facets.values()) {
      const ownership = this.#networkState(facet.network).ownership;
      const alreadyReturned = returnedNetworks.get(ownership);
      const network =
        alreadyReturned ??
        (facet.locallyOwned
          ? returnConnectionNetwork(facet.network)
          : this.#networkValue(
              {
                kind: 'network',
                name: facet.network.name,
                declaration: facet.network.declaration,
                capability: 'readonly',
                generation: facet.network.generation,
              },
              { ownership: this.#networkState(facet.network).ownership },
            ));
      returnedAuthority.facets.set(this.#entityEndpointKey(facet.endpoint), {
        ...facet,
        network,
        locallyOwned: this.#networkState(network).ownership.owner === returnedAuthority.owner,
      });
    }
    for (const attachment of authority.sharedAttachments) {
      const ownership = this.#networkState(attachment.network).ownership;
      const alreadyReturned = returnedNetworks.get(ownership);
      const network =
        alreadyReturned ??
        (attachment.locallyOwned
          ? returnConnectionNetwork(attachment.network)
          : this.#networkValue(
              {
                kind: 'network',
                name: attachment.network.name,
                declaration: attachment.network.declaration,
                capability: 'readonly',
                generation: attachment.network.generation,
              },
              { ownership: this.#networkState(attachment.network).ownership },
            ));
      const logicalNetwork =
        attachment.locallyOwned &&
        this.#networkState(attachment.logicalNetwork).ownership ===
          this.#networkState(attachment.network).ownership
          ? network
          : attachment.logicalNetwork;
      returnedAuthority.sharedAttachments.push({
        ...attachment,
        logicalNetwork,
        network,
        locallyOwned: this.#networkState(network).ownership.owner === returnedAuthority.owner,
      });
    }
    authority.owner = 'retired';
    authority.retiredAt = source;
    this.#entityAuthorities.set(returnedEntity, returnedAuthority);
    this.#entityAuthorityList.push(returnedAuthority);
    this.#syncEntityBindings(returnedAuthority);
    this.#syncEntitySharedAttachments(returnedAuthority);
    return returnedEntity;
  }

  #rebaseTransferredSharedAttachments(
    authority: EntityAuthorityView,
    frame: FunctionOwnershipFrame,
  ): void {
    for (const attachment of authority.sharedAttachments) {
      if (!attachment.locallyOwned) continue;
      const logicalState = this.#networkState(attachment.logicalNetwork);
      if (
        logicalState.ownership.consumedAt === undefined ||
        attachment.logicalNetwork.generation !== logicalState.ownership.generation
      ) {
        continue;
      }
      const target = this.#transferredNetworkTarget(attachment.logicalNetwork.name);
      if (target === undefined) continue;
      const targetState = this.#networkState(target);
      if (
        targetState.ownership.consumedAt !== undefined ||
        targetState.ownership.owner !== frame.owner
      ) {
        continue;
      }
      attachment.network = target;
    }
  }

  #rebaseEntityConnectionsToNetwork(network: NetworkValue): void {
    const ownership = this.#networkState(network).ownership;
    for (const authority of this.#entityAuthorityList) {
      if (authority.owner === 'retired') continue;
      let changed = false;
      for (const facet of authority.facets.values()) {
        if (this.#networkState(facet.network).ownership !== ownership) continue;
        facet.network = network;
        facet.locallyOwned = ownership.owner === authority.owner;
        changed = true;
      }
      for (const [index, attachment] of authority.sharedAttachments.entries()) {
        const logicalMatches =
          this.#networkState(attachment.logicalNetwork).ownership === ownership;
        const attachedMatches = this.#networkState(attachment.network).ownership === ownership;
        if (!logicalMatches && !attachedMatches) continue;
        authority.sharedAttachments[index] = {
          ...attachment,
          ...(logicalMatches ? { logicalNetwork: network } : {}),
          ...(attachedMatches ? { network } : {}),
          locallyOwned: ownership.owner === authority.owner,
        };
        changed = true;
      }
      if (changed) {
        this.#syncEntityBindings(authority);
        this.#syncEntitySharedAttachments(authority);
      }
    }
  }

  #moveNetworkToFrame(
    network: NetworkValue,
    source: SourceSpan,
    frame: FunctionOwnershipFrame,
  ): void {
    this.#ownership.moveToFrame(network, source, frame);
    this.#refreshEntityConnectionsForOwnership(this.#networkState(network).ownership, network);
  }

  #refreshEntityConnectionsForOwnership(
    ownership: NetworkRuntimeState['ownership'],
    preferred?: NetworkValue,
  ): void {
    let candidate =
      preferred !== undefined && this.#networkState(preferred).ownership === ownership
        ? preferred
        : [...this.#networkValues.values()].find(
            (network) => this.#networkState(network).ownership === ownership,
          );
    if (candidate === undefined) {
      for (const authority of this.#entityAuthorityList) {
        if (authority.owner === 'retired') continue;
        candidate = [...authority.facets.values()]
          .map(({ network }) => network)
          .find((network) => this.#networkState(network).ownership === ownership);
        candidate ??= authority.sharedAttachments
          .flatMap(({ logicalNetwork, network }) => [logicalNetwork, network])
          .find((network) => this.#networkState(network).ownership === ownership);
        if (candidate !== undefined) break;
      }
    }
    if (candidate === undefined) return;

    const state = this.#networkState(candidate);
    const connection = this.#networkValue(
      {
        kind: 'network',
        name: candidate.name,
        declaration: candidate.declaration,
        capability: 'ref',
        generation: ownership.generation,
      },
      {
        ownership,
        ...(state.borrow === undefined ? {} : { borrow: state.borrow }),
      },
    );
    this.#rebaseEntityConnectionsToNetwork(connection);
  }

  #transferredNetworkTarget(sourceName: string): NetworkValue | undefined {
    let name = sourceName;
    let moved = false;
    const visited = new Set<string>();
    while (true) {
      if (visited.has(name)) return undefined;
      visited.add(name);
      const transfer = this.#networkTransfers.findLast((candidate) => candidate.source === name);
      if (transfer === undefined) break;
      moved = true;
      name = transfer.destination;
    }
    if (!moved) return undefined;
    return this.#networkValues.get(name);
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
    const returned = this.#networkValue(
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
    this.#rebaseEntityConnectionsToNetwork(returned);
    return returned;
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

  #isParameterSignalValue(value: unknown): value is ParameterSignalValue {
    return this.#hasRuntimeKind(value, 'parameter-signal-value');
  }

  #isSection(value: unknown): value is SectionValue {
    return this.#hasRuntimeKind(value, 'section');
  }

  #isSignal(value: unknown): value is SignalHandle {
    return this.#runtimeValues.hasSignal(value);
  }

  #parameterDeciderOutputSelection(value: unknown): ParameterDeciderOutputSelection | undefined {
    if (this.#isSignal(value)) {
      return Object.freeze({ kind: 'signal', signal: this.#signalSnapshot(value) });
    }
    if (this.#isWildcardToken(value) && value.value === 'each') {
      return Object.freeze({ kind: 'each' });
    }
    return undefined;
  }

  #numericExpressionOperand(value: unknown, path: string): unknown {
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) throw new Error('Numeric expression literals must be finite.');
      return { kind: 'literal', value };
    }
    if (this.#isSignal(value)) {
      throw new Error(
        'Numeric expressions accept only finite numbers and owning number parameters.',
      );
    }
    if (this.#isSection(value)) {
      throw new Error('Only finite number * Section is supported for Section values.');
    }
    if (this.#isCircuitDslValue(value)) {
      throw new Error('Circuit arithmetic currently requires a Network or numeric operand.');
    }
    const ingredientReference = inspectBlueprintRecipeIngredientReference(value);
    if (ingredientReference !== undefined) {
      throw new BlueprintParameterError(
        'CP1001',
        path,
        'recipe ingredient references cannot be used in numeric expressions.',
        ingredientReference.source,
      );
    }
    const expressionView = findSourceNumericExpressionView(value);
    if (expressionView !== undefined) {
      if (this.#parameterCapture?.session !== expressionView.session) {
        throw new Error('Source numeric expression belongs to a different parameter session.');
      }
      return expressionView.expression;
    }
    if (this.#parameterCapture === undefined) {
      throw new Error('Source numeric expressions require an owning parameter session.');
    }
    const slot = lookupBlueprintParameterSlot(
      value,
      'number',
      this.#parameterCapture.session,
      path,
    );
    if (slot === undefined) {
      throw new Error(
        'Numeric expressions accept only finite numbers and owning number parameters.',
      );
    }
    if (typeof slot.registration.defaultValue !== 'number') {
      throw new Error('Numeric expressions require a number parameter with a finite default.');
    }
    return { kind: 'parameter', parameter: slot.handle };
  }

  #rejectDerivedNumericExpression(value: unknown, rawSpan: RawSpan): void {
    if (findSourceNumericExpressionView(value) === undefined) return;
    throw new ElaborationExecutionError(
      'A derived source numeric expression can only be consumed in an exact Arithmetic operand, Constant filter-count/multiplier slot, right-hand numeric threshold of a Decider condition, or numeric Selector select index.',
      this.#span(rawSpan),
      'RT2029',
    );
  }

  #rejectParameterControlValue(value: unknown, rawSpan: RawSpan): void {
    this.#rejectDerivedNumericExpression(value, rawSpan);
    const ingredientReference = inspectBlueprintRecipeIngredientReference(value);
    if (ingredientReference !== undefined) {
      throw new BlueprintParameterError(
        'CP1001',
        '$.ingredient.controlValue',
        'recipe ingredient references cannot be used as JavaScript control-flow values.',
        this.#span(rawSpan),
      );
    }
    const declaration = findBlueprintParameterHandle(value);
    if (declaration === undefined) return;
    throw new ElaborationExecutionError(
      `Blueprint parameter "${declaration.label}" cannot be used as a JavaScript control-flow value.`,
      this.#span(rawSpan),
      'RT2029',
    );
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

  #isPrototypeRecordCandidate(value: unknown): boolean {
    return (
      value !== null &&
      typeof value === 'object' &&
      typeof (value as { key?: unknown }).key === 'string'
    );
  }

  #prepareArithmeticConfigurationSource(
    value: unknown,
    source: RawSpan,
    useSite: RawSpan,
  ): BoundArithmeticConfigurationSource {
    let prepared: PreparedArithmeticConfigurationSource;
    try {
      prepared = prepareArithmeticConfigurationSource(
        value,
        {
          normalizeCircuitOperand: (operand, operandSource) =>
            this.#arithmeticOperand(operand as DslValue, operandSource),
          isSignal: (candidate): candidate is SignalId => this.#isSignal(candidate),
          snapshotSignal: (candidate) => this.#signalSnapshot(candidate),
          isEachOutput: (candidate) =>
            this.#isWildcardToken(candidate) && candidate.value === 'each',
        },
        this.#parameterCapture?.session,
        source,
      );
      const deferConfiguration =
        (this.#hasAutomaticNumberDefaults() || this.#hasDefaultFreeSignalParameters()) &&
        prepared.hasParameterSlots &&
        'template' in prepared;
      return {
        ...(deferConfiguration
          ? {}
          : { configuration: bindPreparedArithmeticConfigurationSource(prepared) }),
        prepared,
      };
    } catch (error) {
      if (error instanceof ElaborationExecutionError) throw error;
      if (error instanceof ArithmeticConfigurationSourceError) {
        throw new ElaborationExecutionError(
          error.message,
          this.#span(useSite),
          'RT2027',
          undefined,
          { cause: error.cause ?? error },
        );
      }
      throw new ElaborationExecutionError(
        error instanceof Error ? error.message : 'Invalid Arithmetic configuration.',
        this.#span(source),
        'RT2027',
        undefined,
        { cause: error },
      );
    }
  }

  #defaultSignalForTemplate(value: SignalId | BlueprintSignalParameterHandle): SignalId {
    if (this.#isSignal(value) || isSignalId(value)) return this.#signalSnapshot(value);
    const session = this.#parameterCapture?.session;
    if (session === undefined) {
      throw new Error('Parameterized Signal templates require an owning parameter session.');
    }
    const slot = lookupBlueprintParameterSlot(value, 'signal', session, '$.configuration.signal');
    if (slot === undefined) {
      throw new Error('Parameterized Signal template has no concrete source default.');
    }
    if (slot.registration.defaultValue === undefined) {
      throw new BlueprintParameterError(
        'CP1002',
        '$.configuration.signal',
        `Signal declaration "${slot.registration.label}" without a default is supported only in a direct Constant filter, Selector select-index, Selector count-output, or Arithmetic output Signal slot.`,
        slot.registration.source,
      );
    }
    return this.#signalSnapshot(slot.registration.defaultValue as SignalId);
  }

  #pendingArithmeticTemplateOperand(value: ArithmeticTemplateOperand): PendingArithmeticOperand {
    if (value.kind === 'constant') return { kind: 'constant' };
    const reference =
      value.refKind === 'single'
        ? { refKind: 'single' as const, network: value.network }
        : { refKind: 'pair' as const, networks: value.networks };
    return value.kind === 'signal'
      ? { kind: 'signal', signal: this.#defaultSignalForTemplate(value.signal), ...reference }
      : { kind: 'each', ...reference };
  }

  #createSectionValue(arguments_: readonly CallArgument[], rawSpan: RawSpan): SectionValue {
    if (!Array.isArray(arguments_)) {
      throw new ElaborationExecutionError(
        'Section(...) arguments must be an evaluated argument list.',
        this.#span(rawSpan),
        'RT2027',
      );
    }

    let active = true;
    let group: string | undefined;
    let filterArguments = arguments_;
    const first = arguments_[0];
    const firstIsPlainDataRecord =
      first !== undefined &&
      isPlainDataRecord(first.value) &&
      !this.#isCircuitDslValue(first.value);
    const firstKeys = firstIsPlainDataRecord ? Reflect.ownKeys(first!.value) : [];
    const firstIsFilterMap =
      first !== undefined &&
      firstIsPlainDataRecord &&
      firstKeys.length > 0 &&
      firstKeys.every((key) => {
        if (typeof key !== 'string') return false;
        try {
          parseSignalRef(key);
          return typeof (first.value as Record<string, unknown>)[key] === 'number';
        } catch {
          return false;
        }
      });
    const options =
      first !== undefined &&
      firstIsPlainDataRecord &&
      (firstKeys.length === 0 ||
        firstKeys.some((key) => key === 'active' || key === 'group') ||
        !firstIsFilterMap);

    if (options) {
      const value = first!.value as Record<string, unknown>;
      for (const key of Reflect.ownKeys(value)) {
        if (typeof key !== 'string' || (key !== 'active' && key !== 'group')) {
          throw new ElaborationExecutionError(
            'Section options accept only the active and group fields.',
            this.#span(first!.fieldSources?.[typeof key === 'string' ? key : ''] ?? first!.source),
            'RT2027',
          );
        }
      }
      if (Object.hasOwn(value, 'active')) {
        if (typeof value.active !== 'boolean') {
          throw new ElaborationExecutionError(
            'Section option active must be a boolean.',
            this.#span(first!.fieldSources?.active ?? first!.source),
            'RT2027',
          );
        }
        active = value.active;
      }
      if (Object.hasOwn(value, 'group')) {
        if (typeof value.group !== 'string') {
          throw new ElaborationExecutionError(
            'Section option group must be a string.',
            this.#span(first!.fieldSources?.group ?? first!.source),
            'RT2027',
          );
        }
        group = value.group;
      }
      filterArguments = arguments_.slice(1);
    }

    let filters;
    try {
      filters = normalizeSignalValueSources(
        filterArguments.map((argument) => argument.value),
        {
          isSignal: (value): value is SignalHandle => this.#isSignal(value),
          isSignalValue: (value): value is SignalValue => this.#isSignalValue(value),
        },
        '$.filters',
      );
    } catch (error) {
      if (error instanceof SignalValueSourceError) {
        const match = /^\$\.filters\[(\d+)\]/.exec(error.path);
        const argument = match === null ? undefined : filterArguments[Number(match[1])];
        throw new ElaborationExecutionError(
          error.message,
          this.#span(argument?.source ?? rawSpan),
          'RT2027',
          undefined,
          { cause: error },
        );
      }
      throw error;
    }

    let section;
    try {
      section = canonicalizeConstantConfiguration(
        {
          isOn: true,
          sections: [
            {
              active,
              ...(group === undefined ? {} : { group }),
              multiplier: 1,
              filters: filters.map(({ signal, value }) => ({
                signal: this.#signalSnapshot(signal),
                value,
              })),
            },
          ],
        },
        undefined,
        '$.section',
      ).sections[0]!;
    } catch (error) {
      throw new ElaborationExecutionError(
        error instanceof Error ? error.message : 'Invalid Section configuration.',
        this.#span(rawSpan),
        'RT2027',
        undefined,
        { cause: error },
      );
    }
    return this.#runtimeValues.brandSection(
      Object.freeze({ kind: 'section', section, scaled: false, source: this.#span(rawSpan) }),
    );
  }

  #createConstantFromCallArguments(
    arguments_: readonly CallArgument[],
    rawSpan: RawSpan,
  ): CombinatorValue {
    if (!Array.isArray(arguments_)) {
      throw new ElaborationExecutionError(
        'CC(...) arguments must be an evaluated argument list.',
        this.#span(rawSpan),
        'RT2027',
      );
    }
    const sectionLike = arguments_.map(
      ({ value }) =>
        value !== null &&
        (typeof value === 'object' || typeof value === 'function') &&
        (value as { kind?: unknown }).kind === 'section',
    );
    const sections = arguments_.map(({ value }) => (this.#isSection(value) ? value : undefined));
    if (sectionLike.some(Boolean)) {
      if (sections.some((section) => section === undefined)) {
        const invalidIndex = sections.findIndex((section) => section === undefined);
        throw new ElaborationExecutionError(
          'CC(...) section form accepts only nominal Section values from this execution session.',
          this.#span(arguments_[invalidIndex === -1 ? 0 : invalidIndex]!.source),
          'RT2027',
        );
      }
      const configuration = canonicalizeConstantConfiguration(
        {
          isOn: true,
          sections: sections.map((section) => section!.section),
        },
        undefined,
        '$.configuration',
      );
      return this.#createConstantProducer(configuration, rawSpan, undefined, true);
    }

    const outputs = normalizeSignalValueSources(
      arguments_.map(({ value }) => value),
      {
        isSignal: (value): value is SignalHandle => this.#isSignal(value),
        isSignalValue: (value): value is SignalValue => this.#isSignalValue(value),
      },
    );
    const configuration = constantConfigurationFromOutputs(
      outputs.map(({ signal, value }) => ({ signal: this.#signalSnapshot(signal), value })),
    );
    return this.#createConstantProducer(
      configuration,
      rawSpan,
      outputs.map(({ signal, value }) => ({ signal, value })),
      false,
    );
  }

  #deciderConditionTemplate(condition: RuntimeDeciderCondition): {
    readonly value: DeciderTemplateCondition;
    readonly hasNumberParameter: boolean;
  } {
    const networkReference = (value: PlanNetworkRef) =>
      value.refKind === 'single'
        ? { refKind: 'single' as const, network: value.network as NetworkId }
        : {
            refKind: 'pair' as const,
            networks: [value.networks[0] as NetworkId, value.networks[1] as NetworkId] as const,
          };
    if (condition.kind === 'and' || condition.kind === 'or') {
      const children = condition.conditions.map((child) => this.#deciderConditionTemplate(child));
      return {
        value: { kind: condition.kind, conditions: children.map(({ value }) => value) },
        hasNumberParameter: children.some(({ hasNumberParameter }) => hasNumberParameter),
      };
    }
    if (condition.kind === 'compare-signals') {
      return {
        value: {
          kind: 'compare',
          left: {
            kind: 'signal',
            signal: this.#signalSnapshot(condition.left.signal),
            ...networkReference(condition.left),
          },
          comparator: condition.comparator,
          right: {
            kind: 'signal',
            signal: this.#signalSnapshot(condition.right.signal),
            ...networkReference(condition.right),
          },
        },
        hasNumberParameter: false,
      };
    }
    if (condition.kind === 'compare-wildcard-signal') {
      return {
        value: {
          kind: 'compare',
          left: {
            kind: 'wildcard',
            value: condition.left.wildcard,
            ...networkReference(condition.left),
          },
          comparator: condition.comparator,
          right: {
            kind: 'signal',
            signal: this.#signalSnapshot(condition.right.signal),
            ...networkReference(condition.right),
          },
        },
        hasNumberParameter: false,
      };
    }
    const slot = this.#deciderParameterSlots.get(condition as object);
    const constant =
      slot ??
      ('constant' in condition && typeof condition.constant === 'number'
        ? condition.constant
        : undefined);
    if (constant === undefined) {
      throw new Error('Parameterized Decider condition lost its captured numeric root.');
    }
    const left =
      condition.kind === 'compare-each'
        ? { kind: 'wildcard' as const, value: 'each' as const, ...networkReference(condition) }
        : condition.kind === 'compare-signal'
          ? {
              kind: 'signal' as const,
              signal: this.#signalSnapshot(condition.signal),
              ...networkReference(condition),
            }
          : {
              kind: 'wildcard' as const,
              value: condition.wildcard,
              ...networkReference(condition),
            };
    return {
      value: {
        kind: 'compare',
        left,
        comparator: condition.comparator,
        right: {
          kind: 'constant',
          value: constant,
        },
      },
      hasNumberParameter: slot !== undefined,
    };
  }

  #requireConcreteDeciderCondition(condition: RuntimeDeciderCondition): PlanDeciderCondition {
    if (hasPendingDeciderConstant(condition)) {
      throw new Error('A pending Decider condition reached concrete configuration handling.');
    }
    return condition as PlanDeciderCondition;
  }

  #requireConcreteDeciderOutput(output: RuntimeDeciderOutput): PlanDeciderOutput {
    if (output.kind === 'parameter-signal-constant') {
      throw new Error('A pending Decider output reached concrete configuration handling.');
    }
    return output;
  }

  #planDeciderOutputFromLogical(output: LogicalDeciderOutput): PlanDeciderOutput {
    const reference = (value: LogicalNetworkRef): PlanNetworkRef =>
      value.refKind === 'single'
        ? { refKind: 'single', network: value.network as NetworkId }
        : {
            refKind: 'pair',
            networks: [value.networks[0] as NetworkId, value.networks[1] as NetworkId],
          };
    if (output.mode === 'constant') {
      if (output.signal.kind === 'signal') {
        return {
          kind: 'signal-constant',
          signal: output.signal.signal,
          value: output.value,
        };
      }
      if (output.signal.value === 'each') {
        return { kind: 'each-constant', value: output.value };
      }
      if (output.signal.value === 'anything' || output.signal.value === 'everything') {
        return {
          kind: 'wildcard-constant',
          wildcard: output.signal.value,
          value: output.value,
          ...(output.input === undefined ? {} : { input: reference(output.input) }),
        };
      }
      throw new Error('Unknown wildcard Decider constant output.');
    }
    if (output.input === undefined) {
      throw new Error('A Decider copy output has no validated input topology.');
    }
    const input = reference(output.input);
    if (output.signal.kind === 'signal') {
      return { kind: 'signal', signal: output.signal.signal, ...input };
    }
    if (output.signal.value === 'each') return { kind: 'each', ...input };
    return { kind: 'wildcard', wildcard: output.signal.value, ...input };
  }

  #deciderTemplateOutput(output: RuntimeDeciderOutput): DeciderTemplateOutput {
    if (output.kind === 'parameter-signal-constant') {
      return {
        mode: 'constant',
        signal:
          output.selection.kind === 'signal'
            ? { kind: 'signal', signal: this.#signalSnapshot(output.selection.signal) }
            : { kind: 'wildcard', value: 'each' },
        value: output.parameter,
      };
    }
    const input =
      output.kind === 'wildcard-constant'
        ? output.input === undefined
          ? undefined
          : output.input.refKind === 'single'
            ? { refKind: 'single' as const, network: output.input.network as NetworkId }
            : {
                refKind: 'pair' as const,
                networks: [
                  output.input.networks[0] as NetworkId,
                  output.input.networks[1] as NetworkId,
                ] as const,
              }
        : 'refKind' in output
          ? output.refKind === 'single'
            ? { refKind: 'single' as const, network: output.network as NetworkId }
            : {
                refKind: 'pair' as const,
                networks: [
                  output.networks[0] as NetworkId,
                  output.networks[1] as NetworkId,
                ] as const,
              }
          : undefined;
    const signal =
      output.kind === 'signal' || output.kind === 'signal-constant'
        ? { kind: 'signal' as const, signal: this.#signalSnapshot(output.signal) }
        : {
            kind: 'wildcard' as const,
            value:
              output.kind === 'each' || output.kind === 'each-constant'
                ? ('each' as const)
                : output.wildcard,
          };
    if (
      output.kind === 'signal-constant' ||
      output.kind === 'each-constant' ||
      output.kind === 'wildcard-constant'
    ) {
      return {
        mode: 'constant',
        signal,
        value: output.value,
        ...(input === undefined ? {} : { input }),
      };
    }
    return { mode: 'copy', signal, ...(input === undefined ? {} : { input }) };
  }

  #captureSelectorTemplate(
    value: CombinatorValue,
    captureId: string,
    template: SelectorConfigurationTemplate,
  ): void {
    if (this.#parameterCapture === undefined) return;
    const descriptor = this.#combinators.stateFor(value).descriptor;
    if (descriptor.kind !== 'selector' || descriptor.operation !== template.operation) {
      throw new Error('Selector template was associated with a mismatched producer.');
    }
    this.#selectorTemplates.push(
      Object.freeze({ captureId, template, source: Object.freeze({ ...descriptor.source }) }),
    );
  }

  #normalizeDeciderConfigurationSource(
    value: unknown,
    source: RawSpan,
    fieldSources?: CallArgument['fieldSources'],
  ): NormalizedDeciderConfiguration {
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
    this.#deciderConditionTemplate(conditionValue.condition);
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
      this.#isParameterSignalValue(value) ||
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

  #resolveCanonicalProfile(
    family: 'Arithmetic' | 'Decider' | 'Selector' | 'Constant',
    rawSpan: RawSpan,
  ): EntityProfile | undefined {
    const prototypeName = `${family.toLowerCase()}-combinator`;
    const prototypeKey = `entity:${prototypeName}`;
    const context = this.#entityContext;
    const resolver = this.#entityPrototypeResolver;
    if (context === undefined || resolver === undefined) return undefined;
    const candidates = context.profiles.filter(({ ref }) => ref.prototypeKey === prototypeKey);
    if (candidates.length === 0) return undefined;
    if (candidates.length > 1) {
      throw new ElaborationExecutionError(
        `The trusted provider exposes ambiguous base ${prototypeName} profiles.`,
        this.#span(rawSpan),
        'RT2027',
      );
    }
    const profile = candidates[0]!;
    if (profile.prototypeType !== prototypeName) {
      throw new ElaborationExecutionError(
        `The trusted base ${prototypeName} profile does not assert prototypeType "${prototypeName}".`,
        this.#span(rawSpan),
        'RT2027',
      );
    }
    let prototype: EntityPrototype | undefined;
    try {
      prototype = resolver.getEntity(profile.ref.prototypeKey);
    } catch (error) {
      throw new ElaborationExecutionError(
        error instanceof Error ? error.message : `${family} prototype lookup failed.`,
        this.#span(rawSpan),
        'RT2027',
        undefined,
        { cause: error },
      );
    }
    if (prototype === undefined) {
      throw new ElaborationExecutionError(
        `Trusted ${family} profile ${JSON.stringify(profile.ref.prototypeKey)} is not available in the selected provider.`,
        this.#span(rawSpan),
        'RT2027',
      );
    }
    if (
      prototype.key !== profile.ref.prototypeKey ||
      prototype.name !== prototypeName ||
      prototype.type !== prototypeName
    ) {
      throw new ElaborationExecutionError(
        `Trusted ${family} profile ${JSON.stringify(profile.ref.prototypeKey)} does not match base provider prototype data.`,
        this.#span(rawSpan),
        'RT2027',
      );
    }
    return profile;
  }

  #createConstantProducer(
    configuration: ConstantConfiguration | undefined,
    rawSpan: RawSpan,
    outputs: readonly { readonly signal: SignalId; readonly value: number }[] | undefined,
    exact: boolean,
    pendingConfiguration?: ConstantConfigurationTemplate,
  ): CombinatorValue {
    const profile = this.#resolveCanonicalProfile('Constant', rawSpan);
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
        ...(exact
          ? pendingConfiguration === undefined
            ? { configuration: configuration! }
            : { pendingConfiguration }
          : {
              outputs: (outputs ?? []).map(({ signal, value }) => ({
                signal: this.#signalSnapshot(signal),
                value,
              })),
            }),
        source: this.#span(rawSpan),
        instancePath: this.#path(),
      },
      rawSpan,
    );
    if (entity !== undefined) {
      const association: LinkedProducerAssociation =
        pendingConfiguration === undefined
          ? { kind: 'constant', entity, configuration: configuration! }
          : { kind: 'pending-constant', entity };
      this.#linkedProducerByIdentity.set(producer.identity, association);
      this.#linkedProducers.push({ producer, association });
      if (pendingConfiguration !== undefined) {
        this.#pendingCombinatorInstallations.push({
          kind: 'constant',
          producer,
          entity,
          ...(configuration === undefined ? { template: pendingConfiguration } : { configuration }),
        });
      }
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
        'Entity construction requires a trusted replay context and prototype resolver.',
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
        sharedAttachments: [],
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
        'Entity construction requires a trusted replay context and prototype resolver.',
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
        'Entity operation requires a trusted replay context and prototype resolver.',
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

  #syncEntitySharedAttachments(authority: EntityAuthorityView): void {
    this.#entityRegistry?.replaceSharedConnectorAttachments(
      authority.entity,
      authority.sharedAttachments.map(({ connector, logicalNetwork, direction, provenance }) => ({
        connector,
        network: logicalNetwork.name,
        generation: logicalNetwork.generation,
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

  #sharedEntityReadableNetworkFacet(
    entity: EntityValue,
    profile: EntityProfile,
    rawSpan: RawSpan,
  ): NetworkValue {
    const source = this.#span(rawSpan);
    const authority = this.#entityAuthority(entity, source);
    const connectorKey = profile.sharedCallConnector;
    if (connectorKey === undefined || !profile.connectors.some(({ key }) => key === connectorKey)) {
      throw new ElaborationExecutionError(
        'Entity profile does not authorize its shared connector read projection.',
        source,
        'RT2031',
      );
    }

    const attachments = [
      ...authority.sharedAttachments
        .filter((attachment) => attachment.connector === connectorKey)
        .map((attachment) => ({
          direction: attachment.direction,
          logicalNetwork: attachment.logicalNetwork,
          network: attachment.network,
          source: attachment.source,
        })),
      ...[...authority.facets.values()]
        .filter((facet) => facet.endpoint.connector === connectorKey)
        .map((facet) => ({
          direction: facet.direction,
          logicalNetwork: facet.network,
          network: facet.network,
          source: facet.source,
        })),
    ];
    const byDirection: Record<
      'input' | 'output',
      Map<NetworkOwnershipState, { network: NetworkValue; sources: SourceSpan[] }>
    > = {
      input: new Map(),
      output: new Map(),
    };

    for (const attachment of attachments) {
      const attachmentState = this.#networkState(attachment.network);
      let network = attachment.network;
      if (
        attachmentState.ownership.consumedAt !== undefined ||
        network.generation !== attachmentState.ownership.generation
      ) {
        const target =
          this.#transferredNetworkTarget(attachment.logicalNetwork.name) ??
          this.#transferredNetworkTarget(network.name);
        if (target !== undefined) {
          const targetState = this.#networkState(target);
          network = this.#networkValue(
            {
              kind: 'network',
              name: target.name,
              declaration: target.declaration,
              capability: attachment.network.capability,
              generation: target.generation,
            },
            {
              ownership: targetState.ownership,
              ...(targetState.borrow === undefined ? {} : { borrow: targetState.borrow }),
            },
          );
        }
      }
      this.#assertReadableNetworkAt(network, source, 'Entity connector attachment');
      const ownership = this.#networkState(network).ownership;
      const role = byDirection[attachment.direction];
      const existing = role.get(ownership);
      if (existing === undefined) {
        role.set(ownership, { network, sources: [attachment.source] });
      } else {
        existing.sources.push(attachment.source);
      }
    }

    const outputs = [...byDirection.output.values()];
    if (outputs.length > 1) {
      throw new ElaborationExecutionError(
        'Shared Entity has more than one distinct output Network.',
        source,
        'RT2032',
        outputs.flatMap(({ sources }) =>
          sources.map((span) => ({ message: 'Output attachment originates here.', span })),
        ),
      );
    }
    if (outputs.length === 1) return outputs[0]!.network;

    const inputs = [...byDirection.input.values()];
    if (inputs.length === 1) {
      const output = this.#network(`$entity-read:${authority.entity.id}`, rawSpan);
      this.#attachSharedEntity(authority.entity, connectorKey, output, 'output', rawSpan);
      return output;
    }

    throw new ElaborationExecutionError(
      inputs.length === 0
        ? 'Shared Entity has no connected Network from which to infer an output.'
        : 'Shared Entity input attachments do not identify one unambiguous output Network.',
      source,
      'RT2032',
      inputs.flatMap(({ sources }) =>
        sources.map((span) => ({ message: 'Input attachment originates here.', span })),
      ),
    );
  }

  #readableNetworkFacet(value: unknown, source: RawSpan | SourceSpan): NetworkValue | undefined {
    if (this.#isEntity(value)) {
      const rawSpan = this.#rawSpan(source);
      const profile = this.#entityProfile(value, this.#sourceSpan(source));
      if (profile.sharedCallConnector !== undefined) {
        return this.#withTopologyTransaction(rawSpan, () =>
          this.#sharedEntityReadableNetworkFacet(value, profile, rawSpan),
        );
      }
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

  #conditionHasNumberParameter(condition: RuntimeDeciderCondition): boolean {
    if (condition.kind === 'and' || condition.kind === 'or') {
      return condition.conditions.some((child) => this.#conditionHasNumberParameter(child));
    }
    return this.#deciderParameterSlots.has(condition as object);
  }

  #assertNoParameterizedNegatedCondition(
    condition: RuntimeDeciderCondition,
    rawSpan: RawSpan,
  ): void {
    if (this.#conditionHasNumberParameter(condition)) {
      throw new ElaborationExecutionError(
        'Source number parameters and derived numeric expressions are not supported in negated Decider conditions.',
        this.#span(rawSpan),
        'RT2027',
      );
    }
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
    const alreadyPending = 'pendingConfiguration' in state.descriptor;
    const hasParameterizedOutput = [...normal.outputs, ...alternate.outputs].some(
      (output) => output.kind === 'parameter-signal-constant',
    );
    if (!alreadyPending && hasParameterizedOutput) {
      const session = this.#parameterCapture?.session;
      if (session === undefined) {
        throw new ElaborationExecutionError(
          'Parameterized Decider outputs require an owning parameter session.',
          this.#span(rawSpan),
          'RT2027',
        );
      }
      const conditionTemplate = this.#deciderConditionTemplate(descriptor.condition);
      const pendingConfiguration = createDeciderConfigurationTemplate(session, {
        condition: conditionTemplate.value,
        outputs: normal.outputs.map((output) => this.#deciderTemplateOutput(output)),
        ...(alternate.outputs.length === 0
          ? {}
          : {
              elseOutputs: alternate.outputs.map((output) => this.#deciderTemplateOutput(output)),
            }),
      });
      this.#combinators.deferPendingDecider(value, {
        ...descriptor,
        condition: pendingDeciderCondition(descriptor.condition),
        pendingConfiguration,
      });
      this.#pendingDeciderConditions.set(value.identity, descriptor.condition);
    } else {
      this.#combinators.update(value, descriptor, this.#span(rawSpan));
    }
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
    readonly outputs: readonly RuntimeDeciderOutput[];
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
    if (
      this.#isSignalValue(output) ||
      this.#isParameterSignalValue(output) ||
      this.#isWildcardCount(output)
    )
      return 'explicit-constant';
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

  #deciderOutput(output: unknown, rawSpan: RawSpan): RuntimeDeciderOutput {
    if (this.#isParameterSignalValue(output)) {
      return {
        kind: 'parameter-signal-constant',
        selection: output.selection,
        parameter: output.parameter,
      };
    }
    if (this.#isSignalValue(output)) {
      return { kind: 'signal-constant', signal: output.signal, value: output.value };
    }
    if (this.#isWildcardCount(output)) {
      if (output.wildcard === 'each') return { kind: 'each-constant', value: output.value };
      return {
        kind: 'wildcard-constant',
        wildcard: output.wildcard,
        value: output.value,
      };
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
        this.#isParameterSignalValue(candidate) ||
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
      this.#isParameterSignalValue(value) ||
      this.#isSection(value) ||
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
  parameterCapture?: BlueprintParameterCapture,
): {
  readonly plan: DirectElaborationPlan;
  readonly resolvedNumberDefaults?: SourceResolvedNumberDefaultContext;
  readonly resolvedSignalTemplates?: SourceSignalTemplateContext;
  readonly arithmeticTemplates: readonly CapturedArithmeticConfigurationTemplate[];
  readonly boundArithmeticOutputCaptureIds: readonly string[];
  readonly constantTemplates: readonly CapturedConstantConfigurationTemplate[];
  readonly deciderTemplates: readonly CapturedDeciderConfigurationTemplate[];
  readonly selectorTemplates: readonly CapturedSelectorConfigurationTemplate[];
} {
  if (program.format !== 'comblang-elaboration-js') {
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
    parameterCapture,
  );
  try {
    Function(program.runtimeParameter, `"use strict";\n${program.code}`)(recorder.executionApi());
  } catch (error) {
    recorder.closeAfterExecution();
    throw error;
  }
  const plan = recorder.plan();
  const resolvedNumberDefaults = recorder.resolvedNumberDefaults();
  const resolvedSignalTemplates = recorder.resolvedSignalTemplates();
  return Object.freeze({
    plan,
    ...(resolvedNumberDefaults === undefined ? {} : { resolvedNumberDefaults }),
    ...(resolvedSignalTemplates === undefined ? {} : { resolvedSignalTemplates }),
    arithmeticTemplates: recorder.arithmeticTemplates(),
    boundArithmeticOutputCaptureIds: recorder.arithmeticOutputBindingCaptureIds(),
    constantTemplates: recorder.constantTemplates(),
    deciderTemplates: recorder.deciderTemplates(),
    selectorTemplates: recorder.selectorTemplates(),
  });
}

/** Executes the canonical source path and preserves the host-supplied replay context. */
export function executeElaborationProgram(
  program: ElaborationJavaScript,
  options: ElaborationExecutionOptions = {},
): DirectElaborationPlan {
  return executeElaborationProgramInternal(program, options).plan;
}

/** Host-local test/preparation seam; deliberately omitted from the runtime package barrel. */
export interface ExecutedElaborationWithBlueprintParameters {
  readonly plan: DirectElaborationPlan;
  readonly session: BlueprintParameterSession;
  readonly parameters: readonly CapturedBlueprintParameter[];
  readonly resolvedNumberDefaults?: SourceResolvedNumberDefaultContext;
  readonly resolvedSignalTemplates?: SourceSignalTemplateContext;
  readonly arithmeticTemplates: readonly CapturedArithmeticConfigurationTemplate[];
  readonly boundArithmeticOutputCaptureIds: readonly string[];
  readonly constantTemplates: readonly CapturedConstantConfigurationTemplate[];
  readonly deciderTemplates: readonly CapturedDeciderConfigurationTemplate[];
  readonly selectorTemplates: readonly CapturedSelectorConfigurationTemplate[];
}

/** Executes once and returns parameter capture beside, never inside, the concrete plan. */
export function executeElaborationProgramWithParameters(
  program: ElaborationJavaScript,
  options: ElaborationExecutionOptions = {},
): ExecutedElaborationWithBlueprintParameters {
  const capture = new BlueprintParameterCapture();
  try {
    const execution = executeElaborationProgramInternal(program, options, capture);
    return Object.freeze({
      ...execution,
      session: capture.session,
      parameters: capture.declarations(),
    });
  } catch (error) {
    capture.seal();
    throw error;
  }
}

import { transformElaborationModule } from '@comblang/compiler/elaboration-transform';
import type { DirectElaborationPlan } from '@comblang/compiler/direct-plan-schema';
import type { LogicalDeciderCondition, NativeCircuitIr } from '@comblang/compiler/ir';
import { signal, signalKey, type SignalId } from '@comblang/factorio';
import {
  cloneEntityReplayContextTransport,
  entityReplayContextIdentity,
  entityReplayContextTransport,
  EntityReplayContextError,
  type EntityReplayContextTransport,
  type TrustedEntityReplayContext,
} from '@comblang/compiler/entity-replay-context';
import {
  classifyDslSemantics,
  parseFile,
  summarizeTopLevel,
  validateDslSemantics,
  type ParsedSourceFile,
  type ParseWorkerResult,
  type SourceFileSnapshot,
} from '@comblang/language';
import type { PrototypeProvider } from '@comblang/prototypes';
import {
  parseDiagnosticPolicy,
  resolveDiagnostics,
  type Diagnostic,
  type DiagnosticPolicy,
} from '@comblang/shared';

import type { ExecutedDirectPlan } from './direct-plan.js';
import { tryElaborateDirectPlan as tryCanonicalDirectPlan } from './direct-plan.js';
import { executeElaborationProgram } from './elaboration-program.js';
import type { EntityPrototypeResolver } from './entity-registry.js';
import { executionFailureDiagnostic } from './execution-diagnostic.js';
import type { ResolvedCircuit } from '@comblang/compiler/resolved-circuit';
import {
  canonicalDirectPlan,
  canonicalResolvedCircuit,
  canonicalizeCompilationArtifacts,
} from './canonical-circuit.js';
import {
  bindCapturedSourceConfigurationTemplates,
  bindCapturedSourceConfigurationTemplatesWithRelations,
} from './executed-blueprint-configuration-binding.js';
import { materializeCapturedPlan } from './source-configuration-materialization.js';
import { executeResolvedDirectPlan } from './direct-plan.js';
import {
  readBlueprintParameterBindings,
  type BlueprintParameterBinding,
} from '../../compiler/src/blueprint-parameter-validation.js';
import {
  executeElaborationProgramWithParameters,
  type ExecutedElaborationWithBlueprintParameters,
} from './elaboration-program.js';
import {
  BlueprintParameterError,
  canonicalBlueprintParameterHandle,
  type BlueprintParameterHandle,
  type BlueprintParameterKind,
  type BlueprintNumberParameterMetadata,
} from '../../compiler/src/blueprint-parameters.js';
import { inspectConstantConfigurationTemplate } from '../../compiler/src/constant-configuration-template.js';
import { inspectArithmeticConfigurationTemplate } from '../../compiler/src/arithmetic-configuration-template.js';
import {
  inspectDeciderConfigurationTemplate,
  type DeciderTemplateCondition,
} from '../../compiler/src/decider-configuration-template.js';
import { nativeDeciderConditionGroups } from '../../compiler/src/native-decider-conditions.js';
import { inspectSelectorConfigurationTemplate } from '../../compiler/src/selector-configuration-template.js';
import {
  inspectRegisteredBlueprintNumericExpression,
  isRegisteredBlueprintNumericExpression,
} from '../../compiler/src/blueprint-numeric-expression-bridge.js';
import {
  buildNativeBlueprintFcir,
  type NativeBlueprintProjectionOptions,
} from '../../compiler/src/native-blueprint-projector.js';
import {
  validateNativeBlueprintFcir,
  type NativeBlueprintFcir,
  type NativeBlueprintJsonObject,
  type NativeBlueprintParameter,
} from '../../compiler/src/native-blueprint-ir.js';
import {
  createNativeNumericFormulaRenderer,
  type MeasuredNativeNumericFormula,
} from './source-native-numeric-formulas.js';
import type { SourceSpan } from '@comblang/shared';

export interface SourceCompilationEnvironment {
  /** Normalized project policy applied only to the final returned diagnostics. */
  readonly diagnosticPolicy?: DiagnosticPolicy;
  readonly prototypes?: PrototypeProvider;
  /** Identity-only, cloneable replay context; host providers and Entity handles stay local. */
  readonly entityReplayContext?: EntityReplayContextTransport;
  /** Host-only profile set used to validate a provider context before transport. */
  readonly trustedEntityReplayContext?: TrustedEntityReplayContext;
  /** Host-only resolver used by synthetic or otherwise injected Entity environments. */
  readonly entityPrototypeResolver?: EntityPrototypeResolver;
}

/** Serializable result safe to send through a browser Worker boundary. */
export interface SourceCompilationArtifact extends ParseWorkerResult {
  /** Every compilation-stage diagnostic in stable execution order. */
  readonly pipelineDiagnostics: readonly Diagnostic[];
  /** Non-parser diagnostics retained for compatibility with parser clients. */
  readonly compilerDiagnostics: readonly Diagnostic[];
  readonly executionMode: 'executed-javascript';
  readonly prototypeIdentity?: string;
  readonly entityReplayContext?: EntityReplayContextTransport;
  /** Future result-cache identity; no compilation-result cache consumes it yet. */
  readonly entityReplayIdentity?: string;
  /** IDs of used Signal declarations that require an explicit test binding. */
  readonly requiredParameterIds?: readonly number[];
  readonly elaborationJavaScript?: string;
  readonly plan?: DirectElaborationPlan;
  /** Detached physical IR; present only after host-authorized lowering succeeds. */
  readonly resolvedCircuit?: ResolvedCircuit;
}

/** Host-local compilation state. Runtime handles never enter the transport artifact. */
export interface LocalSourceCompilation extends SourceCompilationArtifact {
  readonly execution?: ExecutedDirectPlan;
}

/** A source declaration exposed only to the host that owns this compilation result. */
export interface SourceCompilationParameter {
  readonly parameter: BlueprintParameterHandle;
  readonly kind: BlueprintParameterKind;
  readonly label: string;
  readonly defaultValue?: number | SignalId;
  readonly source: SourceSpan;
  readonly metadata?: BlueprintNumberParameterMetadata;
}

const capturedParametersByCompilation = new WeakMap<
  object,
  {
    readonly source: ExecutedElaborationWithBlueprintParameters;
    readonly execution?: ExecutedDirectPlan;
    readonly plan?: DirectElaborationPlan;
    readonly resolvedCircuit?: ResolvedCircuit;
  }
>();
const parameterSourceArtifacts = new WeakSet<object>();

export type SourceCompilationStage = 'parse' | 'semantic' | 'transform' | 'execute' | 'lower';

export type SourceCompilationObserver = (stage: SourceCompilationStage) => void;

function replayTransport(
  environment: SourceCompilationEnvironment,
): EntityReplayContextTransport | undefined {
  const transport =
    environment.entityReplayContext === undefined
      ? environment.trustedEntityReplayContext === undefined
        ? undefined
        : entityReplayContextTransport(environment.trustedEntityReplayContext)
      : cloneEntityReplayContextTransport(environment.entityReplayContext);
  if (transport === undefined) return undefined;

  if (environment.trustedEntityReplayContext !== undefined) {
    const expected = entityReplayContextTransport(environment.trustedEntityReplayContext);
    if (entityReplayContextIdentity(transport) !== entityReplayContextIdentity(expected)) {
      throw new EntityReplayContextError(
        'ER1001',
        '$.entityReplayContext',
        'transport does not match the trusted profile-set context.',
      );
    }
  }
  if (transport.source === 'provider' && environment.trustedEntityReplayContext === undefined) {
    throw new EntityReplayContextError(
      'ER1001',
      '$.entityReplayContext.profileSetIdentity',
      'provider replay contexts require a host-bound trusted profile set.',
    );
  }
  if (environment.prototypes !== undefined) {
    if (
      environment.prototypes.schemaVersion !== transport.database.schemaVersion ||
      environment.prototypes.identity !== transport.database.identity
    ) {
      throw new EntityReplayContextError(
        'ER1001',
        '$.entityReplayContext.database',
        'transport database does not match the selected prototype provider.',
      );
    }
  }
  return transport;
}

function compileParsedSource(
  parsed: ParsedSourceFile,
  environment: SourceCompilationEnvironment,
  preflightDiagnostics: readonly Diagnostic[],
  observe?: SourceCompilationObserver,
): LocalSourceCompilation {
  // Public JavaScript callers are not made trustworthy by the TypeScript type.
  // Validate before semantic analysis or source execution, just like CLI/Worker ingress.
  const diagnosticPolicy = parseDiagnosticPolicy(environment.diagnosticPolicy);
  const entityReplayContext = replayTransport(environment);
  let plan: DirectElaborationPlan | undefined;
  let execution: ExecutedDirectPlan | undefined;
  let resolvedCircuit: ResolvedCircuit | undefined;
  let elaborationJavaScript: string | undefined;
  let hasSourceParameterDeclarations = false;
  let capturedParameters: ExecutedElaborationWithBlueprintParameters | undefined;
  let privateResolvedCircuit: ResolvedCircuit | undefined;
  let privateExecution: ExecutedDirectPlan | undefined;
  observe?.('semantic');
  const semanticDiagnostics = validateDslSemantics(parsed);
  const compilerDiagnostics: Diagnostic[] = [...preflightDiagnostics, ...semanticDiagnostics];
  const pipelineDiagnostics: Diagnostic[] = [
    ...preflightDiagnostics,
    ...parsed.diagnostics,
    ...semanticDiagnostics,
  ];
  const appendCompilerDiagnostics = (diagnostics: readonly Diagnostic[]): void => {
    compilerDiagnostics.push(...diagnostics);
    pipelineDiagnostics.push(...diagnostics);
  };

  if (parsed.diagnostics.length === 0) {
    try {
      observe?.('transform');
      const program = transformElaborationModule(parsed);
      elaborationJavaScript = program.code;
      hasSourceParameterDeclarations = program.containsBlueprintParameterDeclarations === true;
      if (!compilerDiagnostics.some(({ severity }) => severity === 'error')) {
        observe?.('execute');
        const parameterExecution = hasSourceParameterDeclarations
          ? executeElaborationProgramWithParameters(program, environment)
          : undefined;
        const executedPlan =
          parameterExecution?.plan ?? executeElaborationProgram(program, environment);
        const canonicalPlan = canonicalDirectPlan(executedPlan);
        if (parameterExecution !== undefined) {
          capturedParameters = Object.freeze({ ...parameterExecution, plan: canonicalPlan });
        }
        plan = canonicalPlan;
        observe?.('lower');
        const lowered = tryCanonicalDirectPlan(
          canonicalPlan,
          environment.trustedEntityReplayContext,
        );
        execution = lowered.execution;
        resolvedCircuit = lowered.resolvedCircuit;
        privateExecution = lowered.execution;
        privateResolvedCircuit = lowered.resolvedCircuit;
        appendCompilerDiagnostics(executedPlan.diagnostics ?? []);
        appendCompilerDiagnostics(lowered.diagnostics);
      }
    } catch (error) {
      plan = undefined;
      execution = undefined;
      appendCompilerDiagnostics([executionFailureDiagnostic(error)]);
    }
  }

  const hasDefaultFreeSignal =
    capturedParameters?.parameters.some(
      ({ registration }) =>
        registration.kind === 'signal' && registration.defaultValue === undefined,
    ) ?? false;
  const requiredParameterIds =
    capturedParameters?.resolvedSignalTemplates === undefined
      ? []
      : capturedParameters.resolvedSignalTemplates.requiredParameters.flatMap((handle) => {
          const id = capturedParameters!.parameters.findIndex((entry) => entry.handle === handle);
          return id < 0 ? [] : [id];
        });

  const compilation = canonicalizeCompilationArtifacts({
    fileId: parsed.id,
    diagnostics: parsed.diagnostics,
    topLevel: summarizeTopLevel(parsed),
    semantics: classifyDslSemantics(parsed),
    pipelineDiagnostics: resolveDiagnostics(pipelineDiagnostics, diagnosticPolicy),
    compilerDiagnostics: resolveDiagnostics(compilerDiagnostics, diagnosticPolicy),
    executionMode: 'executed-javascript',
    ...(environment.prototypes === undefined
      ? {}
      : { prototypeIdentity: environment.prototypes.identity }),
    ...(entityReplayContext === undefined
      ? {}
      : {
          entityReplayContext,
          entityReplayIdentity: entityReplayContextIdentity(entityReplayContext),
        }),
    ...(elaborationJavaScript === undefined ? {} : { elaborationJavaScript }),
    ...(hasDefaultFreeSignal || plan === undefined ? {} : { plan }),
    ...(hasDefaultFreeSignal || resolvedCircuit === undefined ? {} : { resolvedCircuit }),
    ...(requiredParameterIds.length > 0 || hasDefaultFreeSignal
      ? { requiredParameterIds: Object.freeze(requiredParameterIds) }
      : {}),
    ...(hasDefaultFreeSignal || execution === undefined ? {} : { execution }),
  } as unknown as Record<string, any>) as unknown as LocalSourceCompilation;
  if (capturedParameters !== undefined) {
    capturedParametersByCompilation.set(compilation, {
      source: capturedParameters,
      ...(privateExecution === undefined ? {} : { execution: privateExecution }),
      ...(plan === undefined ? {} : { plan }),
      ...(privateResolvedCircuit === undefined ? {} : { resolvedCircuit: privateResolvedCircuit }),
    });
  }
  if (hasSourceParameterDeclarations) parameterSourceArtifacts.add(compilation);
  return compilation;
}

/** Lists nominal declarations for the owning host without adding them to the transport artifact. */
export function listSourceCompilationParameters(
  compilation: LocalSourceCompilation,
): readonly SourceCompilationParameter[] {
  const state = capturedParametersByCompilation.get(compilation);
  if (state === undefined) return Object.freeze([]);
  return Object.freeze(
    state.source.parameters.map(({ handle, registration }) => {
      const resolvedDefault = state.source.resolvedNumberDefaults?.declarations.find(
        (declaration) => declaration.handle === handle,
      )?.defaultValue;
      const defaultValue = registration.defaultValue ?? resolvedDefault;
      const source = registration.source;
      if (source === undefined) {
        throw new Error('Captured source parameters must have a source span.');
      }
      return Object.freeze({
        parameter: handle,
        kind: registration.kind,
        label: registration.label,
        ...(defaultValue === undefined ? {} : { defaultValue }),
        source,
        ...(registration.metadata === undefined ? {} : { metadata: registration.metadata }),
      });
    }),
  );
}

function effectiveSourceParameterBindings(
  source: ExecutedElaborationWithBlueprintParameters,
  bindings: readonly BlueprintParameterBinding[],
): readonly BlueprintParameterBinding[] {
  const resolvedDefaults = source.resolvedNumberDefaults;
  if (resolvedDefaults === undefined) return bindings;
  const overrides = readBlueprintParameterBindings(source.session, bindings);
  const overridden = new Set(overrides.map(({ parameter }) => parameter));
  const automaticDefaults = source.parameters.flatMap(({ handle, registration }) => {
    if (registration.kind !== 'number' || registration.defaultValue !== undefined) return [];
    const declaration = resolvedDefaults.declarations.find((item) => item.handle === handle);
    if (declaration === undefined) {
      throw new Error('Automatic NUMBER declaration lost its resolved host-local default.');
    }
    return overridden.has(handle) ? [] : [{ parameter: handle, value: declaration.defaultValue }];
  });
  return [...automaticDefaults, ...overrides.map(({ parameter, value }) => ({ parameter, value }))];
}

function concreteSourceParameterBindings(
  source: ExecutedElaborationWithBlueprintParameters,
  bindings: readonly BlueprintParameterBinding[],
): readonly BlueprintParameterBinding[] {
  const effective = effectiveSourceParameterBindings(source, bindings);
  const validated = readBlueprintParameterBindings(source.session, effective);
  const bound = new Set(validated.map(({ parameter }) => parameter));
  for (const parameter of source.resolvedSignalTemplates?.requiredParameters ?? []) {
    if (bound.has(parameter)) continue;
    const index = source.parameters.findIndex((entry) => entry.handle === parameter);
    const registration = source.parameters[index]?.registration;
    throw new BlueprintParameterError(
      'CP1002',
      `$.parameters[${index}].value`,
      `Signal parameter "${registration?.label ?? parameter.label}" requires an explicit binding.`,
      registration?.source,
    );
  }
  return effective;
}

/** Binds this exact compilation's declarations into a fresh concrete NCIR. */
export function bindSourceCompilationParameters(
  compilation: LocalSourceCompilation,
  bindings: readonly BlueprintParameterBinding[] = [],
): NativeCircuitIr {
  const state = capturedParametersByCompilation.get(compilation);
  if (state === undefined) {
    throw new TypeError('Compilation has no host-local source parameter declarations.');
  }
  if (state.execution === undefined) {
    throw new TypeError('Compilation has no canonical execution available for parameter binding.');
  }
  return bindCapturedSourceConfigurationTemplates(
    state.source,
    state.execution,
    concreteSourceParameterBindings(state.source, bindings),
  );
}

/** Projects this exact compilation's supported native parameter slots into metadata. */
export function exportSourceCompilationNativeBlueprint(
  compilation: LocalSourceCompilation,
  options: NativeBlueprintProjectionOptions,
): NativeBlueprintFcir {
  const state = capturedParametersByCompilation.get(compilation);
  if (state === undefined) {
    throw new TypeError('Compilation has no host-local source parameter declarations.');
  }
  if (state.execution === undefined) {
    throw new TypeError('Compilation has no canonical execution available for parameter binding.');
  }
  if (state.resolvedCircuit === undefined || state.plan === undefined) {
    throw new TypeError(
      'Compilation has no private canonical template base for parameter binding.',
    );
  }
  function reject(path: string, message: string, source?: SourceSpan): never {
    throw new BlueprintParameterError('CP1002', path, message, source);
  }
  const declarations = listSourceCompilationParameters(compilation);
  const signalDeclarations = declarations.filter(({ kind }) => kind === 'signal');
  const signalInfoByParameter = new Map<
    BlueprintParameterHandle,
    {
      readonly declaration: SourceCompilationParameter;
      readonly original?: SignalId;
      readonly key?: string;
      readonly placeholder?: string;
    }
  >();
  const signalInfoByOriginalKey = new Map<
    string,
    {
      readonly declaration: SourceCompilationParameter;
      readonly original: SignalId;
      readonly key: string;
    }
  >();
  const signalInfoByOriginalName = new Map<
    string,
    {
      readonly declaration: SourceCompilationParameter;
      readonly original: SignalId;
      readonly key: string;
    }[]
  >();
  const templatePlaceholderNames = new Set(
    signalDeclarations.flatMap((declaration) => {
      const name = state.source.resolvedSignalTemplates?.placeholderFor(declaration.parameter);
      return name === undefined ? [] : [name];
    }),
  );
  for (const [index, declaration] of declarations.entries()) {
    if (declaration.kind === 'signal') {
      if (declaration.defaultValue === undefined) {
        const placeholder = state.source.resolvedSignalTemplates?.placeholderFor(
          declaration.parameter,
        );
        if (placeholder === undefined) {
          reject(
            `$.parameters[${index}]`,
            'default-free Signal declaration has no authenticated Constant, Selector, or Arithmetic output template allocation.',
            declaration.source,
          );
        }
        signalInfoByParameter.set(declaration.parameter, { declaration, placeholder });
        continue;
      }
      const original = declaration.defaultValue as SignalId;
      let key: string;
      try {
        key = signalKey(original);
      } catch {
        reject(
          `$.parameters[${index}].defaultValue`,
          'native Signal defaults must be concrete item, fluid, or virtual signals.',
          declaration.source,
        );
      }
      if (
        (original.type !== 'item' && original.type !== 'fluid' && original.type !== 'virtual') ||
        (original.quality !== undefined && original.quality !== 'normal')
      ) {
        reject(
          `$.parameters[${index}].defaultValue`,
          'native Signal defaults support only item, fluid, or virtual signals with omitted or normal quality.',
          declaration.source,
        );
      }
      if (/^parameter-[0-9]+$/.test(original.name)) {
        reject(
          `$.parameters[${index}].defaultValue`,
          'native Signal defaults cannot use reserved parameter placeholder names.',
          declaration.source,
        );
      }
      const duplicate = signalInfoByOriginalKey.get(key!);
      if (duplicate !== undefined) {
        reject(
          `$.parameters[${index}].defaultValue`,
          `original signal ${JSON.stringify(original.name)} is already used by declaration ${JSON.stringify(duplicate.declaration.label)} at ${duplicate.declaration.source.fileId}:${duplicate.declaration.source.start}-${duplicate.declaration.source.end}.`,
          declaration.source,
        );
      }
      const sameName = signalInfoByOriginalName.get(original.name) ?? [];
      for (const sameNameInfo of sameName) {
        if (sameNameInfo.key !== key) {
          reject(
            `$.parameters[${index}].defaultValue`,
            `Signal declarations with the same name ${JSON.stringify(original.name)} have a different namespace or quality from declaration ${JSON.stringify(sameNameInfo.declaration.label)} at ${sameNameInfo.declaration.source.fileId}:${sameNameInfo.declaration.source.start}-${sameNameInfo.declaration.source.end}.`,
            declaration.source,
          );
        }
      }
      const info = Object.freeze({ declaration, original, key: key! });
      signalInfoByParameter.set(declaration.parameter, info);
      signalInfoByOriginalKey.set(key!, info);
      sameName.push(info);
      signalInfoByOriginalName.set(original.name, sameName);
      continue;
    }
    if (declaration.kind !== 'number') {
      reject(
        `$.parameters[${index}]`,
        'native source export supports only number declarations.',
        declaration.source,
      );
    }
    const original = declaration.defaultValue;
    if (
      typeof original !== 'number' ||
      !Number.isInteger(original) ||
      original < -2147483648 ||
      original > 2147483647
    ) {
      reject(
        `$.parameters[${index}].defaultValue`,
        'native original must be a signed int32 integer.',
        declaration.source,
      );
    }
  }
  if (signalDeclarations.length > 0) {
    const firstSignal = signalDeclarations[0]!;
    const firstSignalIndex = declarations.indexOf(firstSignal);
    const signalPath = `$.parameters[${firstSignalIndex}]`;
    const producers = state.resolvedCircuit.ir.producers;
    const unsupportedProducer = producers.find(
      (producer) =>
        producer.kind !== 'constant' &&
        producer.kind !== 'arithmetic' &&
        producer.kind !== 'selector' &&
        producer.kind !== 'decider',
    );
    if (unsupportedProducer !== undefined) {
      reject(
        signalPath,
        'native Signal export requires every producer to be Constant, Arithmetic, Selector or Decider.',
        firstSignal.source,
      );
    }
    const linkedEntities = new Set(
      producers.flatMap((producer) => (producer.entityId === undefined ? [] : [producer.entityId])),
    );
    const unlinkedEntity = (state.resolvedCircuit.ir.entities ?? []).find(
      (entity) => !linkedEntities.has(entity.id),
    );
    if (unlinkedEntity !== undefined) {
      reject(
        signalPath,
        'native Signal export does not support unlinked physical Entities alongside Signal parameters.',
        firstSignal.source,
      );
    }
  }
  const used = new Set<BlueprintParameterHandle>();
  const reservedSignalPlaceholderNames = new Set<string>();
  type PendingNativeNumericFormula =
    | {
        readonly kind: 'decider-threshold-expression';
        readonly captureId: string;
        readonly conditionPath: readonly number[];
        readonly expression: unknown;
        readonly dependencies: readonly BlueprintParameterHandle[];
        readonly path: string;
        readonly source: SourceSpan;
        readonly session: ReturnType<typeof inspectConstantConfigurationTemplate>['session'];
      }
    | {
        readonly kind: 'arithmetic-operand-expression';
        readonly captureId: string;
        readonly side: 'first' | 'second';
        readonly expression: unknown;
        readonly dependencies: readonly BlueprintParameterHandle[];
        readonly path: string;
        readonly source: SourceSpan;
        readonly session: ReturnType<typeof inspectConstantConfigurationTemplate>['session'];
      }
    | {
        readonly kind: 'constant-count-expression';
        readonly captureId: string;
        readonly sectionIndex: number;
        readonly filterIndex: number;
        readonly expression: unknown;
        readonly dependencies: readonly BlueprintParameterHandle[];
        readonly path: string;
        readonly source: SourceSpan;
        readonly session: ReturnType<typeof inspectConstantConfigurationTemplate>['session'];
      }
    | {
        readonly kind: 'selector-index-expression';
        readonly captureId: string;
        readonly expression: unknown;
        readonly dependencies: readonly BlueprintParameterHandle[];
        readonly path: string;
        readonly source: SourceSpan;
        readonly session: ReturnType<typeof inspectConstantConfigurationTemplate>['session'];
      };
  const pendingNativeNumericFormulas: PendingNativeNumericFormula[] = [];
  const measuredNativeNumericFormulas: MeasuredNativeNumericFormula[] = [];
  let formulaSession:
    ReturnType<typeof inspectConstantConfigurationTemplate>['session'] | undefined;
  let formulaRenderer: ReturnType<typeof createNativeNumericFormulaRenderer> | undefined;
  if (signalDeclarations.length > 0) {
    const concreteDeciderConditionSignals = (condition: LogicalDeciderCondition): SignalId[] => {
      if (condition.kind !== 'compare') {
        return condition.conditions.flatMap(concreteDeciderConditionSignals);
      }
      return [
        ...(condition.left.kind === 'signal' ? [condition.left.signal] : []),
        ...(condition.right.kind === 'signal' ? [condition.right.signal] : []),
      ];
    };
    for (const producer of state.resolvedCircuit.ir.producers) {
      if (
        producer.kind !== 'constant' &&
        producer.kind !== 'arithmetic' &&
        producer.kind !== 'selector' &&
        producer.kind !== 'decider'
      ) {
        continue;
      }
      const configuration =
        'configuration' in producer.config ? producer.config.configuration : undefined;
      const concreteSignals =
        producer.kind === 'constant'
          ? configuration === undefined
            ? (producer.config.outputs?.map(({ signal }) => signal) ?? [])
            : configuration.sections.flatMap((section) =>
                section.filters.map(({ signal }) => signal),
              )
          : producer.kind === 'arithmetic'
            ? [
                ...(producer.config.left.kind === 'signal' &&
                !canonicalBlueprintParameterHandle(producer.config.left.signal)
                  ? [producer.config.left.signal as SignalId]
                  : []),
                ...(producer.config.right.kind === 'signal' &&
                !canonicalBlueprintParameterHandle(producer.config.right.signal)
                  ? [producer.config.right.signal as SignalId]
                  : []),
                ...(producer.config.output.kind === 'signal' &&
                !canonicalBlueprintParameterHandle(producer.config.output.signal)
                  ? [producer.config.output.signal as SignalId]
                  : []),
              ]
            : producer.kind === 'selector'
              ? producer.config.operation === 'select'
                ? typeof producer.config.index !== 'number' &&
                  !canonicalBlueprintParameterHandle(producer.config.index)
                  ? [producer.config.index as SignalId]
                  : []
                : !canonicalBlueprintParameterHandle(producer.config.output)
                  ? [producer.config.output as SignalId]
                  : []
              : producer.kind === 'decider'
                ? [
                    ...concreteDeciderConditionSignals(producer.config.condition),
                    ...producer.config.outputs.flatMap((output) =>
                      output.signal.kind === 'signal' ? [output.signal.signal] : [],
                    ),
                    ...(producer.config.elseOutputs ?? []).flatMap((output) =>
                      output.signal.kind === 'signal' ? [output.signal.signal] : [],
                    ),
                  ]
                : [];
      for (const concreteSignal of concreteSignals) {
        const key = signalKey(concreteSignal);
        if (templatePlaceholderNames.has(concreteSignal.name)) continue;
        reservedSignalPlaceholderNames.add(concreteSignal.name);
        for (const sameName of signalInfoByOriginalName.get(concreteSignal.name) ?? []) {
          if (sameName.key !== key) {
            reject(
              `$.parameters[${declarations.indexOf(sameName.declaration)}].defaultValue`,
              `${producer.kind === 'constant' ? 'Constant filter' : producer.kind === 'arithmetic' ? 'Arithmetic Signal field' : producer.kind === 'selector' ? 'Selector Signal field' : 'Decider Signal field'} ${JSON.stringify(concreteSignal.name)} has a different namespace or quality from the declared Signal default.`,
              sameName.declaration.source,
            );
          }
        }
      }
    }
  }
  const occurrences: ({
    captureId: string;
    path: string;
    source: SourceSpan;
  } & (
    | {
        kind: 'constant-count';
        sectionIndex: number;
        filterIndex: number;
        parameter: BlueprintParameterHandle;
      }
    | {
        kind: 'constant-count-expression';
        sectionIndex: number;
        filterIndex: number;
        measured: MeasuredNativeNumericFormula;
      }
    | {
        kind: 'constant-signal';
        sectionIndex: number;
        filterIndex: number;
        parameter: BlueprintParameterHandle;
      }
    | { kind: 'arithmetic-signal-output'; parameter: BlueprintParameterHandle }
    | { kind: 'arithmetic-operand'; side: 'first' | 'second'; parameter: BlueprintParameterHandle }
    | {
        kind: 'arithmetic-operand-expression';
        side: 'first' | 'second';
        measured: MeasuredNativeNumericFormula;
      }
    | {
        kind: 'selector-index-expression';
        measured: MeasuredNativeNumericFormula;
      }
    | { kind: 'selector-index'; parameter: BlueprintParameterHandle }
    | {
        kind: 'decider-threshold';
        conditionPath: readonly number[];
        parameter: BlueprintParameterHandle;
      }
    | {
        kind: 'decider-threshold-expression';
        conditionPath: readonly number[];
        measured: MeasuredNativeNumericFormula;
      }
    | {
        kind: 'decider-output-count';
        branch: 'outputs' | 'elseOutputs';
        outputIndex: number;
        parameter: BlueprintParameterHandle;
      }
    | { kind: 'selector-index-signal'; parameter: BlueprintParameterHandle }
    | { kind: 'selector-count-output'; parameter: BlueprintParameterHandle }
  ))[] = [];
  state.source.selectorTemplates.forEach((capture, captureIndex) => {
    const path = `$.selectorTemplates[${captureIndex}]`;
    const registration = inspectSelectorConfigurationTemplate(capture.template, path);
    const accepted = new Set<BlueprintParameterHandle>();
    if (capture.template.operation === 'select') {
      const index = capture.template.index;
      const indexPath = `${path}.index`;
      if (isRegisteredBlueprintNumericExpression(index)) {
        let inspection;
        try {
          inspection = inspectRegisteredBlueprintNumericExpression(
            registration.session,
            index,
            indexPath,
          );
        } catch (error) {
          if (error instanceof BlueprintParameterError) {
            reject(
              indexPath,
              'native numeric formula export requires an authenticated expression owned by this compilation.',
              capture.source,
            );
          }
          throw error;
        }
        if (inspection.dependencies.length === 0) {
          reject(
            indexPath,
            'native numeric formulas require at least one number parameter dependency.',
            inspection.source ?? capture.source,
          );
        }
        if (formulaSession !== undefined && formulaSession !== registration.session) {
          reject(
            indexPath,
            'native numeric formulas must belong to one compilation parameter session.',
            capture.source,
          );
        }
        formulaSession = registration.session;
        for (const dependency of inspection.dependencies) {
          accepted.add(dependency);
          used.add(dependency);
        }
        pendingNativeNumericFormulas.push({
          kind: 'selector-index-expression',
          captureId: capture.captureId,
          expression: index,
          dependencies: inspection.dependencies,
          path: indexPath,
          source: inspection.source ?? capture.source,
          session: registration.session,
        });
      } else {
        const parameter = canonicalBlueprintParameterHandle(index);
        if (parameter !== undefined) {
          if (parameter.kind === 'number') {
            accepted.add(parameter);
            used.add(parameter);
            occurrences.push({
              kind: 'selector-index',
              captureId: capture.captureId,
              parameter,
              path: indexPath,
              source: capture.source,
            });
          } else {
            if (!signalInfoByParameter.has(parameter)) {
              reject(
                indexPath,
                'native source export supports only declared Signal parameters in the exact Selector select-index slot.',
                capture.source,
              );
            }
            accepted.add(parameter);
            used.add(parameter);
            occurrences.push({
              kind: 'selector-index-signal',
              captureId: capture.captureId,
              parameter,
              path: indexPath,
              source: capture.source,
            });
          }
        }
      }
    } else {
      const outputPath = `${path}.output`;
      const parameter = canonicalBlueprintParameterHandle(capture.template.output);
      if (parameter !== undefined) {
        if (parameter.kind !== 'signal' || !signalInfoByParameter.has(parameter)) {
          reject(
            outputPath,
            'native source export supports only declared Signal parameters in the exact Selector count-output slot.',
            capture.source,
          );
        }
        accepted.add(parameter);
        used.add(parameter);
        occurrences.push({
          kind: 'selector-count-output',
          captureId: capture.captureId,
          parameter,
          path: outputPath,
          source: capture.source,
        });
      }
    }
    if (registration.usedParameters.some((parameter) => !accepted.has(parameter))) {
      reject(
        `${path}.${capture.template.operation === 'select' ? 'index' : 'output'}`,
        'native source export supports direct numeric or formula Selector indices and declared Signal parameters in exact select-index or count-output slots.',
        capture.source,
      );
    }
  });
  state.source.deciderTemplates.forEach((capture, captureIndex) => {
    const path = `$.deciderTemplates[${captureIndex}]`;
    const registration = inspectDeciderConfigurationTemplate(capture.template, path);
    const accepted = new Set<BlueprintParameterHandle>();
    for (const key of ['outputs', 'elseOutputs'] as const) {
      capture.template[key]?.forEach((output, index) => {
        const outputPath = `${path}.${key}[${index}]`;
        if (
          output.signal.kind === 'signal' &&
          canonicalBlueprintParameterHandle(output.signal.signal) !== undefined
        ) {
          reject(
            `${outputPath}.signal`,
            'native source export does not support symbolic Decider outputs.',
            capture.source,
          );
        }
        if (output.mode !== 'constant' || typeof output.value === 'number') return;
        const parameter = canonicalBlueprintParameterHandle(output.value);
        if (parameter === undefined || parameter.kind !== 'number') {
          reject(
            `${outputPath}.value`,
            'native source export supports only direct number parameters in Decider constant output values.',
            capture.source,
          );
        }
        accepted.add(parameter);
        used.add(parameter);
        occurrences.push({
          kind: 'decider-output-count',
          captureId: capture.captureId,
          branch: key,
          outputIndex: index,
          parameter,
          path: `${outputPath}.value`,
          source: capture.source,
        });
      });
    }
    const collectThresholds = (
      condition: DeciderTemplateCondition,
      conditionPath: readonly number[],
      conditionSourcePath: string,
    ): void => {
      if (condition.kind !== 'compare') {
        condition.conditions.forEach((child, index) =>
          collectThresholds(
            child,
            [...conditionPath, index],
            `${conditionSourcePath}.conditions[${index}]`,
          ),
        );
        return;
      }
      if (condition.right.kind !== 'constant') return;
      const operandPath = `${conditionSourcePath}.right.value`;
      if (isRegisteredBlueprintNumericExpression(condition.right.value)) {
        let inspection;
        try {
          inspection = inspectRegisteredBlueprintNumericExpression(
            registration.session,
            condition.right.value,
            operandPath,
          );
        } catch (error) {
          if (error instanceof BlueprintParameterError) {
            reject(
              operandPath,
              'native numeric formula export requires an authenticated expression owned by this compilation.',
              capture.source,
            );
          }
          throw error;
        }
        if (inspection.dependencies.length === 0) {
          reject(
            operandPath,
            'native numeric formulas require at least one number parameter dependency.',
            inspection.source ?? capture.source,
          );
        }
        if (formulaSession !== undefined && formulaSession !== registration.session) {
          reject(
            operandPath,
            'native numeric formulas must belong to one compilation parameter session.',
            capture.source,
          );
        }
        formulaSession = registration.session;
        for (const dependency of inspection.dependencies) {
          accepted.add(dependency);
          used.add(dependency);
        }
        pendingNativeNumericFormulas.push({
          kind: 'decider-threshold-expression',
          captureId: capture.captureId,
          conditionPath,
          expression: condition.right.value,
          dependencies: inspection.dependencies,
          path: operandPath,
          source: inspection.source ?? capture.source,
          session: registration.session,
        });
        return;
      }
      const parameter = canonicalBlueprintParameterHandle(condition.right.value);
      if (parameter !== undefined && parameter.kind === 'number') {
        accepted.add(parameter);
        used.add(parameter);
        occurrences.push({
          kind: 'decider-threshold',
          conditionPath,
          captureId: capture.captureId,
          parameter,
          path: operandPath,
          source: capture.source,
        });
      }
    };
    collectThresholds(capture.template.condition, [], `${path}.condition`);
    if (registration.usedParameters.some((parameter) => !accepted.has(parameter))) {
      reject(
        `${path}.condition`,
        'native source export supports only direct numeric Decider right thresholds.',
        capture.source,
      );
    }
  });
  state.source.arithmeticTemplates.forEach((capture, captureIndex) => {
    const path = `$.arithmeticTemplates[${captureIndex}]`;
    const registration = inspectArithmeticConfigurationTemplate(capture.template, path);
    const acceptedSignals = new Set<BlueprintParameterHandle>();
    if (capture.template.output.kind === 'signal') {
      const outputPath = `${path}.output.signal`;
      const outputParameter = canonicalBlueprintParameterHandle(capture.template.output.signal);
      if (outputParameter !== undefined) {
        if (outputParameter.kind !== 'signal' || !signalInfoByParameter.has(outputParameter)) {
          reject(
            outputPath,
            'native source export supports only declared Signal parameters in exact Arithmetic output slots.',
            capture.source,
          );
        }
        acceptedSignals.add(outputParameter);
        used.add(outputParameter);
        occurrences.push({
          kind: 'arithmetic-signal-output',
          captureId: capture.captureId,
          parameter: outputParameter,
          path: outputPath,
          source: capture.source,
        });
      }
    }
    for (const [key, side] of [
      ['left', 'first'],
      ['right', 'second'],
    ] as const) {
      const operand = capture.template[key];
      if (operand.kind === 'signal') {
        const operandParameter = canonicalBlueprintParameterHandle(operand.signal);
        if (operandParameter !== undefined) {
          reject(
            `${path}.${key}.signal`,
            'native source export supports Signal parameters only in exact Arithmetic output slots.',
            capture.source,
          );
        }
      }
      if (operand.kind !== 'constant') continue;
      const operandPath = `${path}.${key}.value`;
      if (isRegisteredBlueprintNumericExpression(operand.value)) {
        let inspection;
        try {
          inspection = inspectRegisteredBlueprintNumericExpression(
            registration.session,
            operand.value,
            operandPath,
          );
        } catch (error) {
          if (error instanceof BlueprintParameterError) {
            reject(
              operandPath,
              'native numeric formula export requires an authenticated expression owned by this compilation.',
              capture.source,
            );
          }
          throw error;
        }
        if (inspection.dependencies.length === 0) {
          reject(
            operandPath,
            'native numeric formulas require at least one number parameter dependency.',
            inspection.source ?? capture.source,
          );
        }
        if (formulaSession !== undefined && formulaSession !== registration.session) {
          reject(
            operandPath,
            'native numeric formulas must belong to one compilation parameter session.',
            capture.source,
          );
        }
        formulaSession = registration.session;
        for (const dependency of inspection.dependencies) used.add(dependency);
        pendingNativeNumericFormulas.push({
          kind: 'arithmetic-operand-expression',
          captureId: capture.captureId,
          side,
          expression: operand.value,
          dependencies: inspection.dependencies,
          path: operandPath,
          source: inspection.source ?? capture.source,
          session: registration.session,
        });
        continue;
      }
      const parameter = canonicalBlueprintParameterHandle(operand.value);
      if (parameter === undefined) continue;
      used.add(parameter);
      occurrences.push({
        kind: 'arithmetic-operand',
        captureId: capture.captureId,
        side,
        parameter,
        path: operandPath,
        source: capture.source,
      });
    }
    if (
      registration.usedParameters.some(
        (parameter) => parameter.kind === 'signal' && !acceptedSignals.has(parameter),
      )
    ) {
      reject(
        path,
        'native source export supports Signal parameters only in exact Arithmetic output slots.',
        capture.source,
      );
    }
  });
  state.source.constantTemplates.forEach((capture, captureIndex) => {
    const path = `$.constantTemplates[${captureIndex}]`;
    const registration = inspectConstantConfigurationTemplate(capture.template, path);
    const accepted = new Set<BlueprintParameterHandle>();
    capture.template.sections.forEach((section, sectionIndex) => {
      const sectionPath = `${path}.sections[${sectionIndex}]`;
      if (typeof section.multiplier !== 'number') {
        reject(
          `${sectionPath}.multiplier`,
          'native source export does not support symbolic multipliers.',
          capture.source,
        );
      }
      section.filters.forEach((filter, filterIndex) => {
        const filterPath = `${sectionPath}.filters[${filterIndex}]`;
        const signalParameter = canonicalBlueprintParameterHandle(filter.signal);
        if (signalParameter !== undefined) {
          if (signalParameter.kind !== 'signal' || !signalInfoByParameter.has(signalParameter)) {
            reject(
              `${filterPath}.signal`,
              'native source export supports only declared Signal parameters in Constant filter slots.',
              capture.source,
            );
          }
          accepted.add(signalParameter);
          used.add(signalParameter);
          occurrences.push({
            kind: 'constant-signal',
            captureId: capture.captureId,
            sectionIndex,
            filterIndex,
            parameter: signalParameter,
            path: `${filterPath}.signal`,
            source: capture.source,
          });
        } else {
          const concreteSignal = filter.signal as SignalId;
          const key = signalKey(concreteSignal);
          reservedSignalPlaceholderNames.add(concreteSignal.name);
          for (const sameName of signalInfoByOriginalName.get(concreteSignal.name) ?? []) {
            if (sameName.key !== key) {
              reject(
                `$.parameters[${declarations.indexOf(sameName.declaration)}].defaultValue`,
                `Constant filter signal ${JSON.stringify(concreteSignal.name)} has a different namespace or quality from the declared Signal default.`,
                sameName.declaration.source,
              );
            }
          }
        }
        if (isRegisteredBlueprintNumericExpression(filter.value)) {
          let inspection;
          try {
            inspection = inspectRegisteredBlueprintNumericExpression(
              registration.session,
              filter.value,
              `${filterPath}.value`,
            );
          } catch (error) {
            if (error instanceof BlueprintParameterError) {
              reject(
                `${filterPath}.value`,
                'native formula export requires an authenticated expression owned by this compilation.',
                capture.source,
              );
            }
            throw error;
          }
          if (inspection.dependencies.length === 0) {
            reject(
              `${filterPath}.value`,
              'native numeric formulas require at least one number parameter dependency.',
              inspection.source ?? capture.source,
            );
          }
          if (formulaSession !== undefined && formulaSession !== registration.session) {
            reject(
              `${filterPath}.value`,
              'native numeric formulas must belong to one compilation parameter session.',
              capture.source,
            );
          }
          formulaSession = registration.session;
          for (const dependency of inspection.dependencies) {
            accepted.add(dependency);
            used.add(dependency);
          }
          pendingNativeNumericFormulas.push({
            kind: 'constant-count-expression',
            captureId: capture.captureId,
            sectionIndex,
            filterIndex,
            expression: filter.value,
            dependencies: inspection.dependencies,
            path: `${filterPath}.value`,
            source: inspection.source ?? capture.source,
            session: registration.session,
          });
          return;
        }
        const parameter = canonicalBlueprintParameterHandle(filter.value);
        if (parameter === undefined) return;
        if (parameter.kind !== 'number') {
          reject(
            `${filterPath}.value`,
            'native source export supports only numeric Constant filter counts.',
            capture.source,
          );
        }
        accepted.add(parameter);
        used.add(parameter);
        occurrences.push({
          kind: 'constant-count',
          captureId: capture.captureId,
          sectionIndex,
          filterIndex,
          parameter,
          path: `${filterPath}.value`,
          source: capture.source,
        });
      });
    });
    if (registration.usedParameters.some((parameter) => !accepted.has(parameter))) {
      reject(
        path,
        'native source export does not support this symbolic Constant slot.',
        capture.source,
      );
    }
  });
  if (pendingNativeNumericFormulas.length > 0) {
    const firstFormula = pendingNativeNumericFormulas[0]!;
    const declarationsByParameter = new Map(
      declarations.map((declaration) => [declaration.parameter, declaration]),
    );
    const variableByParameter = new Map<BlueprintParameterHandle, string>();
    const variableOwners = new Map<string, SourceCompilationParameter>();
    const reservedVariables = new Set(['abs', 'log2', 'sign', 'max', 'min']);
    for (const [index, declaration] of declarations.entries()) {
      if (declaration.kind !== 'number') continue;
      const variable = declaration.metadata?.variable;
      if (variable === undefined) continue;
      if (
        typeof variable !== 'string' ||
        !/^[A-Za-z][A-Za-z0-9_]*$/.test(variable) ||
        reservedVariables.has(variable) ||
        /^p[0-9]+_/.test(variable)
      ) {
        reject(
          `$.parameters[${index}].metadata.variable`,
          'native numeric formula variables must be valid non-reserved identifiers.',
          declaration.source,
        );
      }
      const previous = variableOwners.get(variable);
      if (previous !== undefined) {
        reject(
          `$.parameters[${index}].metadata.variable`,
          `native numeric formula variable ${JSON.stringify(variable)} is already used by declaration ${JSON.stringify(previous.label)}.`,
          declaration.source,
        );
      }
      variableOwners.set(variable, declaration);
      variableByParameter.set(declaration.parameter, variable);
    }
    for (const formula of pendingNativeNumericFormulas) {
      for (const dependency of formula.dependencies) {
        const declaration = declarationsByParameter.get(dependency);
        if (declaration === undefined || declaration.kind !== 'number') {
          reject(
            formula.path,
            'native numeric formula dependency is not a number declaration owned by this compilation.',
            formula.source,
          );
        }
        const declarationIndex = declarations.indexOf(declaration);
        const metadata = declaration.metadata;
        if (metadata?.variable === undefined) {
          reject(
            `$.parameters[${declarationIndex}].metadata.variable`,
            'native numeric formula dependencies require an explicit variable name.',
            declaration.source,
          );
        }
        if (Object.hasOwn(metadata, 'formula') || metadata.dependent === true) {
          reject(
            `$.parameters[${declarationIndex}].metadata`,
            'native numeric formula dependencies must be direct leaf parameters without formula metadata.',
            declaration.source,
          );
        }
      }
    }
    const producers = state.resolvedCircuit.ir.producers;
    if (
      producers.some(
        (producer) =>
          producer.kind !== 'constant' &&
          producer.kind !== 'arithmetic' &&
          producer.kind !== 'decider' &&
          producer.kind !== 'selector',
      )
    ) {
      reject(
        firstFormula.path,
        'native numeric formula export requires every producer to be Constant, Arithmetic, Decider or Selector.',
        firstFormula.source,
      );
    }
    const linkedEntities = new Set(
      producers.flatMap((producer) => (producer.entityId === undefined ? [] : [producer.entityId])),
    );
    const unlinkedEntity = (state.resolvedCircuit.ir.entities ?? []).find(
      (entity) => !linkedEntities.has(entity.id),
    );
    if (unlinkedEntity !== undefined) {
      reject(
        firstFormula.path,
        'native numeric formula export does not support unlinked physical Entities.',
        firstFormula.source,
      );
    }
    const ownerSession = formulaSession;
    if (ownerSession === undefined) {
      reject(
        firstFormula.path,
        'native numeric formula session is unavailable.',
        firstFormula.source,
      );
    }
    formulaRenderer = createNativeNumericFormulaRenderer(ownerSession, (parameter) =>
      variableByParameter.get(parameter),
    );
    for (const formula of pendingNativeNumericFormulas) {
      const measured = formulaRenderer.measure(formula.expression, formula.path);
      measuredNativeNumericFormulas.push(measured);
      if (formula.kind === 'decider-threshold-expression') {
        occurrences.push({
          kind: formula.kind,
          captureId: formula.captureId,
          conditionPath: formula.conditionPath,
          measured,
          path: formula.path,
          source: formula.source,
        });
      } else if (formula.kind === 'selector-index-expression') {
        occurrences.push({
          kind: formula.kind,
          captureId: formula.captureId,
          measured,
          path: formula.path,
          source: formula.source,
        });
      } else {
        occurrences.push(
          formula.kind === 'constant-count-expression'
            ? {
                kind: formula.kind,
                captureId: formula.captureId,
                sectionIndex: formula.sectionIndex,
                filterIndex: formula.filterIndex,
                measured,
                path: formula.path,
                source: formula.source,
              }
            : {
                kind: formula.kind,
                captureId: formula.captureId,
                side: formula.side,
                measured,
                path: formula.path,
                source: formula.source,
              },
        );
      }
    }
  }
  const numberOriginals = new Map<number, SourceCompilationParameter>();
  const allocatedSignalNames = new Map<BlueprintParameterHandle, string>();
  const parameters: NativeBlueprintParameter[] = declarations.map((declaration, index) => {
    if (!used.has(declaration.parameter)) {
      reject(
        `$.parameters[${index}]`,
        'native source export does not support unused declarations.',
        declaration.source,
      );
    }
    if (declaration.kind === 'number') {
      const original = declaration.defaultValue as number;
      const first = numberOriginals.get(original);
      if (first !== undefined) {
        reject(
          `$.parameters[${index}].defaultValue`,
          `original ${String(original)} is already used by declaration ${JSON.stringify(first.label)} at ${first.source.fileId}:${first.source.start}-${first.source.end}.`,
          declaration.source,
        );
      }
      numberOriginals.set(original, declaration);
      return Object.freeze({
        type: 'number',
        number: String(original),
        name: declaration.label,
        ...declaration.metadata,
      });
    }
    const templatePlaceholder = state.source.resolvedSignalTemplates?.placeholderFor(
      declaration.parameter,
    );
    if (templatePlaceholder !== undefined) {
      allocatedSignalNames.set(declaration.parameter, templatePlaceholder);
      reservedSignalPlaceholderNames.add(templatePlaceholder);
      return Object.freeze({
        type: 'id',
        id: templatePlaceholder,
        name: declaration.label,
        'quality-condition': Object.freeze({ quality: 'normal', comparator: '=' }),
      });
    }
    const info = signalInfoByParameter.get(declaration.parameter);
    if (info === undefined) {
      reject(
        `$.parameters[${index}]`,
        'native Signal declaration has no authenticated Constant, Arithmetic or Selector slot use.',
        declaration.source,
      );
    }
    let placeholder: string | undefined;
    for (let candidate = 0; candidate < 10; candidate += 1) {
      const name = `parameter-${candidate}`;
      if (!reservedSignalPlaceholderNames.has(name)) {
        placeholder = name;
        reservedSignalPlaceholderNames.add(name);
        break;
      }
    }
    if (placeholder === undefined) {
      reject(
        `$.parameters[${index}]`,
        'native Signal placeholder pool parameter-0 through parameter-9 is exhausted.',
        declaration.source,
      );
    }
    allocatedSignalNames.set(declaration.parameter, placeholder);
    return Object.freeze({
      type: 'id',
      id: placeholder,
      name: declaration.label,
      'quality-condition': Object.freeze({ quality: 'normal', comparator: '=' }),
    });
  });

  if (measuredNativeNumericFormulas.length > 0) {
    const firstFormula = pendingNativeNumericFormulas[0]!;
    const formulaByOriginal = new Map<number, MeasuredNativeNumericFormula>();
    const uniqueFormulas: MeasuredNativeNumericFormula[] = [];
    for (const measured of measuredNativeNumericFormulas) {
      if (numberOriginals.has(measured.defaultValue)) {
        reject(
          measured.path,
          `derived original ${String(measured.defaultValue)} collides with a declared number original.`,
          measured.source,
        );
      }
      const previous = formulaByOriginal.get(measured.defaultValue);
      if (previous !== undefined) {
        if (previous.key !== measured.key) {
          reject(
            measured.path,
            `derived original ${String(measured.defaultValue)} is already used by a different formula at ${previous.path}.`,
            measured.source,
          );
        }
        continue;
      }
      formulaByOriginal.set(measured.defaultValue, measured);
      uniqueFormulas.push(measured);
    }
    if (formulaRenderer === undefined) {
      reject(
        firstFormula.path,
        'native numeric formula renderer is unavailable.',
        firstFormula.source,
      );
    }
    const rendered = formulaRenderer.renderUnique(uniqueFormulas);
    for (const measured of uniqueFormulas) {
      const formula = rendered.get(measured.key);
      if (formula === undefined) {
        reject(measured.path, 'native numeric formula rendering is incomplete.', measured.source);
      }
      parameters.push(
        Object.freeze({
          type: 'number',
          number: String(measured.defaultValue),
          formula,
          dependent: true,
        }),
      );
    }
  }

  // The binder authenticates templates, their session and their exact physical producer relation.
  const nativeBindings = [
    ...effectiveSourceParameterBindings(state.source, []),
    ...(state.source.resolvedSignalTemplates?.requiredParameters.flatMap((parameter) => {
      const placeholder = state.source.resolvedSignalTemplates?.placeholderFor(parameter);
      return placeholder === undefined ? [] : [{ parameter, value: signal('item', placeholder) }];
    }) ?? []),
  ];
  const replacement = bindCapturedSourceConfigurationTemplatesWithRelations(
    state.source,
    state.execution,
    nativeBindings,
  );
  const projected = buildNativeBlueprintFcir(replacement.circuit, options);
  const relations = new Map(
    replacement.captureRelations.map((relation) => [relation.captureId, relation]),
  );
  const boundArithmeticOutputProducerIndexes = new Set<number>();
  for (const captureId of state.source.boundArithmeticOutputCaptureIds) {
    const relation = relations.get(captureId);
    if (relation === undefined || relation.kind !== 'arithmetic') {
      reject(
        '$.arithmeticTemplates',
        'bound Arithmetic output capture has no authenticated producer relation.',
      );
    }
    boundArithmeticOutputProducerIndexes.add(relation.producerIndex);
  }
  const entities = new Map(projected.entities.map((entity) => [entity.entityNumber, entity]));
  const defaults = new Map(
    declarations.map((declaration) => [declaration.parameter, declaration.defaultValue]),
  );
  const readRecord = (value: unknown): Record<string, unknown> | undefined =>
    value !== null && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  const nativeSignalKey = (value: unknown): string | undefined => {
    const field = readRecord(value);
    const name = field?.name;
    const type = field?.type ?? 'item';
    const quality = field?.quality;
    if (typeof name !== 'string' || typeof type !== 'string') return undefined;
    try {
      return signalKey({
        type: type as SignalId['type'],
        name,
        ...(typeof quality === 'string' ? { quality } : {}),
      });
    } catch {
      return undefined;
    }
  };
  type Comparison = Extract<LogicalDeciderCondition, { kind: 'compare' }>;
  const deciderRowIndices = new Map<number, Map<Comparison, number[]>>();
  for (const occurrence of occurrences) {
    const relation = relations.get(occurrence.captureId);
    const family =
      occurrence.kind === 'constant-count' ||
      occurrence.kind === 'constant-count-expression' ||
      occurrence.kind === 'constant-signal'
        ? 'constant'
        : occurrence.kind === 'arithmetic-operand' ||
            occurrence.kind === 'arithmetic-operand-expression' ||
            occurrence.kind === 'arithmetic-signal-output'
          ? 'arithmetic'
          : occurrence.kind === 'selector-index' ||
              occurrence.kind === 'selector-index-expression' ||
              occurrence.kind === 'selector-index-signal' ||
              occurrence.kind === 'selector-count-output'
            ? 'selector'
            : 'decider';
    if (
      relation === undefined ||
      relation.kind !== family ||
      replacement.circuit.producers[relation.producerIndex]?.id !== relation.producerId
    ) {
      reject(
        occurrence.path,
        'missing authenticated source configuration producer relation.',
        occurrence.source,
      );
    }
    // The canonical projector assigns producer entity numbers in NCIR producer order.
    const entity = entities.get(relation.producerIndex + 1);
    if (occurrence.kind === 'arithmetic-signal-output') {
      const info = signalInfoByParameter.get(occurrence.parameter);
      const producer = replacement.circuit.producers[relation.producerIndex];
      const behavior = entity?.native.control_behavior as
        | {
            readonly arithmetic_conditions?: {
              readonly output_signal?: {
                readonly type?: string;
                readonly name?: string;
                readonly quality?: string;
              };
            };
          }
        | undefined;
      const projectedSignal = behavior?.arithmetic_conditions?.output_signal;
      const projectedType = projectedSignal?.type ?? 'item';
      const projectedName = projectedSignal?.name;
      const projectedQuality = projectedSignal?.quality;
      let projectedKey: string | undefined;
      if (typeof projectedType === 'string' && typeof projectedName === 'string') {
        try {
          projectedKey = signalKey({
            type: projectedType as SignalId['type'],
            name: projectedName,
            ...(typeof projectedQuality === 'string' ? { quality: projectedQuality } : {}),
          });
        } catch {
          projectedKey = undefined;
        }
      }
      const sourceOutput = producer?.kind === 'arithmetic' ? producer.config.output : undefined;
      let sourceKey: string | undefined;
      if (sourceOutput?.kind === 'signal') {
        try {
          sourceKey = signalKey(sourceOutput.signal as SignalId);
        } catch {
          sourceKey = undefined;
        }
      }
      const expectedKey =
        info?.key ??
        (info?.placeholder === undefined ? undefined : signalKey(signal('item', info.placeholder)));
      if (
        info === undefined ||
        expectedKey === undefined ||
        sourceOutput?.kind !== 'signal' ||
        sourceKey !== expectedKey ||
        projectedKey !== expectedKey
      ) {
        reject(
          occurrence.path,
          'marked Arithmetic output Signal default did not survive authenticated native projection unchanged.',
          occurrence.source,
        );
      }
      continue;
    }
    if (occurrence.kind === 'selector-index') {
      const behavior = entity?.native.control_behavior as
        { readonly operation?: string; readonly index_constant?: number } | undefined;
      if (
        behavior?.operation !== 'select' ||
        behavior.index_constant !== defaults.get(occurrence.parameter)
      ) {
        reject(
          occurrence.path,
          'marked Selector index did not survive native projection unchanged.',
          occurrence.source,
        );
      }
      continue;
    }
    if (occurrence.kind === 'selector-index-expression') {
      const behavior = entity?.native.control_behavior as
        { readonly operation?: string; readonly index_constant?: number } | undefined;
      if (
        behavior?.operation !== 'select' ||
        behavior.index_constant !== occurrence.measured.defaultValue
      ) {
        reject(
          occurrence.path,
          'marked Selector index expression did not survive native projection at its evaluated default.',
          occurrence.source,
        );
      }
      continue;
    }
    if (
      occurrence.kind === 'selector-index-signal' ||
      occurrence.kind === 'selector-count-output'
    ) {
      const info = signalInfoByParameter.get(occurrence.parameter);
      const producer = replacement.circuit.producers[relation.producerIndex];
      const expectedOperation = occurrence.kind === 'selector-index-signal' ? 'select' : 'count';
      const sourceSignal =
        producer?.kind === 'selector' && producer.config.operation === expectedOperation
          ? producer.config.operation === 'select'
            ? typeof producer.config.index === 'number'
              ? undefined
              : producer.config.index
            : producer.config.output
          : undefined;
      const behavior = readRecord(entity?.native.control_behavior);
      const projectedSignal =
        expectedOperation === 'select' ? behavior?.index_signal : behavior?.count_signal;
      let sourceKey: string | undefined;
      if (sourceSignal !== undefined) {
        try {
          sourceKey = signalKey(sourceSignal as SignalId);
        } catch {
          sourceKey = undefined;
        }
      }
      const expectedKey =
        info?.key ??
        (info?.placeholder === undefined
          ? undefined
          : signalKey({ type: 'item', name: info.placeholder }));
      if (
        info === undefined ||
        expectedKey === undefined ||
        sourceKey !== expectedKey ||
        behavior?.operation !== expectedOperation ||
        nativeSignalKey(projectedSignal) !== expectedKey
      ) {
        reject(
          occurrence.path,
          `marked Selector ${expectedOperation === 'select' ? 'index' : 'count output'} Signal identity did not survive authenticated native projection unchanged.`,
          occurrence.source,
        );
      }
      continue;
    }
    if (
      occurrence.kind === 'decider-threshold' ||
      occurrence.kind === 'decider-threshold-expression'
    ) {
      const behavior = entity?.native.control_behavior as
        | {
            readonly decider_conditions?: {
              readonly conditions?: readonly { readonly constant?: number }[];
            };
          }
        | undefined;
      const conditions = behavior?.decider_conditions?.conditions;
      const producer = replacement.circuit.producers[relation.producerIndex];
      if (producer?.kind !== 'decider') {
        reject(occurrence.path, 'marked Decider producer is unavailable.', occurrence.source);
      }
      let indices = deciderRowIndices.get(relation.producerIndex);
      if (indices === undefined) {
        const rowsByLeaf = new Map<Comparison, number[]>();
        const leaves = nativeDeciderConditionGroups(
          producer.config.condition,
          options.maxDeciderConditionRows,
        ).flat();
        if (conditions?.length !== leaves.length) {
          reject(
            occurrence.path,
            'marked Decider condition rows changed during native projection.',
            occurrence.source,
          );
        }
        leaves.forEach((leaf, index) => {
          const rows = rowsByLeaf.get(leaf) ?? [];
          rows.push(index);
          rowsByLeaf.set(leaf, rows);
        });
        indices = rowsByLeaf;
        deciderRowIndices.set(relation.producerIndex, indices);
      }
      let leaf: LogicalDeciderCondition | undefined = producer.config.condition;
      for (const index of occurrence.conditionPath) {
        leaf = leaf?.kind === 'compare' ? undefined : leaf?.conditions[index];
      }
      const rows = leaf?.kind === 'compare' ? indices.get(leaf) : undefined;
      const expected =
        occurrence.kind === 'decider-threshold-expression'
          ? occurrence.measured.defaultValue
          : defaults.get(occurrence.parameter);
      if (
        rows === undefined ||
        rows.length === 0 ||
        typeof expected !== 'number' ||
        rows.some((index) => conditions?.[index]?.constant !== expected)
      ) {
        reject(
          occurrence.path,
          occurrence.kind === 'decider-threshold-expression'
            ? 'marked Decider expression did not survive native row projection at its evaluated default.'
            : 'marked Decider threshold did not survive native row projection unchanged.',
          occurrence.source,
        );
      }
      continue;
    }
    if (occurrence.kind === 'decider-output-count') {
      const producer = replacement.circuit.producers[relation.producerIndex];
      if (producer?.kind !== 'decider' || entity === undefined) {
        reject(occurrence.path, 'marked Decider producer is unavailable.', occurrence.source);
      }
      const sourceRows =
        occurrence.branch === 'outputs' ? producer.config.outputs : producer.config.elseOutputs;
      const sourceOutput = sourceRows?.[occurrence.outputIndex];
      const expected = defaults.get(occurrence.parameter);
      const expectedSignalKey =
        sourceOutput?.signal.kind === 'signal'
          ? signalKey(sourceOutput.signal.signal as SignalId)
          : undefined;
      const expectedEach =
        sourceOutput?.signal.kind === 'wildcard' && sourceOutput.signal.value === 'each';
      const nativeBehavior = readRecord(entity.native.control_behavior);
      const nativeDecider = readRecord(nativeBehavior?.decider_conditions);
      const nativeRows =
        nativeDecider?.[occurrence.branch === 'outputs' ? 'outputs' : 'else_outputs'];
      const nativeOutput = Array.isArray(nativeRows)
        ? readRecord(nativeRows[occurrence.outputIndex])
        : undefined;
      const projectedSignal = readRecord(nativeOutput?.signal);
      const signalProjectionMatches =
        expectedSignalKey !== undefined
          ? nativeSignalKey(nativeOutput?.signal) === expectedSignalKey
          : expectedEach &&
            projectedSignal?.type === 'virtual' &&
            projectedSignal.name === 'signal-each';
      if (
        sourceRows === undefined ||
        sourceOutput?.mode !== 'constant' ||
        sourceOutput.value !== expected ||
        typeof expected !== 'number' ||
        !Array.isArray(nativeRows) ||
        nativeRows.length !== sourceRows.length ||
        nativeOutput?.constant !== expected ||
        nativeOutput?.copy_count_from_input !== false ||
        (expectedSignalKey === undefined && !expectedEach) ||
        !signalProjectionMatches
      ) {
        reject(
          occurrence.path,
          'marked Decider output count did not survive authenticated branch/row projection unchanged.',
          occurrence.source,
        );
      }
      continue;
    }
    if (
      occurrence.kind === 'arithmetic-operand' ||
      occurrence.kind === 'arithmetic-operand-expression'
    ) {
      const behavior = entity?.native.control_behavior as
        | {
            readonly arithmetic_conditions?: {
              readonly first_constant?: number;
              readonly second_constant?: number;
            };
          }
        | undefined;
      const field = occurrence.side === 'first' ? 'first_constant' : 'second_constant';
      const expected =
        occurrence.kind === 'arithmetic-operand-expression'
          ? occurrence.measured.defaultValue
          : defaults.get(occurrence.parameter);
      if (typeof expected !== 'number' || behavior?.arithmetic_conditions?.[field] !== expected) {
        reject(
          occurrence.path,
          occurrence.kind === 'arithmetic-operand-expression'
            ? 'marked Arithmetic expression did not survive native projection at its evaluated default.'
            : 'marked Arithmetic operand did not survive native projection unchanged.',
          occurrence.source,
        );
      }
      continue;
    }
    const behavior = entity?.native.control_behavior as
      | {
          readonly sections?: {
            readonly sections?: readonly {
              readonly index?: number;
              readonly filters?: readonly {
                readonly index?: number;
                readonly count?: number;
                readonly type?: string;
                readonly name?: string;
                readonly quality?: string;
              }[];
            }[];
          };
        }
      | undefined;
    const section = behavior?.sections?.sections?.[occurrence.sectionIndex];
    const filter = section?.filters?.[occurrence.filterIndex];
    if (
      section?.index !== occurrence.sectionIndex + 1 ||
      filter?.index !== occurrence.filterIndex + 1
    ) {
      reject(
        occurrence.path,
        'marked Constant filter did not survive native projection unchanged.',
        occurrence.source,
      );
    }
    if (occurrence.kind === 'constant-signal') {
      const info = signalInfoByParameter.get(occurrence.parameter);
      const name = filter?.name;
      const type = filter?.type ?? 'item';
      const quality = filter?.quality;
      let projectedKey: string | undefined;
      if (typeof name === 'string' && typeof type === 'string') {
        try {
          projectedKey = signalKey({
            type: type as SignalId['type'],
            name,
            ...(typeof quality === 'string' ? { quality } : {}),
          });
        } catch {
          projectedKey = undefined;
        }
      }
      const expectedKey =
        info?.key ??
        (info?.placeholder === undefined
          ? undefined
          : signalKey({ type: 'item', name: info.placeholder }));
      if (info === undefined || projectedKey !== expectedKey) {
        reject(
          occurrence.path,
          'marked Constant Signal default did not survive authenticated projection unchanged.',
          occurrence.source,
        );
      }
      continue;
    }
    if (occurrence.kind === 'constant-count-expression') {
      if (filter.count !== occurrence.measured.defaultValue) {
        reject(
          occurrence.path,
          'marked Constant expression count did not survive native projection at its evaluated default.',
          occurrence.source,
        );
      }
      continue;
    }
    if (filter.count !== defaults.get(occurrence.parameter)) {
      reject(
        occurrence.path,
        'marked Constant count did not survive native projection unchanged.',
        occurrence.source,
      );
    }
  }
  const replacementsByOriginal = new Map<string, string>();
  for (const [parameter, info] of signalInfoByParameter) {
    if (info.key === undefined) continue;
    const placeholder = allocatedSignalNames.get(parameter);
    if (placeholder === undefined) {
      reject(
        `$.parameters[${declarations.indexOf(info.declaration)}]`,
        'native Signal placeholder allocation is incomplete.',
        info.declaration.source,
      );
    }
    replacementsByOriginal.set(info.key, placeholder);
  }
  const patchedByNumber = new Map<number, (typeof projected.entities)[number]['native']>();
  for (const [producerIndex, producer] of replacement.circuit.producers.entries()) {
    if (replacementsByOriginal.size === 0) continue;
    const entityNumber = producerIndex + 1;
    const entity = entities.get(entityNumber);
    if (producer.kind === 'arithmetic') {
      if (entity === undefined) {
        const declaration = signalDeclarations[0]!;
        reject(
          `$.parameters[${declarations.indexOf(declaration)}]`,
          'projected Arithmetic producer is missing its native entity.',
          declaration.source,
        );
      }
      const behavior = readRecord(entity.native.control_behavior);
      const arithmetic = readRecord(behavior?.arithmetic_conditions);
      if (behavior === undefined || arithmetic === undefined) continue;
      let arithmeticChanged = false;
      const nextArithmetic: Record<string, unknown> = { ...arithmetic };
      for (const field of ['first_signal', 'second_signal', 'output_signal'] as const) {
        if (field === 'output_signal' && boundArithmeticOutputProducerIndexes.has(producerIndex)) {
          continue;
        }
        const signalField = readRecord(arithmetic[field]);
        const name = signalField?.name;
        const type = signalField?.type ?? 'item';
        const quality = signalField?.quality;
        if (typeof name !== 'string' || typeof type !== 'string') continue;
        let key: string;
        try {
          key = signalKey({
            type: type as SignalId['type'],
            name,
            ...(typeof quality === 'string' ? { quality } : {}),
          });
        } catch {
          continue;
        }
        const placeholder = replacementsByOriginal.get(key);
        if (placeholder === undefined || signalField === undefined) continue;
        const preservedFields = { ...signalField };
        delete preservedFields.type;
        nextArithmetic[field] = Object.freeze({ ...preservedFields, name: placeholder });
        arithmeticChanged = true;
      }
      if (arithmeticChanged) {
        const nextBehavior = Object.freeze({
          ...behavior,
          arithmetic_conditions: Object.freeze(nextArithmetic),
        }) as unknown as NativeBlueprintJsonObject;
        patchedByNumber.set(
          entityNumber,
          Object.freeze({ ...entity.native, control_behavior: nextBehavior }),
        );
      }
      continue;
    }
    if (producer.kind === 'decider') {
      if (entity === undefined) {
        const declaration = signalDeclarations[0]!;
        reject(
          `$.parameters[${declarations.indexOf(declaration)}]`,
          'projected Decider producer is missing its native entity.',
          declaration.source,
        );
      }
      const behavior = readRecord(entity.native.control_behavior);
      const decider = readRecord(behavior?.decider_conditions);
      const projectionPath = `$.parameters[${declarations.indexOf(signalDeclarations[0]!)}]`;
      if (behavior === undefined || decider === undefined) {
        reject(
          projectionPath,
          'projected Decider configuration is missing during authenticated native export.',
          signalDeclarations[0]!.source,
        );
      }
      const replaceProjectedSignal = (
        value: unknown,
        expected: SignalId,
        slotPath: string,
      ): Record<string, unknown> | undefined => {
        const expectedKey = signalKey(expected);
        const signalField = readRecord(value);
        if (signalField === undefined || nativeSignalKey(signalField) !== expectedKey) {
          reject(
            projectionPath,
            `concrete Decider Signal at ${slotPath} did not survive authenticated native projection unchanged.`,
            signalDeclarations[0]!.source,
          );
        }
        const placeholder = replacementsByOriginal.get(expectedKey);
        if (placeholder === undefined) return undefined;
        const preservedFields = { ...signalField };
        delete preservedFields.type;
        return Object.freeze({ ...preservedFields, name: placeholder });
      };
      let deciderChanged = false;
      const sourceRows = nativeDeciderConditionGroups(
        producer.config.condition,
        options.maxDeciderConditionRows,
      ).flat();
      const conditions = decider.conditions;
      let nextConditions: readonly unknown[] | undefined;
      if (!Array.isArray(conditions) || conditions.length !== sourceRows.length) {
        reject(
          projectionPath,
          'Decider condition rows changed during authenticated native projection.',
          signalDeclarations[0]!.source,
        );
      }
      let conditionsChanged = false;
      const projectedRows = conditions.map((conditionValue, index) => {
        const condition = readRecord(conditionValue);
        const sourceRow = sourceRows[index]!;
        if (condition === undefined) {
          reject(
            projectionPath,
            `Decider condition row ${index} changed during authenticated native projection.`,
            signalDeclarations[0]!.source,
          );
        }
        let conditionChanged = false;
        const nextCondition: Record<string, unknown> = { ...condition };
        if (sourceRow.left.kind === 'signal') {
          const replacement = replaceProjectedSignal(
            condition.first_signal,
            sourceRow.left.signal,
            `conditions[${index}].first_signal`,
          );
          if (replacement !== undefined) {
            nextCondition.first_signal = replacement;
            conditionChanged = true;
          }
        }
        if (sourceRow.right.kind === 'signal') {
          const replacement = replaceProjectedSignal(
            condition.second_signal,
            sourceRow.right.signal,
            `conditions[${index}].second_signal`,
          );
          if (replacement !== undefined) {
            nextCondition.second_signal = replacement;
            conditionChanged = true;
          }
        }
        if (!conditionChanged) return conditionValue;
        conditionsChanged = true;
        return Object.freeze(nextCondition);
      });
      if (conditionsChanged) {
        deciderChanged = true;
        nextConditions = Object.freeze(projectedRows);
      }
      const replaceOutputSignals = (
        nativeValue: unknown,
        sourceOutputs: typeof producer.config.outputs,
        branch: 'outputs' | 'else_outputs',
      ): readonly unknown[] | undefined => {
        if (!Array.isArray(nativeValue) || nativeValue.length !== sourceOutputs.length) {
          reject(
            projectionPath,
            `Decider ${branch} changed during authenticated native projection.`,
            signalDeclarations[0]!.source,
          );
        }
        let outputsChanged = false;
        const nextOutputs = nativeValue.map((outputValue, index) => {
          const output = readRecord(outputValue);
          const sourceOutput = sourceOutputs[index]!;
          if (output === undefined) {
            reject(
              projectionPath,
              `Decider ${branch}[${index}] changed during authenticated native projection.`,
              signalDeclarations[0]!.source,
            );
          }
          if (sourceOutput.signal.kind !== 'signal') return outputValue;
          const replacement = replaceProjectedSignal(
            output.signal,
            sourceOutput.signal.signal,
            `${branch}[${index}].signal`,
          );
          if (replacement === undefined) return outputValue;
          outputsChanged = true;
          return Object.freeze({ ...output, signal: replacement });
        });
        if (!outputsChanged) return undefined;
        deciderChanged = true;
        return Object.freeze(nextOutputs);
      };
      const nextOutputs = replaceOutputSignals(decider.outputs, producer.config.outputs, 'outputs');
      const nextElseOutputs =
        producer.config.elseOutputs === undefined
          ? undefined
          : replaceOutputSignals(decider.else_outputs, producer.config.elseOutputs, 'else_outputs');
      if (deciderChanged) {
        const nextDecider = Object.freeze({
          ...decider,
          ...(nextConditions === undefined ? {} : { conditions: nextConditions }),
          ...(nextOutputs === undefined ? {} : { outputs: nextOutputs }),
          ...(nextElseOutputs === undefined ? {} : { else_outputs: nextElseOutputs }),
        });
        const nextBehavior = Object.freeze({ ...behavior, decider_conditions: nextDecider });
        patchedByNumber.set(
          entityNumber,
          Object.freeze({
            ...entity.native,
            control_behavior: nextBehavior,
          }) as (typeof projected.entities)[number]['native'],
        );
      }
      continue;
    }
    if (producer.kind === 'selector') {
      if (entity === undefined) {
        const declaration = signalDeclarations[0]!;
        reject(
          `$.parameters[${declarations.indexOf(declaration)}]`,
          'projected Selector producer is missing its native entity.',
          declaration.source,
        );
      }
      const behavior = readRecord(entity.native.control_behavior);
      if (behavior === undefined) continue;
      const field = producer.config.operation === 'select' ? 'index_signal' : 'count_signal';
      const signalField = readRecord(behavior[field]);
      const key = nativeSignalKey(signalField);
      const placeholder = key === undefined ? undefined : replacementsByOriginal.get(key);
      if (signalField === undefined || placeholder === undefined) continue;
      const preservedFields = { ...signalField };
      delete preservedFields.type;
      const nextBehavior = Object.freeze({
        ...behavior,
        [field]: Object.freeze({ ...preservedFields, name: placeholder }),
      }) as unknown as NativeBlueprintJsonObject;
      patchedByNumber.set(
        entityNumber,
        Object.freeze({ ...entity.native, control_behavior: nextBehavior }),
      );
      continue;
    }
    if (producer.kind !== 'constant') continue;
    if (entity === undefined) {
      const declaration = signalDeclarations[0]!;
      reject(
        `$.parameters[${declarations.indexOf(declaration)}]`,
        'projected Constant producer is missing its native entity.',
        declaration.source,
      );
    }
    const behavior = readRecord(entity.native.control_behavior);
    const sectionsRecord = readRecord(behavior?.sections);
    const nativeSections = sectionsRecord?.sections;
    if (!Array.isArray(nativeSections)) continue;
    let entityChanged = false;
    const nextSections = nativeSections.map((sectionValue) => {
      const section = readRecord(sectionValue);
      const filtersValue = section?.filters;
      if (!Array.isArray(filtersValue)) return sectionValue;
      let sectionChanged = false;
      const nextFilters = filtersValue.map((filterValue) => {
        const filter = readRecord(filterValue);
        const name = filter?.name;
        const type = filter?.type ?? 'item';
        const quality = filter?.quality;
        if (typeof name !== 'string' || typeof type !== 'string') return filterValue;
        let key: string;
        try {
          key = signalKey({
            type: type as SignalId['type'],
            name,
            ...(typeof quality === 'string' ? { quality } : {}),
          });
        } catch {
          return filterValue;
        }
        const placeholder = replacementsByOriginal.get(key);
        if (placeholder === undefined || filter === undefined) return filterValue;
        const preservedFields = { ...filter };
        delete preservedFields.type;
        sectionChanged = true;
        return Object.freeze({ ...preservedFields, name: placeholder });
      });
      if (!sectionChanged || section === undefined) return sectionValue;
      entityChanged = true;
      return Object.freeze({ ...section, filters: Object.freeze(nextFilters) });
    });
    if (!entityChanged || behavior === undefined || sectionsRecord === undefined) continue;
    const nextBehavior = Object.freeze({
      ...behavior,
      sections: Object.freeze({ ...sectionsRecord, sections: Object.freeze(nextSections) }),
    });
    patchedByNumber.set(
      entityNumber,
      Object.freeze({ ...entity.native, control_behavior: nextBehavior }),
    );
  }
  const projectedEntities =
    patchedByNumber.size === 0
      ? projected.entities
      : Object.freeze(
          projected.entities.map((entity) => {
            const nativeFields = patchedByNumber.get(entity.entityNumber);
            return nativeFields === undefined
              ? entity
              : Object.freeze({ ...entity, native: nativeFields });
          }),
        );
  const constantSourceByProducerIndex = new Map<number, SourceSpan>();
  for (const capture of state.source.constantTemplates) {
    const relation = relations.get(capture.captureId);
    if (relation?.kind === 'constant') {
      constantSourceByProducerIndex.set(relation.producerIndex, capture.source);
    }
  }
  const parameterSourceByPlaceholder = new Map<string, SourceSpan>();
  for (const [parameter, info] of signalInfoByParameter) {
    const placeholder = allocatedSignalNames.get(parameter);
    if (placeholder !== undefined)
      parameterSourceByPlaceholder.set(placeholder, info.declaration.source);
  }
  const projectedByNumber = new Map(
    projectedEntities.map((entity) => [entity.entityNumber, entity]),
  );
  const serializedFieldIdentity = (
    record: Record<string, unknown>,
    key: string,
  ): readonly unknown[] => (record[key] === undefined ? ['absent'] : ['present', record[key]]);
  for (const [producerIndex, producer] of replacement.circuit.producers.entries()) {
    if (producer.kind !== 'constant') continue;
    const entityNumber = producerIndex + 1;
    const entity = projectedByNumber.get(entityNumber);
    const behavior = readRecord(entity?.native.control_behavior);
    const sections = readRecord(behavior?.sections)?.sections;
    if (!Array.isArray(sections)) continue;
    for (const [sectionIndex, sectionValue] of sections.entries()) {
      const section = readRecord(sectionValue);
      const filters = section?.filters;
      if (!Array.isArray(filters)) continue;
      const seen = new Map<string, number>();
      for (const [filterIndex, filterValue] of filters.entries()) {
        const filter = readRecord(filterValue);
        const name = filter?.name;
        const type = filter?.type;
        if (
          filter === undefined ||
          typeof name !== 'string' ||
          (type !== undefined && typeof type !== 'string')
        ) {
          continue;
        }
        const identity = JSON.stringify([
          type ?? 'item',
          name,
          serializedFieldIdentity(filter, 'quality'),
          serializedFieldIdentity(filter, 'comparator'),
        ]);
        const previousIndex = seen.get(identity);
        if (previousIndex !== undefined) {
          const path = `$.blueprint.entities[${entityNumber - 1}].control_behavior.sections.sections[${sectionIndex}].filters[${filterIndex}]`;
          reject(
            path,
            `duplicate native Constant filter identity at entity ${entityNumber}, section ${sectionIndex + 1} (filters ${previousIndex + 1} and ${filterIndex + 1}) would be collapsed by Factorio; use distinct Signals or put intended contributions in separate sections or devices.`,
            constantSourceByProducerIndex.get(producerIndex) ??
              producer.provenance.source ??
              parameterSourceByPlaceholder.get(name),
          );
        }
        seen.set(identity, filterIndex);
      }
    }
  }
  const native = Object.freeze({
    ...projected,
    entities: projectedEntities,
    parameters: Object.freeze(parameters),
  });
  validateNativeBlueprintFcir(native);
  return native;
}

/** Immutable host-local pair of one compilation's concrete Plan and physical circuit. */
export interface BoundSourceCompilationCircuit {
  readonly plan: DirectElaborationPlan;
  readonly resolvedCircuit: ResolvedCircuit;
}

/** Binds this exact compilation into a matching, strictly replayable concrete pair. */
export function bindSourceCompilationCircuit(
  compilation: LocalSourceCompilation,
  bindings: readonly BlueprintParameterBinding[] = [],
): BoundSourceCompilationCircuit {
  const state = capturedParametersByCompilation.get(compilation);
  if (state === undefined) {
    throw new TypeError('Compilation has no host-local source parameter declarations.');
  }
  if (state.execution === undefined || state.plan === undefined) {
    throw new TypeError('Compilation has no canonical execution available for parameter binding.');
  }
  if (state.resolvedCircuit === undefined) {
    throw new TypeError('Compilation has no resolved circuit available for parameter binding.');
  }

  const replacement = bindCapturedSourceConfigurationTemplatesWithRelations(
    state.source,
    state.execution,
    concreteSourceParameterBindings(state.source, bindings),
  );
  const plan = materializeCapturedPlan(
    state.plan,
    replacement.captureRelations,
    replacement.circuit,
  );
  const resolvedCircuit = canonicalResolvedCircuit(
    state.resolvedCircuit,
    plan,
    replacement.circuit,
  ) as ResolvedCircuit;
  executeResolvedDirectPlan(plan, resolvedCircuit);
  return Object.freeze({ plan, resolvedCircuit });
}

/** Runs the complete browser/Node-neutral compilation pipeline once. */
export function compileSourceProgram(
  file: SourceFileSnapshot,
  environment: SourceCompilationEnvironment = {},
  preflightDiagnostics: readonly Diagnostic[] = [],
  observe?: SourceCompilationObserver,
): LocalSourceCompilation {
  observe?.('parse');
  return compileParsedSource(parseFile(file), environment, preflightDiagnostics, observe);
}

/** Compiles an already project-parsed file without repeating parser work. */
export function compileParsedSourceProgram(
  file: ParsedSourceFile,
  environment: SourceCompilationEnvironment = {},
  preflightDiagnostics: readonly Diagnostic[] = [],
  observe?: SourceCompilationObserver,
): LocalSourceCompilation {
  return compileParsedSource(file, environment, preflightDiagnostics, observe);
}

/** Removes every host-local value before a result crosses a process/Worker boundary. */
export function sourceCompilationArtifact(
  compilation: LocalSourceCompilation,
): SourceCompilationArtifact {
  if (parameterSourceArtifacts.has(compilation)) {
    const {
      execution: _execution,
      elaborationJavaScript: _internalLowering,
      ...artifact
    } = compilation;
    return artifact;
  }
  const { execution: _execution, ...artifact } = compilation;
  return artifact;
}

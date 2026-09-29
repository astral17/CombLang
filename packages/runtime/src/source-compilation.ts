import { transformElaborationModule } from '@comblang/compiler/elaboration-transform';
import type {
  DirectElaborationPlan,
  DirectPlanArithmetic,
  DirectPlanDecider,
  DirectPlanProducer,
  PlanArithmeticOperand,
  PlanDeciderCondition,
} from '@comblang/compiler/direct-plan-schema';
import type { EntityPlanConfiguration } from '@comblang/compiler/entity';
import type {
  ArithmeticProducerConfig,
  DeciderProducerConfig,
  LogicalArithmeticOperand,
  LogicalDeciderCondition,
  LogicalDeciderOutput,
} from '@comblang/compiler/ir';
import type { NativeCircuitIr } from '@comblang/compiler/ir';
import type { SignalId } from '@comblang/factorio';
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
  bindCapturedSourceConfigurationTemplatesWithConfigurations,
} from './executed-blueprint-configuration-binding.js';
import type { BoundBlueprintConfiguration } from '../../compiler/src/blueprint-configuration-set.js';
import { executeResolvedDirectPlan } from './direct-plan.js';
import type { BlueprintParameterBinding } from '../../compiler/src/blueprint-parameter-validation.js';
import {
  executeElaborationProgramWithParameters,
  type ExecutedElaborationWithBlueprintParameters,
} from './elaboration-program.js';
import type {
  BlueprintParameterHandle,
  BlueprintParameterKind,
  BlueprintParameterRegistration,
} from '../../compiler/src/blueprint-parameters.js';
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
  readonly defaultValue: number | SignalId;
  readonly source: SourceSpan;
}

function pairMaterializationFailure(): never {
  throw new TypeError('Captured configuration no longer matches its Direct Plan producer.');
}

function materializeArithmeticOperand(
  planned: PlanArithmeticOperand,
  concrete: LogicalArithmeticOperand,
): PlanArithmeticOperand {
  if (planned.kind !== concrete.kind) return pairMaterializationFailure();
  if (planned.kind === 'constant' && concrete.kind === 'constant') {
    return { ...planned, value: concrete.value };
  }
  if (planned.kind === 'signal' && concrete.kind === 'signal') {
    if (planned.refKind !== concrete.refKind) return pairMaterializationFailure();
    return { ...planned, signal: concrete.signal };
  }
  if (planned.kind === 'each' && concrete.kind === 'each') {
    if (planned.refKind !== concrete.refKind) return pairMaterializationFailure();
    return planned;
  }
  return pairMaterializationFailure();
}

function materializeArithmeticProducer(
  planned: DirectPlanArithmetic,
  concrete: ArithmeticProducerConfig,
): DirectPlanArithmetic {
  if (planned.operation !== concrete.operation) return pairMaterializationFailure();
  let output: DirectPlanArithmetic['output'];
  if (planned.output.kind === 'signal' && concrete.output.kind === 'signal') {
    output = { ...planned.output, signal: concrete.output.signal };
  } else if (planned.output.kind === 'each' && concrete.output.kind === 'each') {
    output = planned.output;
  } else {
    return pairMaterializationFailure();
  }
  return {
    ...planned,
    left: materializeArithmeticOperand(planned.left, concrete.left),
    right: materializeArithmeticOperand(planned.right, concrete.right),
    output,
  };
}

function materializeDeciderCondition(
  planned: PlanDeciderCondition,
  concrete: LogicalDeciderCondition,
): PlanDeciderCondition {
  if (planned.kind === 'and' || planned.kind === 'or') {
    if (
      concrete.kind !== planned.kind ||
      planned.conditions.length !== concrete.conditions.length
    ) {
      return pairMaterializationFailure();
    }
    return {
      ...planned,
      conditions: planned.conditions.map((condition, index) =>
        materializeDeciderCondition(condition, concrete.conditions[index]!),
      ),
    };
  }
  if (concrete.kind !== 'compare' || planned.comparator !== concrete.comparator) {
    return pairMaterializationFailure();
  }
  if (planned.kind === 'compare-each') {
    if (
      concrete.left.kind !== 'wildcard' ||
      concrete.left.value !== 'each' ||
      concrete.right.kind !== 'constant'
    ) {
      return pairMaterializationFailure();
    }
    return { ...planned, constant: concrete.right.value };
  }
  if (planned.kind === 'compare-signal') {
    if (concrete.left.kind !== 'signal' || concrete.right.kind !== 'constant') {
      return pairMaterializationFailure();
    }
    return {
      ...planned,
      signal: concrete.left.signal,
      constant: concrete.right.value,
    };
  }
  if (planned.kind === 'compare-wildcard') {
    if (
      concrete.left.kind !== 'wildcard' ||
      concrete.left.value !== planned.wildcard ||
      concrete.right.kind !== 'constant'
    ) {
      return pairMaterializationFailure();
    }
    return { ...planned, constant: concrete.right.value };
  }
  if (planned.kind === 'compare-signals') {
    if (concrete.left.kind !== 'signal' || concrete.right.kind !== 'signal') {
      return pairMaterializationFailure();
    }
    return {
      ...planned,
      left: { ...planned.left, signal: concrete.left.signal },
      right: { ...planned.right, signal: concrete.right.signal },
    };
  }
  if (
    concrete.left.kind !== 'wildcard' ||
    concrete.left.value !== planned.left.wildcard ||
    concrete.right.kind !== 'signal'
  ) {
    return pairMaterializationFailure();
  }
  return {
    ...planned,
    right: { ...planned.right, signal: concrete.right.signal },
  };
}

function materializeDeciderOutput(
  planned: DirectPlanDecider['output'],
  concrete: LogicalDeciderOutput,
): DirectPlanDecider['output'] {
  if (planned.kind === 'each-constant') {
    if (
      concrete.mode !== 'constant' ||
      concrete.signal.kind !== 'wildcard' ||
      concrete.signal.value !== 'each'
    ) {
      return pairMaterializationFailure();
    }
    return { ...planned, value: concrete.value };
  }
  if (planned.kind === 'signal-constant') {
    if (concrete.mode !== 'constant' || concrete.signal.kind !== 'signal') {
      return pairMaterializationFailure();
    }
    return { ...planned, signal: concrete.signal.signal, value: concrete.value };
  }
  if (concrete.mode !== 'copy') return pairMaterializationFailure();
  if (planned.kind === 'each') {
    if (concrete.signal.kind !== 'wildcard' || concrete.signal.value !== 'each') {
      return pairMaterializationFailure();
    }
    return planned;
  }
  if (planned.kind === 'signal') {
    if (concrete.signal.kind !== 'signal') return pairMaterializationFailure();
    return { ...planned, signal: concrete.signal.signal };
  }
  if (concrete.signal.kind !== 'wildcard' || concrete.signal.value !== planned.wildcard) {
    return pairMaterializationFailure();
  }
  return planned;
}

function materializeDeciderProducer(
  planned: DirectPlanDecider,
  concrete: DeciderProducerConfig,
): DirectPlanDecider {
  const plannedOutputs = planned.outputs ?? [planned.output];
  if (plannedOutputs.length !== concrete.outputs.length || concrete.outputs.length === 0) {
    return pairMaterializationFailure();
  }
  const outputs = plannedOutputs.map((output, index) =>
    materializeDeciderOutput(output, concrete.outputs[index]!),
  );
  let elseOutputs: readonly DirectPlanDecider['output'][] | undefined;
  if (planned.elseOutputs !== undefined || concrete.elseOutputs !== undefined) {
    if (
      planned.elseOutputs === undefined ||
      concrete.elseOutputs === undefined ||
      planned.elseOutputs.length !== concrete.elseOutputs.length
    ) {
      return pairMaterializationFailure();
    }
    elseOutputs = planned.elseOutputs.map((output, index) =>
      materializeDeciderOutput(output, concrete.elseOutputs![index]!),
    );
  }
  return {
    ...planned,
    condition: materializeDeciderCondition(planned.condition, concrete.condition),
    output: outputs[0]!,
    ...(planned.outputs === undefined ? {} : { outputs }),
    ...(elseOutputs === undefined ? {} : { elseOutputs }),
  };
}

function materializeCapturedProducer(
  planned: DirectPlanProducer,
  concrete: BoundBlueprintConfiguration,
): DirectPlanProducer {
  if (planned.kind !== concrete.kind) return pairMaterializationFailure();
  switch (concrete.kind) {
    case 'arithmetic':
      if (planned.kind !== 'arithmetic') return pairMaterializationFailure();
      return materializeArithmeticProducer(planned, concrete.config);
    case 'constant':
      if (planned.kind !== 'constant' || planned.configuration === undefined) {
        return pairMaterializationFailure();
      }
      return { ...planned, configuration: concrete.config };
    case 'decider':
      if (planned.kind !== 'decider') return pairMaterializationFailure();
      return materializeDeciderProducer(planned, concrete.config);
    case 'selector':
      if (planned.kind !== 'selector' || planned.operation !== concrete.config.operation) {
        return pairMaterializationFailure();
      }
      if (planned.operation === 'select' && concrete.config.operation === 'select') {
        return { ...planned, index: concrete.config.index };
      }
      if (planned.operation === 'count' && concrete.config.operation === 'count') {
        return { ...planned, output: concrete.config.output };
      }
      return pairMaterializationFailure();
  }
}

function entityPlanConfiguration(producer: DirectPlanProducer): EntityPlanConfiguration {
  switch (producer.kind) {
    case 'constant':
      if (producer.configuration === undefined) return pairMaterializationFailure();
      return { mode: 'constant', value: producer.configuration };
    case 'arithmetic':
      return {
        mode: 'arithmetic',
        left: producer.left,
        operation: producer.operation,
        right: producer.right,
        output: producer.output,
      };
    case 'decider':
      return {
        mode: 'decider',
        condition: producer.condition,
        outputs: producer.outputs ?? [producer.output],
        ...(producer.elseOutputs === undefined ? {} : { elseOutputs: producer.elseOutputs }),
      };
    case 'selector':
      return producer.operation === 'select'
        ? {
            mode: 'selector',
            operation: 'select',
            input: producer.input,
            selectMax: producer.selectMax,
            index: producer.index,
          }
        : {
            mode: 'selector',
            operation: 'count',
            input: producer.input,
            output: producer.output,
          };
  }
}

function materializeCapturedPlan(
  plan: DirectElaborationPlan,
  configurations: readonly BoundBlueprintConfiguration[],
): DirectElaborationPlan {
  const replacements = new Map<number, DirectPlanProducer>();
  for (const configuration of configurations) {
    const matches = plan.producers.flatMap((producer, index) =>
      producer.debugCaptureIds?.includes(configuration.key) ? [index] : [],
    );
    if (matches.length !== 1) return pairMaterializationFailure();
    const index = matches[0]!;
    const producer = plan.producers[index]!;
    if (replacements.has(index)) return pairMaterializationFailure();
    replacements.set(index, materializeCapturedProducer(producer, configuration));
  }
  const producers = plan.producers.map((producer, index) => replacements.get(index) ?? producer);
  const producersByEntityId = new Map(
    [...replacements.values()].flatMap((producer) =>
      producer.entityId === undefined ? [] : [[producer.entityId, producer] as const],
    ),
  );
  const entities = plan.entities.map((entity) => {
    const producer = producersByEntityId.get(entity.id);
    return producer === undefined
      ? entity
      : { ...entity, configuration: entityPlanConfiguration(producer) };
  });
  return canonicalDirectPlan({ ...plan, producers, entities });
}

const capturedParametersByCompilation = new WeakMap<
  object,
  {
    readonly source: ExecutedElaborationWithBlueprintParameters;
    readonly execution?: ExecutedDirectPlan;
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
  let parameterPairedExecution: ExecutedDirectPlan | undefined;
  let resolvedCircuit: ResolvedCircuit | undefined;
  let elaborationJavaScript: string | undefined;
  let hasSourceParameterDeclarations = false;
  let capturedParameters: ExecutedElaborationWithBlueprintParameters | undefined;
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
        parameterPairedExecution = lowered.execution;
        resolvedCircuit = lowered.resolvedCircuit;
        appendCompilerDiagnostics(executedPlan.diagnostics ?? []);
        appendCompilerDiagnostics(lowered.diagnostics);
      }
    } catch (error) {
      plan = undefined;
      execution = undefined;
      appendCompilerDiagnostics([executionFailureDiagnostic(error)]);
    }
  }

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
    ...(plan === undefined ? {} : { plan }),
    ...(resolvedCircuit === undefined ? {} : { resolvedCircuit }),
    ...(execution === undefined ? {} : { execution }),
  } as unknown as Record<string, any>) as unknown as LocalSourceCompilation;
  if (capturedParameters !== undefined) {
    capturedParametersByCompilation.set(compilation, {
      source: capturedParameters,
      ...(parameterPairedExecution === undefined ? {} : { execution: parameterPairedExecution }),
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
      const defaultValue = registration.defaultValue;
      const source = registration.source;
      if (defaultValue === undefined || source === undefined) {
        throw new Error('Captured source parameters must have a concrete default and source span.');
      }
      return Object.freeze({
        parameter: handle,
        kind: registration.kind,
        label: registration.label,
        defaultValue,
        source,
      });
    }),
  );
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
  return bindCapturedSourceConfigurationTemplates(state.source, state.execution, bindings);
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
  if (state.execution === undefined || compilation.plan === undefined) {
    throw new TypeError('Compilation has no canonical execution available for parameter binding.');
  }
  if (compilation.resolvedCircuit === undefined) {
    throw new TypeError('Compilation has no resolved circuit available for parameter binding.');
  }

  const replacement = bindCapturedSourceConfigurationTemplatesWithConfigurations(
    state.source,
    state.execution,
    bindings,
  );
  const plan = materializeCapturedPlan(compilation.plan, replacement.configurations);
  const resolvedCircuit = canonicalResolvedCircuit(
    compilation.resolvedCircuit,
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

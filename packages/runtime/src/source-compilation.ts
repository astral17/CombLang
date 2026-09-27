import { transformElaborationModule } from '@comblang/compiler/elaboration-transform';
import type { DirectElaborationPlan } from '@comblang/compiler/direct-plan-schema';
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
import { canonicalDirectPlan, canonicalizeCompilationArtifacts } from './canonical-circuit.js';
import { bindCapturedSourceConfigurationTemplates } from './executed-blueprint-configuration-binding.js';
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

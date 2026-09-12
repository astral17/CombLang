import { transformElaborationModule } from '@comblang/compiler/elaboration-transform';
import type { DirectElaborationPlan } from '@comblang/compiler/direct-plan-schema';
import type { DirectElaborationPlanV3 } from '@comblang/compiler/entity';
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
import type { Diagnostic } from '@comblang/shared';

import {
  tryElaborateDirectPlan,
  tryElaborateEntityDirectPlan,
  type ExecutedDirectPlan,
  type ExecutedEntityDirectPlan,
} from './direct-plan.js';
import { executeElaborationProgram, executeElaborationProgramV3 } from './elaboration-program.js';
import type { EntityPrototypeResolver } from './entity-registry.js';
import { executionFailureDiagnostic } from './execution-diagnostic.js';
import {
  resolvedSourceCircuitPlanFingerprint,
  snapshotResolvedSourceCircuit,
  type ResolvedSourceCircuit,
} from '@comblang/compiler/resolved-source-circuit';

export interface SourceCompilationEnvironment {
  readonly prototypes?: PrototypeProvider;
  /** Identity-only, cloneable v3 context; host providers and Entity handles stay local. */
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
  readonly plan?: DirectElaborationPlan | DirectElaborationPlanV3;
  /** Detached physical v3 IR; present only after host-authorized lowering succeeds. */
  readonly resolvedCircuit?: ResolvedSourceCircuit;
}

/** Host-local compilation state. Runtime handles never enter the transport artifact. */
export interface LocalSourceCompilation extends SourceCompilationArtifact {
  readonly execution?: ExecutedDirectPlan | ExecutedEntityDirectPlan;
}

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
  const entityReplayContext = replayTransport(environment);
  let plan: DirectElaborationPlan | DirectElaborationPlanV3 | undefined;
  let execution: ExecutedDirectPlan | ExecutedEntityDirectPlan | undefined;
  let resolvedCircuit: ResolvedSourceCircuit | undefined;
  let elaborationJavaScript: string | undefined;
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
      if (!compilerDiagnostics.some(({ severity }) => severity === 'error')) {
        observe?.('execute');
        plan =
          environment.trustedEntityReplayContext === undefined
            ? executeElaborationProgram(program, environment)
            : executeElaborationProgramV3(program, {
                ...environment,
                trustedEntityReplayContext: environment.trustedEntityReplayContext,
              });
        observe?.('lower');
        const lowered =
          plan.version === 3
            ? environment.trustedEntityReplayContext === undefined
              ? (() => {
                  throw new EntityReplayContextError(
                    'ER1001',
                    '$.entityReplayContext',
                    'Entity v3 plans require a host-bound trusted profile-set context.',
                  );
                })()
              : tryElaborateEntityDirectPlan(plan, environment.trustedEntityReplayContext)
            : tryElaborateDirectPlan(plan);
        execution = lowered.execution;
        if (plan.version === 3 && execution !== undefined) {
          resolvedCircuit = snapshotResolvedSourceCircuit({
            format: 'comblang-resolved-source-circuit',
            version: 1,
            planFingerprint: resolvedSourceCircuitPlanFingerprint(plan),
            ir: execution.circuit.ir,
          });
        }
        appendCompilerDiagnostics(plan.diagnostics ?? []);
        appendCompilerDiagnostics(lowered.diagnostics);
      }
    } catch (error) {
      plan = undefined;
      execution = undefined;
      appendCompilerDiagnostics([executionFailureDiagnostic(error)]);
    }
  }

  return {
    fileId: parsed.id,
    diagnostics: parsed.diagnostics,
    topLevel: summarizeTopLevel(parsed),
    semantics: classifyDslSemantics(parsed),
    pipelineDiagnostics,
    compilerDiagnostics,
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
  };
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
  const { execution: _execution, ...artifact } = compilation;
  return artifact;
}

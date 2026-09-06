import { transformElaborationModule } from '@comblang/compiler/elaboration-transform';
import type { DirectElaborationPlan } from '@comblang/compiler/direct-plan-schema';
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

import { tryElaborateDirectPlan, type ExecutedDirectPlan } from './direct-plan.js';
import { executeElaborationProgram } from './elaboration-program.js';
import { executionFailureDiagnostic } from './execution-diagnostic.js';

export interface SourceCompilationEnvironment {
  readonly prototypes?: PrototypeProvider;
}

/** Serializable result safe to send through a browser Worker boundary. */
export interface SourceCompilationArtifact extends ParseWorkerResult {
  /** Every compilation-stage diagnostic in stable execution order. */
  readonly pipelineDiagnostics: readonly Diagnostic[];
  /** Non-parser diagnostics retained for compatibility with parser clients. */
  readonly compilerDiagnostics: readonly Diagnostic[];
  readonly executionMode: 'executed-javascript';
  readonly prototypeIdentity?: string;
  readonly elaborationJavaScript?: string;
  readonly plan?: DirectElaborationPlan;
}

/** Host-local compilation state. Runtime handles never enter the transport artifact. */
export interface LocalSourceCompilation extends SourceCompilationArtifact {
  readonly execution?: ExecutedDirectPlan;
}

export type SourceCompilationStage = 'parse' | 'semantic' | 'transform' | 'execute' | 'lower';

export type SourceCompilationObserver = (stage: SourceCompilationStage) => void;

function compileParsedSource(
  parsed: ParsedSourceFile,
  environment: SourceCompilationEnvironment,
  preflightDiagnostics: readonly Diagnostic[],
  observe?: SourceCompilationObserver,
): LocalSourceCompilation {
  let plan: DirectElaborationPlan | undefined;
  let execution: ExecutedDirectPlan | undefined;
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
        plan = executeElaborationProgram(program, environment);
        observe?.('lower');
        const lowered = tryElaborateDirectPlan(plan);
        execution = lowered.execution;
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
    ...(elaborationJavaScript === undefined ? {} : { elaborationJavaScript }),
    ...(plan === undefined ? {} : { plan }),
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

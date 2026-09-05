import { transformElaborationModule } from '@comblang/compiler/elaboration-transform';
import type { DirectElaborationPlan } from '@comblang/compiler/direct-plan-schema';
import {
  classifyDslSemantics,
  parseFile,
  summarizeTopLevel,
  validateDslSemantics,
  type ParseWorkerRequest,
  type ParseWorkerResult,
} from '@comblang/language';
import type { PrototypeProvider } from '@comblang/prototypes';
import {
  executionFailureDiagnostic,
  executeElaborationProgram,
  tryElaborateDirectPlan,
} from '@comblang/runtime';
import type { Diagnostic } from '@comblang/shared';

export interface CompiledSourceResult extends ParseWorkerResult {
  /** Every compilation-stage diagnostic in stable execution order. */
  readonly pipelineDiagnostics: readonly Diagnostic[];
  /** Non-parser diagnostics retained for compatibility with ParseWorkerResult consumers. */
  readonly compilerDiagnostics: readonly Diagnostic[];
  readonly executionMode: 'executed-javascript';
  readonly elaborationJavaScript?: string;
  readonly plan?: DirectElaborationPlan;
}

export interface SourceCompilationEnvironment {
  readonly prototypes?: PrototypeProvider;
}

export function compileSource(
  file: ParseWorkerRequest['file'],
  environment: SourceCompilationEnvironment = {},
  preflightDiagnostics: readonly Diagnostic[] = [],
): CompiledSourceResult {
  const parsed = parseFile(file);
  let plan: DirectElaborationPlan | undefined;
  let elaborationJavaScript: string | undefined;
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
      const program = transformElaborationModule(parsed);
      elaborationJavaScript = program.code;
      if (!compilerDiagnostics.some(({ severity }) => severity === 'error')) {
        plan = executeElaborationProgram(program, environment);
        const runtimeDiagnostics = tryElaborateDirectPlan(plan).diagnostics;
        appendCompilerDiagnostics(plan.diagnostics ?? []);
        appendCompilerDiagnostics(runtimeDiagnostics);
      }
    } catch (error) {
      plan = undefined;
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
    ...(elaborationJavaScript === undefined ? {} : { elaborationJavaScript }),
    ...(plan === undefined ? {} : { plan }),
  };
}

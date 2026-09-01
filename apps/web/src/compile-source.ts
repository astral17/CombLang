import { transformElaborationModule } from '@comblang/compiler/elaboration-transform';
import type { DirectElaborationPlan } from '@comblang/compiler/direct-plan';
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
  ElaborationExecutionError,
  ElaborationOperationLimitError,
  executeElaborationProgram,
  tryElaborateDirectPlan,
} from '@comblang/runtime';
import type { Diagnostic } from '@comblang/shared';

export interface CompiledSourceResult extends ParseWorkerResult {
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
): CompiledSourceResult {
  const parsed = parseFile(file);
  let plan: DirectElaborationPlan | undefined;
  let elaborationJavaScript: string | undefined;
  const semanticDiagnostics = validateDslSemantics(parsed);
  let compilerDiagnostics: readonly Diagnostic[] = semanticDiagnostics;
  if (parsed.diagnostics.length === 0) {
    try {
      const program = transformElaborationModule(parsed);
      elaborationJavaScript = program.code;
      if (!semanticDiagnostics.some(({ severity }) => severity === 'error')) {
        plan = executeElaborationProgram(program, environment);
        const runtimeDiagnostics = tryElaborateDirectPlan(plan).diagnostics;
        compilerDiagnostics = [
          ...semanticDiagnostics,
          ...(plan.diagnostics ?? []),
          ...runtimeDiagnostics,
        ];
      }
    } catch (error) {
      plan = undefined;
      compilerDiagnostics = [
        ...semanticDiagnostics,
        {
          code:
            error instanceof ElaborationOperationLimitError
              ? 'EX1003'
              : error instanceof ElaborationExecutionError
                ? error.code
                : 'EX1001',
          severity: 'error',
          message: error instanceof Error ? error.message : 'Elaboration execution failed.',
          ...(error instanceof ElaborationExecutionError ? { span: error.span } : {}),
          ...(error instanceof ElaborationExecutionError && error.related !== undefined
            ? { related: error.related }
            : {}),
        },
      ];
    }
  }

  return {
    fileId: parsed.id,
    diagnostics: parsed.diagnostics,
    topLevel: summarizeTopLevel(parsed),
    semantics: classifyDslSemantics(parsed),
    compilerDiagnostics,
    executionMode: 'executed-javascript',
    ...(elaborationJavaScript === undefined ? {} : { elaborationJavaScript }),
    ...(plan === undefined ? {} : { plan }),
  };
}

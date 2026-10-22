import { executeResolvedDirectPlan } from './direct-plan.js';
import {
  listSourceCompilationParameters,
  type LocalSourceCompilation,
} from './source-compilation.js';
import { createSourceParameterBindingSession } from './source-parameter-binding.js';
import {
  assertEmptyTestParameterOverrides,
  runTestsWithExecution,
  snapshotTestParameterOverrides,
  type DirectPlanTestRun,
  type DirectPlanTestRunnerOptions,
} from './test-runner.js';

export interface SourceCompilationTestRunnerOptions extends DirectPlanTestRunnerOptions {
  /** Full run-wide parameter snapshot used when a registered case omits parameters. */
  readonly parameters?: unknown;
}

/** Runs registered cases against isolated bindings from this host-owned compilation. */
export function runSourceCompilationTests(
  compilation: LocalSourceCompilation,
  source: string,
  options: SourceCompilationTestRunnerOptions = {},
): DirectPlanTestRun {
  const hasRunParameters = options.parameters !== undefined;
  let runParameters: unknown;
  let runParametersError: unknown;
  let hasRunParametersError = false;
  if (hasRunParameters) {
    try {
      runParameters = snapshotTestParameterOverrides(options.parameters);
    } catch (error) {
      runParametersError = error;
      hasRunParametersError = true;
    }
  }

  let hasDeclarations = false;
  let bindingSession: ReturnType<typeof createSourceParameterBindingSession> | undefined;
  let bindingSetupError: unknown;
  let hasBindingSetupError = false;
  try {
    if (compilation.pipelineDiagnostics.some(({ severity }) => severity === 'error')) {
      throw new TypeError('Source tests require a compilation without error diagnostics.');
    }
    // Session creation authenticates IDs against this exact host-local result.
    hasDeclarations = listSourceCompilationParameters(compilation).length > 0;
    if (hasDeclarations) bindingSession = createSourceParameterBindingSession(compilation);
  } catch (error) {
    bindingSetupError = error;
    hasBindingSetupError = true;
  }

  const executionForCase = (caseParameters?: unknown) => {
    const hasCaseParameters = caseParameters !== undefined;
    const effectiveParameters = hasCaseParameters ? caseParameters : runParameters;
    const hasEffectiveParameters = hasCaseParameters || hasRunParameters;

    if (!hasEffectiveParameters && !hasBindingSetupError) {
      if (compilation.execution !== undefined) return compilation.execution;
      if (bindingSession !== undefined) {
        const bound = bindingSession.bind();
        return executeResolvedDirectPlan(bound.plan, bound.resolvedCircuit);
      }
      throw new TypeError('Source compilation has no executable direct plan.');
    }
    if (hasBindingSetupError) throw bindingSetupError;
    if (hasEffectiveParameters && !hasCaseParameters && hasRunParametersError) {
      throw runParametersError;
    }

    if (!hasDeclarations) {
      assertEmptyTestParameterOverrides(effectiveParameters);
      if (compilation.execution !== undefined) return compilation.execution;
      throw new TypeError('Source compilation has no executable direct plan.');
    }
    if (bindingSession === undefined) {
      throw new TypeError('Source parameter binding session was not created.');
    }
    const bound = bindingSession.bind(effectiveParameters);
    return executeResolvedDirectPlan(bound.plan, bound.resolvedCircuit);
  };

  const { parameters: _parameters, ...runnerOptions } = options;
  return runTestsWithExecution(executionForCase, source, runnerOptions);
}

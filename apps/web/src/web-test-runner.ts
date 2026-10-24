import type { DirectElaborationPlan } from '@comblang/compiler/direct-plan-schema';
import type { ResolvedCircuit } from '@comblang/compiler/resolved-circuit';
import {
  executeResolvedDirectPlan,
  runDirectPlanTests,
  runResolvedDirectPlanTests,
  runTestsWithExecutionResolver,
  type DirectPlanTestCaseResult,
  type DirectPlanTestRun,
} from '@comblang/runtime';
import type { TestWorkerBindingFailure } from './test-worker-protocol.js';

export type WebTestResult = DirectPlanTestCaseResult;
export type WebTestRun = DirectPlanTestRun;

export interface WebTestCircuitPair {
  readonly plan: DirectElaborationPlan;
  readonly resolvedCircuit: ResolvedCircuit;
}

export function runWebTests(
  plan: DirectElaborationPlan,
  source: string,
  resolvedCircuit?: ResolvedCircuit,
): WebTestRun {
  if (plan.entities.length > 0 && resolvedCircuit === undefined) {
    return {
      results: [
        {
          name: 'Circuit setup',
          status: 'failed',
          failureKind: 'runtime',
          message: 'Entity-bearing canonical plans require a matching resolved circuit.',
        },
      ],
      passed: 0,
      failed: 1,
    };
  }
  if (resolvedCircuit !== undefined) {
    return runResolvedDirectPlanTests(plan, resolvedCircuit, source, {
      sourceName: 'circuit.test.js',
      stackLineOffset: 3,
    });
  }
  return runDirectPlanTests(plan, source, {
    sourceName: 'circuit.test.js',
    stackLineOffset: 3,
  });
}

export function runWebTestsWithExecutionResolver(
  resolveCircuit: (parameters?: unknown) => Promise<WebTestCircuitPair>,
  source: string,
): Promise<WebTestRun> {
  return runTestsWithExecutionResolver(
    async (parameters) => {
      let pair: WebTestCircuitPair;
      try {
        pair = await resolveCircuit(parameters);
      } catch (error) {
        if (isTestWorkerBindingFailure(error)) throw reconstructBindingError(error);
        throw error;
      }
      return executeResolvedDirectPlan(pair.plan, pair.resolvedCircuit);
    },
    source,
    {
      sourceName: 'circuit.test.js',
      stackLineOffset: 3,
    },
  );
}

function isTestWorkerBindingFailure(error: unknown): error is TestWorkerBindingFailure {
  return (
    typeof error === 'object' &&
    error !== null &&
    typeof (error as { readonly message?: unknown }).message === 'string' &&
    (error as { readonly code?: unknown }).code !== undefined
  );
}

function reconstructBindingError(failure: TestWorkerBindingFailure): Error {
  const error = new Error(failure.message);
  if (failure.code !== undefined) {
    error.name =
      failure.code === 'CP1000' || failure.code === 'CP1001' || failure.code === 'CP1002'
        ? 'BlueprintParameterError'
        : 'TestBindingError';
    Object.assign(error, {
      code: failure.code,
      ...(failure.path === undefined ? {} : { path: failure.path }),
      ...(failure.span === undefined ? {} : { span: failure.span }),
    });
  }
  return error;
}

import type { DirectElaborationPlan } from '@comblang/compiler/direct-plan-schema';
import type { ResolvedCircuit } from '@comblang/compiler/resolved-circuit';
import {
  runDirectPlanTests,
  runResolvedDirectPlanTests,
  type DirectPlanTestCaseResult,
  type DirectPlanTestRun,
} from '@comblang/runtime';

export type WebTestResult = DirectPlanTestCaseResult;
export type WebTestRun = DirectPlanTestRun;

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

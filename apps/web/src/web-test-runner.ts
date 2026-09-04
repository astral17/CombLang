import type { DirectElaborationPlan } from '@comblang/compiler/direct-plan-schema';
import {
  runDirectPlanTests,
  type DirectPlanTestCaseResult,
  type DirectPlanTestRun,
} from '@comblang/runtime';

export type WebTestResult = DirectPlanTestCaseResult;
export type WebTestRun = DirectPlanTestRun;

export function runWebTests(plan: DirectElaborationPlan, source: string): WebTestRun {
  return runDirectPlanTests(plan, source, {
    sourceName: 'circuit.test.js',
    stackLineOffset: 3,
  });
}

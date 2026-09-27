import type { DirectElaborationPlan } from '@comblang/compiler/direct-plan-schema';
import type { ResolvedCircuit } from '@comblang/compiler/resolved-circuit';

import type { WebTestRun } from './web-test-runner.js';

export interface TestWorkerRequest {
  readonly kind: 'test';
  readonly revision: number;
  readonly plan: DirectElaborationPlan;
  readonly resolvedCircuit?: ResolvedCircuit;
  readonly source: string;
}

export interface TestWorkerResponse {
  readonly kind: 'tested';
  readonly revision: number;
  readonly run: WebTestRun;
}

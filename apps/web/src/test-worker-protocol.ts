import type { DirectElaborationPlan } from '@comblang/compiler/direct-plan-schema';
import type { ResolvedCircuit } from '@comblang/compiler/resolved-circuit';
import type { SourceSpan } from '@comblang/shared';

import type { WebTestRun } from './web-test-runner.js';

export interface TestWorkerRequest {
  readonly kind: 'test';
  readonly revision: number;
  readonly plan: DirectElaborationPlan;
  readonly resolvedCircuit?: ResolvedCircuit;
  readonly source: string;
}

export interface TestWorkerSourceRequest {
  readonly kind: 'test-source';
  readonly revision: number;
  readonly sourceRevision: number;
  readonly source: string;
}

export interface TestWorkerBindRequest {
  readonly kind: 'test-bind-request';
  readonly revision: number;
  readonly sourceRevision: number;
  readonly requestId: number;
  readonly hasParameters: boolean;
  readonly parameters?: unknown;
}

export interface TestWorkerBindingFailure {
  readonly message: string;
  readonly code?: string;
  readonly path?: string;
  readonly span?: SourceSpan;
}

export type TestWorkerBindResult =
  | {
      readonly ok: true;
      readonly plan: DirectElaborationPlan;
      readonly resolvedCircuit: ResolvedCircuit;
    }
  | { readonly ok: false; readonly error: TestWorkerBindingFailure };

export interface TestWorkerBindResponse {
  readonly kind: 'test-bind-response';
  readonly revision: number;
  readonly sourceRevision: number;
  readonly requestId: number;
  readonly result: TestWorkerBindResult;
}

export interface TestWorkerTestedResponse {
  readonly kind: 'tested';
  readonly revision: number;
  readonly run: WebTestRun;
}

export interface TestWorkerPhaseResponse {
  readonly kind: 'test-phase';
  readonly revision: number;
  readonly phase: 'executing' | 'waiting-for-binding';
}

export type TestWorkerResponse =
  TestWorkerBindRequest | TestWorkerTestedResponse | TestWorkerPhaseResponse;

export type TestWorkerInboundMessage =
  TestWorkerRequest | TestWorkerSourceRequest | TestWorkerBindResponse;

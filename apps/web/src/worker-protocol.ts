import type { DirectElaborationPlan } from '@comblang/compiler/direct-plan';
import type { ParseWorkerRequest, ParseWorkerResult } from '@comblang/language';
import type { Diagnostic } from '@comblang/shared';

export type CompilerWorkerRequest = ParseWorkerRequest;

export interface CompilerWorkerResponse {
  readonly kind: 'parsed';
  readonly revision: number;
  readonly result: ParseWorkerResult & {
    readonly compilerDiagnostics: readonly Diagnostic[];
    readonly executionMode: 'executed-javascript';
    readonly elaborationJavaScript?: string;
    readonly plan?: DirectElaborationPlan;
  };
}

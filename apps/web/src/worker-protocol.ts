import type { ParseWorkerRequest } from '@comblang/language';

import type { CompiledSourceResult } from './compile-source.js';

export type CompilerWorkerRequest = ParseWorkerRequest;

export interface CompilerWorkerResponse {
  readonly kind: 'parsed';
  readonly revision: number;
  readonly result: CompiledSourceResult;
}

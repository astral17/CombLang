import type { CompiledSourceResult } from './compile-source.js';
import type { PrototypeDatabaseCapabilities, PrototypeEnvironment } from '@comblang/prototypes';

export interface BrowserPrototypeProfileSource {
  /** Normalized Prototype Database JSON. It is parsed only inside the Worker. */
  readonly source: string;
  readonly expectedIdentity?: string;
}

export interface BrowserPrototypeProfileReference {
  /** Identity previously confirmed by this Worker instance. */
  readonly identity: string;
}

export type BrowserPrototypeProfile =
  BrowserPrototypeProfileSource | BrowserPrototypeProfileReference;

export interface CompilerWorkerRequest {
  readonly kind: 'parse';
  readonly revision: number;
  readonly file: { readonly path: string; readonly text: string };
  readonly prototypeProfile?: BrowserPrototypeProfile;
}

export interface BrowserPrototypeEnvironmentReport {
  readonly identity: string;
  readonly factorioVersion: string;
  readonly expansions: readonly string[];
  readonly mods: PrototypeEnvironment['mods'];
  readonly capabilities: PrototypeDatabaseCapabilities;
}

export interface CompilerWorkerResponse {
  readonly kind: 'parsed';
  readonly revision: number;
  readonly result: CompiledSourceResult;
  readonly prototypeEnvironment?: BrowserPrototypeEnvironmentReport;
}

import type { CompiledSourceResult } from './compile-source.js';
import type { EntityReplayContextTransport } from '@comblang/compiler/entity-replay-context';
import type { SourceCompilationStage } from '@comblang/runtime/source-compilation';
import type {
  FactorioDumpWarning,
  PrototypeDatabaseCapabilities,
  PrototypeEnvironment,
} from '@comblang/prototypes';

export interface BrowserPrototypeProfileSource {
  /** Normalized or raw Factorio Prototype JSON. It is parsed only inside the Worker. */
  readonly source: string;
  /** Routing metadata only; authority is built from the loaded provider in the Worker. */
  readonly kind?: 'builtin' | 'custom';
  /** Companion metadata JSON required only for a raw Factorio dump. */
  readonly factorioDumpMetadata?: string;
  /** Generated-asset manifest for a normalized database source. */
  readonly assetManifest?: string;
  readonly expectedIdentity?: string;
}

export interface BrowserPrototypeProfileReference {
  /** Identity previously confirmed by this Worker instance. */
  readonly identity: string;
  /** Routing metadata only; authority is built from the cached provider in the Worker. */
  readonly kind?: 'builtin' | 'custom';
}

export type BrowserPrototypeProfile =
  BrowserPrototypeProfileSource | BrowserPrototypeProfileReference;

export interface CompilerWorkerRequest {
  readonly kind: 'parse';
  readonly revision: number;
  readonly file: { readonly path: string; readonly text: string };
  readonly prototypeProfile?: BrowserPrototypeProfile;
  readonly entityReplayContext?: EntityReplayContextTransport;
}

export interface BrowserPrototypeEnvironmentReport {
  readonly identity: string;
  readonly format: 'normalized' | 'factorio-data-raw';
  readonly factorioVersion: string;
  readonly expansions: readonly string[];
  readonly mods: PrototypeEnvironment['mods'];
  readonly capabilities: PrototypeDatabaseCapabilities;
  readonly warnings: readonly FactorioDumpWarning[];
}

export interface CompilerWorkerReadyResponse {
  readonly kind: 'ready';
}

export type CompilerWorkerProgressStage =
  'receive' | 'profile' | SourceCompilationStage | 'transport';

export interface CompilerWorkerProgressResponse {
  readonly kind: 'progress';
  readonly revision: number;
  readonly stage: CompilerWorkerProgressStage;
}

export interface CompilerWorkerParsedResponse {
  readonly kind: 'parsed';
  readonly revision: number;
  readonly result: CompiledSourceResult;
  readonly prototypeEnvironment?: BrowserPrototypeEnvironmentReport;
}

export type CompilerWorkerResponse =
  CompilerWorkerReadyResponse | CompilerWorkerProgressResponse | CompilerWorkerParsedResponse;

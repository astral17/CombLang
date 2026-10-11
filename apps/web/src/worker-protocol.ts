import type { CompiledSourceResult } from './compile-source.js';
import type { EntityReplayContextTransport } from '@comblang/compiler/entity-replay-context';
import type { SourceCompilationStage } from '@comblang/runtime/source-compilation';
import type {
  FactorioDumpWarning,
  PrototypeDatabaseCapabilities,
  PrototypeEnvironment,
} from '@comblang/prototypes';
import type { Diagnostic, DiagnosticPolicy } from '@comblang/shared';
import type { BlueprintExportOptions } from './blueprint-export.js';
import type { SourceParameterDescriptor } from '@comblang/runtime/source-parameter-binding';
import type { BoundSourceCompilationCircuit } from '@comblang/runtime/source-compilation';
import type {
  BlueprintSourceImportDiagnostic,
  CanonicalBlueprintSourceImportResult,
} from '@comblang/runtime/blueprint-source-import';

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
  readonly diagnosticPolicy?: DiagnosticPolicy;
  readonly prototypeProfile?: BrowserPrototypeProfile;
  readonly entityReplayContext?: EntityReplayContextTransport;
  readonly blueprintExport?: BlueprintExportOptions;
  readonly parameterBinding?: boolean;
}

export interface CompilerWorkerBindRequest {
  readonly kind: 'bind-parameters';
  /** Request correlation ID; independent of the source compilation revision. */
  readonly revision: number;
  /** Revision of the retained source compilation selected by the token. */
  readonly sourceRevision: number;
  readonly token: string;
  readonly overrides?: unknown;
}

export type CompilerWorkerOperationRequest = CompilerWorkerRequest | CompilerWorkerBindRequest;

/** Import-only request; it is deliberately not part of the page operation protocol. */
export interface CompilerWorkerImportRequest {
  readonly kind: 'import-blueprint';
  /** Request correlation ID, independent of any source compilation revision. */
  readonly revision: number;
  readonly document: { readonly text: string };
  /** Explicit virtual generated TypeScript identity; never resolved as a host path. */
  readonly sourcePath: string;
  readonly prototypeProfile?: BrowserPrototypeProfile;
  readonly entityReplayContext?: EntityReplayContextTransport;
}

export type CompilerWorkerMessageRequest =
  CompilerWorkerOperationRequest | CompilerWorkerImportRequest;

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
  readonly parameterBinding?: CompilerWorkerParameterBindingResult;
}

export interface CompilerWorkerBoundResponse {
  readonly kind: 'bound';
  readonly revision: number;
  readonly sourceRevision: number;
  readonly result:
    | (BoundSourceCompilationCircuit & { readonly ok: true })
    | { readonly ok: false; readonly diagnostics: readonly Diagnostic[] };
}

export type CompilerWorkerParameterBindingResult =
  | {
      readonly ok: true;
      readonly parameters: readonly SourceParameterDescriptor[];
      readonly token?: string;
    }
  | { readonly ok: false; readonly diagnostics: readonly Diagnostic[] };

export type CompilerWorkerResponse =
  | CompilerWorkerReadyResponse
  | CompilerWorkerProgressResponse
  | CompilerWorkerParsedResponse
  | CompilerWorkerBoundResponse;

export interface CompilerWorkerBlueprintImportLocation {
  readonly path: string;
  readonly start: { readonly line: number; readonly column: number };
  readonly end: { readonly line: number; readonly column: number };
}

export type CompilerWorkerBlueprintImportDiagnostic = BlueprintSourceImportDiagnostic & {
  readonly generatedLocation?: CompilerWorkerBlueprintImportLocation;
};

export type CompilerWorkerBlueprintImportResult =
  | (Omit<
      Extract<CanonicalBlueprintSourceImportResult, { readonly state: 'verified' }>,
      'diagnosticContext' | 'diagnostics'
    > & {
      readonly diagnostics: readonly CompilerWorkerBlueprintImportDiagnostic[];
    })
  | {
      readonly state: 'blocked';
      readonly diagnostics: readonly CompilerWorkerBlueprintImportDiagnostic[];
      readonly error?: {
        readonly code: string;
        readonly message: string;
        readonly path?: string;
      };
    };

export interface CompilerWorkerImportedResponse {
  readonly kind: 'blueprint-imported';
  readonly revision: number;
  readonly result: CompilerWorkerBlueprintImportResult;
  readonly prototypeEnvironment?: BrowserPrototypeEnvironmentReport;
}

export type CompilerWorkerMessageResponse = CompilerWorkerResponse | CompilerWorkerImportedResponse;

import {
  cloneEntityReplayContextTransport,
  EntityReplayContextError,
  entityReplayContextIdentity,
  entityReplayContextTransport,
  type EntityReplayContextTransport,
  type TrustedEntityReplayContext,
} from '@comblang/compiler/entity-replay-context';
import {
  FactorioDumpError,
  loadPrototypeInputJson,
  loadPrototypeAsset,
  PrototypeAssetError,
  PrototypeInputError,
  PrototypeValidationError,
  type LoadedPrototypeInput,
} from '@comblang/prototypes';
import { parseDiagnosticPolicy, type Diagnostic, type DiagnosticPolicy } from '@comblang/shared';
import type { EntityPrototypeResolver } from '@comblang/runtime/entity-registry';
import type { SourceCompilationEnvironment } from '@comblang/runtime/source-compilation';
import { listSourceCompilationParameters } from '@comblang/runtime/source-compilation';
import {
  createSourceParameterBindingSession,
  type SourceParameterBindingSession,
} from '@comblang/runtime/source-parameter-binding';
import {
  conservativeEntityProvisioningPolicy,
  EntityProvisioningService,
} from '@comblang/runtime/entity-provisioning';

import { compileOwnedSource } from './compile-source.js';
import {
  BrowserBlueprintExportRequestError,
  readBlueprintExportOptions,
  type BlueprintExportOptions,
} from './blueprint-export.js';
import type {
  BrowserPrototypeEnvironmentReport,
  CompilerWorkerProgressStage,
  CompilerWorkerRequest,
  CompilerWorkerParsedResponse,
  CompilerWorkerParameterBindingResult,
} from './worker-protocol.js';

class BrowserPrototypeSelectionError extends Error {
  readonly code = 'WP1001';
}

class BrowserPrototypeCacheMissError extends Error {
  readonly code = 'WP1002';
}

class BrowserDiagnosticPolicyError extends Error {
  readonly code = 'WP1004';
}

class BrowserParameterBindingRequestError extends Error {
  readonly code = 'WP1006';
}

export class CompilerWorkerParameterBindingError extends Error {
  readonly code = 'WP1007';
}

/** Host-local authority supplied after the cloneable replay envelope is checked. */
export interface CompilerWorkerEntityHostContext {
  readonly trustedEntityReplayContext: TrustedEntityReplayContext;
  readonly entityPrototypeResolver?: EntityPrototypeResolver;
}

export interface CompilerWorkerRuntimeOptions {
  /** Resolves host-owned profiles and provider handles for one transport identity. */
  readonly resolveEntityReplayContext?: (
    transport: EntityReplayContextTransport,
  ) => CompilerWorkerEntityHostContext | undefined;
}

function profileFailure(error: unknown): Diagnostic {
  return {
    code:
      error instanceof PrototypeValidationError
        ? error.code
        : error instanceof PrototypeAssetError
          ? error.code
          : error instanceof PrototypeInputError || error instanceof FactorioDumpError
            ? error.code
            : error instanceof BrowserPrototypeSelectionError ||
                error instanceof BrowserPrototypeCacheMissError
              ? error.code
              : error instanceof BrowserDiagnosticPolicyError
                ? error.code
                : error instanceof BrowserBlueprintExportRequestError
                  ? error.code
                  : error instanceof BrowserParameterBindingRequestError
                    ? error.code
                    : error instanceof EntityReplayContextError
                      ? error.code
                      : 'WP1003',
    severity: 'error',
    message: error instanceof Error ? error.message : 'Unable to load the prototype profile.',
  };
}

function readParameterBindingFlag(request: CompilerWorkerRequest): boolean {
  const descriptor = Object.getOwnPropertyDescriptor(request, 'parameterBinding');
  if (descriptor === undefined) return false;
  if (!('value' in descriptor) || !descriptor.enumerable) {
    throw new BrowserParameterBindingRequestError(
      '$.parameterBinding: expected an enumerable data property.',
    );
  }
  if (descriptor.value === undefined) return false;
  if (typeof descriptor.value !== 'boolean') {
    throw new BrowserParameterBindingRequestError('$.parameterBinding: expected a boolean.');
  }
  return descriptor.value;
}

interface WorkerCompileOptions {
  readonly epoch: number;
  readonly revision: number;
  readonly file: { readonly path: string; readonly text: string };
  readonly parameterBinding: boolean;
  readonly environment?: SourceCompilationEnvironment;
  readonly preflightDiagnostics?: readonly Diagnostic[];
  readonly observe: ((stage: CompilerWorkerProgressStage) => void) | undefined;
  readonly blueprintExport: BlueprintExportOptions | undefined;
  readonly prototypeEnvironment?: BrowserPrototypeEnvironmentReport;
}

export class CompilerWorkerRuntime {
  readonly #profiles = new Map<string, LoadedPrototypeInput>();
  readonly #entityProvisioning = new EntityProvisioningService();
  #parameterSession:
    | {
        readonly token: string;
        readonly revision: number;
        readonly session: SourceParameterBindingSession;
      }
    | undefined;
  #parseEpoch = 0;
  #tokenNonce: string | undefined;
  #tokenSequence = 0;
  readonly #resolveEntityReplayContext:
    | ((transport: EntityReplayContextTransport) => CompilerWorkerEntityHostContext | undefined)
    | undefined;

  constructor(options: CompilerWorkerRuntimeOptions = {}) {
    this.#resolveEntityReplayContext = options.resolveEntityReplayContext;
  }

  async handle(
    request: CompilerWorkerRequest,
    observe?: (stage: CompilerWorkerProgressStage) => void,
  ): Promise<CompilerWorkerParsedResponse> {
    const epoch = ++this.#parseEpoch;
    this.#parameterSession = undefined;
    const revision = request.revision;
    const file = Object.freeze({ path: request.file.path, text: request.file.text });
    observe?.('receive');
    let parameterBinding: boolean;
    try {
      parameterBinding = readParameterBindingFlag(request);
    } catch (error) {
      return this.#compileResponse({
        epoch,
        revision,
        file,
        parameterBinding: false,
        preflightDiagnostics: [profileFailure(error)],
        observe,
        blueprintExport: {},
      });
    }
    let blueprintExport: BlueprintExportOptions | undefined;
    try {
      blueprintExport = readBlueprintExportOptions(request);
    } catch (error) {
      return this.#compileResponse({
        epoch,
        revision,
        file,
        parameterBinding,
        preflightDiagnostics: [profileFailure(error)],
        observe,
        blueprintExport: {},
      });
    }
    let diagnosticPolicy: DiagnosticPolicy | undefined;
    try {
      diagnosticPolicy =
        request.diagnosticPolicy === undefined
          ? undefined
          : parseDiagnosticPolicy(request.diagnosticPolicy);
    } catch (error) {
      return this.#compileResponse({
        epoch,
        revision,
        file,
        parameterBinding,
        preflightDiagnostics: [
          profileFailure(
            new BrowserDiagnosticPolicyError(
              error instanceof Error ? error.message : 'Invalid diagnostic policy.',
            ),
          ),
        ],
        observe,
        blueprintExport,
      });
    }
    let entityReplayContext: EntityReplayContextTransport | undefined;
    let entityHostContext: CompilerWorkerEntityHostContext | undefined;
    try {
      entityReplayContext =
        request.entityReplayContext === undefined
          ? undefined
          : cloneEntityReplayContextTransport(request.entityReplayContext);
      if (entityReplayContext !== undefined && this.#resolveEntityReplayContext !== undefined) {
        entityHostContext = this.#resolveEntityReplayContext(entityReplayContext);
        if (entityHostContext !== undefined) {
          const trustedTransport = entityReplayContextTransport(
            entityHostContext.trustedEntityReplayContext,
          );
          if (
            entityReplayContextIdentity(trustedTransport) !==
            entityReplayContextIdentity(entityReplayContext)
          ) {
            throw new EntityReplayContextError(
              'ER1001',
              '$.entityReplayContext',
              'host-bound trusted context does not match the request transport.',
            );
          }
        }
      }
    } catch (error) {
      return this.#compileResponse({
        epoch,
        revision,
        file,
        parameterBinding,
        preflightDiagnostics: [profileFailure(error)],
        observe,
        blueprintExport,
      });
    }
    if (request.prototypeProfile === undefined) {
      return this.#compileResponse({
        epoch,
        revision,
        file,
        parameterBinding,
        environment: {
          ...(diagnosticPolicy === undefined ? {} : { diagnosticPolicy }),
          ...(entityReplayContext === undefined ? {} : { entityReplayContext }),
          ...(entityHostContext === undefined
            ? {}
            : {
                trustedEntityReplayContext: entityHostContext.trustedEntityReplayContext,
                ...(entityHostContext.entityPrototypeResolver === undefined
                  ? {}
                  : { entityPrototypeResolver: entityHostContext.entityPrototypeResolver }),
              }),
        },
        observe,
        blueprintExport,
      });
    }
    let compileEnvironment: SourceCompilationEnvironment;
    let prototypeEnvironment: BrowserPrototypeEnvironmentReport;
    try {
      const profile = request.prototypeProfile;
      observe?.('profile');
      if (
        'source' in profile &&
        profile.assetManifest !== undefined &&
        profile.factorioDumpMetadata !== undefined
      ) {
        throw new BrowserPrototypeSelectionError(
          'A prototype profile cannot combine raw-dump metadata with a generated-asset manifest.',
        );
      }
      const referenceIdentity = 'identity' in profile ? profile.identity : undefined;
      const loaded =
        'source' in profile
          ? profile.assetManifest === undefined
            ? await loadPrototypeInputJson(profile.source, {
                ...(profile.factorioDumpMetadata === undefined
                  ? {}
                  : { factorioDumpMetadata: profile.factorioDumpMetadata }),
              })
            : {
                ...(await loadPrototypeAsset(profile.source, profile.assetManifest)),
                format: 'normalized' as const,
                warnings: Object.freeze([]),
              }
          : this.#profiles.get(profile.identity);
      if (loaded === undefined) {
        throw new BrowserPrototypeCacheMissError(
          `Prototype environment ${referenceIdentity} is not loaded in this Worker; send its database JSON again.`,
        );
      }
      if ('source' in profile) {
        if (
          profile.expectedIdentity !== undefined &&
          profile.expectedIdentity !== loaded.prototypes.identity
        ) {
          throw new BrowserPrototypeSelectionError(
            `Prototype identity mismatch: expected ${profile.expectedIdentity}, loaded ${loaded.prototypes.identity}.`,
          );
        }
        this.#profiles.set(loaded.prototypes.identity, loaded);
      }
      const environment: BrowserPrototypeEnvironmentReport = Object.freeze({
        identity: loaded.prototypes.identity,
        format: loaded.format,
        factorioVersion: loaded.prototypes.environment.factorioVersion,
        expansions: loaded.prototypes.environment.expansions,
        mods: loaded.prototypes.environment.mods,
        capabilities: loaded.prototypes.capabilities,
        warnings: loaded.warnings,
      });
      const provisioned = this.#entityProvisioning.provision(
        loaded.prototypes,
        conservativeEntityProvisioningPolicy,
      );
      if (entityHostContext !== undefined) {
        const trustedDatabase = entityHostContext.trustedEntityReplayContext.database;
        if (
          trustedDatabase.schemaVersion !== loaded.prototypes.schemaVersion ||
          trustedDatabase.identity !== loaded.prototypes.identity
        ) {
          throw new EntityReplayContextError(
            'ER1001',
            '$.entityReplayContext.database',
            'host-bound Entity context does not match the selected provider.',
          );
        }
        entityHostContext = {
          trustedEntityReplayContext: entityHostContext.trustedEntityReplayContext,
          entityPrototypeResolver:
            entityHostContext.entityPrototypeResolver ?? provisioned.entityPrototypeResolver,
        };
      } else {
        if (
          entityReplayContext !== undefined &&
          entityReplayContextIdentity(entityReplayContext) !==
            entityReplayContextIdentity(provisioned.entityReplayContext)
        ) {
          throw new EntityReplayContextError(
            'ER1001',
            '$.entityReplayContext',
            'selected Entity replay identity does not match the loaded provider.',
          );
        }
        entityReplayContext = provisioned.entityReplayContext;
        entityHostContext = {
          trustedEntityReplayContext: provisioned.trustedEntityReplayContext,
          entityPrototypeResolver: provisioned.entityPrototypeResolver,
        };
      }
      prototypeEnvironment = environment;
      compileEnvironment = {
        prototypes: loaded.prototypes,
        ...(diagnosticPolicy === undefined ? {} : { diagnosticPolicy }),
        ...(entityReplayContext === undefined ? {} : { entityReplayContext }),
        ...(entityHostContext === undefined
          ? {}
          : {
              trustedEntityReplayContext: entityHostContext.trustedEntityReplayContext,
              ...(entityHostContext.entityPrototypeResolver === undefined
                ? {}
                : { entityPrototypeResolver: entityHostContext.entityPrototypeResolver }),
            }),
      };
    } catch (error) {
      return this.#compileResponse({
        epoch,
        revision,
        file,
        parameterBinding,
        preflightDiagnostics: [profileFailure(error)],
        observe,
        blueprintExport,
      });
    }
    return this.#compileResponse({
      epoch,
      revision,
      file,
      parameterBinding,
      environment: compileEnvironment,
      observe,
      blueprintExport,
      prototypeEnvironment,
    });
  }

  bindParameters(token: string, sourceRevision: number, overrides?: unknown) {
    const retained = this.#parameterSession;
    if (
      retained === undefined ||
      retained.token !== token ||
      retained.revision !== sourceRevision
    ) {
      throw new CompilerWorkerParameterBindingError(
        'WP1007: parameter binding token is missing, expired, or belongs to another source revision.',
      );
    }
    return retained.session.bind(overrides);
  }

  #issueToken(): string {
    if (this.#tokenNonce === undefined) {
      const cryptoApi = globalThis.crypto;
      if (cryptoApi === undefined || typeof cryptoApi.getRandomValues !== 'function') {
        throw new CompilerWorkerParameterBindingError(
          'WP1007: this runtime cannot allocate a parameter binding token.',
        );
      }
      const bytes = cryptoApi.getRandomValues(new Uint8Array(16));
      this.#tokenNonce = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
    }
    this.#tokenSequence += 1;
    return `${this.#tokenNonce}.${this.#tokenSequence.toString(36)}`;
  }

  #compileResponse(options: WorkerCompileOptions): CompilerWorkerParsedResponse {
    const owned = compileOwnedSource(
      options.file,
      options.environment,
      options.preflightDiagnostics,
      options.observe,
      options.blueprintExport,
    );
    const response: CompilerWorkerParsedResponse = {
      kind: 'parsed',
      revision: options.revision,
      result: owned.result,
      ...(options.prototypeEnvironment === undefined
        ? {}
        : { prototypeEnvironment: options.prototypeEnvironment }),
    };
    if (!options.parameterBinding || options.epoch !== this.#parseEpoch) return response;

    const errors = owned.compilation.pipelineDiagnostics.filter(
      ({ severity }) => severity === 'error',
    );
    if (errors.length > 0) {
      return { ...response, parameterBinding: { ok: false, diagnostics: errors } };
    }

    try {
      if (listSourceCompilationParameters(owned.compilation).length === 0) {
        return { ...response, parameterBinding: { ok: true, parameters: [] } };
      }
      const session = createSourceParameterBindingSession(owned.compilation);
      const token = this.#issueToken();
      this.#parameterSession = { token, revision: options.revision, session };
      return {
        ...response,
        parameterBinding: { ok: true, parameters: session.parameters, token },
      };
    } catch (error) {
      const diagnostic: Diagnostic = {
        code: 'WP1007',
        severity: 'error',
        message: error instanceof Error ? error.message : 'Unable to retain parameter bindings.',
      };
      return { ...response, parameterBinding: { ok: false, diagnostics: [diagnostic] } };
    }
  }
}

const defaultRuntime = new CompilerWorkerRuntime();

export function handleCompilerWorkerRequest(
  request: CompilerWorkerRequest,
  observe?: (stage: CompilerWorkerProgressStage) => void,
) {
  return defaultRuntime.handle(request, observe);
}

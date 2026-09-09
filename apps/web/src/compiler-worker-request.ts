import {
  cloneEntityReplayContextTransport,
  EntityReplayContextError,
} from '@comblang/compiler/entity-replay-context';
import {
  FactorioDumpError,
  loadPrototypeInputJson,
  PrototypeInputError,
  PrototypeValidationError,
  type LoadedPrototypeInput,
} from '@comblang/prototypes';
import type { Diagnostic } from '@comblang/shared';

import { compileSource } from './compile-source.js';
import type {
  BrowserPrototypeEnvironmentReport,
  CompilerWorkerProgressStage,
  CompilerWorkerRequest,
  CompilerWorkerParsedResponse,
} from './worker-protocol.js';

class BrowserPrototypeSelectionError extends Error {
  readonly code = 'WP1001';
}

class BrowserPrototypeCacheMissError extends Error {
  readonly code = 'WP1002';
}

function profileFailure(error: unknown): Diagnostic {
  return {
    code:
      error instanceof PrototypeValidationError
        ? error.code
        : error instanceof PrototypeInputError || error instanceof FactorioDumpError
          ? error.code
          : error instanceof BrowserPrototypeSelectionError ||
              error instanceof BrowserPrototypeCacheMissError
            ? error.code
            : error instanceof EntityReplayContextError
              ? error.code
              : 'WP1003',
    severity: 'error',
    message: error instanceof Error ? error.message : 'Unable to load the prototype profile.',
  };
}

export class CompilerWorkerRuntime {
  readonly #profiles = new Map<string, LoadedPrototypeInput>();

  async handle(
    request: CompilerWorkerRequest,
    observe?: (stage: CompilerWorkerProgressStage) => void,
  ): Promise<CompilerWorkerParsedResponse> {
    observe?.('receive');
    let entityReplayContext;
    try {
      entityReplayContext =
        request.entityReplayContext === undefined
          ? undefined
          : cloneEntityReplayContextTransport(request.entityReplayContext);
    } catch (error) {
      return {
        kind: 'parsed',
        revision: request.revision,
        result: compileSource(request.file, {}, [profileFailure(error)], observe),
      };
    }
    if (request.prototypeProfile === undefined) {
      try {
        return {
          kind: 'parsed',
          revision: request.revision,
          result: compileSource(
            request.file,
            {
              ...(entityReplayContext === undefined ? {} : { entityReplayContext }),
            },
            [],
            observe,
          ),
        };
      } catch (error) {
        return {
          kind: 'parsed',
          revision: request.revision,
          result: compileSource(request.file, {}, [profileFailure(error)], observe),
        };
      }
    }
    try {
      const profile = request.prototypeProfile;
      observe?.('profile');
      const referenceIdentity = 'identity' in profile ? profile.identity : undefined;
      const loaded =
        'source' in profile
          ? await loadPrototypeInputJson(profile.source, {
              ...(profile.factorioDumpMetadata === undefined
                ? {}
                : { factorioDumpMetadata: profile.factorioDumpMetadata }),
            })
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
      return {
        kind: 'parsed',
        revision: request.revision,
        result: compileSource(
          request.file,
          {
            prototypes: loaded.prototypes,
            ...(entityReplayContext === undefined ? {} : { entityReplayContext }),
          },
          [],
          observe,
        ),
        prototypeEnvironment: environment,
      };
    } catch (error) {
      return {
        kind: 'parsed',
        revision: request.revision,
        result: compileSource(request.file, {}, [profileFailure(error)], observe),
      };
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

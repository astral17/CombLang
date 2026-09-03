import {
  loadPrototypeDatabaseJson,
  PrototypeValidationError,
  type LoadedPrototypeEnvironment,
} from '@comblang/prototypes';
import type { Diagnostic } from '@comblang/shared';

import { compileSource } from './compile-source.js';
import type {
  BrowserPrototypeEnvironmentReport,
  CompilerWorkerRequest,
  CompilerWorkerResponse,
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
        : error instanceof BrowserPrototypeSelectionError ||
            error instanceof BrowserPrototypeCacheMissError
          ? error.code
          : 'WP1003',
    severity: 'error',
    message: error instanceof Error ? error.message : 'Unable to load the prototype profile.',
  };
}

export class CompilerWorkerRuntime {
  readonly #profiles = new Map<string, LoadedPrototypeEnvironment>();

  async handle(request: CompilerWorkerRequest): Promise<CompilerWorkerResponse> {
    if (request.prototypeProfile === undefined) {
      return {
        kind: 'parsed',
        revision: request.revision,
        result: compileSource(request.file),
      };
    }
    try {
      const profile = request.prototypeProfile;
      const referenceIdentity = 'identity' in profile ? profile.identity : undefined;
      const loaded =
        'source' in profile
          ? await loadPrototypeDatabaseJson(profile.source)
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
        factorioVersion: loaded.prototypes.environment.factorioVersion,
        expansions: loaded.prototypes.environment.expansions,
        mods: loaded.prototypes.environment.mods,
        capabilities: loaded.prototypes.capabilities,
      });
      return {
        kind: 'parsed',
        revision: request.revision,
        result: compileSource(request.file, { prototypes: loaded.prototypes }),
        prototypeEnvironment: environment,
      };
    } catch (error) {
      return {
        kind: 'parsed',
        revision: request.revision,
        result: compileSource(request.file, {}, [profileFailure(error)]),
      };
    }
  }
}

const defaultRuntime = new CompilerWorkerRuntime();

export function handleCompilerWorkerRequest(request: CompilerWorkerRequest) {
  return defaultRuntime.handle(request);
}

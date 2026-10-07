import { describe, expect, test } from 'vitest';

import {
  COLD_COMPILER_WORKER_REQUEST_TIMEOUT_MS,
  compilerWorkerRequestTimeoutMs,
  compilerWorkerRequestTimeoutReason,
  SOURCE_PROFILE_COMPILER_WORKER_TIMEOUT_MS,
  WARM_COMPILER_WORKER_REQUEST_TIMEOUT_MS,
} from './compiler-worker-budget.js';
import type { CompilerWorkerBindRequest } from './worker-protocol.js';

const ordinaryRequest = {} as const;
const identityOnlyRequest = { prototypeProfile: { identity: 'profile-v1' } } as const;
const sourceProfileRequest = { prototypeProfile: { source: '{"schemaVersion":1}' } } as const;
const bindingRequest: CompilerWorkerBindRequest = {
  kind: 'bind-parameters',
  revision: 4,
  sourceRevision: 3,
  token: 'binding-token',
};

describe('compiler Worker timeout policy', () => {
  test('gives ordinary cold execution the cold budget', () => {
    expect(compilerWorkerRequestTimeoutMs(ordinaryRequest, true)).toBe(
      COLD_COMPILER_WORKER_REQUEST_TIMEOUT_MS,
    );
  });

  test('gives identity-only cold execution the cold budget', () => {
    expect(compilerWorkerRequestTimeoutMs(identityOnlyRequest, true)).toBe(
      COLD_COMPILER_WORKER_REQUEST_TIMEOUT_MS,
    );
  });

  test('gives ordinary and identity-only warm execution the warm budget', () => {
    expect(compilerWorkerRequestTimeoutMs(ordinaryRequest, false)).toBe(
      WARM_COMPILER_WORKER_REQUEST_TIMEOUT_MS,
    );
    expect(compilerWorkerRequestTimeoutMs(identityOnlyRequest, false)).toBe(
      WARM_COMPILER_WORKER_REQUEST_TIMEOUT_MS,
    );
  });

  test('keeps source-profile imports on the maximum execution budget', () => {
    expect(compilerWorkerRequestTimeoutMs(sourceProfileRequest, true)).toBe(
      SOURCE_PROFILE_COMPILER_WORKER_TIMEOUT_MS,
    );
    expect(compilerWorkerRequestTimeoutMs(sourceProfileRequest, false)).toBe(
      SOURCE_PROFILE_COMPILER_WORKER_TIMEOUT_MS,
    );
  });

  test('gives binds the warm budget regardless of Worker warmth or parse profile', () => {
    expect(compilerWorkerRequestTimeoutMs(bindingRequest, true)).toBe(
      WARM_COMPILER_WORKER_REQUEST_TIMEOUT_MS,
    );
    expect(compilerWorkerRequestTimeoutMs(bindingRequest, false)).toBe(
      WARM_COMPILER_WORKER_REQUEST_TIMEOUT_MS,
    );
    expect(compilerWorkerRequestTimeoutReason(bindingRequest, 1000)).toBe(
      'Parameter binding exceeded the 1000 ms worker budget.',
    );
    expect(compilerWorkerRequestTimeoutReason(bindingRequest, 1000, 'transport')).toBe(
      'Parameter binding exceeded the 1000 ms worker budget.',
    );
  });
});

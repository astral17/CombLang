import { describe, expect, test } from 'vitest';

import {
  COLD_COMPILER_WORKER_REQUEST_TIMEOUT_MS,
  compilerWorkerRequestTimeoutMs,
  SOURCE_PROFILE_COMPILER_WORKER_TIMEOUT_MS,
  WARM_COMPILER_WORKER_REQUEST_TIMEOUT_MS,
} from './compiler-worker-budget.js';

const ordinaryRequest = {} as const;
const identityOnlyRequest = { prototypeProfile: { identity: 'profile-v1' } } as const;
const sourceProfileRequest = { prototypeProfile: { source: '{"schemaVersion":1}' } } as const;

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
});

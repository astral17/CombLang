import type { StoredPrototypeProfile } from './prototype-profile-store.js';

export interface PrototypeProfileRollbackResult {
  readonly activeProfile: StoredPrototypeProfile | undefined;
  readonly workerIdentity: string | undefined;
  readonly restored: boolean;
  readonly message: string;
}

/**
 * Restores the last known-good profile after a candidate import terminates.
 * The returned message deliberately retains the complete failure text so the
 * UI can report why the candidate was rejected after the old profile returns.
 */
export function rollbackPrototypeProfile(
  candidateName: string,
  previousProfile: StoredPrototypeProfile | undefined,
  previousWorkerIdentity: string | undefined,
  failureMessage: string,
): PrototypeProfileRollbackResult {
  const failure = failureMessage.trim() || 'prototype profile import failed.';
  if (previousProfile === undefined) {
    return {
      activeProfile: undefined,
      workerIdentity: undefined,
      restored: false,
      message: `${candidateName} · ${failure}`,
    };
  }
  return {
    activeProfile: previousProfile,
    workerIdentity: previousWorkerIdentity,
    restored: true,
    message: `${previousProfile.name} · ${failure}; previous profile kept`,
  };
}

import { describe, expect, test } from 'vitest';

import { rollbackPrototypeProfile } from './prototype-profile-transition.js';

const previousProfile = {
  name: 'known-good.json',
  source: '{"schemaVersion":1}',
  identity: 'comblang-prototypes-v1-sha256:known-good',
} as const;

describe('prototype profile replacement rollback', () => {
  test('restores the previous profile and its worker identity', () => {
    expect(
      rollbackPrototypeProfile(
        'candidate.json',
        previousProfile,
        previousProfile.identity,
        'import failed (PI1003): factorioDumpMetadata.startupSettings[0].value.r: expected a finite number.',
      ),
    ).toEqual({
      activeProfile: previousProfile,
      workerIdentity: previousProfile.identity,
      restored: true,
      message:
        'known-good.json · import failed (PI1003): factorioDumpMetadata.startupSettings[0].value.r: expected a finite number.; previous profile kept',
    });
  });

  test('rejects a failed candidate when there is no previous profile', () => {
    expect(
      rollbackPrototypeProfile('candidate.json', undefined, undefined, 'source-profile timeout'),
    ).toEqual({
      activeProfile: undefined,
      workerIdentity: undefined,
      restored: false,
      message: 'candidate.json · source-profile timeout',
    });
  });
});

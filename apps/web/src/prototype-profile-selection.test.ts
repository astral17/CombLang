import { describe, expect, test } from 'vitest';

import { resolvePrototypeProfileSelection } from './prototype-profile-selection.js';

const builtin = {
  name: 'Space Age 2.1.17',
  source: 'built-in database',
  assetManifest: 'built-in manifest',
} as const;

const custom = {
  name: 'custom.json',
  source: 'custom database',
  identity: 'comblang-prototypes-v1-sha256:' + 'a'.repeat(64),
} as const;

describe('browser prototype profile selection', () => {
  test('uses the built-in profile only when the selection key is missing', () => {
    expect(resolvePrototypeProfileSelection(null, custom, builtin)).toEqual({
      kind: 'builtin',
      profile: builtin,
    });
  });

  test('keeps explicit disable separate from a missing selection', () => {
    expect(resolvePrototypeProfileSelection('', custom, builtin)).toEqual({ kind: 'disabled' });
  });

  test('restores a saved custom profile when its identity is selected', () => {
    expect(resolvePrototypeProfileSelection(custom.identity, custom, builtin)).toEqual({
      kind: 'custom',
      profile: custom,
    });
  });

  test('does not substitute the built-in for a missing custom selection', () => {
    expect(resolvePrototypeProfileSelection('missing-identity', undefined, builtin)).toEqual({
      kind: 'custom-unavailable',
      message: 'The selected prototype database is missing from browser storage.',
    });
  });

  test('turns an unavailable built-in into an ordinary-compilation notice', () => {
    expect(resolvePrototypeProfileSelection(null, undefined, undefined)).toEqual({
      kind: 'builtin-unavailable',
      message: 'Built-in prototype profile unavailable; ordinary circuits remain available.',
    });
  });
});

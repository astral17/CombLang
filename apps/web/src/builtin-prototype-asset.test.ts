import { describe, expect, test } from 'vitest';

import {
  builtinPrototypeAsset,
  fetchBuiltinPrototypeAsset,
  type BuiltinPrototypeAssetResponse,
} from './builtin-prototype-asset.js';

function response(source: string, ok = true): BuiltinPrototypeAssetResponse {
  return { ok, status: ok ? 200 : 503, text: async () => source };
}

describe('built-in prototype asset loading', () => {
  test('keeps the database and manifest as separate lazy URL resources', async () => {
    const calls: string[] = [];
    const loaded = await fetchBuiltinPrototypeAsset(async (input) => {
      calls.push(input);
      return response(input.endsWith('.manifest.json') ? '{"manifest":true}' : '{"database":true}');
    });

    expect(builtinPrototypeAsset.databaseUrl).toMatch(/\.json$/);
    expect(builtinPrototypeAsset.manifestUrl).toMatch(/\.json\.manifest\.json$/);
    expect(builtinPrototypeAsset.databaseUrl).not.toMatch(/^data:/);
    expect(builtinPrototypeAsset.manifestUrl).not.toMatch(/^data:/);
    expect(builtinPrototypeAsset.databaseUrl).not.toBe(builtinPrototypeAsset.manifestUrl);
    expect(calls).toEqual(
      expect.arrayContaining([
        builtinPrototypeAsset.databaseUrl,
        builtinPrototypeAsset.manifestUrl,
      ]),
    );
    expect(loaded).toEqual({ source: '{"database":true}', assetManifest: '{"manifest":true}' });
  });

  test('surfaces a failed built-in fetch without manufacturing profile data', async () => {
    await expect(fetchBuiltinPrototypeAsset(async () => response('', false))).rejects.toThrow(
      'built-in',
    );
  });
});

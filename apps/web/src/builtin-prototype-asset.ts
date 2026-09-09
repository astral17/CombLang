import builtinDatabaseUrl from '../../../packages/prototypes/generated/space-age-2.1.17.json?url';
import builtinManifestUrl from '../../../packages/prototypes/generated/space-age-2.1.17.json.manifest.json?url';

export const builtinPrototypeAsset = Object.freeze({
  name: 'Space Age 2.1.17',
  databaseUrl: builtinDatabaseUrl,
  manifestUrl: builtinManifestUrl,
});

export interface BuiltinPrototypeAssetResponse {
  readonly ok: boolean;
  readonly status?: number;
  text(): Promise<string>;
}

export type BuiltinPrototypeAssetFetcher = (
  input: string,
) => Promise<BuiltinPrototypeAssetResponse>;

async function fetchAsset(
  fetcher: BuiltinPrototypeAssetFetcher,
  url: string,
  label: string,
): Promise<string> {
  const response = await fetcher(url);
  if (!response.ok) {
    const status = response.status === undefined ? '' : ` (HTTP ${response.status})`;
    throw new Error(`The built-in ${label} could not be fetched${status}.`);
  }
  return response.text();
}

/** Fetches the generated database and manifest only when the browser selects the built-in. */
export async function fetchBuiltinPrototypeAsset(
  fetcher: BuiltinPrototypeAssetFetcher = (input) => globalThis.fetch(input),
): Promise<{ readonly source: string; readonly assetManifest: string }> {
  const [source, assetManifest] = await Promise.all([
    fetchAsset(fetcher, builtinPrototypeAsset.databaseUrl, 'prototype database'),
    fetchAsset(fetcher, builtinPrototypeAsset.manifestUrl, 'prototype asset manifest'),
  ]);
  return Object.freeze({ source, assetManifest });
}

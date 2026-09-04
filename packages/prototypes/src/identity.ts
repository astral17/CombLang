import type { PrototypeDatabaseV1 } from './schema.js';
import { compareCanonicalString } from './canonical.js';

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => compareCanonicalString(left, right))
    .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`)
    .join(',')}}`;
}

function identityPayload(database: PrototypeDatabaseV1): unknown {
  const { generatedAt: _generatedAt, ...environment } = database.environment;
  return {
    schemaVersion: database.schemaVersion,
    environment,
    capabilities: database.capabilities,
    items: database.items,
    fluids: database.fluids,
    recipes: database.recipes,
    entities: database.entities,
    qualities: database.qualities,
    recipeCategories: database.recipeCategories,
    virtualSignals: database.virtualSignals,
    indexes: database.indexes,
  };
}

/** Stable cache/project identity; informational generatedAt provenance is excluded. */
export async function prototypeDatabaseIdentity(database: PrototypeDatabaseV1): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalJson(identityPayload(database)));
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  const hex = [...new Uint8Array(digest)]
    .map((value) => value.toString(16).padStart(2, '0'))
    .join('');
  return `comblang-prototypes-v1-sha256:${hex}`;
}

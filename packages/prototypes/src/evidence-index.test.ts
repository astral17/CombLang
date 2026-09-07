import { describe, expect, test } from 'vitest';

import { prototypeEvidenceIdentity } from './evidence-index.js';
import { loadPrototypeEvidence } from './evidence-loader.js';
import type { PrototypeEvidenceManifestV1 } from './evidence.js';
import { syntheticPrototypeDatabase } from './fixtures.js';
import { loadPrototypeDatabase } from './provider.js';

const digest = (character: string) => `sha256:${character.repeat(64)}`;

async function loadedEvidence(overrides: Record<string, unknown> = {}) {
  const database = syntheticPrototypeDatabase();
  const loadedDatabase = await loadPrototypeDatabase(database);
  const manifest = {
    schemaVersion: 1,
    kind: 'comblang-prototype-evidence',
    databaseIdentity: loadedDatabase.prototypes.identity,
    structureEvidence: ['runtime', 'raw'],
    sources: [
      { id: 'native', kind: 'reviewed-native-behavior', artifactSha256: digest('c') },
      { id: 'raw', kind: 'data-raw-structure', artifactSha256: digest('a') },
      { id: 'runtime', kind: 'runtime-structure', artifactSha256: digest('b') },
    ],
    circuitClaims: [
      {
        fact: { entity: 'entity:assembling-machine-3', field: 'read' },
        value: true,
        evidence: ['native'],
      },
    ],
    ...overrides,
  } as PrototypeEvidenceManifestV1;
  return {
    database,
    loadedDatabase,
    manifest,
    loaded: await loadPrototypeEvidence(database, manifest),
  };
}

describe('prototype evidence identity and index', () => {
  test('provides immutable structural, source and circuit lookups', async () => {
    const { loaded } = await loadedEvidence();
    expect(loaded.evidenceIdentity).toMatch(/^comblang-prototype-evidence-v1-sha256:[0-9a-f]{64}$/);
    expect(loaded.evidenceIdentity).not.toBe(loaded.databaseIdentity);
    expect(loaded.index.structuralSources.map(({ id }) => id)).toEqual(['raw', 'runtime']);
    expect(loaded.index.sourceById('native')!.kind).toBe('reviewed-native-behavior');
    expect(loaded.index.sourceById('missing')).toBeUndefined();
    expect(loaded.index.circuit('entity:assembling-machine-3', 'read')).toEqual({
      status: 'verified',
      entity: 'entity:assembling-machine-3',
      field: 'read',
      value: true,
      sources: [loaded.index.sourceById('native')],
    });
    expect(Object.isFrozen(loaded.index)).toBe(true);
    expect(Object.isFrozen(loaded.index.structuralSources)).toBe(true);
    expect(Object.isFrozen(loaded.index.circuit('entity:assembling-machine-3', 'read'))).toBe(true);
  });

  test('distinguishes unknown, unverified false and verified false', async () => {
    const { database, loadedDatabase } = await loadedEvidence({ circuitClaims: [] });
    const unverified = await loadPrototypeEvidence(database, {
      schemaVersion: 1,
      kind: 'comblang-prototype-evidence',
      databaseIdentity: loadedDatabase.prototypes.identity,
      structureEvidence: [],
      sources: [],
      circuitClaims: [],
    });
    expect(unverified.index.circuit('entity:assembling-machine-3', 'setFilters')).toEqual({
      status: 'unverified',
      entity: 'entity:assembling-machine-3',
      field: 'setFilters',
      value: false,
    });
    expect(unverified.index.circuit('entity:missing', 'read')).toEqual({
      status: 'unknown',
      entity: 'entity:missing',
      field: 'read',
    });

    const verified = await loadedEvidence({
      circuitClaims: [
        {
          fact: { entity: 'entity:assembling-machine-3', field: 'setFilters' },
          value: false,
          evidence: ['native'],
        },
      ],
    });
    expect(
      verified.loaded.index.circuit('entity:assembling-machine-3', 'setFilters'),
    ).toMatchObject({
      status: 'verified',
      value: false,
    });
  });

  test('is insensitive to insertion order but changes for identity-bearing content', async () => {
    const { loadedDatabase, manifest } = await loadedEvidence();
    const reordered: PrototypeEvidenceManifestV1 = {
      circuitClaims: [...manifest.circuitClaims].reverse(),
      sources: [...manifest.sources].reverse(),
      structureEvidence: [...manifest.structureEvidence].reverse(),
      databaseIdentity: manifest.databaseIdentity,
      kind: manifest.kind,
      schemaVersion: manifest.schemaVersion,
    };
    expect(await prototypeEvidenceIdentity(manifest)).toBe(
      await prototypeEvidenceIdentity(reordered),
    );

    for (const changed of [
      { ...manifest, databaseIdentity: `comblang-prototypes-v1-sha256:${'d'.repeat(64)}` },
      {
        ...manifest,
        sources: manifest.sources.map((source) =>
          source.id === 'raw' ? { ...source, artifactSha256: digest('e') } : source,
        ),
      },
      {
        ...manifest,
        sources: manifest.sources.map((source) =>
          source.id === 'raw' ? { ...source, kind: 'runtime-structure' } : source,
        ),
      },
      {
        ...manifest,
        circuitClaims: manifest.circuitClaims.map((claim) => ({ ...claim, value: false })),
      },
    ]) {
      expect(await prototypeEvidenceIdentity(changed as PrototypeEvidenceManifestV1)).not.toBe(
        await prototypeEvidenceIdentity(manifest),
      );
    }
    expect(loadedDatabase.prototypes.identity).toBe(manifest.databaseIdentity);
  });
});

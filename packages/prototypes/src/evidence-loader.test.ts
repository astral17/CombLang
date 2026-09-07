import { describe, expect, test } from 'vitest';

import { prototypeDatabaseIdentity } from './identity.js';
import { loadPrototypeEvidence } from './evidence-loader.js';
import { syntheticPrototypeDatabase } from './fixtures.js';
import { loadPrototypeDatabase } from './provider.js';

async function databaseAndIdentity() {
  const database = syntheticPrototypeDatabase();
  const loaded = await loadPrototypeDatabase(database);
  return { database, identity: loaded.prototypes.identity };
}

function manifest(identity: string, overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    kind: 'comblang-prototype-evidence',
    databaseIdentity: identity,
    structureEvidence: ['raw'],
    sources: [
      { id: 'raw', kind: 'data-raw-structure', artifactSha256: `sha256:${'a'.repeat(64)}` },
      {
        id: 'native',
        kind: 'reviewed-native-behavior',
        artifactSha256: `sha256:${'b'.repeat(64)}`,
      },
    ],
    circuitClaims: [
      {
        fact: { entity: 'entity:assembling-machine-3', field: 'read' },
        value: true,
        evidence: ['native'],
      },
    ],
    ...overrides,
  };
}

describe('identity-bound prototype evidence loader', () => {
  test('validates structure and reviewed behavior against the selected database', async () => {
    const { database, identity } = await databaseAndIdentity();
    const loaded = await loadPrototypeEvidence(database, manifest(identity));

    expect(loaded.databaseIdentity).toBe(identity);
    expect(loaded.manifest.databaseIdentity).toBe(identity);
    expect(Object.isFrozen(loaded)).toBe(true);
    expect(loaded.database.entities[0]!.circuit!.read).toBe(true);
  });

  test('allows absent claims and leaves the database unchanged', async () => {
    const { database, identity } = await databaseAndIdentity();
    const before = JSON.stringify(database);
    const loaded = await loadPrototypeEvidence(
      database,
      manifest(identity, { circuitClaims: [], structureEvidence: [] }),
    );

    expect(JSON.stringify(database)).toBe(before);
    expect(loaded.manifest.circuitClaims).toEqual([]);
  });

  test('rejects a stale database identity before authority checks', async () => {
    const { database } = await databaseAndIdentity();
    await expect(
      loadPrototypeEvidence(
        database,
        manifest(`comblang-prototypes-v1-sha256:${'c'.repeat(64)}`, {
          structureEvidence: ['native'],
        }),
      ),
    ).rejects.toMatchObject({ code: 'PE1004', path: 'databaseIdentity' });
  });

  test.each([
    ['structureEvidence[0]', { structureEvidence: ['native'], circuitClaims: [] }],
    [
      'circuitClaims[0].evidence[0]',
      {
        sources: [
          { id: 'raw', kind: 'data-raw-structure', artifactSha256: `sha256:${'a'.repeat(64)}` },
        ],
        structureEvidence: [],
        circuitClaims: [
          {
            fact: { entity: 'entity:assembling-machine-3', field: 'read' },
            value: true,
            evidence: ['raw'],
          },
        ],
      },
    ],
    [
      'circuitClaims[0].evidence[0]',
      {
        sources: [
          { id: 'synthetic', kind: 'synthetic', artifactSha256: `sha256:${'d'.repeat(64)}` },
        ],
        structureEvidence: [],
        circuitClaims: [
          {
            fact: { entity: 'entity:assembling-machine-3', field: 'read' },
            value: true,
            evidence: ['synthetic'],
          },
        ],
      },
    ],
  ])('rejects invalid source authority at %s', async (path, overrides) => {
    const { database, identity } = await databaseAndIdentity();
    await expect(
      loadPrototypeEvidence(database, manifest(identity, overrides)),
    ).rejects.toMatchObject({
      code: 'PE1005',
      path,
    });
  });

  test('rejects a claim for an absent entity and a mismatching stored value', async () => {
    const { database, identity } = await databaseAndIdentity();
    await expect(
      loadPrototypeEvidence(
        database,
        manifest(identity, {
          circuitClaims: [
            {
              fact: { entity: 'entity:missing', field: 'read' },
              value: true,
              evidence: ['native'],
            },
          ],
        }),
      ),
    ).rejects.toMatchObject({ code: 'PE1005', path: 'circuitClaims[0].fact.entity' });

    await expect(
      loadPrototypeEvidence(
        database,
        manifest(identity, {
          circuitClaims: [
            {
              fact: { entity: 'entity:assembling-machine-3', field: 'read' },
              value: false,
              evidence: ['native'],
            },
          ],
        }),
      ),
    ).rejects.toMatchObject({ code: 'PE1006', path: 'circuitClaims[0].value' });
  });

  test('uses the exact database identity produced by the database loader', async () => {
    const database = syntheticPrototypeDatabase();
    const loaded = await loadPrototypeDatabase(database);
    expect(loaded.prototypes.identity).toBe(await prototypeDatabaseIdentity(loaded.database));
  });
});

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, test, vi } from 'vitest';
import { loadPrototypeDatabase, syntheticPrototypeDatabase } from '@comblang/prototypes';

import { run } from './main.js';

const directories: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

async function inputFiles(database: unknown, evidence: unknown) {
  const directory = await mkdtemp(join(tmpdir(), 'comblang-evidence-'));
  directories.push(directory);
  const databasePath = join(directory, 'database.json');
  const evidencePath = join(directory, 'evidence.json');
  await Promise.all([
    writeFile(databasePath, `${JSON.stringify(database)}\n`, 'utf8'),
    writeFile(evidencePath, `${JSON.stringify(evidence)}\n`, 'utf8'),
  ]);
  return { databasePath, evidencePath };
}

async function validInput() {
  const database = syntheticPrototypeDatabase();
  const { prototypes } = await loadPrototypeDatabase(database);
  const evidence = {
    schemaVersion: 1,
    kind: 'comblang-prototype-evidence',
    databaseIdentity: prototypes.identity,
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
  };
  return { database, evidence };
}

describe('factorio-dsl prototypes evidence', () => {
  test('reports stable JSON identities and circuit fact counts', async () => {
    const { database, evidence } = await validInput();
    const { databasePath, evidencePath } = await inputFiles(database, evidence);
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    expect(await run(['prototypes', 'evidence', '--json', databasePath, evidencePath])).toBe(0);
    const report = JSON.parse(String(log.mock.calls[0]![0]));
    expect(report).toMatchObject({
      databaseIdentity: evidence.databaseIdentity,
      evidenceIdentity: expect.stringMatching(/^comblang-prototype-evidence-v1-sha256:/),
      structuralSourceCount: 1,
      circuitFacts: { verified: 1, unverified: 17, unknown: 0 },
    });
  });

  test('human output does not call unverified facts native-confirmed', async () => {
    const { database, evidence } = await validInput();
    const { databasePath, evidencePath } = await inputFiles(database, {
      ...evidence,
      circuitClaims: [],
      structureEvidence: [],
      sources: [],
    });
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    expect(await run(['prototypes', 'evidence', databasePath, evidencePath])).toBe(0);
    expect(log.mock.calls.map(([line]) => String(line)).join('\n')).toContain(
      'Unverified values are not native-confirmed.',
    );
  });

  test('returns package diagnostics for stale identity and malformed manifest', async () => {
    const { database, evidence } = await validInput();
    const changed = structuredClone(database) as {
      items: Array<Record<string, unknown>>;
    };
    changed.items[0] = { ...changed.items[0], stackSize: 101 };
    const staleFiles = await inputFiles(changed, evidence);
    const malformedFiles = await inputFiles(database, {});
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);

    expect(
      await run([
        'prototypes',
        'evidence',
        '--json',
        staleFiles.databasePath,
        staleFiles.evidencePath,
      ]),
    ).toBe(2);
    expect(JSON.parse(String(log.mock.calls[0]![0]))).toMatchObject({
      diagnostics: [{ code: 'PE1004', path: 'databaseIdentity' }],
    });
    log.mockClear();
    expect(
      await run([
        'prototypes',
        'evidence',
        '--json',
        malformedFiles.databasePath,
        malformedFiles.evidencePath,
      ]),
    ).toBe(2);
    expect(JSON.parse(String(log.mock.calls[0]![0]))).toMatchObject({
      diagnostics: [{ code: 'PE1000', path: 'schemaVersion' }],
    });
    expect(await readFile(malformedFiles.evidencePath, 'utf8')).toBe('{}\n');
  });

  test.each(['data-raw-structure', 'synthetic'] as const)(
    'rejects %s sources from verifying behavior',
    async (kind) => {
      const { database, evidence } = await validInput();
      const { databasePath, evidencePath } = await inputFiles(database, {
        ...evidence,
        structureEvidence: [],
        sources: [{ id: 'attempt', kind, artifactSha256: `sha256:${'c'.repeat(64)}` }],
        circuitClaims: [
          {
            fact: { entity: 'entity:assembling-machine-3', field: 'read' },
            value: true,
            evidence: ['attempt'],
          },
        ],
      });
      const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

      expect(await run(['prototypes', 'evidence', '--json', databasePath, evidencePath])).toBe(2);
      expect(JSON.parse(String(log.mock.calls[0]![0]))).toMatchObject({
        diagnostics: [{ code: 'PE1005', path: 'circuitClaims[0].evidence[0]' }],
      });
    },
  );
});

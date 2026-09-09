import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, test, vi } from 'vitest';

import { run } from './main.js';

const databasePath = fileURLToPath(
  new URL('../../../packages/prototypes/generated/space-age-2.1.17.json', import.meta.url),
);
const manifestPath = `${databasePath}.manifest.json`;
const temporaryDirectories: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

async function temporaryAssetFiles(): Promise<{
  readonly directory: string;
  readonly dumpPath: string;
  readonly metadataPath: string;
  readonly firstOutput: string;
  readonly secondOutput: string;
}> {
  const directory = await mkdtemp(join(tmpdir(), 'comblang-asset-'));
  temporaryDirectories.push(directory);
  const dumpPath = join(directory, 'dump.json');
  const metadataPath = join(directory, 'metadata.json');
  const firstOutput = join(directory, 'first.json');
  const secondOutput = join(directory, 'second.json');
  await Promise.all([
    writeFile(
      dumpPath,
      JSON.stringify({
        item: { plate: { type: 'item', name: 'plate', stack_size: 100 } },
        fluid: { water: { type: 'fluid', name: 'water' } },
        recipe: {
          plate: {
            type: 'recipe',
            name: 'plate',
            ingredients: [],
            results: [{ type: 'item', name: 'plate', amount: 1 }],
          },
        },
        'recipe-category': {
          crafting: { type: 'recipe-category', name: 'crafting' },
        },
        quality: { normal: { type: 'quality', name: 'normal', level: 0 } },
        'virtual-signal': {
          'signal-A': { type: 'virtual-signal', name: 'signal-A' },
        },
      }),
      'utf8',
    ),
    writeFile(
      metadataPath,
      JSON.stringify({
        factorioVersion: '2.1.17',
        expansions: ['space-age'],
        mods: [
          { name: 'base', version: '2.1.17' },
          { name: 'space-age', version: '2.1.17' },
        ],
        startupSettings: [],
      }),
      'utf8',
    ),
  ]);
  return { directory, dumpPath, metadataPath, firstOutput, secondOutput };
}

describe('checked-in prototype asset CLI', () => {
  test('verifies the checked-in pair without source inputs', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    expect(await run(['prototypes', 'asset', 'verify', databasePath, manifestPath])).toBe(0);
    expect(String(log.mock.calls[0]?.[0])).toContain('integrity verified');
  });

  test('rejects invalid verify arguments', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    expect(await run(['prototypes', 'asset', 'verify', databasePath])).toBe(2);
    expect(error).toHaveBeenCalledWith(expect.stringContaining('prototypes asset verify'));
  });

  test('rejects tampered output and stale manifest identity', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'comblang-asset-'));
    temporaryDirectories.push(directory);
    const database = await readFile(databasePath, 'utf8');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {
      databaseIdentity: string;
    };
    const outputPath = join(directory, 'database.json');
    const copiedManifestPath = join(directory, 'manifest.json');
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await writeFile(outputPath, `${database}\n`, 'utf8');
    await writeFile(copiedManifestPath, JSON.stringify(manifest), 'utf8');
    expect(await run(['prototypes', 'asset', 'verify', outputPath, copiedManifestPath])).toBe(2);
    expect(String(error.mock.calls.at(-1)?.[0])).toContain('PA1003');

    manifest.databaseIdentity = `comblang-prototypes-v1-sha256:${'0'.repeat(64)}`;
    await writeFile(outputPath, database, 'utf8');
    await writeFile(copiedManifestPath, JSON.stringify(manifest), 'utf8');
    expect(await run(['prototypes', 'asset', 'verify', outputPath, copiedManifestPath])).toBe(2);
    expect(String(error.mock.calls.at(-1)?.[0])).toContain('PA1005');
  });

  test('regenerates identical source assets at different output paths', async () => {
    const files = await temporaryAssetFiles();
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    expect(
      await run([
        'prototypes',
        'asset',
        'generate',
        files.dumpPath,
        files.metadataPath,
        files.firstOutput,
      ]),
    ).toBe(0);
    expect(
      await run([
        'prototypes',
        'asset',
        'generate',
        files.dumpPath,
        files.metadataPath,
        files.secondOutput,
      ]),
    ).toBe(0);
    expect(await readFile(files.secondOutput, 'utf8')).toBe(
      await readFile(files.firstOutput, 'utf8'),
    );
    expect(await readFile(`${files.secondOutput}.manifest.json`, 'utf8')).toBe(
      await readFile(`${files.firstOutput}.manifest.json`, 'utf8'),
    );
  });
});

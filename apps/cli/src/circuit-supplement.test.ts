import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import { loadPrototypeDatabase, syntheticPrototypeDatabase } from '@comblang/prototypes';
import { run } from './main.js';

const directories: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function files() {
  const directory = await mkdtemp(join(tmpdir(), 'comblang-circuit-supplement-'));
  directories.push(directory);
  const { database } = await loadPrototypeDatabase(syntheticPrototypeDatabase());
  const base = await loadPrototypeDatabase({
    ...database,
    capabilities: { ...database.capabilities, entityCircuitCapabilities: false },
    entities: database.entities.map(({ circuit: _circuit, ...entity }) => entity),
  });
  const input = {
    schemaVersion: 1,
    baseIdentity: base.prototypes.identity,
    entities: [database.entities[0]],
  };
  const basePath = join(directory, 'base with spaces.json');
  const supplementPath = join(directory, 'circuit.json');
  const outputPath = join(directory, 'output.json');
  await Promise.all([
    writeFile(basePath, JSON.stringify(base.database)),
    writeFile(supplementPath, JSON.stringify(input)),
  ]);
  return { base, input, basePath, supplementPath, outputPath };
}

test('CLI supplements partial circuit data and the result can compile a source query', async () => {
  const f = await files();
  const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  expect(
    await run(['prototypes', 'supplement', '--json', f.basePath, f.supplementPath, f.outputPath]),
  ).toBe(0);
  const report = JSON.parse(String(log.mock.calls[0]![0]));
  expect(report).toMatchObject({
    baseIdentity: f.base.prototypes.identity,
    circuitCoverage: { known: 1, total: 2, complete: false },
  });
  expect(report.identity).not.toBe(report.baseIdentity);
  const result = await loadPrototypeDatabase(JSON.parse(await readFile(f.outputPath, 'utf8')));
  expect(result.prototypes.identity).toBe(report.identity);
  const sourcePath = join(directories[0]!, 'query.factorio.ts');
  await writeFile(
    sourcePath,
    'const canSet = prototypes.entityCircuitCapabilities("assembling-machine-3").setRecipe;\nconst output = CC(Number(canSet) * Signal("signal-A"));',
  );
  expect(await run(['check', '--json', '--prototypes', f.outputPath, sourcePath])).toBe(0);
});

test.each(['stale', 'malformed', 'conflict'] as const)(
  'CLI reports %s supplement and leaves an existing output untouched',
  async (kind) => {
    const f = await files();
    if (kind === 'stale') f.input.baseIdentity = `comblang-prototypes-v1-sha256:${'0'.repeat(64)}`;
    if (kind === 'conflict') {
      const full = await loadPrototypeDatabase(syntheticPrototypeDatabase());
      await writeFile(f.basePath, JSON.stringify(full.database));
      f.input.baseIdentity = full.prototypes.identity;
      f.input.entities = [{ ...f.input.entities[0]!, type: 'wrong-type' }];
    }
    await writeFile(f.supplementPath, kind === 'malformed' ? '{' : JSON.stringify(f.input));
    await writeFile(f.outputPath, 'untouched');
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    expect(
      await run(['prototypes', 'supplement', '--json', f.basePath, f.supplementPath, f.outputPath]),
    ).toBe(2);
    expect(JSON.parse(String(log.mock.calls[0]![0])).diagnostics[0]).toMatchObject({
      code: kind === 'stale' ? 'PC1002' : kind === 'malformed' ? 'PC1001' : 'PC1003',
    });
    expect(await readFile(f.outputPath, 'utf8')).toBe('untouched');
  },
);

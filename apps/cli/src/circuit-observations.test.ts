import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import sample from '../../../fixtures/prototype-observations/synthetic.json';
import { run } from './main.js';
import { syntheticPrototypeDatabase, validatePrototypeDatabase } from '@comblang/prototypes';

const directories: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function inputFile(text: string) {
  const directory = await mkdtemp(join(tmpdir(), 'comblang-observations-'));
  directories.push(directory);
  const path = join(directory, 'observations with spaces.jsonl');
  await writeFile(path, text);
  return path;
}

test('CLI preserves raw observations in JSON and does not modify the input', async () => {
  const text = `${JSON.stringify(sample)}\n`;
  const path = await inputFile(text);
  const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  expect(await run(['prototypes', 'observations', '--json', path])).toBe(0);
  const report = JSON.parse(String(log.mock.calls[0]![0]));
  expect(report).toMatchObject({
    mode: 'observations-only',
    observations: [{ label: 'synthetic-format-only', behavior: sample.behavior }],
  });
  expect(report).not.toHaveProperty('circuitCoverage');
  expect(await readFile(path, 'utf8')).toBe(text);
});

test('CLI text explicitly distinguishes observations from inferred capabilities', async () => {
  const path = await inputFile(JSON.stringify(sample));
  const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  expect(await run(['prototypes', 'observations', path])).toBe(0);
  expect(String(log.mock.calls[0]![0])).toContain('no prototype capability assertions inferred');
  expect(String(log.mock.calls[1]![0])).toContain('2 value(s), 1 absent, 1 read failure(s)');
});

test('CLI emits structured line-specific failures for truncated captures', async () => {
  const path = await inputFile(`${JSON.stringify(sample)}\n{`);
  const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  expect(await run(['prototypes', 'observations', '--json', path])).toBe(2);
  expect(JSON.parse(String(log.mock.calls[0]![0]))).toMatchObject({
    diagnostics: [{ code: 'PO1001', line: 2, path: '<json>' }],
  });
});

test.each(['match', 'mismatch', 'unverified'] as const)(
  'CLI compares observation provenance with %s exit semantics and preserves inputs',
  async (status) => {
    const full = validatePrototypeDatabase(syntheticPrototypeDatabase());
    const database = {
      ...full,
      environment: {
        ...full.environment,
        mods: sample.environment.mods,
        ...(status === 'unverified' ? {} : { startupSettings: [] }),
      },
      entities: [
        {
          ...full.entities[0],
          key: sample.entity.key,
          name: 'synthetic-assembler',
          ...(status === 'mismatch' ? { type: 'lamp' } : {}),
        },
      ],
    };
    const baseText = JSON.stringify(database);
    const basePath = await inputFile(baseText);
    const observationText = `\n${JSON.stringify(sample)}\n`;
    const path = await inputFile(observationText);
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    expect(await run(['prototypes', 'compare-observations', '--json', basePath, path])).toBe(
      status === 'match' ? 0 : 1,
    );
    expect(JSON.parse(String(log.mock.calls[0]![0]))).toMatchObject({
      mode: 'environment-comparison-only',
      status,
      samples: [{ line: 2, status }],
    });
    expect(await readFile(basePath, 'utf8')).toBe(baseText);
    expect(await readFile(path, 'utf8')).toBe(observationText);
  },
);

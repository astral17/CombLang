import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadPrototypeDatabase, syntheticPrototypeDatabase } from '@comblang/prototypes';
import { afterEach, describe, expect, test, vi } from 'vitest';

import { run } from './main.js';
import { parseProjectProfile, resolveProjectOptions } from './project-profile.js';
import { parseCompilationOptions } from './prototype-options.js';

const directories: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

const profile = {
  schemaVersion: 1,
  source: 'source/main.factorio.ts',
  tests: 'source/circuit.test.js',
  prototypes: { path: 'data/profile.json' },
};

async function projectFile(value: unknown = profile): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'comblang-project-'));
  directories.push(directory);
  const path = join(directory, 'project with spaces.json');
  await writeFile(path, JSON.stringify(value));
  return path;
}

describe('CLI project profile', () => {
  test.each([
    null,
    [],
    { ...profile, schemaVersion: 2 },
    { ...profile, source: '' },
    { ...profile, tests: 42 },
    { ...profile, unexpected: true },
    { ...profile, diagnostics: { levels: { error: false } } },
    { ...profile, diagnostics: { rules: { 'Producer.Unused': { enabled: false } } } },
    { ...profile, diagnostics: { maxInstanceDetails: 101 } },
    { ...profile, prototypes: { path: 'data.json', identitiy: 'typo' } },
    { ...profile, prototypes: { path: '\0' } },
    { ...profile, prototypes: { path: 'data.json', identity: '' } },
  ])('rejects invalid project shape %j', (value) => {
    expect(() => parseProjectProfile(JSON.stringify(value), 'comblang.json')).toThrowError(
      expect.objectContaining({
        code: 'CLI1005',
        message: expect.stringContaining('comblang.json:'),
      }),
    );
  });

  test('rejects malformed JSON without evaluating it', () => {
    expect(() => parseProjectProfile('export default {}', 'project.js')).toThrowError(
      expect.objectContaining({ code: 'CLI1005' }),
    );
  });

  test('resolves configured paths against the project directory, leaving explicit files unchanged', async () => {
    const path = await projectFile();
    const check = await resolveProjectOptions(
      parseCompilationOptions(['--project', path]),
      'check',
    );
    expect(check.files).toEqual([join(dirname(path), 'source/main.factorio.ts')]);
    expect(check.prototypePath).toBe(join(dirname(path), 'data/profile.json'));
    const tests = await resolveProjectOptions(parseCompilationOptions(['--project', path]), 'test');
    expect(tests.files).toEqual([
      join(dirname(path), 'source/main.factorio.ts'),
      join(dirname(path), 'source/circuit.test.js'),
    ]);
    const override = await resolveProjectOptions(
      parseCompilationOptions(['--project', path, 'elsewhere.ts', 'tests.js']),
      'test',
    );
    expect(override.files).toEqual(['elsewhere.ts', 'tests.js']);
  });

  test('normalizes the optional diagnostic policy without searching for another config', async () => {
    const path = await projectFile({
      ...profile,
      diagnostics: {
        levels: { hint: true },
        rules: { 'producer.unused-output': { enabled: false, group: true } },
        maxInstanceDetails: 5,
      },
    });
    const options = await resolveProjectOptions(
      parseCompilationOptions(['--project', path]),
      'check',
    );
    expect(options.diagnosticPolicy).toEqual({
      levels: { error: true, warning: true, note: true, hint: true },
      rules: { 'producer.unused-output': { enabled: false, group: true } },
      maxInstanceDetails: 5,
    });
  });

  test('keeps an existing pin and permits an additional pin only for an unpinned project', async () => {
    const path = await projectFile({
      ...profile,
      prototypes: { path: 'data.json', identity: 'pinned' },
    });
    expect(
      (
        await resolveProjectOptions(
          parseCompilationOptions(['--project', path, '--prototype-identity', 'pinned']),
          'check',
        )
      ).prototypeIdentity,
    ).toBe('pinned');
    await expect(
      resolveProjectOptions(
        parseCompilationOptions(['--project', path, '--prototype-identity', 'different']),
        'check',
      ),
    ).rejects.toMatchObject({ code: 'CLI1003' });
    await expect(
      resolveProjectOptions(
        parseCompilationOptions(['--project', path, '--prototypes', 'other.json']),
        'check',
      ),
    ).rejects.toMatchObject({ code: 'CLI1001' });
    const unpinned = await projectFile();
    expect(
      (
        await resolveProjectOptions(
          parseCompilationOptions(['--project', unpinned, '--prototype-identity', 'pinned']),
          'check',
        )
      ).prototypeIdentity,
    ).toBe('pinned');
  });

  test('runs the checked-in pinned example with no positional paths', async () => {
    const path = fileURLToPath(
      new URL('../../../examples/prototype-stack/comblang.json', import.meta.url),
    );
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    expect(await run(['check', '--json', '--project', path])).toBe(0);
    expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toMatchObject({
      diagnostics: [{ code: 'CL2001', severity: 'warning' }],
      producerCount: 1,
    });
    log.mockClear();
    expect(await run(['test', '--json', '--project', path])).toBe(0);
    expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toMatchObject({
      diagnostics: [{ code: 'CL2001', severity: 'warning' }],
      tests: { passed: 1, failed: 0 },
    });
  });

  test('applies project diagnostic policy end to end for check', async () => {
    const path = await projectFile({
      ...profile,
      diagnostics: { rules: { 'producer.unused-output': { enabled: false } } },
    });
    await mkdir(join(dirname(path), 'source'));
    await mkdir(join(dirname(path), 'data'));
    await writeFile(
      join(dirname(path), 'source/main.factorio.ts'),
      'const input = new Network(); input + 1;',
    );
    await writeFile(
      join(dirname(path), 'data/profile.json'),
      JSON.stringify(syntheticPrototypeDatabase()),
    );
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    expect(await run(['check', '--json', '--project', path])).toBe(0);
    expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toMatchObject({ diagnostics: [] });

    await writeFile(
      path,
      JSON.stringify({
        ...profile,
        diagnostics: { rules: { 'producer.unused-output': { severity: 'error' } } },
      }),
    );
    log.mockClear();
    expect(await run(['check', '--json', '--project', path])).toBe(1);
    expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toMatchObject({
      diagnostics: [
        {
          code: 'CL2001',
          severity: 'error',
          ruleId: 'producer.unused-output',
          category: 'correctness',
        },
      ],
    });
  });

  test('blocks missing, malformed and conflicting projects with structured diagnostics', async () => {
    const path = await projectFile({
      ...profile,
      prototypes: { path: 'missing.json', identity: 'pinned' },
    });
    const malformed = await projectFile(null);
    const noTests = await projectFile({
      schemaVersion: 1,
      source: 'main.ts',
      prototypes: { path: 'data.json' },
    });
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    for (const [args, code] of [
      [['check', '--project', `${path}.missing`], 'CLI1005'],
      [['check', '--project', malformed], 'CLI1005'],
      [['check', '--project', path], 'CLI1002'],
      [['check', '--project', path, '--prototype-identity', 'other'], 'CLI1003'],
      [['test', '--project', noTests], 'CLI1001'],
    ] as const) {
      log.mockClear();
      expect(await run([...args, '--json'])).toBe(2);
      expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toMatchObject({ diagnostics: [{ code }] });
    }
    expect(error).not.toHaveBeenCalled();
  });

  test('checks the loaded database pin before source or test execution', async () => {
    const { prototypes } = await loadPrototypeDatabase(syntheticPrototypeDatabase());
    const path = await projectFile({
      ...profile,
      prototypes: { path: 'data/profile.json', identity: `${prototypes.identity}-wrong` },
    });
    await mkdir(join(dirname(path), 'data'));
    await writeFile(
      join(dirname(path), 'data/profile.json'),
      JSON.stringify(syntheticPrototypeDatabase()),
    );
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    expect(await run(['test', '--json', '--project', path])).toBe(2);
    expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toMatchObject({
      diagnostics: [{ code: 'CLI1003' }],
    });
  });
});

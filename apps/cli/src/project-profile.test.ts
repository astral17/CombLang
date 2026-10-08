import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadPrototypeDatabase, syntheticPrototypeDatabase } from '@comblang/prototypes';
import * as sourceApi from '@comblang/runtime/source-compilation';
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

  test('resolves source export without adding or reading configured tests', async () => {
    const path = await projectFile({
      ...profile,
      tests: 'tests/missing-or-throwing.test.js',
      diagnostics: { rules: { 'producer.unused-output': { enabled: false } } },
      prototypes: { path: 'data/profile.json', identity: 'pinned' },
    });
    const options = await resolveProjectOptions(
      parseCompilationOptions(['--project', path]),
      'export',
    );
    expect(options.files).toEqual([join(dirname(path), 'source/main.factorio.ts')]);
    expect(options.prototypePath).toBe(join(dirname(path), 'data/profile.json'));
    expect(options.prototypeIdentity).toBe('pinned');
    expect(options.diagnosticPolicy?.rules).toEqual({
      'producer.unused-output': { enabled: false },
    });
  });

  test('resolves parameter listing as source-only and leaves explicit source paths cwd-relative', async () => {
    const path = await projectFile({
      ...profile,
      tests: 'tests/missing-or-throwing.test.js',
      prototypes: { path: 'data/profile.json', identity: 'pinned' },
      diagnostics: { rules: { 'producer.unused-output': { enabled: false } } },
    });
    const configured = await resolveProjectOptions(
      parseCompilationOptions(['--project', path]),
      'parameters',
    );
    expect(configured.files).toEqual([join(dirname(path), 'source/main.factorio.ts')]);
    expect(configured.files).not.toContain(join(dirname(path), profile.tests));
    expect(configured.prototypePath).toBe(join(dirname(path), 'data/profile.json'));
    expect(configured.prototypeIdentity).toBe('pinned');
    expect(configured.diagnosticPolicy?.rules).toEqual({
      'producer.unused-output': { enabled: false },
    });
    const matchingPin = await resolveProjectOptions(
      parseCompilationOptions(['--project', path, '--prototype-identity', 'pinned']),
      'parameters',
    );
    expect(matchingPin.prototypeIdentity).toBe('pinned');
    await expect(
      resolveProjectOptions(
        parseCompilationOptions(['--project', path, '--prototype-identity', 'other']),
        'parameters',
      ),
    ).rejects.toMatchObject({ code: 'CLI1003' });

    const explicit = await resolveProjectOptions(
      parseCompilationOptions(['--project', path, 'alternate.factorio.ts']),
      'parameters',
    );
    expect(explicit.files).toEqual(['alternate.factorio.ts']);
  });

  test('lists configured and explicit project sources, then exports cwd-relative override and output paths', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'comblang-project-parameter-cli-'));
    directories.push(directory);
    const projectDirectory = join(directory, 'project');
    const projectSourceDirectory = join(projectDirectory, 'source');
    const projectDataDirectory = join(projectDirectory, 'data');
    await mkdir(projectSourceDirectory, { recursive: true });
    await mkdir(projectDataDirectory, { recursive: true });
    const projectPath = join(projectDirectory, 'comblang.json');
    const configuredSource = `const configured = Param.number('Configured', 5);
const output = new Network();`;
    await writeFile(join(projectSourceDirectory, 'main.factorio.ts'), configuredSource);

    const databasePath = fileURLToPath(
      new URL('../../../packages/prototypes/generated/space-age-2.1.17.json', import.meta.url),
    );
    const { prototypes } = await loadPrototypeDatabase(
      JSON.parse(await readFile(databasePath, 'utf8')),
    );
    await writeFile(join(projectDataDirectory, 'profile.json'), await readFile(databasePath));
    await writeFile(
      projectPath,
      JSON.stringify({
        schemaVersion: 1,
        source: 'source/main.factorio.ts',
        tests: 'tests/does-not-exist.test.js',
        prototypes: { path: 'data/profile.json', identity: prototypes.identity },
        diagnostics: { rules: { 'producer.unused-output': { enabled: false } } },
      }),
    );

    const alternateSource = `const selected = Param.number('CWD explicit', 7);
const output = new Network();`;
    await writeFile(join(directory, 'alternate.factorio.ts'), alternateSource);
    const exportSource = `const amount = Param.number('Export amount', 5);
const output = new Network();
output += Constant({ sections: [{ filters: [{ signal: Signal('virtual', 'signal-A'), value: amount }] }] });`;
    await writeFile(join(directory, 'alternate-export.factorio.ts'), exportSource);
    await writeFile(join(directory, 'values.json'), JSON.stringify([{ id: 0, value: 17 }]));

    const previous = process.cwd();
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      process.chdir(directory);
      expect(
        await run(['parameters', 'list', '--json', '--project', 'project/comblang.json']),
      ).toBe(0);
      expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toMatchObject({
        ok: true,
        parameters: [{ id: 0, kind: 'number', label: 'Configured', defaultValue: 5 }],
      });

      log.mockClear();
      expect(
        await run([
          'parameters',
          'list',
          '--json',
          '--project',
          'project/comblang.json',
          'alternate.factorio.ts',
        ]),
      ).toBe(0);
      expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toMatchObject({
        ok: true,
        parameters: [{ id: 0, kind: 'number', label: 'CWD explicit', defaultValue: 7 }],
      });

      log.mockClear();
      expect(
        await run([
          'blueprint',
          'export',
          '--json',
          '--project',
          'project/comblang.json',
          '--overrides',
          'values.json',
          '--output',
          'project-export.json',
          'alternate-export.factorio.ts',
        ]),
      ).toBe(0);
      expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toEqual({
        ok: true,
        output: join(directory, 'project-export.json'),
      });
      const exported = JSON.parse(await readFile(join(directory, 'project-export.json'), 'utf8'));
      expect(
        exported.blueprint.entities[0].control_behavior.sections.sections[0].filters[0],
      ).toMatchObject({
        count: 17,
      });
      expect(error).not.toHaveBeenCalled();
    } finally {
      process.chdir(previous);
    }
  });

  test('exports the checked-in pinned project with no positional source and no stdout banner', async () => {
    const path = fileURLToPath(
      new URL('../../../examples/prototype-stack/comblang.json', import.meta.url),
    );
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(await run(['blueprint', 'export', '--json', '--project', path])).toBe(0);
    expect(log).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toMatchObject({
      ok: true,
      document: { blueprint: { entities: [{ name: 'constant-combinator' }] } },
      diagnostics: [expect.objectContaining({ code: 'CL2001', severity: 'warning' })],
    });
    expect(error).not.toHaveBeenCalled();
    log.mockClear();
    expect(await run(['blueprint', 'export', '--project', path])).toBe(0);
    expect(log).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toMatchObject({
      blueprint: { entities: [{ name: 'constant-combinator' }] },
    });
    expect(String(log.mock.calls[0]?.[0])).not.toContain('Prototype environment:');
    expect(error).toHaveBeenCalledTimes(1);
    expect(String(error.mock.calls[0]?.[0])).toContain('warning CL2001');
  });

  test('exports a project that has no configured test file', async () => {
    const source = fileURLToPath(
      new URL('../../../examples/prototype-stack/main.factorio.ts', import.meta.url),
    );
    const prototypesPath = fileURLToPath(
      new URL('../../../packages/prototypes/generated/space-age-2.1.17.json', import.meta.url),
    );
    const database = await readFile(prototypesPath, 'utf8');
    const { prototypes } = await loadPrototypeDatabase(JSON.parse(database));
    const path = await projectFile({
      schemaVersion: 1,
      source,
      prototypes: { path: prototypesPath, identity: prototypes.identity },
    });
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    expect(await run(['blueprint', 'export', '--json', '--project', path])).toBe(0);
    expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toMatchObject({
      ok: true,
      document: { blueprint: { entities: [{ name: 'constant-combinator' }] } },
    });
  });

  test('source export rejects project/provider failures before compiling any source', async () => {
    const missing = join(tmpdir(), 'comblang-project-that-does-not-exist.json');
    const malformed = await projectFile(null);
    const missingDatabase = await projectFile({
      schemaVersion: 1,
      source: 'missing.ts',
      prototypes: { path: 'missing-database.json' },
    });
    const conflictingPin = await projectFile({
      ...profile,
      prototypes: { path: 'missing-database.json', identity: 'project-pin' },
    });
    const projectAndInjected = await projectFile({
      schemaVersion: 1,
      source: 'missing.ts',
      prototypes: { path: 'missing-database.json' },
    });
    const databasePath = fileURLToPath(
      new URL('../../../packages/prototypes/generated/space-age-2.1.17.json', import.meta.url),
    );
    const database = await readFile(databasePath, 'utf8');
    const loaded = await loadPrototypeDatabase(JSON.parse(database));
    const wrongLoadedPin = await projectFile({
      schemaVersion: 1,
      source: 'missing.ts',
      prototypes: { path: databasePath, identity: `${loaded.prototypes.identity}-wrong` },
    });
    const injected = (await loadPrototypeDatabase(syntheticPrototypeDatabase())).prototypes;
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const compile = vi.spyOn(sourceApi, 'compileSourceProgram');
    const cases: Array<{
      readonly args: string[];
      readonly code: string;
      readonly environment?: Parameters<typeof run>[1];
    }> = [
      { args: ['--project', missing], code: 'CLI1005' },
      { args: ['--project', malformed], code: 'CLI1005' },
      { args: ['--project', missingDatabase], code: 'CLI1002' },
      { args: ['--project', conflictingPin, '--prototype-identity', 'different'], code: 'CLI1003' },
      {
        args: ['--project', missing, '--prototypes', join(tmpdir(), 'absent-db.json')],
        code: 'CLI1001',
      },
      {
        args: ['--project', projectAndInjected],
        code: 'CLI1001',
        environment: { prototypes: injected },
      },
      { args: ['--project', wrongLoadedPin], code: 'CLI1003' },
    ];
    const noWrite = join(dirname(projectAndInjected), 'must-not-write.json');
    for (const { args, code, environment } of cases) {
      log.mockClear();
      expect(
        await run(['blueprint', 'export', '--json', ...args, '--output', noWrite], environment),
      ).toBe(2);
      expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toMatchObject({
        ok: false,
        error: { code },
      });
      await expect(readFile(noWrite)).rejects.toMatchObject({ code: 'ENOENT' });
    }
    expect(compile).not.toHaveBeenCalled();
  });

  test('uses project-relative data, ignores configured tests, and applies source export overrides and policy', async () => {
    const directory = await mkdtemp(join(process.cwd(), 'tmp CLI project with spaces-'));
    directories.push(directory);
    await mkdir(join(directory, 'source'));
    await mkdir(join(directory, 'data'));
    await mkdir(join(directory, 'tests'));
    const projectPath = join(directory, 'comblang.json');
    const databasePath = fileURLToPath(
      new URL('../../../packages/prototypes/generated/space-age-2.1.17.json', import.meta.url),
    );
    const database = await readFile(databasePath, 'utf8');
    const { prototypes } = await loadPrototypeDatabase(JSON.parse(database));
    const key = '__comblang_project_export_runs';
    const globals = globalThis as Record<string, unknown>;
    const previous = globals[key];
    globals[key] = 0;
    const source = `globalThis.${key} += 1;
const A = Signal('virtual', 'signal-A');
const amount = Param.number('Amount', 5);
const output = Constant({ sections: [{ filters: [{ signal: A, value: amount }] }] });`;
    const alternate = `globalThis.${key} += 1;
const A = Signal('virtual', 'signal-A');
const amount = Param.number('Override', 7);
const output = Constant({ sections: [{ filters: [{ signal: A, value: amount }] }] });`;
    const symbolicMultiplier = `globalThis.${key} += 1;
const A = Signal('virtual', 'signal-A');
const scale = Param.number('Scale', 1);
const output = Constant({ sections: [{ multiplier: scale, filters: [{ signal: A, value: 5 }] }] });`;
    const config = (
      diagnostics?: unknown,
      sourcePath = 'source/main.factorio.ts',
      includePin = true,
    ) => ({
      schemaVersion: 1,
      source: sourcePath,
      tests: 'tests/throwing.test.js',
      prototypes: {
        path: 'data/profile.json',
        ...(includePin ? { identity: prototypes.identity } : {}),
      },
      ...(diagnostics === undefined ? {} : { diagnostics }),
    });
    try {
      await writeFile(join(directory, 'data/profile.json'), database);
      await writeFile(
        join(directory, 'tests/throwing.test.js'),
        "throw new Error('must not execute test file');",
      );
      await writeFile(join(directory, 'source/main.factorio.ts'), source);
      await writeFile(projectPath, JSON.stringify(config()));
      const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
      const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      expect(await run(['check', '--json', '--project', projectPath])).toBe(0);
      const checkReport = JSON.parse(String(log.mock.calls[0]?.[0]));
      expect(checkReport.diagnostics).toEqual([
        expect.objectContaining({ code: 'CL2001', severity: 'warning', span: expect.any(Object) }),
      ]);
      expect(globals[key]).toBe(1);
      const defaultCode = await run(['blueprint', 'export', '--json', '--project', projectPath]);
      expect(defaultCode, String(log.mock.calls[1]?.[0])).toBe(0);
      const ordinary = JSON.parse(String(log.mock.calls[1]?.[0]));
      expect(ordinary).toMatchObject({
        ok: true,
        document: {
          blueprint: {
            entities: [
              { control_behavior: { sections: { sections: [{ filters: [{ count: 5 }] }] } } },
            ],
          },
        },
        diagnostics: [expect.objectContaining({ code: 'CL2001', severity: 'warning' })],
      });
      expect(ordinary.document.blueprint).not.toHaveProperty('parameters');
      const checkWarning = checkReport.diagnostics[0];
      expect(ordinary.diagnostics).toHaveLength(checkReport.diagnostics.length);
      expect(ordinary.diagnostics[0]).toMatchObject({
        code: checkWarning.code,
        message: checkWarning.message,
        severity: checkWarning.severity,
        ruleId: checkWarning.ruleId,
        span: { start: checkWarning.span.start, end: checkWarning.span.end },
      });
      expect(globals[key]).toBe(2);
      expect(String(log.mock.calls[1]?.[0])).not.toContain('Prototype environment:');

      log.mockClear();
      expect(
        await run([
          'blueprint',
          'export',
          '--json',
          '--parameters',
          '--project',
          projectPath,
          '--prototype-identity',
          prototypes.identity,
        ]),
      ).toBe(0);
      const parameterized = JSON.parse(String(log.mock.calls[0]?.[0]));
      expect(parameterized.document.blueprint.parameters).toEqual([
        { type: 'number', number: '5', name: 'Amount' },
      ]);
      expect(
        parameterized.document.blueprint.entities[0].control_behavior.sections.sections[0]
          .filters[0].count,
      ).toBe(5);
      expect(globals[key]).toBe(3);

      await writeFile(
        projectPath,
        JSON.stringify(config({ rules: { 'producer.unused-output': { severity: 'error' } } })),
      );
      const rejectedOutput = join(relative(process.cwd(), directory), 'rejected.json');
      log.mockClear();
      expect(
        await run([
          'blueprint',
          'export',
          '--json',
          '--project',
          projectPath,
          '--output',
          rejectedOutput,
        ]),
      ).toBe(2);
      expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toMatchObject({
        ok: false,
        error: { code: 'CL2001', span: expect.any(Object) },
      });
      await expect(readFile(join(directory, 'rejected.json'))).rejects.toMatchObject({
        code: 'ENOENT',
      });
      expect(globals[key]).toBe(4);

      await writeFile(
        projectPath,
        JSON.stringify(
          config(
            { rules: { 'producer.unused-output': { enabled: false } } },
            'source/missing-configured.factorio.ts',
            false,
          ),
        ),
      );
      const alternatePath = join(directory, 'alternate.factorio.ts');
      await writeFile(alternatePath, alternate);
      const output = join(relative(process.cwd(), directory), 'custom-output.json');
      log.mockClear();
      expect(
        await run([
          'blueprint',
          'export',
          '--json',
          '--parameters',
          '--project',
          projectPath,
          '--prototype-identity',
          prototypes.identity,
          '--label',
          'Project override',
          '--output',
          output,
          relative(process.cwd(), alternatePath),
        ]),
      ).toBe(0);
      expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toEqual({
        ok: true,
        output: join(directory, 'custom-output.json'),
      });
      const native = JSON.parse(await readFile(join(directory, 'custom-output.json'), 'utf8'));
      expect(native.blueprint).toMatchObject({
        label: 'Project override',
        entities: [{ control_behavior: { sections: { sections: [{ filters: [{ count: 7 }] }] } } }],
      });
      expect(native.blueprint.parameters).toEqual([
        { type: 'number', number: '7', name: 'Override' },
      ]);
      expect(globals[key]).toBe(5);

      const symbolicPath = join(directory, 'symbolic-multiplier.factorio.ts');
      await writeFile(symbolicPath, symbolicMultiplier);
      const symbolicRelative = relative(process.cwd(), symbolicPath);
      log.mockClear();
      expect(
        await run(['blueprint', 'export', '--json', '--project', projectPath, symbolicRelative]),
      ).toBe(0);
      const concrete = JSON.parse(String(log.mock.calls[0]?.[0]));
      expect(concrete.document.blueprint).not.toHaveProperty('parameters');
      expect(
        concrete.document.blueprint.entities[0].control_behavior.sections.sections[0],
      ).toMatchObject({
        multiplier: 1,
        filters: [{ count: 5 }],
      });
      expect(globals[key]).toBe(6);

      const rejectedNative = join(relative(process.cwd(), directory), 'native-rejected.json');
      log.mockClear();
      expect(
        await run([
          'blueprint',
          'export',
          '--json',
          '--parameters',
          '--project',
          projectPath,
          '--output',
          rejectedNative,
          symbolicRelative,
        ]),
      ).toBe(2);
      expect(JSON.parse(String(log.mock.calls[0]?.[0])).error).toMatchObject({
        code: 'CP1002',
        path: '$.constantTemplates[0].sections[0].multiplier',
        span: { start: expect.any(Number), end: expect.any(Number) },
      });
      expect(JSON.parse(String(log.mock.calls[0]?.[0]))).not.toHaveProperty('document');
      await expect(readFile(join(directory, 'native-rejected.json'))).rejects.toMatchObject({
        code: 'ENOENT',
      });
      expect(globals[key]).toBe(7);
      expect(error).not.toHaveBeenCalled();
    } finally {
      if (previous === undefined) delete globals[key];
      else globals[key] = previous;
    }
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

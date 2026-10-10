import { mkdtemp, open, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { DEFAULT_BLUEPRINT_CODEC_LIMITS } from '@comblang/blueprint';
import {
  createTrustedEntityReplayContext,
  syntheticZeroPortEntityProfile,
} from '@comblang/compiler';
import type { EntityProfile } from '@comblang/compiler/entity';
import * as blueprintJson from '@comblang/compiler/blueprint-json';
import { loadPrototypeDatabase, syntheticPrototypeDatabase } from '@comblang/prototypes';
import * as sourceApi from '@comblang/runtime/source-compilation';
import { createSourceParameterBindingSession } from '@comblang/runtime/source-parameter-binding';
import { run, type CliCompilationEnvironment } from './main.js';
import { parseSourceExportOptions, reportSourceExportFailure } from './blueprint-source-export.js';

const directories: string[] = [];
const simpleSource = `const A = Signal('virtual', 'signal-A');
const output = new Network();
output += CC(5 * A);`;

// Synthetic authority tests the CLI wiring, not native Factorio conformance.
async function parameterHost() {
  const families = [
    'constant-combinator',
    'arithmetic-combinator',
    'decider-combinator',
    'selector-combinator',
  ] as const;
  const database = syntheticPrototypeDatabase() as { entities: Array<Record<string, unknown>> };
  database.entities.push(
    ...families.map((family) => ({
      key: `entity:${family}`,
      name: family,
      type: family,
      blueprintEligible: true,
      tileWidth: 1,
      tileHeight: 1,
      circuit: {
        read: false,
        enableDisable: false,
        readContents: false,
        setFilters: false,
        setRequests: false,
        setRecipe: false,
        readRecipe: false,
        readFinishedCraft: false,
        outputSignals: false,
      },
    })),
  );
  const { prototypes } = await loadPrototypeDatabase(database);
  const identity = { schemaVersion: prototypes.schemaVersion, identity: prototypes.identity };
  const profiles = families.map((family, index): EntityProfile => ({
    ...structuredClone(syntheticZeroPortEntityProfile),
    ref: {
      ...syntheticZeroPortEntityProfile.ref,
      database: identity,
      prototypeKey: `entity:${family}`,
      profileId: `profile:cli-native-${index}` as EntityProfile['ref']['profileId'],
    },
    prototypeType: family,
  }));
  const trustedEntityReplayContext = createTrustedEntityReplayContext({
    database: identity,
    source: 'synthetic',
    evidenceIdentity: 'cli-source-export-test-evidence',
    policyIdentity: 'cli-source-export-test-policy',
    profiles,
  });
  return {
    database,
    environment: { prototypes, trustedEntityReplayContext } satisfies CliCompilationEnvironment,
  };
}

const mixedSource = `const A = Signal('virtual', 'signal-A');
const first = Param.number('First', 5, { variable: 'x' });
const second = Param.number('Second', 111, { formula: ' x * 2\\n', dependent: true });
const input = new Network();
const output = new Network();
input += CC(1 * A);
output += Selector({ input, operation: 'select', index: second });
output += Constant({ sections: [{ filters: [{ signal: A, value: first }] }] }).at(2, 3, 4);
output += Arithmetic({ left: first, operation: 'add', right: first, output: A });
output += Decider({ condition: (input[A] > first || input[A] == 0) && (input[A] < 19 || input[A] == 5), outputs: [input[A]] });`;

async function sourceFile(text = simpleSource, name = 'main.factorio.ts') {
  const directory = await mkdtemp(join(tmpdir(), 'comblang-source-export-'));
  directories.push(directory);
  const path = join(directory, name);
  await writeFile(path, text);
  return path;
}

function capture() {
  return {
    log: vi.spyOn(console, 'log').mockImplementation(() => undefined),
    error: vi.spyOn(console, 'error').mockImplementation(() => undefined),
    warn: vi.spyOn(console, 'warn').mockImplementation(() => undefined),
  };
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

describe('source blueprint export CLI', () => {
  test('parses project export with optional source and validates the project source arity', () => {
    expect(parseSourceExportOptions(['--project', 'comblang.json'])).toMatchObject({
      projectPath: 'comblang.json',
      files: [],
    });
    expect(
      parseSourceExportOptions([
        '--project',
        'comblang.json',
        'alternate.factorio.ts',
        '--parameters',
        '--label',
        'Kept label',
        '--output',
        'output.json',
        '--json',
      ]),
    ).toMatchObject({
      projectPath: 'comblang.json',
      files: ['alternate.factorio.ts'],
      parameters: true,
      label: 'Kept label',
      output: 'output.json',
      json: true,
    });
    for (const args of [
      ['--project', 'comblang.json', 'one.ts', 'two.ts'],
      ['--project', 'comblang.json', ''],
      ['--project'],
      ['--project', ''],
      ['--project', '--json'],
      ['--project', 'a.json', '--project', 'b.json'],
    ]) {
      expect(() => parseSourceExportOptions(args)).toThrowError(
        expect.objectContaining({ code: 'CLIBP1001' }),
      );
    }
    expect(() =>
      parseSourceExportOptions(['--project', 'a.json', '--prototypes', 'db.json']),
    ).toThrowError(expect.objectContaining({ code: 'CLI1001' }));
    expect(
      parseSourceExportOptions(['--project', 'comblang.json', '--', '--source.ts']).files,
    ).toEqual(['--source.ts']);
  });

  test('parses one overrides file and rejects malformed or native-template combinations', () => {
    expect(parseSourceExportOptions(['--overrides', 'values.json', 'source.ts'])).toMatchObject({
      overridesFile: 'values.json',
      files: ['source.ts'],
      parameters: false,
    });
    expect(
      parseSourceExportOptions([
        '--project',
        'comblang.json',
        '--overrides',
        'values.json',
        '--',
        'alternate.ts',
      ]),
    ).toMatchObject({
      projectPath: 'comblang.json',
      overridesFile: 'values.json',
      files: ['alternate.ts'],
    });
    for (const args of [
      ['source.ts', '--overrides'],
      ['source.ts', '--overrides', ''],
      ['source.ts', '--overrides', '   '],
      ['source.ts', '--overrides', 'a.json', '--overrides', 'b.json'],
      ['source.ts', '--overrides', 'values.json', '--parameters'],
    ]) {
      expect(() => parseSourceExportOptions(args)).toThrowError(
        expect.objectContaining({ code: 'CLIBP1001' }),
      );
    }
  });

  test('validates override conflicts first and reads malformed JSON before profile or source work', async () => {
    const path = await sourceFile(
      `globalThis.__comblang_override_ingress_runs += 1;\n${simpleSource}`,
    );
    const globals = globalThis as Record<string, unknown>;
    const key = '__comblang_override_ingress_runs';
    const previous = globals[key];
    globals[key] = 0;
    const { log, error } = capture();
    try {
      const invalidJson = join(dirname(path), 'invalid-values.json');
      await writeFile(invalidJson, '{');
      const missingProject = join(dirname(path), 'missing-project.json');
      expect(
        await run([
          'blueprint',
          'export',
          '--json',
          '--overrides',
          invalidJson,
          '--project',
          missingProject,
          path,
        ]),
      ).toBe(2);
      expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toMatchObject({
        ok: false,
        error: {
          code: 'CLI1001',
          message: expect.stringContaining(resolve(invalidJson)),
        },
      });
      expect(globals[key]).toBe(0);

      log.mockClear();
      const missingValues = join(dirname(path), 'missing-values.json');
      expect(
        await run([
          'blueprint',
          'export',
          '--json',
          '--parameters',
          '--overrides',
          missingValues,
          path,
        ]),
      ).toBe(2);
      expect(JSON.parse(String(log.mock.calls[0]?.[0])).error.code).toBe('CLIBP1001');
      expect(String(log.mock.calls[0]?.[0])).not.toContain('Unable to open input file');
      expect(globals[key]).toBe(0);
      expect(error).not.toHaveBeenCalled();
    } finally {
      if (previous === undefined) delete globals[key];
      else globals[key] = previous;
    }
  });

  test('dispatches source export with clean native stdout and both help entry points', async () => {
    const path = await sourceFile();
    const { log, error, warn } = capture();
    expect(await run(['blueprint', 'export', path])).toBe(0);
    expect(log).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toMatchObject({
      blueprint: {
        label: 'CombLang generated circuit',
        entities: [{ name: 'constant-combinator' }],
      },
    });
    expect(error).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
    for (const args of [['--help'], ['blueprint', '--help'], ['blueprint', 'export', '--help']]) {
      log.mockClear();
      expect(await run(args)).toBe(0);
      expect(String(log.mock.calls[0]?.[0])).toContain('blueprint export');
      if (args[0] === '--help' || (args[1] === 'export' && args[2] === '--help')) {
        expect(String(log.mock.calls[0]?.[0])).toContain('--project');
      }
    }
  });

  test('reports a JSON document or an exclusive native-only file', async () => {
    const path = await sourceFile();
    const output = join(dirname(path), 'document.json');
    const { log, error } = capture();
    expect(await run(['blueprint', 'export', '--json', '--label', 'Custom label', path])).toBe(0);
    const report = JSON.parse(String(log.mock.calls[0]?.[0]));
    expect(report).toMatchObject({ ok: true, document: { blueprint: { label: 'Custom label' } } });
    expect(report).not.toHaveProperty('diagnostics');
    expect(await run(['blueprint', 'export', path, '--output', output, '--json'])).toBe(0);
    expect(JSON.parse(String(log.mock.calls[1]?.[0]))).toEqual({ ok: true, output });
    expect(JSON.parse(await readFile(output, 'utf8'))).toHaveProperty('blueprint');
    expect(error).not.toHaveBeenCalled();
  });

  test.each([
    [],
    ['other.ts'],
    ['--format', 'json'],
    ['--exchange'],
    ['--input-file', 'source.ts'],
    ['--unknown'],
    ['--json', '--json'],
    ['--parameters', '--parameters'],
    ['--output'],
    ['--label'],
    ['--prototypes'],
    ['--prototype-identity'],
    ['--output', ''],
    ['--label', '--json'],
    ['--label', '-h'],
    ['--output', '--parameters'],
    ['--prototypes', '--json'],
    ['--prototypes', '-h'],
    ['--prototype-identity', ''],
    ['--label', 'x', '--label', 'y'],
    ['--output', 'a', '--output', 'b'],
    ['--prototypes', 'a', '--prototypes', 'b'],
    ['--prototype-identity', 'a', '--prototype-identity', 'b'],
    [''],
    ['--', '--json', 'extra.ts'],
  ])('rejects malformed arguments without execution or publication: %j', async (...extra) => {
    const path = await sourceFile(`throw new Error('must not execute');`);
    const output = join(dirname(path), 'unpublished.json');
    const { log, error } = capture();
    // [] explicitly tests missing source; every other case supplies a valid source too.
    const args = extra.length === 0 ? [] : [path, ...extra];
    expect(await run(['blueprint', 'export', '--json', '--output', output, ...args])).toBe(2);
    expect(log).toHaveBeenCalledTimes(1);
    const report = JSON.parse(String(log.mock.calls[0]?.[0]));
    expect(report.ok).toBe(false);
    expect(['CLIBP1001', 'CLI1001']).toContain(report.error.code);
    expect(String(log.mock.calls[0]?.[0])).not.toContain('must not execute');
    expect(error).not.toHaveBeenCalled();
    await expect(stat(output)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  test('respects literal separator and keeps export flags out of check/test', async () => {
    const path = await sourceFile(simpleSource, '--json');
    const { log, error } = capture();
    const previous = process.cwd();
    try {
      process.chdir(dirname(path));
      expect(await run(['blueprint', 'export', '--', '--json'])).toBe(0);
      expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toHaveProperty('blueprint');
      expect(await run(['blueprint', 'export', '--', '--json', '--parameters'])).toBe(2);
      expect(log).toHaveBeenCalledTimes(1);
      expect(error).toHaveBeenCalled();
    } finally {
      process.chdir(previous);
    }
    for (const command of ['check', 'test']) {
      for (const flag of ['--parameters', '--label', '--output']) {
        log.mockClear();
        expect(await run([command, '--json', flag, path])).toBe(2);
        expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toMatchObject({
          diagnostics: [{ code: 'CLI1001' }],
        });
      }
    }
  });

  test('exports ordered numeric metadata across four families from exactly one live compilation', async () => {
    const { environment } = await parameterHost();
    const globals = globalThis as Record<string, unknown>;
    const key = '__comblang_cli_export_executions';
    const previous = globals[key];
    globals[key] = 0;
    try {
      const path = await sourceFile(`globalThis.${key} += 1;\n${mixedSource}`);
      const { log, error } = capture();
      const compile = vi.spyOn(sourceApi, 'compileSourceProgram');
      const nativeExport = vi.spyOn(sourceApi, 'exportSourceCompilationNativeBlueprint');
      expect(await run(['blueprint', 'export', '--parameters', '--json', path], environment)).toBe(
        0,
      );
      expect(compile).toHaveBeenCalledTimes(1);
      expect(nativeExport).toHaveBeenCalledTimes(1);
      expect(nativeExport.mock.calls[0]?.[0]).toBe(compile.mock.results[0]?.value);
      expect(globals[key]).toBe(1);
      const native = JSON.parse(String(log.mock.calls[0]?.[0])).document;
      expect(native.blueprint.parameters).toEqual([
        { type: 'number', number: '5', name: 'First', variable: 'x' },
        { type: 'number', number: '111', name: 'Second', formula: ' x * 2\n', dependent: true },
      ]);
      expect(native.blueprint.entities.map((entity: { name: string }) => entity.name)).toEqual([
        'constant-combinator',
        'selector-combinator',
        'constant-combinator',
        'arithmetic-combinator',
        'decider-combinator',
      ]);
      expect(native.blueprint.entities[2]).toMatchObject({
        position: { x: 2, y: 3 },
        direction: 4,
        control_behavior: { sections: { sections: [{ filters: [{ count: 5 }] }] } },
      });
      expect(native.blueprint.entities[3]).toMatchObject({
        control_behavior: {
          arithmetic_conditions: { first_constant: 5, second_constant: 5 },
        },
      });
      expect(native.blueprint.entities[1]).toMatchObject({
        control_behavior: { index_constant: 111 },
      });
      expect(
        native.blueprint.entities[4].control_behavior.decider_conditions.conditions,
      ).toHaveLength(8);
      expect(native.blueprint.wires.length).toBeGreaterThan(0);
      expect(nativeExport.mock.calls[0]?.[1]).toEqual({
        label: 'CombLang generated circuit',
        maxDeciderConditionRows: 1024,
      });
      expect(await run(['blueprint', 'export', '--json', path], environment)).toBe(0);
      const concrete = JSON.parse(String(log.mock.calls[1]?.[0])).document;
      expect(concrete.blueprint).not.toHaveProperty('parameters');
      const { parameters: _parameters, ...unmarked } = native.blueprint;
      expect(concrete.blueprint).toEqual(unmarked);
      expect(globals[key]).toBe(2);
      expect(nativeExport).toHaveBeenCalledTimes(1);
      expect(error).not.toHaveBeenCalled();
    } finally {
      if (previous === undefined) delete globals[key];
      else globals[key] = previous;
    }
  });

  test('exports parameter overrides from one concrete bound pair and keeps the default export intact', async () => {
    const { environment } = await parameterHost();
    const key = '__comblang_cli_override_export_runs';
    const globals = globalThis as Record<string, unknown>;
    const previous = globals[key];
    globals[key] = 0;
    const source = `globalThis.${key} = Number(globalThis.${key} ?? 0) + 1;
const A = Signal('virtual', 'signal-A');
const channel = Param.signal('Channel', Signal('virtual', 'signal-B'));
const amount = Param.number('Amount', 5, { variable: 'x', formula: 'x * 2', dependent: true });
const input = new Network(); const output = new Network();
input += CC(2 * A);
output += Constant({ sections: [{ filters: [{ signal: channel, value: amount }] }] });
output += Arithmetic({ left: input[A], operation: 'add', right: amount, output: channel });`;
    const path = await sourceFile(source);
    const overridePath = join(dirname(path), 'values.json');
    const overrideValues = [
      { id: 0, value: { type: 'virtual', name: 'signal-C', quality: 'rare' } },
      { id: 1, value: 12 },
    ] as const;
    await writeFile(overridePath, JSON.stringify(overrideValues));
    const { log, error } = capture();
    try {
      const apiCompilation = sourceApi.compileSourceProgram({ path, text: source }, environment);
      const apiDefaultDocument = blueprintJson.generateBlueprintJson(
        apiCompilation.resolvedCircuit!.ir,
        { label: 'CombLang generated circuit', maxDeciderConditionRows: 1024 },
      );
      const apiBound = createSourceParameterBindingSession(apiCompilation).bind(overrideValues);
      const apiBoundDocument = blueprintJson.generateBlueprintJson(apiBound.resolvedCircuit.ir, {
        label: 'CombLang generated circuit',
        maxDeciderConditionRows: 1024,
      });
      expect(
        blueprintJson.generateBlueprintJson(apiCompilation.resolvedCircuit!.ir, {
          label: 'CombLang generated circuit',
          maxDeciderConditionRows: 1024,
        }),
      ).toEqual(apiDefaultDocument);
      expect(globals[key]).toBe(1);

      expect(await run(['blueprint', 'export', '--json', path], environment)).toBe(0);
      const originalReport = JSON.parse(String(log.mock.calls[0]?.[0]));
      const originalDocument = structuredClone(originalReport.document);
      expect(originalDocument).toEqual(apiDefaultDocument);
      expect(globals[key]).toBe(2);
      log.mockClear();
      expect(
        await run(
          ['blueprint', 'export', '--json', '--overrides', overridePath, path],
          environment,
        ),
      ).toBe(0);
      const report = JSON.parse(String(log.mock.calls[0]?.[0]));
      expect(report.ok).toBe(true);
      expect(report.document).toEqual(apiBoundDocument);
      expect(report.document).not.toHaveProperty('parameters');
      expect(JSON.stringify(report.document)).not.toMatch(/Channel|Amount|configurationTemplate/i);

      const originalEntities = originalDocument.blueprint.entities;
      const boundEntities = report.document.blueprint.entities;
      expect(boundEntities.map((entity: { name: string }) => entity.name)).toEqual(
        originalEntities.map((entity: { name: string }) => entity.name),
      );
      expect(report.document.blueprint.wires).toEqual(originalDocument.blueprint.wires);
      const entity = (
        entities: Array<Record<string, any>>,
        name: string,
        index = 0,
      ): Record<string, any> => {
        const found = entities.filter((candidate) => candidate.name === name)[index];
        expect(found).toBeDefined();
        return found!;
      };
      expect(
        entity(originalEntities, 'constant-combinator', 1).control_behavior.sections.sections[0]
          .filters[0],
      ).toMatchObject({ name: 'signal-B', count: 5 });
      expect(
        entity(boundEntities, 'constant-combinator', 1).control_behavior.sections.sections[0]
          .filters[0],
      ).toMatchObject({ name: 'signal-C', quality: 'rare', count: 12 });
      expect(
        entity(originalEntities, 'arithmetic-combinator').control_behavior.arithmetic_conditions,
      ).toMatchObject({ second_constant: 5, output_signal: { name: 'signal-B' } });
      expect(
        entity(boundEntities, 'arithmetic-combinator').control_behavior.arithmetic_conditions,
      ).toMatchObject({
        second_constant: 12,
        output_signal: { name: 'signal-C', quality: 'rare' },
      });
      expect(originalReport.document).toEqual(originalDocument);
      const sentinelPath = join(dirname(path), 'existing-bound-output.json');
      await writeFile(sentinelPath, 'keep this file');
      log.mockClear();
      expect(
        await run(
          [
            'blueprint',
            'export',
            '--json',
            '--overrides',
            overridePath,
            '--output',
            sentinelPath,
            path,
          ],
          environment,
        ),
      ).toBe(2);
      expect(JSON.parse(String(log.mock.calls[0]?.[0])).error).toMatchObject({
        code: 'CLIBP1003',
        path: sentinelPath,
      });
      expect(await readFile(sentinelPath, 'utf8')).toBe('keep this file');
      expect(globals[key]).toBe(4);
      expect(error).not.toHaveBeenCalled();
    } finally {
      if (previous === undefined) delete globals[key];
      else globals[key] = previous;
    }
  });

  test('exports the accepted Constant-count and Arithmetic-operand expressions locally', async () => {
    const { environment } = await parameterHost();
    const key = '__comblang_cli_local_expression_export_runs';
    const globals = globalThis as Record<string, unknown>;
    const previous = globals[key];
    globals[key] = 0;
    const source = `globalThis.${key} = Number(globalThis.${key} ?? 0) + 1;
const A = Signal('virtual', 'signal-A');
const amount = Param.number('Amount', 5);
const factor = Param.number('Factor', 2);
const input = new Network();
const output = new Network();
input += Constant({ sections: [{ filters: [{ signal: A, value: (amount + 1) * factor }] }] });
output += Arithmetic({ left: input[A], operation: 'multiply', right: amount - 1, output: A });`;
    try {
      const path = await sourceFile(source);
      const valuesPath = join(dirname(path), 'expression-values.json');
      await writeFile(
        valuesPath,
        JSON.stringify([
          { id: 0, value: 9 },
          { id: 1, value: 3 },
        ]),
      );
      const { log, error } = capture();

      expect(await run(['blueprint', 'export', '--json', path], environment)).toBe(0);
      const defaults = JSON.parse(String(log.mock.calls[0]?.[0])).document;
      expect(globals[key]).toBe(1);
      expect(defaults.blueprint.entities).toHaveLength(2);
      const constant = (document: typeof defaults) =>
        document.blueprint.entities.find(
          (entity: { name: string }) => entity.name === 'constant-combinator',
        );
      const arithmetic = (document: typeof defaults) =>
        document.blueprint.entities.find(
          (entity: { name: string }) => entity.name === 'arithmetic-combinator',
        );
      expect(constant(defaults).control_behavior.sections.sections[0].filters[0]).toMatchObject({
        name: 'signal-A',
        count: 12,
      });
      expect(arithmetic(defaults).control_behavior.arithmetic_conditions).toMatchObject({
        first_signal: { name: 'signal-A' },
        second_constant: 4,
        output_signal: { name: 'signal-A' },
      });
      expect(defaults.blueprint.wires.length).toBeGreaterThan(0);

      log.mockClear();
      expect(
        await run(['blueprint', 'export', '--json', '--overrides', valuesPath, path], environment),
      ).toBe(0);
      const bound = JSON.parse(String(log.mock.calls[0]?.[0])).document;
      expect(globals[key]).toBe(2);
      expect(bound.blueprint.entities).toHaveLength(2);
      expect(constant(bound).control_behavior.sections.sections[0].filters[0]).toMatchObject({
        name: 'signal-A',
        count: 30,
      });
      expect(arithmetic(bound).control_behavior.arithmetic_conditions).toMatchObject({
        first_signal: { name: 'signal-A' },
        second_constant: 8,
        output_signal: { name: 'signal-A' },
      });
      expect(bound.blueprint.wires).toEqual(defaults.blueprint.wires);
      expect(defaults.blueprint.entities[0]).not.toEqual(bound.blueprint.entities[0]);
      expect(error).not.toHaveBeenCalled();
    } finally {
      if (previous === undefined) delete globals[key];
      else globals[key] = previous;
    }
  });

  test.each([
    [
      'Constant filter count',
      `Constant({ sections: [{ filters: [{ signal: A, value: amount + 1 }] }] })`,
      'constant-combinator',
    ],
    [
      'Arithmetic operand',
      `Arithmetic({ left: amount + 1, operation: 'add', right: 0, output: A })`,
      'arithmetic-combinator',
    ],
  ] as const)(
    'keeps the derived %s root locally bindable but rejects native-template export',
    async (_label, device, entityName) => {
      const { environment } = await parameterHost();
      const key = '__comblang_cli_derived_native_rejection_runs';
      const globals = globalThis as Record<string, unknown>;
      const previous = globals[key];
      globals[key] = 0;
      const source = `globalThis.${key} = Number(globalThis.${key} ?? 0) + 1;
const A = Signal('virtual', 'signal-A');
const amount = Param.number('Amount', 5);
const output = new Network();
output += ${device};`;
      try {
        const path = await sourceFile(source);
        const valuesPath = join(dirname(path), 'expression-values.json');
        const outputPath = join(dirname(path), 'rejected-expression.json');
        await writeFile(valuesPath, JSON.stringify([{ id: 0, value: 9 }]));
        const { log, error } = capture();

        expect(await run(['blueprint', 'export', '--json', path], environment)).toBe(0);
        const defaults = JSON.parse(String(log.mock.calls[0]?.[0])).document;
        expect(defaults.blueprint.entities).toHaveLength(1);
        expect(defaults.blueprint.entities[0].name).toBe(entityName);
        expect(globals[key]).toBe(1);

        log.mockClear();
        expect(
          await run(
            ['blueprint', 'export', '--json', '--overrides', valuesPath, path],
            environment,
          ),
        ).toBe(0);
        const bound = JSON.parse(String(log.mock.calls[0]?.[0])).document;
        expect(globals[key]).toBe(2);
        expect(bound.blueprint.entities).toHaveLength(1);
        expect(bound.blueprint.entities[0].control_behavior).not.toEqual(
          defaults.blueprint.entities[0].control_behavior,
        );
        if (entityName === 'constant-combinator') {
          expect(
            bound.blueprint.entities[0].control_behavior.sections.sections[0].filters[0],
          ).toMatchObject({
            count: 10,
          });
        } else {
          expect(bound.blueprint.entities[0].control_behavior.arithmetic_conditions).toMatchObject({
            first_constant: 10,
          });
        }

        log.mockClear();
        expect(
          await run(
            ['blueprint', 'export', '--json', '--parameters', '--output', outputPath, path],
            environment,
          ),
        ).toBe(2);
        const failure = JSON.parse(String(log.mock.calls[0]?.[0]));
        expect(failure).toMatchObject({
          ok: false,
          error: {
            code: 'CP1002',
            span: {
              fileId: expect.any(String),
              start: expect.any(Number),
              end: expect.any(Number),
            },
          },
        });
        expect(failure).not.toHaveProperty('document');
        await expect(stat(outputPath)).rejects.toMatchObject({ code: 'ENOENT' });
        expect(globals[key]).toBe(3);
        expect(error).not.toHaveBeenCalled();
      } finally {
        if (previous === undefined) delete globals[key];
        else globals[key] = previous;
      }
    },
  );

  test('accepts only an empty override array for parameter-free sources', async () => {
    const path = await sourceFile(simpleSource);
    const valuesPath = join(dirname(path), 'empty-values.json');
    await writeFile(valuesPath, '[]');
    const invalidPath = join(dirname(path), 'invalid-empty-values.json');
    await writeFile(invalidPath, '[{"id":0,"value":1}]');
    const malformedPath = join(dirname(path), 'malformed-empty-values.json');
    await writeFile(malformedPath, '{}');
    const { log, error } = capture();

    expect(await run(['blueprint', 'export', '--json', path])).toBe(0);
    const defaultDocument = JSON.parse(String(log.mock.calls[0]?.[0])).document;
    log.mockClear();
    expect(await run(['blueprint', 'export', '--json', '--overrides', valuesPath, path])).toBe(0);
    expect(JSON.parse(String(log.mock.calls[0]?.[0])).document).toEqual(defaultDocument);

    for (const [index, overrides] of [invalidPath, malformedPath].entries()) {
      const outputPath = join(dirname(path), `must-not-exist-${index}.json`);
      log.mockClear();
      expect(
        await run([
          'blueprint',
          'export',
          '--json',
          '--overrides',
          overrides,
          '--output',
          outputPath,
          path,
        ]),
      ).toBe(2);
      expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toMatchObject({
        ok: false,
        error: { code: 'CLI1001', message: expect.stringContaining('no parameter declarations') },
      });
      await expect(stat(outputPath)).rejects.toMatchObject({ code: 'ENOENT' });
    }
    expect(error).not.toHaveBeenCalled();
  });

  test('retains adapter error codes, semantic paths and declaration spans without publishing', async () => {
    const { environment } = await parameterHost();
    const source = `const amount = Param.number('Amount', 5);
const channel = Param.signal('Channel', Signal('virtual', 'signal-B'));
const unused = Param.number('Unused', 9);
const output = new Network();
output += Constant({ sections: [{ filters: [{ signal: channel, value: amount }] }] });`;
    const path = await sourceFile(source);
    const cases = [
      {
        values: [{ id: 0, value: 'five' }],
        code: 'CP1000',
        semanticPath: '$.overrides[0].value',
        hasSpan: true,
      },
      {
        values: [{ id: 1, value: { type: 'virtual', name: 'signal-each' } }],
        code: 'CP1000',
        semanticPath: '$.overrides[0].value.name',
        hasSpan: true,
      },
      {
        values: [{ id: 99, value: 5 }],
        code: 'CP1000',
        semanticPath: '$.overrides[0].id',
        hasSpan: false,
      },
      {
        values: [
          { id: 0, value: 5 },
          { id: 0, value: 6 },
        ],
        code: 'CP1000',
        semanticPath: '$.overrides[1].id',
        hasSpan: true,
      },
      {
        values: [{ id: 2, value: 10 }],
        code: 'CP1001',
        semanticPath: '$.bindings',
        hasSpan: true,
      },
    ] as const;
    const { log, error } = capture();

    for (const [index, item] of cases.entries()) {
      const valuesPath = join(dirname(path), `invalid-${index}.json`);
      const outputPath = join(dirname(path), `unpublished-${index}.json`);
      await writeFile(valuesPath, JSON.stringify(item.values));
      log.mockClear();
      expect(
        await run(
          [
            'blueprint',
            'export',
            '--json',
            '--overrides',
            valuesPath,
            '--output',
            outputPath,
            path,
          ],
          environment,
        ),
      ).toBe(2);
      const report = JSON.parse(String(log.mock.calls[0]?.[0]));
      expect(report).toMatchObject({
        ok: false,
        error: { code: item.code, path: item.semanticPath },
      });
      if (item.hasSpan) {
        expect(report.error.span).toMatchObject({
          start: expect.any(Number),
          end: expect.any(Number),
        });
      } else expect(report.error).not.toHaveProperty('span');
      expect(report).not.toHaveProperty('document');
      await expect(stat(outputPath)).rejects.toMatchObject({ code: 'ENOENT' });
    }
    expect(error).not.toHaveBeenCalled();
  });

  test('allows a finite fractional multiplier but rejects a fractional Constant count', async () => {
    const { environment } = await parameterHost();
    const multiplierSource = await sourceFile(`const scale = Param.number('Scale', 1);
const output = new Network();
output += Constant({ sections: [{ multiplier: scale, filters: [{ signal: Signal('virtual', 'signal-A'), value: 1 }] }] });`);
    const multiplierOverrides = join(dirname(multiplierSource), 'fractional-multiplier.json');
    await writeFile(multiplierOverrides, JSON.stringify([{ id: 0, value: 0.5 }]));
    const { log, error } = capture();
    expect(
      await run(
        ['blueprint', 'export', '--json', '--overrides', multiplierOverrides, multiplierSource],
        environment,
      ),
    ).toBe(0);
    expect(JSON.parse(String(log.mock.calls[0]?.[0])).document.blueprint.entities[0]).toMatchObject(
      {
        control_behavior: { sections: { sections: [{ multiplier: 0.5 }] } },
      },
    );

    const countSource = await sourceFile(`const count = Param.number('Count', 1);
const output = new Network();
output += Constant({ sections: [{ filters: [{ signal: Signal('virtual', 'signal-A'), value: count }] }] });`);
    const countOverrides = join(dirname(countSource), 'fractional-count.json');
    const countOutput = join(dirname(countSource), 'must-not-exist.json');
    await writeFile(countOverrides, JSON.stringify([{ id: 0, value: 1.5 }]));
    log.mockClear();
    expect(
      await run(
        [
          'blueprint',
          'export',
          '--json',
          '--overrides',
          countOverrides,
          '--output',
          countOutput,
          countSource,
        ],
        environment,
      ),
    ).toBe(2);
    expect(JSON.parse(String(log.mock.calls[0]?.[0])).error).toMatchObject({
      code: 'CP1000',
      path: expect.stringContaining('filters[0].value'),
      span: { start: expect.any(Number), end: expect.any(Number) },
    });
    await expect(stat(countOutput)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(error).not.toHaveBeenCalled();
  });

  test('both modes produce identical ordinary documents without declarations', async () => {
    const path = await sourceFile();
    const { log } = capture();
    const nativeExport = vi.spyOn(sourceApi, 'exportSourceCompilationNativeBlueprint');
    expect(await run(['blueprint', 'export', path])).toBe(0);
    expect(await run(['blueprint', 'export', '--parameters', path])).toBe(0);
    expect(log.mock.calls[1]?.[0]).toBe(log.mock.calls[0]?.[0]);
    expect(nativeExport).not.toHaveBeenCalled();
    expect(JSON.parse(String(log.mock.calls[0]?.[0])).blueprint).not.toHaveProperty('parameters');
  });

  test.each([
    [
      "const amount = Param.number('Scale', 1);",
      'Constant({ sections: [{ multiplier: amount, filters: [{ signal: A, value: 3 }] }] })',
      '$.constantTemplates[0].sections[0].multiplier',
    ],
    [
      "const amount = Param.signal('Channel', A);",
      'Constant({ sections: [{ filters: [{ signal: amount, value: 5 }] }] })',
      '$.parameters[0]',
    ],
    [
      "const amount = Param.signal('Channel', A);",
      "Arithmetic({ left: 2, operation: 'add', right: 5, output: amount })",
      '$.parameters[0]',
    ],
    [
      "const amount = Param.signal('Channel', A); const count = Param.number('Amount', 5);",
      "Arithmetic({ left: 2, operation: 'add', right: count, output: amount })",
      '$.parameters[0]',
    ],
    [
      "const amount = Param.number('Unused', 5);",
      'Constant({ sections: [{ filters: [{ signal: A, value: 3 }] }] })',
      '$.parameters[0]',
    ],
    [
      "const amount = Param.number('Large', 2147483648);",
      'Constant({ sections: [{ filters: [{ signal: A, value: amount }] }] })',
      '$.parameters[0].defaultValue',
    ],
    [
      "const amount = Param.number('Small', -2147483649);",
      'Constant({ sections: [{ filters: [{ signal: A, value: amount }] }] })',
      '$.parameters[0].defaultValue',
    ],
    [
      "const amount = Param.number('First', 5); const other = Param.number('Second', 5);",
      "Arithmetic({ left: amount, operation: 'add', right: other, output: A })",
      '$.parameters[1].defaultValue',
    ],
  ])(
    'explicit metadata rejection keeps located CP1002 and never writes or falls back: %s',
    async (declaration, device, semanticPath) => {
      const { environment } = await parameterHost();
      const text = `const A = Signal('virtual', 'signal-A');\n${declaration}\nconst output = new Network();\noutput += ${device};`;
      const path = await sourceFile(text);
      const output = join(dirname(path), 'rejected.json');
      const { log, error } = capture();
      expect(
        await run(
          ['blueprint', 'export', '--parameters', '--output', output, '--json', path],
          environment,
        ),
      ).toBe(2);
      const report = JSON.parse(String(log.mock.calls[0]?.[0]));
      expect(report).toMatchObject({
        ok: false,
        error: {
          code: 'CP1002',
          path: semanticPath,
          span: { fileId: expect.any(String), start: expect.any(Number), end: expect.any(Number) },
        },
      });
      const multiplier = semanticPath.startsWith('$.constantTemplates');
      expect(text.slice(report.error.span.start, report.error.span.end)).toContain(
        multiplier ? 'Constant(' : 'Param.',
      );
      expect(report).not.toHaveProperty('document');
      await expect(stat(output)).rejects.toMatchObject({ code: 'ENOENT' });
      expect(await run(['blueprint', 'export', '--parameters', path], environment)).toBe(2);
      expect(log).toHaveBeenCalledTimes(1);
      expect(String(error.mock.calls.at(-1)?.[0])).toContain(`${path}:${multiplier ? 4 : 2}:`);
      expect(String(error.mock.calls.at(-1)?.[0])).toContain(semanticPath);
      expect(await run(['blueprint', 'export', '--json', path], environment)).toBe(0);
      expect(JSON.parse(String(log.mock.calls[1]?.[0])).document.blueprint).not.toHaveProperty(
        'parameters',
      );
      if (multiplier) {
        expect(
          JSON.parse(String(log.mock.calls[1]?.[0])).document.blueprint.entities[0],
        ).toMatchObject({
          control_behavior: {
            sections: { sections: [{ multiplier: 1, filters: [{ count: 3 }] }] },
          },
        });
      }
    },
  );

  test('symbolic numeric expression remains a located compilation failure without output', async () => {
    const { environment } = await parameterHost();
    const { log } = capture();
    for (const device of ["Selector({ input, operation: 'select', index: amount + 1 })"]) {
      const path = await sourceFile(`const A = Signal('virtual', 'signal-A');
const amount = Param.number('Amount', 5);
const input = new Network(); const output = new Network(); output += ${device};`);
      const output = join(dirname(path), 'unsupported.json');
      log.mockClear();
      expect(
        await run(
          ['blueprint', 'export', '--json', '--parameters', '--output', output, path],
          environment,
        ),
      ).toBe(2);
      const report = JSON.parse(String(log.mock.calls[0]?.[0]));
      expect(report.ok).toBe(false);
      expect(report.error.code).not.toBe('CLIBP1000');
      expect(report.error.span).toBeDefined();
      expect(
        report.diagnostics.some(
          (diagnostic: { severity: string }) => diagnostic.severity === 'error',
        ),
      ).toBe(true);
      await expect(stat(output)).rejects.toMatchObject({ code: 'ENOENT' });
    }
  });

  test('provider selection/provisioning is reused, emits no banner, and rejects unavailable or mismatched authority', async () => {
    const { database, environment } = await parameterHost();
    const path = await sourceFile(
      `const output = new Network(); output += Constant({ sections: [{ filters: [{ signal: Signal('virtual', 'signal-A'), value: 5 }] }] });`,
    );
    const profile = join(dirname(path), 'prototypes.json');
    await writeFile(profile, JSON.stringify(database));
    const { log, error } = capture();
    expect(
      await run([
        'blueprint',
        'export',
        '--prototypes',
        profile,
        '--prototype-identity',
        environment.prototypes.identity,
        path,
      ]),
    ).toBe(0);
    expect(log).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(log.mock.calls[0]?.[0])).blueprint.entities).toHaveLength(1);
    expect(error).not.toHaveBeenCalled();
    log.mockClear();
    expect(await run(['blueprint', 'export', '--json', path])).toBe(2);
    expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toMatchObject({
      ok: false,
      diagnostics: [expect.objectContaining({ code: 'RT2027', span: expect.any(Object) })],
    });
    const failures: Array<[string[], CliCompilationEnvironment, string]> = [
      [['--prototype-identity', 'missing'], {}, 'CLI1003'],
      [['--prototype-identity', 'mismatch'], environment, 'CLI1003'],
      [['--prototypes', profile], environment, 'CLI1001'],
      [
        [],
        {
          prototypes: (await loadPrototypeDatabase(syntheticPrototypeDatabase())).prototypes,
          trustedEntityReplayContext: environment.trustedEntityReplayContext,
        },
        'ER1001',
      ],
      [['--prototypes', 'missing-prototypes.json'], {}, 'CLI1002'],
    ];
    const unexecuted = await sourceFile(`throw new Error('must not execute');`);
    for (const [args, injected, code] of failures) {
      log.mockClear();
      expect(await run(['blueprint', 'export', '--json', ...args, unexecuted], injected)).toBe(2);
      expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toMatchObject({
        ok: false,
        error: { code },
      });
      expect(String(log.mock.calls[0]?.[0])).not.toContain('must not execute');
    }
  });

  test('retains compile diagnostics and source positions without publishing failed output', async () => {
    const path = await sourceFile('\nconst ANY = 5;');
    const output = join(dirname(path), 'invalid.json');
    const { log, error } = capture();
    expect(await run(['blueprint', 'export', '--json', '--output', output, path])).toBe(2);
    const report = JSON.parse(String(log.mock.calls[0]?.[0]));
    expect(report).toMatchObject({
      ok: false,
      error: { code: report.diagnostics[0].code, span: expect.any(Object) },
      diagnostics: [expect.objectContaining({ severity: 'error' })],
    });
    expect(report.error).not.toHaveProperty('severity');
    await expect(stat(output)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await run(['blueprint', 'export', path])).toBe(2);
    expect(log).toHaveBeenCalledTimes(1);
    expect(String(error.mock.calls[0]?.[0])).toContain(`${path}:2:`);
  });

  test('warnings remain visible on stderr, or as nonempty JSON diagnostics, with exit zero', async () => {
    const path = await sourceFile('const output = CC();');
    const output = join(dirname(path), 'warnings.json');
    const { log, error, warn } = capture();
    expect(await run(['blueprint', 'export', path])).toBe(0);
    expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toHaveProperty('blueprint');
    expect(String(error.mock.calls[0]?.[0])).toMatch(/warning CL\d+/);
    expect(String(error.mock.calls[0]?.[0])).toContain(`${path}:1:`);
    expect(warn).not.toHaveBeenCalled();
    error.mockClear();
    expect(await run(['blueprint', 'export', '--json', '--output', output, path])).toBe(0);
    expect(JSON.parse(String(log.mock.calls[1]?.[0]))).toMatchObject({
      ok: true,
      output,
      diagnostics: [expect.objectContaining({ severity: 'warning' })],
    });
    expect(JSON.parse(await readFile(output, 'utf8'))).not.toHaveProperty('diagnostics');
    expect(error).not.toHaveBeenCalled();
  });

  test('bounded reader rejects missing, invalid UTF-8 and oversized sources before publication', async () => {
    const path = await sourceFile();
    const invalid = join(dirname(path), 'invalid.factorio.ts');
    const large = join(dirname(path), 'large.factorio.ts');
    await writeFile(invalid, new Uint8Array([0xff]));
    const handle = await open(large, 'wx');
    try {
      await handle.truncate(DEFAULT_BLUEPRINT_CODEC_LIMITS.maxDecompressedBytes + 1);
    } finally {
      await handle.close();
    }
    const { log, error } = capture();
    for (const [input, code] of [
      [join(dirname(path), 'missing.ts'), 'CLIBP1002'],
      [invalid, 'CLIBP1005'],
      [large, 'CLIBP1002'],
    ]) {
      const output = `${input}.json`;
      log.mockClear();
      expect(await run(['blueprint', 'export', '--json', '--output', output, input!])).toBe(2);
      expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toMatchObject({
        ok: false,
        error: { code, path: input },
      });
      await expect(stat(output)).rejects.toMatchObject({ code: 'ENOENT' });
    }
    expect(error).not.toHaveBeenCalled();
  });

  test('exclusive file writing never replaces output sentinels or the source, and reports plain paths', async () => {
    const path = await sourceFile();
    const output = join(dirname(path), 'existing.json');
    await writeFile(output, 'sentinel');
    const { log, error } = capture();
    for (const destination of [output, path]) {
      log.mockClear();
      expect(await run(['blueprint', 'export', '--json', '--output', destination, path])).toBe(2);
      expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toMatchObject({
        ok: false,
        error: { code: 'CLIBP1003', path: destination },
      });
    }
    expect(await readFile(output, 'utf8')).toBe('sentinel');
    expect(await readFile(path, 'utf8')).toBe(simpleSource);
    const newOutput = join(dirname(path), 'new.json');
    log.mockClear();
    expect(await run(['blueprint', 'export', '--output', newOutput, path])).toBe(0);
    expect(log.mock.calls[0]?.[0]).toBe(`Wrote ${newOutput}`);
    expect(JSON.parse(await readFile(newOutput, 'utf8'))).toHaveProperty('blueprint');
    log.mockClear();
    const missingDirectory = join(dirname(path), 'missing', 'output.json');
    expect(await run(['blueprint', 'export', '--json', '--output', missingDirectory, path])).toBe(
      2,
    );
    expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toMatchObject({
      ok: false,
      error: { code: 'CLIBP1004' },
    });
    expect(error).not.toHaveBeenCalled();
  });

  test('UTF-8 output byte budget is checked before the exclusive writer opens a file', async () => {
    const path = await sourceFile();
    const output = join(dirname(path), 'oversized.json');
    const { log } = capture();
    // Isolate the CLI emission guard; native emitter validation has its own lower budgets.
    const document = blueprintJson.generateBlueprintJson(
      sourceApi.compileSourceProgram({ path, text: simpleSource }).resolvedCircuit!.ir,
    );
    vi.spyOn(blueprintJson, 'generateBlueprintJson').mockReturnValue({
      blueprint: {
        ...document.blueprint,
        label: '界'.repeat(Math.ceil(DEFAULT_BLUEPRINT_CODEC_LIMITS.maxEmittedBytes / 3)),
      },
    });
    expect(await run(['blueprint', 'export', '--json', '--output', output, path])).toBe(2);
    expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toMatchObject({
      ok: false,
      error: { code: 'CLIBP1002' },
    });
    await expect(stat(output)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  test('failure envelope preserves related source information from typed errors', () => {
    const { log } = capture();
    const span = { fileId: 'test.ts', start: 0, end: 1 };
    const related = [{ message: 'original declaration', span }];
    const error = Object.assign(new Error('conflicting configuration'), {
      code: 'CP1002',
      path: '$.slot',
      span,
      related,
    });
    expect(reportSourceExportFailure(error, true)).toBe(2);
    expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toEqual({
      ok: false,
      error: {
        code: 'CP1002',
        message: error.message,
        path: '$.slot',
        span,
        related,
      },
    });
  });

  test('documented source examples run, and a parameter file feeds the existing codec separately', async () => {
    const page = await readFile(
      new URL('../../../docs/blueprint-json.md', import.meta.url),
      'utf8',
    );
    const section = page.split('## Source export CLI')[1]?.split('## Mapping')[0];
    const examples = [...section!.matchAll(/```ts\r?\n([\s\S]*?)```/g)].map((match) => match[1]!);
    expect(examples).toHaveLength(2);
    const { environment } = await parameterHost();
    const { log, error } = capture();
    const simple = await sourceFile(examples[0]);
    expect(await run(['blueprint', 'export', simple])).toBe(0);
    expect(JSON.parse(String(log.mock.calls[0]?.[0])).blueprint.entities).toHaveLength(1);
    const numeric = await sourceFile(examples[1]);
    const output = join(dirname(numeric), 'numeric.json');
    expect(
      await run(
        ['blueprint', 'export', '--parameters', '--json', '--output', output, numeric],
        environment,
      ),
    ).toBe(0);
    const document = JSON.parse(await readFile(output, 'utf8'));
    expect(document.blueprint.parameters).toEqual([
      { type: 'number', number: '5', name: 'Amount', variable: 'x' },
      { type: 'number', number: '111', name: 'Limit', formula: 'x * 2', dependent: true },
    ]);
    expect(await run(['blueprint', 'encode', '--json', output])).toBe(0);
    const exchange = JSON.parse(String(log.mock.calls[2]?.[0])).exchange;
    expect(await run(['blueprint', 'decode', '--json', exchange])).toBe(0);
    expect(JSON.parse(String(log.mock.calls[3]?.[0])).document).toEqual(document);
    expect(error).not.toHaveBeenCalled();
  });

  test('native row expansion errors retain their code and source span without a partial file', async () => {
    const { environment } = await parameterHost();
    const condition = Array.from(
      { length: 11 },
      (_, index) => `(input[A] > ${index} || input[A] < ${index + 20})`,
    ).join(' && ');
    const path = await sourceFile(`const A = Signal('virtual', 'signal-A');
const input = new Network(); const output = new Network();
output += Decider({ condition: ${condition}, outputs: [input[A]] });`);
    const output = join(dirname(path), 'too-many-rows.json');
    const { log } = capture();
    expect(
      await run(['blueprint', 'export', '--json', '--output', output, path], environment),
    ).toBe(2);
    expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toMatchObject({
      ok: false,
      error: { code: 'BP1001', span: expect.any(Object) },
    });
    await expect(stat(output)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  test('plain file errors keep the output path on stderr', async () => {
    const path = await sourceFile();
    const output = join(dirname(path), 'sentinel.json');
    await writeFile(output, 'sentinel');
    const { log, error } = capture();
    expect(await run(['blueprint', 'export', '--output', output, path])).toBe(2);
    expect(log).not.toHaveBeenCalled();
    expect(String(error.mock.calls[0]?.[0])).toContain(output);
    expect(String(error.mock.calls[0]?.[0])).toContain('CLIBP1003');
    expect(await readFile(output, 'utf8')).toBe('sentinel');
  });
});

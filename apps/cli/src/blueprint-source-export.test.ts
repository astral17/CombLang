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

  test('exports captured source Math calls through native parameter-template mode', async () => {
    const { environment } = await parameterHost();
    const path = await sourceFile(`const A = Signal('virtual', 'signal-A');
const B = Signal('virtual', 'signal-B');
const C = Signal('virtual', 'signal-C');
const amount = Param.number('Amount', 8, { variable: 'x' });
const output = new Network();
output += Constant({ sections: [{ filters: [
  { signal: A, value: amount },
  { signal: B, value: Math.abs(amount - 20) },
  { signal: C, value: Math.log2(amount) },
] }] });`);
    const { log, error } = capture();
    try {
      expect(await run(['blueprint', 'export', '--parameters', '--json', path], environment)).toBe(
        0,
      );
      const document = JSON.parse(String(log.mock.calls[0]?.[0])).document;
      expect(document.blueprint.parameters).toEqual([
        { type: 'number', number: '8', name: 'Amount', variable: 'x' },
        { type: 'number', number: '12', formula: 'abs((x - 20))', dependent: true },
        { type: 'number', number: '3', formula: 'log2(x)', dependent: true },
      ]);
      expect(
        document.blueprint.entities[0].control_behavior.sections.sections[0].filters.map(
          ({ name, count }: { name: string; count: number }) => ({ name, count }),
        ),
      ).toEqual([
        { name: 'signal-A', count: 8 },
        { name: 'signal-B', count: 12 },
        { name: 'signal-C', count: 3 },
      ]);
      expect(error).not.toHaveBeenCalled();
    } finally {
      vi.restoreAllMocks();
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

  test('exports exact derived Decider thresholds locally and refuses native templates without fallback', async () => {
    const { environment } = await parameterHost();
    const key = '__comblang_cli_decider_threshold_export_runs';
    const globals = globalThis as Record<string, unknown>;
    const previous = globals[key];
    globals[key] = 0;
    const text = `globalThis.${key} = Number(globalThis.${key} ?? 0) + 1;
const A = Signal('virtual', 'signal-A', 'rare');
const amount = Param.number('Amount', 5);
const threshold = amount * 2 - 1;
const input = new Network();
const output = new Network();
input += CC(7 * A);
output += Decider({ condition: input[A] > threshold, outputs: [input[A]] });`;
    try {
      const path = await sourceFile(text);
      const valuesPath = join(dirname(path), 'threshold-values.json');
      const rejectedPath = join(dirname(path), 'native-template.json');
      await writeFile(valuesPath, JSON.stringify([{ id: 0, value: 3 }]));
      const { log, error } = capture();

      expect(await run(['blueprint', 'export', '--json', path], environment)).toBe(0);
      const defaults = JSON.parse(String(log.mock.calls[0]?.[0])).document;
      expect(globals[key]).toBe(1);
      expect(
        await run(['blueprint', 'export', '--json', '--overrides', valuesPath, path], environment),
      ).toBe(0);
      const overridden = JSON.parse(String(log.mock.calls[1]?.[0])).document;
      expect(globals[key]).toBe(2);

      const device = (document: typeof defaults, name: string) =>
        document.blueprint.entities.find((candidate: { name: string }) => candidate.name === name);
      expect(defaults.blueprint.entities.map((item: { name: string }) => item.name)).toEqual([
        'constant-combinator',
        'decider-combinator',
      ]);
      expect(device(defaults, 'constant-combinator').control_behavior).toMatchObject({
        sections: { sections: [{ filters: [{ name: 'signal-A', quality: 'rare', count: 7 }] }] },
      });
      expect(
        device(defaults, 'decider-combinator').control_behavior.decider_conditions,
      ).toMatchObject({
        conditions: [
          {
            first_signal: { name: 'signal-A', quality: 'rare' },
            comparator: '>',
            constant: 9,
          },
        ],
        outputs: [{ signal: { name: 'signal-A', quality: 'rare' }, copy_count_from_input: true }],
      });
      expect(
        device(overridden, 'decider-combinator').control_behavior.decider_conditions.conditions[0],
      ).toMatchObject({
        first_signal: { name: 'signal-A', quality: 'rare' },
        comparator: '>',
        constant: 5,
      });
      expect(overridden.blueprint.entities.map((item: { name: string }) => item.name)).toEqual(
        defaults.blueprint.entities.map((item: { name: string }) => item.name),
      );
      expect(
        overridden.blueprint.entities.map(
          ({
            entity_number,
            position,
            direction,
          }: {
            entity_number: number;
            position: unknown;
            direction: number;
          }) => ({
            entity_number,
            position,
            direction,
          }),
        ),
      ).toEqual(
        defaults.blueprint.entities.map(
          ({
            entity_number,
            position,
            direction,
          }: {
            entity_number: number;
            position: unknown;
            direction: number;
          }) => ({
            entity_number,
            position,
            direction,
          }),
        ),
      );
      expect(overridden.blueprint.wires).toEqual(defaults.blueprint.wires);

      log.mockClear();
      expect(
        await run(
          ['blueprint', 'export', '--parameters', '--json', '--output', rejectedPath, path],
          environment,
        ),
      ).toBe(2);
      const nativeFailure = JSON.parse(String(log.mock.calls[0]?.[0]));
      expect(nativeFailure).toMatchObject({
        ok: false,
        error: {
          code: 'CP1002',
          span: { fileId: expect.any(String), start: expect.any(Number), end: expect.any(Number) },
        },
      });
      expect(nativeFailure).not.toHaveProperty('document');
      await expect(stat(rejectedPath)).rejects.toMatchObject({ code: 'ENOENT' });
      expect(globals[key]).toBe(3);
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

  test('refuses same-section Constant rows that collide after parameter substitution', async () => {
    const { environment } = await parameterHost();
    const path = await sourceFile(`const original = Signal('virtual', 'signal-A');
const channel = Param.signal('Channel', original);
const amount = Param.number('Amount', 5);
const output = new Network();
output += Constant({ sections: [{ filters: [
  { signal: channel, value: amount },
  { signal: original, value: 13 }
] }] });`);
    const outputPath = join(dirname(path), 'unsafe-constant-parameters.json');
    const { log, error } = capture();

    expect(
      await run(
        ['blueprint', 'export', '--parameters', '--json', '--output', outputPath, path],
        environment,
      ),
    ).toBe(2);
    const report = JSON.parse(String(log.mock.calls.at(-1)?.[0]));
    expect(report).toMatchObject({
      ok: false,
      error: {
        code: 'CP1002',
        path: '$.blueprint.entities[0].control_behavior.sections.sections[0].filters[1]',
        span: { start: expect.any(Number), end: expect.any(Number) },
      },
    });
    expect(report.error.message).toMatch(/duplicate native Constant filter/i);
    expect(error.mock.calls).toEqual([]);
    await expect(stat(outputPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  test('exports native Constant Signal parameters through the existing opt-in CLI route', async () => {
    const { environment } = await parameterHost();
    const key = '__comblang_cli_native_signal_runs';
    const globals = globalThis as Record<string, unknown>;
    const previous = globals[key];
    globals[key] = 0;
    try {
      const path = await sourceFile(`globalThis.${key} = Number(globalThis.${key} ?? 0) + 1;
const channel = Param.signal('Channel', Signal('virtual', 'signal-A'));
const amount = Param.number('Amount', 5, { variable: 'x' });
const plate = Param.signal('Plate', Signal('iron-plate'));
const water = Param.signal('Water', Signal('fluid', 'water', 'normal'));
const output = new Network();
const input = new Network();
const A = Signal('virtual', 'signal-A');
output += Constant({ sections: [{ filters: [
  { signal: channel, value: amount * 2 },
  { signal: Signal('virtual', 'signal-C'), value: 13 },
  { signal: plate, value: 7 },
  { signal: Signal('copper-plate'), value: 8 },
  { signal: water, value: 11 },
  { signal: Signal('fluid', 'crude-oil'), value: 12 },
] }] });
output += Decider({ condition: input[A] > 0, outputs: [input[A]], elseOutputs: [2 * A] });`);
      const nativePath = join(dirname(path), 'constant-signal-parameters.json');
      const concretePath = join(dirname(path), 'constant-signal-concrete.json');
      const overridePath = join(dirname(path), 'constant-signal-overrides.json');
      await writeFile(
        overridePath,
        JSON.stringify([
          { id: 0, value: { type: 'virtual', name: 'signal-B' } },
          { id: 1, value: 9 },
          { id: 2, value: { type: 'item', name: 'steel-plate' } },
          { id: 3, value: { type: 'fluid', name: 'petroleum-gas' } },
        ]),
      );
      const { log, error } = capture();
      expect(
        await run(
          ['blueprint', 'export', '--parameters', '--json', '--output', nativePath, path],
          environment,
        ),
      ).toBe(0);
      expect(globals[key]).toBe(1);
      const native = JSON.parse(await readFile(nativePath, 'utf8'));
      expect(native.blueprint.parameters).toEqual([
        {
          type: 'id',
          id: 'parameter-0',
          name: 'Channel',
          'quality-condition': { quality: 'normal', comparator: '=' },
        },
        { type: 'number', number: '5', name: 'Amount', variable: 'x' },
        {
          type: 'id',
          id: 'parameter-1',
          name: 'Plate',
          'quality-condition': { quality: 'normal', comparator: '=' },
        },
        {
          type: 'id',
          id: 'parameter-2',
          name: 'Water',
          'quality-condition': { quality: 'normal', comparator: '=' },
        },
        { type: 'number', number: '10', formula: '(x * 2)', dependent: true },
      ]);
      expect(native.blueprint.entities[0].control_behavior.sections.sections[0].filters).toEqual([
        { index: 1, name: 'parameter-0', quality: 'normal', comparator: '=', count: 10 },
        {
          index: 2,
          type: 'virtual',
          name: 'signal-C',
          quality: 'normal',
          comparator: '=',
          count: 13,
        },
        { index: 3, name: 'parameter-1', quality: 'normal', comparator: '=', count: 7 },
        { index: 4, name: 'copper-plate', quality: 'normal', comparator: '=', count: 8 },
        { index: 5, name: 'parameter-2', quality: 'normal', comparator: '=', count: 11 },
        {
          index: 6,
          type: 'fluid',
          name: 'crude-oil',
          quality: 'normal',
          comparator: '=',
          count: 12,
        },
      ]);
      expect(native.blueprint.entities[1].control_behavior.decider_conditions).toMatchObject({
        conditions: [{ first_signal: { name: 'parameter-0' }, constant: 0 }],
        outputs: [{ signal: { name: 'parameter-0' }, copy_count_from_input: true }],
        else_outputs: [{ signal: { name: 'parameter-0' }, constant: 2 }],
      });

      expect(
        await run(['blueprint', 'export', '--json', '--output', concretePath, path], environment),
      ).toBe(0);
      expect(globals[key]).toBe(2);
      const concrete = JSON.parse(await readFile(concretePath, 'utf8'));
      expect(concrete.blueprint).not.toHaveProperty('parameters');
      expect(concrete.blueprint.entities[0].control_behavior.sections.sections[0].filters).toEqual([
        {
          index: 1,
          type: 'virtual',
          name: 'signal-A',
          quality: 'normal',
          comparator: '=',
          count: 10,
        },
        {
          index: 2,
          type: 'virtual',
          name: 'signal-C',
          quality: 'normal',
          comparator: '=',
          count: 13,
        },
        { index: 3, name: 'iron-plate', quality: 'normal', comparator: '=', count: 7 },
        { index: 4, name: 'copper-plate', quality: 'normal', comparator: '=', count: 8 },
        {
          index: 5,
          type: 'fluid',
          name: 'water',
          quality: 'normal',
          comparator: '=',
          count: 11,
        },
        {
          index: 6,
          type: 'fluid',
          name: 'crude-oil',
          quality: 'normal',
          comparator: '=',
          count: 12,
        },
      ]);
      expect(concrete.blueprint.entities[1].control_behavior.decider_conditions).toMatchObject({
        conditions: [{ first_signal: { name: 'signal-A' }, constant: 0 }],
        outputs: [{ signal: { name: 'signal-A' }, copy_count_from_input: true }],
        else_outputs: [{ signal: { name: 'signal-A' }, constant: 2 }],
      });

      expect(
        await run(
          ['blueprint', 'export', '--json', '--overrides', overridePath, path],
          environment,
        ),
      ).toBe(0);
      expect(globals[key]).toBe(3);
      const bound = JSON.parse(String(log.mock.calls.at(-1)?.[0])).document;
      expect(bound.blueprint).not.toHaveProperty('parameters');
      expect(
        bound.blueprint.entities.map(
          (entity: { entity_number: number; position: unknown; direction: number }) => ({
            entity_number: entity.entity_number,
            position: entity.position,
            direction: entity.direction,
          }),
        ),
      ).toEqual(
        concrete.blueprint.entities.map(
          (entity: { entity_number: number; position: unknown; direction: number }) => ({
            entity_number: entity.entity_number,
            position: entity.position,
            direction: entity.direction,
          }),
        ),
      );
      expect(bound.blueprint.wires).toEqual(concrete.blueprint.wires);
      expect(bound.blueprint.entities[0].control_behavior.sections.sections[0].filters).toEqual([
        {
          index: 1,
          type: 'virtual',
          name: 'signal-B',
          quality: 'normal',
          comparator: '=',
          count: 18,
        },
        {
          index: 2,
          type: 'virtual',
          name: 'signal-C',
          quality: 'normal',
          comparator: '=',
          count: 13,
        },
        { index: 3, name: 'steel-plate', quality: 'normal', comparator: '=', count: 7 },
        { index: 4, name: 'copper-plate', quality: 'normal', comparator: '=', count: 8 },
        {
          index: 5,
          type: 'fluid',
          name: 'petroleum-gas',
          quality: 'normal',
          comparator: '=',
          count: 11,
        },
        {
          index: 6,
          type: 'fluid',
          name: 'crude-oil',
          quality: 'normal',
          comparator: '=',
          count: 12,
        },
      ]);
      expect(bound.blueprint.entities[1].control_behavior.decider_conditions).toMatchObject({
        conditions: [{ first_signal: { name: 'signal-A' }, constant: 0 }],
        outputs: [{ signal: { name: 'signal-A' }, copy_count_from_input: true }],
        else_outputs: [{ signal: { name: 'signal-A' }, constant: 2 }],
      });

      log.mockClear();
      expect(await run(['blueprint', 'export', '--json', path], environment)).toBe(0);
      expect(globals[key]).toBe(4);
      const reset = JSON.parse(String(log.mock.calls[0]?.[0])).document;
      expect(reset).toEqual(concrete);
      expect(error).not.toHaveBeenCalled();
    } finally {
      if (previous === undefined) delete globals[key];
      else globals[key] = previous;
    }
  });

  test('exports an output-only Arithmetic Signal parameter with a numeric formula operand', async () => {
    const { environment } = await parameterHost();
    const path =
      await sourceFile(`const result = Param.signal('Result', Signal('virtual', 'signal-B'));
const amount = Param.number('Amount', 5, { variable: 'x' });
const output = new Network();
output += Arithmetic({ left: 2, operation: 'add', right: amount * 2, output: result });`);
    const { log, error } = capture();
    expect(await run(['blueprint', 'export', '--parameters', '--json', path], environment)).toBe(0);
    expect(error.mock.calls).toEqual([]);
    const resultEnvelope = JSON.parse(String(log.mock.calls[0]?.[0]));
    expect(resultEnvelope.ok).toBe(true);
    expect(resultEnvelope.document.blueprint.parameters).toEqual([
      {
        type: 'id',
        id: 'parameter-0',
        name: 'Result',
        'quality-condition': { quality: 'normal', comparator: '=' },
      },
      { type: 'number', number: '5', name: 'Amount', variable: 'x' },
      { type: 'number', number: '10', formula: '(x * 2)', dependent: true },
    ]);
    const conditions =
      resultEnvelope.document.blueprint.entities[0].control_behavior.arithmetic_conditions;
    expect(conditions).toMatchObject({
      first_constant: 2,
      second_constant: 10,
      output_signal: { name: 'parameter-0' },
    });
    expect(conditions.output_signal).not.toHaveProperty('type');
  });

  test('exports default-free Constant Signal metadata and requires concrete values outside metadata mode', async () => {
    const { environment } = await parameterHost();
    const path = await sourceFile(`const channel = Param.signal('Channel');
const output = new Network();
output += Constant({ sections: [{ filters: [{ signal: channel, value: 5 }] }] });`);
    const overridesPath = join(dirname(path), 'default-free-signal-values.json');
    await writeFile(
      overridesPath,
      JSON.stringify([{ id: 0, value: { type: 'item', name: 'iron-plate', quality: 'rare' } }]),
    );
    const { log, error } = capture();

    expect(await run(['blueprint', 'export', '--parameters', '--json', path], environment)).toBe(0);
    const nativeDocument = JSON.parse(String(log.mock.calls[0]?.[0])).document.blueprint;
    expect(nativeDocument.parameters).toEqual([
      {
        type: 'id',
        id: 'parameter-0',
        name: 'Channel',
        'quality-condition': { quality: 'normal', comparator: '=' },
      },
    ]);
    expect(nativeDocument.entities[0].control_behavior.sections.sections[0].filters).toMatchObject([
      { name: 'parameter-0', count: 5 },
    ]);

    log.mockClear();
    expect(await run(['blueprint', 'export', '--json', path], environment)).toBe(2);
    expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toMatchObject({
      ok: false,
      error: { code: 'CLIBP1000', message: expect.stringContaining('explicit --overrides') },
    });

    log.mockClear();
    expect(
      await run(['blueprint', 'export', '--json', '--overrides', overridesPath, path], environment),
    ).toBe(0);
    const concreteDocument = JSON.parse(String(log.mock.calls[0]?.[0])).document.blueprint;
    expect(concreteDocument).not.toHaveProperty('parameters');
    expect(
      concreteDocument.entities[0].control_behavior.sections.sections[0].filters,
    ).toMatchObject([{ name: 'iron-plate', quality: 'rare', count: 5 }]);
    expect(error).not.toHaveBeenCalled();
  });

  test('lists, exports and runs automatic numeric defaults with a required Constant Signal', async () => {
    const { environment } = await parameterHost();
    const path = await sourceFile(`const amount = Param.number('Amount');
const channel = Param.signal('Channel');
const output = new Network();
output += Constant({ sections: [{ filters: [{ signal: channel, value: amount }] }] });`);
    const casesPath = join(dirname(path), 'automatic-number-signal.test.ts');
    await writeFile(
      casesPath,
      `test('explicit required Signal uses automatic count', ({ network, expectSignal, tick }) => {
  tick();
  expectSignal(network('output'), Signal('item', 'iron-plate', 'uncommon')).toBe(2);
}, { parameters: [{ id: 1, value: Signal('item', 'iron-plate', 'uncommon') }] });
test('empty snapshot cannot satisfy the Signal declaration', () => {
  throw new Error('missing-binding callback must not run');
}, { parameters: [] });
test('valid case follows a missing binding', ({ network, expectSignal, tick }) => {
  tick();
  expectSignal(network('output'), Signal('virtual', 'signal-B', 'rare')).toBe(2);
}, { parameters: [{ id: 1, value: Signal('virtual', 'signal-B', 'rare') }] });`,
    );
    const { log, error } = capture();

    expect(await run(['parameters', 'list', '--json', path], environment)).toBe(0);
    const listing = JSON.parse(String(log.mock.calls[0]?.[0]));
    expect(listing.parameters).toEqual([
      expect.objectContaining({ id: 0, kind: 'number', label: 'Amount', defaultValue: 2 }),
      expect.objectContaining({ id: 1, kind: 'signal', label: 'Channel' }),
    ]);
    expect(listing.parameters[1]).not.toHaveProperty('defaultValue');

    log.mockClear();
    expect(await run(['blueprint', 'export', '--parameters', '--json', path], environment)).toBe(0);
    const native = JSON.parse(String(log.mock.calls[0]?.[0])).document.blueprint;
    expect(native.parameters).toEqual([
      { type: 'number', number: '2', name: 'Amount' },
      {
        type: 'id',
        id: 'parameter-0',
        name: 'Channel',
        'quality-condition': { quality: 'normal', comparator: '=' },
      },
    ]);
    expect(native.entities[0].control_behavior.sections.sections[0].filters).toMatchObject([
      { name: 'parameter-0', count: 2 },
    ]);

    log.mockClear();
    expect(await run(['test', '--json', path, casesPath], environment)).toBe(1);
    const report = JSON.parse(String(log.mock.calls[0]?.[0]));
    expect(report.tests).toMatchObject({
      passed: 2,
      failed: 1,
      results: [{ status: 'passed' }, { status: 'failed', code: 'CP1002' }, { status: 'passed' }],
    });
    expect(String(log.mock.calls[0]?.[0])).not.toContain('missing-binding callback must not run');
    expect(error.mock.calls).toEqual([]);
  });

  test('exports Selector Signal index and count-output parameters through the CLI', async () => {
    const { environment } = await parameterHost();
    const path =
      await sourceFile(`const index = Param.signal('Index', Signal('virtual', 'signal-index'));
const countOutput = Param.signal('Count output', Signal('fluid', 'water', 'normal'));
const input = new Network();
const selectOutput = new Network();
const countNetwork = new Network();
selectOutput += Selector({ input, operation: 'select', index });
countNetwork += Selector({ input, operation: 'count', output: countOutput });`);
    const { log, error } = capture();
    expect(await run(['blueprint', 'export', '--parameters', '--json', path], environment)).toBe(0);
    expect(error.mock.calls).toEqual([]);
    const result = JSON.parse(String(log.mock.calls[0]?.[0]));
    expect(result.ok).toBe(true);
    expect(result.document.blueprint.parameters).toEqual([
      {
        type: 'id',
        id: 'parameter-0',
        name: 'Index',
        'quality-condition': { quality: 'normal', comparator: '=' },
      },
      {
        type: 'id',
        id: 'parameter-1',
        name: 'Count output',
        'quality-condition': { quality: 'normal', comparator: '=' },
      },
    ]);
    const [selectEntity, countEntity] = result.document.blueprint.entities;
    expect(selectEntity.control_behavior).toMatchObject({
      operation: 'select',
      index_signal: { name: 'parameter-0' },
    });
    expect(selectEntity.control_behavior.index_signal).not.toHaveProperty('type');
    expect(countEntity.control_behavior).toMatchObject({
      operation: 'count',
      count_signal: { name: 'parameter-1', quality: 'normal' },
    });
    expect(countEntity.control_behavior.count_signal).not.toHaveProperty('type');

    log.mockClear();
    expect(await run(['blueprint', 'export', '--json', path], environment)).toBe(0);
    const concrete = JSON.parse(String(log.mock.calls[0]?.[0])).document.blueprint;
    expect(concrete).not.toHaveProperty('parameters');
    expect(
      concrete.entities.map(
        (entity: { entity_number: number; control_behavior: { operation: string } }) => ({
          entity_number: entity.entity_number,
          operation: entity.control_behavior.operation,
        }),
      ),
    ).toEqual([
      { entity_number: selectEntity.entity_number, operation: 'select' },
      { entity_number: countEntity.entity_number, operation: 'count' },
    ]);
    expect(concrete.wires).toEqual(result.document.blueprint.wires);
    expect(concrete.entities[0]!.control_behavior.index_signal).toEqual({
      type: 'virtual',
      name: 'signal-index',
    });
    expect(concrete.entities[1]!.control_behavior.count_signal).toEqual({
      type: 'fluid',
      name: 'water',
      quality: 'normal',
    });
  });

  test('exports default-free Selector index and count-output parameters through the CLI', async () => {
    const { environment } = await parameterHost();
    const path = await sourceFile(`const index = Param.signal('Index');
const countOutput = Param.signal('Count output');
const input = new Network();
const selectOutput = new Network();
const countNetwork = new Network();
selectOutput += Selector({ input, operation: 'select', index });
countNetwork += Selector({ input, operation: 'count', output: countOutput });`);
    const { log, error } = capture();
    expect(await run(['blueprint', 'export', '--parameters', '--json', path], environment)).toBe(0);
    expect(error.mock.calls).toEqual([]);
    const result = JSON.parse(String(log.mock.calls[0]?.[0]));
    expect(result.ok).toBe(true);
    expect(result.document.blueprint.parameters).toEqual([
      {
        type: 'id',
        id: 'parameter-0',
        name: 'Index',
        'quality-condition': { quality: 'normal', comparator: '=' },
      },
      {
        type: 'id',
        id: 'parameter-1',
        name: 'Count output',
        'quality-condition': { quality: 'normal', comparator: '=' },
      },
    ]);
    const [selectEntity, countEntity] = result.document.blueprint.entities;
    expect(selectEntity.control_behavior).toMatchObject({
      operation: 'select',
      index_signal: { type: 'virtual', name: 'parameter-0' },
    });
    expect(countEntity.control_behavior).toMatchObject({
      operation: 'count',
      count_signal: { type: 'virtual', name: 'parameter-1' },
    });

    log.mockClear();
    expect(await run(['blueprint', 'export', '--json', path], environment)).toBe(2);
    expect(JSON.parse(String(log.mock.calls[0]?.[0])).error).toMatchObject({
      code: 'CLIBP1000',
      message: expect.stringContaining('explicit --overrides'),
    });
    expect(error.mock.calls).toEqual([]);
  });

  test('exports and binds fractional, divided, and powered Selector formulas without publishing failures', async () => {
    const { environment } = await parameterHost();
    const path = await sourceFile(`const amount = Param.number('Amount', 10, { variable: 'x' });
const input = new Network();
const directOutput = new Network();
const fractionalOutput = new Network();
const formulaOutput = new Network();
const powerOutput = new Network();
const largeOutput = new Network();
directOutput += Selector({ input, operation: 'select', index: amount });
fractionalOutput += Selector({ input, operation: 'select', index: amount * 0.5 + 1 });
formulaOutput += Selector({ input, operation: 'select', index: amount / 2 + 3 });
powerOutput += Selector({ input, operation: 'select', index: amount ** 2 });
largeOutput += Selector({ input, operation: 'select', index: (amount + 2147483648) - 2147483647 });`);
    const nativePath = join(dirname(path), 'selector-formula-native.json');
    const overridesPath = join(dirname(path), 'selector-formula-overrides.json');
    await writeFile(overridesPath, JSON.stringify([{ id: 0, value: 14 }]));
    const { log, error } = capture();

    expect(
      await run(
        ['blueprint', 'export', '--parameters', '--json', '--output', nativePath, path],
        environment,
      ),
    ).toBe(0);
    const native = JSON.parse(await readFile(nativePath, 'utf8'));
    expect(native.blueprint.parameters).toEqual([
      { type: 'number', number: '10', name: 'Amount', variable: 'x' },
      { type: 'number', number: '6', formula: '((x * 0.5) + 1)', dependent: true },
      { type: 'number', number: '8', formula: '((x / 2) + 3)', dependent: true },
      { type: 'number', number: '100', formula: '((x) ^ (2))', dependent: true },
      {
        type: 'number',
        number: '11',
        formula: '((x + 2147483648) - 2147483647)',
        dependent: true,
      },
    ]);
    expect(
      native.blueprint.entities.map(
        ({ control_behavior }: { control_behavior: { index_constant?: number } }) =>
          control_behavior.index_constant,
      ),
    ).toEqual([10, 6, 8, 100, 11]);

    expect(
      await run(['blueprint', 'export', '--json', '--overrides', overridesPath, path], environment),
    ).toBe(0);
    const concrete = JSON.parse(String(log.mock.calls.at(-1)?.[0])).document;
    expect(concrete.blueprint).not.toHaveProperty('parameters');
    expect(
      concrete.blueprint.entities.map(
        ({ control_behavior }: { control_behavior: { index_constant?: number } }) =>
          control_behavior.index_constant,
      ),
    ).toEqual([14, 8, 10, 196, 15]);

    await writeFile(overridesPath, JSON.stringify([{ id: 0, value: 11 }]));
    const failedOutput = join(dirname(path), 'selector-formula-fractional.json');
    expect(
      await run(
        [
          'blueprint',
          'export',
          '--json',
          '--overrides',
          overridesPath,
          '--output',
          failedOutput,
          path,
        ],
        environment,
      ),
    ).toBe(2);
    expect(JSON.parse(String(log.mock.calls.at(-1)?.[0]))).toMatchObject({
      ok: false,
      error: { code: 'CP1000', span: expect.any(Object) },
    });
    await expect(stat(failedOutput)).rejects.toMatchObject({ code: 'ENOENT' });

    const formulaOnlyPath = await sourceFile(
      `const amount = Param.number('Amount', 5, { variable: 'x' });
const input = new Network();
const output = new Network();
output += Selector({ input, operation: 'select', index: amount + 1 });`,
      'selector-formula-only.factorio.ts',
    );
    const formulaOnlyOutput = join(dirname(formulaOnlyPath), 'selector-formula-only-native.json');
    expect(
      await run(
        [
          'blueprint',
          'export',
          '--parameters',
          '--json',
          '--output',
          formulaOnlyOutput,
          formulaOnlyPath,
        ],
        environment,
      ),
    ).toBe(0);
    const formulaOnly = JSON.parse(await readFile(formulaOnlyOutput, 'utf8'));
    expect(formulaOnly.blueprint.parameters).toEqual([
      { type: 'number', number: '5', name: 'Amount', variable: 'x' },
      { type: 'number', number: '6', formula: '(x + 1)', dependent: true },
    ]);
    expect(formulaOnly.blueprint.entities).toHaveLength(1);
    expect(formulaOnly.blueprint.entities[0].control_behavior).toMatchObject({
      operation: 'select',
      index_constant: 6,
    });

    const formulaOnlyConcreteOutput = join(
      dirname(formulaOnlyPath),
      'selector-formula-only-concrete.json',
    );
    expect(
      await run(
        [
          'blueprint',
          'export',
          '--json',
          '--overrides',
          overridesPath,
          '--output',
          formulaOnlyConcreteOutput,
          formulaOnlyPath,
        ],
        environment,
      ),
    ).toBe(0);
    const formulaOnlyConcrete = JSON.parse(await readFile(formulaOnlyConcreteOutput, 'utf8'));
    expect(formulaOnlyConcrete.blueprint).not.toHaveProperty('parameters');
    expect(formulaOnlyConcrete.blueprint.entities[0].control_behavior).toMatchObject({
      operation: 'select',
      index_constant: 12,
    });
    expect(error).not.toHaveBeenCalled();
  });

  test('exports typed Constant, Arithmetic and final fluent Decider formulas and keeps failures atomic', async () => {
    const { environment } = await parameterHost();
    const formulaSource = `const A = Signal('virtual', 'signal-A');
const B = Signal('virtual', 'signal-B');
const amount = Param.number('Amount', 5, { variable: 'x' });
const input = new Network(), output = new Network();
output += Constant({ sections: [{ filters: [
  { signal: A, value: amount },
  { signal: B, value: amount * 2 },
] }] });
output += Arithmetic({ left: amount, operation: 'add', right: (amount * 2 + 3) * 5, output: Signal('virtual', 'signal-C') });
const gate = when(input[A] > amount && input[A] < amount * 3).at(4, 5, 2).then(input[A]);
output += gate;
gate.else(2 * B);
gate.then(3 * B);
gate.else(4 * B);`;
    const path = await sourceFile(formulaSource);
    const nativePath = join(dirname(path), 'typed-formula-native.json');
    const concretePath = join(dirname(path), 'typed-formula-concrete.json');
    const overridesPath = join(dirname(path), 'typed-formula-overrides.json');
    await writeFile(overridesPath, JSON.stringify([{ id: 0, value: 9 }]));
    const { log, error } = capture();
    expect(
      await run(
        ['blueprint', 'export', '--parameters', '--json', '--output', nativePath, path],
        environment,
      ),
    ).toBe(0);
    const native = JSON.parse(await readFile(nativePath, 'utf8'));
    expect(native.blueprint.parameters).toEqual([
      { type: 'number', number: '5', name: 'Amount', variable: 'x' },
      { type: 'number', number: '15', formula: '(x * 3)', dependent: true },
      { type: 'number', number: '65', formula: '(((x * 2) + 3) * 5)', dependent: true },
      { type: 'number', number: '10', formula: '(x * 2)', dependent: true },
    ]);
    expect(native.blueprint.entities[0].control_behavior.sections.sections[0].filters).toEqual([
      {
        index: 1,
        type: 'virtual',
        name: 'signal-A',
        quality: 'normal',
        comparator: '=',
        count: 5,
      },
      {
        index: 2,
        type: 'virtual',
        name: 'signal-B',
        quality: 'normal',
        comparator: '=',
        count: 10,
      },
    ]);
    expect(native.blueprint.entities[1].control_behavior.arithmetic_conditions).toMatchObject({
      first_constant: 5,
      second_constant: 65,
    });
    expect(native.blueprint.entities[2]).toMatchObject({
      position: { x: 4, y: 5 },
      direction: 2,
      control_behavior: {
        decider_conditions: {
          conditions: [{ constant: 5 }, { constant: 15 }],
          outputs: [
            { copy_count_from_input: true, signal: { name: 'signal-A' } },
            { constant: 3, signal: { name: 'signal-B' } },
          ],
          else_outputs: [
            { constant: 2, signal: { name: 'signal-B' } },
            { constant: 4, signal: { name: 'signal-B' } },
          ],
        },
      },
    });
    expect(
      await run(['blueprint', 'export', '--json', '--output', concretePath, path], environment),
    ).toBe(0);
    const concrete = JSON.parse(await readFile(concretePath, 'utf8'));
    expect(concrete.blueprint).not.toHaveProperty('parameters');
    expect(concrete.blueprint.entities[0].control_behavior.sections.sections[0].filters).toEqual([
      { index: 1, type: 'virtual', name: 'signal-A', quality: 'normal', comparator: '=', count: 5 },
      {
        index: 2,
        type: 'virtual',
        name: 'signal-B',
        quality: 'normal',
        comparator: '=',
        count: 10,
      },
    ]);
    expect(concrete.blueprint.entities[1].control_behavior.arithmetic_conditions).toMatchObject({
      first_constant: 5,
      second_constant: 65,
    });
    expect(
      concrete.blueprint.entities[2].control_behavior.decider_conditions.conditions,
    ).toMatchObject([{ constant: 5 }, { constant: 15 }]);

    expect(
      await run(['blueprint', 'export', '--json', '--overrides', overridesPath, path], environment),
    ).toBe(0);
    const overridden = JSON.parse(String(log.mock.calls.at(-1)?.[0])).document;
    expect(overridden.blueprint).not.toHaveProperty('parameters');
    expect(overridden.blueprint.entities[0].control_behavior.sections.sections[0].filters).toEqual([
      expect.objectContaining({ count: 9 }),
      expect.objectContaining({ count: 18 }),
    ]);
    expect(overridden.blueprint.entities[1].control_behavior.arithmetic_conditions).toMatchObject({
      first_constant: 9,
      second_constant: 105,
    });
    expect(
      overridden.blueprint.entities[2].control_behavior.decider_conditions.conditions,
    ).toMatchObject([{ constant: 9 }, { constant: 27 }]);

    const rejectedSource = formulaSource
      .replace('{ signal: B, value: amount * 2 }', '{ signal: B, value: amount + 5 }')
      .replace(
        'input[A] > amount && input[A] < amount * 3',
        'input[A] > amount && input[A] < amount * 2',
      );
    const rejectedPath = await sourceFile(rejectedSource, 'unsupported-formula.factorio.ts');
    const rejectedOutput = join(dirname(rejectedPath), 'must-not-exist.json');
    expect(
      await run(
        ['blueprint', 'export', '--parameters', '--json', '--output', rejectedOutput, rejectedPath],
        environment,
      ),
    ).toBe(2);
    const failure = JSON.parse(String(log.mock.calls.at(-1)?.[0]));
    expect(failure).toMatchObject({
      ok: false,
      error: {
        code: 'CP1002',
        path: '$.constantTemplates[0].sections[0].filters[1].value',
        span: { start: expect.any(Number), end: expect.any(Number) },
      },
    });
    expect(rejectedSource.slice(failure.error.span.start, failure.error.span.end)).toBe(
      "Param.number('Amount', 5, { variable: 'x' })",
    );
    expect(failure).not.toHaveProperty('document');
    await expect(stat(rejectedOutput)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(error).not.toHaveBeenCalled();
  });

  test.each([
    [
      "const amount = Param.number('Scale', 1);",
      'Constant({ sections: [{ multiplier: amount, filters: [{ signal: A, value: 3 }] }] })',
      '$.constantTemplates[0].sections[0].multiplier',
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
      const appendedDevice = device.startsWith('const input =') ? device : `output += ${device};`;
      const text = `const A = Signal('virtual', 'signal-A');\n${declaration}\nconst output = new Network();\n${appendedDevice}`;
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
        multiplier
          ? 'Constant('
          : semanticPath.startsWith('$.deciderTemplates')
            ? 'Decider('
            : 'Param.',
      );
      expect(report).not.toHaveProperty('document');
      await expect(stat(output)).rejects.toMatchObject({ code: 'ENOENT' });
      expect(await run(['blueprint', 'export', '--parameters', path], environment)).toBe(2);
      expect(log).toHaveBeenCalledTimes(1);
      const sourceLine = text.slice(0, report.error.span.start).split(/\r?\n/).length;
      expect(String(error.mock.calls.at(-1)?.[0])).toContain(`${path}:${sourceLine}:`);
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

  test('Selector formula without an explicit variable is a located atomic native-export failure', async () => {
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
      expect(report.error).toMatchObject({
        code: 'CP1002',
        path: '$.parameters[0].metadata.variable',
      });
      expect(report.error.span).toBeDefined();
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

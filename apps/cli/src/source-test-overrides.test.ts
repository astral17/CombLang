import { mkdtemp, mkdir, open, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  createTrustedEntityReplayContext,
  generateBlueprintJson,
  syntheticZeroPortEntityProfile,
} from '@comblang/compiler';
import type { EntityProfile } from '@comblang/compiler/entity';
import { loadPrototypeDatabase, syntheticPrototypeDatabase } from '@comblang/prototypes';
import * as sourceApi from '@comblang/runtime/source-compilation';
import * as bindingApi from '@comblang/runtime/source-parameter-binding';
import * as runtime from '@comblang/runtime';
import { run, type CliCompilationEnvironment } from './main.js';

const directories: string[] = [];
const sourceCounter = '__comblang_cli_test_override_source_runs';
const testCounter = '__comblang_cli_test_override_registration_runs';
const globals = globalThis as Record<string, unknown>;
const counted = `globalThis.${sourceCounter} += 1;\n`;
const registered = `globalThis.${testCounter} += 1;\n`;
const source = `${counted}const amount = Param.number('Amount', 5, { formula: 'opaque not evaluated', dependent: true });
const channel = Param.signal('Channel', Signal('virtual', 'signal-A'));
const scale = Param.number('Scale', 1);
const input = new Network();
const output = new Network();
const outputAlias = output;
input += Constant({ sections: [{ multiplier: scale, filters: [{ signal: channel, value: amount }] }] });
output += Arithmetic({ left: input[Signal('virtual', 'signal-A')], operation: 'add', right: amount, output: channel });`;
const chosen = [
  { id: 0, value: 8 },
  { id: 1, value: { type: 'virtual', name: 'signal-C', quality: 'rare' } },
  { id: 2, value: 1 },
];

// Private synthetic authority fixture: exercises replay, not native Factorio behavior.
async function parameterHost() {
  const families = ['constant-combinator', 'arithmetic-combinator', 'structural'] as const;
  const database = syntheticPrototypeDatabase() as { entities: Array<Record<string, unknown>> };
  database.entities.push(
    ...families.map((family) => ({
      key: `entity:${family}`,
      name: family,
      type: family === 'structural' ? 'container' : family,
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
      profileId: `profile:cli-test-${index}` as EntityProfile['ref']['profileId'],
    },
    prototypeType: family === 'structural' ? 'container' : family,
  }));
  const trustedEntityReplayContext = createTrustedEntityReplayContext({
    database: identity,
    source: 'synthetic',
    evidenceIdentity: 'cli-test-parameter-evidence',
    policyIdentity: 'cli-test-parameter-policy',
    profiles,
  });
  return {
    database,
    environment: { prototypes, trustedEntityReplayContext } satisfies CliCompilationEnvironment,
  };
}

function capture() {
  vi.stubGlobal(sourceCounter, 0);
  vi.stubGlobal(testCounter, 0);
  const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  return { log, error, warn, report: () => JSON.parse(String(log.mock.calls.at(-1)?.[0])) };
}

async function files(
  text = source,
  tests = `${registered}test('registered', () => {});`,
  values: unknown = chosen,
) {
  const directory = await mkdtemp(join(tmpdir(), 'comblang-test-overrides-'));
  directories.push(directory);
  const sourcePath = join(directory, 'source.factorio.ts');
  const testPath = join(directory, 'circuit.test.js');
  const valuesPath = join(directory, 'values.json');
  await Promise.all([
    writeFile(sourcePath, text),
    writeFile(testPath, tests),
    writeFile(valuesPath, JSON.stringify(values)),
  ]);
  return { directory, sourcePath, testPath, valuesPath };
}

function assertions(
  amount: number,
  channel: { type: string; name: string; quality?: string },
  inputCount: number,
) {
  return `${registered}const S = Signal(${JSON.stringify(channel.type)}, ${JSON.stringify(channel.name)}, ${JSON.stringify(channel.quality)});
test('fresh concrete values', ({ network, session, tick, expectSignal, execution }) => {
  const input = network('input'); const output = network('outputAlias');
  expectSignal(input, S).toBe(0); expectSignal(output, S).toBe(0);
  session.trace(output);
  tick(); expectSignal(input, S).toBe(${inputCount}); expectSignal(output, S).toBe(${amount});
  tick(); expectSignal(output, S).toBe(${channel.name === 'signal-A' && channel.quality === undefined ? inputCount + amount : amount});
  if (${JSON.stringify(channel.name)} !== 'signal-A') {
    expectSignal(output, Signal('virtual', 'signal-A')).toBe(0);
    expectSignal(output, Signal('virtual', ${JSON.stringify(channel.name)})).toBe(0);
  }
  expectSignal(output, Signal('virtual', 'signal-B')).toBe(0);
  if (execution.debug.root.network('output').id !== output.id) throw new Error('debug alias lost');
});`;
}

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

describe('CLI test concrete override ingress', () => {
  test.each([
    ['missing', undefined, 'CLIBP1002'],
    ['utf8', new Uint8Array([0xff]), 'CLIBP1005'],
    ['json', '{', 'CLI1001'],
    ['overflow', '[{"id":0,"value":1e400}]', 'CLI1001'],
    ['oversize', 'sparse', 'CLIBP1002'],
  ] as const)(
    'reports %s before project/provider/source/test work',
    async (kind, content, code) => {
      const f = await files();
      const c = capture();
      const valuesPath = join(f.directory, `${kind}.json`);
      if (kind === 'oversize') {
        const handle = await open(valuesPath, 'w');
        try {
          await handle.truncate(1_048_577);
        } finally {
          await handle.close();
        }
      } else if (content !== undefined) await writeFile(valuesPath, content);
      expect(
        await run([
          'test',
          '--json',
          '--overrides',
          valuesPath,
          '--project',
          join(f.directory, 'missing-project.json'),
          f.sourcePath,
          f.testPath,
        ]),
      ).toBe(2);
      const report = c.report();
      expect(report).toMatchObject({ diagnostics: [{ code, severity: 'error' }] });
      expect(report).not.toHaveProperty('tests');
      expect(report).not.toHaveProperty('ok');
      if (code.startsWith('CLIBP')) expect(report.diagnostics[0].path).toBe(valuesPath);
      else expect(report.diagnostics[0].message).toContain(valuesPath);
      expect(globals[sourceCounter]).toBe(0);
      expect(globals[testCounter]).toBe(0);
    },
  );

  test.each(
    [
      ['--parameters', 'a', 'b'],
      ['--output', 'out', 'a', 'b'],
      ['a'],
      ['a', 'b', 'c'],
      ['--project', 'missing-project.json', 'a'],
      ['--project', 'p', '--prototypes', 'db'],
    ].map((args) => ({ args })),
  )('rejects malformed arguments before reading missing overrides: %j', async ({ args }) => {
    const c = capture();
    expect(await run(['test', '--json', '--overrides', 'missing-values.json', ...args])).toBe(2);
    expect(c.report().diagnostics[0]).toMatchObject({ code: 'CLI1001' });
    expect(c.report().diagnostics[0].message).not.toContain('Unable to open');
    expect(globals[sourceCounter]).toBe(0);
    expect(globals[testCounter]).toBe(0);
  });

  test('check rejects overrides and provider pin failure remains ingress exit 2', async () => {
    const f = await files();
    const c = capture();
    expect(await run(['check', '--json', '--overrides', f.valuesPath, f.sourcePath])).toBe(2);
    expect(c.report().diagnostics[0].code).toBe('CLI1001');
    expect(
      await run([
        'test',
        '--json',
        '--overrides',
        f.valuesPath,
        '--prototype-identity',
        'missing',
        f.sourcePath,
        f.testPath,
      ]),
    ).toBe(2);
    expect(c.report().diagnostics[0].code).toBe('CLI1003');
    expect(globals[sourceCounter]).toBe(0);
    expect(globals[testCounter]).toBe(0);
  });

  test.each(['--project', '--prototypes', '--prototype-identity'])(
    'does not turn a missing common value into valid file roles: %s',
    async (option) => {
      const c = capture();
      expect(
        await run(['test', '--json', option, '--overrides', 'missing-values.json', 'a', 'b', 'c']),
      ).toBe(2);
      expect(c.report().diagnostics[0]).toMatchObject({
        code: 'CLI1001',
        message: `${option} requires a value.`,
      });
      expect(globals[sourceCounter]).toBe(0);
      expect(globals[testCounter]).toBe(0);
    },
  );

  test('preserves injected-provider conflicts and matching host authority checks', async () => {
    const { database, environment } = await parameterHost();
    const f = await files();
    const c = capture();
    const databasePath = join(f.directory, 'db.json');
    await writeFile(databasePath, JSON.stringify(database));
    expect(
      await run(
        [
          'test',
          '--json',
          '--overrides',
          f.valuesPath,
          '--prototypes',
          databasePath,
          f.sourcePath,
          f.testPath,
        ],
        environment,
      ),
    ).toBe(2);
    expect(c.report().diagnostics[0].code).toBe('CLI1001');
    const other = await loadPrototypeDatabase(syntheticPrototypeDatabase());
    expect(
      await run(['test', '--json', '--overrides', f.valuesPath, f.sourcePath, f.testPath], {
        prototypes: other.prototypes,
        trustedEntityReplayContext: environment.trustedEntityReplayContext,
      }),
    ).toBe(2);
    expect(c.report().diagnostics[0].code).toBe('ER1001');
    expect(globals[sourceCounter]).toBe(0);
    expect(globals[testCounter]).toBe(0);
  });
});

describe('CLI test owning compilation and setup diagnostics', () => {
  test.each([
    [[{ id: 0, value: 'five' }], 'CP1000', '$.overrides[0].value', true],
    [
      [{ id: 1, value: { type: 'virtual', name: 'signal-each' } }],
      'CP1000',
      '$.overrides[0].value.name',
      true,
    ],
    [[{ id: 99, value: 5 }], 'CP1000', '$.overrides[0].id', false],
    [
      [
        { id: 0, value: 5 },
        { id: 0, value: 6 },
      ],
      'CP1000',
      '$.overrides[1].id',
      true,
    ],
    [[{ id: 3, value: 9 }], 'CP1001', '$.bindings', true],
    [[{ id: 0, value: 1.5 }], 'CP1000', 'filters[0].value', true],
    [{ overrides: [] }, 'CP1000', '$.overrides', false],
  ] as const)(
    'keeps adapter code/path/span for %j without registration',
    async (values, code, path, hasSpan) => {
      const { environment } = await parameterHost();
      const f = await files(
        `${source}\nconst unused = Param.number('Unused', 9);\nconst warningInput = new Network(); const warningProducer = warningInput + 0;`,
        undefined,
        values,
      );
      const c = capture();
      expect(
        await run(
          ['test', '--json', '--overrides', f.valuesPath, f.sourcePath, f.testPath],
          environment,
        ),
      ).toBe(1);
      const report = c.report();
      const diag = report.diagnostics.find((d: { code: string }) => d.code === code);
      expect(diag).toMatchObject({
        code,
        severity: 'error',
        message: expect.stringContaining(path),
      });
      if (hasSpan)
        expect(diag.span).toMatchObject({
          fileId: expect.any(String),
          start: expect.any(Number),
          end: expect.any(Number),
        });
      else expect(diag).not.toHaveProperty('span');
      expect(report.diagnostics).toContainEqual(
        expect.objectContaining({ code: 'CL2001', severity: 'warning' }),
      );
      expect(report).not.toHaveProperty('tests');
      expect(globals[sourceCounter]).toBe(1);
      expect(globals[testCounter]).toBe(0);
    },
  );

  test('formats a located binding failure using the circuit file, not the test file', async () => {
    const { environment } = await parameterHost();
    const f = await files(source, undefined, [{ id: 0, value: 'bad' }]);
    const c = capture();
    expect(
      await run(['test', '--overrides', f.valuesPath, f.sourcePath, f.testPath], environment),
    ).toBe(1);
    expect(c.error).toHaveBeenCalledWith(
      expect.stringContaining(`${relative(process.cwd(), f.sourcePath).replaceAll('\\', '/')}:2:`),
    );
    expect(c.error).toHaveBeenCalledWith(expect.stringContaining('error CP1000'));
    expect(c.log.mock.calls.some(([text]) => String(text).startsWith('PASS'))).toBe(false);
  });

  test('unexpected binding failure stays a setup error with no fallback or source rerun', async () => {
    const { environment } = await parameterHost();
    const f = await files();
    const c = capture();
    vi.spyOn(bindingApi, 'createSourceParameterBindingSession').mockImplementation(() => {
      throw new Error('binding fault');
    });
    const originalRunner = vi.spyOn(runtime, 'runExecutedDirectPlanTests');
    expect(
      await run(
        ['test', '--json', '--overrides', f.valuesPath, f.sourcePath, f.testPath],
        environment,
      ),
    ).toBe(1);
    expect(c.report().diagnostics).toContainEqual(
      expect.objectContaining({ code: 'EX1001', message: 'binding fault' }),
    );
    expect(c.report()).not.toHaveProperty('tests');
    expect(originalRunner).not.toHaveBeenCalled();
    expect(globals[sourceCounter]).toBe(1);
    expect(globals[testCounter]).toBe(0);
  });

  test.each([[], [{ id: 0, value: 5 }], {}].map((values) => ({ values })))(
    'without declarations only [] succeeds: %j',
    async ({ values }) => {
      const f = await files(
        `${counted}const A = Signal('virtual', 'signal-A');\nconst output = new Network();\noutput += CC(5 * A);`,
        undefined,
        values,
      );
      const c = capture();
      const succeeds = Array.isArray(values) && values.length === 0;
      expect(
        await run(['test', '--json', '--overrides', f.valuesPath, f.sourcePath, f.testPath]),
      ).toBe(succeeds ? 0 : 1);
      if (succeeds) expect(c.report().tests).toMatchObject({ passed: 1, failed: 0 });
      else {
        expect(c.report().diagnostics).toContainEqual(expect.objectContaining({ code: 'CLI1001' }));
        expect(c.report()).not.toHaveProperty('tests');
      }
      expect(globals[sourceCounter]).toBe(1);
      expect(globals[testCounter]).toBe(succeeds ? 1 : 0);
    },
  );

  test.each(['const broken = ;', `${counted}const output = new Network(); output += 5;`])(
    'parse/pipeline failure blocks binding and tests',
    async (text) => {
      const f = await files(text);
      const c = capture();
      const bind = vi.spyOn(bindingApi, 'createSourceParameterBindingSession');
      expect(
        await run(['test', '--json', '--overrides', f.valuesPath, f.sourcePath, f.testPath]),
      ).toBe(1);
      expect(c.report()).not.toHaveProperty('tests');
      expect(bind).not.toHaveBeenCalled();
      expect(globals[testCounter]).toBe(0);
    },
  );
});

describe('CLI test selected pair and fresh sessions', () => {
  test('binds once, executes source once and isolates a failed first test from fresh quality-aware T0', async () => {
    const { environment } = await parameterHost();
    const tests = `const C = Signal('virtual', 'signal-A');
test('changed first session', ({ network, drive, tick, expectSignal }) => {
  drive(network('input'), [[C, 100]]); tick(3);
  expectSignal(network('output'), C).toBe(-999);
});\n${assertions(8, { type: 'virtual', name: 'signal-C', quality: 'rare' }, 8)}`;
    const f = await files(source, tests);
    const c = capture();
    const original = bindingApi.createSourceParameterBindingSession;
    const bind = vi.fn();
    const owner = vi
      .spyOn(bindingApi, 'createSourceParameterBindingSession')
      .mockImplementation((compilation) => {
        const session = original(compilation);
        bind.mockImplementation((raw) => session.bind(raw));
        return { parameters: session.parameters, bind };
      });
    const runner = vi.spyOn(runtime, 'runResolvedDirectPlanTests');
    expect(
      await run(
        ['test', '--json', '--overrides', f.valuesPath, f.sourcePath, f.testPath],
        environment,
      ),
    ).toBe(1);
    expect(owner).toHaveBeenCalledTimes(1);
    expect(bind).toHaveBeenCalledExactlyOnceWith(chosen);
    expect(runner).toHaveBeenCalledTimes(1);
    expect(c.report().tests).toMatchObject({
      passed: 1,
      failed: 1,
      results: [
        { name: 'changed first session', status: 'failed', line: 4 },
        {
          name: 'fresh concrete values',
          status: 'passed',
          trace: { endTick: 2 },
          debug: { format: 'comblang-debug' },
        },
      ],
    });
    expect(globals[sourceCounter]).toBe(1);
    expect(globals[testCounter]).toBe(1);
  });

  test.each([
    [[], 5, { type: 'virtual', name: 'signal-A' }, 5],
    [[{ id: 0, value: 8 }], 8, { type: 'virtual', name: 'signal-A' }, 8],
    [chosen, 8, { type: 'virtual', name: 'signal-C', quality: 'rare' }, 8],
  ] as const)(
    'agrees with API binding and concrete export with independent expectations: %j',
    async (values, amount, channel, inputCount) => {
      const { environment } = await parameterHost();
      const f = await files(source, assertions(amount, channel, inputCount), values);
      const c = capture();
      const compilation = sourceApi.compileSourceProgram(
        { path: f.sourcePath, text: source },
        environment,
      );
      expect(
        compilation.pipelineDiagnostics.filter(({ severity }) => severity === 'error'),
      ).toEqual([]);
      const pair = bindingApi.createSourceParameterBindingSession(compilation).bind(values);
      expect(
        pair.resolvedCircuit.ir.entities.find(
          ({ profile }) => profile.prototypeKey === 'entity:constant-combinator',
        )?.configuration,
      ).toMatchObject({
        mode: 'constant',
        value: {
          sections: [
            {
              multiplier: 1,
              filters: [{ signal: channel, value: amount }],
            },
          ],
        },
      });
      const apiTests = runtime.runResolvedDirectPlanTests(
        pair.plan,
        pair.resolvedCircuit,
        assertions(amount, channel, inputCount),
      );
      expect(apiTests.results.map(({ message }) => message)).toEqual([undefined]);
      expect(apiTests).toMatchObject({ passed: 1, failed: 0 });
      expect(
        await run(
          ['blueprint', 'export', '--json', '--overrides', f.valuesPath, f.sourcePath],
          environment,
        ),
      ).toBe(0);
      expect(c.report().document).toEqual(
        generateBlueprintJson(pair.resolvedCircuit.ir, {
          label: 'CombLang generated circuit',
          maxDeciderConditionRows: 1024,
        }),
      );
      expect(
        await run(
          ['test', '--json', '--overrides', f.valuesPath, f.sourcePath, f.testPath],
          environment,
        ),
      ).toBe(0);
      expect(c.report().tests).toMatchObject({ passed: 1, failed: 0 });
      expect(globals[sourceCounter]).toBe(3); // API compilation + export invocation + test invocation, never bind/replay.
    },
  );

  test('keeps no-overrides JSON/plain results and original execution path', async () => {
    const { environment } = await parameterHost();
    const f = await files(source, assertions(5, { type: 'virtual', name: 'signal-A' }, 5));
    const c = capture();
    const bound = vi.spyOn(runtime, 'runResolvedDirectPlanTests');
    const executed = vi.spyOn(runtime, 'runExecutedDirectPlanTests');
    expect(await run(['test', '--json', f.sourcePath, f.testPath], environment)).toBe(0);
    const report = c.report();
    expect(report.tests).toMatchObject({ passed: 1, failed: 0 });
    expect(report.prototypeEnvironment.identity).toBe(environment.prototypes.identity);
    expect(report.entityReplayIdentity).toEqual(expect.any(String));
    expect(report).not.toHaveProperty('ok');
    expect(await run(['test', f.sourcePath, f.testPath], environment)).toBe(0);
    expect(c.log).toHaveBeenCalledWith('PASS fresh concrete values');
    expect(c.log).toHaveBeenCalledWith('1 passed, 0 failed.');
    expect(executed).toHaveBeenCalledTimes(2);
    expect(bound).not.toHaveBeenCalled();
    expect(globals[sourceCounter]).toBe(2);
  });

  test('accepts fractional multiplier structurally and exposes existing Unknown simulation semantics', async () => {
    const { environment } = await parameterHost();
    const values = [{ id: 2, value: 0.5 }];
    const tests = `${registered}test('fractional configuration', ({ execution, network, session, tick }) => {
  const entity = execution.circuit.ir.entities.find(e => e.prototypeName === 'constant-combinator');
  const section = entity.configuration.value.sections[0];
  if (section.multiplier !== 0.5 || section.filters[0].value !== 5) throw new Error('fraction clamped or count changed');
  tick();
  const value = session.readValue(network('input'));
  if (value.kind !== 'unknown' || !value.origins.some(o => o.description.includes('non-unit-multiplier'))) {
    throw new Error('unmodeled multiplier silently simulated');
  }
});`;
    const f = await files(source, tests, values);
    const c = capture();
    const compilation = sourceApi.compileSourceProgram(
      { path: f.sourcePath, text: source },
      environment,
    );
    const pair = bindingApi.createSourceParameterBindingSession(compilation).bind(values);
    expect(
      runtime.runResolvedDirectPlanTests(pair.plan, pair.resolvedCircuit, tests),
    ).toMatchObject({ passed: 1, failed: 0 });
    expect(
      await run(
        ['blueprint', 'export', '--json', '--overrides', f.valuesPath, f.sourcePath],
        environment,
      ),
    ).toBe(0);
    expect(c.report().document).toEqual(
      generateBlueprintJson(pair.resolvedCircuit.ir, {
        label: 'CombLang generated circuit',
        maxDeciderConditionRows: 1024,
      }),
    );
    expect(
      c
        .report()
        .document.blueprint.entities.find(
          (e: { name: string }) => e.name === 'constant-combinator',
        ),
    ).toMatchObject({
      control_behavior: { sections: { sections: [{ multiplier: 0.5, filters: [{ count: 5 }] }] } },
    });
    expect(
      await run(
        ['test', '--json', '--overrides', f.valuesPath, f.sourcePath, f.testPath],
        environment,
      ),
    ).toBe(0);
    expect(c.report().tests).toMatchObject({ passed: 1, failed: 0 });
    expect(globals[sourceCounter]).toBe(3);
  });

  test.each(['test(', `test('before throw', () => {});\nthrow new Error('registration failed');`])(
    'registration failures retain existing test report',
    async (tests) => {
      const { environment } = await parameterHost();
      const f = await files(source, tests);
      const c = capture();
      expect(
        await run(
          ['test', '--json', '--overrides', f.valuesPath, f.sourcePath, f.testPath],
          environment,
        ),
      ).toBe(1);
      expect(c.report().tests).toMatchObject({
        passed: 0,
        failed: 1,
        results: [{ status: 'failed', failureKind: 'runtime' }],
      });
      expect(globals[sourceCounter]).toBe(1);
    },
  );
});

describe('CLI test project paths, pins and policy', () => {
  test('uses configured paths but explicit source/test/override paths remain cwd-relative', async () => {
    const { database, environment } = await parameterHost();
    const c = capture();
    const f = await files(
      `${source}\nconst structural = Entity('structural');`,
      assertions(8, { type: 'virtual', name: 'signal-C', quality: 'rare' }, 8),
    );
    const projectDirectory = join(f.directory, 'project');
    await mkdir(projectDirectory);
    await writeFile(join(projectDirectory, 'db.json'), JSON.stringify(database));
    await writeFile(join(projectDirectory, 'configured.ts'), source);
    await writeFile(
      join(projectDirectory, 'configured.js'),
      assertions(8, { type: 'virtual', name: 'signal-C', quality: 'rare' }, 8),
    );
    const projectPath = join(projectDirectory, 'comblang.json');
    const profile = {
      schemaVersion: 1,
      source: 'configured.ts',
      tests: 'configured.js',
      prototypes: { path: 'db.json', identity: environment.prototypes.identity },
      diagnostics: { rules: { 'producer.unused-output': { enabled: false } } },
    };
    await writeFile(projectPath, JSON.stringify(profile));
    const hostOnly = { trustedEntityReplayContext: environment.trustedEntityReplayContext };
    const relativeValues = relative(process.cwd(), f.valuesPath);
    expect(
      await run(
        ['test', '--json', '--project', projectPath, '--overrides', relativeValues],
        hostOnly,
      ),
    ).toBe(0);
    expect(c.report().tests).toMatchObject({ passed: 1, failed: 0 });
    expect(c.report().diagnostics).toEqual([]);
    expect(c.report().prototypeEnvironment.identity).toBe(environment.prototypes.identity);
    await writeFile(
      projectPath,
      JSON.stringify({ ...profile, source: 'missing.ts', tests: 'missing.js' }),
    );
    expect(
      await run(
        [
          'test',
          '--json',
          '--project',
          projectPath,
          '--overrides',
          relativeValues,
          relative(process.cwd(), f.sourcePath),
          relative(process.cwd(), f.testPath),
          '--prototype-identity',
          environment.prototypes.identity,
        ],
        hostOnly,
      ),
    ).toBe(0);
    expect(c.report().tests).toMatchObject({ passed: 1, failed: 0 });
    const compileRuns = globals[sourceCounter];
    expect(
      await run(
        [
          'test',
          '--json',
          '--project',
          projectPath,
          '--overrides',
          relativeValues,
          '--prototype-identity',
          'conflict',
        ],
        hostOnly,
      ),
    ).toBe(2);
    expect(c.report().diagnostics[0].code).toBe('CLI1003');
    expect(c.report()).not.toHaveProperty('tests');
    expect(globals[sourceCounter]).toBe(compileRuns);
  });
});

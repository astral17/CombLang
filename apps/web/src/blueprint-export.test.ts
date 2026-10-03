import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  createTrustedEntityReplayContext,
  syntheticZeroPortEntityProfile,
} from '@comblang/compiler';
import type { EntityProfile } from '@comblang/compiler/entity';
import { entityReplayContextTransport } from '@comblang/compiler/entity-replay-context';
import { generateBlueprintJson } from '@comblang/compiler/blueprint-json';
import { loadPrototypeDatabase, syntheticPrototypeDatabase } from '@comblang/prototypes';
import { executeResolvedDirectPlan } from '@comblang/runtime';
import { entityPrototypeResolverFromProvider } from '@comblang/runtime/entity-registry';
import * as sourceApi from '@comblang/runtime/source-compilation';
import { sourceFileId, sourceSpan, type Diagnostic } from '@comblang/shared';
import { signal } from '@comblang/factorio';
import { emitNativeBlueprintJson } from '../../../packages/compiler/src/native-blueprint-emitter.js';
import { compileSource } from './compile-source.js';
import { CompilerWorkerRuntime } from './compiler-worker-request.js';
import { readBlueprintExportOptions } from './blueprint-export.js';
import { createSourceCircuitArtifact } from './source-circuit-artifact.js';
import { run } from '../../cli/src/main.js';

const directories: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

// Synthetic profiles pin local contracts only, not native game behavior.
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
      tileWidth: 1,
      tileHeight: 1,
      blueprintEligible: true,
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
    prototypeType: family,
    ref: {
      ...syntheticZeroPortEntityProfile.ref,
      database: identity,
      prototypeKey: `entity:${family}`,
      profileId: `profile:worker-export-${index}` as EntityProfile['ref']['profileId'],
    },
  }));
  const trustedEntityReplayContext = createTrustedEntityReplayContext({
    database: identity,
    source: 'synthetic',
    evidenceIdentity: 'worker-export-test-evidence',
    policyIdentity: 'worker-export-test-policy',
    profiles,
  });
  return { database, environment: { prototypes, trustedEntityReplayContext } };
}

const mixedSource = `const A = Signal('virtual', 'signal-A');
const first = Param.number('First', 5, { variable: '', formula: ' unknown(x)\\n', dependent: false });
const second = Param.number('Second', 111, { formula: 'x * 2', dependent: true });
const input = new Network(); const output = new Network();
input += CC(1 * A);
output += Selector({ input, operation: 'select', index: second });
output += Constant({ sections: [{ filters: [{ signal: A, value: first }] }] }).at(2, 3, 4);
output += Arithmetic({ left: first, operation: 'add', right: first, output: A });
output += Decider({ condition: (input[A] > first || input[A] == 0) && (input[A] < 19 || input[A] == 5), outputs: [input[A]] });`;

describe('Worker-local owning blueprint projection', () => {
  test('uses exactly one owning compilation before stripping; retains defaults, topology and opaque metadata', async () => {
    const { environment } = await parameterHost();
    const key = '__comblang_worker_native_export_runs';
    const globals = globalThis as Record<string, unknown>;
    const previous = globals[key];
    globals[key] = 0;
    try {
      const file = { path: 'mixed.factorio.ts', text: `globalThis.${key} += 1;\n${mixedSource}` };
      const compile = vi.spyOn(sourceApi, 'compileSourceProgram');
      const exportNative = vi.spyOn(sourceApi, 'exportSourceCompilationNativeBlueprint');
      const strip = vi.spyOn(sourceApi, 'sourceCompilationArtifact');
      const result = compileSource(file, environment, [], undefined, { parameters: true });
      expect(compile).toHaveBeenCalledTimes(1);
      expect(globals[key]).toBe(1);
      expect(exportNative.mock.calls[0]?.[0]).toBe(compile.mock.results[0]?.value);
      expect(exportNative.mock.invocationCallOrder[0]!).toBeLessThan(
        strip.mock.invocationCallOrder[0]!,
      );
      expect(exportNative.mock.calls[0]?.[1]).toEqual({
        label: 'CombLang generated circuit',
        maxDeciderConditionRows: 1024,
      });
      expect(result.pipelineDiagnostics).toEqual([]);
      const exported = result.blueprintExport;
      if (!exported?.ok) throw new Error(JSON.stringify(exported));
      expect(exported.document.blueprint.parameters).toEqual([
        {
          type: 'number',
          number: '5',
          name: 'First',
          variable: '',
          formula: ' unknown(x)\n',
          dependent: false,
        },
        { type: 'number', number: '111', name: 'Second', formula: 'x * 2', dependent: true },
      ]);
      const concrete = generateBlueprintJson(result.resolvedCircuit!.ir);
      expect(exported.document.blueprint.entities).toEqual(concrete.blueprint.entities);
      expect(exported.document.blueprint.wires).toEqual(concrete.blueprint.wires);
      expect(exported.document.blueprint.entities.map((entity) => entity.name)).toEqual([
        'constant-combinator',
        'selector-combinator',
        'constant-combinator',
        'arithmetic-combinator',
        'decider-combinator',
      ]);
      expect(exported.document.blueprint.entities[2]).toMatchObject({
        position: { x: 2, y: 3 },
        direction: 4,
      });
      expect(exported.document).toEqual(
        emitNativeBlueprintJson(exportNative.mock.results[0]?.value),
      );
      expect(result.plan).toBe(compile.mock.results[0]?.value.plan);
      expect(result.resolvedCircuit).toBe(compile.mock.results[0]?.value.resolvedCircuit);
      const artifact = createSourceCircuitArtifact(result.plan!, result.resolvedCircuit!);
      expect(artifact.blueprint).toEqual(concrete);
      expect(structuredClone(result)).toEqual(result);
      const { blueprintExport: _export, ...transport } = result;
      expect(transport).toEqual(strip.mock.results[0]?.value);
      expect(transport).not.toHaveProperty('parameters');
      expect(transport).not.toHaveProperty('execution');
      expect(transport).not.toHaveProperty('arithmeticTemplates');
      expect(transport.elaborationJavaScript).toBeUndefined();
      expect(
        Object.isFrozen(
          readBlueprintExportOptions({ blueprintExport: { label: 'frozen', parameters: false } }),
        ),
      ).toBe(true);
    } finally {
      if (previous === undefined) delete globals[key];
      else globals[key] = previous;
    }
  });

  test.each([
    [
      "const amount = Param.signal('Channel', A);",
      'Constant({ sections: [{ filters: [{ signal: amount, value: 5 }] }] })',
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
      "const amount = Param.number('First', 5); const other = Param.number('Second', 5);",
      "Arithmetic({ left: amount, operation: 'add', right: other, output: A })",
      '$.parameters[1].defaultValue',
    ],
  ])(
    'native rejection keeps compilation and strict replay usable: %s',
    async (declaration, device, path) => {
      const { environment } = await parameterHost();
      const file = {
        path: 'native-rejection.factorio.ts',
        text: `const A = Signal('virtual', 'signal-A');\n${declaration}\nconst output = new Network(); output += ${device};`,
      };
      const result = compileSource(file, environment, [], undefined, { parameters: true });
      expect(result.pipelineDiagnostics).toEqual([]);
      expect(result.blueprintExport).toMatchObject({
        ok: false,
        diagnostics: [
          {
            code: 'CP1002',
            severity: 'error',
            message: expect.stringContaining(path),
            span: { fileId: result.fileId },
          },
        ],
      });
      expect(result.blueprintExport).not.toHaveProperty('document');
      if (result.blueprintExport?.ok === false) {
        const span = result.blueprintExport.diagnostics[0]!.span!;
        expect(file.text.slice(span.start, span.end)).toContain('Param.');
        expect(result.blueprintExport.diagnostics[0]).not.toHaveProperty('path');
      }
      const replay = executeResolvedDirectPlan(result.plan!, result.resolvedCircuit!);
      expect(() => replay.circuit.createSimulation().step()).not.toThrow();
      expect(structuredClone(result)).toEqual(result);
      const defaults = compileSource(file, environment, [], undefined, {});
      expect(defaults.blueprintExport?.ok).toBe(true);
      if (defaults.blueprintExport?.ok)
        expect(defaults.blueprintExport.document.blueprint).not.toHaveProperty('parameters');
      expect(defaults.plan).toEqual(result.plan);
      expect(defaults.resolvedCircuit).toEqual(result.resolvedCircuit);
    },
  );

  test('row expansion failures remain separate; successful concrete simulation still reads defaults', async () => {
    const { environment } = await parameterHost();
    const condition = Array.from(
      { length: 11 },
      (_, index) => `(input[A] > ${index} || input[A] < ${index + 20})`,
    ).join(' && ');
    const result = compileSource(
      {
        path: 'expanded.factorio.ts',
        text: `const A = Signal('virtual', 'signal-A');
const input = new Network(); const output = new Network();
input += CC(1 * A); output += Decider({ condition: ${condition}, outputs: [input[A]] });`,
      },
      environment,
      [],
      undefined,
      {},
    );
    expect(result.pipelineDiagnostics).toEqual([]);
    expect(result.blueprintExport).toMatchObject({
      ok: false,
      diagnostics: [{ code: 'BP1001', span: expect.any(Object) }],
    });
    expect(() =>
      executeResolvedDirectPlan(result.plan!, result.resolvedCircuit!)
        .circuit.createSimulation()
        .step(),
    ).not.toThrow();
    const defaults = compileSource(
      {
        path: 'defaults.factorio.ts',
        text: `const A = Signal('virtual', 'signal-A');
const amount = Param.number('Amount', 5, { formula: '999', dependent: true });
const output = new Network(); output += Constant({ sections: [{ filters: [{ signal: A, value: amount }] }] });`,
      },
      environment,
      [],
      undefined,
      { parameters: true },
    );
    const replay = executeResolvedDirectPlan(defaults.plan!, defaults.resolvedCircuit!);
    expect(
      replay.circuit
        .createSimulation()
        .step()
        .read(replay.network('output').id)
        .get(signal('virtual', 'signal-A')),
    ).toBe(5);
  });

  test('compile and preflight failures reuse errors without projecting or erasing warnings/related spans', () => {
    const id = sourceFileId('error.factorio.ts');
    const warning: Diagnostic = {
      code: 'ENV_WARNING',
      severity: 'warning',
      message: 'Warning retained.',
    };
    const error: Diagnostic = {
      code: 'ENV_ERROR',
      severity: 'error',
      message: 'Error retained.',
      span: sourceSpan(id, 0, 1),
      related: [{ message: 'Origin.', span: sourceSpan(id, 2, 3) }],
    };
    const native = vi.spyOn(sourceApi, 'exportSourceCompilationNativeBlueprint');
    const file = { path: 'error.factorio.ts', text: "throw new Error('must not execute');" };
    const preflight = compileSource(file, {}, [warning, error], undefined, {});
    expect(preflight.pipelineDiagnostics).toEqual([warning, error]);
    expect(preflight.blueprintExport).toEqual({ ok: false, diagnostics: [error] });
    const compileFailure = compileSource({ ...file, text: 'const ANY = 5;' }, {}, [], undefined, {
      parameters: true,
    });
    expect(compileFailure.blueprintExport).toEqual({
      ok: false,
      diagnostics: compileFailure.pipelineDiagnostics,
    });
    expect(native).not.toHaveBeenCalled();
    const success = compileSource(
      { path: 'warning.ts', text: 'const output = CC();' },
      {},
      [warning],
      undefined,
      {},
    );
    expect(success.blueprintExport?.ok).toBe(true);
    expect(success.pipelineDiagnostics).toContainEqual(warning);
    expect(success.pipelineDiagnostics).toContainEqual(
      expect.objectContaining({ code: 'CL2001', severity: 'warning' }),
    );
  });

  test('forwards host authority and cache data while keeping independent source captures and progress', async () => {
    const { environment, database } = await parameterHost();
    const runtime = new CompilerWorkerRuntime({
      resolveEntityReplayContext: () => ({
        ...environment,
        entityPrototypeResolver: entityPrototypeResolverFromProvider(environment.prototypes),
      }),
    });
    const file = { path: 'independent.factorio.ts', text: mixedSource };
    const stages: string[] = [];
    const request = {
      kind: 'parse' as const,
      revision: 21,
      file,
      blueprintExport: { parameters: true, label: 'Worker label' },
      entityReplayContext: entityReplayContextTransport(environment.trustedEntityReplayContext),
    };
    const first = await runtime.handle(structuredClone(request), (stage) => stages.push(stage));
    expect(first.result.blueprintExport?.ok).toBe(true);
    expect(stages).toEqual(['receive', 'parse', 'semantic', 'transform', 'execute', 'lower']);
    expect(first.result.blueprintExport).toMatchObject({
      document: { blueprint: { label: 'Worker label' } },
    });
    const second = await runtime.handle({ ...request, revision: 22 });
    expect(second.result.blueprintExport).toEqual(first.result.blueprintExport);
    expect(second.result).not.toBe(first.result);
    expect(second.result.plan).not.toBe(first.result.plan);
    const loaded = await runtime.handle({
      ...request,
      revision: 23,
      prototypeProfile: { source: JSON.stringify(database) },
    });
    expect(loaded.result.blueprintExport).toEqual(first.result.blueprintExport);
    const cached = await runtime.handle({
      ...request,
      revision: 24,
      prototypeProfile: { identity: loaded.prototypeEnvironment!.identity },
    });
    expect(cached.result.blueprintExport).toEqual(first.result.blueprintExport);
    expect(cached.revision).toBe(24);
    expect(structuredClone(cached)).toEqual(cached);
    const checkData = (value: unknown): void => {
      if (value === null || typeof value !== 'object') {
        expect(typeof value).not.toBe('function');
        return;
      }
      expect(Reflect.ownKeys(value).every((key) => typeof key === 'string')).toBe(true);
      for (const key of [
        'execution',
        'trustedEntityReplayContext',
        'entityPrototypeResolver',
        'arithmeticTemplates',
        'session',
        'registration',
      ])
        expect(value).not.toHaveProperty(key);
      for (const child of Object.values(value)) checkData(child);
    };
    checkData(cached);
  });

  test.each([
    [{ prototypeProfile: { source: '{' } }, 'PT1006'],
    [{ prototypeProfile: { identity: 'missing' } }, 'WP1002'],
    [{ diagnosticPolicy: { levels: { error: false } } }, 'WP1004'],
    [{ entityReplayContext: { protocolVersion: 0 } }, 'ER1000'],
  ])(
    'requested export on preflight failure preserves $1 and never projects',
    async (input, code) => {
      const native = vi.spyOn(sourceApi, 'exportSourceCompilationNativeBlueprint');
      const result = (
        await new CompilerWorkerRuntime().handle({
          kind: 'parse',
          revision: 44,
          file: { path: 'preflight.factorio.ts', text: "throw new Error('must not execute');" },
          blueprintExport: { parameters: true },
          ...input,
        } as never)
      ).result;
      expect(result.pipelineDiagnostics).toEqual([expect.objectContaining({ code })]);
      expect(result.blueprintExport).toEqual({
        ok: false,
        diagnostics: result.pipelineDiagnostics,
      });
      expect(result.plan).toBeUndefined();
      expect(native).not.toHaveBeenCalled();
    },
  );

  test('builtin asset and warm cached provider export numeric metadata without external fetch', async () => {
    const source = await readFile(
      new URL('../../../packages/prototypes/generated/space-age-2.1.17.json', import.meta.url),
      'utf8',
    );
    const assetManifest = await readFile(
      new URL(
        '../../../packages/prototypes/generated/space-age-2.1.17.json.manifest.json',
        import.meta.url,
      ),
      'utf8',
    );
    const runtime = new CompilerWorkerRuntime();
    const request = {
      kind: 'parse' as const,
      revision: 30,
      file: { path: 'builtin-export.factorio.ts', text: mixedSource },
      blueprintExport: { parameters: true },
    };
    const first = await runtime.handle({
      ...request,
      prototypeProfile: { kind: 'builtin', source, assetManifest },
    });
    expect(first.result.pipelineDiagnostics).toEqual([]);
    expect(first.result.blueprintExport?.ok).toBe(true);
    const warm = await runtime.handle({
      ...request,
      revision: 31,
      prototypeProfile: { kind: 'builtin', identity: first.prototypeEnvironment!.identity },
    });
    expect(warm.result.blueprintExport).toEqual(first.result.blueprintExport);
    expect(structuredClone(warm)).toEqual(warm);
    const missing = await new CompilerWorkerRuntime().handle({
      ...request,
      prototypeProfile: { identity: first.prototypeEnvironment!.identity },
    });
    expect(missing.result.blueprintExport).toMatchObject({
      ok: false,
      diagnostics: [{ code: 'WP1002' }],
    });
  });

  test('Worker profile and profile-free native failures are not mislabeled as profile failures', async () => {
    const { environment, database } = await parameterHost();
    const runtime = new CompilerWorkerRuntime({
      resolveEntityReplayContext: () => ({
        ...environment,
        entityPrototypeResolver: entityPrototypeResolverFromProvider(environment.prototypes),
      }),
    });
    const request = {
      kind: 'parse' as const,
      revision: 45,
      blueprintExport: { parameters: true },
      file: {
        path: 'worker-rejected.factorio.ts',
        text: `const A = Signal('virtual', 'signal-A');
const channel = Param.signal('Channel', A); const output = new Network();
output += Constant({ sections: [{ filters: [{ signal: channel, value: 5 }] }] });`,
      },
      entityReplayContext: entityReplayContextTransport(environment.trustedEntityReplayContext),
    };
    for (const extra of [
      {},
      { prototypeProfile: { source: JSON.stringify(database) } },
      { prototypeProfile: { identity: environment.prototypes.identity } },
    ]) {
      const response = await runtime.handle({ ...request, ...extra });
      expect(response.result.pipelineDiagnostics).toEqual([]);
      expect(response.result.blueprintExport).toMatchObject({
        ok: false,
        diagnostics: [
          {
            code: 'CP1002',
            message: expect.stringContaining('$.parameters[0]'),
            span: expect.any(Object),
          },
        ],
      });
      expect(response.result.blueprintExport).not.toHaveProperty('document');
      expect(() =>
        executeResolvedDirectPlan(response.result.plan!, response.result.resolvedCircuit!),
      ).not.toThrow();
      expect(structuredClone(response)).toEqual(response);
    }
  });

  test('export diagnostics retain related information and semantic path without touching compilation errors', async () => {
    const { environment } = await parameterHost();
    const span = sourceSpan(sourceFileId('related.factorio.ts'), 0, 4);
    const related = [{ message: 'Original declaration.', span }];
    vi.spyOn(sourceApi, 'exportSourceCompilationNativeBlueprint').mockImplementation(() => {
      throw Object.assign(new Error('Rejected native field.'), {
        code: 'CP1002',
        path: '$.parameters[0]',
        span,
        related,
      });
    });
    const result = compileSource(
      { path: 'related.factorio.ts', text: mixedSource },
      environment,
      [],
      undefined,
      { parameters: true },
    );
    expect(result.pipelineDiagnostics).toEqual([]);
    expect(result.blueprintExport).toEqual({
      ok: false,
      diagnostics: [
        {
          code: 'CP1002',
          severity: 'error',
          message: '$.parameters[0]: Rejected native field.',
          span,
          related,
        },
      ],
    });
    expect(structuredClone(result)).toEqual(result);
  });

  test('numeric Worker document equals the existing CLI owning-source document', async () => {
    const { environment } = await parameterHost();
    const directory = await mkdtemp(join(tmpdir(), 'comblang-worker-cli-parity-'));
    directories.push(directory);
    const path = join(directory, 'same.factorio.ts');
    await writeFile(path, mixedSource);
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(await run(['blueprint', 'export', '--json', '--parameters', path], environment)).toBe(0);
    const cli = JSON.parse(String(log.mock.calls[0]?.[0])).document;
    const browser = compileSource({ path, text: mixedSource }, environment, [], undefined, {
      parameters: true,
    });
    expect(browser.blueprintExport).toEqual({ ok: true, document: cli });
    expect(error).not.toHaveBeenCalled();
  });
});

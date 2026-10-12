import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

import {
  DEFAULT_BLUEPRINT_CODEC_LIMITS,
  encodeBlueprintExchange,
  parseLosslessJson,
  stringifyLosslessJson,
} from '@comblang/blueprint';
import {
  createTrustedEntityReplayContext,
  syntheticZeroPortEntityProfile,
} from '@comblang/compiler';
import type { EntityProfile, EntityProfileId } from '@comblang/compiler/entity';
import * as blueprintImportApi from '@comblang/runtime/blueprint-source-import';
import * as sourceApi from '@comblang/runtime/source-compilation';
import { loadPrototypeDatabase, syntheticPrototypeDatabase } from '@comblang/prototypes';
import { afterEach, describe, expect, test, vi } from 'vitest';

import type { CliCompilationEnvironment } from './main.js';
import { run } from './main.js';
import { parseSourceBlueprintImportOptions } from './blueprint-source-import.js';

const directories: string[] = [];

function arithmeticBehavior(
  signal: string,
  mask: { readonly red: boolean; readonly green: boolean },
  output = 'signal-B',
) {
  return {
    arithmetic_conditions: {
      first_signal: { type: 'virtual', name: signal },
      first_signal_networks: mask,
      operation: '+',
      second_constant: 2,
      output_signal: { type: 'virtual', name: output },
    },
  };
}

function constantBehavior(multiplier = 1) {
  return {
    is_on: true,
    sections: {
      sections: [
        {
          index: 1,
          active: true,
          multiplier,
          filters: [
            {
              index: 1,
              name: 'signal-A',
              type: 'virtual',
              quality: 'normal',
              comparator: '=',
              count: 7,
            },
          ],
        },
      ],
    },
  };
}

function blueprintDocument(
  options: { readonly multiplier?: number; readonly metadata?: boolean } = {},
) {
  return JSON.stringify({
    blueprint: {
      ...(options.metadata ? { item: 'blueprint', label: 'imported label', version: 1 } : {}),
      entities: [
        {
          entity_number: 12,
          name: 'arithmetic-combinator',
          position: { x: 0, y: 4 },
          direction: 4,
          control_behavior: arithmeticBehavior(
            'signal-each',
            { red: true, green: true },
            'signal-each',
          ),
        },
        {
          entity_number: 400,
          name: 'constant-combinator',
          position: { x: 8, y: -1 },
          direction: 15,
          control_behavior: constantBehavior(options.multiplier ?? 1),
        },
        {
          entity_number: 11,
          name: 'arithmetic-combinator',
          position: { x: -2, y: 1 },
          direction: 0,
          control_behavior: arithmeticBehavior('signal-A', { red: true, green: false }),
        },
        {
          entity_number: 13,
          name: 'constant-combinator',
          position: { x: 7, y: 6 },
          direction: 8,
          control_behavior: constantBehavior(),
        },
      ],
      wires: [
        [400, 1, 11, 1],
        [400, 1, 12, 1],
        [12, 3, 12, 1],
        [12, 4, 12, 2],
      ],
    },
  });
}

function deciderDocument(options: { readonly implicitCopyInput?: boolean } = {}) {
  return JSON.stringify({
    blueprint: {
      entities: [
        {
          entity_number: 42,
          name: 'decider-combinator',
          position: { x: 0, y: 0 },
          direction: 0,
          control_behavior: {
            decider_conditions: {
              conditions: [
                {
                  first_signal: { type: 'virtual', name: 'signal-A' },
                  first_signal_networks: { red: true, green: false },
                  comparator: '>',
                  constant: 0,
                  compare_type: 'and',
                },
              ],
              outputs: [
                {
                  signal: { type: 'virtual', name: 'signal-B' },
                  copy_count_from_input: true,
                  ...(options.implicitCopyInput ? {} : { networks: { red: true, green: false } }),
                },
              ],
            },
          },
        },
      ],
      wires: [[42, 1, 42, 3]],
    },
  });
}

async function temporaryFile(name: string, content: string | Uint8Array): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'comblang-blueprint-import-'));
  directories.push(directory);
  const path = join(directory, name);
  await writeFile(path, content);
  return path;
}

async function exchangeFile(name: string, documentText: string, ending = ''): Promise<string> {
  const exchange = await encodeBlueprintExchange(parseLosslessJson(documentText));
  return temporaryFile(name, `${exchange}${ending}`);
}

async function canonicalHost() {
  const database = structuredClone(syntheticPrototypeDatabase()) as {
    entities: Array<Record<string, unknown>>;
  };
  const families = ['constant-combinator', 'arithmetic-combinator', 'decider-combinator'] as const;
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
  const databaseRef = { schemaVersion: prototypes.schemaVersion, identity: prototypes.identity };
  const profiles = families.map((family, index): EntityProfile => ({
    ...structuredClone(syntheticZeroPortEntityProfile),
    ref: {
      ...syntheticZeroPortEntityProfile.ref,
      database: databaseRef,
      prototypeKey: `entity:${family}` as EntityProfile['ref']['prototypeKey'],
      profileId: `profile:blueprint-import-${index}` as EntityProfileId,
    },
    prototypeType: family,
  }));
  const trustedEntityReplayContext = createTrustedEntityReplayContext({
    database: databaseRef,
    source: 'synthetic',
    evidenceIdentity: 'blueprint-source-import-test-evidence',
    policyIdentity: 'blueprint-source-import-test-policy',
    profiles,
  });
  return {
    database,
    profiles,
    trustedEntityReplayContext,
    environment: { prototypes, trustedEntityReplayContext } satisfies CliCompilationEnvironment,
  };
}

function capture() {
  return {
    log: vi.spyOn(console, 'log').mockImplementation(() => undefined),
    error: vi.spyOn(console, 'error').mockImplementation(() => undefined),
  };
}

function reportAt(log: ReturnType<typeof capture>['log'], index = 0): Record<string, any> {
  return JSON.parse(String(log.mock.calls[index]?.[0])) as Record<string, any>;
}

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

describe('blueprint source import CLI', () => {
  test('parses the narrow option set, option terminator, and exactly one document', () => {
    expect(
      parseSourceBlueprintImportOptions([
        '--json',
        '--output',
        'out.factorio.ts',
        '--prototypes',
        'database.json',
        '--prototype-identity',
        'pinned-id',
        '--',
        '--document.json',
      ]),
    ).toEqual({
      inputPath: '--document.json',
      json: true,
      output: 'out.factorio.ts',
      prototypePath: 'database.json',
      prototypeIdentity: 'pinned-id',
    });

    for (const args of [
      [],
      ['one.json', 'two.json'],
      [''],
      ['--output'],
      ['--output', '   ', 'input.json'],
      ['--prototypes', ''],
      ['--prototype-identity', '--json', 'input.json'],
      ['input.json', '--json', '--json'],
      ['--output', 'one.ts', '--output', 'two.ts', 'input.json'],
      ['--prototypes', 'one.json', '--prototypes', 'two.json', 'input.json'],
      ['--parameters', 'input.json'],
      ['--overrides', 'values.json', 'input.json'],
      ['--project', 'project.json', 'input.json'],
      ['--input-file', 'input.json'],
      ['--unknown', 'input.json'],
      ['bad\0path.json'],
      ['--output', 'bad\0path.ts', 'input.json'],
    ]) {
      expect(() => parseSourceBlueprintImportOptions(args)).toThrowError(
        expect.objectContaining({ code: 'CLIBP1001' }),
      );
    }
    expect(() => parseSourceBlueprintImportOptions([])).toThrowError(
      'import requires exactly one blueprint file path.',
    );
  });

  test('validates invalid arguments and sole help before provider access or compilation', async () => {
    const { log } = capture();
    const compile = vi.spyOn(sourceApi, 'compileSourceProgram');
    let providerReads = 0;
    const environment = {
      get prototypes(): NonNullable<CliCompilationEnvironment['prototypes']> {
        providerReads += 1;
        throw new Error('Invalid arguments and help must not load a provider.');
      },
    } satisfies CliCompilationEnvironment;

    expect(
      await run(['blueprint', 'import', '--json', '--project', 'never-read.json'], environment),
    ).toBe(2);
    expect(reportAt(log)).toMatchObject({ ok: false, error: { code: 'CLIBP1001' } });
    expect(await run(['blueprint', 'import', '--help'], environment)).toBe(0);
    expect(String(log.mock.calls[1]?.[0])).toContain('<blueprint-file>');
    expect(String(log.mock.calls[1]?.[0])).not.toContain('<document.json>');
    expect(await run(['--help'], environment)).toBe(0);
    expect(String(log.mock.calls[2]?.[0])).toContain('<blueprint-file>');
    expect(providerReads).toBe(0);
    expect(compile).not.toHaveBeenCalled();
  });

  test('imports shuffled, feedback/fanout, disconnected, Each and explicit placement through real compilation and verification', async () => {
    const host = await canonicalHost();
    const input = await temporaryFile('shuffled.json', blueprintDocument({ metadata: true }));
    const output = join(dirname(input), 'verified.factorio.ts');
    const databasePath = join(dirname(input), 'prototypes.json');
    await writeFile(databasePath, JSON.stringify(host.database));
    const { log, error } = capture();
    const compile = vi.spyOn(sourceApi, 'compileSourceProgram');

    expect(
      await run(
        [
          'blueprint',
          'import',
          '--json',
          '--prototypes',
          databasePath,
          '--prototype-identity',
          host.environment.prototypes!.identity,
          '--output',
          output,
          input,
        ],
        { trustedEntityReplayContext: host.trustedEntityReplayContext },
      ),
    ).toBe(0);

    const report = reportAt(log);
    expect(log).toHaveBeenCalledTimes(1);
    expect(error).not.toHaveBeenCalled();
    expect(compile).toHaveBeenCalledTimes(1);
    expect(report).toMatchObject({
      ok: true,
      source: { path: output, text: expect.any(String) },
      output,
      verification: {
        state: 'verified',
        entityCount: 4,
        networkCount: expect.any(Number),
      },
      correspondence: {
        entities: [
          { entityNumber: 12, family: 'arithmetic' },
          { entityNumber: 400, family: 'constant' },
          { entityNumber: 11, family: 'arithmetic' },
          { entityNumber: 13, family: 'constant' },
        ],
      },
      diagnostics: expect.arrayContaining([
        expect.objectContaining({ path: '$.blueprint.label', message: expect.any(String) }),
      ]),
    });
    expect(report.source.path).toBe(resolve(output));
    expect(report.source.text).toBe(compile.mock.calls[0]?.[0].text);
    expect(await readFile(output, 'utf8')).toBe(report.source.text);

    const compilation = compile.mock.results[0]?.value as ReturnType<
      typeof sourceApi.compileSourceProgram
    >;
    const verified = report.diagnostics.filter(
      (diagnostic: { readonly category?: string }) =>
        diagnostic.category === 'source-verification-mismatch',
    );
    expect(verified).toEqual([]);
    const actualWarnings = compilation.pipelineDiagnostics.filter(
      ({ severity }) => severity === 'warning',
    );
    const reportedWarnings = report.diagnostics.filter(
      (diagnostic: { readonly severity?: string }) => diagnostic.severity === 'warning',
    );
    expect(actualWarnings.length).toBeGreaterThan(0);
    expect(reportedWarnings).toEqual(actualWarnings);
    expect(
      report.diagnostics.filter(
        (diagnostic: { readonly code?: string }) => diagnostic.code === 'CL2001',
      ),
    ).toEqual(actualWarnings.filter(({ code }) => code === 'CL2001'));
    const arithmetic = compilation.resolvedCircuit?.ir.producers.find(
      ({ kind, config }) =>
        kind === 'arithmetic' && config.left.kind === 'each' && config.output.kind === 'each',
    );
    expect(arithmetic?.kind).toBe('arithmetic');
    expect(arithmetic?.provenance.source).toBeDefined();
  });

  test('imports JSON and exchange files through the same core once with equal verified results', async () => {
    const host = await canonicalHost();
    const sourceText = blueprintDocument({ metadata: true });
    const jsonPath = await temporaryFile('equal.json', sourceText);
    const exchange = await encodeBlueprintExchange(parseLosslessJson(sourceText));
    const { log } = capture();
    const importCore = vi.spyOn(blueprintImportApi, 'importCanonicalBlueprintSource');
    const compile = vi.spyOn(sourceApi, 'compileSourceProgram');

    expect(await run(['blueprint', 'import', '--json', jsonPath], host.environment)).toBe(0);
    const jsonReport = reportAt(log);
    await writeFile(jsonPath, exchange);
    log.mockClear();
    expect(await run(['blueprint', 'import', '--json', jsonPath], host.environment)).toBe(0);
    const exchangeReport = reportAt(log);

    expect(importCore).toHaveBeenCalledTimes(2);
    expect(importCore.mock.calls[0]?.[0]).toBe(sourceText);
    expect(importCore.mock.calls[1]?.[0]).toBe(
      stringifyLosslessJson(parseLosslessJson(sourceText)),
    );
    expect(compile).toHaveBeenCalledTimes(2);
    expect(exchangeReport.source.text).toBe(jsonReport.source.text);
    expect(exchangeReport.correspondence).toEqual(jsonReport.correspondence);
    expect(exchangeReport.verification).toEqual(jsonReport.verification);
    expect(exchangeReport.diagnostics).toEqual(jsonReport.diagnostics);
  });

  test('imports canonical Decider JSON and exchange with exact exclusive source output', async () => {
    const host = await canonicalHost();
    const sourceText = deciderDocument();
    const jsonInput = await temporaryFile('decider.json', sourceText);
    const exchangeInput = await exchangeFile('decider.exchange', sourceText);
    const jsonOutput = join(dirname(jsonInput), 'decider-json.factorio.ts');
    const exchangeOutput = join(dirname(exchangeInput), 'decider-exchange.factorio.ts');
    const compile = vi.spyOn(sourceApi, 'compileSourceProgram');
    const { log, error } = capture();

    for (const [input, output] of [
      [jsonInput, jsonOutput],
      [exchangeInput, exchangeOutput],
    ] as const) {
      log.mockClear();
      expect(
        await run(['blueprint', 'import', '--json', '--output', output, input], host.environment),
      ).toBe(0);
      const report = reportAt(log);
      expect(error).not.toHaveBeenCalled();
      expect(report).toMatchObject({
        ok: true,
        output: resolve(output),
        source: { path: resolve(output), text: expect.stringContaining('= Decider(') },
        verification: { state: 'verified', entityCount: 1 },
        correspondence: { entities: [{ entityNumber: 42, family: 'decider' }] },
      });
      expect(await readFile(output, 'utf8')).toBe(report.source.text);
      expect(compile.mock.calls.at(-1)?.[0]?.text).toBe(report.source.text);
    }

    expect(compile).toHaveBeenCalledTimes(2);
  });

  test('refuses an implicit Decider copy-input mask without creating output', async () => {
    const host = await canonicalHost();
    const input = await temporaryFile(
      'decider-implicit-mask.json',
      deciderDocument({
        implicitCopyInput: true,
      }),
    );
    const output = join(dirname(input), 'refused-decider.factorio.ts');
    const compile = vi.spyOn(sourceApi, 'compileSourceProgram');
    const { log } = capture();

    expect(
      await run(['blueprint', 'import', '--json', '--output', output, input], host.environment),
    ).toBe(2);
    expect(reportAt(log)).toMatchObject({
      ok: false,
      error: {
        code: 'CLIBP1006',
        path: '$.blueprint.entities[0].control_behavior.decider_conditions.outputs[0]',
      },
      diagnostics: [expect.objectContaining({ category: 'unsupported-source-configuration' })],
    });
    expect(compile).not.toHaveBeenCalled();
    await expect(stat(output)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  test('accepts only the exchange file terminal-newline exception and preserves JSON whitespace', async () => {
    const host = await canonicalHost();
    const sourceText = blueprintDocument();
    const exchange = await encodeBlueprintExchange(parseLosslessJson(sourceText));
    const { log } = capture();
    const importCore = vi.spyOn(blueprintImportApi, 'importCanonicalBlueprintSource');

    for (const [name, ending] of [
      ['bare.exchange', ''],
      ['lf.exchange', '\n'],
      ['crlf.exchange', '\r\n'],
    ] as const) {
      const path = await temporaryFile(name, `${exchange}${ending}`);
      expect(await run(['blueprint', 'import', '--json', path], host.environment)).toBe(0);
      log.mockClear();
    }

    const jsonWithWhitespace = ` \n${sourceText}\t `;
    const jsonPath = await temporaryFile('whitespace.json', jsonWithWhitespace);
    expect(await run(['blueprint', 'import', '--json', jsonPath], host.environment)).toBe(0);
    expect(importCore.mock.calls[3]?.[0]).toBe(jsonWithWhitespace);

    for (const [name, text, code] of [
      ['two-newlines.exchange', `${exchange}\n\n`, 'BEX1002'],
      ['leading-space.exchange', ` ${exchange}`, 'BPD1001'],
      ['wrapped.exchange', `${exchange.slice(0, 8)}\n${exchange.slice(8)}`, 'BEX1002'],
    ] as const) {
      const path = await temporaryFile(name, text);
      log.mockClear();
      expect(await run(['blueprint', 'import', '--json', path], host.environment)).toBe(2);
      expect(reportAt(log)).toMatchObject({ ok: false, error: { code, path: '$' } });
      expect(reportAt(log)).not.toHaveProperty('source');
    }
  });

  test('preserves exchange codec failures and paths without compiling or creating output', async () => {
    const host = await canonicalHost();
    const oversized = `0${'A'.repeat(DEFAULT_BLUEPRINT_CODEC_LIMITS.maxEncodedCharacters)}`;
    const cases = [
      ['malformed-base64.exchange', '0!', 'BEX1002'],
      ['malformed-deflate.exchange', '0AAAAAA==', 'BEX1005'],
      ['over-encoded-limit.exchange', oversized, 'BEX1003'],
    ] as const;
    const { log, error } = capture();
    const importCore = vi.spyOn(blueprintImportApi, 'importCanonicalBlueprintSource');
    const compile = vi.spyOn(sourceApi, 'compileSourceProgram');

    for (const [name, text, code] of cases) {
      const input = await temporaryFile(name, text);
      const output = join(dirname(input), `${name}.factorio.ts`);
      expect(
        await run(['blueprint', 'import', '--json', '--output', output, input], host.environment),
      ).toBe(2);
      expect(reportAt(log)).toMatchObject({ ok: false, error: { code, path: '$' } });
      expect(reportAt(log)).not.toHaveProperty('source');
      expect(reportAt(log)).not.toHaveProperty('correspondence');
      await expect(stat(output)).rejects.toMatchObject({ code: 'ENOENT' });
      log.mockClear();
    }

    expect(importCore).not.toHaveBeenCalled();
    expect(compile).not.toHaveBeenCalled();

    const malformedPath = await temporaryFile('plain-malformed.exchange', '0!');
    expect(await run(['blueprint', 'import', malformedPath], host.environment)).toBe(2);
    expect(error.mock.calls.map(([line]) => String(line)).join('\n')).toContain('BEX1002 $:');
  });

  test('keeps decoded refusals located, avoids partial output, and leaves JSON independent of streams', async () => {
    const host = await canonicalHost();
    const unsupportedRoot = await exchangeFile('book.exchange', '{"blueprint_book":{}}');
    const negativeZero = await exchangeFile(
      'negative-zero.exchange',
      blueprintDocument().replace('"multiplier":1,', '"multiplier":-0,'),
    );
    const validExchange = await exchangeFile('stream-capability.exchange', blueprintDocument());
    const { log } = capture();

    const unsupportedOutput = join(dirname(unsupportedRoot), 'unsupported.factorio.ts');
    expect(
      await run(
        ['blueprint', 'import', '--json', '--output', unsupportedOutput, unsupportedRoot],
        host.environment,
      ),
    ).toBe(2);
    expect(reportAt(log)).toMatchObject({
      error: { code: 'CLIBP1006', path: '$.blueprint_book' },
    });
    expect(reportAt(log)).not.toHaveProperty('source');
    await expect(stat(unsupportedOutput)).rejects.toMatchObject({ code: 'ENOENT' });

    const negativeOutput = join(dirname(negativeZero), 'negative-zero.factorio.ts');
    log.mockClear();
    expect(
      await run(
        ['blueprint', 'import', '--json', '--output', negativeOutput, negativeZero],
        host.environment,
      ),
    ).toBe(2);
    expect(reportAt(log)).toMatchObject({
      error: { code: 'CLIBP1006', path: '$.blueprint.entities[1]' },
    });
    expect(reportAt(log)).not.toHaveProperty('source');
    await expect(stat(negativeOutput)).rejects.toMatchObject({ code: 'ENOENT' });

    vi.stubGlobal('CompressionStream', undefined);
    vi.stubGlobal('DecompressionStream', undefined);
    log.mockClear();
    expect(await run(['blueprint', 'import', '--json', validExchange], host.environment)).toBe(2);
    expect(reportAt(log)).toMatchObject({ error: { code: 'BEX1004', path: '$' } });
    log.mockClear();
    const jsonPath = await temporaryFile('without-streams.json', blueprintDocument());
    expect(await run(['blueprint', 'import', '--json', jsonPath], host.environment)).toBe(0);
    expect(reportAt(log)).toMatchObject({ ok: true, verification: { state: 'verified' } });
  });

  test('writes successful exchange output exclusively and preserves existing bytes', async () => {
    const host = await canonicalHost();
    const input = await exchangeFile('exclusive.exchange', blueprintDocument());
    const output = join(dirname(input), 'exchange.factorio.ts');
    const { log } = capture();

    expect(
      await run(['blueprint', 'import', '--json', '--output', output, input], host.environment),
    ).toBe(0);
    const success = reportAt(log);
    expect(success).toMatchObject({ ok: true, output: resolve(output) });
    expect(await readFile(output, 'utf8')).toBe(success.source.text);

    await writeFile(output, 'keep-existing');
    log.mockClear();
    expect(
      await run(['blueprint', 'import', '--json', '--output', output, input], host.environment),
    ).toBe(2);
    expect(reportAt(log)).toMatchObject({ error: { code: 'CLIBP1003', path: resolve(output) } });
    expect(await readFile(output, 'utf8')).toBe('keep-existing');
  });

  test('prints only the generated source to stdout and uses a virtual default source path', async () => {
    const host = await canonicalHost();
    const input = await temporaryFile('plain.json', blueprintDocument());
    const { log, error } = capture();
    expect(await run(['blueprint', 'import', '--json', input], host.environment)).toBe(0);
    const response = reportAt(log);
    expect(response.source.path).toBe(resolve(`${input}.factorio.ts`));
    expect(response).not.toHaveProperty('output');
    await expect(stat(response.source.path)).rejects.toMatchObject({ code: 'ENOENT' });
    log.mockClear();
    error.mockClear();

    expect(await run(['blueprint', 'import', input], host.environment)).toBe(0);
    expect(log).toHaveBeenCalledTimes(1);
    const generated = String(log.mock.calls[0]?.[0]);
    expect(generated).toContain('Constant(');
    expect(generated).toContain('left:Each(pair(');
    expect(generated).toContain('output:EACH');
    expect(generated).not.toContain('ok":true');
    expect(error).toHaveBeenCalled();
    expect(error.mock.calls.some(([line]) => String(line).includes('CL2001'))).toBe(true);

    const output = join(dirname(input), 'plain-output.factorio.ts');
    log.mockClear();
    error.mockClear();
    expect(await run(['blueprint', 'import', '--output', output, input], host.environment)).toBe(0);
    expect(log.mock.calls[0]?.[0]).toBe(`Wrote ${resolve(output)}`);
    expect(error.mock.calls.some(([line]) => String(line).includes('CL2001'))).toBe(true);
    expect(await readFile(output, 'utf8')).toContain('const import_entity_1');
  });

  test('requires trusted context even for an empty blueprint and does not use a fallback', async () => {
    const input = await temporaryFile('empty.json', '{"blueprint":{"entities":[],"wires":[]}}');
    const { log } = capture();
    expect(await run(['blueprint', 'import', '--json', input])).toBe(2);
    expect(reportAt(log)).toMatchObject({
      ok: false,
      error: {
        code: 'CLIBP1006',
        message: expect.stringContaining('trusted Entity replay context'),
      },
    });
    expect(reportAt(log)).not.toHaveProperty('source');
    expect(reportAt(log)).not.toHaveProperty('correspondence');
  });

  test('refuses a missing exact profile and a same-type modded name at the native entity path', async () => {
    const host = await canonicalHost();
    const input = await temporaryFile(
      'constant.json',
      JSON.stringify({
        blueprint: {
          entities: [
            {
              entity_number: 1,
              name: 'constant-combinator',
              position: { x: 0, y: 0 },
              direction: 0,
              control_behavior: constantBehavior(),
            },
          ],
          wires: [],
        },
      }),
    );
    const missingProfileContext = createTrustedEntityReplayContext({
      database: host.trustedEntityReplayContext.database,
      source: 'synthetic',
      evidenceIdentity: 'missing-import-profile-evidence',
      policyIdentity: 'missing-import-profile-policy',
      profiles: [host.profiles[1]!],
    });
    const { log } = capture();
    const missingOutput = join(dirname(input), 'missing-profile.ts');
    expect(
      await run(['blueprint', 'import', '--json', '--output', missingOutput, input], {
        ...host.environment,
        trustedEntityReplayContext: missingProfileContext,
      }),
    ).toBe(2);
    expect(reportAt(log)).toMatchObject({
      ok: false,
      error: { code: 'CLIBP1006', path: '$.blueprint.entities[0].name' },
      diagnostics: [expect.objectContaining({ category: 'missing-profile-selection' })],
    });
    await expect(stat(missingOutput)).rejects.toMatchObject({ code: 'ENOENT' });

    const moddedName = 'modded-arithmetic-combinator';
    const moddedProfile: EntityProfile = {
      ...host.profiles[1]!,
      ref: {
        ...host.profiles[1]!.ref,
        prototypeKey: `entity:${moddedName}` as EntityProfile['ref']['prototypeKey'],
        profileId: 'profile:modded-arithmetic-import' as EntityProfileId,
      },
      prototypeType: 'arithmetic-combinator',
    };
    const sameTypeModdedContext = createTrustedEntityReplayContext({
      database: host.trustedEntityReplayContext.database,
      source: 'synthetic',
      evidenceIdentity: 'modded-import-profile-evidence',
      policyIdentity: 'modded-import-profile-policy',
      profiles: [moddedProfile],
    });
    const moddedInput = await temporaryFile(
      'modded.json',
      JSON.stringify({
        blueprint: {
          entities: [
            { entity_number: 2, name: moddedName, position: { x: 0, y: 0 }, direction: 0 },
          ],
          wires: [],
        },
      }),
    );
    log.mockClear();
    expect(
      await run(['blueprint', 'import', '--json', moddedInput], {
        ...host.environment,
        trustedEntityReplayContext: sameTypeModdedContext,
      }),
    ).toBe(2);
    expect(reportAt(log)).toMatchObject({
      error: { code: 'CLIBP1006', path: '$.blueprint.entities[0].name' },
      diagnostics: [expect.objectContaining({ category: 'unsupported-canonical-family' })],
    });
  });

  test('refuses ambiguous exact canonical profiles without selecting one', async () => {
    const host = await canonicalHost();
    const duplicate: EntityProfile = {
      ...host.profiles[0]!,
      ref: {
        ...host.profiles[0]!.ref,
        profileId: 'profile:duplicate-constant-import' as EntityProfileId,
      },
    };
    const context = createTrustedEntityReplayContext({
      database: host.trustedEntityReplayContext.database,
      source: 'synthetic',
      evidenceIdentity: 'ambiguous-import-profile-evidence',
      policyIdentity: 'ambiguous-import-profile-policy',
      profiles: [...host.profiles, duplicate],
    });
    const input = await temporaryFile(
      'ambiguous.json',
      JSON.stringify({
        blueprint: {
          entities: [
            {
              entity_number: 1,
              name: 'constant-combinator',
              position: { x: 0, y: 0 },
              direction: 0,
              control_behavior: constantBehavior(),
            },
          ],
          wires: [],
        },
      }),
    );
    const { log } = capture();
    expect(
      await run(['blueprint', 'import', '--json', input], {
        ...host.environment,
        trustedEntityReplayContext: context,
      }),
    ).toBe(2);
    expect(reportAt(log)).toMatchObject({
      error: { code: 'CLIBP1006', path: '$.blueprint.entities[0].name' },
      diagnostics: [expect.objectContaining({ category: 'ambiguous-canonical-profile' })],
    });
  });

  test('preserves duplicate and dangling inventory diagnostics and refuses opaque roots', async () => {
    const host = await canonicalHost();
    const invalidInventory = await temporaryFile(
      'partial.json',
      JSON.stringify({
        blueprint: {
          entities: [
            { entity_number: 1, name: 'constant-combinator' },
            { entity_number: 1, name: 'constant-combinator' },
          ],
          wires: [[1, 1, 99, 1]],
        },
      }),
    );
    const { log } = capture();
    const partialOutput = join(dirname(invalidInventory), 'partial-refusal.factorio.ts');
    expect(
      await run(
        ['blueprint', 'import', '--json', '--output', partialOutput, invalidInventory],
        host.environment,
      ),
    ).toBe(2);
    expect(reportAt(log)).toMatchObject({
      error: { code: 'CLIBP1006', path: '$.blueprint.entities[1].entity_number' },
      diagnostics: expect.arrayContaining([
        expect.objectContaining({ category: 'duplicate-entity-number' }),
        expect.objectContaining({ category: 'dangling-wire-reference' }),
      ]),
    });
    expect(reportAt(log)).not.toHaveProperty('source');
    await expect(stat(partialOutput)).rejects.toMatchObject({ code: 'ENOENT' });

    const opaque = await temporaryFile('book.json', '{"blueprint_book":{}}');
    log.mockClear();
    expect(await run(['blueprint', 'import', '--json', opaque], host.environment)).toBe(2);
    expect(reportAt(log)).toMatchObject({
      error: { code: 'CLIBP1006', path: '$.blueprint_book' },
      diagnostics: [expect.objectContaining({ category: 'unsupported-root' })],
    });
  });

  test('preserves typed malformed JSON and UTF-8 failures with their paths', async () => {
    const host = await canonicalHost();
    const malformed = await temporaryFile('malformed.json', '{');
    const invalidUtf8 = await temporaryFile('invalid-utf8.json', new Uint8Array([0xff]));
    const { log } = capture();
    expect(await run(['blueprint', 'import', '--json', malformed], host.environment)).toBe(2);
    expect(reportAt(log)).toMatchObject({
      error: { code: 'BPD1001', path: '$' },
    });
    log.mockClear();
    expect(await run(['blueprint', 'import', '--json', invalidUtf8], host.environment)).toBe(2);
    expect(reportAt(log)).toMatchObject({
      error: { code: 'CLIBP1005', path: resolve(invalidUtf8) },
    });
  });

  test('does not publish source when assembly or native verification refuses the input', async () => {
    const host = await canonicalHost();
    const unsupportedFieldInput = await temporaryFile(
      'unsupported-field.json',
      JSON.stringify({
        blueprint: {
          entities: [
            {
              entity_number: 1,
              name: 'constant-combinator',
              position: { x: 0, y: 0 },
              direction: 0,
              control_behavior: constantBehavior(),
              unsupported_extra: true,
            },
          ],
          wires: [],
        },
      }),
    );
    const assemblyOutput = join(dirname(unsupportedFieldInput), 'assembly-refusal.ts');
    const { log } = capture();
    expect(
      await run(
        ['blueprint', 'import', '--json', '--output', assemblyOutput, unsupportedFieldInput],
        host.environment,
      ),
    ).toBe(2);
    expect(reportAt(log)).toMatchObject({
      error: { code: 'CLIBP1006', path: '$.blueprint.entities[0].unsupported_extra' },
      diagnostics: [expect.objectContaining({ category: 'unsupported-source-field' })],
    });
    await expect(stat(assemblyOutput)).rejects.toMatchObject({ code: 'ENOENT' });

    const negativeZeroInput = await temporaryFile(
      'negative-zero.json',
      blueprintDocument().replace('"multiplier":1,', '"multiplier":-0,'),
    );
    const verificationOutput = join(dirname(negativeZeroInput), 'verification-refusal.ts');
    log.mockClear();
    expect(
      await run(
        ['blueprint', 'import', '--json', '--output', verificationOutput, negativeZeroInput],
        host.environment,
      ),
    ).toBe(2);
    expect(reportAt(log)).toMatchObject({
      error: {
        code: 'CLIBP1006',
        path: '$.blueprint.entities[1]',
        message: expect.stringContaining('Reprojected native configuration'),
      },
      diagnostics: expect.arrayContaining([
        expect.objectContaining({
          category: 'source-verification-mismatch',
          entityNumber: 400,
          path: '$.blueprint.entities[1]',
          source: expect.objectContaining({ start: expect.any(Number), end: expect.any(Number) }),
        }),
      ]),
    });
    await expect(stat(verificationOutput)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(JSON.stringify(reportAt(log))).not.toContain('severity":"error"');
    expect(JSON.stringify(reportAt(log))).not.toContain('diagnosticContext');

    const { error } = capture();
    expect(await run(['blueprint', 'import', negativeZeroInput], host.environment)).toBe(2);
    const stderr = error.mock.calls.map(([line]) => String(line)).join('\n');
    expect(stderr).toContain('$.blueprint.entities[1]');
    expect(stderr).toContain(`Generated source ${resolve(`${negativeZeroInput}.factorio.ts`)}:`);
  });

  test('never publishes source when the ordinary compiler boundary fails', async () => {
    const host = await canonicalHost();
    const input = await temporaryFile('compiler-failure.json', blueprintDocument());
    const output = join(dirname(input), 'compiler-failure.factorio.ts');
    const { log } = capture();
    vi.spyOn(sourceApi, 'compileSourceProgram').mockImplementationOnce(() => {
      throw new Error('synthetic compiler boundary failure');
    });
    expect(
      await run(['blueprint', 'import', '--json', '--output', output, input], host.environment),
    ).toBe(2);
    expect(reportAt(log)).toMatchObject({
      error: { code: 'CLIBP1000', message: 'synthetic compiler boundary failure' },
    });
    expect(reportAt(log)).not.toHaveProperty('source');
    await expect(stat(output)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  test('preserves existing input and output bytes with exclusive creation', async () => {
    const host = await canonicalHost();
    const input = await temporaryFile('same.json', blueprintDocument());
    const original = await readFile(input, 'utf8');
    const { log } = capture();
    expect(
      await run(['blueprint', 'import', '--json', '--output', input, input], host.environment),
    ).toBe(2);
    expect(reportAt(log)).toMatchObject({ error: { code: 'CLIBP1003', path: resolve(input) } });
    expect(await readFile(input, 'utf8')).toBe(original);

    const existingOutput = await temporaryFile('existing.factorio.ts', 'sentinel');
    log.mockClear();
    expect(
      await run(
        ['blueprint', 'import', '--json', '--output', existingOutput, input],
        host.environment,
      ),
    ).toBe(2);
    expect(reportAt(log)).toMatchObject({
      error: { code: 'CLIBP1003', path: resolve(existingOutput) },
    });
    expect(await readFile(existingOutput, 'utf8')).toBe('sentinel');
  });

  test('keeps codec and source-export dispatch unchanged', async () => {
    const input = await temporaryFile('codec.json', '{"blueprint":{"entities":[],"wires":[]}}');
    const { log } = capture();
    expect(await run(['blueprint', 'encode', '--json', input])).toBe(0);
    expect(reportAt(log)).toMatchObject({ ok: true, exchange: expect.stringMatching(/^0/) });
    log.mockClear();
    expect(await run(['blueprint', 'export', '--help'])).toBe(0);
    expect(String(log.mock.calls[0]?.[0])).toContain('blueprint export');
    expect(String(log.mock.calls[0]?.[0])).not.toContain('blueprint import');
  });
});

import { mkdtemp, open, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';

import { run } from './main.js';
import {
  parseSourceParameterListOptions,
  readSourceParameterOverrides,
} from './source-parameters.js';

const directories: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

async function temporaryFile(name: string, contents?: string | Uint8Array): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'comblang-source-parameters-'));
  directories.push(directory);
  const path = join(directory, name);
  if (contents !== undefined) await writeFile(path, contents);
  return path;
}

async function sourceFile(contents: string): Promise<string> {
  return temporaryFile('main.factorio.ts', contents);
}

describe('source parameter listing CLI options', () => {
  test('parses direct and project source selections with existing environment options', () => {
    expect(
      parseSourceParameterListOptions([
        'list',
        '--json',
        '--prototypes',
        'data.json',
        '--prototype-identity',
        'fixture-id',
        '--',
        'source.ts',
      ]),
    ).toMatchObject({
      files: ['source.ts'],
      json: true,
      prototypePath: 'data.json',
      prototypeIdentity: 'fixture-id',
    });
    expect(parseSourceParameterListOptions(['list', '--', '--source.ts']).files).toEqual([
      '--source.ts',
    ]);
    expect(parseSourceParameterListOptions(['list', 'source.ts'])).toMatchObject({
      files: ['source.ts'],
    });
    expect(parseSourceParameterListOptions(['list', '--project', 'app.json'])).toMatchObject({
      files: [],
      projectPath: 'app.json',
    });
    expect(
      parseSourceParameterListOptions(['list', '--project', 'app.json', 'alternate.ts']),
    ).toMatchObject({ files: ['alternate.ts'], projectPath: 'app.json' });
  });

  test.each([
    [[]],
    [['show']],
    [['list']],
    [['list', 'one.ts', 'two.ts']],
    [['list', '--project', 'app.json', 'one.ts', 'two.ts']],
    [['list', '--project']],
    [['list', '--project', '']],
    [['list', '--unknown']],
    [['list', '--project', 'app.json', '--prototypes', 'data.json']],
    [['list', '--', 'one.ts', 'two.ts']],
  ])('rejects malformed listing arguments before source execution: %j', (args) => {
    expect(() => parseSourceParameterListOptions(args)).toThrowError(
      expect.objectContaining({ code: 'CLI1001' }),
    );
  });

  test('rejects unknown actions and extra sources through run before executing source', async () => {
    const key = '__comblang_cli_parameter_parse_runs';
    const globals = globalThis as Record<string, unknown>;
    const previous = globals[key];
    globals[key] = 0;
    const path = await sourceFile(`globalThis.${key} = Number(globalThis.${key} ?? 0) + 1;
const output = new Network();`);
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      for (const args of [
        ['parameters', 'show', '--json', path],
        ['parameters', 'list', '--json', path, 'extra.ts'],
      ]) {
        log.mockClear();
        expect(await run(args)).toBe(2);
        expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toMatchObject({
          ok: false,
          error: { code: 'CLI1001' },
        });
        expect(globals[key]).toBe(0);
      }
    } finally {
      if (previous === undefined) delete globals[key];
      else globals[key] = previous;
    }
  });

  test('reads an ordinary JSON override array without reshaping adapter values', async () => {
    const path = await temporaryFile(
      'values.json',
      JSON.stringify([
        { id: 0, value: 17 },
        { id: 1, value: { type: 'item', name: 'iron-plate', quality: 'rare' } },
      ]),
    );
    await expect(readSourceParameterOverrides(path)).resolves.toEqual([
      { id: 0, value: 17 },
      { id: 1, value: { type: 'item', name: 'iron-plate', quality: 'rare' } },
    ]);
    const empty = await temporaryFile('empty.json', '[]');
    await expect(readSourceParameterOverrides(empty)).resolves.toEqual([]);
  });

  test.each(['{', '1e400', 'NaN'])(
    'rejects invalid JSON representation %s with its absolute path',
    async (text) => {
      const path = await temporaryFile('invalid.json', text);
      await expect(readSourceParameterOverrides(path)).rejects.toMatchObject({
        code: 'CLI1001',
        message: expect.stringContaining(resolve(path)),
      });
    },
  );

  test('preserves missing, invalid UTF-8, and byte-limit file errors', async () => {
    const missing = await temporaryFile('missing.json');
    await expect(readSourceParameterOverrides(missing)).rejects.toMatchObject({
      code: 'CLIBP1002',
      path: resolve(missing),
    });

    const invalidUtf8 = await temporaryFile('invalid-utf8.json', Uint8Array.of(0xc3, 0x28));
    await expect(readSourceParameterOverrides(invalidUtf8)).rejects.toMatchObject({
      code: 'CLIBP1005',
      path: resolve(invalidUtf8),
    });

    const oversized = await temporaryFile('oversized.json');
    const file = await open(oversized, 'w');
    try {
      await file.truncate(1_048_577);
    } finally {
      await file.close();
    }
    await expect(readSourceParameterOverrides(oversized)).rejects.toMatchObject({
      code: 'CLIBP1002',
      path: resolve(oversized),
    });
  });

  test('lists detached descriptors from one owning compilation and preserves metadata and quality', async () => {
    const key = '__comblang_cli_parameter_list_runs';
    const globals = globalThis as Record<string, unknown>;
    const previous = globals[key];
    globals[key] = 0;
    const path = await sourceFile(`globalThis.${key} = Number(globalThis.${key} ?? 0) + 1;
const amount = Param.number('Same label', 5, { variable: 'x', formula: 'x * 2', dependent: true });
const channel = Param.signal('Same label', Signal('virtual', 'signal-A', 'rare'));
const duplicate = Param.number('Same label', 5);
const output = new Network();
output += CC(5 * Signal('virtual', 'signal-output'));`);
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      expect(await run(['parameters', 'list', '--json', path])).toBe(0);
      const report = JSON.parse(String(log.mock.calls[0]?.[0]));
      expect(report).toMatchObject({
        ok: true,
        parameters: [
          {
            id: 0,
            kind: 'number',
            label: 'Same label',
            defaultValue: 5,
            metadata: { variable: 'x', formula: 'x * 2', dependent: true },
          },
          {
            id: 1,
            kind: 'signal',
            label: 'Same label',
            defaultValue: { type: 'virtual', name: 'signal-A', quality: 'rare' },
          },
          { id: 2, kind: 'number', label: 'Same label', defaultValue: 5 },
        ],
      });
      expect(report).not.toHaveProperty('parameters.0.parameter');
      expect(Object.getOwnPropertySymbols(report.parameters[0])).toEqual([]);
      expect(() => structuredClone(report.parameters)).not.toThrow();
      expect(globals[key]).toBe(1);

      log.mockClear();
      expect(await run(['parameters', 'list', path])).toBe(0);
      expect(String(log.mock.calls[0]?.[0]).split('\n')).toEqual([
        '0\tnumber\t"Same label"\t5',
        '1\tsignal\t"Same label"\t{"type":"virtual","name":"signal-A","quality":"rare"}',
        '2\tnumber\t"Same label"\t5',
      ]);
      expect(globals[key]).toBe(2);
      expect(error.mock.calls.every(([message]) => String(message).includes('warning'))).toBe(true);
    } finally {
      if (previous === undefined) delete globals[key];
      else globals[key] = previous;
    }
  });

  test('lists number descriptors without exposing local expression roots or views', async () => {
    const key = '__comblang_cli_local_expression_list_runs';
    const globals = globalThis as Record<string, unknown>;
    const previous = globals[key];
    globals[key] = 0;
    const path = await sourceFile(`globalThis.${key} = Number(globalThis.${key} ?? 0) + 1;
const amount = Param.number('Amount', 5);
const factor = Param.number('Factor', 2);
const count = (amount + 1) * factor;
const right = amount - 1;`);
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      expect(await run(['parameters', 'list', '--json', path])).toBe(0);
      const report = JSON.parse(String(log.mock.calls[0]?.[0]));
      expect(report).toMatchObject({
        ok: true,
        parameters: [
          { id: 0, kind: 'number', label: 'Amount', defaultValue: 5 },
          { id: 1, kind: 'number', label: 'Factor', defaultValue: 2 },
        ],
      });
      expect(report.parameters[0]).not.toHaveProperty('expression');
      expect(report.parameters[1]).not.toHaveProperty('expression');
      expect(Object.getOwnPropertySymbols(report.parameters[0])).toEqual([]);
      expect(JSON.stringify(report.parameters)).not.toMatch(/numericExpression|binary|session/i);
      expect(globals[key]).toBe(1);
    } finally {
      if (previous === undefined) delete globals[key];
      else globals[key] = previous;
    }
  });

  test('prints empty listings and warnings plainly, and never returns a partial listing on compile errors', async () => {
    const warningSource = await sourceFile(`function Double(input) { return input * 2; }
function Triple(input: Network) { return input * 3; }
const input = CC(); const a = Double(input); const b = Double(input); const c = Triple(input);`);
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    expect(await run(['parameters', 'list', warningSource])).toBe(0);
    expect(log.mock.calls[0]?.[0]).toBe('No parameters declared.');
    expect(error.mock.calls.some(([message]) => String(message).includes('warning CL2002'))).toBe(
      true,
    );
    expect(warn).not.toHaveBeenCalled();

    log.mockClear();
    error.mockClear();
    expect(await run(['parameters', 'list', '--json', warningSource])).toBe(0);
    expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toMatchObject({
      ok: true,
      parameters: [],
      diagnostics: [expect.objectContaining({ code: 'CL2002', severity: 'warning' })],
    });
    expect(error).not.toHaveBeenCalled();

    const brokenSource = await sourceFile('const = ;');
    log.mockClear();
    expect(await run(['parameters', 'list', '--json', brokenSource])).toBe(2);
    const failure = JSON.parse(String(log.mock.calls[0]?.[0]));
    expect(failure).toMatchObject({
      ok: false,
      error: {
        code: expect.any(String),
        span: { start: expect.any(Number), end: expect.any(Number) },
      },
      diagnostics: [expect.objectContaining({ severity: 'error', span: expect.any(Object) })],
    });
    expect(failure).not.toHaveProperty('parameters');
  });
});

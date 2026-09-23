import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { encodeBlueprintExchange, parseLosslessJson } from '@comblang/blueprint';
import { afterEach, describe, expect, test, vi } from 'vitest';

import { readBoundedUtf8File } from './blueprint-command.js';
import { run } from './main.js';

const temporaryDirectories: string[] = [];

async function temporaryFile(name: string, content: string | Uint8Array): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'comblang-blueprint-cli-'));
  temporaryDirectories.push(directory);
  const path = join(directory, name);
  await writeFile(path, content);
  return path;
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

describe('blueprint codec CLI', () => {
  test('encodes JSON files and decodes raw exchange strings with lossless machine output', async () => {
    const source = '{"blueprint":{"item":"blueprint","version":9007199254740993}}';
    const inputPath = await temporaryFile('blueprint.json', source);
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    expect(await run(['blueprint', 'encode', inputPath, '--json'])).toBe(0);
    expect(error).not.toHaveBeenCalled();
    const encodeResult = JSON.parse(String(log.mock.calls[0]?.[0])) as {
      readonly ok: boolean;
      readonly exchange: string;
    };
    expect(encodeResult.ok).toBe(true);
    expect(encodeResult.exchange.startsWith('0')).toBe(true);

    expect(await run(['blueprint', 'decode', encodeResult.exchange, '--json'])).toBe(0);
    expect(String(log.mock.calls[1]?.[0])).toBe(`{"ok":true,"document":${source}}`);
  });

  test('supports bounded exchange files and creates output only when the target is new', async () => {
    const source = '{"blueprint":{"label":"file input","version":7}}';
    const inputPath = await temporaryFile('blueprint.json', source);
    const exchange = await encodeBlueprintExchange(parseLosslessJson(source));
    const exchangePath = await temporaryFile('exchange.txt', `${exchange}\r\n`);
    const outputPath = join(dirname(exchangePath), 'decoded.json');
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    expect(
      await run([
        'blueprint',
        'decode',
        '--input-file',
        exchangePath,
        '--output',
        outputPath,
        '--json',
      ]),
    ).toBe(0);
    expect(await readFile(outputPath, 'utf8')).toBe(source);
    expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toMatchObject({
      ok: true,
      output: outputPath,
    });

    await writeFile(outputPath, 'keep-existing');
    expect(
      await run([
        'blueprint',
        'decode',
        '--input-file',
        exchangePath,
        '--output',
        outputPath,
        '--json',
      ]),
    ).toBe(2);
    expect(await readFile(outputPath, 'utf8')).toBe('keep-existing');
    expect(JSON.parse(String(log.mock.calls[1]?.[0]))).toMatchObject({
      ok: false,
      error: { code: 'CLIBP1003' },
    });
    expect(error).not.toHaveBeenCalled();
    expect(await readFile(inputPath, 'utf8')).toBe(source);

    const encodedPath = join(dirname(exchangePath), 'encoded.txt');
    expect(await run(['blueprint', 'encode', inputPath, '--output', encodedPath, '--json'])).toBe(
      0,
    );
    expect(await readFile(encodedPath, 'utf8')).toBe(exchange);
    expect(JSON.parse(String(log.mock.calls[2]?.[0]))).toMatchObject({
      ok: true,
      output: encodedPath,
    });
  });

  test('returns typed machine-safe errors for codec failures and invalid UTF-8 files', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(await run(['blueprint', 'decode', 'not-an-exchange', '--json'])).toBe(2);
    expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toMatchObject({
      ok: false,
      error: { code: 'BEX1001', path: '$' },
    });

    const invalidUtf8Path = await temporaryFile('invalid.json', new Uint8Array([0xff]));
    expect(await run(['blueprint', 'encode', invalidUtf8Path, '--json'])).toBe(2);
    expect(JSON.parse(String(log.mock.calls[1]?.[0]))).toMatchObject({
      ok: false,
      error: { code: 'CLIBP1005' },
    });
    expect(error).not.toHaveBeenCalled();
  });

  test('rejects oversized file input before reading it into an unbounded string', async () => {
    const path = await temporaryFile('large.txt', 'four');
    await expect(readBoundedUtf8File(path, 3)).rejects.toMatchObject({ code: 'CLIBP1002' });
  });
});

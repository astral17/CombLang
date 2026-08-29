import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, test, vi } from 'vitest';

import { run } from './main.js';

const temporaryDirectories: string[] = [];

async function sourceFile(text: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'comblang-cli-'));
  temporaryDirectories.push(directory);
  const path = join(directory, 'main.factorio.ts');
  await writeFile(path, text, 'utf8');
  return path;
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

describe('factorio-dsl check', () => {
  test('runs executed circuit validation and reports producer totals as JSON', async () => {
    const path = await sourceFile(`const CHEST = Signal("chest");
const input = CC(5 * CHEST);`);
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    expect(await run(['check', '--json', path])).toBe(0);
    expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toMatchObject({
      diagnostics: [],
      producerCount: 1,
    });
  });

  test('reports semantic errors in branches that execution would skip', async () => {
    const path = await sourceFile(`const output = new Network();
if (false) {
  output += 5;
}`);
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    expect(await run(['check', path])).toBe(1);
    expect(String(error.mock.calls[0]?.[0])).toContain(
      '3:3 - error CL1034: Network += requires a combinator producer',
    );
  });

  test('preserves structured ownership diagnostics from executed aliases', async () => {
    const path = await sourceFile(`const destination = new Network();
const source = new Network();
const aliases = [source];
destination.take(source);
const output: Network = aliases[0] + 1;`);
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    expect(await run(['check', '--json', path])).toBe(1);
    const result = JSON.parse(String(log.mock.calls[0]?.[0]));
    expect(result.diagnostics).toEqual([
      expect.objectContaining({ code: 'RT2012', severity: 'error', related: expect.any(Array) }),
    ]);
  });

  test('reports runtime borrow conflicts that conservative semantics cannot prove', async () => {
    const path = await sourceFile(`const network = new Network();
function Invalid(_read: Readonly<Network>): void {
  network += CC(1 * Signal("virtual", "signal-A"));
}
Invalid(network);`);
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    expect(await run(['check', '--json', path])).toBe(1);
    const result = JSON.parse(String(log.mock.calls[0]?.[0]));
    expect(result.diagnostics).toEqual([
      expect.objectContaining({ code: 'RT2016', severity: 'error', related: expect.any(Array) }),
    ]);
  });
});

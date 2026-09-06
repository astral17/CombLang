import { execFile } from 'node:child_process';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  codeUnitCompare,
  generateInventory,
  serializeInventory,
  verifyFileHash,
} from './generate-control-behavior-inventory.mjs';

const temporaryDirectories = [];
const executeFile = promisify(execFile);
let inventory;

beforeAll(async () => {
  inventory = await generateInventory();
});

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe('pinned Factorio API inventory', () => {
  it('retains the reviewed 2.1.17 baseline', () => {
    expect(inventory.source).toMatchObject({
      snapshot: 'fixtures/2.1.17',
      applicationVersion: '2.1.17',
      apiVersion: 6,
    });
    expect(inventory.counts).toEqual({
      classes: 40,
      concrete: 37,
      abstract: 3,
      entityVariants: 47,
      referencedConcepts: 120,
    });
  });

  it('uses repository-relative provenance and deterministic serialization', async () => {
    const regenerated = await generateInventory();
    expect(serializeInventory(regenerated)).toBe(serializeInventory(inventory));
    expect(serializeInventory(regenerated)).not.toMatch(/Analysis|[A-Z]:\\/);
  });

  it('regenerates identically from an isolated tool directory', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'comblang-api-isolated-'));
    temporaryDirectories.push(directory);
    const isolatedTool = join(directory, 'factorio-api');
    await cp(fileURLToPath(new URL('./', import.meta.url)), isolatedTool, {
      recursive: true,
    });

    await executeFile(
      process.execPath,
      [join(isolatedTool, 'generate-control-behavior-inventory.mjs')],
      { cwd: directory },
    );

    expect(await readFile(join(isolatedTool, 'generated', 'control-behaviors.json'), 'utf8')).toBe(
      serializeInventory(inventory),
    );
  });

  it('sorts persisted names by UTF-16 code units', () => {
    expect(['é', 'a', 'Ä', 'Z'].sort(codeUnitCompare)).toEqual(['Z', 'a', 'Ä', 'é']);
  });

  it('fails closed when a pinned file hash changes', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'comblang-api-hash-'));
    temporaryDirectories.push(directory);
    const file = join(directory, 'runtime-api.json');
    await writeFile(file, '{}\n');

    await expect(verifyFileHash(pathToFileURL(file), '0'.repeat(64))).rejects.toThrow(
      'snapshot hash mismatch',
    );
  });

  it('requires an explicit review assignment for every API class', async () => {
    const review = JSON.parse(
      await readFile(new URL('control-behavior-review.json', import.meta.url), 'utf8'),
    );
    review.waves.space_combat_and_display = review.waves.space_combat_and_display.filter(
      (name) => name !== 'LuaRadarControlBehavior',
    );

    await expect(generateInventory({ review })).rejects.toThrow(
      'No review wave for LuaRadarControlBehavior',
    );
  });
});

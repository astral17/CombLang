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
  generateSchemaCatalog,
  serializeInventory,
  serializeSchemaCatalog,
  sha256,
  verifyFileHash,
} from './generate-control-behavior-inventory.mjs';

const temporaryDirectories = [];
const executeFile = promisify(execFile);
let inventory;
let catalog;

beforeAll(async () => {
  inventory = await generateInventory();
  catalog = await generateSchemaCatalog();
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

describe('pinned Blueprint schema catalog', () => {
  it('retains the reviewed schema baseline', () => {
    expect(catalog.source).toMatchObject({
      snapshot: 'fixtures/2.1.17',
      applicationVersion: '2.1.17',
      apiVersion: 6,
    });
    expect(catalog.counts).toEqual({
      entityVariants: 62,
      controlBehaviors: 37,
      referencedSchemas: 116,
    });
    expect(catalog.variants).toHaveLength(62);
    expect(catalog.controlBehaviors).toHaveLength(37);
  });

  it('is deterministic and contains no API descriptions or local provenance', async () => {
    const regenerated = await generateSchemaCatalog();
    const serialized = serializeSchemaCatalog(regenerated);
    expect(serialized).toBe(serializeSchemaCatalog(catalog));
    expect(serialized).not.toMatch(/"description"\s*:|"examples?"\s*:|Analysis|[A-Z]:\\/i);
    expect(catalog.common.fields.find(({ name }) => name === 'entity_number')).toMatchObject({
      ownership: 'compiler',
    });
    expect(
      catalog.controlBehaviors.find(({ name }) => name === 'LuaAssemblingMachineControlBehavior'),
    ).toMatchObject({
      blueprintType: 'AssemblingMachineBlueprintControlBehavior',
      entityVariants: ['assembling-machine'],
    });
    expect(serialized).not.toMatch(/circuit_connector|connector_lanes|lane_count/);
  });

  it('preserves selector variant groups behind its common operation field', () => {
    const selector = catalog.references.find(({ name }) => name === 'SelectorCombinatorParameters');
    expect(selector?.type).toMatchObject({
      kind: 'object',
      fields: [
        {
          name: 'operation',
          default: 'select',
        },
      ],
      variant: {
        discriminator: 'operation',
        default: 'select',
        groups: [
          { value: 'count' },
          { value: 'quality-filter' },
          { value: 'quality-transfer' },
          { value: 'random' },
          { value: 'select' },
          { value: 'time' },
        ],
      },
    });
    expect(selector?.type.kind === 'object' && selector.type.variant?.groups).toHaveLength(6);
    expect(
      selector?.type.kind === 'object' &&
        selector.type.variant?.groups
          .find(({ value }) => value === 'select')
          ?.fields.map(({ name }) => name),
    ).toEqual(['index_constant', 'index_signal', 'select_max']);
  });

  it.each([
    [
      'ambiguous',
      (parameters) =>
        parameters.push({
          name: 'ambiguous_operation',
          type: 'SelectorCombinatorParameterOperation',
          optional: true,
        }),
    ],
    [
      'missing',
      (parameters) => {
        parameters.find(({ name }) => name === 'operation').type = 'string';
      },
    ],
  ])('fails closed for a %s inferred Selector discriminator', async (_label, mutate) => {
    const directory = await mkdtemp(join(tmpdir(), 'comblang-api-variant-inference-'));
    temporaryDirectories.push(directory);
    const fixtureDirectory = join(directory, 'fixture');
    await cp(fileURLToPath(new URL('fixtures/2.1.17/', import.meta.url)), fixtureDirectory, {
      recursive: true,
    });
    const runtimePath = join(fixtureDirectory, 'runtime-api.json');
    const runtime = JSON.parse(await readFile(runtimePath, 'utf8'));
    const selector = runtime.concepts.find(({ name }) => name === 'SelectorCombinatorParameters');
    expect(selector?.type?.parameters).toBeInstanceOf(Array);
    mutate(selector.type.parameters);
    const runtimeSerialized = `${JSON.stringify(runtime, null, 2)}\n`;
    await writeFile(runtimePath, runtimeSerialized);
    const manifestPath = join(fixtureDirectory, 'manifest.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    manifest.files['runtime-api.json'].sha256 = sha256(runtimeSerialized);
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

    await expect(
      generateSchemaCatalog({
        fixtureDirectory: pathToFileURL(manifestPath),
      }),
    ).rejects.toThrow('exactly one unambiguous string discriminator');
  });

  it('covers representative variants and every reviewed wave', async () => {
    const review = JSON.parse(
      await readFile(new URL('control-behavior-review.json', import.meta.url), 'utf8'),
    );
    const variantNames = new Set(catalog.variants.map(({ name }) => name));
    for (const name of [
      'assembling-machine',
      'container',
      'inserter',
      'lamp',
      'roboport',
      'train-stop',
      'locomotive',
      'cargo-wagon',
      'car',
      'underground-belt',
      'linked-container',
    ]) {
      expect(variantNames.has(name)).toBe(true);
    }
    const behaviorNames = new Set(catalog.controlBehaviors.map(({ name }) => name));
    for (const name of Object.values(review.waves).flat()) {
      if (
        ![
          'LuaControlBehavior',
          'LuaCombinatorControlBehavior',
          'LuaGenericOnOffControlBehavior',
        ].includes(name)
      ) {
        expect(behaviorNames.has(name)).toBe(true);
      }
    }
    expect(
      catalog.variants.filter(({ fields }) =>
        fields.some(({ name }) => name === 'control_behavior'),
      ),
    ).toHaveLength(47);
  });

  it('rejects a review manifest with a changed schema catalog count', async () => {
    const review = JSON.parse(
      await readFile(new URL('control-behavior-review.json', import.meta.url), 'utf8'),
    );
    review.expectedSchemaCatalogCounts.entityVariants -= 1;
    await expect(generateSchemaCatalog({ review })).rejects.toThrow(
      'Reviewed Blueprint schema catalog counts',
    );
  });
});

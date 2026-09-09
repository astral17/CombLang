import { describe, expect, test } from 'vitest';

import { generatePrototypeAsset, loadPrototypeAsset } from './generated-asset.js';

const dumpSource = JSON.stringify({
  item: {
    plate: { type: 'item', name: 'plate', stack_size: 100 },
  },
  fluid: {
    water: { type: 'fluid', name: 'water' },
  },
  recipe: {
    plate: {
      type: 'recipe',
      name: 'plate',
      ingredients: [],
      results: [{ type: 'item', name: 'plate', amount: 1 }],
    },
  },
  'recipe-category': {
    crafting: { type: 'recipe-category', name: 'crafting' },
  },
  quality: {
    normal: { type: 'quality', name: 'normal', level: 0 },
  },
  'virtual-signal': {
    'signal-A': { type: 'virtual-signal', name: 'signal-A' },
  },
});

const metadataSource = JSON.stringify({
  factorioVersion: '2.1.17',
  expansions: ['space-age'],
  mods: [
    { name: 'base', version: '2.1.17' },
    { name: 'space-age', version: '2.1.17' },
  ],
  startupSettings: [],
});

async function asset() {
  return generatePrototypeAsset(dumpSource, metadataSource);
}

describe('generated prototype assets', () => {
  test('regeneration is byte-identical and loading does not require raw input', async () => {
    const first = await asset();
    const second = await asset();

    expect(second.databaseJson).toBe(first.databaseJson);
    expect(second.manifestJson).toBe(first.manifestJson);
    const loaded = await loadPrototypeAsset(first.databaseJson, first.manifestJson);
    expect(loaded.prototypes.identity).toBe(first.manifest.databaseIdentity);
    expect(loaded.prototypes.item.plate).toMatchObject({ name: 'plate', stackSize: 100 });
  });

  test.each([
    ['raw dump', { rawDumpSource: `${dumpSource} `, metadataSource }],
    ['metadata', { rawDumpSource: dumpSource, metadataSource: `${metadataSource} ` }],
  ] as const)('rejects stale %s input hashes', async (_label, inputs) => {
    const generated = await asset();

    await expect(
      loadPrototypeAsset(generated.databaseJson, generated.manifestJson, inputs),
    ).rejects.toMatchObject({ code: 'PA1004' });
  });

  test('rejects stale output bytes', async () => {
    const generated = await asset();

    await expect(
      loadPrototypeAsset(`${generated.databaseJson}\n`, generated.manifestJson),
    ).rejects.toMatchObject({ code: 'PA1003' });
  });

  test('rejects malformed metadata before writing an asset', async () => {
    await expect(generatePrototypeAsset(dumpSource, '{')).rejects.toMatchObject({
      code: 'PI1003',
    });
  });

  test('rejects a manifest identity that does not match the database', async () => {
    const generated = await asset();
    const manifest = JSON.parse(generated.manifestJson) as {
      databaseIdentity: string;
    };
    manifest.databaseIdentity = `comblang-prototypes-v1-sha256:${'0'.repeat(64)}`;

    await expect(
      loadPrototypeAsset(generated.databaseJson, JSON.stringify(manifest)),
    ).rejects.toMatchObject({ code: 'PA1005' });
  });

  test.each([
    ['top-level', { unexpected: true }, '<manifest>.unexpected'],
    ['input', { input: { unexpected: true } }, 'input.unexpected'],
  ] as const)('rejects unknown %s manifest fields', async (_label, extra, path) => {
    const generated = await asset();
    const manifest = JSON.parse(generated.manifestJson) as Record<string, unknown>;
    const changed =
      'input' in extra
        ? { ...manifest, input: { ...(manifest.input as object), ...extra.input } }
        : { ...manifest, ...extra };

    await expect(
      loadPrototypeAsset(generated.databaseJson, JSON.stringify(changed)),
    ).rejects.toMatchObject({ code: 'PA1001', path });
  });
});

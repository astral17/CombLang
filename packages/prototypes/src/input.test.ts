import { describe, expect, test } from 'vitest';

import { syntheticPrototypeDatabase } from './fixtures.js';
import {
  FactorioDumpError,
  loadPrototypeInputJson,
  PrototypeInputError,
  type FactorioDumpMetadata,
} from './index.js';

const metadata: FactorioDumpMetadata = {
  factorioVersion: '2.1.17',
  expansions: ['space-age'],
  mods: [
    { name: 'base', version: '2.1.17' },
    { name: 'space-age', version: '2.1.17' },
  ],
};

function rawFixture(): unknown {
  return {
    item: { 'iron-plate': { type: 'item', name: 'iron-plate', stack_size: 100 } },
    fluid: { water: { type: 'fluid', name: 'water' } },
    recipe: {
      'iron-plate': {
        type: 'recipe',
        name: 'iron-plate',
        ingredients: {},
        results: [{ type: 'item', name: 'iron-plate', amount: 1 }],
      },
    },
    'recipe-category': { crafting: { type: 'recipe-category', name: 'crafting' } },
    quality: { normal: { type: 'quality', name: 'normal', level: 0 } },
    'virtual-signal': { 'signal-A': { type: 'virtual-signal', name: 'signal-A' } },
    'assembling-machine': {
      'footprint-less': {
        type: 'assembling-machine',
        name: 'footprint-less',
        crafting_categories: ['crafting'],
      },
    },
  };
}

describe('shared prototype input loader', () => {
  test('loads valid normalized input and preserves detailed normalized errors', async () => {
    const loaded = await loadPrototypeInputJson(JSON.stringify(syntheticPrototypeDatabase()));
    expect(loaded.format).toBe('normalized');
    expect(loaded.warnings).toEqual([]);

    await expect(loadPrototypeInputJson(JSON.stringify({ schemaVersion: 1 }))).rejects.toEqual(
      expect.objectContaining({ code: 'PT1001', path: 'recipes' }),
    );
    const partial = structuredClone(syntheticPrototypeDatabase()) as {
      entities: Array<Record<string, unknown>>;
    };
    delete partial.entities[0]!.tileHeight;
    await expect(loadPrototypeInputJson(JSON.stringify(partial))).rejects.toEqual(
      expect.objectContaining({ code: 'PT1004', path: 'entities[0]' }),
    );
  });

  test('loads raw data with metadata, including a footprint-less recognized Entity', async () => {
    const loaded = await loadPrototypeInputJson(JSON.stringify(rawFixture()), {
      factorioDumpMetadata: JSON.stringify(metadata),
    });
    expect(loaded.format).toBe('factorio-data-raw');
    expect(loaded.prototypes.entity['footprint-less']).toMatchObject({
      type: 'assembling-machine',
      crafting: { categories: ['crafting'] },
    });
    expect(loaded.prototypes.entity['footprint-less']).not.toHaveProperty('tileWidth');
    expect(loaded.warnings).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'PD2002' })]),
    );
  });

  test('unwraps a data.raw envelope and requires valid companion metadata', async () => {
    const loaded = await loadPrototypeInputJson(JSON.stringify({ data: { raw: rawFixture() } }), {
      factorioDumpMetadata: metadata,
    });
    expect(loaded.format).toBe('factorio-data-raw');

    await expect(loadPrototypeInputJson(JSON.stringify(rawFixture()))).rejects.toEqual(
      expect.objectContaining({ code: 'PI1002', path: 'factorioDumpMetadata' }),
    );
    await expect(
      loadPrototypeInputJson(JSON.stringify(rawFixture()), {
        factorioDumpMetadata: JSON.stringify({ factorioVersion: '2.1.17' }),
      }),
    ).rejects.toEqual(
      expect.objectContaining({ code: 'PI1003', path: 'factorioDumpMetadata.expansions' }),
    );
  });

  test('keeps raw validation errors distinct from unsupported JSON', async () => {
    await expect(
      loadPrototypeInputJson(JSON.stringify({ recipe: null }), {
        factorioDumpMetadata: metadata,
      }),
    ).rejects.toBeInstanceOf(FactorioDumpError);
    await expect(loadPrototypeInputJson(JSON.stringify({ answer: 42 }))).rejects.toEqual(
      expect.objectContaining({ code: 'PI1001', path: '<root>' }),
    );
    await expect(loadPrototypeInputJson('{')).rejects.toEqual(
      expect.objectContaining({ code: 'PT1006', path: '<json>' }),
    );
    expect(new PrototypeInputError('PI1001', '<root>', 'test')).toBeInstanceOf(Error);
  });

  test('preserves the precise path for invalid nested startup settings', async () => {
    await expect(
      loadPrototypeInputJson(JSON.stringify(rawFixture()), {
        factorioDumpMetadata: JSON.stringify({
          ...metadata,
          startupSettings: [{ name: 'mode', value: { r: 'not-a-number' } }],
        }),
      }),
    ).rejects.toEqual(
      expect.objectContaining({
        code: 'PI1003',
        path: 'factorioDumpMetadata.startupSettings[0].value.r',
        message: 'factorioDumpMetadata.startupSettings[0].value.r: expected a finite number.',
      }),
    );
  });
});

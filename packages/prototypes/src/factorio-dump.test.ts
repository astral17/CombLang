import { describe, expect, test } from 'vitest';

import { normalizeFactorioDataDump } from './factorio-dump.js';
import { loadPrototypeDatabase } from './provider.js';

const metadata = {
  factorioVersion: '2.1.16',
  expansions: ['space-age'],
  mods: [
    { name: 'base', version: '2.1.16' },
    { name: 'space-age', version: '2.1.16' },
  ],
  startupSettingsIdentity: 'fixture-settings',
} as const;

function dumpFixture(): unknown {
  return {
    item: {
      'iron-plate': { type: 'item', name: 'iron-plate', stack_size: 100 },
    },
    capsule: {
      grenade: { type: 'capsule', name: 'grenade', stack_size: 100 },
    },
    fluid: {
      water: { type: 'fluid', name: 'water' },
    },
    recipe: {
      'iron-plate': {
        type: 'recipe',
        name: 'iron-plate',
        ingredients: [{ type: 'item', name: 'grenade', amount: 1 }],
        results: [{ type: 'item', name: 'iron-plate', amount: 1 }],
      },
      'heated-water': {
        type: 'recipe',
        name: 'heated-water',
        categories: ['chemistry', 'crafting-with-fluid'],
        energy_required: 2,
        enabled: false,
        ingredients: {},
        results: [
          {
            type: 'fluid',
            name: 'water',
            amount: 10,
            temperature: 100,
            extra_count_fraction: 0.25,
          },
        ],
        main_product: 'water',
      },
      'recipe-unknown': {
        type: 'recipe',
        name: 'recipe-unknown',
        ingredients: {},
        results: {},
      },
    },
    'recipe-category': {
      crafting: { type: 'recipe-category', name: 'crafting' },
      chemistry: { type: 'recipe-category', name: 'chemistry' },
      'crafting-with-fluid': {
        type: 'recipe-category',
        name: 'crafting-with-fluid',
      },
    },
    quality: {
      normal: { type: 'quality', name: 'normal', level: 0 },
    },
    'virtual-signal': {
      'signal-A': { type: 'virtual-signal', name: 'signal-A' },
    },
    'assembling-machine': {
      assembler: {
        type: 'assembling-machine',
        name: 'assembler',
        collision_box: [
          [-1.2, -1.2],
          [1.2, 1.2],
        ],
        selection_box: [
          [-1.5, -1.5],
          [1.5, 1.5],
        ],
        crafting_categories: ['crafting', 'crafting-with-fluid'],
        fluid_boxes: [{ production_type: 'input' }],
        circuit_wire_max_distance: 9,
      },
    },
  };
}

describe('Factorio data-raw-dump normalizer', () => {
  test('retains correlated product ranges and explicit statistics/productivity amounts', async () => {
    const dump = dumpFixture() as {
      recipe: Record<string, { ingredients: unknown; results: unknown }>;
    };
    dump.recipe['iron-plate']!.ingredients = [
      { type: 'item', name: 'grenade', amount: 1, ignored_by_stats: 0 },
    ];
    dump.recipe['iron-plate']!.results = [
      {
        type: 'item',
        name: 'iron-plate',
        amount: 1,
        independent_probability: 0.5,
        shared_probability: { min: 0, max: 0.2 },
        ignored_by_stats: 0,
        ignored_by_productivity: 3,
      },
      { type: 'item', name: 'grenade', amount: 1, shared_probability: { min: 0.2, max: 1 } },
    ];
    const normalized = normalizeFactorioDataDump(dump, metadata);
    const { prototypes } = await loadPrototypeDatabase(
      JSON.parse(JSON.stringify(normalized.database)),
    );
    const recipe = prototypes.recipe['iron-plate']!;
    expect(recipe.ingredients[0]).toMatchObject({ ignoredByStats: 0 });
    expect(recipe.products).toEqual([
      {
        prototype: 'item:iron-plate',
        amount: 1,
        independentProbability: 0.5,
        sharedProbability: { min: 0, max: 0.2 },
        ignoredByStats: 0,
        ignoredByProductivity: 3,
      },
      { prototype: 'item:grenade', amount: 1, sharedProbability: { min: 0.2, max: 1 } },
    ]);
    expect(Object.isFrozen(recipe.products[0]!.sharedProbability)).toBe(true);
    expect(normalized.warnings.some(({ path }) => /probability|ignored_by/.test(path))).toBe(false);
  });

  test('rejects malformed raw shared probability with its dump path', () => {
    const dump = dumpFixture() as { recipe: Record<string, { results: unknown }> };
    dump.recipe['iron-plate']!.results = [
      { type: 'item', name: 'iron-plate', amount: 1, shared_probability: { min: 0 } },
    ];
    expect(() => normalizeFactorioDataDump(dump, metadata)).toThrowError(
      expect.objectContaining({
        code: 'PD1001',
        path: 'recipe.iron-plate.results[0].shared_probability.max',
      }),
    );
  });

  test('normalizes defaults, item subtypes, categories, temperature, and entities', async () => {
    const normalized = normalizeFactorioDataDump(dumpFixture(), metadata);
    const { database, prototypes } = await loadPrototypeDatabase(normalized.database);

    expect(database.environment.generatorVersion).toBe('comblang-factorio-data-dump-v1.1');
    expect(prototypes.item.grenade?.stackSize).toBe(100);
    expect(prototypes.recipe['iron-plate']).toMatchObject({
      categories: ['crafting'],
      energy: 0.5,
      enabledByDefault: true,
    });
    expect(prototypes.recipe['heated-water']).toMatchObject({
      categories: ['chemistry', 'crafting-with-fluid'],
      energy: 2,
      enabledByDefault: false,
      mainProduct: 'fluid:water',
      products: [{ prototype: 'fluid:water', amount: 10, temperature: 100 }],
    });
    expect(prototypes.entity.assembler).toMatchObject({
      tileWidth: 3,
      tileHeight: 3,
      crafting: { categories: ['crafting', 'crafting-with-fluid'], supportsFluids: true },
    });
    expect(prototypes.canCraft('assembler', 'heated-water')).toBe(true);
    expect(() => prototypes.entityCircuitCapabilities('assembler')).toThrow(
      'Prototype database does not provide entityCircuitCapabilities data.',
    );
    expect(normalized.warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'PD2001', path: 'recipe.recipe-unknown' }),
        expect.objectContaining({ code: 'PD2002', path: 'entities.*.circuit' }),
      ]),
    );
  });

  test('preserves zero-base probabilistic extra counts used by recycling recipes', () => {
    const dump = dumpFixture() as {
      recipe: Record<string, { results: unknown }>;
    };
    dump.recipe['heated-water']!.results = [
      { type: 'fluid', name: 'water', amount: 0, extra_count_fraction: 0.25 },
    ];

    expect(normalizeFactorioDataDump(dump, metadata).database.recipes[0]?.products).toEqual([
      { prototype: 'fluid:water', amount: 0, extraCountFraction: 0.25 },
    ]);
  });

  test('accepts the older singular recipe category dump shape', () => {
    const dump = dumpFixture() as {
      recipe: Record<string, { categories?: unknown; category?: unknown }>;
    };
    delete dump.recipe['iron-plate']!.categories;
    dump.recipe['iron-plate']!.category = 'chemistry';

    const recipe = normalizeFactorioDataDump(dump, metadata).database.recipes.find(
      ({ name }) => name === 'iron-plate',
    );
    expect(recipe?.categories).toEqual(['chemistry']);
  });

  test('rejects a mismatched dump table identity', () => {
    const dump = dumpFixture() as { item: Record<string, { name: string }> };
    dump.item['iron-plate']!.name = 'copper-plate';

    expect(() => normalizeFactorioDataDump(dump, metadata)).toThrowError(
      expect.objectContaining({ code: 'PD1001', path: 'item.iron-plate' }),
    );
  });
});

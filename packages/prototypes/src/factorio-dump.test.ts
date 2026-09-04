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
  test.each(['enabled', 'allow_productivity', 'hidden', 'main_product'])(
    'rejects malformed raw %s instead of silently replacing it',
    (field) => {
      const dump = dumpFixture() as { recipe: Record<string, Record<string, unknown>> };
      dump.recipe['iron-plate']![field] = 1;
      expect(() => normalizeFactorioDataDump(dump, metadata)).toThrowError(
        expect.objectContaining({ code: 'PD1001', path: `recipe.iron-plate.${field}` }),
      );
    },
  );

  test('requires an unambiguous existing main product but allows repeated rows in one namespace', () => {
    const dump = dumpFixture() as {
      recipe: Record<string, Record<string, unknown>>;
      fluid: Record<string, unknown>;
    };
    const recipe = dump.recipe['iron-plate']!;
    recipe.main_product = 'missing';
    const invalid = () =>
      expect(() => normalizeFactorioDataDump(dump, metadata)).toThrowError(
        expect.objectContaining({ code: 'PD1001', path: 'recipe.iron-plate.main_product' }),
      );
    invalid();
    recipe.main_product = 'iron-plate';
    recipe.results = [
      { type: 'item', name: 'iron-plate', amount: 1 },
      { type: 'item', name: 'iron-plate', amount: 2 },
    ];
    expect(
      normalizeFactorioDataDump(dump, metadata).database.recipes.find(
        ({ name }) => name === 'iron-plate',
      )?.mainProduct,
    ).toBe('item:iron-plate');
    dump.fluid['iron-plate'] = { type: 'fluid', name: 'iron-plate' };
    (recipe.results as unknown[]).push({ type: 'fluid', name: 'iron-plate', amount: 1 });
    invalid();
    recipe.main_product = '';
    expect(
      normalizeFactorioDataDump(dump, metadata).database.recipes.find(
        ({ name }) => name === 'iron-plate',
      )?.mainProduct,
    ).toBeUndefined();
  });

  test.each([[], {}])(
    'retains empty-output recipes, including recipes that consume ingredients (%j)',
    async (results) => {
      const dump = dumpFixture() as { recipe: Record<string, Record<string, unknown>> };
      dump.recipe['iron-plate']!.results = results;
      const normalized = normalizeFactorioDataDump(dump, metadata);
      const { prototypes } = await loadPrototypeDatabase(
        JSON.parse(JSON.stringify(normalized.database)),
      );
      expect(prototypes.recipe['iron-plate']).toMatchObject({
        ingredients: [{ prototype: 'item:grenade', amount: 1 }],
        products: [],
      });
      expect(prototypes.recipesProducing('item:iron-plate')).toEqual([]);
      expect(normalized.warnings.some(({ path }) => path.startsWith('recipe.'))).toBe(false);
    },
  );

  test('maps raw quality chains and validates bounds through their next edges', () => {
    const dump = dumpFixture() as {
      quality: Record<string, unknown>;
      recipe: Record<string, { results: unknown }>;
    };
    dump.quality.normal = { type: 'quality', name: 'normal', level: 0, next: 'rare' };
    dump.quality.rare = { type: 'quality', name: 'rare', level: 2 };
    dump.recipe['iron-plate']!.results = [
      { type: 'item', name: 'iron-plate', amount: 1, quality_min: 'normal', quality_max: 'rare' },
    ];
    const result = normalizeFactorioDataDump(dump, metadata);
    expect(result.database.qualities).toEqual([
      { key: 'quality:normal', name: 'normal', level: 0, next: 'quality:rare' },
      { key: 'quality:rare', name: 'rare', level: 2, next: null },
    ]);
  });

  test.each([
    ['quality_min', 1],
    ['quality_max', ''],
    ['affected_by_quality', 0],
  ])('rejects malformed raw %s with a dump path', (field, value) => {
    const dump = dumpFixture() as { recipe: Record<string, { results: unknown }> };
    dump.recipe['iron-plate']!.results = [
      { type: 'item', name: 'iron-plate', amount: 1, [field as string]: value },
    ];
    expect(() => normalizeFactorioDataDump(dump, metadata)).toThrowError(
      expect.objectContaining({ code: 'PD1001', path: `recipe.iron-plate.results[0].${field}` }),
    );
  });
  test('retains explicit startup setting metadata without replacing a legacy identity label', () => {
    const startupSettings = [
      { name: 'mode', value: false },
      { name: 'count', value: 0 },
    ];
    const result = normalizeFactorioDataDump(dumpFixture(), { ...metadata, startupSettings });
    expect(result.database.environment.startupSettings).toEqual([...startupSettings].reverse());
    expect(result.database.environment.startupSettingsIdentity).toBe(
      metadata.startupSettingsIdentity,
    );
    expect(Object.isFrozen(result.database.environment.startupSettings)).toBe(true);
  });
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

    expect(database.environment.generatorVersion).toBe('comblang-factorio-data-dump-v1.5');
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
    expect(prototypes.isBasicCraftingCompatible('assembler', 'heated-water')).toBe(true);
    expect(() => prototypes.entityCircuitCapabilities('assembler')).toThrow(
      'Prototype database does not provide entityCircuitCapabilities data for entity:assembler.',
    );
    expect(normalized.warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'PD2002', path: 'entities.*.circuit' }),
      ]),
    );
    expect(prototypes.recipe['recipe-unknown']?.products).toEqual([]);
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

  test('round-trips item spoilage and fluid routing through JSON and the provider', async () => {
    const dump = dumpFixture() as {
      recipe: Record<string, { ingredients: unknown; results: unknown }>;
    };
    dump.recipe['iron-plate']!.ingredients = [
      { type: 'item', name: 'grenade', amount: 1, spoil_weight: 0 },
    ];
    dump.recipe['iron-plate']!.results = [
      {
        type: 'item',
        name: 'iron-plate',
        amount: 1,
        percent_spoiled: 0.5,
        always_fresh: false,
        reset_freshness_on_craft: true,
      },
    ];
    dump.recipe['heated-water']!.ingredients = [
      {
        type: 'fluid',
        name: 'water',
        amount: 10,
        fluidbox_index: 0,
        fluidbox_multiplier: 1,
        optional_fluidbox_indexes: [3, 2],
      },
    ];
    dump.recipe['heated-water']!.results = [
      {
        type: 'fluid',
        name: 'water',
        amount: 10,
        fluidbox_index: 1,
        fluidbox_multiplier: 255,
        optional_fluidbox_indexes: {},
      },
    ];
    const normalized = normalizeFactorioDataDump(dump, metadata);
    const { prototypes } = await loadPrototypeDatabase(
      JSON.parse(JSON.stringify(normalized.database)),
    );
    expect(prototypes.recipe['iron-plate']!.ingredients[0]).toMatchObject({ spoilWeight: 0 });
    expect(prototypes.recipe['iron-plate']!.products[0]).toMatchObject({
      percentSpoiled: 0.5,
      alwaysFresh: false,
      resetFreshnessOnCraft: true,
    });
    expect(prototypes.recipe['heated-water']!.ingredients[0]).toMatchObject({
      fluidboxIndex: 0,
      fluidboxMultiplier: 1,
      optionalFluidboxIndexes: [3, 2],
    });
    expect(prototypes.recipe['heated-water']!.products[0]).toMatchObject({
      fluidboxIndex: 1,
      fluidboxMultiplier: 255,
      optionalFluidboxIndexes: [],
    });
    expect(normalized.warnings.some(({ path }) => /spoil|fresh|fluidbox/.test(path))).toBe(false);
  });

  test.each([
    ['always_fresh', 1, 'always_fresh'],
    ['optional_fluidbox_indexes', { first: 1 }, 'optional_fluidbox_indexes'],
    ['optional_fluidbox_indexes', ['2'], 'optional_fluidbox_indexes[0]'],
  ])('reports malformed raw %s with its dump path', (field, value, suffix) => {
    const dump = dumpFixture() as { recipe: Record<string, { results: unknown }> };
    dump.recipe['heated-water']!.results = [
      { type: 'fluid', name: 'water', amount: 10, [field as string]: value },
    ];
    expect(() => normalizeFactorioDataDump(dump, metadata)).toThrowError(
      expect.objectContaining({ code: 'PD1001', path: `recipe.heated-water.results[0].${suffix}` }),
    );
  });

  test('retains item quality transforms and explicit chain terminals without loss warnings', async () => {
    const dump = dumpFixture() as {
      recipe: Record<string, { results: unknown; ingredients: unknown }>;
    };
    dump.recipe['iron-plate']!.ingredients = [
      {
        type: 'item',
        name: 'grenade',
        amount: 1,
        quality_change: -1,
        quality_min: 'normal',
        quality_max: 'normal',
      },
    ];
    dump.recipe['iron-plate']!.results = [
      {
        type: 'item',
        name: 'iron-plate',
        amount: 1,
        affected_by_quality: false,
        quality_change: 1,
        quality_min: 'normal',
        quality_max: 'normal',
      },
    ];
    const { warnings, database } = normalizeFactorioDataDump(dump, metadata);
    const { prototypes } = await loadPrototypeDatabase(JSON.parse(JSON.stringify(database)));
    expect(prototypes.recipe['iron-plate']!.products[0]).toMatchObject({
      affectedByQuality: false,
      qualityChange: 1,
      qualityMin: 'quality:normal',
      qualityMax: 'quality:normal',
    });
    expect(prototypes.recipe['iron-plate']!.ingredients[0]).toMatchObject({
      qualityChange: -1,
      qualityMin: 'quality:normal',
      qualityMax: 'quality:normal',
    });
    expect(prototypes.quality.normal!.next).toBeNull();
    for (const field of ['affected_by_quality', 'quality_change']) {
      expect(warnings.some(({ path }) => path.includes(field))).toBe(false);
    }
  });
});

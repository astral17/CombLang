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
        flags: ['placeable-player', 'player-creation'],
        collision_box: [
          [-1.2, -1.2],
          [1.2, 1.2],
        ],
        selection_box: [
          [-5, -5],
          [5, 5],
        ],
        crafting_categories: ['crafting', 'crafting-with-fluid'],
        fluid_boxes: [{ production_type: 'input' }],
        circuit_wire_max_distance: 9,
      },
    },
  };
}

type RawDumpTable = Record<string, Record<string, unknown>>;

interface RawDumpFixture {
  [table: string]: RawDumpTable | undefined;
  capsule: RawDumpTable;
  fluid: RawDumpTable;
  item: RawDumpTable;
  recipe: RawDumpTable;
}

function ingredientOrderDumpFixture(): RawDumpFixture {
  const dump = dumpFixture() as RawDumpFixture;
  dump['item-group'] = {
    'group-override': {
      type: 'item-group',
      name: 'group-override',
      order: 'z',
      order_in_recipe: 'a',
    },
    'group-fallback': { type: 'item-group', name: 'group-fallback', order: 'b' },
    'group-alpha': { type: 'item-group', name: 'group-alpha', order_in_recipe: 'c' },
    'group-beta': { type: 'item-group', name: 'group-beta', order_in_recipe: 'c' },
    'group-subgroup': { type: 'item-group', name: 'group-subgroup', order_in_recipe: 'd' },
    'group-item': { type: 'item-group', name: 'group-item', order_in_recipe: 'e' },
  };
  dump['item-subgroup'] = {
    'sub-override': {
      type: 'item-subgroup',
      name: 'sub-override',
      group: 'group-override',
      order: 'a',
    },
    'sub-fallback': {
      type: 'item-subgroup',
      name: 'sub-fallback',
      group: 'group-fallback',
      order: 'a',
    },
    'sub-alpha': { type: 'item-subgroup', name: 'sub-alpha', group: 'group-alpha', order: 'a' },
    'sub-beta': { type: 'item-subgroup', name: 'sub-beta', group: 'group-beta', order: 'a' },
    'sub-first': { type: 'item-subgroup', name: 'sub-first', group: 'group-subgroup', order: 'a' },
    'sub-later': { type: 'item-subgroup', name: 'sub-later', group: 'group-subgroup', order: 'b' },
    'sub-tie-alpha': {
      type: 'item-subgroup',
      name: 'sub-tie-alpha',
      group: 'group-subgroup',
      order: 'c',
    },
    'sub-tie-zeta': {
      type: 'item-subgroup',
      name: 'sub-tie-zeta',
      group: 'group-subgroup',
      order: 'c',
    },
    'sub-items': { type: 'item-subgroup', name: 'sub-items', group: 'group-item', order: 'a' },
  };
  const addItem = (
    table: string,
    name: string,
    subgroup: string,
    order: string,
    extra: Record<string, unknown> = {},
  ) => {
    dump[table] ??= {};
    dump[table]![name] = {
      type: table,
      name,
      stack_size: 100,
      subgroup,
      order,
      ...extra,
    };
  };
  addItem('item', 'override-alpha', 'sub-override', 'a');
  addItem('tool', 'tool-late', 'sub-override', 'z');
  addItem('item', 'fallback-item', 'sub-fallback', 'a');
  addItem('item', 'group-alpha-item', 'sub-alpha', 'a');
  addItem('item', 'group-beta-item', 'sub-beta', 'a');
  addItem('item', 'subgroup-first-item', 'sub-first', 'z');
  addItem('item', 'subgroup-later-item', 'sub-later', 'a');
  addItem('item', 'subgroup-tie-alpha-item', 'sub-tie-alpha', 'z');
  addItem('item', 'subgroup-tie-zeta-item', 'sub-tie-zeta', 'a');
  addItem('item', 'item-order-first', 'sub-items', 'a');
  addItem('item', 'item-name-alpha', 'sub-items', 'x');
  addItem('item', 'item-name-zeta', 'sub-items', 'x');
  dump.fluid['petroleum-gas'] = { type: 'fluid', name: 'petroleum-gas' };
  return dump;
}

function malformedIngredientOrderDump(mutate: (dump: RawDumpFixture) => void): RawDumpFixture {
  const dump = dumpFixture() as RawDumpFixture;
  dump.recipe['iron-plate']!.ingredients = [{ type: 'item', name: 'grenade', amount: 1 }];
  dump.capsule.grenade!.subgroup = 'sub';
  dump['item-subgroup'] = {
    sub: { type: 'item-subgroup', name: 'sub', group: 'group', order: 'a' },
  };
  dump['item-group'] = {
    group: { type: 'item-group', name: 'group', order: 'a' },
  };
  mutate(dump);
  return dump;
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
    expect(
      normalizeFactorioDataDump(dump, metadata).database.recipes.find(
        ({ name }) => name === 'iron-plate',
      )?.products,
    ).toEqual([
      { prototype: 'item:iron-plate', amount: 1 },
      { prototype: 'item:iron-plate', amount: 2 },
    ]);
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

  test.each([
    {
      title: 'amount minimum on ingredient',
      recipe: 'iron-plate',
      role: 'ingredients',
      rawField: 'amount_min',
      normalizedField: 'amountMin',
      value: 1,
    },
    {
      title: 'amount maximum on ingredient',
      recipe: 'iron-plate',
      role: 'ingredients',
      rawField: 'amount_max',
      normalizedField: 'amountMax',
      value: 2,
    },
    {
      title: 'legacy probability on ingredient',
      recipe: 'iron-plate',
      role: 'ingredients',
      rawField: 'probability',
      normalizedField: 'probability',
      value: 0.5,
    },
    {
      title: 'independent probability on ingredient',
      recipe: 'iron-plate',
      role: 'ingredients',
      rawField: 'independent_probability',
      normalizedField: 'independentProbability',
      value: 0.5,
    },
    {
      title: 'shared probability on ingredient',
      recipe: 'iron-plate',
      role: 'ingredients',
      rawField: 'shared_probability',
      normalizedField: 'sharedProbability',
      value: { min: 0, max: 1 },
    },
    {
      title: 'ignored productivity on ingredient',
      recipe: 'iron-plate',
      role: 'ingredients',
      rawField: 'ignored_by_productivity',
      normalizedField: 'ignoredByProductivity',
      value: 0,
    },
    {
      title: 'extra count fraction on fluid product',
      recipe: 'heated-water',
      role: 'products',
      rawField: 'extra_count_fraction',
      normalizedField: 'extraCountFraction',
      value: 0.25,
    },
    {
      title: 'quality roll on fluid product',
      recipe: 'heated-water',
      role: 'products',
      rawField: 'affected_by_quality',
      normalizedField: 'affectedByQuality',
      value: false,
    },
    {
      title: 'quality change on fluid product',
      recipe: 'heated-water',
      role: 'products',
      rawField: 'quality_change',
      normalizedField: 'qualityChange',
      value: 1,
    },
    {
      title: 'quality minimum on fluid product',
      recipe: 'heated-water',
      role: 'products',
      rawField: 'quality_min',
      normalizedField: 'qualityMin',
      value: 'normal',
    },
    {
      title: 'quality maximum on fluid product',
      recipe: 'heated-water',
      role: 'products',
      rawField: 'quality_max',
      normalizedField: 'qualityMax',
      value: 'normal',
    },
    {
      title: 'spoil percentage on fluid product',
      recipe: 'heated-water',
      role: 'products',
      rawField: 'percent_spoiled',
      normalizedField: 'percentSpoiled',
      value: 0.5,
    },
    {
      title: 'freshness flag on fluid product',
      recipe: 'heated-water',
      role: 'products',
      rawField: 'always_fresh',
      normalizedField: 'alwaysFresh',
      value: false,
    },
    {
      title: 'freshness reset on fluid product',
      recipe: 'heated-water',
      role: 'products',
      rawField: 'reset_freshness_on_craft',
      normalizedField: 'resetFreshnessOnCraft',
      value: true,
    },
    {
      title: 'spoil weight on fluid ingredient',
      recipe: 'heated-water',
      role: 'ingredients',
      rawField: 'spoil_weight',
      normalizedField: 'spoilWeight',
      value: 0,
    },
    {
      title: 'fluidbox index on item product',
      recipe: 'iron-plate',
      role: 'products',
      rawField: 'fluidbox_index',
      normalizedField: 'fluidboxIndex',
      value: 0,
    },
    {
      title: 'fluidbox multiplier on item product',
      recipe: 'iron-plate',
      role: 'products',
      rawField: 'fluidbox_multiplier',
      normalizedField: 'fluidboxMultiplier',
      value: 1,
    },
    {
      title: 'optional fluidbox indexes on item product',
      recipe: 'iron-plate',
      role: 'products',
      rawField: 'optional_fluidbox_indexes',
      normalizedField: 'optionalFluidboxIndexes',
      value: {},
    },
    {
      title: 'temperature on item product',
      recipe: 'iron-plate',
      role: 'products',
      rawField: 'temperature',
      normalizedField: 'temperature',
      value: 50,
    },
    {
      title: 'minimum temperature on item ingredient',
      recipe: 'iron-plate',
      role: 'ingredients',
      rawField: 'minimum_temperature',
      normalizedField: 'temperatureMin',
      value: 10,
    },
    {
      title: 'maximum temperature on item ingredient',
      recipe: 'iron-plate',
      role: 'ingredients',
      rawField: 'maximum_temperature',
      normalizedField: 'temperatureMax',
      value: 100,
    },
    {
      title: 'minimum temperature on fluid product',
      recipe: 'heated-water',
      role: 'products',
      rawField: 'minimum_temperature',
      normalizedField: 'temperatureMin',
      value: 10,
    },
    {
      title: 'maximum temperature on fluid product',
      recipe: 'heated-water',
      role: 'products',
      rawField: 'maximum_temperature',
      normalizedField: 'temperatureMax',
      value: 100,
    },
  ] as const)('warns and omits inapplicable raw fields: $title', (caseData) => {
    const dump = dumpFixture() as {
      recipe: Record<string, { ingredients: unknown[]; results: unknown[] }>;
    };
    const recipe = dump.recipe[caseData.recipe]!;
    if (caseData.role === 'ingredients' && !Array.isArray(recipe.ingredients)) {
      recipe.ingredients = [{ type: 'fluid', name: 'water', amount: 10 }];
    }
    const rawComponents = caseData.role === 'products' ? recipe.results : recipe.ingredients;
    Object.assign(rawComponents[0] as Record<string, unknown>, {
      [caseData.rawField]: caseData.value,
    });

    const normalized = normalizeFactorioDataDump(dump, metadata);
    const warning = normalized.warnings.filter(({ code }) => code === 'PD2003');
    expect(warning).toEqual([
      expect.objectContaining({
        code: 'PD2003',
        path: `recipe.${caseData.recipe}.${caseData.role === 'products' ? 'results' : 'ingredients'}[0].${caseData.rawField}`,
        message: expect.stringContaining('retained by data.raw'),
      }),
    ]);
    const normalizedRecipe = normalized.database.recipes.find(
      ({ name }) => name === caseData.recipe,
    )!;
    const component =
      caseData.role === 'products' ? normalizedRecipe.products[0] : normalizedRecipe.ingredients[0];
    expect(component).not.toHaveProperty(caseData.normalizedField);
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

  test.each([
    {
      title: 'zero item product',
      recipe: 'iron-plate',
      role: 'results',
      component: { type: 'item', name: 'iron-plate', amount: 0 },
      expected: { prototype: 'item:iron-plate', amount: 0 },
    },
    {
      title: 'zero fluid product',
      recipe: 'heated-water',
      role: 'results',
      component: { type: 'fluid', name: 'water', amount: 0 },
      expected: { prototype: 'fluid:water', amount: 0 },
    },
    {
      title: 'zero to uint16 item product range',
      recipe: 'iron-plate',
      role: 'results',
      component: { type: 'item', name: 'iron-plate', amount_min: 0, amount_max: 65535 },
      expected: { prototype: 'item:iron-plate', amountMin: 0, amountMax: 65535 },
    },
    {
      title: 'zero fluid product range',
      recipe: 'heated-water',
      role: 'results',
      component: { type: 'fluid', name: 'water', amount_min: 0, amount_max: 0 },
      expected: { prototype: 'fluid:water', amountMin: 0, amountMax: 0 },
    },
  ] as const)('accepts raw amount boundary: $title', (caseData) => {
    const dump = dumpFixture() as {
      recipe: Record<string, { ingredients: unknown; results: unknown }>;
    };
    dump.recipe[caseData.recipe]![caseData.role] = [caseData.component];
    const normalized = normalizeFactorioDataDump(dump, metadata);
    const recipe = normalized.database.recipes.find(({ name }) => name === caseData.recipe)!;
    expect(recipe.products[0]).toMatchObject(caseData.expected);
  });

  test('accepts a positive fluid ingredient but rejects a zero fluid ingredient at its raw path', () => {
    const dump = dumpFixture() as {
      recipe: Record<string, { ingredients: unknown; results: unknown }>;
    };
    dump.recipe['heated-water']!.ingredients = [{ type: 'fluid', name: 'water', amount: 0 }];
    expect(() => normalizeFactorioDataDump(dump, metadata)).toThrowError(
      expect.objectContaining({
        code: 'PD1001',
        path: 'recipe.heated-water.ingredients[0].amount',
      }),
    );
    dump.recipe['heated-water']!.ingredients = [{ type: 'fluid', name: 'water', amount: 0.25 }];
    expect(
      normalizeFactorioDataDump(dump, metadata).database.recipes.find(
        ({ name }) => name === 'heated-water',
      )?.ingredients,
    ).toEqual([{ prototype: 'fluid:water', amount: 0.25 }]);
  });

  test.each([
    [
      'item fractional exact amount',
      'iron-plate',
      'results',
      { type: 'item', name: 'iron-plate', amount: 1.5 },
      'amount',
    ],
    [
      'item overflowing exact amount',
      'iron-plate',
      'results',
      { type: 'item', name: 'iron-plate', amount: 65536 },
      'amount',
    ],
    [
      'item fractional range minimum',
      'iron-plate',
      'results',
      { type: 'item', name: 'iron-plate', amount_min: 1.5, amount_max: 2 },
      'amount_min',
    ],
    [
      'item overflowing range maximum',
      'iron-plate',
      'results',
      { type: 'item', name: 'iron-plate', amount_min: 1, amount_max: 65536 },
      'amount_max',
    ],
    [
      'fluid negative exact amount',
      'heated-water',
      'results',
      { type: 'fluid', name: 'water', amount: -0.1 },
      'amount',
    ],
    [
      'fluid negative range minimum',
      'heated-water',
      'results',
      { type: 'fluid', name: 'water', amount_min: -1, amount_max: 2 },
      'amount_min',
    ],
  ] as const)('rejects invalid raw amount: %s', (title, recipeName, role, component, field) => {
    const dump = dumpFixture() as {
      recipe: Record<string, { ingredients: unknown; results: unknown }>;
    };
    dump.recipe[recipeName]![role] = [component];
    expect(() => normalizeFactorioDataDump(dump, metadata)).toThrowError(
      expect.objectContaining({
        code: 'PD1001',
        path: `recipe.${recipeName}.${role}[0].${field}`,
      }),
    );
  });

  test.each([
    ['missing range maximum', { type: 'item', name: 'iron-plate', amount_min: 1 }, 'amount_max'],
    ['missing range minimum', { type: 'fluid', name: 'water', amount_max: 2 }, 'amount_min'],
    [
      'exact plus range',
      { type: 'item', name: 'iron-plate', amount: 1, amount_min: 1, amount_max: 2 },
      'amount',
    ],
  ] as const)('rejects malformed raw amount shape: %s', (title, component, field) => {
    const dump = dumpFixture() as {
      recipe: Record<string, { results: unknown }>;
    };
    dump.recipe['iron-plate']!.results = [component];
    expect(() => normalizeFactorioDataDump(dump, metadata)).toThrowError(
      expect.objectContaining({
        code: 'PD1001',
        path: `recipe.iron-plate.results[0].${field}`,
      }),
    );
  });

  test.each([
    [
      'descending item product range',
      'iron-plate',
      { type: 'item', name: 'iron-plate', amount_min: 4, amount_max: 2 },
      { amountMin: 4, amountMax: 4 },
    ],
    [
      'descending fluid product range',
      'heated-water',
      { type: 'fluid', name: 'water', amount_min: 4, amount_max: 2 },
      { amountMin: 4, amountMax: 4 },
    ],
  ] as const)(
    'normalizes the documented raw descending range: %s',
    (title, recipeName, component, expected) => {
      const dump = dumpFixture() as {
        recipe: Record<string, { results: unknown }>;
      };
      dump.recipe[recipeName]!.results = [component];
      const recipe = normalizeFactorioDataDump(dump, metadata).database.recipes.find(
        ({ name }) => name === recipeName,
      )!;
      expect(recipe.products[0]).toMatchObject({
        prototype: component.type + ':' + component.name,
        ...expected,
      });
    },
  );

  test('retains duplicate ingredient and product rows through JSON, provider, indexes, and identity', async () => {
    const dump = dumpFixture() as {
      recipe: Record<string, { ingredients: unknown; results: unknown }>;
    };
    dump.recipe['iron-plate']!.ingredients = [
      { type: 'item', name: 'grenade', amount: 1 },
      { type: 'item', name: 'grenade', amount: 1 },
    ];
    dump.recipe['iron-plate']!.results = [
      { type: 'item', name: 'iron-plate', amount: 1 },
      { type: 'item', name: 'iron-plate', amount: 1 },
      { type: 'fluid', name: 'water', amount: 0 },
    ];

    const normalized = normalizeFactorioDataDump(dump, metadata).database;
    const loaded = await loadPrototypeDatabase(JSON.parse(JSON.stringify(normalized)));
    const recipe = loaded.prototypes.recipe['iron-plate']!;
    expect(recipe.ingredients).toEqual([
      { prototype: 'item:grenade', amount: 1 },
      { prototype: 'item:grenade', amount: 1 },
    ]);
    expect(recipe.products).toEqual([
      { prototype: 'item:iron-plate', amount: 1 },
      { prototype: 'item:iron-plate', amount: 1 },
      { prototype: 'fluid:water', amount: 0 },
    ]);
    expect(loaded.prototypes.recipesProducing('item:iron-plate')).toEqual([
      expect.objectContaining({ key: 'recipe:iron-plate' }),
    ]);
    expect(loaded.prototypes.recipesProducing('fluid:water').map(({ key }) => key)).toEqual([
      'recipe:heated-water',
      'recipe:iron-plate',
    ]);

    const reorderedDump = dumpFixture() as {
      recipe: Record<string, { ingredients: unknown; results: unknown }>;
    };
    reorderedDump.recipe['iron-plate']!.ingredients = [
      { type: 'item', name: 'grenade', amount: 1 },
      { type: 'item', name: 'grenade', amount: 2 },
    ];
    reorderedDump.recipe['iron-plate']!.results = [
      { type: 'fluid', name: 'water', amount: 0 },
      { type: 'item', name: 'iron-plate', amount: 1 },
      { type: 'item', name: 'iron-plate', amount: 1 },
    ];
    const reordered = await loadPrototypeDatabase(
      JSON.parse(JSON.stringify(normalizeFactorioDataDump(reorderedDump, metadata).database)),
    );
    expect(reordered.prototypes.identity).not.toBe(loaded.prototypes.identity);
  });

  test('normalizes defaults, item subtypes, categories, temperature, and entities', async () => {
    const normalized = normalizeFactorioDataDump(dumpFixture(), metadata);
    const { database, prototypes } = await loadPrototypeDatabase(normalized.database);

    expect(database.environment.generatorVersion).toBe('comblang-factorio-data-dump-v1.11');
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
      blueprintEligible: true,
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

  test('derives blueprint eligibility from raw flags, including the empty default', () => {
    const dump = dumpFixture() as Record<string, Record<string, Record<string, unknown>>>;
    dump.projectile = {
      projectile: { type: 'projectile', name: 'projectile', flags: ['not-on-map'] },
    };
    dump.explosion = {
      explosion: { type: 'explosion', name: 'explosion', flags: ['not-blueprintable'] },
    };
    const normalized = normalizeFactorioDataDump(dump, metadata).database;
    expect(normalized.entities).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: 'entity:assembler', blueprintEligible: true }),
        expect.objectContaining({ key: 'entity:projectile', blueprintEligible: false }),
        expect.objectContaining({ key: 'entity:explosion', blueprintEligible: false }),
      ]),
    );

    delete dump['assembling-machine']!.assembler!.flags;
    const legacy = normalizeFactorioDataDump(dump, metadata).database.entities.find(
      ({ name }) => name === 'assembler',
    );
    expect(legacy).toMatchObject({ blueprintEligible: false });
  });

  test.each([
    ['not-an-array', 'expected an array of flag names.'],
    [['player-creation', 'player-creation'], 'duplicate flag name.'],
    [['player-creation', 1], 'expected a non-empty flag name.'],
  ] as const)('rejects malformed raw entity flags', (flags, message) => {
    const dump = dumpFixture() as {
      'assembling-machine': Record<string, Record<string, unknown>>;
    };
    dump['assembling-machine'].assembler!.flags = flags;
    expect(() => normalizeFactorioDataDump(dump, metadata)).toThrowError(
      expect.objectContaining({
        code: 'PD1001',
        path: expect.stringContaining('assembling-machine.assembler.flags'),
        message: expect.stringContaining(message),
      }),
    );
  });

  test('prefers explicit tile dimensions and falls back per axis to the collision box', () => {
    const dump = dumpFixture() as {
      'assembling-machine': Record<string, Record<string, unknown>>;
    };
    const assembler = dump['assembling-machine'].assembler!;
    assembler.tile_width = 2;
    assembler.tile_height = 3;
    expect(normalizeFactorioDataDump(dump, metadata).database.entities[0]).toMatchObject({
      tileWidth: 2,
      tileHeight: 3,
    });

    delete assembler.tile_height;
    expect(normalizeFactorioDataDump(dump, metadata).database.entities[0]).toMatchObject({
      tileWidth: 2,
      tileHeight: 3,
    });
  });

  test('retains catalog-recognized entities when ordinary footprint data is unavailable', () => {
    const dump = dumpFixture() as Record<string, Record<string, Record<string, unknown>>>;
    const assembler = dump['assembling-machine']!.assembler!;
    delete assembler.collision_box;
    delete assembler.tile_width;
    delete assembler.tile_height;
    dump['not-an-entity'] = {
      fake: {
        type: 'not-an-entity',
        name: 'fake',
        collision_box: [
          [-1, -1],
          [1, 1],
        ],
      },
    };

    const normalized = normalizeFactorioDataDump(dump, metadata);
    expect(normalized.database.entities).toEqual([
      expect.objectContaining({ key: 'entity:assembler', type: 'assembling-machine' }),
    ]);
    expect(normalized.database.entities[0]).not.toHaveProperty('tileWidth');
    expect(normalized.database.entities[0]).not.toHaveProperty('tileHeight');
  });

  test.each([
    ['tile_width', 0],
    ['tile_height', 1.5],
  ])('rejects invalid explicit entity %s', (field, value) => {
    const dump = dumpFixture() as {
      'assembling-machine': Record<string, Record<string, unknown>>;
    };
    dump['assembling-machine'].assembler![field] = value;
    expect(() => normalizeFactorioDataDump(dump, metadata)).toThrowError(
      expect.objectContaining({
        code: 'PD1001',
        path: `assembling-machine.assembler.${field}`,
      }),
    );
  });

  test('warns and omits an inapplicable fluid product extra count', () => {
    const dump = dumpFixture() as {
      recipe: Record<string, { results: unknown }>;
    };
    dump.recipe['heated-water']!.results = [
      { type: 'fluid', name: 'water', amount: 1, extra_count_fraction: 0.25 },
    ];

    const normalized = normalizeFactorioDataDump(dump, metadata);
    expect(
      normalized.database.recipes.find(({ name }) => name === 'heated-water')?.products,
    ).toEqual([{ prototype: 'fluid:water', amount: 1 }]);
    expect(normalized.warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'PD2003',
          path: 'recipe.heated-water.results[0].extra_count_fraction',
        }),
      ]),
    );
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
    expect(normalized.warnings.some(({ code }) => code === 'PD2003')).toBe(false);
  });

  test.each([
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

  test('warns and omits an inapplicable malformed item-only raw field on a fluid', () => {
    const dump = dumpFixture() as { recipe: Record<string, { results: unknown }> };
    dump.recipe['heated-water']!.results = [
      { type: 'fluid', name: 'water', amount: 10, always_fresh: 1 },
    ];

    const normalized = normalizeFactorioDataDump(dump, metadata);
    expect(
      normalized.database.recipes.find(({ name }) => name === 'heated-water')?.products[0],
    ).not.toHaveProperty('alwaysFresh');
    expect(normalized.warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'PD2003',
          path: 'recipe.heated-water.results[0].always_fresh',
          message: expect.stringContaining('retained by data.raw'),
        }),
      ]),
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

  test('normalizes item ingredient order by Factorio metadata and keeps fluids, products and rows intact', () => {
    const dump = ingredientOrderDumpFixture();
    dump.recipe['iron-plate']!.ingredients = [
      { type: 'fluid', name: 'water', amount: 100, temperature: 25, fluidbox_index: 0 },
      { type: 'item', name: 'item-name-zeta', amount: 4 },
      { type: 'item', name: 'subgroup-tie-zeta-item', amount: 1 },
      { type: 'item', name: 'group-beta-item', amount: 1 },
      { type: 'fluid', name: 'petroleum-gas', amount: 20 },
      { type: 'item', name: 'fallback-item', amount: 1 },
      {
        type: 'item',
        name: 'override-alpha',
        amount: 2,
        ignored_by_stats: 1,
        quality_change: -1,
        spoil_weight: 0.25,
      },
      { type: 'item', name: 'subgroup-later-item', amount: 1 },
      { type: 'item', name: 'item-order-first', amount: 1 },
      { type: 'item', name: 'tool-late', amount: 1 },
      { type: 'item', name: 'subgroup-first-item', amount: 1 },
      { type: 'item', name: 'group-alpha-item', amount: 1 },
      { type: 'item', name: 'subgroup-tie-alpha-item', amount: 1 },
      { type: 'item', name: 'item-name-alpha', amount: 1 },
    ];
    dump.recipe['iron-plate']!.results = [
      { type: 'item', name: 'iron-plate', amount: 1 },
      { type: 'item', name: 'iron-plate', amount: 2, ignored_by_stats: 1 },
    ];
    const before = structuredClone(dump);

    const normalized = normalizeFactorioDataDump(dump, metadata).database.recipes.find(
      ({ name }) => name === 'iron-plate',
    )!;

    expect(dump).toEqual(before);
    expect(normalized.ingredients.map(({ prototype }) => prototype)).toEqual([
      'item:override-alpha',
      'item:tool-late',
      'item:fallback-item',
      'item:group-alpha-item',
      'item:group-beta-item',
      'item:subgroup-first-item',
      'item:subgroup-later-item',
      'item:subgroup-tie-alpha-item',
      'item:subgroup-tie-zeta-item',
      'item:item-order-first',
      'item:item-name-alpha',
      'item:item-name-zeta',
      'fluid:water',
      'fluid:petroleum-gas',
    ]);
    expect(normalized.ingredients[0]).toEqual({
      prototype: 'item:override-alpha',
      amount: 2,
      ignoredByStats: 1,
      qualityChange: -1,
      spoilWeight: 0.25,
    });
    expect(normalized.ingredients.slice(-2)).toEqual([
      { prototype: 'fluid:water', amount: 100, temperature: 25, fluidboxIndex: 0 },
      { prototype: 'fluid:petroleum-gas', amount: 20 },
    ]);
    expect(normalized.products).toEqual([
      { prototype: 'item:iron-plate', amount: 1 },
      { prototype: 'item:iron-plate', amount: 2, ignoredByStats: 1 },
    ]);
  });

  test('retains authored item order when sorting is false and moves fluids after all items', () => {
    const dump = ingredientOrderDumpFixture();
    dump.recipe['iron-plate']!.sort_item_ingredients = false;
    dump.recipe['iron-plate']!.ingredients = [
      { type: 'fluid', name: 'petroleum-gas', amount: 20 },
      { type: 'item', name: 'item-name-zeta', amount: 1 },
      { type: 'fluid', name: 'water', amount: 10 },
      { type: 'item', name: 'override-alpha', amount: 1 },
    ];

    expect(
      normalizeFactorioDataDump(dump, metadata)
        .database.recipes.find(({ name }) => name === 'iron-plate')
        ?.ingredients.map(({ prototype }) => prototype),
    ).toEqual(['item:item-name-zeta', 'item:override-alpha', 'fluid:petroleum-gas', 'fluid:water']);
  });

  test('defaults omitted ordering metadata safely and orders UTF-8 strings without changing the global canonical comparator', () => {
    const minimal = dumpFixture() as RawDumpFixture;
    minimal.recipe['iron-plate']!.ingredients = [
      { type: 'item', name: 'iron-plate', amount: 1 },
      { type: 'item', name: 'grenade', amount: 1 },
    ];
    expect(
      normalizeFactorioDataDump(minimal, metadata)
        .database.recipes.find(({ name }) => name === 'iron-plate')
        ?.ingredients.map(({ prototype }) => prototype),
    ).toEqual(['item:grenade', 'item:iron-plate']);

    const unicode = dumpFixture() as RawDumpFixture;
    unicode.item['astral-order'] = {
      type: 'item',
      name: 'astral-order',
      stack_size: 100,
      order: '\u{10000}',
    };
    unicode.item['bmp-order'] = {
      type: 'item',
      name: 'bmp-order',
      stack_size: 100,
      order: '\uE000',
    };
    unicode.recipe['iron-plate']!.ingredients = [
      { type: 'item', name: 'astral-order', amount: 1 },
      { type: 'item', name: 'bmp-order', amount: 1 },
    ];
    expect(
      normalizeFactorioDataDump(unicode, metadata)
        .database.recipes.find(({ name }) => name === 'iron-plate')
        ?.ingredients.map(({ prototype }) => prototype),
    ).toEqual(['item:bmp-order', 'item:astral-order']);
  });

  test('keeps empty ingredients empty and rejects malformed used ordering fields at their raw paths', () => {
    const empty = dumpFixture() as RawDumpFixture;
    empty.recipe['iron-plate']!.ingredients = {};
    expect(
      normalizeFactorioDataDump(empty, metadata).database.recipes.find(
        ({ name }) => name === 'iron-plate',
      )?.ingredients,
    ).toEqual([]);

    const malformed = [
      [
        'item.order',
        'capsule.grenade.order',
        (dump: RawDumpFixture) => {
          dump.capsule.grenade!.order = 1;
        },
      ],
      [
        'item.subgroup',
        'capsule.grenade.subgroup',
        (dump: RawDumpFixture) => {
          dump.capsule.grenade!.subgroup = 1;
        },
      ],
      [
        'subgroup.order',
        'item-subgroup.sub.order',
        (dump: RawDumpFixture) => {
          dump['item-subgroup']!.sub!.order = false;
        },
      ],
      [
        'subgroup.group',
        'item-subgroup.sub.group',
        (dump: RawDumpFixture) => {
          dump['item-subgroup']!.sub!.group = 1;
        },
      ],
      [
        'group.order_in_recipe',
        'item-group.group.order_in_recipe',
        (dump: RawDumpFixture) => {
          dump['item-group']!.group!.order_in_recipe = 1;
        },
      ],
      [
        'fallback group.order',
        'item-group.group.order',
        (dump: RawDumpFixture) => {
          dump['item-group']!.group!.order = 1;
        },
      ],
    ] as const;
    for (const [field, path, mutate] of malformed) {
      const dump = malformedIngredientOrderDump(mutate);
      expect(() => normalizeFactorioDataDump(dump, metadata), field).toThrowError(
        expect.objectContaining({ code: 'PD1001', path }),
      );
    }

    const invalidFlag = malformedIngredientOrderDump((dump) => {
      dump.recipe['iron-plate']!.sort_item_ingredients = 1;
    });
    expect(() => normalizeFactorioDataDump(invalidFlag, metadata)).toThrowError(
      expect.objectContaining({ code: 'PD1001', path: 'recipe.iron-plate.sort_item_ingredients' }),
    );
  });

  test('does not validate unused ordering metadata or sort item metadata when the raw flag is false', () => {
    const unused = dumpFixture() as RawDumpFixture;
    unused.capsule.grenade!.order = 1;
    unused.recipe['iron-plate']!.ingredients = [{ type: 'item', name: 'iron-plate', amount: 1 }];
    expect(() => normalizeFactorioDataDump(unused, metadata)).not.toThrow();

    const disabled = dumpFixture() as RawDumpFixture;
    disabled.capsule.grenade!.order = 1;
    disabled.recipe['iron-plate']!.sort_item_ingredients = false;
    disabled.recipe['iron-plate']!.ingredients = [{ type: 'item', name: 'grenade', amount: 1 }];
    expect(
      normalizeFactorioDataDump(disabled, metadata).database.recipes.find(
        ({ name }) => name === 'iron-plate',
      )?.ingredients,
    ).toEqual([{ prototype: 'item:grenade', amount: 1 }]);
  });
});

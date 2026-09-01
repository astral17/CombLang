import { describe, expect, test } from 'vitest';

import { syntheticPrototypeDatabase } from './fixtures.js';
import { loadPrototypeDatabase } from './provider.js';
import type { RecipePrototype } from './schema.js';
import {
  buildPrototypeIndexes,
  PrototypeValidationError,
  parsePrototypeDatabaseJson,
  validatePrototypeDatabase,
} from './validation.js';

type MutableDatabase = {
  schemaVersion: number;
  environment: {
    expansions: string[];
    mods: { name: string; version: string }[];
    startupSettingsIdentity?: string;
    generatedAt?: string;
  };
  capabilities: Record<string, boolean>;
  items: { key: string; name: string; stackSize: number }[];
  fluids: { key: string; name: string }[];
  recipes: Record<string, unknown>[];
  entities: Record<string, unknown>[];
  qualities: Record<string, unknown>[];
  indexes: { recipesByProduct: Record<string, string[]> };
};

function mutableFixture(): MutableDatabase {
  return syntheticPrototypeDatabase() as MutableDatabase;
}

describe('PrototypeDatabase v1', () => {
  test('normalizes, freezes, indexes, and queries a synthetic environment', async () => {
    const raw = mutableFixture();
    raw.environment.expansions.reverse();
    raw.environment.mods.reverse();
    raw.items.reverse();
    const loaded = await loadPrototypeDatabase(raw);
    const { database, provider } = loaded;

    expect(Object.isFrozen(database)).toBe(true);
    expect(Object.isFrozen(database.items)).toBe(true);
    expect(Object.isFrozen(database.items[0])).toBe(true);
    expect(database.items.map(({ key }) => key)).toEqual([
      'item:copper-plate',
      'item:iron-gear-wheel',
      'item:iron-plate',
    ]);
    expect(provider.identity).toMatch(/^comblang-prototypes-v1-sha256:[0-9a-f]{64}$/);
    expect(provider.getItem('iron-plate')).toBe(provider.getItem('item:iron-plate'));
    expect(provider.stackSize('iron-plate')).toBe(100);
    expect(provider.recipesProducing('item:iron-gear-wheel').map(({ name }) => name)).toEqual([
      'iron-gear-wheel',
      'modded-gear-wheel',
    ]);
    expect(provider.canCraft('assembling-machine-3', 'iron-gear-wheel')).toBe(true);
    expect(provider.canCraft('assembling-machine-3', 'water-cycle')).toBe(false);
    expect(provider.canCraft('chemical-plant', 'water-cycle')).toBe(true);
    expect(provider.entityCircuitCapabilities('assembling-machine-3').setRecipe).toBe(true);

    raw.items[0]!.stackSize = 1;
    expect(provider.stackSize('iron-plate')).toBe(100);
  });

  test('rejects unsupported schemas, duplicate keys, bad references, and stale indexes', () => {
    const unsupported = mutableFixture();
    unsupported.schemaVersion = 2;
    expect(() => validatePrototypeDatabase(unsupported)).toThrowError(
      expect.objectContaining({ code: 'PT1000', path: 'schemaVersion' }),
    );

    const duplicate = mutableFixture();
    duplicate.items.push(structuredClone(duplicate.items[0]!));
    expect(() => validatePrototypeDatabase(duplicate)).toThrowError(
      expect.objectContaining({ code: 'PT1003', path: 'items' }),
    );

    const badReference = mutableFixture();
    const recipe = badReference.recipes[0] as { ingredients: { prototype: string }[] };
    recipe.ingredients[0]!.prototype = 'item:missing';
    expect(() => validatePrototypeDatabase(badReference)).toThrowError(
      expect.objectContaining({ code: 'PT1004' }),
    );

    const staleIndex = mutableFixture();
    staleIndex.indexes.recipesByProduct['item:iron-gear-wheel'] = ['recipe:iron-gear-wheel'];
    expect(() => validatePrototypeDatabase(staleIndex)).toThrowError(
      expect.objectContaining({ code: 'PT1005', path: 'indexes.recipesByProduct' }),
    );
  });

  test('retains the resolved effective modded recipe rather than a vanilla assumption', async () => {
    const raw = mutableFixture();
    const effective = raw.recipes.find(({ name }) => name === 'iron-gear-wheel') as {
      ingredients: { prototype: string; amount: number }[];
    };
    effective.ingredients = [{ prototype: 'item:copper-plate', amount: 3 }];
    const loaded = await loadPrototypeDatabase(raw);

    expect(loaded.provider.getRecipe('iron-gear-wheel')?.ingredients).toEqual([
      { prototype: 'item:copper-plate', amount: 3 },
    ]);
  });

  test('changes identity with content, mods, or startup settings but not provenance/order', async () => {
    const original = mutableFixture();
    const reordered = mutableFixture();
    reordered.environment.generatedAt = '2099-01-01T00:00:00.000Z';
    reordered.environment.expansions.reverse();
    reordered.environment.mods.reverse();
    reordered.items.reverse();
    reordered.recipes.reverse();
    for (const recipes of Object.values(reordered.indexes.recipesByProduct)) recipes.reverse();

    const contentChanged = mutableFixture();
    contentChanged.items.find(({ name }) => name === 'iron-plate')!.stackSize = 200;
    const modsChanged = mutableFixture();
    modsChanged.environment.mods.push({ name: 'example-mod', version: '1.0.0' });
    const settingsChanged = mutableFixture();
    settingsChanged.environment.startupSettingsIdentity = 'different-settings';

    const [base, same, content, mods, settings] = await Promise.all(
      [original, reordered, contentChanged, modsChanged, settingsChanged].map(
        async (value) => (await loadPrototypeDatabase(value)).provider.identity,
      ),
    );
    expect(same).toBe(base);
    expect(new Set([base, content, mods, settings]).size).toBe(4);
  });

  test('builds deterministic multi-recipe product indexes without duplicate rows', () => {
    const database = validatePrototypeDatabase(mutableFixture());
    const duplicateProductRecipe: RecipePrototype = Object.freeze({
      ...database.recipes[0]!,
      products: Object.freeze([...database.recipes[0]!.products, ...database.recipes[0]!.products]),
    });
    const indexes = buildPrototypeIndexes([
      duplicateProductRecipe,
      database.recipes[1]!,
    ] as readonly RecipePrototype[]);

    expect(indexes.recipesByProduct['item:iron-gear-wheel']).toEqual([
      'recipe:iron-gear-wheel',
      'recipe:modded-gear-wheel',
    ]);
  });

  test('distinguishes missing capability data from an unknown prototype', async () => {
    const raw = mutableFixture();
    raw.capabilities.recipes = false;
    const provider = (await loadPrototypeDatabase(raw)).provider;

    expect(() => provider.getRecipe('missing')).toThrow(
      'Prototype database does not provide recipes data.',
    );
    expect(() => provider.stackSize('missing')).toThrow('Unknown item prototype: missing.');
    expect(() => provider.getItem('missing')).not.toThrow();
    expect(provider.getItem('missing')).toBeUndefined();

    const partialItems = mutableFixture();
    partialItems.capabilities.itemStackSizes = false;
    delete (partialItems.items[0] as { stackSize?: number }).stackSize;
    const partialProvider = (await loadPrototypeDatabase(partialItems)).provider;
    expect(() => partialProvider.stackSize('copper-plate')).toThrow(
      'Prototype database does not provide itemStackSizes data.',
    );

    const inconsistentCoverage = mutableFixture();
    delete (inconsistentCoverage.items[0] as { stackSize?: number }).stackSize;
    expect(() => validatePrototypeDatabase(inconsistentCoverage)).toThrowError(
      expect.objectContaining({ code: 'PT1004', path: 'items' }),
    );
  });

  test('exposes validation failures as structured errors', () => {
    try {
      validatePrototypeDatabase({ schemaVersion: 1 });
      expect.fail('Expected invalid database to fail.');
    } catch (error) {
      expect(error).toBeInstanceOf(PrototypeValidationError);
      expect(error).toMatchObject({ code: 'PT1001', path: 'recipes' });
    }
    expect(() => parsePrototypeDatabaseJson('{')).toThrowError(
      expect.objectContaining({ code: 'PT1006', path: '<json>' }),
    );
  });
});

import { describe, expect, test } from 'vitest';

import { syntheticPrototypeDatabase } from './fixtures.js';
import { selectRecipeIngredient } from './recipe-ingredient-selection.js';
import type { RecipeIngredient } from './schema.js';
import { validatePrototypeDatabase } from './validation.js';

function databaseWithIngredients(ingredients: readonly RecipeIngredient[]) {
  const baseline = validatePrototypeDatabase(syntheticPrototypeDatabase());
  return validatePrototypeDatabase({
    ...baseline,
    recipes: baseline.recipes.map((recipe) =>
      recipe.key === 'recipe:iron-gear-wheel' ? { ...recipe, ingredients } : recipe,
    ),
  });
}

describe('local recipe ingredient selection', () => {
  test('selects identity and amount from the same component', () => {
    const database = validatePrototypeDatabase(syntheticPrototypeDatabase());
    expect(selectRecipeIngredient(database, 'recipe:iron-gear-wheel', 0)).toEqual({
      ok: true,
      recipe: 'recipe:iron-gear-wheel',
      index: 0,
      ingredient: { prototype: 'item:iron-plate', amount: 2 },
    });
  });

  test('preserves mixed item/fluid order, duplicates, fractional amounts and constraints', () => {
    const ingredients: RecipeIngredient[] = [
      { prototype: 'item:iron-plate', amount: 2, qualityMin: 'quality:rare' },
      { prototype: 'fluid:water', amount: 0.25, temperatureMin: 15, temperatureMax: 25 },
      { prototype: 'item:iron-plate', amount: 3 },
    ];
    const database = databaseWithIngredients(ingredients);
    for (const [index, ingredient] of ingredients.entries()) {
      expect(selectRecipeIngredient(database, 'recipe:iron-gear-wheel', index)).toEqual({
        ok: true,
        recipe: 'recipe:iron-gear-wheel',
        index,
        ingredient,
      });
    }
  });

  test('does not derive ingredient amounts from probabilistic or ranged products', () => {
    const database = validatePrototypeDatabase(syntheticPrototypeDatabase());
    expect(selectRecipeIngredient(database, 'recipe:modded-gear-wheel', 0)).toMatchObject({
      ok: true,
      ingredient: { prototype: 'item:copper-plate', amount: 3 },
    });
    expect(selectRecipeIngredient(database, 'recipe:water-cycle', 0)).toMatchObject({
      ok: true,
      ingredient: { prototype: 'fluid:water', amount: 10, temperatureMin: 15 },
    });
  });

  test.each([-1, 0.5, NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER + 1])(
    'rejects invalid index %s rather than silently using zero',
    (index) => {
      const database = validatePrototypeDatabase(syntheticPrototypeDatabase());
      expect(selectRecipeIngredient(database, 'recipe:iron-gear-wheel', index)).toEqual({
        ok: false,
        reason: 'invalid-index',
      });
    },
  );

  test.each([1, 999, Number.MAX_SAFE_INTEGER])('reports missing ingredient %s', (index) => {
    const database = validatePrototypeDatabase(syntheticPrototypeDatabase());
    expect(selectRecipeIngredient(database, 'recipe:iron-gear-wheel', index)).toEqual({
      ok: false,
      reason: 'ingredient-out-of-range',
    });
  });

  test('supports empty ingredient lists without substituting a product', () => {
    expect(
      selectRecipeIngredient(databaseWithIngredients([]), 'recipe:iron-gear-wheel', 0),
    ).toEqual({
      ok: false,
      reason: 'ingredient-out-of-range',
    });
  });

  test('requires an exact recipe key and never guesses by product', () => {
    const database = validatePrototypeDatabase(syntheticPrototypeDatabase());
    expect(selectRecipeIngredient(database, 'recipe:iron-plate', 0)).toEqual({
      ok: false,
      reason: 'unknown-recipe',
    });
  });

  test('reports unavailable recipe data separately from an unknown recipe', () => {
    const database = validatePrototypeDatabase(syntheticPrototypeDatabase());
    const unavailable = { ...database, capabilities: { ...database.capabilities, recipes: false } };
    expect(selectRecipeIngredient(unavailable, 'recipe:unknown', 0)).toEqual({
      ok: false,
      reason: 'recipes-unavailable',
    });
  });

  test('returns immutable metadata without modifying the validated database', () => {
    const database = validatePrototypeDatabase(syntheticPrototypeDatabase());
    const before = JSON.stringify(database);
    const result = selectRecipeIngredient(database, 'recipe:iron-gear-wheel', -0);
    expect(Object.isFrozen(result)).toBe(true);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('Expected a selected ingredient');
    expect(Object.is(result.index, -0)).toBe(false);
    expect(Object.isFrozen(result.ingredient)).toBe(true);
    expect(result.ingredient).toBe(database.recipes[0]!.ingredients[0]);
    expect(JSON.stringify(database)).toBe(before);
  });
});

import type { PrototypeDatabaseV1, RecipeIngredient, RecipePrototypeKey } from './schema.js';

export type RecipeIngredientSelection =
  | {
      readonly ok: true;
      readonly recipe: RecipePrototypeKey;
      readonly index: number;
      readonly ingredient: RecipeIngredient;
    }
  | {
      readonly ok: false;
      readonly reason:
        'recipes-unavailable' | 'invalid-index' | 'unknown-recipe' | 'ingredient-out-of-range';
    };

/**
 * Selects one ingredient from a validated, immutable prototype database.
 * Indexes address the normalized ingredient array, not Factorio formula slots.
 * The original component retains its exact amount and quality/fluid constraints;
 * entries are never sorted, merged, or inferred from a recipe's products.
 */
export function selectRecipeIngredient(
  database: PrototypeDatabaseV1,
  recipeKey: RecipePrototypeKey,
  index: number,
): RecipeIngredientSelection {
  if (!database.capabilities.recipes) {
    return Object.freeze({ ok: false, reason: 'recipes-unavailable' });
  }
  if (!Number.isSafeInteger(index) || index < 0) {
    return Object.freeze({ ok: false, reason: 'invalid-index' });
  }
  const recipe = database.recipes.find(({ key }) => key === recipeKey);
  if (!recipe) return Object.freeze({ ok: false, reason: 'unknown-recipe' });
  const ingredient = recipe.ingredients[index];
  if (!ingredient) return Object.freeze({ ok: false, reason: 'ingredient-out-of-range' });
  return Object.freeze({ ok: true, recipe: recipeKey, index: index === 0 ? 0 : index, ingredient });
}

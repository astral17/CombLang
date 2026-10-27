import type {
  PrototypeDatabaseV1,
  RecipeIngredient,
  RecipePrototype,
  RecipePrototypeKey,
} from './schema.js';

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
 * Indexes address the stored ingredient array. Raw Factorio imports normalize
 * it to effective game order; already-normalized providers are consumed as-is.
 * This is not a mapping to native formula slots.
 * The original component retains its exact amount and quality/fluid constraints;
 * the selector never sorts, merges, or infers entries from recipe products.
 */
export function selectRecipeIngredient(
  database: PrototypeDatabaseV1,
  recipeKey: RecipePrototypeKey,
  index: number,
): RecipeIngredientSelection {
  if (!database.capabilities.recipes) {
    return Object.freeze({ ok: false, reason: 'recipes-unavailable' });
  }
  const recipe = database.recipes.find(({ key }) => key === recipeKey);
  return selectRecipeIngredientFromRecipe(recipe, index);
}

/** Shared normalized-order selector for a recipe obtained through a host provider. */
export function selectRecipeIngredientFromRecipe(
  recipe: RecipePrototype | undefined,
  index: number,
): RecipeIngredientSelection {
  if (!Number.isSafeInteger(index) || index < 0) {
    return Object.freeze({ ok: false, reason: 'invalid-index' });
  }
  if (!recipe) return Object.freeze({ ok: false, reason: 'unknown-recipe' });
  const ingredient = recipe.ingredients[index];
  if (!ingredient) return Object.freeze({ ok: false, reason: 'ingredient-out-of-range' });
  return Object.freeze({
    ok: true,
    recipe: recipe.key,
    index: index === 0 ? 0 : index,
    ingredient,
  });
}

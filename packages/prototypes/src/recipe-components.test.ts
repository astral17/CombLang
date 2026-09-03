import { describe, expect, test } from 'vitest';

import { syntheticPrototypeDatabase } from './fixtures.js';
import { loadPrototypeDatabase } from './provider.js';
import { validatePrototypeDatabase } from './validation.js';

function fixture(fields: Record<string, unknown>, role: 'products' | 'ingredients' = 'products') {
  const value = syntheticPrototypeDatabase() as {
    recipes: {
      name: string;
      ingredients: Record<string, unknown>[];
      products: Record<string, unknown>[];
    }[];
  };
  const recipe = value.recipes.find(({ name }) => name === 'iron-gear-wheel')!;
  Object.assign(recipe[role][0]!, fields);
  return value;
}

describe('recipe product metadata', () => {
  test.each([
    { independentProbability: -0.1 },
    { independentProbability: 1.1 },
    { independentProbability: NaN },
    { independentProbability: Infinity },
    { sharedProbability: { min: -0.1, max: 0 } },
    { sharedProbability: { min: 0, max: 1.1 } },
    { sharedProbability: { min: 0.7, max: 0.2 } },
    { sharedProbability: { min: 0 } },
    { sharedProbability: [] },
    { ignoredByStats: -1 },
    { ignoredByStats: 0.5 },
    { ignoredByProductivity: 65536 },
  ])('rejects invalid numeric metadata %j', (fields) => {
    expect(() => validatePrototypeDatabase(fixture(fields))).toThrowError(
      expect.objectContaining({ code: 'PT1001', path: expect.stringContaining('products[0]') }),
    );
  });

  test.each([
    { independentProbability: 0.5 },
    { sharedProbability: { min: 0, max: 1 } },
    { ignoredByProductivity: 0 },
  ])('rejects product-only fields on ingredients %j', (fields) => {
    expect(() => validatePrototypeDatabase(fixture(fields, 'ingredients'))).toThrowError(
      expect.objectContaining({ code: 'PT1004' }),
    );
  });

  test('keeps legacy probabilities but rejects mixed legacy/new probability models', () => {
    expect(() => validatePrototypeDatabase(fixture({ probability: 0.2 }))).not.toThrow();
    for (const fields of [
      { independentProbability: 0.2 },
      { sharedProbability: { min: 0, max: 1 } },
    ]) {
      expect(() =>
        validatePrototypeDatabase(fixture({ probability: 0.2, ...fields })),
      ).toThrowError(expect.objectContaining({ code: 'PT1004' }));
    }
  });

  test('preserves zeros, empty shared intervals and counters larger than the crafted amount', async () => {
    const loaded = await loadPrototypeDatabase(
      fixture({
        independentProbability: 0,
        sharedProbability: { min: 0.4, max: 0.4 },
        ignoredByStats: 0,
        ignoredByProductivity: 100,
      }),
    );
    expect(loaded.prototypes.recipe['iron-gear-wheel']!.products[0]).toMatchObject({
      independentProbability: 0,
      sharedProbability: { min: 0.4, max: 0.4 },
      ignoredByStats: 0,
      ignoredByProductivity: 100,
    });
  });

  test('includes each optional fact in environment identity without filling omitted defaults', async () => {
    const baseline = await loadPrototypeDatabase(fixture({}));
    const original = baseline.prototypes.recipe['iron-gear-wheel']!.products[0]!;
    expect(original).not.toHaveProperty('ignoredByStats');
    for (const fields of [
      { independentProbability: 1 },
      { sharedProbability: { min: 0, max: 1 } },
      { ignoredByStats: 0 },
      { ignoredByProductivity: 0 },
    ]) {
      expect((await loadPrototypeDatabase(fixture(fields))).prototypes.identity).not.toBe(
        baseline.prototypes.identity,
      );
    }
  });
});

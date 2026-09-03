import { describe, expect, test } from 'vitest';

import { syntheticPrototypeDatabase } from './fixtures.js';
import { loadPrototypeDatabase } from './provider.js';
import { validatePrototypeDatabase } from './validation.js';

function fixture(
  fields: Record<string, unknown>,
  role: 'products' | 'ingredients' = 'products',
  recipeName = 'iron-gear-wheel',
) {
  const value = syntheticPrototypeDatabase() as {
    recipes: {
      name: string;
      ingredients: Record<string, unknown>[];
      products: Record<string, unknown>[];
    }[];
  };
  const recipe = value.recipes.find(({ name }) => name === recipeName)!;
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

describe('recipe spoilage and fluidbox metadata', () => {
  test.each([
    ['percentSpoiled', -0.01],
    ['percentSpoiled', 1],
    ['percentSpoiled', NaN],
    ['percentSpoiled', Infinity],
    ['spoilWeight', -0.01],
    ['spoilWeight', 1.01],
    ['spoilWeight', '1'],
    ['alwaysFresh', 0],
    ['resetFreshnessOnCraft', 'false'],
  ])('rejects invalid item field %s = %j at its field path', (field, value) => {
    expect(() =>
      validatePrototypeDatabase(
        fixture({ [field as string]: value }, field === 'spoilWeight' ? 'ingredients' : 'products'),
      ),
    ).toThrowError(
      expect.objectContaining({ code: 'PT1001', path: expect.stringContaining(`.${field}`) }),
    );
  });

  test.each([
    ['fluidboxIndex', -1, 'fluidboxIndex'],
    ['fluidboxIndex', 0.5, 'fluidboxIndex'],
    ['fluidboxIndex', 4294967296, 'fluidboxIndex'],
    ['fluidboxIndex', Infinity, 'fluidboxIndex'],
    ['fluidboxMultiplier', 0, 'fluidboxMultiplier'],
    ['fluidboxMultiplier', 256, 'fluidboxMultiplier'],
    ['fluidboxMultiplier', 1.5, 'fluidboxMultiplier'],
    ['optionalFluidboxIndexes', {}, 'optionalFluidboxIndexes'],
    ['optionalFluidboxIndexes', [1, -1], 'optionalFluidboxIndexes[1]'],
    ['optionalFluidboxIndexes', [4294967296], 'optionalFluidboxIndexes[0]'],
    ['optionalFluidboxIndexes', [0.5], 'optionalFluidboxIndexes[0]'],
    ['optionalFluidboxIndexes', ['1'], 'optionalFluidboxIndexes[0]'],
  ])('rejects invalid fluid field %s = %j', (field, value, suffix) => {
    expect(() =>
      validatePrototypeDatabase(fixture({ [field as string]: value }, 'products', 'water-cycle')),
    ).toThrowError(
      expect.objectContaining({ code: 'PT1001', path: expect.stringContaining(`.${suffix}`) }),
    );
  });

  test('checks item/fluid and ingredient/product applicability even for false or empty values', () => {
    for (const fields of [
      { percentSpoiled: 0 },
      { alwaysFresh: false },
      { resetFreshnessOnCraft: false },
    ]) {
      for (const [role, name] of [
        ['ingredients', 'iron-gear-wheel'],
        ['products', 'water-cycle'],
      ] as const) {
        expect(() => validatePrototypeDatabase(fixture(fields, role, name))).toThrowError(
          expect.objectContaining({ code: 'PT1004' }),
        );
      }
    }
    for (const [role, name] of [
      ['products', 'iron-gear-wheel'],
      ['ingredients', 'water-cycle'],
    ] as const) {
      expect(() => validatePrototypeDatabase(fixture({ spoilWeight: 0 }, role, name))).toThrowError(
        expect.objectContaining({ code: 'PT1004' }),
      );
    }
    for (const role of ['ingredients', 'products'] as const) {
      for (const fields of [
        { fluidboxIndex: 0 },
        { fluidboxMultiplier: 1 },
        { optionalFluidboxIndexes: [] },
      ]) {
        expect(() => validatePrototypeDatabase(fixture(fields, role))).toThrowError(
          expect.objectContaining({ code: 'PT1004' }),
        );
      }
    }
  });

  test('preserves boundary values, routing order and inactive optional indexes without inserting defaults', async () => {
    for (const role of ['ingredients', 'products'] as const) {
      const fields = {
        fluidboxIndex: 0,
        fluidboxMultiplier: 255,
        optionalFluidboxIndexes: [4294967295, 2, 0, 2],
      };
      const { prototypes } = await loadPrototypeDatabase(fixture(fields, role, 'water-cycle'));
      const component = prototypes.recipe['water-cycle']![role][0]!;
      expect(component).toMatchObject(fields);
      expect(component.optionalFluidboxIndexes).not.toBe(fields.optionalFluidboxIndexes);
      expect(Object.isFrozen(component.optionalFluidboxIndexes)).toBe(true);
      const inactive = await loadPrototypeDatabase(
        fixture({ optionalFluidboxIndexes: [2] }, role, 'water-cycle'),
      );
      expect(inactive.prototypes.recipe['water-cycle']![role][0]).not.toHaveProperty(
        'fluidboxIndex',
      );
      expect(inactive.prototypes.recipe['water-cycle']![role][0]!.optionalFluidboxIndexes).toEqual([
        2,
      ]);
    }
    for (const spoilWeight of [0, 1]) {
      expect(() =>
        validatePrototypeDatabase(fixture({ spoilWeight }, 'ingredients')),
      ).not.toThrow();
    }
    expect(() =>
      validatePrototypeDatabase(
        fixture({ percentSpoiled: 0.999, alwaysFresh: true, resetFreshnessOnCraft: true }),
      ),
    ).not.toThrow();
    expect(() =>
      validatePrototypeDatabase(
        fixture({ fluidboxIndex: 4294967295, fluidboxMultiplier: 1 }, 'products', 'water-cycle'),
      ),
    ).not.toThrow();
  });

  test('includes every explicit spoilage/routing fact in identity and preserves omission', async () => {
    for (const [role, name, fields] of [
      ['products', 'iron-gear-wheel', { percentSpoiled: 0 }],
      ['products', 'iron-gear-wheel', { alwaysFresh: false }],
      ['products', 'iron-gear-wheel', { resetFreshnessOnCraft: false }],
      ['ingredients', 'iron-gear-wheel', { spoilWeight: 1 }],
      ['products', 'water-cycle', { fluidboxIndex: 0 }],
      ['products', 'water-cycle', { fluidboxMultiplier: 3 }],
      ['products', 'water-cycle', { optionalFluidboxIndexes: [] }],
    ] as const) {
      const baseline = await loadPrototypeDatabase(fixture({}, role, name));
      const loaded = await loadPrototypeDatabase(fixture(fields, role, name));
      expect(loaded.prototypes.identity).not.toBe(baseline.prototypes.identity);
      expect(loaded.prototypes.recipe[name]![role][0]).toMatchObject(fields);
      expect(baseline.prototypes.recipe[name]![role][0]).not.toHaveProperty(
        Object.keys(fields)[0]!,
      );
    }
  });
});

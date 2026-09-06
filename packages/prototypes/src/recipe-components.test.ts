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

function editedComponentFixture(
  role: 'products' | 'ingredients',
  recipeName: string,
  edit: (component: Record<string, unknown>) => void,
) {
  const value = syntheticPrototypeDatabase() as {
    recipes: {
      name: string;
      ingredients: Record<string, unknown>[];
      products: Record<string, unknown>[];
    }[];
  };
  const recipe = value.recipes.find(({ name }) => name === recipeName)!;
  edit(recipe[role][0]!);
  return value;
}

describe('recipe amount validation', () => {
  test('validates item and fluid ingredient domains', () => {
    expect(() => validatePrototypeDatabase(fixture({ amount: 1 }, 'ingredients'))).not.toThrow();
    expect(() =>
      validatePrototypeDatabase(fixture({ amount: 65535 }, 'ingredients')),
    ).not.toThrow();
    expect(() => validatePrototypeDatabase(fixture({ amount: 0 }, 'ingredients'))).toThrowError(
      expect.objectContaining({ code: 'PT1001', path: expect.stringContaining('.amount') }),
    );
    expect(() =>
      validatePrototypeDatabase(fixture({ amount: 0 }, 'ingredients', 'water-cycle')),
    ).toThrowError(
      expect.objectContaining({ code: 'PT1001', path: expect.stringContaining('.amount') }),
    );
    expect(() =>
      validatePrototypeDatabase(fixture({ amount: 0.25 }, 'ingredients', 'water-cycle')),
    ).not.toThrow();
  });

  test('validates item and fluid product zero and uint16 boundaries', () => {
    expect(() => validatePrototypeDatabase(fixture({ amount: 0 }))).not.toThrow();
    expect(() => validatePrototypeDatabase(fixture({ amount: 65535 }))).not.toThrow();
    for (const amount of [65536, 1.5]) {
      expect(() => validatePrototypeDatabase(fixture({ amount }, 'products'))).toThrowError(
        expect.objectContaining({ code: 'PT1001', path: expect.stringContaining('.amount') }),
      );
    }
    expect(() =>
      validatePrototypeDatabase(fixture({ amount: 0 }, 'products', 'water-cycle')),
    ).not.toThrow();
    expect(() =>
      validatePrototypeDatabase(fixture({ amount: 0.25 }, 'products', 'water-cycle')),
    ).not.toThrow();
  });

  test('requires complete product amount forms and rejects exact/range conflicts', () => {
    expect(() =>
      validatePrototypeDatabase(
        editedComponentFixture('products', 'iron-gear-wheel', (component) => {
          delete component.amount;
        }),
      ),
    ).toThrowError(
      expect.objectContaining({ code: 'PT1001', path: expect.stringContaining('.amount') }),
    );
    expect(() =>
      validatePrototypeDatabase(
        editedComponentFixture('products', 'iron-gear-wheel', (component) => {
          delete component.amount;
          component.amountMin = 1;
        }),
      ),
    ).toThrowError(
      expect.objectContaining({ code: 'PT1001', path: expect.stringContaining('.amountMax') }),
    );
    expect(() =>
      validatePrototypeDatabase(
        editedComponentFixture('products', 'iron-gear-wheel', (component) => {
          component.amountMin = 1;
          component.amountMax = 2;
        }),
      ),
    ).toThrowError(
      expect.objectContaining({ code: 'PT1001', path: expect.stringContaining('.amount') }),
    );
    expect(() =>
      validatePrototypeDatabase(
        editedComponentFixture('products', 'iron-gear-wheel', (component) => {
          delete component.amount;
          component.extraCountFraction = 0.5;
        }),
      ),
    ).toThrowError(
      expect.objectContaining({ code: 'PT1001', path: expect.stringContaining('.amount') }),
    );
  });

  test('rejects ranges on ingredients and descending normalized product ranges', () => {
    expect(() =>
      validatePrototypeDatabase(
        editedComponentFixture('ingredients', 'iron-gear-wheel', (component) => {
          delete component.amount;
          component.amountMin = 1;
          component.amountMax = 2;
        }),
      ),
    ).toThrowError(
      expect.objectContaining({ code: 'PT1004', path: expect.stringContaining('.amountMin') }),
    );
    expect(() =>
      validatePrototypeDatabase(
        editedComponentFixture('products', 'modded-gear-wheel', (component) => {
          delete component.amount;
          component.amountMin = 2;
          component.amountMax = 1;
        }),
      ),
    ).toThrowError(
      expect.objectContaining({ code: 'PT1001', path: expect.stringContaining('.amountMax') }),
    );
  });
});

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

  test('enforces shared product and ingredient-only applicability at canonical field paths', () => {
    for (const [field, fields, role, recipeName] of [
      ['amountMin', { amountMin: 1 }, 'ingredients', 'iron-gear-wheel'],
      ['amountMax', { amountMax: 2 }, 'ingredients', 'iron-gear-wheel'],
      ['probability', { probability: 0.5 }, 'ingredients', 'iron-gear-wheel'],
      ['independentProbability', { independentProbability: 0.5 }, 'ingredients', 'iron-gear-wheel'],
      [
        'sharedProbability',
        { sharedProbability: { min: 0, max: 1 } },
        'ingredients',
        'iron-gear-wheel',
      ],
      ['ignoredByProductivity', { ignoredByProductivity: 0 }, 'ingredients', 'iron-gear-wheel'],
      ['extraCountFraction', { extraCountFraction: 0 }, 'ingredients', 'iron-gear-wheel'],
      ['extraCountFraction', { extraCountFraction: 0 }, 'products', 'water-cycle'],
      ['temperatureMin', { temperatureMin: 15 }, 'products', 'water-cycle'],
      ['temperatureMax', { temperatureMax: 100 }, 'products', 'water-cycle'],
    ] as const) {
      expect(() => validatePrototypeDatabase(fixture(fields, role, recipeName))).toThrowError(
        expect.objectContaining({
          code: 'PT1004',
          path: expect.stringContaining(`.${field}`),
        }),
      );
    }
    expect(() =>
      validatePrototypeDatabase(
        fixture({ amountMin: 1, amountMax: 2 }, 'products', 'modded-gear-wheel'),
      ),
    ).not.toThrow();
    expect(() =>
      validatePrototypeDatabase(fixture({ extraCountFraction: 0 }, 'products')),
    ).not.toThrow();
    expect(() =>
      validatePrototypeDatabase(
        fixture({ temperatureMin: 15, temperatureMax: 100 }, 'ingredients', 'water-cycle'),
      ),
    ).not.toThrow();
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

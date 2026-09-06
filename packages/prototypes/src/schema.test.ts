import { describe, expect, test } from 'vitest';

import type {
  FluidRecipeIngredient,
  FluidRecipeProduct,
  ItemRecipeIngredient,
  ItemRecipeProduct,
} from './schema.js';

const itemIngredient = {
  prototype: 'item:iron-plate',
  amount: 2,
  ignoredByStats: 0,
  qualityChange: -1,
  spoilWeight: 0,
} satisfies ItemRecipeIngredient;

const fluidIngredient = {
  prototype: 'fluid:water',
  amount: 10,
  fluidboxIndex: 0,
  temperatureMin: 15,
  temperatureMax: 100,
} satisfies FluidRecipeIngredient;

const itemProduct = {
  prototype: 'item:iron-gear-wheel',
  amountMin: 1,
  amountMax: 2,
  extraCountFraction: 0,
  affectedByQuality: false,
  percentSpoiled: 0,
} satisfies ItemRecipeProduct;

const fluidProduct = {
  prototype: 'fluid:water',
  amount: 0,
  independentProbability: 0,
  fluidboxMultiplier: 3,
  temperature: 25,
} satisfies FluidRecipeProduct;

const itemIngredientWithProductField = {
  prototype: 'item:iron-plate',
  amount: 1,
  // @ts-expect-error Product probability is not admitted on an ingredient shape.
  probability: 0.5,
} satisfies ItemRecipeIngredient;

const fluidIngredientWithItemField = {
  prototype: 'fluid:water',
  amount: 1,
  // @ts-expect-error Item quality fields are not admitted on a fluid ingredient shape.
  qualityChange: 1,
} satisfies FluidRecipeIngredient;

const itemProductWithFluidField = {
  prototype: 'item:iron-gear-wheel',
  amount: 1,
  // @ts-expect-error Fluid routing fields are not admitted on an item product shape.
  fluidboxIndex: 1,
} satisfies ItemRecipeProduct;

const fluidProductWithItemField = {
  prototype: 'fluid:water',
  amount: 1,
  // @ts-expect-error Item-only extra count is not admitted on a fluid product shape.
  extraCountFraction: 0,
} satisfies FluidRecipeProduct;

describe('discriminated recipe component schema', () => {
  test('exposes precise ingredient and product shapes without serialized discriminants', () => {
    expect([itemIngredient, fluidIngredient, itemProduct, fluidProduct]).toHaveLength(4);
    for (const component of [itemIngredient, fluidIngredient, itemProduct, fluidProduct]) {
      expect(component).not.toHaveProperty('role');
      expect(component).not.toHaveProperty('kind');
    }
  });
});

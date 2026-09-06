import { describe, expect, test } from 'vitest';

import {
  isRecipeComponentFieldApplicable,
  recipeComponentApplicabilityIssues,
  type RecipeComponentField,
  type RecipeComponentKind,
  type RecipeComponentRole,
} from './recipe-component-policy.js';

const allRoles: readonly RecipeComponentRole[] = ['ingredient', 'product'];
const allKinds: readonly RecipeComponentKind[] = ['item', 'fluid'];

describe('recipe component applicability policy', () => {
  test('allows universal fields for every role and kind', () => {
    for (const field of ['amount', 'ignoredByStats'] as const) {
      for (const role of allRoles) {
        for (const kind of allKinds) {
          expect(isRecipeComponentFieldApplicable(field, role, kind)).toBe(true);
          expect(recipeComponentApplicabilityIssues({ [field]: 0 }, role, kind)).toEqual([]);
        }
      }
    }
  });

  test('allows product-only fields only on products', () => {
    const fields = [
      'amountMin',
      'amountMax',
      'probability',
      'independentProbability',
      'sharedProbability',
      'ignoredByProductivity',
    ] as const;
    for (const field of fields) {
      expect(recipeComponentApplicabilityIssues({ [field]: 0 }, 'product', 'item')).toEqual([]);
      expect(recipeComponentApplicabilityIssues({ [field]: 0 }, 'product', 'fluid')).toEqual([]);
      expect(recipeComponentApplicabilityIssues({ [field]: 0 }, 'ingredient', 'item')).toEqual([
        expect.objectContaining({ field }),
      ]);
      expect(recipeComponentApplicabilityIssues({ [field]: 0 }, 'ingredient', 'fluid')).toEqual([
        expect.objectContaining({ field }),
      ]);
    }
  });

  test('allows item-product fields only on item products', () => {
    const fields = [
      'extraCountFraction',
      'affectedByQuality',
      'percentSpoiled',
      'alwaysFresh',
      'resetFreshnessOnCraft',
    ] as const;
    for (const field of fields) {
      expect(recipeComponentApplicabilityIssues({ [field]: false }, 'product', 'item')).toEqual([]);
      expect(recipeComponentApplicabilityIssues({ [field]: false }, 'ingredient', 'item')).toEqual([
        expect.objectContaining({ field }),
      ]);
      expect(recipeComponentApplicabilityIssues({ [field]: false }, 'product', 'fluid')).toEqual([
        expect.objectContaining({ field }),
      ]);
    }
  });

  test('allows spoil weight only on item ingredients', () => {
    expect(recipeComponentApplicabilityIssues({ spoilWeight: 0 }, 'ingredient', 'item')).toEqual(
      [],
    );
    for (const [role, kind] of [
      ['product', 'item'],
      ['ingredient', 'fluid'],
    ] as const) {
      expect(recipeComponentApplicabilityIssues({ spoilWeight: 0 }, role, kind)).toEqual([
        expect.objectContaining({ field: 'spoilWeight' }),
      ]);
    }
  });

  test('allows quality fields on item ingredients and products only', () => {
    const fields = ['qualityChange', 'qualityMin', 'qualityMax'] as const;
    for (const field of fields) {
      expect(recipeComponentApplicabilityIssues({ [field]: 0 }, 'ingredient', 'item')).toEqual([]);
      expect(recipeComponentApplicabilityIssues({ [field]: 0 }, 'product', 'item')).toEqual([]);
      expect(recipeComponentApplicabilityIssues({ [field]: 0 }, 'ingredient', 'fluid')).toEqual([
        expect.objectContaining({ field }),
      ]);
      expect(recipeComponentApplicabilityIssues({ [field]: 0 }, 'product', 'fluid')).toEqual([
        expect.objectContaining({ field }),
      ]);
    }
  });

  test('allows fluid routing and exact temperature on both fluid roles', () => {
    const fields = [
      'fluidboxIndex',
      'fluidboxMultiplier',
      'optionalFluidboxIndexes',
      'temperature',
    ] as const;
    for (const field of fields) {
      for (const role of allRoles) {
        expect(recipeComponentApplicabilityIssues({ [field]: 0 }, role, 'fluid')).toEqual([]);
      }
      for (const role of allRoles) {
        expect(recipeComponentApplicabilityIssues({ [field]: 0 }, role, 'item')).toEqual([
          expect.objectContaining({ field }),
        ]);
      }
    }
  });

  test('allows temperature ranges only on fluid ingredients', () => {
    for (const field of ['temperatureMin', 'temperatureMax'] as const) {
      expect(recipeComponentApplicabilityIssues({ [field]: 0 }, 'ingredient', 'fluid')).toEqual([]);
      for (const [role, kind] of [
        ['product', 'fluid'],
        ['ingredient', 'item'],
      ] as const) {
        expect(recipeComponentApplicabilityIssues({ [field]: 0 }, role, kind)).toEqual([
          expect.objectContaining({ field }),
        ]);
      }
    }
  });

  test('checks presence without interpreting zero, false, or empty arrays', () => {
    const component = {
      extraCountFraction: 0,
      affectedByQuality: false,
      optionalFluidboxIndexes: [],
      temperatureMin: 0,
    };
    expect(
      recipeComponentApplicabilityIssues(component, 'product', 'fluid').map(({ field }) => field),
    ).toEqual(['extraCountFraction', 'affectedByQuality', 'temperatureMin']);
  });

  test('returns stable canonical field order and messages', () => {
    const fields = {
      temperatureMax: 0,
      extraCountFraction: 0,
      amountMin: 0,
    } satisfies Partial<Record<RecipeComponentField, unknown>>;
    expect(recipeComponentApplicabilityIssues(fields, 'ingredient', 'item')).toEqual([
      {
        field: 'amountMin',
        message: 'amountMin is valid only on product components.',
      },
      {
        field: 'extraCountFraction',
        message: 'extraCountFraction is valid only on item products.',
      },
      {
        field: 'temperatureMax',
        message: 'temperatureMax is valid only on fluid ingredients.',
      },
    ]);
  });
});

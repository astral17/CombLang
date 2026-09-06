import { describe, expect, test } from 'vitest';

import { evaluateRecipeAmount } from './recipe-amount-policy.js';

function fields(result: ReturnType<typeof evaluateRecipeAmount>) {
  return result.issues.map(({ field }) => field);
}

describe('recipe amount policy', () => {
  test('accepts exact ingredient amounts at each domain boundary', () => {
    expect(evaluateRecipeAmount({ amount: 1 }, 'ingredient', 'item').issues).toEqual([]);
    expect(evaluateRecipeAmount({ amount: 65535 }, 'ingredient', 'item').issues).toEqual([]);
    expect(evaluateRecipeAmount({ amount: 0.25 }, 'ingredient', 'fluid').issues).toEqual([]);
  });

  test('rejects missing, zero, fractional, overflowing and non-finite ingredient amounts', () => {
    expect(fields(evaluateRecipeAmount({}, 'ingredient', 'item'))).toEqual(['amount']);
    expect(fields(evaluateRecipeAmount({ amount: 0 }, 'ingredient', 'item'))).toEqual(['amount']);
    expect(fields(evaluateRecipeAmount({ amount: 0 }, 'ingredient', 'fluid'))).toEqual(['amount']);
    expect(fields(evaluateRecipeAmount({ amount: 1.5 }, 'ingredient', 'item'))).toEqual(['amount']);
    expect(fields(evaluateRecipeAmount({ amount: 65536 }, 'ingredient', 'item'))).toEqual([
      'amount',
    ]);
    expect(fields(evaluateRecipeAmount({ amount: Infinity }, 'ingredient', 'fluid'))).toEqual([
      'amount',
    ]);
  });

  test('accepts zero products and product ranges in their corresponding domains', () => {
    expect(evaluateRecipeAmount({ amount: 0 }, 'product', 'item').issues).toEqual([]);
    expect(evaluateRecipeAmount({ amount: 0 }, 'product', 'fluid').issues).toEqual([]);
    expect(
      evaluateRecipeAmount({ amountMin: 0, amountMax: 65535 }, 'product', 'item').issues,
    ).toEqual([]);
    expect(
      evaluateRecipeAmount({ amountMin: 0.25, amountMax: 10.5 }, 'product', 'fluid').issues,
    ).toEqual([]);
  });

  test('requires one complete product amount form and rejects conflicts', () => {
    expect(fields(evaluateRecipeAmount({}, 'product', 'item'))).toEqual(['amount']);
    expect(fields(evaluateRecipeAmount({ amountMin: 1 }, 'product', 'item'))).toEqual([
      'amountMax',
    ]);
    expect(fields(evaluateRecipeAmount({ amountMax: 1 }, 'product', 'item'))).toEqual([
      'amountMin',
    ]);
    expect(
      fields(evaluateRecipeAmount({ amount: 1, amountMin: 1, amountMax: 2 }, 'product', 'item')),
    ).toEqual(['amount']);
    expect(
      fields(evaluateRecipeAmount({ amountMin: 1, amountMax: 2 }, 'ingredient', 'item')),
    ).toEqual(['amountMin', 'amountMin']);
  });

  test('rejects an extra-count-only product because amount remains required', () => {
    const result = evaluateRecipeAmount({ extraCountFraction: 0.5 }, 'product', 'item');
    expect(result.issues).toEqual([
      {
        field: 'amount',
        message: 'extraCountFraction does not replace an exact amount or complete amount range.',
      },
    ]);
  });

  test('requires canonical product ranges to be ascending', () => {
    const result = evaluateRecipeAmount({ amountMin: 4, amountMax: 2 }, 'product', 'fluid');
    expect(result.issues).toEqual([
      {
        field: 'amountMax',
        message: 'canonical amount ranges require amountMin <= amountMax.',
      },
    ]);
    expect(result.effective).toEqual({ amountMin: 4, amountMax: 2 });
  });

  test('supports the explicit raw descending product fallback', () => {
    const result = evaluateRecipeAmount({ amountMin: 4, amountMax: 2 }, 'product', 'item', {
      allowDescendingProductRange: true,
    });
    expect(result.issues).toEqual([]);
    expect(result.effective).toEqual({ amountMin: 4, amountMax: 4 });
  });

  test('does not apply the descending fallback to ingredients', () => {
    const result = evaluateRecipeAmount({ amountMin: 4, amountMax: 2 }, 'ingredient', 'fluid', {
      allowDescendingProductRange: true,
    });
    expect(result.issues.map(({ message }) => message)).toEqual([
      'ingredients require an exact amount; amount ranges are product-only.',
      'ingredient components cannot use an amount range.',
      'canonical amount ranges require amountMin <= amountMax.',
    ]);
  });
});

import { sourceFileId } from '@comblang/shared';
import { describe, expect, test } from 'vitest';

import { createBlueprintParameterSession } from './blueprint-parameters.js';
import {
  createBlueprintRecipeIngredientReference,
  inspectBlueprintRecipeIngredientReference,
  projectBlueprintRecipeIngredientReference,
} from './blueprint-recipe-ingredient-reference.js';

const callSource = Object.freeze({
  fileId: sourceFileId('ingredient-reference.ts'),
  start: 20,
  end: 42,
});
const useSource = Object.freeze({
  fileId: sourceFileId('ingredient-reference.ts'),
  start: 20,
  end: 57,
});

describe('source recipe ingredient references', () => {
  test('keeps an authenticated parent and local index on opaque typed leaves', () => {
    const session = createBlueprintParameterSession();
    const parameter = session.signal('Part', { source: callSource });
    const reference = createBlueprintRecipeIngredientReference(session, parameter, 2, callSource);
    const signal = projectBlueprintRecipeIngredientReference(reference, 'signal', useSource)!;
    const amount = projectBlueprintRecipeIngredientReference(reference, 'amount', useSource)!;

    const rootInspection = inspectBlueprintRecipeIngredientReference(reference)!;
    expect(rootInspection.reference).toBe(reference);
    expect(rootInspection.session).toBe(session);
    expect(rootInspection.parameter).toBe(parameter);
    expect(rootInspection.index).toBe(2);
    expect(rootInspection.callSource).toEqual(callSource);
    const signalInspection = inspectBlueprintRecipeIngredientReference(signal)!;
    expect(signalInspection.reference).toBe(signal);
    expect(signalInspection.parameter).toBe(parameter);
    expect(signalInspection.index).toBe(2);
    expect(signalInspection.slot).toBe('signal');
    expect(signalInspection.source).toEqual(useSource);
    const amountInspection = inspectBlueprintRecipeIngredientReference(amount)!;
    expect(amountInspection.reference).toBe(amount);
    expect(amountInspection.parameter).toBe(parameter);
    expect(amountInspection.index).toBe(2);
    expect(amountInspection.slot).toBe('amount');
    expect(amountInspection.source).toEqual(useSource);
    expect(Object.is(signal, amount)).toBe(false);
    expect(() => Object.keys(signal)).toThrowError(expect.objectContaining({ code: 'CP1001' }));
    expect(inspectBlueprintRecipeIngredientReference({ signal, amount })).toBeUndefined();
  });

  test('rejects invalid indices, numeric roots, foreign roots and access outside the two fields', () => {
    const session = createBlueprintParameterSession();
    const signal = session.signal('Part', { source: callSource });
    const number = session.number('Amount', { defaultValue: 1, source: callSource });
    const foreignSession = createBlueprintParameterSession();
    const foreign = foreignSession.signal('Foreign', { source: callSource });

    expect(() =>
      createBlueprintRecipeIngredientReference(session, signal, -1, callSource),
    ).toThrowError(
      expect.objectContaining({ code: 'CP1000', path: '$.ingredient.index', span: callSource }),
    );
    expect(() =>
      createBlueprintRecipeIngredientReference(session, number, 0, callSource),
    ).toThrowError(expect.objectContaining({ code: 'CP1001', span: callSource }));
    expect(() =>
      createBlueprintRecipeIngredientReference(session, foreign, 0, callSource),
    ).toThrowError(expect.objectContaining({ code: 'CP1001' }));
    const reference = createBlueprintRecipeIngredientReference(session, signal, 0, callSource);
    expect(() =>
      projectBlueprintRecipeIngredientReference(reference, 'prototype', useSource),
    ).toThrowError(expect.objectContaining({ code: 'CP1001', span: useSource }));
  });
});

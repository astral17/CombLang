import { signal } from '@comblang/factorio';
import type { SourceSpan } from '@comblang/shared';
import { describe, expect, test } from 'vitest';

import { createBlueprintParameterSession } from './blueprint-parameters.js';
import { bindConstantConfigurationTemplate } from './constant-configuration-binding.js';
import {
  createConstantConfigurationTemplate,
  inspectConstantConfigurationTemplate,
} from './constant-configuration-template.js';
import {
  createBlueprintRecipeIngredientReference,
  projectBlueprintRecipeIngredientReference,
} from './blueprint-recipe-ingredient-reference.js';

const callSource: SourceSpan = {
  fileId: 'constant-recipe-ingredient.test.ts' as SourceSpan['fileId'],
  start: 10,
  end: 30,
};
const signalUse: SourceSpan = { fileId: callSource.fileId, start: 31, end: 55 };
const amountUse: SourceSpan = { fileId: callSource.fileId, start: 57, end: 81 };

describe('Constant recipe ingredient template slots', () => {
  test('captures only the parent declaration and materializes both owned leaves', () => {
    const session = createBlueprintParameterSession();
    const parent = session.signal('Recipe');
    const root = createBlueprintRecipeIngredientReference(session, parent, 4, callSource);
    const signalReference = projectBlueprintRecipeIngredientReference(root, 'signal', signalUse)!;
    const amountReference = projectBlueprintRecipeIngredientReference(root, 'amount', amountUse)!;
    const template = createConstantConfigurationTemplate(session, {
      sections: [{ filters: [{ signal: signalReference, value: amountReference }] }],
    });
    const registration = inspectConstantConfigurationTemplate(template, '$.template');

    expect(template.sections[0]!.filters[0]!.signal).toBe(signalReference);
    expect(template.sections[0]!.filters[0]!.value).toBe(amountReference);
    expect(registration.usedParameters).toEqual([parent]);
    expect(registration.recipeIngredientReferences.map(({ slot }) => slot)).toEqual([
      'signal',
      'amount',
    ]);
  });

  test('drops an absent derived Signal filter before checking its absent amount', () => {
    const session = createBlueprintParameterSession();
    const parent = session.signal('Recipe');
    const root = createBlueprintRecipeIngredientReference(session, parent, 4, callSource);
    const signalReference = projectBlueprintRecipeIngredientReference(root, 'signal', signalUse)!;
    const amountReference = projectBlueprintRecipeIngredientReference(root, 'amount', amountUse)!;
    const template = createConstantConfigurationTemplate(session, {
      sections: [{ filters: [{ signal: signalReference, value: amountReference }] }],
    });

    expect(
      bindConstantConfigurationTemplate(
        template,
        [],
        [{ parameter: parent, index: 4, status: 'absent' }],
      ),
    ).toEqual({ isOn: true, sections: [{ active: true, multiplier: 1, filters: [] }] });
  });

  test('locates a missing amount in a surviving filter and refuses fractional amounts', () => {
    const session = createBlueprintParameterSession();
    const parent = session.signal('Recipe');
    const root = createBlueprintRecipeIngredientReference(session, parent, 4, callSource);
    const amountReference = projectBlueprintRecipeIngredientReference(root, 'amount', amountUse)!;
    const signalValue = signal('item', 'iron-plate');
    const template = createConstantConfigurationTemplate(session, {
      sections: [{ filters: [{ signal: signalValue, value: amountReference }] }],
    });

    expect(() =>
      bindConstantConfigurationTemplate(
        template,
        [],
        [{ parameter: parent, index: 4, status: 'absent' }],
      ),
    ).toThrowError(expect.objectContaining({ code: 'CP1002', span: amountUse }));
    expect(() =>
      bindConstantConfigurationTemplate(
        template,
        [],
        [
          {
            parameter: parent,
            index: 4,
            status: 'present',
            signal: signalValue,
            amount: 0.25,
          },
        ],
      ),
    ).toThrowError(expect.objectContaining({ code: 'CP1000', span: amountUse }));
  });
});

import { describe, expect, test } from 'vitest';
import type { SourceParameterDescriptor } from '@comblang/runtime/source-parameter-binding';
import type { SourceSpan } from '@comblang/shared';

import {
  createParameterDrafts,
  parameterDraftOverrides,
  type ParameterDraft,
} from './parameter-panel.js';

const source: SourceSpan = { fileId: 'panel.test.ts' as SourceSpan['fileId'], start: 0, end: 1 };

function numericDraft(drafts: readonly ParameterDraft[], index: number) {
  const draft = drafts[index];
  if (draft?.kind !== 'number') throw new Error('Expected a numeric draft.');
  return draft;
}

function signalDraft(drafts: readonly ParameterDraft[], index: number) {
  const draft = drafts[index];
  if (draft?.kind !== 'signal') throw new Error('Expected a Signal draft.');
  return draft;
}

function numberParameter(
  id: number,
  label: string,
  defaultValue: number,
): SourceParameterDescriptor {
  return { id, kind: 'number', label, defaultValue, source };
}

function signalParameter(
  id: number,
  label: string,
  defaultValue: { type: 'item' | 'virtual'; name: string; quality?: string },
): SourceParameterDescriptor {
  return { id, kind: 'signal', label, defaultValue, source };
}

describe('parameter panel value drafts', () => {
  test('creates detached editable strings from immutable descriptors', () => {
    const parameters = [
      numberParameter(4, 'Amount', 2.5),
      signalParameter(9, 'Channel', { type: 'virtual', name: 'signal-A', quality: 'rare' }),
    ];
    const drafts = createParameterDrafts(parameters);

    expect(drafts).toEqual([
      { id: 4, kind: 'number', value: '2.5' },
      { id: 9, kind: 'signal', type: 'virtual', name: 'signal-A', quality: 'rare' },
    ]);
    numericDraft(drafts, 0).value = '8';
    signalDraft(drafts, 1).name = 'edited';
    expect(parameters[0]!.defaultValue).toBe(2.5);
    expect(parameters[1]!.defaultValue).toEqual({
      type: 'virtual',
      name: 'signal-A',
      quality: 'rare',
    });
  });

  test('converts fractions, negative values and exponent notation without clamping', () => {
    const parameters = [
      numberParameter(0, 'Zero', 0),
      numberParameter(1, 'Negative', -2),
      numberParameter(2, 'Fraction', 1.25),
      numberParameter(3, 'Exponent', 100),
    ];
    const drafts = createParameterDrafts(parameters);
    numericDraft(drafts, 0).value = '-0';
    numericDraft(drafts, 1).value = '-3.5';
    numericDraft(drafts, 2).value = '0.125';
    numericDraft(drafts, 3).value = '2.5e2';

    expect(parameterDraftOverrides(parameters, drafts)).toEqual([
      { id: 1, value: -3.5 },
      { id: 2, value: 0.125 },
      { id: 3, value: 250 },
    ]);
  });

  test('sends blank, non-finite and fractional drafts to Worker validation as entered values', () => {
    const parameters = [numberParameter(0, 'Blank', 5), numberParameter(1, 'Infinite', 6)];
    const drafts = createParameterDrafts(parameters);
    numericDraft(drafts, 0).value = '  ';
    numericDraft(drafts, 1).value = 'Infinity';

    const overrides = parameterDraftOverrides(parameters, drafts);
    expect(overrides[0]?.id).toBe(0);
    expect(Number.isNaN(overrides[0]?.value as number)).toBe(true);
    expect(overrides[1]).toEqual({ id: 1, value: Infinity });
  });

  test('omits unchanged values and keeps duplicate labels/defaults distinct by id', () => {
    const parameters = [numberParameter(10, 'Duplicate', 7), numberParameter(20, 'Duplicate', 7)];
    const drafts = createParameterDrafts(parameters);
    if (drafts[1]!.kind !== 'number') throw new Error('Expected a numeric draft.');
    drafts[1]!.value = '8';

    expect(parameterDraftOverrides(parameters, drafts)).toEqual([{ id: 20, value: 8 }]);
  });

  test('preserves raw Signal edits and normalizes quality only for default equality', () => {
    const parameters = [
      signalParameter(0, 'Normal', { type: 'item', name: 'iron-plate' }),
      signalParameter(1, 'Reserved', { type: 'virtual', name: 'signal-A' }),
      signalParameter(2, 'Rare', { type: 'virtual', name: 'signal-B', quality: 'rare' }),
    ];
    const drafts = createParameterDrafts(parameters);
    signalDraft(drafts, 0).quality = 'normal';
    signalDraft(drafts, 1).name = 'signal-each';
    signalDraft(drafts, 1).quality = '  custom quality  ';
    signalDraft(drafts, 2).quality = '';

    expect(parameterDraftOverrides(parameters, drafts)).toEqual([
      {
        id: 1,
        value: { type: 'virtual', name: 'signal-each', quality: '  custom quality  ' },
      },
      { id: 2, value: { type: 'virtual', name: 'signal-B' } },
    ]);
  });

  test('omits empty or normal quality when equal to the original default', () => {
    const parameters = [signalParameter(0, 'Default', { type: 'virtual', name: 'signal-A' })];
    const drafts = createParameterDrafts(parameters);
    signalDraft(drafts, 0).quality = 'normal';
    expect(parameterDraftOverrides(parameters, drafts)).toEqual([]);
    signalDraft(drafts, 0).quality = '';
    expect(parameterDraftOverrides(parameters, drafts)).toEqual([]);
  });

  test('rejects draft arrays not positionally aligned with descriptor IDs and kinds', () => {
    const parameters = [numberParameter(2, 'Amount', 5)];
    expect(() => parameterDraftOverrides(parameters, [])).toThrow(/align/);
    expect(() =>
      parameterDraftOverrides(parameters, [{ id: 3, kind: 'number', value: '5' }]),
    ).toThrow(/align/);
    expect(() =>
      parameterDraftOverrides(parameters, [
        { id: 2, kind: 'signal', type: 'item', name: 'iron-plate', quality: '' },
      ]),
    ).toThrow(/align/);
  });

  test('restoring original drafts removes previous overrides, including unused declarations', () => {
    const parameters = [numberParameter(0, 'Used', 5), numberParameter(1, 'Unused', 5)];
    const drafts = createParameterDrafts(parameters);
    const draft = drafts[0]!;
    if (draft.kind !== 'number') throw new Error('Expected a numeric draft.');
    draft.value = '9';
    expect(parameterDraftOverrides(parameters, drafts)).toEqual([{ id: 0, value: 9 }]);
    draft.value = '5';
    expect(parameterDraftOverrides(parameters, drafts)).toEqual([]);
    expect(parameterDraftOverrides(parameters, createParameterDrafts(parameters))).toEqual([]);
  });
});

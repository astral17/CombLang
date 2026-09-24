import { signal } from '@comblang/factorio';
import type { SourceFileId } from '@comblang/shared';
import { describe, expect, test } from 'vitest';

import { createBlueprintParameterSession } from './blueprint-parameters.js';
import {
  assertBlueprintParameterNumberValue,
  canonicalizeBlueprintParameterSignal,
  createBlueprintParameterDataBudget,
  lookupBlueprintParameterSlot,
  openBlueprintParameterArray,
  openBlueprintParameterRecord,
  readBlueprintParameterBindings,
} from './blueprint-parameter-validation.js';

const source = { fileId: 'validation-test' as SourceFileId, start: 2, end: 8 };

describe('shared blueprint parameter validation', () => {
  test('reads bounded plain records and arrays without evaluating accessors', () => {
    const budget = createBlueprintParameterDataBudget();
    let calls = 0;
    const record = {};
    Object.defineProperty(record, 'danger', {
      enumerable: true,
      get() {
        calls += 1;
        return true;
      },
    });
    expect(() => openBlueprintParameterRecord(record, '$.record', 0, budget)).toThrowError(
      expect.objectContaining({ code: 'CP1000', path: '$.record.danger' }),
    );
    expect(calls).toBe(0);

    const sparse = new Array(1);
    expect(() =>
      openBlueprintParameterArray(sparse, '$.items', 0, createBlueprintParameterDataBudget()),
    ).toThrowError(expect.objectContaining({ code: 'CP1000', path: '$.items[0]' }));
  });

  test('looks up nominal slots by session and expected domain', () => {
    const session = createBlueprintParameterSession();
    const foreign = createBlueprintParameterSession();
    const count = session.number('count');
    const target = foreign.signal('target', { source });

    expect(lookupBlueprintParameterSlot(count, 'number', session, '$.count')?.handle).toBe(count);
    expect(() => lookupBlueprintParameterSlot(count, 'signal', session, '$.signal')).toThrowError(
      expect.objectContaining({ code: 'CP1001', path: '$.signal' }),
    );
    expect(() => lookupBlueprintParameterSlot(target, 'signal', session, '$.target')).toThrowError(
      expect.objectContaining({ code: 'CP1001', path: '$.target', span: source }),
    );
  });

  test('parses bindings once, preserving handle identity while rejecting duplicates and getters', () => {
    const session = createBlueprintParameterSession();
    const parameter = session.number('count', { source });
    const parsed = readBlueprintParameterBindings(session, [{ parameter, value: 0 }]);
    expect(parsed).toMatchObject([{ parameter, value: 0, registration: { kind: 'number' } }]);

    expect(() =>
      readBlueprintParameterBindings(session, [
        { parameter, value: 1 },
        { parameter, value: 2 },
      ]),
    ).toThrowError(
      expect.objectContaining({ code: 'CP1001', path: '$.bindings[1].parameter', span: source }),
    );

    let getterCalls = 0;
    const entry = { parameter };
    Object.defineProperty(entry, 'value', {
      enumerable: true,
      get() {
        getterCalls += 1;
        return 5;
      },
    });
    expect(() => readBlueprintParameterBindings(session, [entry])).toThrowError(
      expect.objectContaining({ code: 'CP1000', path: '$.bindings[0].value' }),
    );
    expect(getterCalls).toBe(0);
  });

  test('enforces field-specific number domains and canonicalizes Signal IDs', () => {
    expect(assertBlueprintParameterNumberValue(1.5, '$.multiplier', 'finite')).toBe(1.5);
    expect(() =>
      assertBlueprintParameterNumberValue(1.5, '$.operand.value', 'safe-integer', source),
    ).toThrowError(
      expect.objectContaining({ code: 'CP1000', path: '$.operand.value', span: source }),
    );
    expect(() =>
      assertBlueprintParameterNumberValue(Infinity, '$.operand.value', 'finite'),
    ).toThrow(expect.objectContaining({ code: 'CP1000' }));

    expect(
      canonicalizeBlueprintParameterSignal(signal('item', 'iron-plate', 'uncommon'), '$.signal'),
    ).toEqual(signal('item', 'iron-plate', 'uncommon'));
    expect(() =>
      canonicalizeBlueprintParameterSignal(
        { type: 'invalid', name: 'signal-A' },
        '$.signal',
        source,
      ),
    ).toThrowError(
      expect.objectContaining({
        code: 'CP1000',
        path: '$.signal.type',
        span: source,
      }),
    );
  });
});

import { signal } from '@comblang/factorio';
import type { SourceFileId, SourceSpan } from '@comblang/shared';
import { describe, expect, test } from 'vitest';

import { createBlueprintParameterSession } from './blueprint-parameters.js';
import { createBlueprintNumericExpression } from './blueprint-numeric-expression.js';
import { bindConstantConfigurationTemplate } from './constant-configuration-binding.js';
import type { BlueprintParameterBinding } from './blueprint-parameter-validation.js';
import { createConstantConfigurationTemplate } from './constant-configuration-template.js';

const source: SourceSpan = { fileId: 'binding-test' as SourceFileId, start: 4, end: 11 };

describe('binding symbolic Constant configuration templates', () => {
  test('evaluates reused multiplier expressions with defaults and per-call overrides', () => {
    const session = createBlueprintParameterSession();
    const multiplier = session.number('multiplier', { defaultValue: 1.5, source });
    const count = session.number('count', { defaultValue: 3 });
    const target = session.signal('target', {
      defaultValue: signal('item', 'iron-plate'),
    });
    const expression = createBlueprintNumericExpression(session, {
      kind: 'binary',
      operator: 'add',
      left: { kind: 'parameter', parameter: multiplier },
      right: { kind: 'literal', value: 0.25 },
    });
    const template = createConstantConfigurationTemplate(session, {
      sections: [
        { multiplier: expression, filters: [{ signal: target, value: count }] },
        {
          multiplier: expression,
          filters: [{ signal: signal('virtual', 'signal-B'), value: 4 }],
        },
      ],
    });

    const defaults = bindConstantConfigurationTemplate(template);
    expect(defaults.sections.map(({ multiplier: value }) => value)).toEqual([1.75, 1.75]);
    expect(defaults.sections[0]?.filters[0]?.value).toBe(3);

    const firstOverride = bindConstantConfigurationTemplate(template, [
      { parameter: multiplier, value: 2.25 },
      { parameter: count, value: 5 },
      { parameter: target, value: signal('item', 'iron-plate', 'uncommon') },
    ]);
    expect(firstOverride.sections.map(({ multiplier: value }) => value)).toEqual([2.5, 2.5]);
    expect(firstOverride.sections[0]?.filters[0]?.value).toBe(5);

    const secondOverride = bindConstantConfigurationTemplate(template, [
      { parameter: multiplier, value: 4.5 },
    ]);
    expect(secondOverride.sections.map(({ multiplier: value }) => value)).toEqual([4.75, 4.75]);
    expect(defaults.sections.map(({ multiplier: value }) => value)).toEqual([1.75, 1.75]);
  });

  test('binds ordered filter-count expressions with shared subexpressions and per-call defaults', () => {
    const session = createBlueprintParameterSession();
    const base = session.number('base', { defaultValue: 2, source });
    const extra = session.number('extra', { defaultValue: 3 });
    const target = session.signal('target', {
      defaultValue: signal('item', 'iron-plate'),
    });
    const shared = createBlueprintNumericExpression(session, {
      kind: 'binary',
      operator: 'add',
      left: { kind: 'parameter', parameter: base },
      right: { kind: 'literal', value: 1 },
    });
    const firstCount = createBlueprintNumericExpression(session, {
      kind: 'binary',
      operator: 'add',
      left: shared,
      right: { kind: 'parameter', parameter: extra },
    });
    const secondCount = createBlueprintNumericExpression(session, {
      kind: 'binary',
      operator: 'multiply',
      left: shared,
      right: { kind: 'literal', value: 2 },
    });
    const template = createConstantConfigurationTemplate(session, {
      sections: [
        {
          filters: [
            { signal: target, value: firstCount },
            { signal: signal('virtual', 'signal-B'), value: secondCount },
            { signal: signal('virtual', 'signal-C'), value: 17 },
          ],
        },
        {
          filters: [
            { signal: target, value: firstCount },
            { signal: target, value: extra },
          ],
        },
      ],
    });

    const defaults = bindConstantConfigurationTemplate(template);
    expect(defaults.sections.map(({ filters }) => filters.map(({ value }) => value))).toEqual([
      [6, 6, 17],
      [6, 3],
    ]);

    const firstOverride = bindConstantConfigurationTemplate(template, [
      { parameter: base, value: 5 },
      { parameter: extra, value: 4 },
    ]);
    expect(firstOverride.sections.map(({ filters }) => filters.map(({ value }) => value))).toEqual([
      [10, 12, 17],
      [10, 4],
    ]);

    const secondOverride = bindConstantConfigurationTemplate(template, [
      { parameter: base, value: 1 },
      { parameter: extra, value: 2 },
    ]);
    expect(secondOverride.sections.map(({ filters }) => filters.map(({ value }) => value))).toEqual(
      [
        [4, 4, 17],
        [4, 2],
      ],
    );
    expect(defaults.sections.map(({ filters }) => filters.map(({ value }) => value))).toEqual([
      [6, 6, 17],
      [6, 3],
    ]);
  });

  test('requires safe-integer expression results before Constant int32 normalization', () => {
    const session = createBlueprintParameterSession();
    const base = session.number('base', { defaultValue: -1, source });
    const expression = createBlueprintNumericExpression(session, {
      kind: 'binary',
      operator: 'add',
      left: { kind: 'parameter', parameter: base },
      right: { kind: 'literal', value: 1 },
    });
    const template = createConstantConfigurationTemplate(session, {
      sections: [{ filters: [{ signal: signal('virtual', 'signal-A'), value: expression }] }],
    });

    expect(bindConstantConfigurationTemplate(template).sections[0]?.filters[0]?.value).toBe(0);
    expect(
      bindConstantConfigurationTemplate(template, [{ parameter: base, value: -4 }]).sections[0]
        ?.filters[0]?.value,
    ).toBe(-3);
    expect(
      bindConstantConfigurationTemplate(template, [{ parameter: base, value: 2_147_483_647 }])
        .sections[0]?.filters[0]?.value,
    ).toBe(-2_147_483_648);

    expect(() =>
      bindConstantConfigurationTemplate(template, [{ parameter: base, value: 0.5 }]),
    ).toThrowError(
      expect.objectContaining({
        code: 'CP1000',
        path: '$.sections[0].filters[0].value',
        span: source,
        message: expect.stringContaining('safe integers'),
      }),
    );
    expect(() =>
      bindConstantConfigurationTemplate(template, [
        { parameter: base, value: Number.MAX_SAFE_INTEGER },
      ]),
    ).toThrowError(
      expect.objectContaining({
        code: 'CP1000',
        path: '$.sections[0].filters[0].value',
        span: source,
        message: expect.stringContaining('safe integers'),
      }),
    );

    const overflowSession = createBlueprintParameterSession();
    const large = overflowSession.number('large', { defaultValue: 1, source });
    const overflow = createBlueprintNumericExpression(overflowSession, {
      kind: 'binary',
      operator: 'multiply',
      left: { kind: 'parameter', parameter: large },
      right: { kind: 'literal', value: Number.MAX_VALUE },
    });
    const overflowTemplate = createConstantConfigurationTemplate(overflowSession, {
      sections: [{ filters: [{ signal: signal('virtual', 'signal-A'), value: overflow }] }],
    });
    expect(() =>
      bindConstantConfigurationTemplate(overflowTemplate, [{ parameter: large, value: 2 }]),
    ).toThrowError(
      expect.objectContaining({
        code: 'CP1000',
        path: '$.sections[0].filters[0].value',
        span: source,
        message: expect.stringContaining('finite number'),
      }),
    );
  });

  test('preserves count-expression missing-default paths and permits retry', () => {
    const session = createBlueprintParameterSession();
    const amount = session.number('amount', { source });
    const expression = createBlueprintNumericExpression(session, {
      kind: 'binary',
      operator: 'add',
      left: { kind: 'parameter', parameter: amount },
      right: { kind: 'literal', value: 1 },
    });
    const template = createConstantConfigurationTemplate(session, {
      sections: [{ filters: [{ signal: signal('virtual', 'signal-A'), value: expression }] }],
    });

    expect(() => bindConstantConfigurationTemplate(template)).toThrowError(
      expect.objectContaining({
        code: 'CP1002',
        path: '$.sections[0].filters[0].value.left.parameter',
        span: source,
      }),
    );
    const retried = bindConstantConfigurationTemplate(template, [{ parameter: amount, value: 4 }]);
    expect(retried.sections[0]?.filters[0]?.value).toBe(5);
  });

  test('keeps multiplier expressions finite-double, preserves negative zero and supports retry', () => {
    const session = createBlueprintParameterSession();
    const amount = session.number('amount', { source });
    const expression = createBlueprintNumericExpression(session, {
      kind: 'binary',
      operator: 'add',
      left: { kind: 'parameter', parameter: amount },
      right: { kind: 'literal', value: 0.25 },
    });
    const template = createConstantConfigurationTemplate(session, {
      sections: [{ multiplier: expression, filters: [] }],
    });

    expect(() => bindConstantConfigurationTemplate(template)).toThrowError(
      expect.objectContaining({
        code: 'CP1002',
        path: '$.sections[0].multiplier.left.parameter',
        span: source,
      }),
    );
    expect(() =>
      bindConstantConfigurationTemplate(template, [{ parameter: amount, value: Infinity }]),
    ).toThrowError(
      expect.objectContaining({
        code: 'CP1000',
        path: '$.sections[0].multiplier.left.value',
        span: source,
      }),
    );

    const concrete = bindConstantConfigurationTemplate(template, [
      { parameter: amount, value: 2_147_483_648.5 },
    ]);
    expect(concrete.sections[0]?.multiplier).toBe(2_147_483_648.75);
    expect(() =>
      bindConstantConfigurationTemplate(template, [{ parameter: amount, value: Infinity }]),
    ).toThrowError(expect.objectContaining({ code: 'CP1000' }));
    expect(concrete.sections[0]?.multiplier).toBe(2_147_483_648.75);
    expect(Object.isFrozen(concrete)).toBe(true);

    const negativeZero = createBlueprintNumericExpression(session, {
      kind: 'negate',
      operand: { kind: 'literal', value: 0 },
    });
    const negativeZeroTemplate = createConstantConfigurationTemplate(session, {
      sections: [{ multiplier: negativeZero, filters: [] }],
    });
    const negativeZeroBound = bindConstantConfigurationTemplate(negativeZeroTemplate);
    expect(Object.is(negativeZeroBound.sections[0]?.multiplier, -0)).toBe(true);
    expect(Object.is(concrete.sections[0]?.multiplier, -0)).toBe(false);
  });

  test('rejects non-finite expression overflow at the multiplier path', () => {
    const session = createBlueprintParameterSession();
    const overflow = createBlueprintNumericExpression(session, {
      kind: 'binary',
      operator: 'multiply',
      left: { kind: 'literal', value: Number.MAX_VALUE },
      right: { kind: 'literal', value: 2 },
    });
    const template = createConstantConfigurationTemplate(session, {
      sections: [{ multiplier: overflow, filters: [] }],
    });

    expect(() => bindConstantConfigurationTemplate(template)).toThrowError(
      expect.objectContaining({
        code: 'CP1000',
        path: '$.sections[0].multiplier',
        message: expect.stringContaining('finite number'),
      }),
    );
  });

  test('resolves defaults and overrides by handle into a fresh canonical configuration', () => {
    const session = createBlueprintParameterSession();
    const count = session.number('count', { defaultValue: 2, source });
    const target = session.signal('target', {
      defaultValue: signal('item', 'iron-plate', 'uncommon'),
    });
    const template = createConstantConfigurationTemplate(session, {
      isOn: false,
      sections: [
        {
          active: false,
          group: 'backup',
          multiplier: 0,
          filters: [
            { signal: target, value: count },
            { signal: target, value: 0 },
          ],
        },
      ],
    });
    const before = JSON.stringify(template, (_key, value: unknown) =>
      typeof value === 'object' && value !== null && 'kind' in value
        ? { parameter: value.kind, label: (value as { readonly label?: unknown }).label }
        : value,
    );

    const resolved = bindConstantConfigurationTemplate(template, [
      { parameter: count, value: 2_147_483_649 },
    ]);

    expect(resolved).toEqual({
      isOn: false,
      sections: [
        {
          active: false,
          group: 'backup',
          multiplier: 0,
          filters: [
            { signal: signal('item', 'iron-plate', 'uncommon'), value: -2_147_483_647 },
            { signal: signal('item', 'iron-plate', 'uncommon'), value: 0 },
          ],
        },
      ],
    });
    expect(Object.isFrozen(resolved)).toBe(true);
    expect(Object.isFrozen(resolved.sections[0]?.filters)).toBe(true);
    expect(
      JSON.stringify(template, (_key, value: unknown) =>
        typeof value === 'object' && value !== null && 'kind' in value
          ? { parameter: value.kind, label: (value as { readonly label?: unknown }).label }
          : value,
      ),
    ).toBe(before);
  });

  test('reports missing and invalid values at the slot with the declaration span', () => {
    const session = createBlueprintParameterSession();
    const count = session.number('count', { source });
    const template = createConstantConfigurationTemplate(session, {
      sections: [{ filters: [{ signal: signal('virtual', 'signal-A'), value: count }] }],
    });

    expect(() => bindConstantConfigurationTemplate(template)).toThrowError(
      expect.objectContaining({
        code: 'CP1002',
        path: '$.sections[0].filters[0].value',
        span: source,
      }),
    );
    expect(() =>
      bindConstantConfigurationTemplate(template, [{ parameter: count, value: 1.5 }]),
    ).toThrowError(
      expect.objectContaining({
        code: 'CP1000',
        path: '$.sections[0].filters[0].value',
        span: source,
      }),
    );
    expect(() =>
      bindConstantConfigurationTemplate(template, [{ parameter: count, value: 1.25 }]),
    ).toThrowError(
      expect.objectContaining({
        code: 'CP1000',
        message: expect.stringContaining('safe integers'),
        path: '$.sections[0].filters[0].value',
        span: source,
      }),
    );
  });

  test('rejects duplicate, unused, foreign, and wrong-kind bindings', () => {
    const session = createBlueprintParameterSession();
    const other = createBlueprintParameterSession();
    const count = session.number('count', { defaultValue: 1 });
    const unused = session.number('unused', { defaultValue: 3 });
    const foreign = other.number('foreign', { defaultValue: 1 });
    const target = session.signal('target', { defaultValue: signal('item', 'iron-plate') });
    const template = createConstantConfigurationTemplate(session, {
      sections: [{ filters: [{ signal: target, value: count }] }],
    });

    expect(() =>
      bindConstantConfigurationTemplate(template, [
        { parameter: count, value: 1 },
        { parameter: count, value: 2 },
      ]),
    ).toThrowError(expect.objectContaining({ code: 'CP1001', path: '$.bindings[1].parameter' }));
    expect(() =>
      bindConstantConfigurationTemplate(template, [{ parameter: unused, value: 3 }]),
    ).toThrowError(expect.objectContaining({ code: 'CP1001', path: '$.bindings' }));
    expect(() =>
      bindConstantConfigurationTemplate(template, [{ parameter: foreign, value: 1 }]),
    ).toThrowError(expect.objectContaining({ code: 'CP1001', path: '$.bindings[0].parameter' }));
    expect(() =>
      bindConstantConfigurationTemplate(template, [{ parameter: count, value: {} }]),
    ).toThrowError(
      expect.objectContaining({ code: 'CP1000', path: '$.sections[0].filters[0].value' }),
    );
  });

  test('keeps global duplicate, foreign and unused checks for expression dependencies', () => {
    const session = createBlueprintParameterSession();
    const other = createBlueprintParameterSession();
    const count = session.number('count', { defaultValue: 1 });
    const unused = session.number('unused', { defaultValue: 3 });
    const foreign = other.number('foreign', { defaultValue: 1 });
    const expression = createBlueprintNumericExpression(session, {
      kind: 'binary',
      operator: 'add',
      left: { kind: 'parameter', parameter: count },
      right: { kind: 'literal', value: 0 },
    });
    const template = createConstantConfigurationTemplate(session, {
      sections: [{ filters: [{ signal: signal('virtual', 'signal-A'), value: expression }] }],
    });

    expect(() =>
      bindConstantConfigurationTemplate(template, [
        { parameter: count, value: 1 },
        { parameter: count, value: 2 },
      ]),
    ).toThrowError(expect.objectContaining({ code: 'CP1001', path: '$.bindings[1].parameter' }));
    expect(() =>
      bindConstantConfigurationTemplate(template, [{ parameter: unused, value: 3 }]),
    ).toThrowError(expect.objectContaining({ code: 'CP1001', path: '$.bindings' }));
    expect(() =>
      bindConstantConfigurationTemplate(template, [{ parameter: foreign, value: 1 }]),
    ).toThrowError(expect.objectContaining({ code: 'CP1001', path: '$.bindings[0].parameter' }));
  });

  test('validates malformed Signal IDs at their slot and keeps earlier results untouched', () => {
    const session = createBlueprintParameterSession();
    const count = session.number('count', { defaultValue: 5 });
    const target = session.signal('target', { source });
    const template = createConstantConfigurationTemplate(session, {
      sections: [{ filters: [{ signal: target, value: count }] }],
    });
    const good = bindConstantConfigurationTemplate(template, [
      { parameter: target, value: signal('fluid', 'water', 'rare') },
    ]);

    expect(() =>
      bindConstantConfigurationTemplate(template, [
        { parameter: target, value: { type: 'not-a-signal', name: 'water' } },
      ]),
    ).toThrowError(
      expect.objectContaining({
        code: 'CP1000',
        path: '$.sections[0].filters[0].signal.type',
        span: source,
      }),
    );
    expect(good.sections[0]?.filters[0]?.signal).toEqual(signal('fluid', 'water', 'rare'));
    expect(good.sections[0]?.filters[0]?.value).toBe(5);
  });

  test('binding records are bounded data-only records and accessors are not invoked', () => {
    const session = createBlueprintParameterSession();
    const count = session.number('count', { defaultValue: 1 });
    const template = createConstantConfigurationTemplate(session, {
      sections: [{ filters: [{ signal: signal('virtual', 'signal-A'), value: count }] }],
    });
    let getterCalls = 0;
    const entry = { parameter: count };
    Object.defineProperty(entry, 'value', {
      enumerable: true,
      get() {
        getterCalls += 1;
        return 4;
      },
    });

    expect(() =>
      bindConstantConfigurationTemplate(template, [entry as unknown as BlueprintParameterBinding]),
    ).toThrowError(expect.objectContaining({ code: 'CP1000', path: '$.bindings[0].value' }));
    expect(getterCalls).toBe(0);
    expect(() =>
      bindConstantConfigurationTemplate(
        template,
        new Array(1) as unknown as readonly BlueprintParameterBinding[],
      ),
    ).toThrowError(expect.objectContaining({ code: 'CP1000', path: '$.bindings[0]' }));
  });
});

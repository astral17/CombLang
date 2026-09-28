import { constantConfigurationLimits, signal, type SignalId } from '@comblang/factorio';
import type { SourceFileId } from '@comblang/shared';
import { describe, expect, test } from 'vitest';

import {
  assertBlueprintParameterFromSession,
  createBlueprintParameterSession,
} from './blueprint-parameters.js';
import { createBlueprintNumericExpression } from './blueprint-numeric-expression.js';
import {
  createConstantConfigurationTemplate,
  inspectConstantConfigurationTemplate,
} from './constant-configuration-template.js';
describe('symbolic Constant configuration templates', () => {
  test('preserves one registered expression reused by section multipliers only', () => {
    const session = createBlueprintParameterSession();
    const multiplier = session.number('multiplier', {
      defaultValue: 1.5,
      source: {
        fileId: 'constant-template.test.ts' as SourceFileId,
        start: 12,
        end: 22,
      },
    });
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
        { multiplier: expression, filters: [{ signal: target, value: multiplier }] },
        { multiplier: expression, filters: [{ signal: target, value: 4 }] },
      ],
    });

    expect(template.sections.map(({ multiplier: value }) => value)).toEqual([
      expression,
      expression,
    ]);
    expect(template.sections[0]?.multiplier).toBe(expression);
    expect(template.sections[1]?.multiplier).toBe(expression);
    expect(template.sections[0]?.filters[0]).toEqual({ signal: target, value: multiplier });
    expect(inspectConstantConfigurationTemplate(template, '$.template').usedParameters).toEqual([
      multiplier,
      target,
    ]);
  });

  test('preserves registered expressions in ordered filter-count slots across sections', () => {
    const session = createBlueprintParameterSession();
    const base = session.number('base', { defaultValue: 2 });
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

    const input = {
      sections: [
        {
          filters: [
            { signal: target, value: firstCount },
            { signal: signal('virtual', 'signal-B'), value: secondCount },
            { signal: target, value: 7 },
          ],
        },
        {
          filters: [
            { signal: target, value: firstCount },
            { signal: target, value: extra },
          ],
        },
      ],
    };
    const inputBefore = JSON.stringify(input);
    const template = createConstantConfigurationTemplate(session, input);

    expect(template.sections[0]?.filters.map(({ value }) => value)).toEqual([
      firstCount,
      secondCount,
      7,
    ]);
    expect(template.sections[1]?.filters.map(({ value }) => value)).toEqual([firstCount, extra]);
    expect(inspectConstantConfigurationTemplate(template, '$.template').usedParameters).toEqual([
      target,
      base,
      extra,
    ]);
    expect(JSON.stringify(input)).toBe(inputBefore);
    expect(Object.isFrozen(input)).toBe(false);
    expect(Object.isFrozen(input.sections[0])).toBe(false);
    expect(Object.isFrozen(input.sections[0]?.filters)).toBe(false);
  });

  test('rejects foreign, forged, and unsupported expressions at their slots', () => {
    const session = createBlueprintParameterSession();
    const other = createBlueprintParameterSession();
    const expression = createBlueprintNumericExpression(session, {
      kind: 'literal',
      value: 2,
    });
    const foreign = createBlueprintNumericExpression(other, {
      kind: 'literal',
      value: 3,
    });
    const signalHandle = session.signal('signal', { defaultValue: signal('virtual', 'signal-A') });

    expect(() =>
      createConstantConfigurationTemplate(session, {
        sections: [{ multiplier: foreign, filters: [] }],
      }),
    ).toThrowError(expect.objectContaining({ code: 'CP1001', path: '$.sections[0].multiplier' }));
    expect(() =>
      createConstantConfigurationTemplate(session, {
        sections: [{ multiplier: { kind: 'literal', value: 2 }, filters: [] }],
      }),
    ).toThrowError(expect.objectContaining({ code: 'CP1001', path: '$.sections[0].multiplier' }));
    expect(() =>
      createConstantConfigurationTemplate(session, {
        sections: [{ multiplier: 1, group: expression, filters: [] }],
      }),
    ).toThrowError(expect.objectContaining({ code: 'CP1001', path: '$.sections[0].group' }));
    expect(() =>
      createConstantConfigurationTemplate(session, {
        sections: [{ multiplier: 1, filters: [{ signal: expression, value: 1 }] }],
      }),
    ).toThrowError(
      expect.objectContaining({ code: 'CP1001', path: '$.sections[0].filters[0].signal' }),
    );
    expect(() =>
      createConstantConfigurationTemplate(session, {
        sections: [{ multiplier: 1, filters: [{ signal: signalHandle, value: foreign }] }],
      }),
    ).toThrowError(
      expect.objectContaining({ code: 'CP1001', path: '$.sections[0].filters[0].value' }),
    );
    expect(() =>
      createConstantConfigurationTemplate(session, {
        sections: [
          {
            multiplier: 1,
            filters: [{ signal: signalHandle, value: { kind: 'literal', value: 2 } }],
          },
        ],
      }),
    ).toThrowError(
      expect.objectContaining({ code: 'CP1001', path: '$.sections[0].filters[0].value' }),
    );
    expect(() =>
      createConstantConfigurationTemplate(session, {
        sections: [],
        unsupported: expression,
      }),
    ).toThrowError(expect.objectContaining({ code: 'CP1001', path: '$.unsupported' }));
  });

  test('accounts shared expression DAG nodes and bytes without expanding the graph', () => {
    const session = createBlueprintParameterSession();
    let shared: unknown = createBlueprintNumericExpression(session, {
      kind: 'literal',
      value: 1,
    });
    for (let depth = 0; depth < 18; depth += 1) {
      shared = createBlueprintNumericExpression(session, {
        kind: 'binary',
        operator: 'add',
        left: shared,
        right: shared,
      });
    }
    const repeated = createConstantConfigurationTemplate(session, {
      sections: [
        {
          multiplier: shared,
          filters: [{ signal: signal('virtual', 'signal-A'), value: shared }],
        },
        {
          multiplier: shared,
          filters: [{ signal: signal('virtual', 'signal-A'), value: shared }],
        },
      ],
    });
    expect(repeated.sections[0]?.multiplier).toBe(shared);
    expect(repeated.sections[1]?.multiplier).toBe(shared);
    expect(repeated.sections[0]?.filters[0]?.value).toBe(shared);
    expect(repeated.sections[1]?.filters[0]?.value).toBe(shared);

    const balanced = (depth: number): unknown =>
      depth === 0
        ? { kind: 'literal', value: 1 }
        : {
            kind: 'binary',
            operator: 'add',
            left: balanced(depth - 1),
            right: balanced(depth - 1),
          };
    const largeShared = createBlueprintNumericExpression(session, balanced(10));
    const sharedAcrossSlots = createConstantConfigurationTemplate(session, {
      sections: [
        {
          multiplier: largeShared,
          filters: [{ signal: signal('virtual', 'signal-A'), value: largeShared }],
        },
      ],
    });
    expect(sharedAcrossSlots.sections[0]?.multiplier).toBe(largeShared);
    expect(sharedAcrossSlots.sections[0]?.filters[0]?.value).toBe(largeShared);

    const overBudget = createBlueprintNumericExpression(session, balanced(11));
    expect(() =>
      createConstantConfigurationTemplate(session, {
        sections: [{ filters: [{ signal: signal('virtual', 'signal-A'), value: overBudget }] }],
      }),
    ).toThrowError(
      expect.objectContaining({
        code: 'CP1000',
        path: '$.sections[0].filters[0].value',
        message: expect.stringContaining(`node limit of ${constantConfigurationLimits.maxNodes}`),
      }),
    );

    const largeLabel = session.number('x'.repeat(constantConfigurationLimits.maxBytes - 120));
    const largeExpression = createBlueprintNumericExpression(session, {
      kind: 'parameter',
      parameter: largeLabel,
    });
    expect(() =>
      createConstantConfigurationTemplate(session, {
        sections: [
          { filters: [{ signal: signal('virtual', 'signal-A'), value: largeExpression }] },
        ],
      }),
    ).toThrowError(
      expect.objectContaining({
        code: 'CP1000',
        message: expect.stringContaining('byte limit'),
      }),
    );

    const halfBudgetLabel = session.number(
      'y'.repeat(Math.floor(constantConfigurationLimits.maxBytes / 2)),
    );
    const halfBudgetExpression = createBlueprintNumericExpression(session, {
      kind: 'parameter',
      parameter: halfBudgetLabel,
    });
    const sharedBytes = createConstantConfigurationTemplate(session, {
      sections: [
        {
          multiplier: halfBudgetExpression,
          filters: [{ signal: signal('virtual', 'signal-A'), value: halfBudgetExpression }],
        },
      ],
    });
    expect(sharedBytes.sections[0]?.multiplier).toBe(halfBudgetExpression);
    expect(sharedBytes.sections[0]?.filters[0]?.value).toBe(halfBudgetExpression);
  });

  test('blueprint-wide parameter handles remain scoped when used by Constant', () => {
    const owner = createBlueprintParameterSession();
    const foreign = createBlueprintParameterSession();
    const localCount = owner.number('count', {
      source: { fileId: 'local' as SourceFileId, start: 1, end: 4 },
    });
    const foreignCount = foreign.number('count', {
      source: { fileId: 'foreign' as SourceFileId, start: 5, end: 9 },
    });

    const template = createConstantConfigurationTemplate(owner, {
      sections: [{ filters: [{ signal: signal('virtual', 'signal-A'), value: localCount }] }],
    });
    expect(template.sections[0]?.filters[0]?.value).toBe(localCount);
    expect(() =>
      createConstantConfigurationTemplate(owner, {
        sections: [{ filters: [{ signal: signal('virtual', 'signal-A'), value: foreignCount }] }],
      }),
    ).toThrowError(
      expect.objectContaining({
        code: 'CP1001',
        path: '$.sections[0].filters[0].value',
        span: { fileId: 'foreign' as SourceFileId, start: 5, end: 9 },
      }),
    );
  });

  test('preserves concrete values and nominal references in ordered slots', () => {
    const session = createBlueprintParameterSession();
    const count = session.number('count', { defaultValue: 0 });
    const target = session.signal('target', {
      defaultValue: signal('item', 'iron-plate', 'uncommon'),
    });
    const input = {
      isOn: false,
      sections: [
        {
          active: false,
          group: 'backup',
          multiplier: 1.25,
          filters: [
            { signal: signal('virtual', 'signal-A'), value: 0 },
            { signal: target, value: count },
          ],
        },
        {
          filters: [{ signal: target, value: 2 }],
        },
      ],
    };
    const before = JSON.stringify(input);

    const template = createConstantConfigurationTemplate(session, input);

    expect(template.isOn).toBe(false);
    expect(template.sections).toHaveLength(2);
    expect(template.sections[0]).toMatchObject({
      active: false,
      group: 'backup',
      multiplier: 1.25,
    });
    expect(template.sections[0]?.filters).toEqual([
      { signal: signal('virtual', 'signal-A'), value: 0 },
      { signal: target, value: count },
    ]);
    expect(template.sections[1]).toMatchObject({
      active: true,
      multiplier: 1,
      filters: [{ value: 2 }],
    });
    expect(template.sections[1]?.filters[0]?.signal).toBe(target);
    expect(assertBlueprintParameterFromSession(session, count, '$.count').kind).toBe('number');
    expect(assertBlueprintParameterFromSession(session, target, '$.target').kind).toBe('signal');
    expect(inspectConstantConfigurationTemplate(template, '$.template').session).toBe(session);
    expect(Object.isFrozen(template)).toBe(true);
    expect(Object.isFrozen(template.sections)).toBe(true);
    expect(Object.isFrozen(template.sections[0]?.filters)).toBe(true);
    expect(JSON.stringify(input)).toBe(before);
  });

  test('rejects wrong-kind, foreign, and non-slot parameter references', () => {
    const session = createBlueprintParameterSession();
    const other = createBlueprintParameterSession();
    const count = session.number('count');
    const target = session.signal('target');
    const foreign = other.number('foreign');

    expect(() =>
      createConstantConfigurationTemplate(session, {
        sections: [{ multiplier: target, filters: [] }],
      }),
    ).toThrowError(expect.objectContaining({ code: 'CP1001', path: '$.sections[0].multiplier' }));
    expect(() =>
      createConstantConfigurationTemplate(session, {
        sections: [{ filters: [{ signal: count, value: 1 }] }],
      }),
    ).toThrowError(
      expect.objectContaining({ code: 'CP1001', path: '$.sections[0].filters[0].signal' }),
    );
    expect(() =>
      createConstantConfigurationTemplate(session, {
        sections: [{ filters: [{ signal: target, value: foreign }] }],
      }),
    ).toThrowError(
      expect.objectContaining({ code: 'CP1001', path: '$.sections[0].filters[0].value' }),
    );
    expect(() =>
      createConstantConfigurationTemplate(session, { isOn: count, sections: [] }),
    ).toThrowError(expect.objectContaining({ code: 'CP1001', path: '$.isOn' }));
    expect(() =>
      createConstantConfigurationTemplate(session, {
        sections: [{ filters: [{ signal: { kind: 'signal', label: 'fake' }, value: 1 }] }],
      }),
    ).toThrowError(expect.objectContaining({ code: 'CP1001' }));
  });

  test('rejects accessors without evaluation and enforces the Constant input budget', () => {
    const session = createBlueprintParameterSession();
    let getterCalls = 0;
    const section = { active: true, multiplier: 1 };
    Object.defineProperty(section, 'filters', {
      enumerable: true,
      get() {
        getterCalls += 1;
        return [];
      },
    });
    expect(() =>
      createConstantConfigurationTemplate(session, { sections: [section] }),
    ).toThrowError(expect.objectContaining({ code: 'CP1000', path: '$.sections[0].filters' }));
    expect(getterCalls).toBe(0);

    expect(() =>
      createConstantConfigurationTemplate(session, {
        sections: [{ group: 'x'.repeat(270_000), filters: [] }],
      }),
    ).toThrowError(
      expect.objectContaining({ code: 'CP1000', message: expect.stringContaining('byte limit') }),
    );
  });

  test('rejects cyclic, sparse, and unknown data while leaving original inputs untouched', () => {
    const session = createBlueprintParameterSession();
    const cyclic: unknown[] = [];
    cyclic.push(cyclic);
    expect(() => createConstantConfigurationTemplate(session, { sections: cyclic })).toThrowError(
      expect.objectContaining({ code: 'CP1000' }),
    );

    const sparse = new Array(1);
    expect(() => createConstantConfigurationTemplate(session, { sections: sparse })).toThrowError(
      expect.objectContaining({ code: 'CP1000' }),
    );

    expect(() =>
      createConstantConfigurationTemplate(session, { sections: [], formula: 'future' }),
    ).toThrowError(expect.objectContaining({ code: 'CP1000', path: '$.formula' }));

    const raw = { sections: [{ filters: [{ signal: signal('virtual', 'signal-A'), value: 0 }] }] };
    const before = JSON.stringify(raw);
    const template = createConstantConfigurationTemplate(session, raw);
    expect(JSON.stringify(raw)).toBe(before);
    expect(template.sections[0]?.filters[0]?.signal).toEqual(
      signal('virtual', 'signal-A') as SignalId,
    );
  });
});

import { signal } from '@comblang/factorio';
import type { SourceFileId, SourceSpan } from '@comblang/shared';
import { describe, expect, test } from 'vitest';

import { bindBlueprintConfigurationSet } from './blueprint-configuration-binding.js';
import { createBlueprintConfigurationSet } from './blueprint-configuration-set.js';
import { createBlueprintParameterSession } from './blueprint-parameters.js';
import { createBlueprintNumericExpression } from './blueprint-numeric-expression.js';
import { createArithmeticConfigurationTemplate } from './arithmetic-configuration-template.js';
import { createConstantConfigurationTemplate } from './constant-configuration-template.js';
import { createDeciderConfigurationTemplate } from './decider-configuration-template.js';

const source: SourceSpan = {
  fileId: 'configuration-set.test.ts' as SourceFileId,
  start: 4,
  end: 17,
};

describe('atomic blueprint configuration-set binding', () => {
  test('partitions a shared Decider output expression with another producer family atomically', () => {
    const session = createBlueprintParameterSession();
    const amount = session.number('shared-decider-amount', { defaultValue: 3, source });
    const expression = createBlueprintNumericExpression(session, {
      kind: 'binary',
      operator: 'add',
      left: { kind: 'parameter', parameter: amount },
      right: { kind: 'literal', value: 2 },
    });
    const decider = createDeciderConfigurationTemplate(session, {
      condition: {
        kind: 'compare',
        left: { kind: 'wildcard', value: 'each', refKind: 'single', network: 'network:in' },
        comparator: '>',
        right: { kind: 'constant', value: expression },
      },
      outputs: [
        { mode: 'constant', signal: { kind: 'wildcard', value: 'each' }, value: expression },
        { mode: 'constant', signal: { kind: 'wildcard', value: 'each' }, value: expression },
        { mode: 'copy', signal: { kind: 'wildcard', value: 'anything' } },
      ],
      elseOutputs: [
        { mode: 'constant', signal: { kind: 'wildcard', value: 'anything' }, value: expression },
      ],
    });
    const arithmetic = createArithmeticConfigurationTemplate(session, {
      left: { kind: 'constant', value: amount },
      operation: 'add',
      right: { kind: 'constant', value: 1 },
      output: { kind: 'each' },
    });
    const configurationSet = createBlueprintConfigurationSet(session, [
      { key: 'decision', kind: 'decider', template: decider },
      { key: 'arithmetic', kind: 'arithmetic', template: arithmetic },
    ]);
    const bound = bindBlueprintConfigurationSet(configurationSet, [
      { parameter: amount, value: 10 },
    ]);

    expect(bound[0]).toMatchObject({
      kind: 'decider',
      config: {
        condition: { right: { value: 12 } },
        outputs: [
          { mode: 'constant', value: 12 },
          { mode: 'constant', value: 12 },
          { mode: 'copy' },
        ],
        elseOutputs: [{ mode: 'constant', value: 12 }],
      },
    });
    expect(bound[1]).toMatchObject({
      kind: 'arithmetic',
      config: { left: { kind: 'constant', value: 10 }, right: { kind: 'constant', value: 1 } },
    });
    expect(JSON.stringify(bound)).not.toContain('shared-decider-amount');
    expect(JSON.stringify(bound)).not.toContain('"kind":"binary"');
    expect(Object.isFrozen(bound)).toBe(true);
    expect(Object.isFrozen(bound[0])).toBe(true);
    const previous = JSON.stringify(bound);

    expect(() =>
      bindBlueprintConfigurationSet(configurationSet, [{ parameter: amount, value: 1.5 }]),
    ).toThrowError(
      expect.objectContaining({ code: 'CP1000', path: '$.entries[0].condition.right.value' }),
    );
    expect(JSON.stringify(bound)).toBe(previous);
  });

  test('partitions Constant multiplier/count expressions and direct handles across entries', () => {
    const session = createBlueprintParameterSession();
    const shared = session.number('shared-parameter', { defaultValue: 2.25 });
    const directCount = session.number('direct-count-parameter', { defaultValue: 3 });
    const target = session.signal('target-parameter', {
      defaultValue: signal('item', 'iron-plate'),
    });
    const offset = session.number('offset-parameter', { defaultValue: 4 });
    const multiplierExpression = createBlueprintNumericExpression(session, {
      kind: 'binary',
      operator: 'add',
      left: { kind: 'parameter', parameter: shared },
      right: { kind: 'literal', value: 0.25 },
    });
    const countExpression = createBlueprintNumericExpression(session, {
      kind: 'binary',
      operator: 'subtract',
      left: { kind: 'parameter', parameter: shared },
      right: { kind: 'literal', value: 0.25 },
    });
    const constant = createConstantConfigurationTemplate(session, {
      sections: [
        {
          multiplier: multiplierExpression,
          filters: [
            { signal: target, value: countExpression },
            { signal: signal('virtual', 'signal-B'), value: directCount },
          ],
        },
      ],
    });
    const arithmetic = createArithmeticConfigurationTemplate(session, {
      left: { kind: 'constant', value: offset },
      operation: 'add',
      right: { kind: 'constant', value: 1 },
      output: { kind: 'each' },
    });
    const configurationSet = createBlueprintConfigurationSet(session, [
      { key: 'constant', kind: 'constant', template: constant },
      { key: 'arithmetic', kind: 'arithmetic', template: arithmetic },
    ]);
    const bindings = [
      { parameter: shared, value: 3.25 },
      { parameter: directCount, value: 2_147_483_649 },
      { parameter: target, value: signal('item', 'iron-plate', 'uncommon') },
      { parameter: offset, value: 9 },
    ];
    const bound = bindBlueprintConfigurationSet(configurationSet, bindings);

    expect(bound[0]).toMatchObject({
      kind: 'constant',
      config: {
        sections: [
          {
            multiplier: 3.5,
            filters: [
              {
                signal: signal('item', 'iron-plate', 'uncommon'),
                value: 3,
              },
              { signal: signal('virtual', 'signal-B'), value: -2_147_483_647 },
            ],
          },
        ],
      },
    });
    expect(bound[1]).toMatchObject({
      kind: 'arithmetic',
      config: { left: { kind: 'constant', value: 9 } },
    });
    expect(JSON.stringify(bound)).not.toContain('shared-parameter');
    expect(JSON.stringify(bound)).not.toContain('direct-count-parameter');
    expect(JSON.stringify(bound)).not.toContain('target-parameter');
    expect(JSON.stringify(bound)).not.toContain('offset-parameter');
    const before = JSON.stringify(bound);

    expect(() =>
      bindBlueprintConfigurationSet(configurationSet, [
        ...bindings.slice(0, -1),
        { parameter: offset, value: 1.5 },
      ]),
    ).toThrowError(expect.objectContaining({ code: 'CP1000', path: '$.entries[1].left.value' }));
    expect(JSON.stringify(bound)).toBe(before);
    expect(Object.isFrozen(bound)).toBe(true);
  });

  test('partitions one binding list across ordered leaf templates', () => {
    const session = createBlueprintParameterSession();
    const amount = session.number('amount', { source });
    const constant = createConstantConfigurationTemplate(session, {
      sections: [{ filters: [{ signal: signal('virtual', 'signal-A'), value: amount }] }],
    });
    const arithmetic = createArithmeticConfigurationTemplate(session, {
      left: { kind: 'constant', value: amount },
      operation: 'add',
      right: { kind: 'constant', value: 1 },
      output: { kind: 'each' },
    });
    const configurationSet = createBlueprintConfigurationSet(session, [
      { key: 'constants', kind: 'constant', template: constant },
      { key: 'sum', kind: 'arithmetic', template: arithmetic },
    ]);

    const result = bindBlueprintConfigurationSet(configurationSet, [
      { parameter: amount, value: 3 },
    ]);

    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({
      key: 'constants',
      kind: 'constant',
      config: { sections: [{ filters: [{ value: 3 }] }] },
    });
    expect(result[1]).toMatchObject({
      key: 'sum',
      kind: 'arithmetic',
      config: { left: { value: 3 }, right: { value: 1 } },
    });
    expect(Object.isFrozen(result)).toBe(true);
    expect(result.every(Object.isFrozen)).toBe(true);
  });

  test('preserves global duplicate, foreign and unused-binding paths', () => {
    const session = createBlueprintParameterSession();
    const foreignSession = createBlueprintParameterSession();
    const used = session.number('used');
    const unused = session.number('unused');
    const foreign = foreignSession.number('foreign');
    const template = createConstantConfigurationTemplate(session, {
      sections: [{ filters: [{ signal: signal('virtual', 'signal-A'), value: used }] }],
    });
    const configurationSet = createBlueprintConfigurationSet(session, [
      { key: 'one', kind: 'constant', template },
    ]);

    expect(() =>
      bindBlueprintConfigurationSet(configurationSet, [
        { parameter: used, value: 1 },
        { parameter: used, value: 2 },
      ]),
    ).toThrowError(expect.objectContaining({ code: 'CP1001', path: '$.bindings[1].parameter' }));
    expect(() =>
      bindBlueprintConfigurationSet(configurationSet, [{ parameter: foreign, value: 1 }]),
    ).toThrowError(expect.objectContaining({ code: 'CP1001', path: '$.bindings[0].parameter' }));
    expect(() =>
      bindBlueprintConfigurationSet(configurationSet, [{ parameter: unused, value: 1 }]),
    ).toThrowError(expect.objectContaining({ code: 'CP1001', path: '$.bindings' }));
  });

  test('prefixes leaf failures with the entry path and retains code, detail and source span', () => {
    const session = createBlueprintParameterSession();
    const amount = session.number('amount', { source });
    const template = createConstantConfigurationTemplate(session, {
      sections: [{ filters: [{ signal: signal('virtual', 'signal-A'), value: amount }] }],
    });
    const configurationSet = createBlueprintConfigurationSet(session, [
      { key: 'needs-amount', kind: 'constant', template },
    ]);

    expect(() => bindBlueprintConfigurationSet(configurationSet)).toThrowError(
      expect.objectContaining({
        code: 'CP1002',
        path: '$.entries[0].sections[0].filters[0].value',
        span: source,
        message: expect.stringContaining('has no binding or default'),
      }),
    );
  });

  test('a later entry failure cannot mutate an earlier successful transaction result', () => {
    const session = createBlueprintParameterSession();
    const firstValue = session.number('first', { defaultValue: 2 });
    const laterValue = session.number('later', { defaultValue: 3 });
    const firstTemplate = createConstantConfigurationTemplate(session, {
      sections: [{ filters: [{ signal: signal('virtual', 'signal-A'), value: firstValue }] }],
    });
    const laterTemplate = createArithmeticConfigurationTemplate(session, {
      left: { kind: 'constant', value: laterValue },
      operation: 'add',
      right: { kind: 'constant', value: 1 },
      output: { kind: 'each' },
    });
    const configurationSet = createBlueprintConfigurationSet(session, [
      { key: 'first', kind: 'constant', template: firstTemplate },
      { key: 'later', kind: 'arithmetic', template: laterTemplate },
    ]);
    const prior = bindBlueprintConfigurationSet(configurationSet, [
      { parameter: firstValue, value: 5 },
      { parameter: laterValue, value: 6 },
    ]);
    const before = JSON.stringify(prior);

    expect(() =>
      bindBlueprintConfigurationSet(configurationSet, [
        { parameter: firstValue, value: 8 },
        { parameter: laterValue, value: 1.5 },
      ]),
    ).toThrowError(
      expect.objectContaining({
        code: 'CP1000',
        path: '$.entries[1].left.value',
        span: undefined,
      }),
    );
    expect(JSON.stringify(prior)).toBe(before);
    const priorConstant = prior[0];
    if (priorConstant?.kind !== 'constant') throw new Error('expected the first bound Constant');
    expect(priorConstant.config.sections[0]?.filters[0]?.value).toBe(5);
  });
});

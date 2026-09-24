import { signal } from '@comblang/factorio';
import type { SourceFileId, SourceSpan } from '@comblang/shared';
import { describe, expect, test } from 'vitest';

import { createBlueprintParameterSession } from './blueprint-parameters.js';
import { bindDeciderConfigurationTemplate } from './decider-configuration-binding.js';
import { createDeciderConfigurationTemplate } from './decider-configuration-template.js';

const source: SourceSpan = {
  fileId: 'decider-binding.test.ts' as SourceFileId,
  start: 11,
  end: 24,
};

describe('binding symbolic Decider configuration templates', () => {
  test('resolves shared defaults and overrides into a fresh deeply immutable concrete config', () => {
    const session = createBlueprintParameterSession();
    const amount = session.number('amount', { defaultValue: 0, source });
    const target = session.signal('target', { defaultValue: signal('item', 'iron-plate'), source });
    const template = createDeciderConfigurationTemplate(session, {
      condition: {
        kind: 'and',
        conditions: [
          {
            kind: 'compare',
            left: {
              kind: 'signal',
              signal: target,
              refKind: 'pair',
              networks: ['network:red', 'network:green'],
            },
            comparator: '>=',
            right: { kind: 'constant', value: amount },
          },
        ],
      },
      outputs: [
        {
          mode: 'constant',
          signal: { kind: 'signal', signal: target },
          value: amount,
          input: { refKind: 'pair', networks: ['network:green', 'network:red'] },
        },
        { mode: 'copy', signal: { kind: 'wildcard', value: 'everything' } },
      ],
      elseOutputs: [{ mode: 'copy', signal: { kind: 'signal', signal: target } }],
    });
    const qualitySignal = signal('item', 'iron-plate', 'uncommon');
    const concrete = bindDeciderConfigurationTemplate(template, [
      { parameter: amount, value: 2_147_483_649 },
      { parameter: target, value: qualitySignal },
    ]);

    expect(concrete).toEqual({
      condition: {
        kind: 'and',
        conditions: [
          {
            kind: 'compare',
            left: {
              kind: 'signal',
              signal: qualitySignal,
              refKind: 'pair',
              networks: ['network:red', 'network:green'],
            },
            comparator: '>=',
            right: { kind: 'constant', value: -2_147_483_647 },
          },
        ],
      },
      outputs: [
        {
          mode: 'constant',
          signal: { kind: 'signal', signal: qualitySignal },
          value: -2_147_483_647,
          input: { refKind: 'pair', networks: ['network:green', 'network:red'] },
        },
        { mode: 'copy', signal: { kind: 'wildcard', value: 'everything' } },
      ],
      elseOutputs: [{ mode: 'copy', signal: { kind: 'signal', signal: qualitySignal } }],
    });
    expect(concrete).not.toBe(template);
    expect(Object.isFrozen(concrete)).toBe(true);
    expect(Object.isFrozen(concrete.condition)).toBe(true);
    expect(Object.isFrozen(concrete.outputs)).toBe(true);
    expect(Object.isFrozen(concrete.outputs[0])).toBe(true);
    expect(Object.isFrozen(concrete.outputs[0]?.input)).toBe(true);
    if (concrete.condition.kind === 'and') {
      expect(Object.isFrozen(concrete.condition.conditions)).toBe(true);
      expect(Object.isFrozen(concrete.condition.conditions[0])).toBe(true);
      const comparison = concrete.condition.conditions[0];
      if (
        comparison?.kind === 'compare' &&
        comparison.left.kind === 'signal' &&
        comparison.left.refKind === 'pair'
      ) {
        expect(Object.isFrozen(comparison.left.networks)).toBe(true);
        expect(comparison.left.signal).toBe(
          concrete.outputs[0]?.signal.kind === 'signal'
            ? concrete.outputs[0].signal.signal
            : undefined,
        );
      }
    }
  });

  test('applies defaults including numeric zero and validates safe integers before int32', () => {
    const session = createBlueprintParameterSession();
    const amount = session.number('amount', { defaultValue: 0 });
    const template = createDeciderConfigurationTemplate(session, {
      condition: {
        kind: 'compare',
        left: { kind: 'wildcard', value: 'each', refKind: 'single', network: 'network:input' },
        comparator: '=',
        right: { kind: 'constant', value: amount },
      },
      outputs: [{ mode: 'constant', signal: { kind: 'wildcard', value: 'each' }, value: amount }],
    });

    expect(bindDeciderConfigurationTemplate(template).outputs[0]).toEqual({
      mode: 'constant',
      signal: { kind: 'wildcard', value: 'each' },
      value: 0,
    });
    expect(() =>
      bindDeciderConfigurationTemplate(template, [{ parameter: amount, value: 1.5 }]),
    ).toThrowError(expect.objectContaining({ code: 'CP1000', path: '$.condition.right.value' }));
    expect(() =>
      bindDeciderConfigurationTemplate(template, [
        { parameter: amount, value: Number.MAX_SAFE_INTEGER + 1 },
      ]),
    ).toThrowError(expect.objectContaining({ code: 'CP1000', path: '$.condition.right.value' }));
  });

  test('reports exact nested paths and declaration spans for missing or invalid bindings', () => {
    const session = createBlueprintParameterSession();
    const amount = session.number('amount', { source });
    const target = session.signal('target', { source });
    const template = createDeciderConfigurationTemplate(session, {
      condition: {
        kind: 'and',
        conditions: [
          {
            kind: 'compare',
            left: { kind: 'wildcard', value: 'each', refKind: 'single', network: 'network:in' },
            comparator: '>',
            right: { kind: 'constant', value: amount },
          },
          {
            kind: 'compare',
            left: { kind: 'wildcard', value: 'anything', refKind: 'single', network: 'network:in' },
            comparator: '<',
            right: { kind: 'constant', value: 0 },
          },
        ],
      },
      outputs: [{ mode: 'copy', signal: { kind: 'signal', signal: target } }],
    });

    expect(() => bindDeciderConfigurationTemplate(template)).toThrowError(
      expect.objectContaining({
        code: 'CP1002',
        path: '$.condition.conditions[0].right.value',
        span: source,
      }),
    );
    expect(() =>
      bindDeciderConfigurationTemplate(template, [{ parameter: amount, value: Infinity }]),
    ).toThrowError(
      expect.objectContaining({
        code: 'CP1000',
        path: '$.condition.conditions[0].right.value',
        span: source,
      }),
    );
    expect(() =>
      bindDeciderConfigurationTemplate(template, [
        { parameter: amount, value: 3 },
        { parameter: target, value: { type: 'unknown', name: 'bad' } },
      ]),
    ).toThrowError(
      expect.objectContaining({
        code: 'CP1000',
        path: '$.outputs[0].signal.signal.type',
        span: source,
      }),
    );
  });

  test('rejects wrong-kind, duplicate, unused, forged and foreign bindings', () => {
    const session = createBlueprintParameterSession();
    const other = createBlueprintParameterSession();
    const amount = session.number('amount', { defaultValue: 1, source });
    const target = session.signal('target', { defaultValue: signal('item', 'iron-plate') });
    const unused = session.number('unused', { defaultValue: 4 });
    const foreign = other.number('foreign', { defaultValue: 3, source });
    const template = createDeciderConfigurationTemplate(session, {
      condition: {
        kind: 'compare',
        left: { kind: 'signal', signal: target, refKind: 'single', network: 'network:in' },
        comparator: '>',
        right: { kind: 'constant', value: amount },
      },
      outputs: [{ mode: 'copy', signal: { kind: 'signal', signal: target } }],
    });

    expect(() =>
      bindDeciderConfigurationTemplate(template, [
        { parameter: amount, value: signal('item', 'iron-plate') as unknown as number },
      ]),
    ).toThrowError(expect.objectContaining({ code: 'CP1000', path: '$.condition.right.value' }));
    expect(() =>
      bindDeciderConfigurationTemplate(template, [
        { parameter: amount, value: 1 },
        { parameter: amount, value: 2 },
      ]),
    ).toThrowError(expect.objectContaining({ code: 'CP1001', path: '$.bindings[1].parameter' }));
    expect(() =>
      bindDeciderConfigurationTemplate(template, [{ parameter: unused, value: 4 }]),
    ).toThrowError(expect.objectContaining({ code: 'CP1001', path: '$.bindings' }));
    expect(() =>
      bindDeciderConfigurationTemplate(template, [{ parameter: foreign, value: 3 }]),
    ).toThrowError(
      expect.objectContaining({ code: 'CP1001', path: '$.bindings[0].parameter', span: source }),
    );
    expect(() =>
      bindDeciderConfigurationTemplate(template, [
        { parameter: { kind: 'number', label: 'forged' } as never, value: 1 },
      ]),
    ).toThrowError(expect.objectContaining({ code: 'CP1001', path: '$.bindings[0].parameter' }));
  });

  test('does not mutate a previous concrete result after a failed rebind', () => {
    const session = createBlueprintParameterSession();
    const amount = session.number('amount', { defaultValue: 3 });
    const template = createDeciderConfigurationTemplate(session, {
      condition: {
        kind: 'compare',
        left: { kind: 'wildcard', value: 'each', refKind: 'single', network: 'network:in' },
        comparator: '>',
        right: { kind: 'constant', value: amount },
      },
      outputs: [{ mode: 'constant', signal: { kind: 'wildcard', value: 'each' }, value: amount }],
    });
    const first = bindDeciderConfigurationTemplate(template);

    expect(() =>
      bindDeciderConfigurationTemplate(template, [{ parameter: amount, value: Infinity }]),
    ).toThrowError(expect.objectContaining({ code: 'CP1000' }));
    expect(first.condition).toMatchObject({ right: { value: 3 } });
    expect(first.outputs[0]).toMatchObject({ value: 3 });
    expect(Object.isFrozen(first)).toBe(true);
  });
});

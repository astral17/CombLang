import { describe, expect, test } from 'vitest';
import { signal, type SignalId } from '@comblang/factorio';
import { sourceFileId } from '@comblang/shared';
import { createBlueprintParameterSession } from '../../compiler/src/blueprint-parameters.js';
import { createBlueprintNumericExpression } from '../../compiler/src/blueprint-numeric-expression.js';
import { bindConstantConfigurationTemplate } from '../../compiler/src/constant-configuration-binding.js';
import { inspectConstantConfigurationTemplate } from '../../compiler/src/constant-configuration-template.js';

import {
  normalizeConstantConfigurationSource,
  normalizeConstantConfigurationSourceWithParameters,
  prepareConstantConfigurationSource,
  ConstantConfigurationSourceError,
} from './constant-configuration-source.js';
import { createSourceNumericExpressionView } from './source-numeric-expressions.js';

const A = signal('virtual', 'signal-A');
const B = signal('virtual', 'signal-B', 'excellent');
const context = {
  isSignal: (value: unknown): value is SignalId => value === A || value === B,
  isSignalValue: (_value: unknown): _value is never => false,
};

function expressionView(session: ReturnType<typeof createBlueprintParameterSession>, value = 2) {
  const amount = session.number('Amount', { defaultValue: value });
  const expression = createBlueprintNumericExpression(session, {
    kind: 'binary',
    operator: 'add',
    left: { kind: 'parameter', parameter: amount },
    right: { kind: 'literal', value: 1 },
  });
  return {
    expression,
    view: createSourceNumericExpressionView(session, expression, {
      fileId: sourceFileId('constant-configuration-source-test.ts'),
      start: 0,
      end: 1,
    }),
  };
}

describe('exact Constant source configuration', () => {
  test.each(['$', '$.configuration'])(
    'locates unbound expressions at their slot under %s',
    (path) => {
      const session = createBlueprintParameterSession();
      const amount = session.number('Missing');
      const expression = createBlueprintNumericExpression(session, {
        kind: 'binary',
        operator: 'add',
        left: { kind: 'parameter', parameter: amount },
        right: { kind: 'literal', value: 1 },
      });
      const view = createSourceNumericExpressionView(session, expression, {
        fileId: sourceFileId('constant-configuration-source-test.ts'),
        start: 2,
        end: 3,
      });
      for (const field of ['count', 'multiplier']) {
        const value =
          field === 'count'
            ? { sections: [{ filters: [{ signal: A, value: view }] }] }
            : { sections: [{ multiplier: view }] };
        const suffix = field === 'count' ? '.filters[0].value' : '.multiplier';
        expect(() =>
          normalizeConstantConfigurationSourceWithParameters(value, context, session, path),
        ).toThrowError(
          expect.objectContaining({
            name: 'ConstantConfigurationSourceError',
            path: `${path}.sections[0]${suffix}`,
            message: expect.stringContaining('has no binding or default'),
          }),
        );
      }
    },
  );

  test('prepares missing-default slots symbolically and binds supplied values later', () => {
    const session = createBlueprintParameterSession();
    const count = session.number('Amount');
    const multiplier = session.number('Scale');
    const channel = session.signal('Channel');
    const expression = createBlueprintNumericExpression(session, {
      kind: 'binary',
      operator: 'add',
      left: { kind: 'parameter', parameter: multiplier },
      right: { kind: 'literal', value: 1 },
    });
    const expressionSource = createSourceNumericExpressionView(session, expression, {
      fileId: sourceFileId('constant-configuration-source-test.ts'),
      start: 2,
      end: 3,
    });
    const filterRow: { signal: unknown; value: unknown } = { signal: channel, value: count };
    const source = {
      sections: [{ multiplier: expressionSource, filters: [filterRow] }],
    };

    const prepared = prepareConstantConfigurationSource(source, context, session);
    expect(prepared.hasParameterSlots).toBe(true);
    expect(Object.isFrozen(prepared.template)).toBe(true);
    expect(inspectConstantConfigurationTemplate(prepared.template, '$.template')).toMatchObject({
      session,
      usedParameters: [multiplier, channel, count],
    });
    expect(prepared.template.sections[0]).toMatchObject({
      multiplier: expression,
      filters: [{ signal: channel, value: count }],
    });

    filterRow.value = 99;
    expect(prepared.template.sections[0]!.filters[0]!.value).toBe(count);
    expect(
      bindConstantConfigurationTemplate(prepared.template, [
        { parameter: multiplier, value: 2 },
        { parameter: count, value: 7 },
        { parameter: channel, value: B },
      ]),
    ).toEqual({
      isOn: true,
      sections: [
        {
          active: true,
          multiplier: 3,
          filters: [{ signal: B, value: 7 }],
        },
      ],
    });
  });

  test('evaluates registered count and multiplier defaults while retaining their host roots', () => {
    const session = createBlueprintParameterSession();
    const count = expressionView(session, 5);
    const multiplier = expressionView(session, 2);
    const normalized = normalizeConstantConfigurationSourceWithParameters(
      {
        sections: [
          {
            multiplier: multiplier.view,
            filters: [{ signal: A, value: count.view }],
          },
        ],
      },
      context,
      session,
    );

    expect(normalized.configuration.sections[0]).toMatchObject({
      multiplier: 3,
      filters: [{ signal: A, value: 6 }],
    });
    expect(normalized.template?.sections).toEqual([
      {
        active: true,
        multiplier: multiplier.expression,
        filters: [{ signal: A, value: count.expression }],
      },
    ]);
  });

  test.each(['count', 'multiplier'] as const)(
    'rejects a %s expression without its owning consuming session at the field path',
    (field) => {
      const owner = createBlueprintParameterSession();
      const { view } = expressionView(owner);
      const value =
        field === 'count'
          ? { sections: [{ filters: [{ signal: A, value: view }] }] }
          : { sections: [{ multiplier: view }] };
      const path =
        field === 'count' ? '$.sections[0].filters[0].value' : '$.sections[0].multiplier';

      for (const session of [undefined, createBlueprintParameterSession()]) {
        expect(() =>
          normalizeConstantConfigurationSourceWithParameters(value, context, session),
        ).toThrowError(
          expect.objectContaining({
            name: 'ConstantConfigurationSourceError',
            path,
          }),
        );
      }
    },
  );

  test.each([1, 0.5, -0, 2147483648, 1e100])(
    'retains parameter multiplier default %s as finite double, including multiplier-only capture',
    (value) => {
      const session = createBlueprintParameterSession();
      const scale = session.number('Scale', { defaultValue: value });
      const normalized = normalizeConstantConfigurationSourceWithParameters(
        {
          sections: [
            { multiplier: scale, filters: [] },
            { multiplier: scale, filters: [[A, 2]] },
            {},
          ],
        },
        context,
        session,
      );
      expect(normalized.configuration.sections.map(({ multiplier }) => multiplier)).toEqual([
        value,
        value,
        1,
      ]);
      expect(normalized.template?.sections).toMatchObject([
        { multiplier: scale, filters: [] },
        { multiplier: scale, filters: [{ signal: A, value: 2 }] },
        { multiplier: 1, filters: [] },
      ]);
    },
  );

  test.each(['signal', 'foreign', 'copied', 'forged', 'missing-default'] as const)(
    'authenticates multiplier slot and rejects %s without coercion',
    (kind) => {
      const session = createBlueprintParameterSession();
      const scale = session.number('Scale', { defaultValue: 1 });
      const candidates = {
        signal: session.signal('Wrong', { defaultValue: A }),
        foreign: createBlueprintParameterSession().number('Foreign', { defaultValue: 1 }),
        copied: { ...scale },
        forged: { kind: 'number', label: 'Scale', defaultValue: 1 },
        'missing-default': session.number('Missing'),
      };
      expect(() =>
        normalizeConstantConfigurationSourceWithParameters(
          { sections: [{ multiplier: candidates[kind] }] },
          context,
          session,
        ),
      ).toThrowError(
        expect.objectContaining({
          name: 'ConstantConfigurationSourceError',
          path: '$.sections[0].multiplier',
        }),
      );
      expect(
        normalizeConstantConfigurationSourceWithParameters(
          { sections: [{ multiplier: scale }] },
          context,
          session,
        ).configuration.sections[0]!.multiplier,
      ).toBe(1);
    },
  );

  test('rejects object multiplier without invoking primitive conversion', () => {
    let calls = 0;
    const multiplier = {
      valueOf() {
        calls += 1;
        return 1;
      },
      [Symbol.toPrimitive]() {
        calls += 1;
        return 1;
      },
    };
    expect(() =>
      normalizeConstantConfigurationSourceWithParameters(
        { sections: [{ multiplier }] },
        context,
        createBlueprintParameterSession(),
      ),
    ).toThrowError(expect.objectContaining({ path: '$.sections[0].multiplier' }));
    expect(calls).toBe(0);
  });

  test('rejects multiplier accessor without executing getter or mutating the caller', () => {
    let calls = 0;
    const section = Object.defineProperty({}, 'multiplier', {
      enumerable: true,
      get: () => {
        calls += 1;
        return 1;
      },
    });
    expect(() =>
      normalizeConstantConfigurationSourceWithParameters(
        { sections: [section] },
        context,
        createBlueprintParameterSession(),
      ),
    ).toThrowError(expect.objectContaining({ path: '$.sections[0].multiplier' }));
    expect(calls).toBe(0);
    expect(Object.getOwnPropertyDescriptor(section, 'multiplier')?.get).toBeDefined();
  });

  test('normalizes ordered nested sources without merging duplicate or zero rows', () => {
    const configuration = normalizeConstantConfigurationSource(
      {
        isOn: false,
        sections: [
          {
            active: false,
            filters: [
              [A, 0],
              [B, 3],
            ],
          },
          { filters: new Map([['virtual/signal-A', -2]]) },
        ],
      },
      context,
    );

    expect(configuration).toEqual({
      isOn: false,
      sections: [
        {
          active: false,
          multiplier: 1,
          filters: [
            { signal: A, value: 0 },
            { signal: B, value: 3 },
          ],
        },
        {
          active: true,
          multiplier: 1,
          filters: [{ signal: A, value: -2 }],
        },
      ],
    });
    expect(configuration.sections[0]!.filters[0]!.signal).not.toBe(A);
    expect(configuration.sections[1]!.filters[0]!.signal).toEqual(A);
  });

  test('applies empty and omitted defaults', () => {
    expect(normalizeConstantConfigurationSource({}, context)).toEqual({
      isOn: true,
      sections: [],
    });
    expect(normalizeConstantConfigurationSource({ sections: [{}] }, context)).toEqual({
      isOn: true,
      sections: [{ active: true, multiplier: 1, filters: [] }],
    });
  });

  test('keeps signal and value as ordinary signal keys in map-style filter rows', () => {
    const configuration = normalizeConstantConfigurationSource(
      { sections: [{ filters: [{ signal: 2, value: 3 }, { value: 5 }] }] },
      context,
    );
    expect(configuration.sections[0]?.filters).toEqual([
      { signal: signal('item', 'signal'), value: 2 },
      { signal: signal('item', 'value'), value: 3 },
      { signal: signal('item', 'value'), value: 5 },
    ]);
  });

  test.each([
    ['accessor', Object.defineProperty({}, 'isOn', { get: () => true })],
    [
      'cycle',
      (() => {
        const value: { sections?: unknown } = {};
        value.sections = [value];
        return value;
      })(),
    ],
  ])('reports %s without mutating the caller', (_name, value) => {
    const before = structuredClone(value);
    expect(() => normalizeConstantConfigurationSource(value, context)).toThrow(
      ConstantConfigurationSourceError,
    );
    expect(value).toEqual(before);
  });

  test('retains valid structural fields outside the evaluator subset', () => {
    expect(
      normalizeConstantConfigurationSource(
        { sections: [{ group: 'backup', multiplier: 1.5, filters: [[A, 2]] }] },
        context,
      ),
    ).toEqual({
      isOn: true,
      sections: [
        {
          active: true,
          group: 'backup',
          multiplier: 1.5,
          filters: [{ signal: A, value: 2 }],
        },
      ],
    });
  });
});

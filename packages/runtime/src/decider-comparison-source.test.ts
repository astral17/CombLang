import { Signal } from '@comblang/factorio';
import { describe, expect, test } from 'vitest';

import { bindDeciderConfigurationTemplate } from '../../compiler/src/decider-configuration-binding.js';
import { createBlueprintNumericExpression } from '../../compiler/src/blueprint-numeric-expression.js';
import {
  createBlueprintParameterSession,
  createBlueprintParameterSourceView,
} from '../../compiler/src/blueprint-parameters.js';
import { inspectDeciderConfigurationTemplate } from '../../compiler/src/decider-configuration-template.js';
import type { DeciderConstantComparisonHead } from './elaboration-operators.js';
import { createSourceNumericExpressionView } from './source-numeric-expressions.js';
import {
  bindPreparedDeciderComparisonSource,
  DeciderComparisonSourceError,
  prepareDeciderComparisonSource,
} from './decider-comparison-source.js';

function context() {
  return { snapshotSignal: <T>(value: T) => value };
}

function signalHead(
  kind: 'compare-signal' | 'compare-each' | 'compare-wildcard',
  refKind: 'single' | 'pair',
  wildcard: 'anything' | 'everything' = 'anything',
): DeciderConstantComparisonHead {
  const reference =
    refKind === 'single'
      ? { refKind, network: 'network:input' }
      : { refKind, networks: ['network:left', 'network:right'] as const };
  if (kind === 'compare-signal') {
    return {
      kind,
      ...reference,
      signal: Signal('virtual', 'signal-A'),
      comparator: '>',
    } as DeciderConstantComparisonHead;
  }
  if (kind === 'compare-wildcard') {
    return { kind, ...reference, wildcard, comparator: '>' };
  }
  return { kind, ...reference, comparator: '>' };
}

describe('symbolic Decider comparison source preparation', () => {
  test.each([
    ['selected Signal/single', 'compare-signal', 'single'],
    ['Each/pair', 'compare-each', 'pair'],
    ['Anything/single', 'compare-wildcard', 'single'],
    ['Everything/pair', 'compare-wildcard', 'pair', 'everything'],
  ] as const)(
    'prepares a missing-default numeric root for %s',
    (_name, kind, refKind, wildcard?: 'everything') => {
      const session = createBlueprintParameterSession();
      const parameter = session.number('Threshold');
      const wildcardName = wildcard ?? 'anything';
      const signalSnapshots: string[] = [];
      const prepared = prepareDeciderComparisonSource(
        signalHead(kind, refKind, wildcardName),
        createBlueprintParameterSourceView(session, parameter),
        session,
        {
          snapshotSignal: (value) => {
            signalSnapshots.push(value.name);
            return value;
          },
        },
      );

      expect(prepared.root).toBe(parameter);
      expect(inspectDeciderConfigurationTemplate(prepared.template, '$.template')).toMatchObject({
        session,
        usedParameters: [parameter],
      });
      expect(signalSnapshots).toEqual(kind === 'compare-signal' ? ['signal-A'] : []);
      expect(prepared.template.condition).toMatchObject({
        kind: 'compare',
        left:
          kind === 'compare-signal'
            ? { kind: 'signal', signal: Signal('virtual', 'signal-A') }
            : kind === 'compare-each'
              ? { kind: 'wildcard', value: 'each' }
              : { kind: 'wildcard', value: wildcardName },
        right: { kind: 'constant', value: parameter },
      });
      expect(prepared.template.outputs).toEqual([]);
      expect(() => bindPreparedDeciderComparisonSource(prepared)).toThrowError(
        expect.objectContaining({ path: '$.condition.right' }),
      );
    },
  );

  test('retains an opaque derived expression and defers its evaluation to binding', () => {
    const session = createBlueprintParameterSession();
    const amount = session.number('Amount');
    const expression = createBlueprintNumericExpression(session, {
      kind: 'binary',
      operator: 'add',
      left: { kind: 'parameter', parameter: amount },
      right: { kind: 'literal', value: 2 },
    });
    const view = createSourceNumericExpressionView(session, expression, {
      fileId: 'decider-comparison-source.test.ts' as never,
      start: 1,
      end: 2,
    });
    const prepared = prepareDeciderComparisonSource(
      signalHead('compare-each', 'single'),
      view,
      session,
      context(),
    );

    expect(prepared.root).toBe(expression);
    expect(inspectDeciderConfigurationTemplate(prepared.template, '$.template')).toMatchObject({
      session,
      usedParameters: [amount],
    });
    expect(prepared.template.condition).toMatchObject({
      right: { kind: 'constant', value: expression },
    });
    expect(() => bindPreparedDeciderComparisonSource(prepared)).toThrowError(
      expect.objectContaining({ path: '$.condition.right' }),
    );
    expect(bindPreparedDeciderComparisonSource(prepared, [{ parameter: amount, value: 5 }])).toBe(
      7,
    );
  });

  test('uses supplied bindings and maps a missing binding to the owning right slot', () => {
    const session = createBlueprintParameterSession();
    const parameter = session.number('Threshold');
    const prepared = prepareDeciderComparisonSource(
      signalHead('compare-signal', 'single'),
      parameter,
      session,
      context(),
    );

    expect(() => bindPreparedDeciderComparisonSource(prepared)).toThrowError(
      expect.objectContaining({
        name: 'DeciderComparisonSourceError',
        path: '$.condition.right',
      }),
    );
    expect(bindPreparedDeciderComparisonSource(prepared, [{ parameter, value: 13 }])).toBe(13);
  });

  test('rejects Signal slots, foreign sessions, forged handles, and absent ownership', () => {
    const session = createBlueprintParameterSession();
    const other = createBlueprintParameterSession();
    const parameter = session.number('Threshold');

    for (const [value, owner] of [
      [session.signal('Signal'), session],
      [other.number('Foreign'), session],
      [{ kind: 'number', label: 'Forged' }, session],
      [{ ...parameter }, session],
      [createBlueprintParameterSourceView(session, parameter), undefined],
    ] as const) {
      expect(() =>
        prepareDeciderComparisonSource(
          signalHead('compare-each', 'single'),
          value,
          owner,
          context(),
        ),
      ).toThrowError(
        expect.objectContaining({
          name: 'DeciderComparisonSourceError',
          path: '$.condition.right',
        }),
      );
    }

    const foreignExpression = createBlueprintNumericExpression(other, {
      kind: 'literal',
      value: 4,
    });
    const foreignExpressionView = createSourceNumericExpressionView(other, foreignExpression, {
      fileId: 'foreign-decider-comparison-source.test.ts' as never,
      start: 1,
      end: 2,
    });
    expect(() =>
      prepareDeciderComparisonSource(
        signalHead('compare-each', 'single'),
        foreignExpressionView,
        session,
        context(),
      ),
    ).toThrowError(expect.objectContaining({ path: '$.condition.right' }));
  });
});

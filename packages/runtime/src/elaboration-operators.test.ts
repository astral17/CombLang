import type { SignalId } from '@comblang/factorio';
import { sourceFileId, sourceSpan } from '@comblang/shared';
import { describe, expect, test } from 'vitest';

import {
  elaborationOperatorPolicy as operators,
  type ElaborationOperatorDispatchContext,
} from './elaboration-operators.js';
import { RuntimeValueRegistry, type DslValue, type NetworkValue } from './elaboration-values.js';

function dispatchFixture() {
  const registry = new RuntimeValueRegistry();
  const source = sourceSpan(sourceFileId('operator-policy.factorio.ts'), 0, 1);
  const network = registry.brand({
    kind: 'network',
    name: 'input',
    declaration: source,
    ownership: {
      generation: 0,
      owner: 'top-level',
      readonlyBorrows: new Set(),
    },
    capability: 'owned',
    generation: 0,
  });
  let calls = 0;
  const isSignal = (value: unknown): value is SignalId =>
    typeof value === 'object' &&
    value !== null &&
    'type' in value &&
    'name' in value &&
    !('kind' in value);
  const context: ElaborationOperatorDispatchContext<number> = {
    isCircuitDslValue: (value): value is DslValue =>
      isSignal(value) ||
      registry.hasKind(value, 'network') ||
      registry.hasKind(value, 'pair') ||
      registry.hasKind(value, 'selected') ||
      registry.hasKind(value, 'destinations') ||
      registry.hasKind(value, 'signal-value') ||
      registry.hasKind(value, 'wildcard-token') ||
      registry.hasKind(value, 'wildcard-count') ||
      registry.hasKind(value, 'condition') ||
      registry.hasKind(value, 'producer'),
    isSignal,
    isSelected: (value) => registry.hasKind(value, 'selected'),
    isNetwork: (value): value is NetworkValue => registry.hasKind(value, 'network'),
    isPair: (value) => registry.hasKind(value, 'pair'),
    isWildcardToken: (value) => registry.hasKind(value, 'wildcard-token'),
    recordDslCall: () => {
      calls += 1;
    },
    assertReadable: () => undefined,
    planNetworkRef: (value) => {
      if (value.kind === 'pair') {
        return {
          refKind: 'pair',
          networks: value.networks.map(({ name }) => name) as [string, string],
        };
      }
      if (value.kind === 'selected') {
        return value.networks === undefined
          ? { refKind: 'single', network: value.network.name }
          : {
              refKind: 'pair',
              networks: value.networks.map(({ name }) => name) as [string, string],
            };
      }
      return { refKind: 'single', network: value.name };
    },
    arithmeticOperand: (value) =>
      typeof value === 'number'
        ? { kind: 'constant', value }
        : registry.hasKind(value, 'network')
          ? { kind: 'each', refKind: 'single', network: value.name }
          : (() => {
              throw new Error('Unexpected fixture operand.');
            })(),
    producerMetadata: () => ({ source, instancePath: [] }),
    brand: (value) => registry.brand(value),
  };
  return { context, network, calls: () => calls };
}

describe('elaboration operator policy', () => {
  test('normalizes source operators into circuit operations', () => {
    expect(operators.arithmetic('+')).toBe('add');
    expect(operators.arithmetic('<<')).toBe('left-shift');
    expect(operators.comparator('===')).toBe('=');
    expect(operators.comparator('!==')).toBe('!=');
    expect(operators.arithmetic('instanceof')).toBeUndefined();
  });

  test('reverses and recursively negates circuit conditions', () => {
    expect(operators.reverseComparator('>')).toBe('<');
    expect(
      operators.invertCondition({
        kind: 'and',
        conditions: [
          {
            kind: 'compare-each',
            refKind: 'single',
            network: 'input',
            comparator: '>',
            constant: 0,
          },
          {
            kind: 'compare-signal',
            refKind: 'single',
            network: 'input',
            signal: { type: 'virtual', name: 'signal-A' },
            comparator: '=',
            constant: 1,
          },
        ],
      }),
    ).toMatchObject({
      kind: 'or',
      conditions: [{ comparator: '<=' }, { comparator: '!=' }],
    });
  });

  test('preserves native JavaScript equality and arithmetic behavior', () => {
    expect(operators.evaluateJavaScriptComparison('==', 1, '1')).toBe(true);
    expect(operators.evaluateJavaScriptComparison('===', 1, '1')).toBe(false);
    expect(operators.evaluateJavaScriptBinary('+', 'a', 2)).toBe('a2');
    expect(operators.evaluateJavaScriptBinary('<<', 3, 2)).toBe(12);
    expect(() => operators.evaluateJavaScriptBinary('in', 0, [])).toThrow(
      /Unsupported compile-time operator/,
    );
  });

  test('dispatches nominal DSL values while leaving ordinary values native', () => {
    const fixture = dispatchFixture();
    expect(operators.dispatchBinary('+', 2, 3, 0, fixture.context)).toBe(5);
    expect(fixture.calls()).toBe(0);

    expect(operators.dispatchBinary('*', fixture.network, 2, 0, fixture.context)).toMatchObject({
      kind: 'producer',
      producer: {
        kind: 'arithmetic',
        left: { kind: 'each', refKind: 'single', network: 'input' },
        operation: 'multiply',
      },
    });
    expect(fixture.calls()).toBe(1);
    expect(operators.dispatchComparison('<', 0, fixture.network, 0, fixture.context)).toMatchObject(
      {
        kind: 'condition',
        condition: { kind: 'compare-each', comparator: '>', constant: 0 },
      },
    );
    expect(fixture.calls()).toBe(2);
  });
});

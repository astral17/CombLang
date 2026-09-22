import { Signal, type SignalId } from '@comblang/factorio';
import { sourceFileId, sourceSpan } from '@comblang/shared';
import { describe, expect, test } from 'vitest';

import {
  elaborationOperatorPolicy as operators,
  type ElaborationOperatorDispatchContext,
} from './elaboration-operators.js';
import {
  RuntimeValueRegistry,
  type CombinatorDescriptor,
  type DslValue,
  type NetworkValue,
  type SectionValue,
} from './elaboration-values.js';

function dispatchFixture() {
  const registry = new RuntimeValueRegistry();
  const source = sourceSpan(sourceFileId('operator-policy.factorio.ts'), 0, 1);
  const network = registry.brandNetwork(
    {
      kind: 'network',
      name: 'input',
      declaration: source,
      capability: 'owned',
      generation: 0,
    },
    {
      ownership: {
        generation: 0,
        owner: 'top-level',
        readonlyBorrows: new Set(),
      },
    },
  );
  const signal = registry.brandSignal(Signal('virtual', 'signal-A'));
  let calls = 0;
  let lastDescriptor: CombinatorDescriptor | undefined;
  const isSignal = (value: unknown): value is SignalId => registry.hasSignal(value);
  const context: ElaborationOperatorDispatchContext<number> = {
    isCircuitDslValue: (value): value is DslValue =>
      isSignal(value) ||
      registry.hasKind(value, 'network') ||
      registry.hasKind(value, 'pair') ||
      registry.hasKind(value, 'selected') ||
      registry.hasKind(value, 'destinations') ||
      registry.hasKind(value, 'signal-value') ||
      registry.hasKind(value, 'section') ||
      registry.hasKind(value, 'wildcard-token') ||
      registry.hasKind(value, 'wildcard-count') ||
      registry.hasKind(value, 'condition') ||
      registry.hasKind(value, 'combinator'),
    isSignal,
    isSignalId: (value): value is SignalId =>
      typeof value === 'object' && value !== null && 'type' in value && 'name' in value,
    isSelected: (value) => registry.hasKind(value, 'selected'),
    selectedSelection: (value) => registry.selectedState(value)!.selection,
    isNetwork: (value): value is NetworkValue => registry.hasKind(value, 'network'),
    networkFacet: (value) => (registry.hasKind(value, 'network') ? value : undefined),
    readableNetworkFacet: (value) => (registry.hasKind(value, 'network') ? value : undefined),
    isPair: (value) => registry.hasKind(value, 'pair'),
    isSection: (value) => registry.hasKind(value, 'section'),
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
        const state = registry.selectedState(value)!;
        return state.kind === 'concrete' || state.networks === undefined
          ? { refKind: 'single', network: state.network.name }
          : {
              refKind: 'pair',
              networks: state.networks.map(({ name }) => name) as [string, string],
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
    createCombinator: (descriptor) => {
      lastDescriptor = descriptor;
      return registry.brand({ kind: 'combinator', identity: {} });
    },
    brand: (value) => registry.brand(value),
  };
  return { context, network, signal, calls: () => calls, descriptor: () => lastDescriptor };
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

    const lookalike = { type: 'virtual', name: 'signal-A' };
    expect(
      Number.isNaN(operators.dispatchBinary('*', 2, lookalike, 0, fixture.context) as number),
    ).toBe(true);
    expect(fixture.calls()).toBe(0);

    expect(operators.dispatchBinary('*', 2, fixture.signal, 0, fixture.context)).toMatchObject({
      kind: 'signal-value',
      signal: { type: 'virtual', name: 'signal-A' },
      value: 2,
    });
    expect(fixture.calls()).toBe(1);

    expect(operators.dispatchBinary('*', fixture.network, 2, 0, fixture.context)).toMatchObject({
      kind: 'combinator',
    });
    expect(fixture.descriptor()).toMatchObject({
      kind: 'arithmetic',
      left: { kind: 'each', refKind: 'single', network: 'input' },
      operation: 'multiply',
    });
    expect(fixture.calls()).toBe(2);
    expect(operators.dispatchComparison('<', 0, fixture.network, 0, fixture.context)).toMatchObject(
      {
        kind: 'condition',
        condition: { kind: 'compare-each', comparator: '>', constant: 0 },
      },
    );
    expect(fixture.calls()).toBe(3);
  });

  test('canonicalizes concrete circuit constants at DSL dispatch boundaries', () => {
    const fixture = dispatchFixture();

    expect(
      operators.dispatchBinary('*', 4_294_967_295, fixture.signal, 0, fixture.context),
    ).toMatchObject({ kind: 'signal-value', value: -1 });
    expect(
      operators.dispatchComparison('>', fixture.network, 2_147_483_648, 0, fixture.context),
    ).toMatchObject({ condition: { constant: -2_147_483_648 } });

    for (const value of [1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() =>
        operators.dispatchBinary('*', value, fixture.signal, 0, fixture.context),
      ).toThrow(/safe integers/);
    }
  });

  test('scales a Section only through a finite left-handed multiplier', () => {
    const fixture = dispatchFixture();
    const section = fixture.context.brand({
      kind: 'section',
      section: { active: true, multiplier: 1, filters: [] },
      scaled: false,
      source: { fileId: 'operator-policy.factorio.ts' as never, start: 0, end: 1 },
    }) as SectionValue;

    const scaled = operators.dispatchBinary('*', 0.5, section, 0, fixture.context);
    expect(scaled).toMatchObject({ kind: 'section', section: { multiplier: 0.5 } });
    expect(fixture.descriptor()).toBeUndefined();
    expect(() => operators.dispatchBinary('*', section, 2, 0, fixture.context)).toThrow(
      /finite number \* Section/,
    );
    expect(() =>
      operators.dispatchBinary('*', Number.POSITIVE_INFINITY, section, 0, fixture.context),
    ).toThrow(/finite numbers/);
    expect(() => operators.dispatchComparison('===', section, section, 0, fixture.context)).toThrow(
      /cannot be compared/,
    );

    expect(() => operators.dispatchBinary('*', 2, scaled, 0, fixture.context)).toThrow(
      /more than once/,
    );
    const scaledByOne = operators.dispatchBinary('*', 1, section, 0, fixture.context);
    expect(() => operators.dispatchBinary('*', 2, scaledByOne, 0, fixture.context)).toThrow(
      /more than once/,
    );
  });
});

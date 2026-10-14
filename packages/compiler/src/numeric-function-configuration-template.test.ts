import { signal } from '@comblang/factorio';
import type { NetworkId } from '@comblang/shared';
import { describe, expect, test } from 'vitest';

import { createArithmeticConfigurationTemplate } from './arithmetic-configuration-template.js';
import { bindArithmeticConfigurationTemplate } from './arithmetic-configuration-binding.js';
import { createBlueprintNumericExpression } from './blueprint-numeric-expression.js';
import { createBlueprintParameterSession } from './blueprint-parameters.js';
import { bindConstantConfigurationTemplate } from './constant-configuration-binding.js';
import { createConstantConfigurationTemplate } from './constant-configuration-template.js';
import { bindDeciderConfigurationTemplate } from './decider-configuration-binding.js';
import { createDeciderConfigurationTemplate } from './decider-configuration-template.js';
import { bindSelectorConfigurationTemplate } from './selector-configuration-binding.js';
import { createSelectorConfigurationTemplate } from './selector-configuration-template.js';

const inputNetwork = 'network:input' as NetworkId;

describe('registered numeric function template integration', () => {
  test('binds call roots in existing numeric slots, resets defaults, and keeps templates immutable', () => {
    const session = createBlueprintParameterSession();
    const amount = session.number('amount', { defaultValue: 4 });
    const index = session.number('index', { defaultValue: -3 });
    const scale = session.number('scale', { defaultValue: 0.5 });
    const parameter = (value: typeof amount) => ({ kind: 'parameter' as const, parameter: value });
    const literal = (value: number) => ({ kind: 'literal' as const, value });
    const call = (functionName: 'abs' | 'log2' | 'sign' | 'min' | 'max', ...args: unknown[]) =>
      createBlueprintNumericExpression(session, {
        kind: 'call',
        function: functionName,
        arguments: args,
      });

    const arithmeticLeft = call('min', parameter(amount), literal(5));
    const arithmeticRight = call('abs', literal(-2));
    const arithmetic = createArithmeticConfigurationTemplate(session, {
      left: { kind: 'constant', value: arithmeticLeft },
      operation: 'add',
      right: { kind: 'constant', value: arithmeticRight },
      output: { kind: 'each' },
    });

    const multiplier = call('abs', parameter(scale));
    const count = call('max', parameter(amount), literal(1));
    const constant = createConstantConfigurationTemplate(session, {
      sections: [
        {
          multiplier,
          filters: [{ signal: signal('virtual', 'signal-A'), value: count }],
        },
      ],
    });

    const decider = createDeciderConfigurationTemplate(session, {
      condition: {
        kind: 'compare',
        left: {
          kind: 'wildcard',
          value: 'each',
          refKind: 'single',
          network: inputNetwork,
        },
        comparator: '>',
        right: { kind: 'constant', value: call('log2', parameter(amount)) },
      },
      outputs: [
        {
          mode: 'constant',
          signal: { kind: 'wildcard', value: 'each' },
          value: call('sign', parameter(index)),
        },
      ],
      elseOutputs: [
        {
          mode: 'constant',
          signal: { kind: 'wildcard', value: 'anything' },
          value: call('min', parameter(amount), literal(2)),
        },
      ],
    });

    const selector = createSelectorConfigurationTemplate(session, {
      operation: 'select',
      input: { refKind: 'single', network: inputNetwork },
      selectMax: false,
      index: call('abs', parameter(index)),
    });
    const templatesBefore = [arithmetic, constant, decider, selector].map((template) =>
      JSON.stringify(template),
    );

    const arithmeticDefault = bindArithmeticConfigurationTemplate(arithmetic);
    const arithmeticOverride = bindArithmeticConfigurationTemplate(arithmetic, [
      { parameter: amount, value: 7 },
    ]);
    expect(arithmeticDefault).toEqual({
      left: { kind: 'constant', value: 4 },
      operation: 'add',
      right: { kind: 'constant', value: 2 },
      output: { kind: 'each' },
    });
    expect(arithmeticOverride.left).toEqual({ kind: 'constant', value: 5 });
    expect(arithmeticOverride.right).toEqual({ kind: 'constant', value: 2 });

    const constantDefault = bindConstantConfigurationTemplate(constant);
    const constantOverride = bindConstantConfigurationTemplate(constant, [
      { parameter: amount, value: 7 },
      { parameter: scale, value: -2.5 },
    ]);
    expect(constantDefault.sections[0]?.multiplier).toBe(0.5);
    expect(constantDefault.sections[0]?.filters[0]?.value).toBe(4);
    expect(constantOverride.sections[0]?.multiplier).toBe(2.5);
    expect(constantOverride.sections[0]?.filters[0]?.value).toBe(7);
    expect(() =>
      bindConstantConfigurationTemplate(constant, [
        { parameter: amount, value: 3.5 },
        { parameter: scale, value: 2 },
      ]),
    ).toThrowError(expect.objectContaining({ code: 'CP1000' }));
    expect(bindConstantConfigurationTemplate(constant).sections[0]?.multiplier).toBe(0.5);

    const deciderDefault = bindDeciderConfigurationTemplate(decider);
    const deciderOverride = bindDeciderConfigurationTemplate(decider, [
      { parameter: amount, value: 8 },
      { parameter: index, value: 0 },
    ]);
    expect(deciderDefault.condition).toMatchObject({ right: { value: 2 } });
    expect(deciderDefault.outputs[0]).toMatchObject({ value: -1 });
    expect(deciderDefault.elseOutputs?.[0]).toMatchObject({ value: 2 });
    expect(deciderOverride.condition).toMatchObject({ right: { value: 3 } });
    expect(deciderOverride.outputs[0]).toMatchObject({ value: 0 });
    expect(deciderOverride.elseOutputs?.[0]).toMatchObject({ value: 2 });

    const selectorDefault = bindSelectorConfigurationTemplate(selector);
    const selectorOverride = bindSelectorConfigurationTemplate(selector, [
      { parameter: index, value: -6 },
    ]);
    expect(selectorDefault).toMatchObject({ operation: 'select', index: 3 });
    expect(selectorOverride).toMatchObject({ operation: 'select', index: 6 });
    expect(bindSelectorConfigurationTemplate(selector, [])).toEqual(selectorDefault);
    expect(bindArithmeticConfigurationTemplate(arithmetic, [])).toEqual(arithmeticDefault);
    expect(bindDeciderConfigurationTemplate(decider, [])).toEqual(deciderDefault);

    for (const [template, before] of [arithmetic, constant, decider, selector].map(
      (value, indexValue) => [value, templatesBefore[indexValue]] as const,
    )) {
      expect(JSON.stringify(template)).toBe(before);
      expect(Object.isFrozen(template)).toBe(true);
      expect(JSON.stringify(template)).toContain('"kind":"call"');
    }
    expect(
      JSON.stringify([arithmeticDefault, constantDefault, deciderDefault, selectorDefault]),
    ).not.toContain('"kind":"call"');
  });
});

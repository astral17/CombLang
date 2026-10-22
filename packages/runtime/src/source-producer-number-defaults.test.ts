import { constantConfigurationLimits, signal } from '@comblang/factorio';
import type { NetworkId } from '@comblang/shared';
import { sourceFileId } from '@comblang/shared';
import { describe, expect, test } from 'vitest';

import { bindArithmeticConfigurationTemplate } from '../../compiler/src/arithmetic-configuration-binding.js';
import {
  createArithmeticConfigurationTemplate,
  type ArithmeticConfigurationTemplate,
} from '../../compiler/src/arithmetic-configuration-template.js';
import {
  createBlueprintNumericExpression,
  type BlueprintNumericExpression,
} from '../../compiler/src/blueprint-numeric-expression.js';
import { bindConstantConfigurationTemplate } from '../../compiler/src/constant-configuration-binding.js';
import {
  createConstantConfigurationTemplate,
  type ConstantConfigurationTemplate,
} from '../../compiler/src/constant-configuration-template.js';
import { bindDeciderConfigurationTemplate } from '../../compiler/src/decider-configuration-binding.js';
import {
  createDeciderConfigurationTemplate,
  type DeciderConfigurationTemplate,
} from '../../compiler/src/decider-configuration-template.js';
import {
  assertBlueprintParameterFromSession,
  BlueprintParameterError,
  createBlueprintParameterSession,
  type BlueprintNumberParameterHandle,
  type BlueprintParameterHandle,
  type BlueprintParameterSession,
} from '../../compiler/src/blueprint-parameters.js';
import { bindSelectorConfigurationTemplate } from '../../compiler/src/selector-configuration-binding.js';
import {
  createSelectorConfigurationTemplate,
  type SelectorConfigurationTemplate,
} from '../../compiler/src/selector-configuration-template.js';
import type { CapturedBlueprintParameter } from './blueprint-parameter-capture.js';
import type { CombinatorDescriptor } from './elaboration-values.js';
import { createProducerNumberDefaultContext } from './source-producer-number-defaults.js';

const source = Object.freeze({
  fileId: sourceFileId('source-producer-number-defaults.test.ts'),
  start: 5,
  end: 21,
});
const A = signal('virtual', 'signal-A');
const input = 'input' as NetworkId;

function declarations(
  session: BlueprintParameterSession,
  handles: readonly BlueprintParameterHandle[],
): CapturedBlueprintParameter[] {
  return handles.map((handle) =>
    Object.freeze({
      handle,
      registration: assertBlueprintParameterFromSession(session, handle, '$.test.handle'),
    }),
  );
}

function constantDescriptor(template: ConstantConfigurationTemplate): CombinatorDescriptor {
  return {
    kind: 'constant',
    source,
    instancePath: [],
    pendingConfiguration: template,
  } as unknown as CombinatorDescriptor;
}

function arithmeticDescriptor(template: ArithmeticConfigurationTemplate): CombinatorDescriptor {
  return {
    kind: 'arithmetic',
    left: { kind: 'constant' },
    operation: 'add',
    right: { kind: 'constant' },
    output: { kind: 'signal', signal: A },
    source,
    instancePath: [],
    pendingConfiguration: template,
  } as unknown as CombinatorDescriptor;
}

function deciderDescriptor(template: DeciderConfigurationTemplate): CombinatorDescriptor {
  return {
    kind: 'decider',
    condition: {
      kind: 'compare-each',
      refKind: 'single',
      network: input,
      comparator: '>',
      constant: { kind: 'constant' },
    },
    output: { kind: 'signal-constant', signal: A, value: 4 },
    source,
    instancePath: [],
    pendingConfiguration: template,
  } as unknown as CombinatorDescriptor;
}

function selectorDescriptor(template: SelectorConfigurationTemplate): CombinatorDescriptor {
  return {
    kind: 'selector',
    operation: 'select',
    input: { refKind: 'single', network: input },
    selectMax: false,
    source,
    instancePath: [],
    pendingConfiguration: template,
  } as unknown as CombinatorDescriptor;
}

function arithmeticTemplate(
  session: BlueprintParameterSession,
  left: number | BlueprintNumberParameterHandle | BlueprintNumericExpression,
  right: number | BlueprintNumberParameterHandle | BlueprintNumericExpression,
): ArithmeticConfigurationTemplate {
  return createArithmeticConfigurationTemplate(session, {
    left: { kind: 'constant', value: left },
    operation: 'add',
    right: { kind: 'constant', value: right },
    output: { kind: 'signal', signal: A },
  });
}

describe('producer-composed automatic numeric defaults', () => {
  test('keeps default-free Signal identity separate from numeric choices and projections', () => {
    const session = createBlueprintParameterSession();
    const automatic = session.number('Automatic count');
    const channel = session.signal('Required channel');
    const template = createConstantConfigurationTemplate(session, {
      sections: [{ filters: [{ signal: channel, value: automatic }] }],
    });
    const context = createProducerNumberDefaultContext(
      session,
      declarations(session, [automatic, channel]),
      [constantDescriptor(template)],
    );
    const numberSnapshot = context.declarations.find(({ handle }) => handle === automatic);
    const signalSnapshot = context.declarations.find(({ handle }) => handle === channel);

    expect(numberSnapshot).toMatchObject({ kind: 'number', defaultValue: 2 });
    expect(signalSnapshot).toMatchObject({ kind: 'signal', label: 'Required channel' });
    expect(signalSnapshot).not.toHaveProperty('defaultValue');
    expect(automatic.defaultValue).toBeUndefined();
    expect(channel.defaultValue).toBeUndefined();

    const numericOnly = context.bindingsForConstantTemplate(template);
    expect(numericOnly).toEqual([{ parameter: automatic, value: 2 }]);
    expect(() => bindConstantConfigurationTemplate(template, numericOnly)).toThrowError(
      expect.objectContaining({ code: 'CP1002' }),
    );

    const bound = bindConstantConfigurationTemplate(
      template,
      context.bindingsForConstantTemplate(template, [{ parameter: channel, value: A }]),
    );
    expect(bound.sections[0]?.filters).toEqual([{ signal: A, value: 2 }]);

    const literalSession = createBlueprintParameterSession();
    const sameAutomatic = literalSession.number('Automatic count');
    const literalTemplate = createConstantConfigurationTemplate(literalSession, {
      sections: [{ filters: [{ signal: A, value: sameAutomatic }] }],
    });
    const literalContext = createProducerNumberDefaultContext(
      literalSession,
      declarations(literalSession, [sameAutomatic]),
      [constantDescriptor(literalTemplate)],
    );
    expect(literalContext.declarations[0]?.defaultValue).toBe(numberSnapshot?.defaultValue);
  });

  test('reserves final typed slot values and binds authentic templates with stable reset defaults', () => {
    const session = createBlueprintParameterSession();
    const first = session.number('First automatic');
    const zero = session.number('Explicit zero', { defaultValue: 0 });
    const two = session.number('Explicit two', { defaultValue: 2 });
    const second = session.number('Second automatic');
    const nine = session.number('Explicit nine', { defaultValue: 9 });
    const unusedFive = session.number('Unused explicit five', { defaultValue: 5 });
    const wrapsToOne = session.number('Wraps to one', { defaultValue: 4_294_967_297 });
    const third = session.number('Third automatic');
    const fourth = session.number('Fourth automatic');
    const captured = declarations(session, [
      first,
      zero,
      two,
      second,
      nine,
      unusedFive,
      wrapsToOne,
      third,
      fourth,
    ]);
    const twoPlusSix = createBlueprintNumericExpression(session, {
      kind: 'binary',
      operator: 'add',
      left: { kind: 'parameter', parameter: two },
      right: { kind: 'literal', value: 6 },
    });
    const templates = {
      constant: createConstantConfigurationTemplate(session, {
        sections: [{ multiplier: first, filters: [{ signal: A, value: second }] }],
      }),
      arithmetic: arithmeticTemplate(session, first, twoPlusSix),
      expressionArithmetic: arithmeticTemplate(session, twoPlusSix, third),
      wrappedArithmetic: arithmeticTemplate(session, wrapsToOne, fourth),
      decider: createDeciderConfigurationTemplate(session, {
        condition: {
          kind: 'compare',
          left: { kind: 'wildcard', value: 'each', refKind: 'single', network: input },
          comparator: '>',
          right: { kind: 'constant', value: first },
        },
        outputs: [],
      }),
      selector: createSelectorConfigurationTemplate(session, {
        operation: 'select',
        input: { refKind: 'single', network: input },
        selectMax: false,
        index: second,
      }),
    };
    const producers = [
      constantDescriptor(templates.constant),
      arithmeticDescriptor(templates.arithmetic),
      arithmeticDescriptor(templates.expressionArithmetic),
      arithmeticDescriptor(templates.wrappedArithmetic),
      deciderDescriptor(templates.decider),
      selectorDescriptor(templates.selector),
    ];
    const before = producers.map((producer) => ({ ...producer }));

    const context = createProducerNumberDefaultContext(session, captured, producers);

    // 0, 2, 5 and 9 are explicit declarations; 4 and 8 are final slot values;
    // 4294967297 wraps to 1 in an int32 slot. The expression's intermediate 6
    // is deliberately not reserved, so the four choices are 3, 6, 7 and 10.
    expect(context.declarations.map(({ handle, defaultValue }) => [handle, defaultValue])).toEqual([
      [first, 3],
      [zero, 0],
      [two, 2],
      [second, 6],
      [nine, 9],
      [unusedFive, 5],
      [wrapsToOne, 4_294_967_297],
      [third, 7],
      [fourth, 10],
    ]);
    expect(
      bindConstantConfigurationTemplate(
        templates.constant,
        context.bindingsForConstantTemplate(templates.constant),
      ),
    ).toMatchObject({ sections: [{ multiplier: 3, filters: [{ value: 6 }] }] });
    expect(
      bindArithmeticConfigurationTemplate(
        templates.arithmetic,
        context.bindingsForArithmeticTemplate(templates.arithmetic),
      ),
    ).toMatchObject({ left: { value: 3 }, right: { value: 8 } });
    expect(
      bindArithmeticConfigurationTemplate(
        templates.expressionArithmetic,
        context.bindingsForArithmeticTemplate(templates.expressionArithmetic),
      ),
    ).toMatchObject({ left: { value: 8 }, right: { value: 7 } });
    expect(
      bindArithmeticConfigurationTemplate(
        templates.wrappedArithmetic,
        context.bindingsForArithmeticTemplate(templates.wrappedArithmetic),
      ),
    ).toMatchObject({ left: { value: 1 }, right: { value: 10 } });
    expect(
      bindDeciderConfigurationTemplate(
        templates.decider,
        context.bindingsForDeciderTemplate(templates.decider),
      ).condition,
    ).toMatchObject({ right: { kind: 'constant', value: 3 } });
    expect(
      bindSelectorConfigurationTemplate(
        templates.selector,
        context.bindingsForSelectorTemplate(templates.selector),
      ),
    ).toMatchObject({ operation: 'select', index: 6 });

    const overridden = bindConstantConfigurationTemplate(
      templates.constant,
      context.bindingsForConstantTemplate(templates.constant, [
        { parameter: first, value: 0 },
        { parameter: second, value: 12 },
      ]),
    );
    expect(overridden.sections[0]).toMatchObject({ multiplier: 0, filters: [{ value: 12 }] });
    const reset = bindConstantConfigurationTemplate(
      templates.constant,
      context.bindingsForConstantTemplate(templates.constant),
    );
    expect(reset.sections[0]).toMatchObject({ multiplier: 3, filters: [{ value: 6 }] });
    expect(
      createProducerNumberDefaultContext(session, captured, producers).declarations.map(
        ({ defaultValue }) => defaultValue,
      ),
    ).toEqual(context.declarations.map(({ defaultValue }) => defaultValue));
    expect(first.defaultValue).toBeUndefined();
    expect(second.defaultValue).toBeUndefined();
    expect(wrapsToOne.defaultValue).toBe(4_294_967_297);
    expect(producers).toEqual(before);
  });

  test('keeps finite multipliers out of int32 reservations and honors the legacy empty-row multiplier', () => {
    const session = createBlueprintParameterSession();
    const automatic = session.number('Automatic');
    const fractional = session.number('Fractional explicit', { defaultValue: 1.5 });
    const captured = declarations(session, [automatic, fractional]);
    const legacyEmpty = {
      kind: 'constant',
      outputs: [],
      source,
      instancePath: [],
    } as unknown as CombinatorDescriptor;
    const exactMultipliers = {
      kind: 'constant',
      configuration: {
        isOn: true,
        sections: [
          { active: true, multiplier: 2.5, filters: [] },
          { active: true, multiplier: 3_000_000_000, filters: [] },
        ],
      },
      source,
      instancePath: [],
    } as unknown as CombinatorDescriptor;
    const template = arithmeticTemplate(session, automatic, 10);

    const context = createProducerNumberDefaultContext(session, captured, [
      legacyEmpty,
      exactMultipliers,
      arithmeticDescriptor(template),
    ]);

    expect(context.declarations.map(({ defaultValue }) => defaultValue)).toEqual([2, 1.5]);
  });

  test('does not require allocator choices when there are no missing NUMBER declarations', () => {
    const session = createBlueprintParameterSession();
    const explicit = session.number('Explicit', { defaultValue: 17 });
    const context = createProducerNumberDefaultContext(
      session,
      declarations(session, [explicit]),
      [],
    );

    expect(context.declarations.map(({ handle, defaultValue }) => [handle, defaultValue])).toEqual([
      [explicit, 17],
    ]);
  });

  test('rejects an expression depending on an automatic handle at its exact slot and allows retry', () => {
    const session = createBlueprintParameterSession();
    const automatic = session.number('Automatic', { source });
    const dependent = createBlueprintNumericExpression(session, {
      kind: 'binary',
      operator: 'add',
      left: { kind: 'parameter', parameter: automatic },
      right: { kind: 'literal', value: 0 },
    });
    const template = arithmeticTemplate(session, dependent, 1);
    const producer = arithmeticDescriptor(template);

    expect(() =>
      createProducerNumberDefaultContext(session, declarations(session, [automatic]), [producer]),
    ).toThrowError(
      expect.objectContaining({
        code: 'CP1002',
        path: '$.producers[0].pendingConfiguration.left.value',
        span: source,
      }),
    );
    expect(automatic.defaultValue).toBeUndefined();
    expect(
      createProducerNumberDefaultContext(session, declarations(session, [automatic]), [
        arithmeticDescriptor(arithmeticTemplate(session, automatic, 1)),
      ]).declarations[0]?.defaultValue,
    ).toBe(2);
  });

  test('locates expression domain failures at the producer slot and permits a clean retry', () => {
    const session = createBlueprintParameterSession();
    const explicit = session.number('Explicit', { defaultValue: 2 });
    const fractionalExpression = createBlueprintNumericExpression(session, {
      kind: 'binary',
      operator: 'add',
      left: { kind: 'literal', value: 0.5 },
      right: { kind: 'literal', value: 0 },
    });
    const template = arithmeticTemplate(session, fractionalExpression, explicit);

    expect(() =>
      createProducerNumberDefaultContext(session, declarations(session, [explicit]), [
        arithmeticDescriptor(template),
      ]),
    ).toThrowError(
      expect.objectContaining({
        code: 'CP1000',
        path: '$.producers[0].pendingConfiguration.left.value',
        span: source,
      }),
    );
    expect(
      createProducerNumberDefaultContext(session, declarations(session, [explicit]), [])
        .declarations[0]?.defaultValue,
    ).toBe(2);
  });

  test('rejects same-session slot dependencies omitted from the authentic declaration list', () => {
    const session = createBlueprintParameterSession();
    const listed = session.number('Listed');
    const unlisted = session.number('Unlisted', { defaultValue: 8 });
    const expression = createBlueprintNumericExpression(session, {
      kind: 'binary',
      operator: 'add',
      left: { kind: 'parameter', parameter: unlisted },
      right: { kind: 'literal', value: 1 },
    });
    const template = arithmeticTemplate(session, expression, listed);

    expect(() =>
      createProducerNumberDefaultContext(session, declarations(session, [listed]), [
        arithmeticDescriptor(template),
      ]),
    ).toThrowError(
      expect.objectContaining({
        code: 'CP1001',
        path: '$.producers[0].pendingConfiguration.left.value',
      }),
    );
    expect(
      createProducerNumberDefaultContext(session, declarations(session, [listed]), [
        arithmeticDescriptor(arithmeticTemplate(session, listed, 1)),
      ]).declarations[0]?.defaultValue,
    ).toBe(2);
  });

  test('fails closed for foreign roots/declarations, fake roots, and duplicate declarations', () => {
    const session = createBlueprintParameterSession();
    const local = session.number('Local');
    const foreignSession = createBlueprintParameterSession();
    const foreignSource = Object.freeze({
      fileId: sourceFileId('foreign-producer.ts'),
      start: 1,
      end: 2,
    });
    const foreign = foreignSession.number('Foreign', {
      defaultValue: 3,
      source: foreignSource,
    });
    const foreignTemplate = arithmeticTemplate(foreignSession, foreign, 1);

    expect(() =>
      createProducerNumberDefaultContext(session, declarations(session, [local]), [
        arithmeticDescriptor(foreignTemplate),
      ]),
    ).toThrowError(expect.objectContaining({ code: 'CP1001' }));
    expect(
      createProducerNumberDefaultContext(session, declarations(session, [local]), [
        arithmeticDescriptor(arithmeticTemplate(session, local, 1)),
      ]).declarations[0]?.defaultValue,
    ).toBe(2);

    const foreignRoot = {
      kind: 'arithmetic',
      left: { kind: 'constant', value: foreign },
      operation: 'add',
      right: { kind: 'constant', value: 1 },
      output: { kind: 'signal', signal: A },
      source,
      instancePath: [],
    } as unknown as CombinatorDescriptor;
    expect(() =>
      createProducerNumberDefaultContext(session, declarations(session, [local]), [foreignRoot]),
    ).toThrowError(
      expect.objectContaining({
        code: 'CP1001',
        path: '$.producers[0].left.value',
        span: source,
      }),
    );
    expect(
      createProducerNumberDefaultContext(session, declarations(session, [local]), [
        arithmeticDescriptor(arithmeticTemplate(session, local, 1)),
      ]).declarations[0]?.defaultValue,
    ).toBe(2);

    expect(() =>
      createProducerNumberDefaultContext(session, declarations(foreignSession, [foreign]), []),
    ).toThrowError(expect.objectContaining({ code: 'CP1001', path: '$.declarations[0].handle' }));

    const fakeRoot = {
      kind: 'arithmetic',
      left: { kind: 'constant', value: { kind: 'literal', value: 7 } },
      operation: 'add',
      right: { kind: 'constant', value: 1 },
      output: { kind: 'signal', signal: A },
      source,
      instancePath: [],
    } as unknown as CombinatorDescriptor;
    expect(() =>
      createProducerNumberDefaultContext(session, declarations(session, [local]), [fakeRoot]),
    ).toThrowError(
      expect.objectContaining({
        code: 'CP1002',
        path: '$.producers[0].left.value',
        span: source,
      }),
    );
    expect(
      createProducerNumberDefaultContext(session, declarations(session, [local]), [
        arithmeticDescriptor(arithmeticTemplate(session, local, 1)),
      ]).declarations[0]?.defaultValue,
    ).toBe(2);

    const captured = declarations(session, [local]);
    expect(() =>
      createProducerNumberDefaultContext(session, [captured[0]!, captured[0]!], []),
    ).toThrowError(expect.objectContaining({ code: 'CP1001', path: '$.declarations[1].handle' }));
    expect(
      createProducerNumberDefaultContext(session, captured, [
        arithmeticDescriptor(arithmeticTemplate(session, local, 1)),
      ]).declarations[0]?.defaultValue,
    ).toBe(2);
  });

  test('composes maxNodes-plus-one producers and aggregate slots without truncation', () => {
    const session = createBlueprintParameterSession();
    const automatic = session.number('Automatic');
    const producerCount = constantConfigurationLimits.maxNodes + 1;
    const producers: CombinatorDescriptor[] = Array.from({ length: producerCount }, (_, index) => {
      const left = index === producerCount - 1 ? automatic : 10;
      return {
        kind: 'arithmetic',
        left: { kind: 'constant', value: left },
        operation: 'add',
        right: { kind: 'constant', value: 11 },
        output: { kind: 'signal', signal: A },
        source,
        instancePath: [],
      } as unknown as CombinatorDescriptor;
    });

    const context = createProducerNumberDefaultContext(
      session,
      declarations(session, [automatic]),
      producers,
    );

    expect(producers).toHaveLength(constantConfigurationLimits.maxNodes + 1);
    expect(context.declarations[0]?.defaultValue).toBe(1);
  });

  test('composes more aggregate numeric slots than maxNodes with fewer producers', () => {
    const session = createBlueprintParameterSession();
    const automatic = session.number('Automatic');
    const producers: CombinatorDescriptor[] = Array.from({ length: 2049 }, () => ({
      kind: 'arithmetic',
      left: { kind: 'constant', value: 10 },
      operation: 'add',
      right: { kind: 'constant', value: 11 },
      output: { kind: 'signal', signal: A },
      source,
      instancePath: [],
    }));

    const context = createProducerNumberDefaultContext(
      session,
      declarations(session, [automatic]),
      producers,
    );

    expect(producers.length).toBeLessThan(constantConfigurationLimits.maxNodes);
    expect(producers.length * 2).toBeGreaterThan(constantConfigurationLimits.maxNodes);
    expect(context.declarations[0]?.defaultValue).toBe(1);
  });
});

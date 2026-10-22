import { signal } from '@comblang/factorio';
import { sourceFileId, type NetworkId } from '@comblang/shared';
import { describe, expect, test } from 'vitest';

import { bindArithmeticConfigurationTemplate } from '../../compiler/src/arithmetic-configuration-binding.js';
import { createArithmeticConfigurationTemplate } from '../../compiler/src/arithmetic-configuration-template.js';
import { bindConstantConfigurationTemplate } from '../../compiler/src/constant-configuration-binding.js';
import { createConstantConfigurationTemplate } from '../../compiler/src/constant-configuration-template.js';
import { bindDeciderConfigurationTemplate } from '../../compiler/src/decider-configuration-binding.js';
import { createDeciderConfigurationTemplate } from '../../compiler/src/decider-configuration-template.js';
import { bindSelectorConfigurationTemplate } from '../../compiler/src/selector-configuration-binding.js';
import { createSelectorConfigurationTemplate } from '../../compiler/src/selector-configuration-template.js';
import { createBlueprintNumericExpression } from '../../compiler/src/blueprint-numeric-expression.js';
import {
  BlueprintParameterError,
  createBlueprintParameterSourceView,
  createBlueprintParameterSession,
  inspectBlueprintParameterHandle,
  type BlueprintNumberParameterHandle,
  type BlueprintParameterHandle,
  type BlueprintParameterSession,
  type BlueprintSignalParameterHandle,
} from '../../compiler/src/blueprint-parameters.js';
import type { CapturedBlueprintParameter } from './blueprint-parameter-capture.js';
import {
  createSourceResolvedNumberDefaultContext,
  inspectSourceResolvedNumberDefaultDeclarations,
} from './source-resolved-number-defaults.js';

const source = {
  fileId: sourceFileId('source-resolved-number-defaults.test.ts'),
  start: 4,
  end: 16,
};
const A = signal('virtual', 'signal-A');
const B = signal('virtual', 'signal-B');

function declarations(handles: readonly BlueprintParameterHandle[]): CapturedBlueprintParameter[] {
  return handles.map((handle) =>
    Object.freeze({
      handle,
      registration: inspectBlueprintParameterHandle(handle, '$.test.handle'),
    }),
  );
}

function ownerFixture() {
  const session = createBlueprintParameterSession();
  const amount = session.number('Amount', {
    source,
    metadata: { variable: 'amount-value', formula: 'amount + 1' },
  });
  const spare = session.number('Spare', { source });
  const zero = session.number('Zero is explicit', { defaultValue: 0, source });
  const channel = session.signal('Channel', { defaultValue: A, source });
  const captured = declarations([amount, spare, zero, channel]);
  const choices = [
    { parameter: amount, value: 17 },
    { parameter: spare, value: -8 },
  ];
  const context = createSourceResolvedNumberDefaultContext(session, captured, choices);
  return { session, amount, spare, zero, channel, captured, choices, context };
}

function familyTemplates(
  session: BlueprintParameterSession,
  amount: BlueprintNumberParameterHandle,
  spare: BlueprintNumberParameterHandle,
  zero: BlueprintNumberParameterHandle,
  channel: BlueprintSignalParameterHandle,
) {
  const amountExpression = createBlueprintNumericExpression(session, {
    kind: 'binary',
    operator: 'add',
    left: { kind: 'parameter', parameter: amount },
    right: { kind: 'literal', value: 2 },
  });
  const constant = createConstantConfigurationTemplate(session, {
    isOn: true,
    sections: [
      {
        multiplier: zero,
        filters: [{ signal: channel, value: amount }],
      },
    ],
  });
  const arithmetic = createArithmeticConfigurationTemplate(session, {
    left: { kind: 'constant', value: amountExpression },
    operation: 'add',
    right: { kind: 'constant', value: spare },
    output: { kind: 'signal', signal: A },
  });
  const decider = createDeciderConfigurationTemplate(session, {
    condition: {
      kind: 'compare',
      left: {
        kind: 'wildcard',
        value: 'each',
        refKind: 'single',
        network: 'input' as NetworkId,
      },
      comparator: '>',
      right: { kind: 'constant', value: amount },
    },
    outputs: [
      {
        mode: 'constant',
        signal: { kind: 'signal', signal: A },
        value: spare,
      },
    ],
  });
  const selector = createSelectorConfigurationTemplate(session, {
    operation: 'select',
    input: { refKind: 'single', network: 'input' as NetworkId },
    selectMax: false,
    index: amount,
  });
  return { constant, arithmetic, decider, selector };
}

describe('execution-local resolved numeric default context', () => {
  test('exposes the same authenticated immutable declaration pairs used by the context', () => {
    const fixture = ownerFixture();
    const inspected = inspectSourceResolvedNumberDefaultDeclarations(
      fixture.session,
      fixture.captured,
    );

    expect(inspected.map(({ handle, registration }) => [handle, registration])).toEqual(
      fixture.captured.map(({ handle, registration }) => [handle, registration]),
    );
    expect(Object.isFrozen(inspected)).toBe(true);
    expect(inspected.every(Object.isFrozen)).toBe(true);
    expect(inspected[0]?.handle).toBe(fixture.amount);
    expect(inspected[0]?.registration).toBe(
      inspectBlueprintParameterHandle(fixture.amount, '$.amount'),
    );

    const invalid = [
      [{ ...fixture.captured[0]!, registration: { ...fixture.captured[0]!.registration } }],
      [fixture.captured[0]!, fixture.captured[0]!],
    ];
    for (const declarationsValue of invalid) {
      let inspectorError: unknown;
      let contextError: unknown;
      try {
        inspectSourceResolvedNumberDefaultDeclarations(fixture.session, declarationsValue);
      } catch (error) {
        inspectorError = error;
      }
      try {
        createSourceResolvedNumberDefaultContext(fixture.session, declarationsValue, []);
      } catch (error) {
        contextError = error;
      }
      expect(inspectorError).toMatchObject({
        code: (contextError as BlueprintParameterError).code,
        path: (contextError as BlueprintParameterError).path,
      });
      expect(contextError).toBeInstanceOf(BlueprintParameterError);
    }
  });

  test('validates an exact, immutable chosen-default set without changing registrations', () => {
    const fixture = ownerFixture();
    const originalAmountRegistration = inspectBlueprintParameterHandle(fixture.amount, '$.amount');
    const originalSpareRegistration = inspectBlueprintParameterHandle(fixture.spare, '$.spare');
    const snapshot = fixture.context.declarations;

    expect(snapshot.map(({ label, defaultValue }) => [label, defaultValue])).toEqual([
      ['Amount', 17],
      ['Spare', -8],
      ['Zero is explicit', 0],
      ['Channel', A],
    ]);
    expect(snapshot[0]).not.toBe(originalAmountRegistration);
    expect(snapshot[0]).not.toHaveProperty('registration');
    expect(snapshot[0]?.metadata).toEqual({
      variable: 'amount-value',
      formula: 'amount + 1',
    });
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot[0])).toBe(true);
    expect(Object.isFrozen(snapshot[0]?.source)).toBe(true);
    expect(Object.isFrozen(snapshot[0]?.metadata)).toBe(true);
    expect(Reflect.set(snapshot[0]!, 'defaultValue', 99)).toBe(false);
    expect(() => (snapshot as unknown as unknown[]).push({})).toThrow();
    expect(fixture.amount.defaultValue).toBeUndefined();
    expect(fixture.spare.defaultValue).toBeUndefined();
    expect(inspectBlueprintParameterHandle(fixture.amount, '$.amount')).toBe(
      originalAmountRegistration,
    );
    expect(inspectBlueprintParameterHandle(fixture.spare, '$.spare')).toBe(
      originalSpareRegistration,
    );

    fixture.choices[0]!.value = 101;
    expect(fixture.context.declarations[0]?.defaultValue).toBe(17);
  });

  test('authenticates declarations, preserves capture order, and rejects foreign or unsupported entries', () => {
    const session = createBlueprintParameterSession();
    const first = session.number('First');
    const second = session.number('Second');
    const authentic = declarations([first, second]);
    const choices = [
      { parameter: first, value: 1 },
      { parameter: second, value: 2 },
    ];

    expect(
      createSourceResolvedNumberDefaultContext(session, authentic, choices).declarations.map(
        ({ handle }) => handle,
      ),
    ).toEqual([first, second]);
    expect(() =>
      createSourceResolvedNumberDefaultContext(
        session,
        [{ ...authentic[0]!, registration: { ...authentic[0]!.registration } }, authentic[1]!],
        choices,
      ),
    ).toThrowError(expect.objectContaining({ code: 'CP1001' }));
    expect(() =>
      createSourceResolvedNumberDefaultContext(
        session,
        [authentic[0]!, authentic[0]!],
        [choices[0]!],
      ),
    ).toThrowError(expect.objectContaining({ code: 'CP1001' }));

    const foreignSession = createBlueprintParameterSession();
    const foreign = foreignSession.number('Foreign');
    expect(() =>
      createSourceResolvedNumberDefaultContext(session, declarations([foreign]), [
        { parameter: foreign, value: 3 },
      ]),
    ).toThrowError(expect.objectContaining({ code: 'CP1001' }));

    const signalSession = createBlueprintParameterSession();
    const missingSignal = signalSession.signal('Missing signal default');
    const signalContext = createSourceResolvedNumberDefaultContext(
      signalSession,
      declarations([missingSignal]),
      [],
    );
    expect(signalContext.declarations).toMatchObject([
      { kind: 'signal', label: 'Missing signal default' },
    ]);
    expect(signalContext.declarations[0]).not.toHaveProperty('defaultValue');

    const signalTemplate = createConstantConfigurationTemplate(signalSession, {
      sections: [{ filters: [{ signal: missingSignal, value: 5 }] }],
    });
    expect(signalContext.bindingsForConstantTemplate(signalTemplate)).toEqual([]);
    expect(() =>
      bindConstantConfigurationTemplate(
        signalTemplate,
        signalContext.bindingsForConstantTemplate(signalTemplate),
      ),
    ).toThrowError(expect.objectContaining({ code: 'CP1002' }));
  });

  test('requires one distinct nonzero int32 choice per missing NUMBER and excludes explicit defaults', () => {
    const session = createBlueprintParameterSession();
    const missing = session.number('Missing');
    const missingAgain = session.number('Missing again');
    const explicit = session.number('Explicit', { defaultValue: 12 });
    const channel = session.signal('Channel', { defaultValue: A });
    const unlisted = session.number('Unlisted declaration');
    const captured = declarations([missing, missingAgain, explicit, channel]);
    const base = [
      { parameter: missing, value: 1 },
      { parameter: missingAgain, value: 2 },
    ];
    const invalidChoices: readonly unknown[][] = [
      [null],
      [],
      [{ parameter: missing, value: 1 }],
      [...base, { parameter: explicit, value: 3 }],
      [...base, { parameter: channel, value: 3 }],
      [
        { parameter: missing, value: 1 },
        { parameter: unlisted, value: 2 },
      ],
      [
        { parameter: missing, value: 1 },
        { parameter: missing, value: 2 },
      ],
      [
        { parameter: missing, value: 1 },
        { parameter: missingAgain, value: 1 },
      ],
      [
        { parameter: missing, value: 0 },
        { parameter: missingAgain, value: 2 },
      ],
      [
        { parameter: missing, value: 1.5 },
        { parameter: missingAgain, value: 2 },
      ],
      [
        { parameter: missing, value: Number.NaN },
        { parameter: missingAgain, value: 2 },
      ],
      [
        { parameter: missing, value: undefined },
        { parameter: missingAgain, value: 2 },
      ],
      [
        { parameter: missing, value: Number.POSITIVE_INFINITY },
        { parameter: missingAgain, value: 2 },
      ],
      [
        { parameter: missing, value: 2_147_483_648 },
        { parameter: missingAgain, value: 2 },
      ],
      [
        { parameter: missing, value: -2_147_483_649 },
        { parameter: missingAgain, value: 2 },
      ],
      [
        { parameter: missing, value: 12 },
        { parameter: missingAgain, value: 2 },
      ],
      [
        { parameter: { kind: 'number', label: 'forged' }, value: 1 },
        { parameter: missingAgain, value: 2 },
      ],
      [
        { parameter: createBlueprintParameterSession().number('Foreign'), value: 1 },
        { parameter: missingAgain, value: 2 },
      ],
    ];
    for (const choices of invalidChoices) {
      expect(() => createSourceResolvedNumberDefaultContext(session, captured, choices)).toThrow(
        BlueprintParameterError,
      );
    }
    expect(() => createSourceResolvedNumberDefaultContext(session, captured, null)).toThrow(
      BlueprintParameterError,
    );

    const valid = createSourceResolvedNumberDefaultContext(session, captured, base);
    expect(valid.declarations[0]?.defaultValue).toBe(1);
    expect(missing.defaultValue).toBeUndefined();
  });

  test('validates all overrides before projecting only the parameters used by each template', () => {
    const fixture = ownerFixture();
    const amountOnly = createArithmeticConfigurationTemplate(fixture.session, {
      left: { kind: 'constant', value: fixture.amount },
      operation: 'add',
      right: { kind: 'constant', value: 1 },
      output: { kind: 'signal', signal: A },
    });
    const spareOnly = createArithmeticConfigurationTemplate(fixture.session, {
      left: { kind: 'constant', value: fixture.spare },
      operation: 'add',
      right: { kind: 'constant', value: 1 },
      output: { kind: 'signal', signal: A },
    });

    const mutableOverrides = [{ parameter: fixture.spare, value: 33 }];
    const projectedAmount = fixture.context.bindingsForArithmeticTemplate(
      amountOnly,
      mutableOverrides,
    );
    mutableOverrides[0]!.value = 88;
    expect(projectedAmount).toEqual([{ parameter: fixture.amount, value: 17 }]);
    expect(bindArithmeticConfigurationTemplate(amountOnly, projectedAmount).left).toEqual({
      kind: 'constant',
      value: 17,
    });

    const mutableUsedOverride = [{ parameter: fixture.amount, value: 23 }];
    const projectedUsedOverride = fixture.context.bindingsForArithmeticTemplate(
      amountOnly,
      mutableUsedOverride,
    );
    mutableUsedOverride[0]!.value = 88;
    expect(projectedUsedOverride).toEqual([{ parameter: fixture.amount, value: 23 }]);
    expect(bindArithmeticConfigurationTemplate(amountOnly, projectedUsedOverride).left).toEqual({
      kind: 'constant',
      value: 23,
    });

    const projectedSpare = fixture.context.bindingsForArithmeticTemplate(spareOnly, [
      { parameter: fixture.amount, value: 44 },
    ]);
    expect(projectedSpare).toEqual([{ parameter: fixture.spare, value: -8 }]);
    expect(bindArithmeticConfigurationTemplate(spareOnly, projectedSpare).left).toEqual({
      kind: 'constant',
      value: -8,
    });

    expect(Object.isFrozen(projectedAmount)).toBe(true);
    expect(Object.isFrozen(projectedAmount[0])).toBe(true);
    expect(Reflect.set(projectedAmount[0]!, 'value', 91)).toBe(false);

    const alias = createBlueprintParameterSourceView(fixture.session, fixture.amount);
    expect(() =>
      fixture.context.bindingsForArithmeticTemplate(amountOnly, [
        { parameter: fixture.amount, value: 2 },
        { parameter: alias as BlueprintParameterHandle, value: 3 },
      ]),
    ).toThrowError(
      expect.objectContaining({
        code: 'CP1001',
        message: expect.stringContaining('duplicate binding'),
      }),
    );

    const unknownInSession = fixture.session.number('Not in declaration list');
    for (const invalid of [
      [null],
      [{ parameter: unknownInSession, value: 1 }],
      [{ parameter: fixture.spare, value: Number.POSITIVE_INFINITY }],
      [{ parameter: fixture.channel, value: 'not-a-signal' }],
      [{ parameter: fixture.amount, value: undefined }],
      [
        { parameter: fixture.amount, value: 1 },
        { parameter: fixture.amount, value: 2 },
      ],
    ]) {
      expect(() => fixture.context.bindingsForArithmeticTemplate(amountOnly, invalid)).toThrow(
        BlueprintParameterError,
      );
    }
    expect(() => fixture.context.bindingsForArithmeticTemplate(amountOnly, null)).toThrow(
      BlueprintParameterError,
    );

    const fractional = fixture.context.bindingsForArithmeticTemplate(amountOnly, [
      { parameter: fixture.amount, value: 1.5 },
    ]);
    expect(() => bindArithmeticConfigurationTemplate(amountOnly, fractional)).toThrow(
      BlueprintParameterError,
    );
  });

  test('uses the existing Constant, Arithmetic, Decider, and Selector binders with reset and overrides', () => {
    const fixture = ownerFixture();
    const templates = familyTemplates(
      fixture.session,
      fixture.amount,
      fixture.spare,
      fixture.zero,
      fixture.channel,
    );
    const amountRegistration = inspectBlueprintParameterHandle(fixture.amount, '$.amount');
    const amountHandle = fixture.amount;
    const arithmeticTemplate = templates.arithmetic;
    const constantDefault = bindConstantConfigurationTemplate(
      templates.constant,
      fixture.context.bindingsForConstantTemplate(templates.constant),
    );
    const arithmeticDefault = bindArithmeticConfigurationTemplate(
      templates.arithmetic,
      fixture.context.bindingsForArithmeticTemplate(templates.arithmetic),
    );
    const deciderDefault = bindDeciderConfigurationTemplate(
      templates.decider,
      fixture.context.bindingsForDeciderTemplate(templates.decider),
    );
    const selectorDefault = bindSelectorConfigurationTemplate(
      templates.selector,
      fixture.context.bindingsForSelectorTemplate(templates.selector),
    );

    expect(constantDefault).toEqual({
      isOn: true,
      sections: [
        {
          active: true,
          multiplier: 0,
          filters: [{ signal: A, value: 17 }],
        },
      ],
    });
    expect(arithmeticDefault.left).toEqual({ kind: 'constant', value: 19 });
    expect(arithmeticDefault.right).toEqual({ kind: 'constant', value: -8 });
    expect(deciderDefault.condition).toMatchObject({
      kind: 'compare',
      right: { kind: 'constant', value: 17 },
    });
    expect(deciderDefault.outputs[0]).toMatchObject({ mode: 'constant', value: -8 });
    expect(selectorDefault).toMatchObject({ operation: 'select', index: 17 });

    const explicitOverrides = [
      { parameter: fixture.amount, value: 0 },
      { parameter: fixture.spare, value: 17 },
      { parameter: fixture.zero, value: 7 },
      { parameter: fixture.channel, value: B },
    ];
    const overriddenConstant = bindConstantConfigurationTemplate(
      templates.constant,
      fixture.context.bindingsForConstantTemplate(templates.constant, explicitOverrides),
    );
    const overriddenArithmetic = bindArithmeticConfigurationTemplate(
      templates.arithmetic,
      fixture.context.bindingsForArithmeticTemplate(templates.arithmetic, explicitOverrides),
    );
    expect(overriddenConstant.sections[0]).toMatchObject({
      multiplier: 7,
      filters: [{ signal: B, value: 0 }],
    });
    expect(overriddenArithmetic.left).toEqual({ kind: 'constant', value: 2 });
    expect(overriddenArithmetic.right).toEqual({ kind: 'constant', value: 17 });

    const reset = bindArithmeticConfigurationTemplate(
      templates.arithmetic,
      fixture.context.bindingsForArithmeticTemplate(templates.arithmetic),
    );
    expect(reset).toEqual(arithmeticDefault);
    expect(inspectBlueprintParameterHandle(amountHandle, '$.amount')).toBe(amountRegistration);
    expect(fixture.amount.defaultValue).toBeUndefined();
    expect(templates.arithmetic).toBe(arithmeticTemplate);
  });

  test('keeps contexts isolated across owners and leaves template/session identities untouched', () => {
    const first = ownerFixture();
    const firstTemplates = familyTemplates(
      first.session,
      first.amount,
      first.spare,
      first.zero,
      first.channel,
    );
    const secondSession = createBlueprintParameterSession();
    const secondAmount = secondSession.number('Amount');
    const secondDeclarations = declarations([secondAmount]);
    const secondContext = createSourceResolvedNumberDefaultContext(
      secondSession,
      secondDeclarations,
      [{ parameter: secondAmount, value: 3 }],
    );
    const secondTemplate = createSelectorConfigurationTemplate(secondSession, {
      operation: 'select',
      input: { refKind: 'single', network: 'other' as NetworkId },
      selectMax: false,
      index: secondAmount,
    });

    expect(
      bindSelectorConfigurationTemplate(
        secondTemplate,
        secondContext.bindingsForSelectorTemplate(secondTemplate),
      ),
    ).toMatchObject({ index: 3 });
    if (secondTemplate.operation !== 'select' || firstTemplates.selector.operation !== 'select') {
      throw new Error('Expected select-mode Selector templates.');
    }
    expect(
      bindSelectorConfigurationTemplate(
        firstTemplates.selector,
        first.context.bindingsForSelectorTemplate(firstTemplates.selector),
      ),
    ).toMatchObject({ index: 17 });
    expect(() => secondContext.bindingsForSelectorTemplate(firstTemplates.selector)).toThrow(
      BlueprintParameterError,
    );
    expect(() => first.context.bindingsForSelectorTemplate(secondTemplate)).toThrow(
      BlueprintParameterError,
    );
    expect(first.context.declarations[0]?.defaultValue).toBe(17);
    expect(secondContext.declarations[0]?.defaultValue).toBe(3);
    expect(firstTemplates.selector.index).toBe(first.amount);
    expect(secondTemplate.index).toBe(secondAmount);
  });
});

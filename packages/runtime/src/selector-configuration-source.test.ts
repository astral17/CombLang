import { signal } from '@comblang/factorio';
import { sourceFileId, type NetworkId } from '@comblang/shared';
import { describe, expect, test, vi } from 'vitest';
import { inspectSelectorConfigurationTemplate } from '../../compiler/src/selector-configuration-template.js';
import { bindSelectorConfigurationTemplate } from '../../compiler/src/selector-configuration-binding.js';
import { createBlueprintNumericExpression } from '../../compiler/src/blueprint-numeric-expression.js';
import { createBlueprintParameterSession } from '../../compiler/src/blueprint-parameters.js';
import { createSourceNumericExpressionView } from './source-numeric-expressions.js';
import {
  bindPreparedSelectorConfigurationSource,
  prepareSelectorConfigurationSource,
  SelectorConfigurationSourceError,
} from './selector-configuration-source.js';

const source = { fileId: sourceFileId('selector-configuration-source.test.ts'), start: 0, end: 12 };
const A = signal('virtual', 'signal-A');

function context() {
  return {
    normalizeInput(value: unknown, _span: { readonly start: number; readonly end: number }) {
      if (value !== 'input' && value !== 'secondary') throw new Error('not a test Network');
      return { refKind: 'single' as const, network: value as NetworkId };
    },
    isSignal: (value: unknown): value is typeof A => value === A,
    snapshotSignal(value: typeof A) {
      return Object.freeze({ ...value });
    },
  };
}

function select(overrides: Record<string, unknown> = {}) {
  return { input: 'input', operation: 'select', index: 0, ...overrides };
}

describe('symbolic exact Selector source preparation', () => {
  test('retains missing-default numeric and Signal indices and binds only at the boundary', () => {
    const session = createBlueprintParameterSession();
    const numeric = session.number('index');
    const signalIndex = session.signal('indexSignal');
    const preparedNumber = prepareSelectorConfigurationSource(
      select({ index: numeric }),
      context(),
      session,
      source,
    );
    const preparedSignal = prepareSelectorConfigurationSource(
      select({ index: signalIndex }),
      context(),
      session,
      source,
    );

    expect('template' in preparedNumber && preparedNumber.hasParameterSlots).toBe(true);
    expect('template' in preparedSignal && preparedSignal.hasParameterSlots).toBe(true);
    if (
      !('template' in preparedNumber) ||
      !('template' in preparedSignal) ||
      preparedNumber.template.operation !== 'select' ||
      preparedSignal.template.operation !== 'select'
    ) {
      throw new Error('Expected authentic Selector templates.');
    }
    expect(
      inspectSelectorConfigurationTemplate(preparedNumber.template, '$.template').session,
    ).toBe(session);
    expect(preparedNumber.template.index).toBe(numeric);
    expect(preparedSignal.template.index).toBe(signalIndex);
    expect(
      bindPreparedSelectorConfigurationSource(preparedNumber, [{ parameter: numeric, value: 7 }]),
    ).toMatchObject({ operation: 'select', index: 7 });
    expect(
      bindPreparedSelectorConfigurationSource(preparedSignal, [
        { parameter: signalIndex, value: A },
      ]),
    ).toMatchObject({ operation: 'select', index: A });
    expect(() => bindPreparedSelectorConfigurationSource(preparedNumber)).toThrowError(
      expect.objectContaining({
        path: '$.index',
        cause: expect.objectContaining({ code: 'CP1002' }),
      }),
    );
  });

  test('retains count output slots and numeric expression roots without materializing defaults', () => {
    const session = createBlueprintParameterSession();
    const output = session.signal('output');
    const amount = session.number('amount');
    const expression = createBlueprintNumericExpression(session, {
      kind: 'binary',
      operator: 'add',
      left: { kind: 'parameter', parameter: amount },
      right: { kind: 'literal', value: 1 },
    });
    const view = createSourceNumericExpressionView(session, expression, source);
    const preparedOutput = prepareSelectorConfigurationSource(
      { input: 'input', operation: 'count', output },
      context(),
      session,
      source,
    );
    const preparedExpression = prepareSelectorConfigurationSource(
      select({ index: view }),
      context(),
      session,
      source,
    );

    expect('template' in preparedOutput && preparedOutput.hasParameterSlots).toBe(true);
    expect('template' in preparedExpression && preparedExpression.hasParameterSlots).toBe(true);
    if (
      !('template' in preparedOutput) ||
      !('template' in preparedExpression) ||
      preparedOutput.template.operation !== 'count' ||
      preparedExpression.template.operation !== 'select'
    ) {
      throw new Error('Expected Selector templates.');
    }
    expect(preparedOutput.template.output).toBe(output);
    expect(preparedExpression.template.index).toBe(expression);
    expect(
      bindSelectorConfigurationTemplate(preparedOutput.template, [{ parameter: output, value: A }]),
    ).toMatchObject({ operation: 'count', output: A });
    expect(
      bindSelectorConfigurationTemplate(preparedExpression.template, [
        { parameter: amount, value: 4 },
      ]),
    ).toMatchObject({ operation: 'select', index: 5 });
    expect(() => bindPreparedSelectorConfigurationSource(preparedOutput)).toThrowError(
      expect.objectContaining({
        path: '$.output',
        cause: expect.objectContaining({ code: 'CP1002' }),
      }),
    );
  });

  test('preparation does not evaluate expressions, coerce values, or mutate input data', () => {
    const session = createBlueprintParameterSession();
    const amount = session.number('amount');
    const expression = createBlueprintNumericExpression(session, {
      kind: 'binary',
      operator: 'divide',
      left: { kind: 'literal', value: 1 },
      right: { kind: 'parameter', parameter: amount },
    });
    const view = createSourceNumericExpressionView(session, expression, source);
    const coercion = vi.fn(() => 3);
    const strange = { [Symbol.toPrimitive]: coercion };
    const record = select({ index: view });
    expect(() =>
      prepareSelectorConfigurationSource(record, context(), session, source),
    ).not.toThrow();
    expect(() =>
      prepareSelectorConfigurationSource(select({ index: strange }), context(), session, source),
    ).toThrow();
    expect(coercion).not.toHaveBeenCalled();
    expect(record.index).toBe(view);

    const revoked = Proxy.revocable({}, {});
    revoked.revoke();
    expect(() =>
      prepareSelectorConfigurationSource(
        select({ index: revoked.proxy }),
        context(),
        session,
        source,
      ),
    ).toThrowError(
      expect.objectContaining({ path: '$.index', name: 'SelectorConfigurationSourceError' }),
    );
  });

  test('reads source descriptors once and rejects accessors without invoking them', () => {
    const counts = new Map<PropertyKey, number>();
    const record = select();
    const observed = new Proxy(record, {
      getOwnPropertyDescriptor(target, key) {
        counts.set(key, (counts.get(key) ?? 0) + 1);
        return Reflect.getOwnPropertyDescriptor(target, key);
      },
    });
    prepareSelectorConfigurationSource(observed, context(), undefined, source);
    expect([...counts.values()]).toEqual([1, 1, 1]);

    const getter = vi.fn(() => 'input');
    const accessor = { operation: 'select', index: 1 };
    Object.defineProperty(accessor, 'input', { enumerable: true, get: getter });
    expect(() =>
      prepareSelectorConfigurationSource(accessor, context(), undefined, source),
    ).toThrowError(expect.objectContaining({ path: '$.input' }));
    expect(getter).not.toHaveBeenCalled();

    const revoked = Proxy.revocable({}, {});
    revoked.revoke();
    expect(() =>
      prepareSelectorConfigurationSource(revoked.proxy, context(), undefined, source),
    ).toThrowError(
      expect.objectContaining({
        path: '$',
        configurationShape: true,
        name: 'SelectorConfigurationSourceError',
      }),
    );
  });

  test('preserves concrete no-session defaults and snapshots Signals', () => {
    const concrete = prepareSelectorConfigurationSource(
      select({ index: A, selectMax: undefined }),
      context(),
      undefined,
      source,
    );
    expect(concrete).toMatchObject({
      configuration: { operation: 'select', selectMax: true, index: A },
      hasParameterSlots: false,
    });
    if (!('configuration' in concrete)) throw new Error('Expected a concrete config.');
    if (concrete.configuration.operation !== 'select') {
      throw new Error('Expected a concrete select configuration.');
    }
    expect(concrete.configuration.index).not.toBe(A);
    expect(Object.isFrozen(concrete.configuration.index)).toBe(true);
    expect(
      prepareSelectorConfigurationSource(
        select({ index: undefined }),
        context(),
        undefined,
        source,
      ),
    ).toMatchObject({ configuration: { index: 0, selectMax: true } });
    expect(() =>
      prepareSelectorConfigurationSource(select({ index: 2 }), context(), undefined, source),
    ).not.toThrow();
  });

  test('rejects wrong-kind, foreign, forged, and foreign-expression source values at root fields', () => {
    const session = createBlueprintParameterSession();
    const other = createBlueprintParameterSession();
    const wrongKind = session.number('notSignal');
    const foreign = other.number('foreign');
    const copied = { ...wrongKind };
    const forged = { kind: 'number', label: 'forged' };
    const foreignExpression = createSourceNumericExpressionView(
      other,
      createBlueprintNumericExpression(other, {
        kind: 'literal',
        value: 3,
      }),
      source,
    );
    for (const value of [wrongKind, foreign, copied, forged, foreignExpression]) {
      expect(() =>
        prepareSelectorConfigurationSource(
          { input: 'input', operation: 'count', output: value },
          context(),
          session,
          source,
        ),
      ).toThrowError(
        expect.objectContaining({ name: 'SelectorConfigurationSourceError', path: '$.output' }),
      );
    }
    expect(() =>
      prepareSelectorConfigurationSource(
        { input: 'input', operation: 'count', output: wrongKind },
        context(),
        session,
        source,
      ),
    ).toThrowError(
      expect.objectContaining({
        path: '$.output',
        cause: expect.objectContaining({ path: '$.output', code: 'CP1001' }),
      }),
    );
  });

  test('keeps selectMax concrete and validates operation-specific source fields', () => {
    const session = createBlueprintParameterSession();
    expect(() =>
      prepareSelectorConfigurationSource(
        select({ selectMax: session.number('max') }),
        context(),
        session,
        source,
      ),
    ).toThrowError(expect.objectContaining({ path: '$.selectMax' }));
    for (const invalid of [
      { input: 'input', operation: 'count', output: A, selectMax: true },
      { input: 'input', operation: 'count' },
      { input: 'input', operation: 'other' },
      { input: 'input', operation: 'select', index: 1, [Symbol('unknown')]: true },
    ]) {
      expect(() => prepareSelectorConfigurationSource(invalid, context(), session, source)).toThrow(
        SelectorConfigurationSourceError,
      );
    }
  });

  test('reports concrete numeric and input failures without a session', () => {
    expect(() =>
      prepareSelectorConfigurationSource(
        select({ index: Number.NaN }),
        context(),
        undefined,
        source,
      ),
    ).toThrowError(expect.objectContaining({ path: '$.index' }));
    expect(() =>
      prepareSelectorConfigurationSource(
        select({ index: createBlueprintParameterSession().number('x') }),
        context(),
        undefined,
        source,
      ),
    ).toThrowError(expect.objectContaining({ path: '$.index' }));
    expect(() =>
      prepareSelectorConfigurationSource(
        select({ input: 'missing' }),
        context(),
        undefined,
        source,
      ),
    ).toThrowError(/not a test Network/);
  });
});

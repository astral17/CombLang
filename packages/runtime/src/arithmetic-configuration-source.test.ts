import { circuitConstant, signal } from '@comblang/factorio';
import { sourceFileId, type NetworkId } from '@comblang/shared';
import { describe, expect, test, vi } from 'vitest';
import { bindArithmeticConfigurationTemplate } from '../../compiler/src/arithmetic-configuration-binding.js';
import {
  createArithmeticConfigurationTemplate,
  inspectArithmeticConfigurationTemplate,
} from '../../compiler/src/arithmetic-configuration-template.js';
import { createBlueprintNumericExpression } from '../../compiler/src/blueprint-numeric-expression.js';
import { createBlueprintParameterSession } from '../../compiler/src/blueprint-parameters.js';
import { createSourceNumericExpressionView } from './source-numeric-expressions.js';
import {
  bindPreparedArithmeticConfigurationSource,
  ArithmeticConfigurationSourceError,
  prepareArithmeticConfigurationSource,
} from './arithmetic-configuration-source.js';

const source = {
  fileId: sourceFileId('arithmetic-configuration-source.test.ts'),
  start: 0,
  end: 12,
};
const A = signal('virtual', 'signal-A');
const EACH = Object.freeze({ kind: 'each-output' });

function context() {
  return {
    normalizeCircuitOperand(value: unknown) {
      if (typeof value === 'number')
        return { kind: 'constant' as const, value: circuitConstant(value) };
      if (value === 'input') {
        return { kind: 'each' as const, refKind: 'single' as const, network: 'input' as NetworkId };
      }
      if (value === A) {
        return {
          kind: 'signal' as const,
          refKind: 'single' as const,
          network: 'input' as NetworkId,
          signal: A,
        };
      }
      throw new Error('unsupported test circuit operand');
    },
    isSignal: (value: unknown): value is typeof A => value === A,
    snapshotSignal(value: typeof A) {
      return Object.freeze({ ...value });
    },
    isEachOutput: (value: unknown) => value === EACH,
  };
}

function config(overrides: Record<string, unknown> = {}) {
  return {
    left: 2,
    operation: 'add',
    right: 3,
    output: A,
    ...overrides,
  };
}

describe('symbolic exact Arithmetic source preparation', () => {
  test('authenticates missing-default operands and output without reading defaults', () => {
    const session = createBlueprintParameterSession();
    const left = session.number('left');
    const right = session.number('right');
    const output = session.signal('output');
    const prepared = prepareArithmeticConfigurationSource(
      config({ left, right, output }),
      context(),
      session,
      source,
    );

    expect('template' in prepared).toBe(true);
    if (!('template' in prepared)) throw new Error('Expected symbolic template.');
    expect(prepared.hasParameterSlots).toBe(true);
    expect(inspectArithmeticConfigurationTemplate(prepared.template, '$.template').session).toBe(
      session,
    );
    expect(prepared.template.left).toEqual({ kind: 'constant', value: left });
    expect(prepared.template.right).toEqual({ kind: 'constant', value: right });
    expect(prepared.template.output).toEqual({ kind: 'signal', signal: output });
    expect(
      bindArithmeticConfigurationTemplate(prepared.template, [
        { parameter: left, value: 4 },
        { parameter: right, value: 7 },
        { parameter: output, value: A },
      ]),
    ).toMatchObject({
      left: { kind: 'constant', value: 4 },
      right: { kind: 'constant', value: 7 },
      output: { kind: 'signal', signal: A },
    });
    expect(() => bindArithmeticConfigurationTemplate(prepared.template)).toThrowError(
      expect.objectContaining({ path: '$.left.value', code: 'CP1002' }),
    );
  });

  test.each(['left', 'right'] as const)(
    'retains the original missing-default expression root in the %s slot',
    (field) => {
      const session = createBlueprintParameterSession();
      const amount = session.number('amount');
      const expression = createBlueprintNumericExpression(session, {
        kind: 'binary',
        operator: 'add',
        left: { kind: 'parameter', parameter: amount },
        right: { kind: 'literal', value: 1 },
      });
      const view = createSourceNumericExpressionView(session, expression, source);
      const prepared = prepareArithmeticConfigurationSource(
        config({ [field]: view }),
        context(),
        session,
        source,
      );

      expect('template' in prepared).toBe(true);
      if (!('template' in prepared)) throw new Error('Expected symbolic template.');
      expect(prepared.template[field]).toEqual({ kind: 'constant', value: expression });
      expect(
        bindArithmeticConfigurationTemplate(prepared.template, [{ parameter: amount, value: 5 }])[
          field
        ],
      ).toEqual({ kind: 'constant', value: 6 });
      expect(() => bindPreparedArithmeticConfigurationSource(prepared)).toThrowError(
        expect.objectContaining({
          path: `$.${field}`,
          message: expect.stringContaining('has no binding or default'),
        }),
      );
    },
  );

  test('does not invoke coercion or evaluate expressions during preparation', () => {
    const session = createBlueprintParameterSession();
    const amount = session.number('amount');
    const expression = createBlueprintNumericExpression(session, {
      kind: 'binary',
      operator: 'divide',
      left: { kind: 'literal', value: 1 },
      right: { kind: 'parameter', parameter: amount },
    });
    const view = createSourceNumericExpressionView(session, expression, source);
    const coerce = vi.fn(() => 99);
    const strange = { [Symbol.toPrimitive]: coerce };

    expect(() =>
      prepareArithmeticConfigurationSource(config({ left: view }), context(), session, source),
    ).not.toThrow();
    expect(() =>
      prepareArithmeticConfigurationSource(config({ left: strange }), context(), session, source),
    ).toThrow();
    expect(coerce).not.toHaveBeenCalled();
  });

  test('uses recorder-owned circuit normalization and snapshots concrete Signals', () => {
    const session = createBlueprintParameterSession();
    const prepared = prepareArithmeticConfigurationSource(
      config({ left: 'input', right: A, output: EACH }),
      context(),
      session,
      source,
    );
    expect('template' in prepared).toBe(true);
    if (!('template' in prepared)) throw new Error('Expected template.');
    expect(prepared.template.left).toEqual({ kind: 'each', refKind: 'single', network: 'input' });
    expect(prepared.template.right).toEqual({
      kind: 'signal',
      refKind: 'single',
      network: 'input',
      signal: A,
    });
    expect(prepared.template.right.kind === 'signal' && prepared.template.right.signal).not.toBe(A);
    expect(
      Object.isFrozen(
        prepared.template.right.kind === 'signal' ? prepared.template.right.signal : {},
      ),
    ).toBe(true);
    expect(prepared.template.output).toEqual({ kind: 'each' });
  });

  test('supports literal-only source without constructing a parameter session', () => {
    const prepared = prepareArithmeticConfigurationSource(config(), context(), undefined, source);
    expect(prepared).toEqual({
      configuration: {
        left: { kind: 'constant', value: 2 },
        operation: 'add',
        right: { kind: 'constant', value: 3 },
        output: { kind: 'signal', signal: A },
      },
      hasParameterSlots: false,
    });
    expect(Object.isFrozen(prepared)).toBe(true);
  });

  test('rejects wrong-kind, foreign, and forged source slots at exact field paths', () => {
    const session = createBlueprintParameterSession();
    const foreign = createBlueprintParameterSession().number('foreign');
    const signalParameter = session.signal('channel');
    for (const [value, message] of [
      [signalParameter, 'expected a number parameter, received signal'],
      [foreign, 'parameter belongs to a different parameter session'],
      [{ kind: 'number', label: 'forged' }, 'unregistered parameter-like object'],
    ] as const) {
      expect(() =>
        prepareArithmeticConfigurationSource(config({ left: value }), context(), session, source),
      ).toThrowError(
        expect.objectContaining({
          name: 'ArithmeticConfigurationSourceError',
          path: '$.left',
          message: expect.stringContaining(message),
        } satisfies Partial<ArithmeticConfigurationSourceError>),
      );
    }
  });

  test('descriptor-reads exact fields once and refuses accessors without invoking them', () => {
    const reads = new Map<string, number>();
    const original = config();
    const sourceRecord = new Proxy(original, {
      getOwnPropertyDescriptor(target, key) {
        if (typeof key === 'string') reads.set(key, (reads.get(key) ?? 0) + 1);
        return Reflect.getOwnPropertyDescriptor(target, key);
      },
    });
    prepareArithmeticConfigurationSource(sourceRecord, context(), undefined, source);
    expect([...reads.values()]).toEqual([1, 1, 1, 1]);
    expect(original).toEqual(config());

    const getter = vi.fn(() => 2);
    const accessor = { ...config() };
    Object.defineProperty(accessor, 'left', { enumerable: true, get: getter });
    expect(() =>
      prepareArithmeticConfigurationSource(accessor, context(), undefined, source),
    ).toThrowError(expect.objectContaining({ path: '$.left' }));
    expect(getter).not.toHaveBeenCalled();
  });

  test('validates required fields and operation before attempting to bind', () => {
    expect(() =>
      prepareArithmeticConfigurationSource(
        { left: 1, operation: 'invalid', right: 2, output: A },
        context(),
        undefined,
        source,
      ),
    ).toThrowError(expect.objectContaining({ path: '$.operation' }));
    expect(() =>
      prepareArithmeticConfigurationSource(
        { left: 1, operation: 'add', right: 2 },
        context(),
        undefined,
        source,
      ),
    ).toThrowError(expect.objectContaining({ path: '$.output' }));
  });

  test('rejects a source expression owned by a different parameter session', () => {
    const owner = createBlueprintParameterSession();
    const other = createBlueprintParameterSession();
    const amount = owner.number('amount');
    const expression = createBlueprintNumericExpression(owner, {
      kind: 'parameter',
      parameter: amount,
    });
    const view = createSourceNumericExpressionView(owner, expression, source);
    expect(() =>
      prepareArithmeticConfigurationSource(config({ right: view }), context(), other, source),
    ).toThrowError(expect.objectContaining({ path: '$.right' }));
  });

  test('template construction reuses the shared compiler factory validation', () => {
    const session = createBlueprintParameterSession();
    const prepared = prepareArithmeticConfigurationSource(config(), context(), session, source);
    expect('template' in prepared).toBe(true);
    if (!('template' in prepared)) throw new Error('Expected template.');
    const independentlyCreated = createArithmeticConfigurationTemplate(session, {
      left: { kind: 'constant', value: 2 },
      operation: 'add',
      right: { kind: 'constant', value: 3 },
      output: { kind: 'signal', signal: A },
    });
    expect(prepared.template).toEqual(independentlyCreated);
    expect(bindArithmeticConfigurationTemplate(prepared.template)).toEqual(
      bindArithmeticConfigurationTemplate(independentlyCreated),
    );
  });
});

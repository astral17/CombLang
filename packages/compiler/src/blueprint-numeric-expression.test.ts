import {
  canonicalizeConstantConfiguration,
  constantConfigurationLimits,
  signal,
} from '@comblang/factorio';
import type { SourceFileId } from '@comblang/shared';
import { describe, expect, test } from 'vitest';

import {
  createBlueprintParameterSession,
  createBlueprintParameterSourceView,
  sealBlueprintParameterSession,
} from './blueprint-parameters.js';
import {
  createBlueprintNumericExpression,
  evaluateBlueprintNumericExpression,
  inspectBlueprintNumericExpression,
} from './blueprint-numeric-expression.js';
import { assertBlueprintParameterNumberValue } from './blueprint-parameter-validation.js';
import { registerBlueprintNumericExpressionAdapter } from './blueprint-numeric-expression-bridge.js';
import type { BlueprintNumericExpression } from './blueprint-numeric-expression.js';

const source = { fileId: 'numeric-expression.test.ts' as SourceFileId, start: 4, end: 28 };

describe('host-local blueprint numeric expressions', () => {
  test('rejects replacement by a conflicting host-local adapter', () => {
    expect(() =>
      registerBlueprintNumericExpressionAdapter({
        isRegistered: (_value): _value is BlueprintNumericExpression => false,
        inspect: () => {
          throw new Error('unused test adapter');
        },
        evaluate: () => 0,
      }),
    ).toThrowError(/conflicting blueprint numeric expression adapter/);
  });

  test('builds frozen typed nodes while preserving ordered operations and shared subexpressions', () => {
    const session = createBlueprintParameterSession();
    const product = {
      kind: 'binary',
      operator: 'multiply',
      left: { kind: 'literal', value: 2 },
      right: { kind: 'literal', value: 3 },
    };
    const ordered = createBlueprintNumericExpression(session, {
      kind: 'binary',
      operator: 'subtract',
      left: { kind: 'literal', value: 20 },
      right: product,
    });
    const shared = {
      kind: 'binary',
      operator: 'add',
      left: { kind: 'literal', value: 7 },
      right: { kind: 'literal', value: 2 },
    };
    const reused = createBlueprintNumericExpression(session, {
      kind: 'binary',
      operator: 'subtract',
      left: shared,
      right: shared,
    });
    const sharedRegistered = createBlueprintNumericExpression(session, {
      kind: 'binary',
      operator: 'add',
      left: ordered,
      right: ordered,
    });

    expect(Object.isFrozen(ordered)).toBe(true);
    if (ordered.kind !== 'binary' || ordered.right.kind !== 'binary') {
      throw new Error('Expected nested binary expression nodes.');
    }
    expect(Object.isFrozen(ordered.right)).toBe(true);
    expect(ordered).toMatchObject({
      kind: 'binary',
      operator: 'subtract',
      left: { kind: 'literal', value: 20 },
      right: {
        kind: 'binary',
        operator: 'multiply',
        left: { kind: 'literal', value: 2 },
        right: { kind: 'literal', value: 3 },
      },
    });
    if (reused.kind !== 'binary') throw new Error('Expected a shared binary expression node.');
    expect(reused.left).toBe(reused.right);
    if (sharedRegistered.kind !== 'binary') {
      throw new Error('Expected a binary expression that reuses registered nodes.');
    }
    expect(sharedRegistered.left).toBe(ordered);
    expect(sharedRegistered.left).toBe(sharedRegistered.right);
    expect(evaluateBlueprintNumericExpression(session, ordered)).toBe(14);
    expect(evaluateBlueprintNumericExpression(session, reused)).toBe(0);
    expect(evaluateBlueprintNumericExpression(session, sharedRegistered)).toBe(28);
  });

  test('evaluates finite JavaScript division on either side with fractional intermediates', () => {
    const session = createBlueprintParameterSession();
    const amount = session.number('amount', { defaultValue: 10, source });
    const parameterNode = { kind: 'parameter', parameter: amount };
    const halfThenAdd = createBlueprintNumericExpression(session, {
      kind: 'binary',
      operator: 'add',
      left: {
        kind: 'binary',
        operator: 'divide',
        left: parameterNode,
        right: { kind: 'literal', value: 2 },
      },
      right: { kind: 'literal', value: 3 },
    });
    const reciprocalSide = createBlueprintNumericExpression(session, {
      kind: 'binary',
      operator: 'divide',
      left: { kind: 'literal', value: 20 },
      right: parameterNode,
    });
    const fractionalIntermediate = createBlueprintNumericExpression(session, {
      kind: 'binary',
      operator: 'multiply',
      left: {
        kind: 'binary',
        operator: 'divide',
        left: parameterNode,
        right: { kind: 'literal', value: 4 },
      },
      right: { kind: 'literal', value: 8 },
    });
    const negative = createBlueprintNumericExpression(session, {
      kind: 'binary',
      operator: 'divide',
      left: { kind: 'literal', value: -20 },
      right: { kind: 'literal', value: 4 },
    });
    const negativeDenominator = createBlueprintNumericExpression(session, {
      kind: 'binary',
      operator: 'divide',
      left: { kind: 'literal', value: -20 },
      right: { kind: 'literal', value: -4 },
    });

    expect(evaluateBlueprintNumericExpression(session, halfThenAdd)).toBe(8);
    expect(
      evaluateBlueprintNumericExpression(session, halfThenAdd, [{ parameter: amount, value: 14 }]),
    ).toBe(10);
    expect(evaluateBlueprintNumericExpression(session, reciprocalSide)).toBe(2);
    expect(
      evaluateBlueprintNumericExpression(session, reciprocalSide, [
        { parameter: amount, value: 5 },
      ]),
    ).toBe(4);
    expect(evaluateBlueprintNumericExpression(session, fractionalIntermediate)).toBe(20);
    expect(evaluateBlueprintNumericExpression(session, negative)).toBe(-5);
    expect(evaluateBlueprintNumericExpression(session, negativeDenominator)).toBe(5);
  });

  test('rejects zero denominators and non-finite division with the expression source', () => {
    const session = createBlueprintParameterSession();
    const denominator = session.number('denominator', { defaultValue: 2, source });
    const expression = createBlueprintNumericExpression(session, {
      kind: 'binary',
      operator: 'divide',
      left: { kind: 'literal', value: 20 },
      right: { kind: 'parameter', parameter: denominator },
    });

    for (const value of [0, -0]) {
      expect(() =>
        evaluateBlueprintNumericExpression(session, expression, [
          { parameter: denominator, value },
        ]),
      ).toThrowError(expect.objectContaining({ code: 'CP1000', span: source }));
    }
    const overflow = createBlueprintNumericExpression(session, {
      kind: 'binary',
      operator: 'divide',
      left: { kind: 'literal', value: 1 },
      right: { kind: 'literal', value: Number.MIN_VALUE },
    });
    expect(() => evaluateBlueprintNumericExpression(session, overflow)).toThrowError(
      expect.objectContaining({ code: 'CP1000' }),
    );
  });

  test('evaluates registered power with JavaScript grouping, orientations, and finite fractions', () => {
    const session = createBlueprintParameterSession();
    const amount = session.number('amount', { defaultValue: 3, source });
    const ref = { kind: 'parameter' as const, parameter: amount };
    const literal = (value: number) => ({ kind: 'literal' as const, value });
    const binary = (left: unknown, right: unknown) => ({
      kind: 'binary' as const,
      operator: 'power' as const,
      left,
      right,
    });
    const powerThenAdd = createBlueprintNumericExpression(session, {
      kind: 'binary',
      operator: 'add',
      left: binary(ref, literal(2)),
      right: literal(1),
    });
    const parameterOnRight = createBlueprintNumericExpression(session, binary(literal(2), ref));
    const rightAssociated = createBlueprintNumericExpression(
      session,
      binary(literal(2), binary(ref, literal(2))),
    );
    const leftAssociated = createBlueprintNumericExpression(
      session,
      binary(binary(literal(2), ref), literal(2)),
    );
    const fractionalIntermediate = createBlueprintNumericExpression(session, {
      kind: 'binary',
      operator: 'multiply',
      left: binary(ref, literal(-1)),
      right: literal(12),
    });
    const zeroToZero = createBlueprintNumericExpression(session, binary(literal(0), literal(0)));
    const negativeExponent = createBlueprintNumericExpression(
      session,
      binary(literal(2), literal(-2)),
    );

    expect(evaluateBlueprintNumericExpression(session, powerThenAdd)).toBe(10);
    expect(
      evaluateBlueprintNumericExpression(session, powerThenAdd, [{ parameter: amount, value: 4 }]),
    ).toBe(17);
    expect(evaluateBlueprintNumericExpression(session, parameterOnRight)).toBe(8);
    expect(
      evaluateBlueprintNumericExpression(session, parameterOnRight, [
        { parameter: amount, value: 4 },
      ]),
    ).toBe(16);
    expect(evaluateBlueprintNumericExpression(session, rightAssociated)).toBe(512);
    expect(evaluateBlueprintNumericExpression(session, leftAssociated)).toBe(64);
    expect(evaluateBlueprintNumericExpression(session, fractionalIntermediate)).toBe(4);
    expect(evaluateBlueprintNumericExpression(session, zeroToZero)).toBe(1);
    expect(evaluateBlueprintNumericExpression(session, negativeExponent)).toBe(0.25);
  });

  test('rejects power NaN and non-finite results with located CP1000 diagnostics', () => {
    const session = createBlueprintParameterSession();
    const base = session.number('base', { defaultValue: -2, source });
    const exponent = session.number('exponent', { defaultValue: 3, source });
    const expression = createBlueprintNumericExpression(session, {
      kind: 'binary',
      operator: 'power',
      left: { kind: 'parameter', parameter: base },
      right: { kind: 'parameter', parameter: exponent },
    });

    expect(evaluateBlueprintNumericExpression(session, expression)).toBe(-8);
    expect(() =>
      evaluateBlueprintNumericExpression(session, expression, [
        { parameter: exponent, value: 0.5 },
      ]),
    ).toThrowError(expect.objectContaining({ code: 'CP1000', span: source }));

    for (const [left, right] of [
      [0, -1],
      [2, 1024],
    ] as const) {
      const invalid = createBlueprintNumericExpression(session, {
        kind: 'binary',
        operator: 'power',
        left: { kind: 'literal', value: left },
        right: { kind: 'literal', value: right },
      });
      expect(() => evaluateBlueprintNumericExpression(session, invalid)).toThrowError(
        expect.objectContaining({ code: 'CP1000' }),
      );
    }
  });

  test('canonicalizes same-session opaque source views to raw number references', () => {
    const session = createBlueprintParameterSession();
    const parameter = session.number('Limit', { defaultValue: 5, source });
    const sourceView = createBlueprintParameterSourceView(session, parameter);
    const expression = createBlueprintNumericExpression(session, {
      kind: 'parameter',
      parameter: sourceView,
    });

    expect(expression).toMatchObject({ kind: 'parameter', parameter });
    expect((expression as { readonly parameter: unknown }).parameter).toBe(parameter);
    expect(evaluateBlueprintNumericExpression(session, expression)).toBe(5);
    expect(
      evaluateBlueprintNumericExpression(session, expression, [{ parameter, value: 11 }]),
    ).toBe(11);
  });

  test('inspects ordered unique dependencies on a shared DAG, including after sealing', () => {
    const session = createBlueprintParameterSession();
    const parameter = session.number('shared', { defaultValue: 5, source });
    const sharedReference = { kind: 'parameter', parameter };
    const expression = createBlueprintNumericExpression(session, {
      kind: 'binary',
      operator: 'add',
      left: sharedReference,
      right: sharedReference,
    });

    const beforeSeal = inspectBlueprintNumericExpression(session, expression, '$.expression');
    sealBlueprintParameterSession(session, '$.session');
    const afterSeal = inspectBlueprintNumericExpression(session, expression, '$.expression');

    expect(beforeSeal.session).toBe(session);
    expect(beforeSeal.dependencies).toEqual([parameter]);
    expect(beforeSeal.nodeCount).toBe(2);
    expect(beforeSeal.byteLength).toBeGreaterThan(0);
    expect(Object.isFrozen(beforeSeal)).toBe(true);
    expect(Object.isFrozen(beforeSeal.dependencies)).toBe(true);
    expect(afterSeal).toEqual(beforeSeal);
    expect(evaluateBlueprintNumericExpression(session, expression)).toBe(10);
  });

  test('rejects signal, foreign, and forged parameter references', () => {
    const session = createBlueprintParameterSession();
    const foreign = createBlueprintParameterSession();
    const number = session.number('count', { source });
    const signalParameter = session.signal('target', { source });
    const foreignParameter = foreign.number('foreign', { source });
    const forged = Object.freeze({ kind: 'number', label: 'count' });

    expect(() =>
      createBlueprintNumericExpression(session, { kind: 'parameter', parameter: signalParameter }),
    ).toThrowError(expect.objectContaining({ code: 'CP1001', path: '$.parameter', span: source }));
    expect(() =>
      createBlueprintNumericExpression(session, { kind: 'parameter', parameter: foreignParameter }),
    ).toThrowError(expect.objectContaining({ code: 'CP1001', path: '$.parameter', span: source }));
    expect(() =>
      createBlueprintNumericExpression(session, { kind: 'parameter', parameter: forged }),
    ).toThrowError(expect.objectContaining({ code: 'CP1001', path: '$.parameter' }));
    expect(() =>
      createBlueprintNumericExpression(foreign, { kind: 'parameter', parameter: number }),
    ).toThrowError(expect.objectContaining({ code: 'CP1001', path: '$.parameter', span: source }));
  });

  test('uses defaults and current-call bindings, rejecting missing, unused, duplicate, and invalid values', () => {
    const session = createBlueprintParameterSession();
    const count = session.number('count', { defaultValue: 4, source });
    const missing = session.number('missing', { source });
    const unused = session.number('unused', { defaultValue: 99, source });
    const foreign = createBlueprintParameterSession().number('foreign', {
      defaultValue: 2,
      source,
    });
    const expression = createBlueprintNumericExpression(session, {
      kind: 'binary',
      operator: 'multiply',
      left: { kind: 'parameter', parameter: count },
      right: { kind: 'literal', value: 3 },
    });

    expect(evaluateBlueprintNumericExpression(session, expression)).toBe(12);
    expect(
      evaluateBlueprintNumericExpression(session, expression, [{ parameter: count, value: 8 }]),
    ).toBe(24);
    expect(
      evaluateBlueprintNumericExpression(session, expression, [{ parameter: count, value: 2 }]),
    ).toBe(6);
    expect(() =>
      evaluateBlueprintNumericExpression(
        session,
        createBlueprintNumericExpression(session, { kind: 'parameter', parameter: missing }),
      ),
    ).toThrowError(expect.objectContaining({ code: 'CP1002', span: source }));
    expect(() =>
      evaluateBlueprintNumericExpression(session, expression, [{ parameter: unused, value: 1 }]),
    ).toThrowError(expect.objectContaining({ code: 'CP1001', span: source }));
    expect(() =>
      evaluateBlueprintNumericExpression(session, expression, [
        { parameter: count, value: 1 },
        { parameter: count, value: 2 },
      ]),
    ).toThrowError(expect.objectContaining({ code: 'CP1001', span: source }));
    expect(() =>
      evaluateBlueprintNumericExpression(session, expression, [{ parameter: foreign, value: 2 }]),
    ).toThrowError(expect.objectContaining({ code: 'CP1001', span: source }));
    expect(() =>
      evaluateBlueprintNumericExpression(session, expression, [
        { parameter: count, value: Number.POSITIVE_INFINITY },
      ]),
    ).toThrowError(expect.objectContaining({ code: 'CP1000', span: source }));
    expect(
      evaluateBlueprintNumericExpression(session, expression, [{ parameter: count, value: 3 }]),
    ).toBe(9);
    expect(() =>
      evaluateBlueprintNumericExpression(session, expression, [
        { parameter: session.signal('signal binding', { source }), value: 1 },
      ]),
    ).toThrowError(expect.objectContaining({ code: 'CP1001', span: source }));
  });

  test('rejects malformed, cyclic, accessor-bearing, and over-budget AST input transactionally', () => {
    const session = createBlueprintParameterSession();
    const cyclic: { kind: string; operand?: unknown } = { kind: 'negate' };
    cyclic.operand = cyclic;
    const accessor = Object.defineProperty({ kind: 'literal' }, 'value', {
      enumerable: true,
      get: () => 3,
    });
    const partial = { kind: 'literal', value: 6 };

    expect(() => createBlueprintNumericExpression(session, cyclic)).toThrowError(
      expect.objectContaining({ code: 'CP1000', message: expect.stringContaining('cyclic') }),
    );
    expect(() => createBlueprintNumericExpression(session, accessor)).toThrowError(
      expect.objectContaining({ code: 'CP1000', path: '$.value' }),
    );
    expect(() =>
      createBlueprintNumericExpression(session, { kind: 'literal', value: 1, extra: true }),
    ).toThrowError(expect.objectContaining({ code: 'CP1000', path: '$.extra' }));
    expect(() =>
      createBlueprintNumericExpression(session, {
        kind: 'binary',
        operator: 'modulo',
        left: partial,
        right: { kind: 'literal', value: 2 },
      }),
    ).toThrowError(expect.objectContaining({ code: 'CP1000', path: '$.operator' }));
    expect(() =>
      createBlueprintNumericExpression(session, {
        kind: 'binary',
        operator: 'add',
        left: partial,
        right: { kind: 'literal', value: Number.POSITIVE_INFINITY },
      }),
    ).toThrowError(expect.objectContaining({ code: 'CP1000', path: '$.right.value' }));

    const expression = createBlueprintNumericExpression(session, partial);
    expect(evaluateBlueprintNumericExpression(session, expression)).toBe(6);
  });

  test('enforces depth, node, and UTF-8 byte budgets', () => {
    const session = createBlueprintParameterSession();
    let deep: unknown = { kind: 'literal', value: 1 };
    for (let depth = 0; depth <= constantConfigurationLimits.maxDepth; depth += 1) {
      deep = { kind: 'negate', operand: deep };
    }
    expect(() => createBlueprintNumericExpression(session, deep)).toThrowError(
      expect.objectContaining({ code: 'CP1000', message: expect.stringContaining('depth limit') }),
    );

    let sharedDeep: unknown = { kind: 'literal', value: 1 };
    for (let depth = 0; depth < constantConfigurationLimits.maxDepth - 1; depth += 1) {
      sharedDeep = { kind: 'negate', operand: sharedDeep };
    }
    expect(() =>
      createBlueprintNumericExpression(session, {
        kind: 'binary',
        operator: 'add',
        left: sharedDeep,
        right: { kind: 'negate', operand: { kind: 'negate', operand: sharedDeep } },
      }),
    ).toThrowError(
      expect.objectContaining({ code: 'CP1000', message: expect.stringContaining('depth limit') }),
    );

    const makeBalanced = (depth: number): unknown =>
      depth === 0
        ? { kind: 'literal', value: 1 }
        : {
            kind: 'binary',
            operator: 'add',
            left: makeBalanced(depth - 1),
            right: makeBalanced(depth - 1),
          };
    expect(() => createBlueprintNumericExpression(session, makeBalanced(12))).toThrowError(
      expect.objectContaining({ code: 'CP1000', message: expect.stringContaining('node limit') }),
    );

    const longLabel = session.number('x'.repeat(constantConfigurationLimits.maxBytes + 1));
    expect(() =>
      createBlueprintNumericExpression(session, { kind: 'parameter', parameter: longLabel }),
    ).toThrowError(
      expect.objectContaining({ code: 'CP1000', message: expect.stringContaining('byte limit') }),
    );
  });

  test('preserves negative zero and rejects non-finite literals and arithmetic results', () => {
    const session = createBlueprintParameterSession();
    const negativeZero = createBlueprintNumericExpression(session, {
      kind: 'negate',
      operand: { kind: 'literal', value: 0 },
    });
    const negativeZeroLiteral = createBlueprintNumericExpression(session, {
      kind: 'literal',
      value: -0,
    });
    const overflow = createBlueprintNumericExpression(session, {
      kind: 'binary',
      operator: 'multiply',
      left: { kind: 'literal', value: Number.MAX_VALUE },
      right: { kind: 'literal', value: Number.MAX_VALUE },
    });

    expect(Object.is(evaluateBlueprintNumericExpression(session, negativeZero), -0)).toBe(true);
    expect(Object.is(evaluateBlueprintNumericExpression(session, negativeZeroLiteral), -0)).toBe(
      true,
    );
    expect(() =>
      createBlueprintNumericExpression(session, { kind: 'literal', value: NaN }),
    ).toThrowError(expect.objectContaining({ code: 'CP1000', path: '$.value' }));
    expect(() => evaluateBlueprintNumericExpression(session, overflow)).toThrowError(
      expect.objectContaining({ code: 'CP1000', message: expect.stringContaining('finite') }),
    );
  });

  test('remains session-owned after sealing and cannot enter concrete numeric configuration', () => {
    const session = createBlueprintParameterSession();
    const amount = session.number('amount', { defaultValue: 3 });
    const expression = createBlueprintNumericExpression(session, {
      kind: 'binary',
      operator: 'add',
      left: { kind: 'parameter', parameter: amount },
      right: { kind: 'literal', value: 2 },
    });
    sealBlueprintParameterSession(session, '$.session');

    expect(evaluateBlueprintNumericExpression(session, expression)).toBe(5);
    expect(() =>
      createBlueprintNumericExpression(session, { kind: 'literal', value: 1 }),
    ).toThrowError(
      expect.objectContaining({ code: 'CP1001', message: expect.stringContaining('sealed') }),
    );
    expect(() =>
      session.number('invalid default', { defaultValue: expression as never }),
    ).toThrowError(expect.objectContaining({ code: 'CP1000' }));
    expect(() =>
      assertBlueprintParameterNumberValue(expression, '$.producer.config.value', 'finite'),
    ).toThrowError(expect.objectContaining({ code: 'CP1000', path: '$.producer.config.value' }));
    expect(() =>
      canonicalizeConstantConfiguration({
        isOn: true,
        sections: [
          {
            active: true,
            multiplier: 1,
            filters: [{ signal: signal('virtual', 'signal-A'), value: expression as never }],
          },
        ],
      }),
    ).toThrow();
  });

  test('rejects an expression registered by another parameter session', () => {
    const owner = createBlueprintParameterSession();
    const other = createBlueprintParameterSession();
    const expression = createBlueprintNumericExpression(owner, {
      kind: 'literal',
      value: 4,
    });

    expect(() => evaluateBlueprintNumericExpression(other, expression)).toThrowError(
      expect.objectContaining({ code: 'CP1001', path: '$.expression' }),
    );
    expect(() => inspectBlueprintNumericExpression(other, expression, '$.expression')).toThrowError(
      expect.objectContaining({ code: 'CP1001', path: '$.expression' }),
    );
    expect(() =>
      evaluateBlueprintNumericExpression(owner, { kind: 'literal', value: 4 } as never),
    ).toThrowError(expect.objectContaining({ code: 'CP1001', path: '$.expression' }));
    expect(() =>
      inspectBlueprintNumericExpression(owner, { kind: 'literal', value: 4 }, '$.expression'),
    ).toThrowError(expect.objectContaining({ code: 'CP1001', path: '$.expression' }));
    expect(() =>
      createBlueprintNumericExpression(other, {
        kind: 'negate',
        operand: expression,
      }),
    ).toThrowError(expect.objectContaining({ code: 'CP1001', path: '$.operand' }));
  });
});

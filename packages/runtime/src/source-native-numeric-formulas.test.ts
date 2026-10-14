import { describe, expect, test } from 'vitest';
import type { BlueprintNumericExpression } from '../../compiler/src/blueprint-numeric-expression.js';
import { createBlueprintNumericExpression } from '../../compiler/src/blueprint-numeric-expression.js';
import {
  BlueprintParameterError,
  createBlueprintParameterSession,
  type BlueprintNumberParameterHandle,
} from '../../compiler/src/blueprint-parameters.js';
import { createNativeNumericFormulaRenderer } from './source-native-numeric-formulas.js';

function setup(defaults: readonly { readonly name: string; readonly value: number }[] = []) {
  const session = createBlueprintParameterSession();
  const variables = new Map<BlueprintNumberParameterHandle, string>();
  const handles = new Map<string, BlueprintNumberParameterHandle>();
  for (const { name, value } of defaults) {
    const parameter = session.number(name, { defaultValue: value, metadata: { variable: name } });
    variables.set(parameter, name);
    handles.set(name, parameter);
  }
  const renderer = createNativeNumericFormulaRenderer(session, (parameter) =>
    variables.get(parameter),
  );
  return { session, handles, renderer };
}

function parameter(parameter: BlueprintNumberParameterHandle) {
  return { kind: 'parameter' as const, parameter };
}

function literal(value: number) {
  return { kind: 'literal' as const, value };
}

function binary(
  operator: 'add' | 'subtract' | 'multiply' | 'divide' | 'power',
  left: unknown,
  right: unknown,
) {
  return { kind: 'binary' as const, operator, left, right };
}

function call(functionName: 'abs' | 'log2' | 'sign' | 'min' | 'max', ...argumentsValue: unknown[]) {
  return { kind: 'call' as const, function: functionName, arguments: argumentsValue };
}

function render(renderer: ReturnType<typeof createNativeNumericFormulaRenderer>, root: unknown) {
  const measured = renderer.measure(root, '$.count');
  return { measured, text: renderer.renderUnique([measured]).get(measured.key) };
}

describe('private native numeric formula renderer', () => {
  test('preserves operator tree and deterministically renders every supported operator', () => {
    const { session, handles, renderer } = setup([
      { name: 'x', value: 5 },
      { name: 'y', value: 4 },
    ]);
    const root = createBlueprintNumericExpression(session, {
      kind: 'negate',
      operand: binary(
        'subtract',
        binary('add', parameter(handles.get('x')!), literal(2)),
        binary('multiply', parameter(handles.get('y')!), literal(3)),
      ),
    });
    const result = render(renderer, root);
    expect(result.text).toBe('(-((x + 2) - (y * 3)))');
    expect(result.measured.defaultValue).toBe(5);
  });

  test('renders division with measured parentheses and distinct canonical identity', () => {
    const { session, handles, renderer } = setup([{ name: 'x', value: 10 }]);
    const halfPlusThree = createBlueprintNumericExpression(
      session,
      binary('add', binary('divide', parameter(handles.get('x')!), literal(2)), literal(3)),
    );
    const divideFirst = createBlueprintNumericExpression(
      session,
      binary('divide', parameter(handles.get('x')!), binary('add', literal(2), literal(3))),
    );
    const parameterOnRight = createBlueprintNumericExpression(
      session,
      binary('divide', literal(20), parameter(handles.get('x')!)),
    );
    const measured = [
      renderer.measure(halfPlusThree, '$.first'),
      renderer.measure(divideFirst, '$.second'),
      renderer.measure(parameterOnRight, '$.third'),
    ];
    const formulas = renderer.renderUnique(measured);

    expect(formulas.get(measured[0]!.key)).toBe('((x / 2) + 3)');
    expect(formulas.get(measured[1]!.key)).toBe('(x / (2 + 3))');
    expect(measured[0]!.renderedBytes).toBe('((x / 2) + 3)'.length);
    expect(measured[1]!.renderedBytes).toBe('(x / (2 + 3))'.length);
    expect(measured[0]!.defaultValue).toBe(8);
    expect(measured[1]!.defaultValue).toBe(2);
    expect(formulas.get(measured[2]!.key)).toBe('(20 / x)');
    expect(measured[2]!.defaultValue).toBe(2);

    const multiply = renderer.measure(
      createBlueprintNumericExpression(
        session,
        binary('multiply', parameter(handles.get('x')!), literal(2)),
      ),
      '$.multiply',
    );
    expect(multiply.key).not.toBe(measured[0]!.key);
    expect(renderer.renderUnique([multiply]).get(multiply.key)).toBe('(x * 2)');

    const sameOperands = (['multiply', 'divide', 'power'] as const).map((operator) =>
      renderer.measure(
        createBlueprintNumericExpression(
          session,
          binary(operator, parameter(handles.get('x')!), literal(1)),
        ),
        '$.sameOperands',
      ),
    );
    expect(sameOperands.map(({ defaultValue }) => defaultValue)).toEqual([10, 10, 10]);
    expect(new Set(sameOperands.map(({ key }) => key)).size).toBe(3);
    expect([...renderer.renderUnique(sameOperands).values()]).toEqual([
      '(x * 1)',
      '(x / 1)',
      '((x) ^ (1))',
    ]);
  });

  test('renders power with explicit operands, source grouping, and measured expansion', () => {
    const { session, handles, renderer } = setup([
      { name: 'x', value: 3 },
      { name: 'y', value: 2 },
    ]);
    const x = parameter(handles.get('x')!);
    const power = (left: unknown, right: unknown) => binary('power', left, right);
    const cases = [
      [power(x, literal(2)), '((x) ^ (2))', 9],
      [power(literal(2), x), '((2) ^ (x))', 8],
      [power(literal(-2), x), '((-2) ^ (x))', -8],
      [power({ kind: 'negate', operand: x }, literal(2)), '(((-x)) ^ (2))', 9],
      [{ kind: 'negate', operand: power(x, literal(2)) }, '(-((x) ^ (2)))', -9],
      [power(power(x, literal(2)), literal(2)), '((((x) ^ (2))) ^ (2))', 81],
      [power(x, power(literal(2), literal(3))), '((x) ^ (((2) ^ (3))))', 6561],
    ] as const;
    const measured = cases.map(([expression]) =>
      renderer.measure(createBlueprintNumericExpression(session, expression), '$.power'),
    );
    const formulas = renderer.renderUnique(measured);

    for (const [index, [, expected, defaultValue]] of cases.entries()) {
      expect(formulas.get(measured[index]!.key)).toBe(expected);
      expect(measured[index]!.renderedBytes).toBe(expected.length);
      expect(measured[index]!.defaultValue).toBe(defaultValue);
    }
  });

  test('renders host numeric functions with exact syntax, byte counts, and canonical identity', () => {
    const { session, handles, renderer } = setup([
      { name: 'x', value: 4 },
      { name: 'y', value: 4 },
    ]);
    const cases = [
      [call('abs', literal(-4)), 'abs(-4)', 4],
      [call('log2', literal(8)), 'log2(8)', 3],
      [call('sign', literal(-0)), 'sign(0)', 0],
      [call('min', literal(4), literal(2), literal(3)), 'min(4, 2, 3)', 2],
      [call('max', literal(4), literal(2), literal(3)), 'max(4, 2, 3)', 4],
      [call('max', literal(1.5), literal(2)), 'max(1.5, 2)', 2],
      [
        call(
          'max',
          call('abs', parameter(handles.get('x')!)),
          call('min', literal(2), call('log2', literal(8))),
        ),
        'max(abs(x), min(2, log2(8)))',
        4,
      ],
    ] as const;
    const measured = cases.map(([expression]) =>
      renderer.measure(createBlueprintNumericExpression(session, expression), '$.call'),
    );
    const formulas = renderer.renderUnique(measured);
    for (const [index, [, expected, defaultValue]] of cases.entries()) {
      expect(formulas.get(measured[index]!.key)).toBe(expected);
      expect(measured[index]!.renderedBytes).toBe(new TextEncoder().encode(expected).byteLength);
      expect(measured[index]!.defaultValue).toBe(defaultValue);
    }

    const variants = [
      call('min', parameter(handles.get('x')!), parameter(handles.get('y')!)),
      call('max', parameter(handles.get('x')!), parameter(handles.get('y')!)),
      call('max', parameter(handles.get('y')!), parameter(handles.get('x')!)),
    ].map((expression) =>
      renderer.measure(createBlueprintNumericExpression(session, expression), '$.canonical'),
    );
    expect(variants.map(({ defaultValue }) => defaultValue)).toEqual([4, 4, 4]);
    expect(new Set(variants.map(({ key }) => key)).size).toBe(3);
    expect([...renderer.renderUnique(variants).values()]).toEqual([
      'min(x, y)',
      'max(x, y)',
      'max(y, x)',
    ]);
    expect(() =>
      renderer.measure(
        createBlueprintNumericExpression(session, call('abs', literal(1.5))),
        '$.fractionalDefault',
      ),
    ).toThrowError(
      expect.objectContaining({
        code: 'CP1002',
        message: expect.stringContaining('signed int32 integers'),
      }),
    );
    expect(() =>
      renderer.measure(
        createBlueprintNumericExpression(session, call('max', literal(2147483648), literal(1))),
        '$.outOfInt32Default',
      ),
    ).toThrowError(
      expect.objectContaining({
        code: 'CP1002',
        message: expect.stringContaining('signed int32 integers'),
      }),
    );
  });

  test('preflights expanded shared multi-argument calls and aggregate formula bytes', () => {
    const { session, renderer } = setup();
    let shared: unknown = call('min', literal(1), literal(2));
    for (let index = 0; index < 15; index += 1) shared = call('max', shared, shared);
    expect(() =>
      renderer.measure(createBlueprintNumericExpression(session, shared), '$.expandedTooLarge'),
    ).toThrowError(expect.objectContaining({ code: 'CP1002', path: '$.expandedTooLarge' }));

    shared = call('min', literal(1), literal(2));
    for (let index = 0; index < 13; index += 1) shared = call('max', shared, shared);
    const first = renderer.measure(
      createBlueprintNumericExpression(session, shared),
      '$.firstShared',
    );
    const second = renderer.measure(
      createBlueprintNumericExpression(session, call('min', shared, shared)),
      '$.secondShared',
    );
    expect(first.renderedBytes).toBeLessThan(262144);
    expect(second.renderedBytes).toBeLessThan(262144);
    expect(() => renderer.renderUnique([first, second])).toThrowError(
      expect.objectContaining({ code: 'CP1002', path: '$.secondShared' }),
    );
  });

  test('renders finite decimal and scientific literals with exact bounded text', () => {
    const { session, renderer } = setup();
    const cases = [
      [binary('add', literal(0.5), literal(1.5)), '(0.5 + 1.5)', 2],
      [binary('subtract', literal(1.5), literal(0.5)), '(1.5 - 0.5)', 1],
      [binary('multiply', literal(-0.5), literal(2)), '(-0.5 * 2)', -1],
      [binary('divide', literal(1), literal(0.5)), '(1 / 0.5)', 2],
      [
        binary('add', binary('power', literal(-0.5), literal(2)), literal(0.75)),
        '(((-0.5) ^ (2)) + 0.75)',
        1,
      ],
      [binary('add', { kind: 'negate', operand: literal(0.5) }, literal(1.5)), '((-0.5) + 1.5)', 1],
      [
        binary('subtract', literal(2147483648), literal(2147483647)),
        '(2147483648 - 2147483647)',
        1,
      ],
      [
        binary('add', binary('subtract', literal(1e21), literal(1e21)), literal(1)),
        '((1e21 - 1e21) + 1)',
        1,
      ],
      [
        binary(
          'add',
          binary('subtract', literal(Number.MIN_VALUE), literal(Number.MIN_VALUE)),
          literal(1),
        ),
        '((5e-324 - 5e-324) + 1)',
        1,
      ],
      [
        binary(
          'add',
          binary('subtract', literal(0.30000000000000004), literal(0.30000000000000004)),
          literal(1),
        ),
        '((0.30000000000000004 - 0.30000000000000004) + 1)',
        1,
      ],
    ] as const;
    const measured = cases.map(([expression]) =>
      renderer.measure(createBlueprintNumericExpression(session, expression), '$.literal'),
    );
    const formulas = renderer.renderUnique(measured);

    for (const [index, [, expected, defaultValue]] of cases.entries()) {
      expect(formulas.get(measured[index]!.key)).toBe(expected);
      expect(measured[index]!.renderedBytes).toBe(expected.length);
      expect(measured[index]!.defaultValue).toBe(defaultValue);
      expect([...expected].every((character) => character.charCodeAt(0) < 128)).toBe(true);
    }
  });

  test('normalizes negative zero and keeps distinct finite literals canonical', () => {
    const { session, renderer } = setup();
    const negativeZero = renderer.measure(
      createBlueprintNumericExpression(session, binary('add', literal(-0), literal(1))),
      '$.negativeZero',
    );
    const positiveZero = renderer.measure(
      createBlueprintNumericExpression(session, binary('add', literal(0), literal(1))),
      '$.positiveZero',
    );
    expect(negativeZero.key).toBe(positiveZero.key);
    expect([...renderer.renderUnique([negativeZero, positiveZero]).values()]).toEqual(['(0 + 1)']);

    const first = renderer.measure(
      createBlueprintNumericExpression(
        session,
        binary('subtract', literal(2147483648), literal(2147483647)),
      ),
      '$.first',
    );
    const second = renderer.measure(
      createBlueprintNumericExpression(
        session,
        binary('subtract', literal(2147483649), literal(2147483648)),
      ),
      '$.second',
    );
    expect(first.defaultValue).toBe(second.defaultValue);
    expect(first.key).not.toBe(second.key);
    expect([...renderer.renderUnique([first, second]).values()]).toEqual([
      '(2147483648 - 2147483647)',
      '(2147483649 - 2147483648)',
    ]);
  });

  test('rejects forged roots and invalid final defaults with located CP1002', () => {
    const { session, handles, renderer } = setup([{ name: 'x', value: 5 }]);
    const forged = { kind: 'literal', value: 1 } as BlueprintNumericExpression;
    let forgedError: unknown;
    try {
      renderer.measure(forged, '$.constantTemplates[0].sections[0].filters[0].value');
    } catch (error) {
      forgedError = error;
    }
    expect(forgedError).toBeInstanceOf(BlueprintParameterError);
    expect(forgedError).toMatchObject({
      code: 'CP1002',
      path: '$.constantTemplates[0].sections[0].filters[0].value',
    });
    const invalidLiteral = createBlueprintNumericExpression(
      session,
      binary('add', parameter(handles.get('x')!), literal(2147483648)),
    );
    expect(() => renderer.measure(invalidLiteral, '$.invalidLiteral')).toThrow(
      expect.objectContaining({ code: 'CP1002', path: '$.invalidLiteral' }),
    );
    const fractionalDefault = createBlueprintNumericExpression(
      session,
      binary('divide', parameter(handles.get('x')!), literal(2)),
    );
    expect(() => renderer.measure(fractionalDefault, '$.fractionalDefault')).toThrow(
      expect.objectContaining({
        code: 'CP1002',
        path: '$.fractionalDefault',
        message: expect.stringContaining('signed int32 integers'),
      }),
    );
  });

  test('rejects a registered root owned by a foreign parameter session', () => {
    const { renderer } = setup([{ name: 'x', value: 5 }]);
    const foreignSession = createBlueprintParameterSession();
    const foreignParameter = foreignSession.number('Foreign', { defaultValue: 5 });
    const foreignRoot = createBlueprintNumericExpression(foreignSession, {
      kind: 'parameter',
      parameter: foreignParameter,
    });
    expect(() => renderer.measure(foreignRoot, '$.foreign')).toThrow(
      expect.objectContaining({ code: 'CP1002', path: '$.foreign' }),
    );
  });

  test.each(['multiply', 'power'] as const)(
    'bounds shared %s expansion and aggregate unique text bytes',
    (operator) => {
      const { session, renderer } = setup([{ name: 'x', value: 0 }]);
      let shared: unknown = binary('subtract', literal(1.5), literal(0.5));
      for (let index = 0; index < 16; index += 1) shared = binary(operator, shared, shared);
      const overRootLimit = createBlueprintNumericExpression(session, shared);
      expect(() => renderer.measure(overRootLimit, '$.tooLarge')).toThrow(
        expect.objectContaining({ code: 'CP1002', path: '$.tooLarge' }),
      );

      shared = binary('subtract', literal(1.5), literal(0.5));
      const sharedDepth = operator === 'power' ? 12 : 13;
      for (let index = 0; index < sharedDepth; index += 1)
        shared = binary(operator, shared, shared);
      const first = createBlueprintNumericExpression(session, binary(operator, shared, shared));
      const second = createBlueprintNumericExpression(session, binary('add', shared, shared));
      const measured = [renderer.measure(first, '$.first'), renderer.measure(second, '$.second')];
      expect(measured[0]!.renderedBytes).toBeLessThan(262144);
      expect(measured[1]!.renderedBytes).toBeLessThan(262144);
      expect(() => renderer.renderUnique(measured)).toThrow(
        expect.objectContaining({ code: 'CP1002', path: '$.second' }),
      );
    },
  );
});

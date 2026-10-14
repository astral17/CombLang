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
  operator: 'add' | 'subtract' | 'multiply' | 'divide',
  left: unknown,
  right: unknown,
) {
  return { kind: 'binary' as const, operator, left, right };
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

    const sameOperands = (['multiply', 'divide'] as const).map((operator) =>
      renderer.measure(
        createBlueprintNumericExpression(
          session,
          binary(operator, parameter(handles.get('x')!), literal(1)),
        ),
        '$.sameOperands',
      ),
    );
    expect(sameOperands.map(({ defaultValue }) => defaultValue)).toEqual([10, 10]);
    expect(sameOperands[0]!.key).not.toBe(sameOperands[1]!.key);
    expect([...renderer.renderUnique(sameOperands).values()]).toEqual(['(x * 1)', '(x / 1)']);
  });

  test('rejects forged roots and non-int32 literals with located CP1002', () => {
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

  test('measures shared expression expansion before rendering and enforces aggregate unique text bytes', () => {
    const { session, handles, renderer } = setup([{ name: 'x', value: 0 }]);
    let shared: unknown = parameter(handles.get('x')!);
    for (let index = 0; index < 16; index += 1) shared = binary('multiply', shared, shared);
    const overRootLimit = createBlueprintNumericExpression(session, shared);
    expect(() => renderer.measure(overRootLimit, '$.tooLarge')).toThrow(
      expect.objectContaining({ code: 'CP1002', path: '$.tooLarge' }),
    );

    shared = parameter(handles.get('x')!);
    for (let index = 0; index < 14; index += 1) shared = binary('multiply', shared, shared);
    const first = createBlueprintNumericExpression(session, binary('multiply', shared, shared));
    const second = createBlueprintNumericExpression(session, binary('add', shared, shared));
    const measured = [renderer.measure(first, '$.first'), renderer.measure(second, '$.second')];
    expect(measured[0]!.renderedBytes).toBeLessThan(262144);
    expect(measured[1]!.renderedBytes).toBeLessThan(262144);
    expect(() => renderer.renderUnique(measured)).toThrow(
      expect.objectContaining({ code: 'CP1002', path: '$.second' }),
    );
  });
});

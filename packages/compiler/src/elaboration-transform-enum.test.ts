import ts from 'typescript';
import { describe, expect, test, vi } from 'vitest';

import { lowerEnumDeclaration } from './elaboration-transform-enum.js';

function parsedEnum(text: string): { sourceFile: ts.SourceFile; declaration: ts.EnumDeclaration } {
  const sourceFile = ts.createSourceFile(
    'enum.factorio.ts',
    text,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const declaration = sourceFile.statements.find(ts.isEnumDeclaration);
  if (declaration === undefined) throw new Error('Test source requires an enum declaration.');
  return { sourceFile, declaration };
}

function lower(
  text: string,
  transformExpression: (expression: ts.Expression) => ts.Expression = (expression) => expression,
): string {
  const { sourceFile, declaration } = parsedEnum(text);
  const lowered = lowerEnumDeclaration(declaration, {
    factory: ts.factory,
    sourceFile,
    transformExpression,
  });
  return ts.createPrinter().printNode(ts.EmitHint.Unspecified, lowered, sourceFile);
}

function evaluate<T>(code: string, name: string): T {
  return Function(`"use strict"; ${code}; return ${name};`)() as T;
}

describe('elaboration enum lowering', () => {
  test('preserves numeric progression through local and qualified constant references', () => {
    const code = lower(
      'enum Direction { North = 1 << 2, East, South = -2, West, Again = North + East, After = Direction.Again + 1, Final }',
    );
    const value = evaluate<Record<string, number>>(code, 'Direction');

    expect(value).toEqual({
      North: 4,
      East: 5,
      South: -2,
      West: -1,
      Again: 9,
      After: 10,
      Final: 11,
    });
    expect(Object.isFrozen(value)).toBe(true);
  });

  test('transforms a dynamic initializer and resumes after an explicit numeric reset', () => {
    const transformExpression = vi.fn(() => ts.factory.createNumericLiteral(7));
    const code = lower('enum Dynamic { First = source(), Reset = 10, Next }', transformExpression);

    expect(evaluate(code, 'Dynamic')).toEqual({ First: 7, Reset: 10, Next: 11 });
    expect(transformExpression).toHaveBeenCalledOnce();
  });

  test('requires an explicit member after a dynamic initializer', () => {
    expect(() => lower('enum Dynamic { First = source(), Missing }')).toThrow(
      'Enum Dynamic.Missing requires an explicit initializer',
    );
  });
});

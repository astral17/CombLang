import ts from 'typescript';

import { evaluateNumericConstantExpression } from '@comblang/language';

export interface EnumLoweringContext {
  readonly factory: ts.NodeFactory;
  readonly sourceFile: ts.SourceFile;
  transformExpression(expression: ts.Expression): ts.Expression;
}

function numericLiteral(factory: ts.NodeFactory, value: number): ts.Expression {
  return value < 0 || Object.is(value, -0)
    ? factory.createPrefixUnaryExpression(
        ts.SyntaxKind.MinusToken,
        factory.createNumericLiteral(Math.abs(value)),
      )
    : factory.createNumericLiteral(value);
}

/** Lowers one TypeScript-like enum into the immutable runtime object supported by elaboration. */
export function lowerEnumDeclaration(
  node: ts.EnumDeclaration,
  context: EnumLoweringContext,
): ts.VariableStatement {
  const { factory, sourceFile } = context;
  const memberValues = new Map<string, number>();
  let nextNumericValue: number | undefined = 0;
  const properties = node.members.map((member) => {
    const name =
      ts.isIdentifier(member.name) || ts.isStringLiteral(member.name)
        ? member.name.text
        : member.name.getText(sourceFile);
    let value: ts.Expression;
    if (member.initializer === undefined) {
      if (nextNumericValue === undefined) {
        throw new Error(
          `Enum ${node.name.text}.${name} requires an explicit initializer because the previous value is not a supported numeric constant.`,
        );
      }
      value = numericLiteral(factory, nextNumericValue);
      memberValues.set(name, nextNumericValue);
      nextNumericValue += 1;
    } else {
      const evaluated = evaluateNumericConstantExpression(member.initializer, (reference) => {
        if (ts.isIdentifier(reference)) return memberValues.get(reference.text);
        return ts.isIdentifier(reference.expression) && reference.expression.text === node.name.text
          ? memberValues.get(reference.name.text)
          : undefined;
      });
      if (evaluated === undefined || !Number.isFinite(evaluated)) {
        value = context.transformExpression(member.initializer);
        nextNumericValue = undefined;
      } else {
        value = numericLiteral(factory, evaluated);
        memberValues.set(name, evaluated);
        nextNumericValue = evaluated + 1;
      }
    }
    return factory.createPropertyAssignment(factory.createStringLiteral(name), value);
  });
  return factory.createVariableStatement(
    undefined,
    factory.createVariableDeclarationList(
      [
        factory.createVariableDeclaration(
          node.name,
          undefined,
          undefined,
          factory.createCallExpression(
            factory.createPropertyAccessExpression(factory.createIdentifier('Object'), 'freeze'),
            undefined,
            [factory.createObjectLiteralExpression(properties, true)],
          ),
        ),
      ],
      ts.NodeFlags.Const,
    ),
  );
}

import ts from 'typescript';

export type NumericConstantReference = ts.Identifier | ts.PropertyAccessExpression;

/** Evaluates the side-effect-free numeric subset used by TypeScript enum constants. */
export function evaluateNumericConstantExpression(
  node: ts.Expression,
  resolveReference: (reference: NumericConstantReference) => number | undefined = () => undefined,
): number | undefined {
  if (ts.isParenthesizedExpression(node)) {
    return evaluateNumericConstantExpression(node.expression, resolveReference);
  }
  if (ts.isNumericLiteral(node)) return Number(node.text);
  if (ts.isIdentifier(node) || ts.isPropertyAccessExpression(node)) {
    return resolveReference(node);
  }
  if (ts.isPrefixUnaryExpression(node)) {
    const operand = evaluateNumericConstantExpression(node.operand, resolveReference);
    if (operand === undefined) return undefined;
    switch (node.operator) {
      case ts.SyntaxKind.PlusToken:
        return operand;
      case ts.SyntaxKind.MinusToken:
        return -operand;
      case ts.SyntaxKind.TildeToken:
        return ~operand;
      default:
        return undefined;
    }
  }
  if (!ts.isBinaryExpression(node)) return undefined;
  const left = evaluateNumericConstantExpression(node.left, resolveReference);
  const right = evaluateNumericConstantExpression(node.right, resolveReference);
  if (left === undefined || right === undefined) return undefined;
  switch (node.operatorToken.kind) {
    case ts.SyntaxKind.PlusToken:
      return left + right;
    case ts.SyntaxKind.MinusToken:
      return left - right;
    case ts.SyntaxKind.AsteriskToken:
      return left * right;
    case ts.SyntaxKind.SlashToken:
      return left / right;
    case ts.SyntaxKind.PercentToken:
      return left % right;
    case ts.SyntaxKind.AsteriskAsteriskToken:
      return left ** right;
    case ts.SyntaxKind.LessThanLessThanToken:
      return left << right;
    case ts.SyntaxKind.GreaterThanGreaterThanToken:
      return left >> right;
    case ts.SyntaxKind.GreaterThanGreaterThanGreaterThanToken:
      return left >>> right;
    case ts.SyntaxKind.AmpersandToken:
      return left & right;
    case ts.SyntaxKind.BarToken:
      return left | right;
    case ts.SyntaxKind.CaretToken:
      return left ^ right;
    default:
      return undefined;
  }
}

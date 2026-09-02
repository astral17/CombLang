import ts from 'typescript';

import type { ParsedSourceFile } from './parser.js';

/** Resolve lexical bindings only: this deliberately performs no TypeScript assignability checking. */
export function createFunctionResolver(
  file: ParsedSourceFile,
): (identifier: ts.Identifier) => ts.FunctionDeclaration | undefined {
  const program = ts.createProgram({
    rootNames: [file.ast.fileName],
    options: { noLib: true, noResolve: true, alwaysStrict: true, target: ts.ScriptTarget.ESNext },
    host: {
      getSourceFile: () => file.ast,
      getDefaultLibFileName: () => '',
      writeFile: () => undefined,
      getCurrentDirectory: () => '/',
      getCanonicalFileName: (name) => name,
      useCaseSensitiveFileNames: () => true,
      getNewLine: () => '\n',
      fileExists: () => false,
      readFile: () => undefined,
    },
  });
  const checker = program.getTypeChecker();
  const reassigned = new Set<ts.Symbol>();
  const recordTarget = (node: ts.Node): void => {
    if (ts.isIdentifier(node)) {
      const symbol = checker.getSymbolAtLocation(node);
      if (symbol !== undefined) reassigned.add(symbol);
    } else if (ts.isArrayLiteralExpression(node)) {
      node.elements.forEach(recordTarget);
    } else if (ts.isObjectLiteralExpression(node)) {
      for (const property of node.properties) {
        if (ts.isShorthandPropertyAssignment(property)) {
          const symbol = checker.getShorthandAssignmentValueSymbol(property);
          if (symbol !== undefined) reassigned.add(symbol);
        } else if (ts.isPropertyAssignment(property)) recordTarget(property.initializer);
        else if (ts.isSpreadAssignment(property)) recordTarget(property.expression);
      }
    } else if (ts.isParenthesizedExpression(node) || ts.isSpreadElement(node)) {
      recordTarget(node.expression);
    } else if (ts.isBinaryExpression(node)) {
      recordTarget(node.left);
    }
  };
  const visit = (node: ts.Node): void => {
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
      node.operatorToken.kind <= ts.SyntaxKind.LastAssignment
    ) {
      recordTarget(node.left);
    } else if (
      (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) &&
      (node.operator === ts.SyntaxKind.PlusPlusToken ||
        node.operator === ts.SyntaxKind.MinusMinusToken)
    ) {
      recordTarget(node.operand);
    } else if (ts.isForInStatement(node) || ts.isForOfStatement(node)) {
      if (!ts.isVariableDeclarationList(node.initializer)) recordTarget(node.initializer);
    }
    node.forEachChild(visit);
  };
  visit(file.ast);
  return (identifier) => {
    const symbol = checker.getSymbolAtLocation(identifier);
    if (symbol === undefined || reassigned.has(symbol)) return undefined;
    const declaration = symbol.valueDeclaration;
    return declaration !== undefined &&
      ts.isFunctionDeclaration(declaration) &&
      declaration.body !== undefined
      ? declaration
      : undefined;
  };
}

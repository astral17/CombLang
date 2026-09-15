import ts from 'typescript';

import {
  entityFamilyDslNames,
  wildcardDslNames,
  type EntityFamilyDslName,
} from '@comblang/language';

export interface CallTransformContext {
  readonly factory: ts.NodeFactory;
  readonly visit: ts.Visitor;
  dslCall(name: string, arguments_: readonly ts.Expression[]): ts.Expression;
  spanLiteral(node: ts.Node): ts.ObjectLiteralExpression;
  transformTestInstantiation(node: ts.CallExpression): ts.Expression | undefined;
}

function isWriteTarget(node: ts.ElementAccessExpression): boolean {
  const parent = node.parent;
  if (ts.isBinaryExpression(parent) && parent.left === node) {
    return (
      parent.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
      parent.operatorToken.kind <= ts.SyntaxKind.LastAssignment
    );
  }
  if (
    (ts.isPrefixUnaryExpression(parent) || ts.isPostfixUnaryExpression(parent)) &&
    (parent.operator === ts.SyntaxKind.PlusPlusToken ||
      parent.operator === ts.SyntaxKind.MinusMinusToken)
  ) {
    return true;
  }
  return ts.isDeleteExpression(parent);
}

/** Rewrites the call/member family while preserving JavaScript evaluation order. */
export function transformCallOrElementNode(
  node: ts.Node,
  context: CallTransformContext,
): ts.Node | undefined {
  const { factory, visit } = context;
  const callArguments = (args: readonly ts.Expression[]): ts.ArrayLiteralExpression =>
    factory.createArrayLiteralExpression(
      args.map((argument) =>
        ts.isSpreadElement(argument)
          ? factory.createSpreadElement(
              context.dslCall('spreadCallArguments', [
                ts.visitNode(argument.expression, visit) as ts.Expression,
                context.spanLiteral(argument),
              ]),
            )
          : factory.createObjectLiteralExpression([
              factory.createPropertyAssignment(
                'value',
                ts.visitNode(argument, visit) as ts.Expression,
              ),
              factory.createPropertyAssignment('source', context.spanLiteral(argument)),
            ]),
      ),
    );

  // Preserve native nullish short-circuiting, including delayed key/argument evaluation.
  if (ts.isCallChain(node)) {
    return factory.updateCallChain(
      node,
      ts.visitNode(node.expression, visit) as ts.Expression,
      node.questionDotToken,
      node.typeArguments,
      node.arguments.map((argument) => ts.visitNode(argument, visit) as ts.Expression),
    );
  }
  if (ts.isElementAccessChain(node)) {
    return factory.updateElementAccessChain(
      node,
      ts.visitNode(node.expression, visit) as ts.Expression,
      node.questionDotToken,
      ts.visitNode(node.argumentExpression, visit) as ts.Expression,
    );
  }
  if (ts.isPropertyAccessChain(node)) {
    return factory.updatePropertyAccessChain(
      node,
      ts.visitNode(node.expression, visit) as ts.Expression,
      node.questionDotToken,
      node.name,
    );
  }

  if (
    ts.isCallExpression(node) &&
    node.questionDotToken === undefined &&
    ts.isIdentifier(node.expression)
  ) {
    const wildcard = wildcardDslNames[node.expression.text as keyof typeof wildcardDslNames];
    if (wildcard !== undefined && node.arguments.length === 1) {
      return context.dslCall('wildcard', [
        factory.createStringLiteral(wildcard),
        ts.visitNode(node.arguments[0]!, visit) as ts.Expression,
        context.spanLiteral(node),
      ]);
    }
    const mapped = {
      Signal: 'signal',
      CC: 'constant',
      when: 'deciderStart',
      to: 'destinations',
      pair: 'pair',
      join: 'join',
    }[node.expression.text];
    if (node.expression.text === 'Entity') {
      return context.dslCall('entityFromPrototype', [
        callArguments(node.arguments),
        context.spanLiteral(node),
      ]);
    }
    // Constant has two public overload families. Keep the statically certain
    // string/prototype-plus-configuration form on the existing Entity bridge;
    // all other forms retain their evaluated arguments for runtime dispatch.
    if (
      node.expression.text === 'Constant' &&
      (node.arguments.length === 2 ||
        (node.arguments.length === 1 && ts.isStringLiteral(node.arguments[0]!)))
    ) {
      return context.dslCall('entityFamilyFromPrototype', [
        factory.createStringLiteral(node.expression.text),
        callArguments(node.arguments),
        context.spanLiteral(node),
      ]);
    }
    if (node.expression.text === 'Constant') {
      return context.dslCall('constantOverload', [
        callArguments(node.arguments),
        context.spanLiteral(node),
      ]);
    }
    if (node.expression.text === 'Arithmetic') {
      return context.dslCall('arithmeticOverload', [
        callArguments(node.arguments),
        context.spanLiteral(node),
      ]);
    }
    const entityFamily = Object.prototype.hasOwnProperty.call(
      entityFamilyDslNames,
      node.expression.text,
    )
      ? entityFamilyDslNames[node.expression.text as EntityFamilyDslName]
      : undefined;
    if (entityFamily !== undefined) {
      return context.dslCall('entityFamilyFromPrototype', [
        factory.createStringLiteral(node.expression.text),
        callArguments(node.arguments),
        context.spanLiteral(node),
      ]);
    }
    if (node.expression.text === 'NativeCondition') {
      return context.dslCall('nativeCondition', [
        callArguments(node.arguments),
        context.spanLiteral(node),
      ]);
    }
    if (node.expression.text === 'IF' && node.arguments.length >= 2) {
      return context.dslCall('deciderBranches', [
        ts.visitNode(node.arguments[0]!, visit) as ts.Expression,
        ts.visitNode(node.arguments[1]!, visit) as ts.Expression,
        node.arguments[2] === undefined
          ? factory.createVoidZero()
          : (ts.visitNode(node.arguments[2], visit) as ts.Expression),
        context.spanLiteral(node),
      ]);
    }
    if (mapped !== undefined) {
      return context.dslCall(mapped, [
        ...node.arguments.map((argument) => ts.visitNode(argument, visit) as ts.Expression),
        context.spanLiteral(node),
      ]);
    }
    // Direct eval must keep its lexical environment.
    if (node.expression.text !== 'eval') {
      return context.dslCall('invoke', [
        node.expression,
        callArguments(node.arguments),
        context.spanLiteral(node),
      ]);
    }
  }

  if (ts.isCallExpression(node)) {
    const instantiated = context.transformTestInstantiation(node);
    if (instantiated !== undefined) return instantiated;
  }

  if (
    ts.isCallExpression(node) &&
    node.questionDotToken === undefined &&
    (ts.isPropertyAccessExpression(node.expression) ||
      ts.isElementAccessExpression(node.expression)) &&
    node.expression.expression.kind !== ts.SyntaxKind.SuperKeyword &&
    !(
      ts.isPropertyAccessExpression(node.expression) && ts.isPrivateIdentifier(node.expression.name)
    )
  ) {
    return context.dslCall('invokePrepared', [
      context.dslCall('prepareMember', [
        ts.visitNode(node.expression.expression, visit) as ts.Expression,
        ts.isPropertyAccessExpression(node.expression)
          ? factory.createStringLiteral(node.expression.name.text)
          : (ts.visitNode(node.expression.argumentExpression, visit) as ts.Expression),
        context.spanLiteral(node),
      ]),
      callArguments(node.arguments),
      context.spanLiteral(node),
    ]);
  }

  // Calls whose callee is computed or itself returned from a call need the same
  // runtime boundary as identifier calls. This is what lets a nominal Entity
  // handle receive DSL call meaning without making it a JavaScript function.
  if (
    ts.isCallExpression(node) &&
    node.questionDotToken === undefined &&
    node.expression.kind !== ts.SyntaxKind.SuperKeyword &&
    !(ts.isIdentifier(node.expression) && node.expression.text === 'eval')
  ) {
    return context.dslCall('invoke', [
      ts.visitNode(node.expression, visit) as ts.Expression,
      callArguments(node.arguments),
      context.spanLiteral(node),
    ]);
  }

  if (
    ts.isElementAccessExpression(node) &&
    node.questionDotToken === undefined &&
    !isWriteTarget(node)
  ) {
    return context.dslCall('element', [
      ts.visitNode(node.expression, visit) as ts.Expression,
      ts.visitNode(node.argumentExpression, visit) as ts.Expression,
      context.spanLiteral(node),
    ]);
  }

  return undefined;
}

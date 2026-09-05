import ts from 'typescript';

export interface ControlFlowTransformContext {
  readonly factory: ts.NodeFactory;
  readonly visit: ts.Visitor;
  dslCall(name: string, arguments_: readonly ts.Expression[]): ts.Expression;
  spanLiteral(node: ts.Node): ts.ObjectLiteralExpression;
}

function controlTest(
  expression: ts.Expression,
  context: ControlFlowTransformContext,
): ts.Expression {
  return context.dslCall('controlTest', [
    ts.visitNode(expression, context.visit) as ts.Expression,
    context.spanLiteral(expression),
  ]);
}

function loopBinding(
  initializer: ts.ForInitializer,
  factory: ts.NodeFactory,
): { readonly name: string; readonly value: ts.Expression } {
  const declaration = ts.isVariableDeclarationList(initializer)
    ? initializer.declarations[0]
    : undefined;
  const identifier =
    declaration !== undefined && ts.isIdentifier(declaration.name)
      ? declaration.name
      : ts.isIdentifier(initializer)
        ? initializer
        : undefined;
  return {
    name: identifier?.text ?? 'iteration',
    value: identifier ?? factory.createVoidZero(),
  };
}

function instrumentLoopBody(
  statement: ts.Statement,
  name: string,
  value: ts.Expression,
  source: ts.IterationStatement,
  context: ControlFlowTransformContext,
): ts.Block {
  const { factory, visit } = context;
  const originalStatements = ts.isBlock(statement) ? statement.statements : [statement];
  return factory.createBlock(
    [
      factory.createExpressionStatement(
        context.dslCall('enterLoop', [
          factory.createStringLiteral(name),
          value,
          context.spanLiteral(source),
        ]),
      ),
      factory.createTryStatement(
        factory.createBlock(
          originalStatements.map((child) => ts.visitNode(child, visit) as ts.Statement),
          true,
        ),
        undefined,
        factory.createBlock(
          [
            factory.createExpressionStatement(
              context.dslCall('exitInstance', [context.spanLiteral(source)]),
            ),
          ],
          true,
        ),
      ),
    ],
    true,
  );
}

/** Rewrites one control-flow node, or returns undefined when the family does not own it. */
export function transformControlFlowNode(
  node: ts.Node,
  context: ControlFlowTransformContext,
): ts.Node | undefined {
  const { factory, visit } = context;
  if (ts.isIfStatement(node)) {
    return factory.updateIfStatement(
      node,
      controlTest(node.expression, context),
      ts.visitNode(node.thenStatement, visit) as ts.Statement,
      node.elseStatement === undefined
        ? undefined
        : (ts.visitNode(node.elseStatement, visit) as ts.Statement),
    );
  }
  if (ts.isConditionalExpression(node)) {
    return factory.updateConditionalExpression(
      node,
      controlTest(node.condition, context),
      node.questionToken,
      ts.visitNode(node.whenTrue, visit) as ts.Expression,
      node.colonToken,
      ts.visitNode(node.whenFalse, visit) as ts.Expression,
    );
  }
  if (ts.isForStatement(node)) {
    const declaration =
      node.initializer !== undefined && ts.isVariableDeclarationList(node.initializer)
        ? node.initializer.declarations[0]
        : undefined;
    const indexName =
      declaration !== undefined && ts.isIdentifier(declaration.name)
        ? declaration.name.text
        : undefined;
    const body = instrumentLoopBody(
      node.statement,
      indexName ?? 'iteration',
      indexName === undefined ? factory.createVoidZero() : factory.createIdentifier(indexName),
      node,
      context,
    );
    return factory.updateForStatement(
      node,
      node.initializer === undefined
        ? undefined
        : (ts.visitNode(node.initializer, visit) as ts.ForInitializer),
      node.condition === undefined ? undefined : controlTest(node.condition, context),
      node.incrementor === undefined
        ? undefined
        : (ts.visitNode(node.incrementor, visit) as ts.Expression),
      body,
    );
  }
  if (ts.isForOfStatement(node) || ts.isForInStatement(node)) {
    const binding = loopBinding(node.initializer, factory);
    const initializer = ts.visitNode(node.initializer, visit) as ts.ForInitializer;
    const expression = ts.visitNode(node.expression, visit) as ts.Expression;
    const body = instrumentLoopBody(node.statement, binding.name, binding.value, node, context);
    return ts.isForOfStatement(node)
      ? factory.updateForOfStatement(node, node.awaitModifier, initializer, expression, body)
      : factory.updateForInStatement(node, initializer, expression, body);
  }
  if (ts.isWhileStatement(node)) {
    return factory.updateWhileStatement(
      node,
      controlTest(node.expression, context),
      instrumentLoopBody(node.statement, 'while', factory.createVoidZero(), node, context),
    );
  }
  if (ts.isDoStatement(node)) {
    return factory.updateDoStatement(
      node,
      instrumentLoopBody(node.statement, 'do', factory.createVoidZero(), node, context),
      controlTest(node.expression, context),
    );
  }
  return undefined;
}

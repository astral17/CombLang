import ts from 'typescript';

import { wildcardDslNames, type ParsedSourceFile } from '@comblang/language';

import { analyzeElaborationTransform } from './elaboration-transform-analysis.js';
import {
  createElaborationBindingTransform,
  type ElaborationBindingTransform,
} from './elaboration-transform-bindings.js';
import { transformControlFlowNode } from './elaboration-transform-control-flow.js';
import { lowerEnumDeclaration } from './elaboration-transform-enum.js';
import { transformFunctionBoundaryNode } from './elaboration-transform-functions.js';
import { printErasedTypeScript } from './typescript-erase.js';

export interface ElaborationJavaScript {
  readonly format: 'comblang-elaboration-js';
  readonly version: 2;
  readonly fileId: ParsedSourceFile['id'];
  readonly runtimeParameter: string;
  readonly containsUnsupportedAsync: boolean;
  readonly code: string;
}

const runtimeCall = (
  factory: ts.NodeFactory,
  runtimeParameter: string,
  name: string,
  args: readonly ts.Expression[],
) =>
  factory.createCallExpression(
    factory.createPropertyAccessExpression(factory.createIdentifier(runtimeParameter), name),
    undefined,
    args,
  );

function spanLiteral(factory: ts.NodeFactory, node: ts.Node): ts.ObjectLiteralExpression {
  return factory.createObjectLiteralExpression([
    factory.createPropertyAssignment('start', factory.createNumericLiteral(node.getStart())),
    factory.createPropertyAssignment('end', factory.createNumericLiteral(node.getEnd())),
  ]);
}

/**
 * First executable-transform slice. Ordinary JavaScript control flow is deliberately
 * left to the JS engine; only DSL-sensitive nodes are replaced with allowlisted calls.
 */
export interface ElaborationTransformOptions {
  /** Enables the test-only `context.instantiate(fn, ...args)` capture primitive. */
  readonly testContextName?: string;
}

export function transformElaborationModule(
  file: ParsedSourceFile,
  options: ElaborationTransformOptions = {},
): ElaborationJavaScript {
  const {
    runtimeParameter,
    containsUnsupportedAsync,
    signalNames,
    networkNames,
    producerTypeForAssignment,
  } = analyzeElaborationTransform(file);
  const dslCall = (factory: ts.NodeFactory, name: string, args: readonly ts.Expression[]) =>
    runtimeCall(factory, runtimeParameter, name, args);

  const transformer: ts.TransformerFactory<ts.SourceFile> = (context) => {
    const { factory } = context;
    const isNonReferenceIdentifier = (node: ts.Identifier): boolean => {
      const parent = node.parent;
      for (
        let ancestor: ts.Node | undefined = parent;
        ancestor !== undefined;
        ancestor = ancestor.parent
      ) {
        if (ts.isTypeNode(ancestor)) return true;
        if (ts.isExpression(ancestor) || ts.isStatement(ancestor) || ts.isSourceFile(ancestor))
          break;
      }
      return (
        (ts.isPropertyAccessExpression(parent) && parent.name === node) ||
        (ts.isPropertyAssignment(parent) && parent.name === node) ||
        ((ts.isPropertySignature(parent) || ts.isMethodSignature(parent)) &&
          parent.name === node) ||
        (ts.isBindingElement(parent) && (parent.name === node || parent.propertyName === node)) ||
        ((ts.isVariableDeclaration(parent) || ts.isParameter(parent)) && parent.name === node) ||
        ((ts.isFunctionDeclaration(parent) ||
          ts.isFunctionExpression(parent) ||
          ts.isClassDeclaration(parent) ||
          ts.isClassExpression(parent) ||
          ts.isInterfaceDeclaration(parent) ||
          ts.isTypeAliasDeclaration(parent) ||
          ts.isTypeParameterDeclaration(parent) ||
          ts.isMethodDeclaration(parent) ||
          ts.isPropertyDeclaration(parent) ||
          ts.isGetAccessorDeclaration(parent) ||
          ts.isSetAccessorDeclaration(parent) ||
          ts.isEnumDeclaration(parent) ||
          ts.isEnumMember(parent)) &&
          parent.name === node) ||
        (ts.isLabeledStatement(parent) && parent.label === node) ||
        ((ts.isBreakStatement(parent) || ts.isContinueStatement(parent)) && parent.label === node)
      );
    };
    const isWriteTarget = (node: ts.ElementAccessExpression): boolean => {
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
    };
    const callArguments = (args: readonly ts.Expression[]): ts.ArrayLiteralExpression =>
      factory.createArrayLiteralExpression(
        args.map((argument) =>
          ts.isSpreadElement(argument)
            ? factory.createSpreadElement(
                dslCall(factory, 'spreadCallArguments', [
                  ts.visitNode(argument.expression, visit) as ts.Expression,
                  spanLiteral(factory, argument),
                ]),
              )
            : factory.createObjectLiteralExpression([
                factory.createPropertyAssignment(
                  'value',
                  ts.visitNode(argument, visit) as ts.Expression,
                ),
                factory.createPropertyAssignment('source', spanLiteral(factory, argument)),
              ]),
        ),
      );
    let bindingTransform: ElaborationBindingTransform;
    const visit: ts.Visitor = (node) => {
      // The optional operation itself remains native JavaScript, while descendants still need
      // DSL transformation. Chain-specific updaters preserve TypeScript's internal chain flags
      // and keep transformed keys and arguments behind the native nullish short-circuit.
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
      if (ts.isEnumDeclaration(node)) {
        return lowerEnumDeclaration(node, {
          factory,
          sourceFile: file.ast,
          transformExpression: (expression) => ts.visitNode(expression, visit) as ts.Expression,
        });
      }
      if (ts.isParameter(node)) return bindingTransform.transformParameter(node);

      if (ts.isExpressionStatement(node)) {
        return factory.updateExpressionStatement(
          node,
          ts.visitNode(node.expression, visit) as ts.Expression,
        );
      }

      const functionBoundary = transformFunctionBoundaryNode(node, {
        factory,
        file,
        visit,
        dslCall: (name, arguments_) => dslCall(factory, name, arguments_),
        spanLiteral: (source) => spanLiteral(factory, source),
        transformParameter: bindingTransform.transformParameter,
      });
      if (functionBoundary !== undefined) return functionBoundary;

      const controlFlow = transformControlFlowNode(node, {
        factory,
        visit,
        dslCall: (name, arguments_) => dslCall(factory, name, arguments_),
        spanLiteral: (source) => spanLiteral(factory, source),
      });
      if (controlFlow !== undefined) return controlFlow;

      if (
        ts.isShorthandPropertyAssignment(node) &&
        wildcardDslNames[node.name.text as keyof typeof wildcardDslNames] !== undefined
      ) {
        return factory.createPropertyAssignment(
          node.name,
          dslCall(factory, 'wildcardToken', [
            factory.createStringLiteral(
              wildcardDslNames[node.name.text as keyof typeof wildcardDslNames],
            ),
          ]),
        );
      }
      if (
        ts.isIdentifier(node) &&
        wildcardDslNames[node.text as keyof typeof wildcardDslNames] !== undefined &&
        !isNonReferenceIdentifier(node)
      ) {
        return dslCall(factory, 'wildcardToken', [
          factory.createStringLiteral(wildcardDslNames[node.text as keyof typeof wildcardDslNames]),
        ]);
      }
      if (ts.isShorthandPropertyAssignment(node) && node.name.text === 'prototypes') {
        return factory.createPropertyAssignment(
          node.name,
          dslCall(factory, 'prototypeEnvironment', [spanLiteral(factory, node.name)]),
        );
      }
      if (ts.isIdentifier(node) && node.text === 'prototypes' && !isNonReferenceIdentifier(node)) {
        return dslCall(factory, 'prototypeEnvironment', [spanLiteral(factory, node)]);
      }
      if (ts.isVariableDeclaration(node)) {
        return bindingTransform.transformVariableDeclaration(node);
      }

      if (
        ts.isNewExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === 'Network'
      ) {
        return bindingTransform.transformNetworkConstruction(node);
      }

      if (
        ts.isCallExpression(node) &&
        node.questionDotToken === undefined &&
        ts.isIdentifier(node.expression)
      ) {
        const wildcard = wildcardDslNames[node.expression.text as keyof typeof wildcardDslNames];
        if (wildcard !== undefined && node.arguments.length === 1) {
          return dslCall(factory, 'wildcard', [
            factory.createStringLiteral(wildcard),
            ts.visitNode(node.arguments[0]!, visit) as ts.Expression,
            spanLiteral(factory, node),
          ]);
        }
        const mapped = {
          Signal: 'signal',
          CC: 'constant',
          to: 'destinations',
          pair: 'pair',
        }[node.expression.text];
        if (node.expression.text === 'IF' && node.arguments.length >= 2) {
          return dslCall(factory, 'deciderBranches', [
            ts.visitNode(node.arguments[0]!, visit) as ts.Expression,
            ts.visitNode(node.arguments[1]!, visit) as ts.Expression,
            node.arguments[2] === undefined
              ? factory.createVoidZero()
              : (ts.visitNode(node.arguments[2], visit) as ts.Expression),
            spanLiteral(factory, node),
          ]);
        }
        if (mapped !== undefined) {
          return dslCall(factory, mapped, [
            ...node.arguments.map((argument) => ts.visitNode(argument, visit) as ts.Expression),
            spanLiteral(factory, node),
          ]);
        }
        // Keep direct eval native: wrapping it would change its lexical environment.
        if (node.expression.text !== 'eval') {
          return dslCall(factory, 'invoke', [
            node.expression,
            callArguments(node.arguments),
            spanLiteral(factory, node),
          ]);
        }
      }

      if (ts.isCallExpression(node)) {
        const instantiated = bindingTransform.transformTestInstantiation(node);
        if (instantiated !== undefined) return instantiated;
      }

      if (
        ts.isCallExpression(node) &&
        node.questionDotToken === undefined &&
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.questionDotToken === undefined
      ) {
        const method = node.expression.name.text;
        const receiver = node.expression.expression;
        if (
          method === 'else' &&
          ts.isCallExpression(receiver) &&
          ts.isPropertyAccessExpression(receiver.expression) &&
          receiver.expression.name.text === 'then' &&
          ts.isCallExpression(receiver.expression.expression) &&
          ts.isIdentifier(receiver.expression.expression.expression) &&
          receiver.expression.expression.expression.text === 'when' &&
          receiver.expression.expression.arguments.length === 1 &&
          node.arguments.length >= 1
        ) {
          const whenCall = receiver.expression.expression;
          return dslCall(factory, 'deciderBranches', [
            ts.visitNode(whenCall.arguments[0]!, visit) as ts.Expression,
            factory.createArrayLiteralExpression(
              receiver.arguments.map((argument) => ts.visitNode(argument, visit) as ts.Expression),
            ),
            factory.createArrayLiteralExpression(
              node.arguments.map((argument) => ts.visitNode(argument, visit) as ts.Expression),
            ),
            spanLiteral(factory, node),
          ]);
        }
        if (
          (method === 'then' || method === 'else') &&
          ts.isCallExpression(receiver) &&
          ts.isIdentifier(receiver.expression) &&
          receiver.expression.text === 'when' &&
          receiver.arguments.length === 1 &&
          node.arguments.length >= 1
        ) {
          return dslCall(factory, 'deciderBranches', [
            ts.visitNode(receiver.arguments[0]!, visit) as ts.Expression,
            method === 'then'
              ? factory.createArrayLiteralExpression(
                  node.arguments.map((argument) => ts.visitNode(argument, visit) as ts.Expression),
                )
              : factory.createVoidZero(),
            method === 'else'
              ? factory.createArrayLiteralExpression(
                  node.arguments.map((argument) => ts.visitNode(argument, visit) as ts.Expression),
                )
              : factory.createVoidZero(),
            spanLiteral(factory, node),
          ]);
        }
      }

      if (
        ts.isCallExpression(node) &&
        node.questionDotToken === undefined &&
        (ts.isPropertyAccessExpression(node.expression) ||
          ts.isElementAccessExpression(node.expression)) &&
        node.expression.expression.kind !== ts.SyntaxKind.SuperKeyword &&
        !(
          ts.isPropertyAccessExpression(node.expression) &&
          ts.isPrivateIdentifier(node.expression.name)
        )
      ) {
        return dslCall(factory, 'invokePrepared', [
          dslCall(factory, 'prepareMember', [
            ts.visitNode(node.expression.expression, visit) as ts.Expression,
            ts.isPropertyAccessExpression(node.expression)
              ? factory.createStringLiteral(node.expression.name.text)
              : (ts.visitNode(node.expression.argumentExpression, visit) as ts.Expression),
            spanLiteral(factory, node),
          ]),
          callArguments(node.arguments),
          spanLiteral(factory, node),
        ]);
      }

      if (
        ts.isElementAccessExpression(node) &&
        node.questionDotToken === undefined &&
        !isWriteTarget(node)
      ) {
        return dslCall(factory, 'element', [
          ts.visitNode(node.expression, visit) as ts.Expression,
          ts.visitNode(node.argumentExpression, visit) as ts.Expression,
          spanLiteral(factory, node),
        ]);
      }

      if (ts.isBinaryExpression(node)) {
        if (node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
          const producerType = producerTypeForAssignment(node.left, node);
          if (producerType !== undefined) {
            return factory.updateBinaryExpression(
              node,
              ts.visitNode(node.left, visit) as ts.Expression,
              node.operatorToken,
              dslCall(factory, 'producerHandle', [
                ts.visitNode(node.right, visit) as ts.Expression,
                factory.createStringLiteral(producerType),
                factory.createStringLiteral(node.left.getText(file.ast)),
                spanLiteral(factory, node.right),
              ]),
            );
          }
        }
        if (
          node.operatorToken.kind === ts.SyntaxKind.PlusEqualsToken &&
          ts.isElementAccessExpression(node.left) &&
          ts.isCallExpression(node.left.expression) &&
          ts.isIdentifier(node.left.expression.expression) &&
          node.left.expression.expression.text === 'to'
        ) {
          return dslCall(factory, 'attach', [
            dslCall(factory, 'select', [
              ts.visitNode(node.left.expression, visit) as ts.Expression,
              ts.visitNode(node.left.argumentExpression, visit) as ts.Expression,
              spanLiteral(factory, node.left),
            ]),
            ts.visitNode(node.right, visit) as ts.Expression,
            spanLiteral(factory, node),
          ]);
        }
        if (
          node.operatorToken.kind === ts.SyntaxKind.PlusEqualsToken &&
          ts.isCallExpression(node.left) &&
          ts.isIdentifier(node.left.expression) &&
          node.left.expression.text === 'to'
        ) {
          return dslCall(factory, 'attach', [
            ts.visitNode(node.left, visit) as ts.Expression,
            ts.visitNode(node.right, visit) as ts.Expression,
            spanLiteral(factory, node),
          ]);
        }
        if (node.operatorToken.kind === ts.SyntaxKind.PlusEqualsToken) {
          const add = (current: ts.Expression, assign: ts.Expression) =>
            dslCall(factory, 'addAssign', [
              current,
              ts.visitNode(node.right, visit) as ts.Expression,
              assign,
              spanLiteral(factory, node),
            ]);
          if (ts.isIdentifier(node.left)) {
            const value = factory.createUniqueName('_value');
            return add(
              node.left,
              factory.createArrowFunction(
                undefined,
                undefined,
                [factory.createParameterDeclaration(undefined, undefined, value)],
                undefined,
                factory.createToken(ts.SyntaxKind.EqualsGreaterThanToken),
                factory.createAssignment(node.left, value),
              ),
            );
          }
          if (ts.isPropertyAccessExpression(node.left)) {
            const target = factory.createUniqueName('_target');
            const value = factory.createUniqueName('_value');
            const property = factory.createPropertyAccessExpression(target, node.left.name);
            return factory.createCallExpression(
              factory.createParenthesizedExpression(
                factory.createArrowFunction(
                  undefined,
                  undefined,
                  [factory.createParameterDeclaration(undefined, undefined, target)],
                  undefined,
                  factory.createToken(ts.SyntaxKind.EqualsGreaterThanToken),
                  add(
                    property,
                    factory.createArrowFunction(
                      undefined,
                      undefined,
                      [factory.createParameterDeclaration(undefined, undefined, value)],
                      undefined,
                      factory.createToken(ts.SyntaxKind.EqualsGreaterThanToken),
                      factory.createAssignment(property, value),
                    ),
                  ),
                ),
              ),
              undefined,
              [ts.visitNode(node.left.expression, visit) as ts.Expression],
            );
          }
          if (ts.isElementAccessExpression(node.left)) {
            const target = factory.createUniqueName('_target');
            const key = factory.createUniqueName('_key');
            const value = factory.createUniqueName('_value');
            const element = factory.createElementAccessExpression(target, key);
            const current = dslCall(factory, 'element', [
              target,
              key,
              spanLiteral(factory, node.left),
            ]);
            return factory.createCallExpression(
              factory.createParenthesizedExpression(
                factory.createArrowFunction(
                  undefined,
                  undefined,
                  [
                    factory.createParameterDeclaration(undefined, undefined, target),
                    factory.createParameterDeclaration(undefined, undefined, key),
                  ],
                  undefined,
                  factory.createToken(ts.SyntaxKind.EqualsGreaterThanToken),
                  add(
                    current,
                    factory.createArrowFunction(
                      undefined,
                      undefined,
                      [factory.createParameterDeclaration(undefined, undefined, value)],
                      undefined,
                      factory.createToken(ts.SyntaxKind.EqualsGreaterThanToken),
                      factory.createAssignment(element, value),
                    ),
                  ),
                ),
              ),
              undefined,
              [
                ts.visitNode(node.left.expression, visit) as ts.Expression,
                ts.visitNode(node.left.argumentExpression, visit) as ts.Expression,
              ],
            );
          }
        }
        if (
          node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken ||
          node.operatorToken.kind === ts.SyntaxKind.BarBarToken
        ) {
          return dslCall(factory, 'logical', [
            factory.createStringLiteral(
              node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken ? 'and' : 'or',
            ),
            factory.createArrowFunction(
              undefined,
              undefined,
              [],
              undefined,
              factory.createToken(ts.SyntaxKind.EqualsGreaterThanToken),
              ts.visitNode(node.left, visit) as ts.Expression,
            ),
            factory.createArrowFunction(
              undefined,
              undefined,
              [],
              undefined,
              factory.createToken(ts.SyntaxKind.EqualsGreaterThanToken),
              ts.visitNode(node.right, visit) as ts.Expression,
            ),
            spanLiteral(factory, node),
          ]);
        }
        if (
          [
            ts.SyntaxKind.LessThanToken,
            ts.SyntaxKind.LessThanEqualsToken,
            ts.SyntaxKind.GreaterThanToken,
            ts.SyntaxKind.GreaterThanEqualsToken,
            ts.SyntaxKind.EqualsEqualsToken,
            ts.SyntaxKind.EqualsEqualsEqualsToken,
            ts.SyntaxKind.ExclamationEqualsToken,
            ts.SyntaxKind.ExclamationEqualsEqualsToken,
          ].includes(node.operatorToken.kind)
        ) {
          return dslCall(factory, 'compare', [
            factory.createStringLiteral(node.operatorToken.getText(file.ast)),
            ts.visitNode(node.left, visit) as ts.Expression,
            ts.visitNode(node.right, visit) as ts.Expression,
            spanLiteral(factory, node),
          ]);
        }
        const arithmeticOperators = new Set([
          ts.SyntaxKind.PlusToken,
          ts.SyntaxKind.MinusToken,
          ts.SyntaxKind.AsteriskToken,
          ts.SyntaxKind.SlashToken,
          ts.SyntaxKind.PercentToken,
          ts.SyntaxKind.AsteriskAsteriskToken,
          ts.SyntaxKind.LessThanLessThanToken,
          ts.SyntaxKind.GreaterThanGreaterThanToken,
          ts.SyntaxKind.AmpersandToken,
          ts.SyntaxKind.BarToken,
          ts.SyntaxKind.CaretToken,
        ]);
        if (arithmeticOperators.has(node.operatorToken.kind)) {
          return dslCall(factory, 'binary', [
            factory.createStringLiteral(node.operatorToken.getText(file.ast)),
            ts.visitNode(node.left, visit) as ts.Expression,
            ts.visitNode(node.right, visit) as ts.Expression,
            spanLiteral(factory, node),
          ]);
        }
      }
      if (ts.isPrefixUnaryExpression(node) && node.operator === ts.SyntaxKind.ExclamationToken) {
        return dslCall(factory, 'not', [
          ts.visitNode(node.operand, visit) as ts.Expression,
          spanLiteral(factory, node),
        ]);
      }
      return ts.visitEachChild(node, visit, context);
    };
    bindingTransform = createElaborationBindingTransform({
      factory,
      file,
      ...(options.testContextName === undefined
        ? {}
        : { testContextName: options.testContextName }),
      visit,
      dslCall: (name, arguments_) => dslCall(factory, name, arguments_),
      spanLiteral: (source) => spanLiteral(factory, source),
    });
    return (source) => ts.visitNode(source, visit) as ts.SourceFile;
  };

  const compilerOptions: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.None,
  };
  const transformed = ts.transform(file.ast, [transformer], compilerOptions);
  const javaScript = printErasedTypeScript(transformed.transformed[0]!, compilerOptions);
  transformed.dispose();
  return {
    format: 'comblang-elaboration-js',
    version: 2,
    fileId: file.id,
    runtimeParameter,
    containsUnsupportedAsync,
    code: javaScript,
  };
}

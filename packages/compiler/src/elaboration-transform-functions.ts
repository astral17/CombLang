import ts from 'typescript';

import { networkTypeFromAnnotation, type ParsedSourceFile } from '@comblang/language';

import { producerHandleTypeName } from './elaboration-transform-analysis.js';

export interface FunctionBoundaryTransformContext {
  readonly factory: ts.NodeFactory;
  readonly file: ParsedSourceFile;
  readonly visit: ts.Visitor;
  dslCall(name: string, arguments_: readonly ts.Expression[]): ts.Expression;
  spanLiteral(node: ts.Node): ts.ObjectLiteralExpression;
  transformParameter(parameter: ts.ParameterDeclaration): ts.ParameterDeclaration;
}

type TransformableFunction = ts.FunctionDeclaration | ts.FunctionExpression | ts.ArrowFunction;

function enclosingTransformableFunction(node: ts.Node): TransformableFunction | undefined {
  for (let parent = node.parent; parent !== undefined; parent = parent.parent) {
    if (ts.isFunctionLike(parent)) {
      return ts.isFunctionDeclaration(parent) ||
        ts.isFunctionExpression(parent) ||
        ts.isArrowFunction(parent)
        ? parent
        : undefined;
    }
  }
  return undefined;
}

function borrowDescriptorForType(
  type: ts.TypeNode | undefined,
  sourceFile: ts.SourceFile,
):
  | {
      readonly capability: 'readonly' | 'ref' | 'move';
      readonly color?: 'red' | 'green';
    }
  | undefined {
  const syntax = networkTypeFromAnnotation(type, sourceFile);
  if (syntax === undefined || syntax.capability === 'owned') return undefined;
  return {
    capability: syntax.capability,
    ...(syntax.color === undefined ? {} : { color: syntax.color }),
  };
}

function transformReturnStatement(
  node: ts.ReturnStatement,
  owner: TransformableFunction,
  context: FunctionBoundaryTransformContext,
): ts.ReturnStatement {
  const { factory, file, visit } = context;
  const networkReturn = networkTypeFromAnnotation(owner.type, file.ast);
  return factory.updateReturnStatement(
    node,
    networkReturn === undefined
      ? context.dslCall('returnValue', [
          ts.visitNode(node.expression!, visit) as ts.Expression,
          context.spanLiteral(node),
          producerHandleTypeName(file, owner.type) === undefined
            ? factory.createVoidZero()
            : factory.createStringLiteral(producerHandleTypeName(file, owner.type)!),
        ])
      : context.dslCall('returnNetwork', [
          ts.visitNode(node.expression!, visit) as ts.Expression,
          factory.createStringLiteral(networkReturn.capability),
          networkReturn.color === undefined
            ? factory.createVoidZero()
            : factory.createStringLiteral(networkReturn.color),
          context.spanLiteral(node),
        ]),
  );
}

function hasExplicitBoundary(
  owner: TransformableFunction,
  context: FunctionBoundaryTransformContext,
): boolean {
  return (
    ts.isFunctionDeclaration(owner) ||
    networkTypeFromAnnotation(owner.type, context.file.ast) !== undefined ||
    producerHandleTypeName(context.file, owner.type) !== undefined
  );
}

function parameterBinding(
  parameter: ts.ParameterDeclaration,
  index: number,
  context: FunctionBoundaryTransformContext,
): readonly ts.Statement[] {
  if (!ts.isIdentifier(parameter.name)) return [];
  const { factory, file } = context;
  const source = context.dslCall('parameterSource', [
    factory.createNumericLiteral(index),
    context.spanLiteral(parameter),
  ]);
  const producerType = producerHandleTypeName(file, parameter.type);
  if (producerType !== undefined) {
    return [
      factory.createExpressionStatement(
        factory.createAssignment(
          parameter.name,
          context.dslCall('combinatorParameter', [
            parameter.name,
            factory.createStringLiteral(producerType),
            factory.createStringLiteral(parameter.name.text),
            source,
          ]),
        ),
      ),
    ];
  }
  const descriptor = borrowDescriptorForType(parameter.type, file.ast);
  const networkType = networkTypeFromAnnotation(parameter.type, file.ast);
  if (parameter.type === undefined || networkType?.capability === 'owned') {
    return [
      factory.createExpressionStatement(
        factory.createAssignment(
          parameter.name,
          context.dslCall('implicitNetworkParameter', [
            parameter.name,
            factory.createStringLiteral(parameter.name.text),
            networkType?.color === undefined
              ? factory.createVoidZero()
              : factory.createStringLiteral(networkType.color),
            context.spanLiteral(parameter),
            source,
            networkType === undefined ? factory.createFalse() : factory.createTrue(),
          ]),
        ),
      ),
    ];
  }
  if (descriptor === undefined) return [];
  return [
    factory.createExpressionStatement(
      factory.createAssignment(
        parameter.name,
        descriptor.capability === 'move'
          ? context.dslCall('moveParameter', [
              parameter.name,
              factory.createStringLiteral(parameter.name.text),
              descriptor.color === undefined
                ? factory.createVoidZero()
                : factory.createStringLiteral(descriptor.color),
              source,
            ])
          : context.dslCall('borrowParameter', [
              parameter.name,
              factory.createStringLiteral(descriptor.capability),
              factory.createStringLiteral(parameter.name.text),
              descriptor.color === undefined
                ? factory.createVoidZero()
                : factory.createStringLiteral(descriptor.color),
              source,
            ]),
      ),
    ),
  ];
}

function functionNameAndCallable(
  owner: TransformableFunction,
  context: FunctionBoundaryTransformContext,
): readonly [ts.StringLiteral, ts.Expression, ts.Expression?] {
  const named =
    ts.isFunctionDeclaration(owner) || ts.isFunctionExpression(owner) ? owner.name : undefined;
  const name = named?.text ?? '<anonymous>';
  return named === undefined
    ? [context.factory.createStringLiteral(name), context.spanLiteral(owner)]
    : [context.factory.createStringLiteral(name), named, context.spanLiteral(owner)];
}

function returnedExpression(
  expression: ts.Expression,
  source: ts.Node,
  owner: TransformableFunction,
  context: FunctionBoundaryTransformContext,
): ts.Expression {
  const { factory, file } = context;
  const networkReturn = networkTypeFromAnnotation(owner.type, file.ast);
  return networkReturn === undefined
    ? context.dslCall('returnValue', [
        expression,
        context.spanLiteral(source),
        producerHandleTypeName(file, owner.type) === undefined
          ? factory.createVoidZero()
          : factory.createStringLiteral(producerHandleTypeName(file, owner.type)!),
      ])
    : context.dslCall('returnNetwork', [
        expression,
        factory.createStringLiteral(networkReturn.capability),
        networkReturn.color === undefined
          ? factory.createVoidZero()
          : factory.createStringLiteral(networkReturn.color),
        context.spanLiteral(source),
      ]);
}

function transformFunctionBody(
  owner: TransformableFunction,
  body: ts.Block,
  context: FunctionBoundaryTransformContext,
  transformStatements = true,
): ts.Block {
  const { factory, visit } = context;
  const [name, callable, source] = functionNameAndCallable(owner, context);
  const enterArguments = [name, callable, ...(source === undefined ? [] : [source])];
  const parameterBindings = owner.parameters.flatMap((parameter, index) =>
    parameterBinding(parameter, index, context),
  );
  return factory.createBlock(
    [
      factory.createExpressionStatement(context.dslCall('enterFunction', enterArguments)),
      factory.createTryStatement(
        factory.createBlock(
          [
            ...parameterBindings,
            ...(transformStatements
              ? body.statements.map((statement) => ts.visitNode(statement, visit) as ts.Statement)
              : body.statements),
          ],
          true,
        ),
        undefined,
        factory.createBlock(
          [
            factory.createExpressionStatement(
              context.dslCall('exitInstance', [source ?? context.spanLiteral(owner)]),
            ),
          ],
          true,
        ),
      ),
    ],
    true,
  );
}

function transformFunctionDeclaration(
  node: ts.FunctionDeclaration,
  context: FunctionBoundaryTransformContext,
): ts.FunctionDeclaration {
  const { factory } = context;
  const parameters = node.parameters.map(context.transformParameter);
  const body = transformFunctionBody(node, node.body!, context);
  return factory.updateFunctionDeclaration(
    node,
    node.modifiers,
    node.asteriskToken,
    node.name,
    node.typeParameters,
    parameters,
    node.type,
    body,
  );
}

function transformFunctionExpression(
  node: ts.FunctionExpression,
  context: FunctionBoundaryTransformContext,
): ts.FunctionExpression {
  const { factory } = context;
  const parameters = node.parameters.map(context.transformParameter);
  const body = transformFunctionBody(node, node.body as ts.Block, context);
  return factory.updateFunctionExpression(
    node,
    node.modifiers,
    node.asteriskToken,
    node.name,
    node.typeParameters,
    parameters,
    node.type,
    body,
  );
}

function transformArrowFunction(
  node: ts.ArrowFunction,
  context: FunctionBoundaryTransformContext,
): ts.ArrowFunction {
  const { factory, visit } = context;
  const parameters = node.parameters.map(context.transformParameter);
  const body = ts.isBlock(node.body)
    ? transformFunctionBody(node, node.body, context)
    : transformFunctionBody(
        node,
        factory.createBlock(
          [
            factory.createReturnStatement(
              returnedExpression(
                ts.visitNode(node.body, visit) as ts.Expression,
                node.body,
                node,
                context,
              ),
            ),
          ],
          true,
        ),
        context,
        false,
      );
  return factory.updateArrowFunction(
    node,
    node.modifiers,
    node.typeParameters,
    parameters,
    node.type,
    node.equalsGreaterThanToken,
    body,
  );
}

/** Rewrites one function declaration/return boundary, or leaves other nodes to the caller. */
export function transformFunctionBoundaryNode(
  node: ts.Node,
  context: FunctionBoundaryTransformContext,
): ts.Node | undefined {
  if (ts.isReturnStatement(node) && node.expression !== undefined) {
    const owner = enclosingTransformableFunction(node);
    if (owner !== undefined && hasExplicitBoundary(owner, context)) {
      return transformReturnStatement(node, owner, context);
    }
  }
  if (ts.isFunctionDeclaration(node) && node.body !== undefined) {
    return transformFunctionDeclaration(node, context);
  }
  if (ts.isFunctionExpression(node) && node.body !== undefined) {
    return hasExplicitBoundary(node, context)
      ? transformFunctionExpression(node, context)
      : undefined;
  }
  if (ts.isArrowFunction(node)) {
    return hasExplicitBoundary(node, context) ? transformArrowFunction(node, context) : undefined;
  }
  return undefined;
}

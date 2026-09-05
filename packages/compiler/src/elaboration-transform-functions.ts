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

function enclosingFunctionDeclaration(node: ts.Node): ts.FunctionDeclaration | undefined {
  for (let parent = node.parent; parent !== undefined; parent = parent.parent) {
    if (ts.isFunctionLike(parent)) {
      return ts.isFunctionDeclaration(parent) ? parent : undefined;
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
  owner: ts.FunctionDeclaration,
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
          context.dslCall('producerHandle', [
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

function transformFunctionDeclaration(
  node: ts.FunctionDeclaration,
  context: FunctionBoundaryTransformContext,
): ts.FunctionDeclaration {
  const { factory, visit } = context;
  const name = node.name?.text ?? '<anonymous>';
  const parameters = node.parameters.map(context.transformParameter);
  const parameterBindings = node.parameters.flatMap((parameter, index) =>
    parameterBinding(parameter, index, context),
  );
  const body = factory.createBlock(
    [
      factory.createExpressionStatement(
        context.dslCall('enterFunction', [
          factory.createStringLiteral(name),
          node.name ?? factory.createVoidZero(),
          context.spanLiteral(node),
        ]),
      ),
      factory.createTryStatement(
        factory.createBlock(
          [
            ...parameterBindings,
            ...node.body!.statements.map(
              (statement) => ts.visitNode(statement, visit) as ts.Statement,
            ),
          ],
          true,
        ),
        undefined,
        factory.createBlock(
          [
            factory.createExpressionStatement(
              context.dslCall('exitInstance', [context.spanLiteral(node)]),
            ),
          ],
          true,
        ),
      ),
    ],
    true,
  );
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

/** Rewrites one function declaration/return boundary, or leaves other nodes to the caller. */
export function transformFunctionBoundaryNode(
  node: ts.Node,
  context: FunctionBoundaryTransformContext,
): ts.Node | undefined {
  if (ts.isReturnStatement(node) && node.expression !== undefined) {
    const owner = enclosingFunctionDeclaration(node);
    if (owner !== undefined) return transformReturnStatement(node, owner, context);
  }
  if (ts.isFunctionDeclaration(node) && node.body !== undefined) {
    return transformFunctionDeclaration(node, context);
  }
  return undefined;
}

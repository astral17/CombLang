import ts from 'typescript';

import {
  evaluateNumericConstantExpression,
  networkTypeFromAnnotation,
  parseDslTypeText,
  wildcardDslNames,
  type ParsedSourceFile,
} from '@comblang/language';

import {
  analyzeElaborationTransform,
  producerHandleTypeName,
} from './elaboration-transform-analysis.js';
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
    const borrowDescriptorForType = (
      type: ts.TypeNode | undefined,
    ):
      | {
          readonly capability: 'readonly' | 'ref' | 'move';
          readonly color?: 'red' | 'green';
        }
      | undefined => {
      const syntax = networkTypeFromAnnotation(type, file.ast);
      if (syntax === undefined || syntax.capability === 'owned') return undefined;
      return {
        capability: syntax.capability,
        ...(syntax.color === undefined ? {} : { color: syntax.color }),
      };
    };
    const bindingReader = (name: string): ts.Expression =>
      factory.createArrowFunction(
        undefined,
        undefined,
        [],
        undefined,
        factory.createToken(ts.SyntaxKind.EqualsGreaterThanToken),
        factory.createIdentifier(name),
      );
    const networkCall = (node: ts.NewExpression, name?: string): ts.Expression => {
      const type = parseDslTypeText(
        `Network${node.typeArguments?.[0] === undefined ? '' : `<${node.typeArguments[0].getText(file.ast)}>`}`,
      );
      const color = type?.kind === 'network' ? type.color : undefined;
      return dslCall(factory, 'network', [
        name === undefined ? factory.createVoidZero() : factory.createStringLiteral(name),
        color === undefined ? factory.createVoidZero() : factory.createStringLiteral(color),
        spanLiteral(factory, node),
        ...(name === undefined ? [] : [bindingReader(name)]),
      ]);
    };
    const colorForType = (node: ts.TypeNode | undefined): ts.Expression => {
      const color = networkTypeFromAnnotation(node, file.ast)?.color;
      return color === undefined ? factory.createVoidZero() : factory.createStringLiteral(color);
    };
    const enclosingFunctionDeclaration = (node: ts.Node): ts.FunctionDeclaration | undefined => {
      for (let parent = node.parent; parent !== undefined; parent = parent.parent) {
        if (ts.isFunctionLike(parent)) {
          return ts.isFunctionDeclaration(parent) ? parent : undefined;
        }
      }
      return undefined;
    };
    const bindingDescriptor = (
      name: ts.BindingName,
      type: ts.TypeNode | undefined,
      property?: string,
    ): ts.Expression =>
      ts.isIdentifier(name)
        ? factory.createObjectLiteralExpression([
            factory.createPropertyAssignment('name', factory.createStringLiteral(name.text)),
            ...(property === undefined
              ? []
              : [
                  factory.createPropertyAssignment(
                    'property',
                    factory.createStringLiteral(property),
                  ),
                ]),
            factory.createPropertyAssignment('color', colorForType(type)),
            ...(producerHandleTypeName(file, type) === undefined
              ? []
              : [
                  factory.createPropertyAssignment(
                    'producerType',
                    factory.createStringLiteral(producerHandleTypeName(file, type)!),
                  ),
                ]),
          ])
        : factory.createNull();
    const tupleElementType = (
      type: ts.TypeNode | undefined,
      index: number,
    ): ts.TypeNode | undefined => {
      if (!type || !ts.isTupleTypeNode(type)) return undefined;
      const element = type.elements[index];
      return element && ts.isNamedTupleMember(element) ? element.type : element;
    };
    const objectPropertyType = (
      type: ts.TypeNode | undefined,
      property: string,
    ): ts.TypeNode | undefined => {
      if (!type || !ts.isTypeLiteralNode(type)) return undefined;
      const member = type.members.find(
        (candidate): candidate is ts.PropertySignature =>
          ts.isPropertySignature(candidate) && candidate.name.getText(file.ast) === property,
      );
      return member?.type;
    };
    const testInstantiation = (
      node: ts.CallExpression,
      bindingName?: string,
    ): ts.Expression | undefined => {
      if (
        options.testContextName === undefined ||
        node.questionDotToken !== undefined ||
        !ts.isPropertyAccessExpression(node.expression) ||
        node.expression.questionDotToken !== undefined ||
        !ts.isIdentifier(node.expression.expression) ||
        node.expression.expression.text !== options.testContextName ||
        node.expression.name.text !== 'instantiate' ||
        node.arguments.length < 1
      ) {
        return undefined;
      }
      return dslCall(factory, 'instantiate', [
        factory.createStringLiteral(bindingName ?? `instance@${node.getStart(file.ast)}`),
        ...node.arguments.map((argument) => ts.visitNode(argument, visit) as ts.Expression),
        spanLiteral(factory, node),
      ]);
    };
    const transformBindingInitializer = (
      initializer: ts.Expression,
      name: ts.Identifier,
      type: ts.TypeNode | undefined,
      source: ts.Node,
    ): ts.Expression => {
      let transformed: ts.Expression;
      const constructsNetwork =
        ts.isNewExpression(initializer) &&
        ts.isIdentifier(initializer.expression) &&
        initializer.expression.text === 'Network';
      if (constructsNetwork) {
        transformed = networkCall(initializer as ts.NewExpression, name.text);
      } else {
        transformed =
          (ts.isCallExpression(initializer)
            ? testInstantiation(initializer, name.text)
            : undefined) ?? (ts.visitNode(initializer, visit) as ts.Expression);
      }
      const producerType = producerHandleTypeName(file, type);
      if (producerType !== undefined) {
        return dslCall(factory, 'producerHandle', [
          transformed,
          factory.createStringLiteral(producerType),
          factory.createStringLiteral(name.text),
          spanLiteral(factory, source),
        ]);
      }
      return constructsNetwork
        ? transformed
        : dslCall(factory, 'materialize', [
            transformed,
            factory.createStringLiteral(name.text),
            colorForType(type),
            spanLiteral(factory, source),
            bindingReader(name.text),
          ]);
    };
    const transformBindingName = (
      name: ts.BindingName,
      type: ts.TypeNode | undefined,
    ): ts.BindingName => {
      if (ts.isIdentifier(name)) return name;
      const array = ts.isArrayBindingPattern(name);
      const elements = name.elements.map((element, index) => {
        if (ts.isOmittedExpression(element)) return element;
        const property = array
          ? undefined
          : (element.propertyName?.getText(file.ast) ??
            (ts.isIdentifier(element.name) ? element.name.text : undefined));
        const elementType = array
          ? tupleElementType(type, index)
          : property === undefined
            ? undefined
            : objectPropertyType(type, property);
        const bindingName = transformBindingName(element.name, elementType);
        const initializer =
          element.initializer === undefined
            ? undefined
            : ts.isIdentifier(element.name)
              ? transformBindingInitializer(element.initializer, element.name, elementType, element)
              : (ts.visitNode(element.initializer, visit) as ts.Expression);
        return factory.updateBindingElement(
          element,
          element.dotDotDotToken,
          element.propertyName === undefined
            ? undefined
            : (ts.visitNode(element.propertyName, visit) as ts.PropertyName),
          bindingName,
          initializer,
        );
      });
      return array
        ? factory.updateArrayBindingPattern(name, elements)
        : factory.updateObjectBindingPattern(name, elements as readonly ts.BindingElement[]);
    };
    const transformParameter = (parameter: ts.ParameterDeclaration): ts.ParameterDeclaration => {
      const bindingName = transformBindingName(parameter.name, parameter.type);
      const initializer =
        parameter.initializer === undefined
          ? undefined
          : ts.isIdentifier(parameter.name)
            ? transformBindingInitializer(
                parameter.initializer,
                parameter.name,
                parameter.type,
                parameter,
              )
            : (ts.visitNode(parameter.initializer, visit) as ts.Expression);
      return factory.updateParameterDeclaration(
        parameter,
        parameter.modifiers,
        parameter.dotDotDotToken,
        bindingName,
        parameter.questionToken,
        parameter.type,
        initializer,
      );
    };
    const instrumentLoopBody = (
      statement: ts.Statement,
      name: string,
      value: ts.Expression,
      source: ts.IterationStatement,
      visit: ts.Visitor,
    ): ts.Block => {
      const originalStatements = ts.isBlock(statement) ? statement.statements : [statement];
      return factory.createBlock(
        [
          factory.createExpressionStatement(
            dslCall(factory, 'enterLoop', [
              factory.createStringLiteral(name),
              value,
              spanLiteral(factory, source),
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
                  dslCall(factory, 'exitInstance', [spanLiteral(factory, source)]),
                ),
              ],
              true,
            ),
          ),
        ],
        true,
      );
    };
    const loopBinding = (
      initializer: ts.ForInitializer,
    ): { readonly name: string; readonly value: ts.Expression } => {
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
    };
    const controlTest = (expression: ts.Expression, visit: ts.Visitor): ts.Expression =>
      dslCall(factory, 'controlTest', [
        ts.visitNode(expression, visit) as ts.Expression,
        spanLiteral(factory, expression),
      ]);
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
        const memberValues = new Map<string, number>();
        let nextNumericValue: number | undefined = 0;
        const numericLiteral = (value: number): ts.Expression =>
          value < 0 || Object.is(value, -0)
            ? factory.createPrefixUnaryExpression(
                ts.SyntaxKind.MinusToken,
                factory.createNumericLiteral(Math.abs(value)),
              )
            : factory.createNumericLiteral(value);
        const properties = node.members.map((member) => {
          const name =
            ts.isIdentifier(member.name) || ts.isStringLiteral(member.name)
              ? member.name.text
              : member.name.getText(file.ast);
          let value: ts.Expression;
          if (member.initializer === undefined) {
            if (nextNumericValue === undefined) {
              throw new Error(
                `Enum ${node.name.text}.${name} requires an explicit initializer because the previous value is not a supported numeric constant.`,
              );
            }
            value = numericLiteral(nextNumericValue);
            memberValues.set(name, nextNumericValue);
            nextNumericValue += 1;
          } else {
            const evaluated = evaluateNumericConstantExpression(member.initializer, (reference) => {
              if (ts.isIdentifier(reference)) return memberValues.get(reference.text);
              return ts.isIdentifier(reference.expression) &&
                reference.expression.text === node.name.text
                ? memberValues.get(reference.name.text)
                : undefined;
            });
            if (evaluated === undefined || !Number.isFinite(evaluated)) {
              value = ts.visitNode(member.initializer, visit) as ts.Expression;
              nextNumericValue = undefined;
            } else {
              value = numericLiteral(evaluated);
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
                  factory.createPropertyAccessExpression(
                    factory.createIdentifier('Object'),
                    'freeze',
                  ),
                  undefined,
                  [factory.createObjectLiteralExpression(properties, true)],
                ),
              ),
            ],
            ts.NodeFlags.Const,
          ),
        );
      }
      if (ts.isParameter(node)) return transformParameter(node);

      if (ts.isExpressionStatement(node)) {
        return factory.updateExpressionStatement(
          node,
          ts.visitNode(node.expression, visit) as ts.Expression,
        );
      }

      if (
        ts.isReturnStatement(node) &&
        node.expression !== undefined &&
        enclosingFunctionDeclaration(node) !== undefined
      ) {
        const owner = enclosingFunctionDeclaration(node)!;
        const networkReturn = networkTypeFromAnnotation(owner.type, file.ast);
        return factory.updateReturnStatement(
          node,
          networkReturn === undefined
            ? dslCall(factory, 'returnValue', [
                ts.visitNode(node.expression, visit) as ts.Expression,
                spanLiteral(factory, node),
                producerHandleTypeName(file, owner.type) === undefined
                  ? factory.createVoidZero()
                  : factory.createStringLiteral(producerHandleTypeName(file, owner.type)!),
              ])
            : dslCall(factory, 'returnNetwork', [
                ts.visitNode(node.expression, visit) as ts.Expression,
                factory.createStringLiteral(networkReturn.capability),
                networkReturn.color === undefined
                  ? factory.createVoidZero()
                  : factory.createStringLiteral(networkReturn.color),
                spanLiteral(factory, node),
              ]),
        );
      }

      if (ts.isFunctionDeclaration(node) && node.body !== undefined) {
        const name = node.name?.text ?? '<anonymous>';
        const parameters = node.parameters.map(transformParameter);
        const parameterBindings = node.parameters.flatMap((parameter, index) => {
          if (!ts.isIdentifier(parameter.name)) return [];
          const source = dslCall(factory, 'parameterSource', [
            factory.createNumericLiteral(index),
            spanLiteral(factory, parameter),
          ]);
          const producerType = producerHandleTypeName(file, parameter.type);
          if (producerType !== undefined) {
            return [
              factory.createExpressionStatement(
                factory.createAssignment(
                  parameter.name,
                  dslCall(factory, 'producerHandle', [
                    parameter.name,
                    factory.createStringLiteral(producerType),
                    factory.createStringLiteral(parameter.name.text),
                    source,
                  ]),
                ),
              ),
            ];
          }
          const descriptor = borrowDescriptorForType(parameter.type);
          const networkType = networkTypeFromAnnotation(parameter.type, file.ast);
          if (parameter.type === undefined || networkType?.capability === 'owned') {
            return [
              factory.createExpressionStatement(
                factory.createAssignment(
                  parameter.name,
                  dslCall(factory, 'implicitNetworkParameter', [
                    parameter.name,
                    factory.createStringLiteral(parameter.name.text),
                    networkType?.color === undefined
                      ? factory.createVoidZero()
                      : factory.createStringLiteral(networkType.color),
                    spanLiteral(factory, parameter),
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
                  ? dslCall(factory, 'moveParameter', [
                      parameter.name,
                      factory.createStringLiteral(parameter.name.text),
                      descriptor.color === undefined
                        ? factory.createVoidZero()
                        : factory.createStringLiteral(descriptor.color),
                      source,
                    ])
                  : dslCall(factory, 'borrowParameter', [
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
        });
        const body = factory.createBlock(
          [
            factory.createExpressionStatement(
              dslCall(factory, 'enterFunction', [
                factory.createStringLiteral(name),
                node.name ?? factory.createVoidZero(),
                spanLiteral(factory, node),
              ]),
            ),
            factory.createTryStatement(
              factory.createBlock(
                [
                  ...parameterBindings,
                  ...node.body.statements.map(
                    (statement) => ts.visitNode(statement, visit) as ts.Statement,
                  ),
                ],
                true,
              ),
              undefined,
              factory.createBlock(
                [
                  factory.createExpressionStatement(
                    dslCall(factory, 'exitInstance', [spanLiteral(factory, node)]),
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

      if (ts.isIfStatement(node)) {
        return factory.updateIfStatement(
          node,
          controlTest(node.expression, visit),
          ts.visitNode(node.thenStatement, visit) as ts.Statement,
          node.elseStatement === undefined
            ? undefined
            : (ts.visitNode(node.elseStatement, visit) as ts.Statement),
        );
      }

      if (ts.isConditionalExpression(node)) {
        return factory.updateConditionalExpression(
          node,
          controlTest(node.condition, visit),
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
          visit,
        );
        return factory.updateForStatement(
          node,
          node.initializer === undefined
            ? undefined
            : (ts.visitNode(node.initializer, visit) as ts.ForInitializer),
          node.condition === undefined ? undefined : controlTest(node.condition, visit),
          node.incrementor === undefined
            ? undefined
            : (ts.visitNode(node.incrementor, visit) as ts.Expression),
          body,
        );
      }

      if (ts.isForOfStatement(node) || ts.isForInStatement(node)) {
        const binding = loopBinding(node.initializer);
        const initializer = ts.visitNode(node.initializer, visit) as ts.ForInitializer;
        const expression = ts.visitNode(node.expression, visit) as ts.Expression;
        const body = instrumentLoopBody(node.statement, binding.name, binding.value, node, visit);
        return ts.isForOfStatement(node)
          ? factory.updateForOfStatement(node, node.awaitModifier, initializer, expression, body)
          : factory.updateForInStatement(node, initializer, expression, body);
      }

      if (ts.isWhileStatement(node)) {
        return factory.updateWhileStatement(
          node,
          controlTest(node.expression, visit),
          instrumentLoopBody(node.statement, 'while', factory.createVoidZero(), node, visit),
        );
      }

      if (ts.isDoStatement(node)) {
        return factory.updateDoStatement(
          node,
          instrumentLoopBody(node.statement, 'do', factory.createVoidZero(), node, visit),
          controlTest(node.expression, visit),
        );
      }

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
      if (
        ts.isVariableDeclaration(node) &&
        (ts.isArrayBindingPattern(node.name) || ts.isObjectBindingPattern(node.name))
      ) {
        const array = ts.isArrayBindingPattern(node.name);
        const bindingName = transformBindingName(node.name, node.type);
        if (node.initializer === undefined) {
          return factory.updateVariableDeclaration(
            node,
            bindingName,
            undefined,
            node.type,
            undefined,
          );
        }
        const descriptors = node.name.elements.map((element, index) => {
          if (ts.isOmittedExpression(element)) return factory.createNull();
          const property = array
            ? undefined
            : (element.propertyName?.getText(file.ast) ??
              (ts.isIdentifier(element.name) ? element.name.text : undefined));
          return bindingDescriptor(
            element.name,
            array
              ? tupleElementType(node.type, index)
              : property === undefined
                ? undefined
                : objectPropertyType(node.type, property),
            property,
          );
        });
        const initializer = dslCall(factory, array ? 'materializeArray' : 'materializeObject', [
          ts.visitNode(node.initializer, visit) as ts.Expression,
          factory.createArrayLiteralExpression(descriptors),
          spanLiteral(factory, node),
        ]);
        return factory.updateVariableDeclaration(
          node,
          bindingName,
          undefined,
          undefined,
          initializer,
        );
      }
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
        const initializer = transformBindingInitializer(
          node.initializer,
          node.name,
          node.type,
          node,
        );
        return factory.updateVariableDeclaration(
          node,
          node.name,
          undefined,
          undefined,
          initializer,
        );
      }

      if (
        ts.isNewExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === 'Network'
      ) {
        return networkCall(node);
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
        const instantiated = testInstantiation(node);
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

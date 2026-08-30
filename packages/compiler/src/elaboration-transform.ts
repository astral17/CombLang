import ts from 'typescript';

import type { ParsedSourceFile } from '@comblang/language';

export interface ElaborationJavaScript {
  readonly format: 'comblang-elaboration-js';
  readonly version: 1;
  readonly fileId: ParsedSourceFile['id'];
  readonly code: string;
}

const dslCall = (factory: ts.NodeFactory, name: string, args: readonly ts.Expression[]) =>
  factory.createCallExpression(
    factory.createPropertyAccessExpression(factory.createIdentifier('__dsl'), name),
    undefined,
    args,
  );

const wildcardNames: Readonly<Record<string, 'each' | 'anything' | 'everything'>> = {
  Each: 'each',
  EACH: 'each',
  Anything: 'anything',
  Any: 'anything',
  ANYTHING: 'anything',
  ANY: 'anything',
  Everything: 'everything',
  All: 'everything',
  EVERYTHING: 'everything',
  ALL: 'everything',
};

function spanLiteral(factory: ts.NodeFactory, node: ts.Node): ts.ObjectLiteralExpression {
  return factory.createObjectLiteralExpression([
    factory.createPropertyAssignment('start', factory.createNumericLiteral(node.getStart())),
    factory.createPropertyAssignment('end', factory.createNumericLiteral(node.getEnd())),
  ]);
}

function isProducerHandleType(file: ParsedSourceFile, type: ts.TypeNode | undefined): boolean {
  const text = type?.getText(file.ast).replaceAll(/\s/g, '') ?? '';
  return ['Producer', 'DeciderCombinator', 'ArithmeticCombinator', 'ConstantCombinator'].includes(
    text,
  );
}

function producerHandleTypeName(
  file: ParsedSourceFile,
  type: ts.TypeNode | undefined,
): string | undefined {
  const text = type?.getText(file.ast).replaceAll(/\s/g, '') ?? '';
  return isProducerHandleType(file, type) ? text : undefined;
}

function producerArrayElementTypeName(
  file: ParsedSourceFile,
  type: ts.TypeNode | undefined,
): string | undefined {
  const text = type?.getText(file.ast).replaceAll(/\s/g, '') ?? '';
  const element = text.endsWith('[]') ? text.slice(0, -2) : /^Array<(.+)>$/.exec(text)?.[1];
  return element === undefined ||
    !['Producer', 'DeciderCombinator', 'ArithmeticCombinator', 'ConstantCombinator'].includes(
      element,
    )
    ? undefined
    : element;
}

/**
 * First executable-transform slice. Ordinary JavaScript control flow is deliberately
 * left to the JS engine; only DSL-sensitive nodes are replaced with allowlisted calls.
 */
export function transformElaborationModule(file: ParsedSourceFile): ElaborationJavaScript {
  const signalNames = new Set<string>();
  const networkNames = new Set<string>();

  const collect = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
      const initializer = node.initializer;
      if (
        initializer !== undefined &&
        ts.isCallExpression(initializer) &&
        ts.isIdentifier(initializer.expression)
      ) {
        if (initializer.expression.text === 'Signal') signalNames.add(node.name.text);
        if (initializer.expression.text === 'CC') networkNames.add(node.name.text);
      }
      if (
        initializer !== undefined &&
        ts.isNewExpression(initializer) &&
        ts.isIdentifier(initializer.expression) &&
        initializer.expression.text === 'Network'
      ) {
        networkNames.add(node.name.text);
      }
      if (node.type?.getText(file.ast).replaceAll(/\s/g, '').startsWith('Network') === true) {
        networkNames.add(node.name.text);
      }
    }
    if (ts.isParameter(node) && ts.isIdentifier(node.name)) {
      const type = node.type?.getText(file.ast).replaceAll(/\s/g, '') ?? '';
      if (type.includes('Network')) networkNames.add(node.name.text);
    }
    node.forEachChild(collect);
  };
  collect(file.ast);

  const containsNamed = (node: ts.Node, names: ReadonlySet<string>): boolean => {
    if (ts.isIdentifier(node) && names.has(node.text)) return true;
    let found = false;
    node.forEachChild((child) => {
      if (!found && containsNamed(child, names)) found = true;
    });
    return found;
  };

  const addBindingNames = (name: ts.BindingName): void => {
    if (ts.isIdentifier(name)) {
      networkNames.add(name.text);
      return;
    }
    for (const element of name.elements) {
      if (!ts.isOmittedExpression(element)) addBindingNames(element.name);
    }
  };
  const collectRuntimeNetworkBindings = (node: ts.Node): void => {
    if (
      ts.isVariableDeclaration(node) &&
      !ts.isIdentifier(node.name) &&
      node.initializer !== undefined &&
      (node.type?.getText(file.ast).includes('Network') === true ||
        containsNamed(node.initializer, networkNames))
    ) {
      addBindingNames(node.name);
    }
    node.forEachChild(collectRuntimeNetworkBindings);
  };
  collectRuntimeNetworkBindings(file.ast);

  interface ProducerSlotDeclaration {
    readonly name: string;
    readonly type: ts.TypeNode | undefined;
    readonly scope: ts.Node;
    readonly start: number;
  }
  const producerSlots: ProducerSlotDeclaration[] = [];
  const slotScope = (node: ts.Node): ts.Node => {
    for (let parent = node.parent; parent !== undefined; parent = parent.parent) {
      if (
        ts.isFunctionLike(parent) ||
        ts.isBlock(parent) ||
        ts.isSourceFile(parent) ||
        ts.isForStatement(parent) ||
        ts.isForInStatement(parent) ||
        ts.isForOfStatement(parent) ||
        ts.isCatchClause(parent)
      ) {
        return parent;
      }
    }
    return file.ast;
  };
  const collectProducerSlots = (node: ts.Node): void => {
    if ((ts.isVariableDeclaration(node) || ts.isParameter(node)) && ts.isIdentifier(node.name)) {
      producerSlots.push({
        name: node.name.text,
        type: node.type,
        scope: slotScope(node),
        start: node.getStart(file.ast),
      });
    }
    node.forEachChild(collectProducerSlots);
  };
  collectProducerSlots(file.ast);
  const isWithin = (node: ts.Node, scope: ts.Node): boolean => {
    for (let current: ts.Node | undefined = node; current !== undefined; current = current.parent) {
      if (current === scope) return true;
    }
    return false;
  };
  const scopeDepth = (node: ts.Node): number => {
    let depth = 0;
    for (let current = node.parent; current !== undefined; current = current.parent) depth += 1;
    return depth;
  };
  const producerTypeForProperty = (
    type: ts.TypeNode | undefined,
    property: string,
  ): string | undefined => {
    if (type === undefined || !ts.isTypeLiteralNode(type)) return undefined;
    const member = type.members.find(
      (candidate): candidate is ts.PropertySignature =>
        ts.isPropertySignature(candidate) &&
        (ts.isIdentifier(candidate.name) ||
        ts.isStringLiteral(candidate.name) ||
        ts.isNumericLiteral(candidate.name)
          ? candidate.name.text
          : candidate.name.getText(file.ast)) === property,
    );
    return producerHandleTypeName(file, member?.type);
  };
  const producerTypeForAssignment = (
    target: ts.Expression,
    assignment: ts.BinaryExpression,
  ): string | undefined => {
    const base = ts.isIdentifier(target)
      ? target
      : (ts.isPropertyAccessExpression(target) || ts.isElementAccessExpression(target)) &&
          ts.isIdentifier(target.expression)
        ? target.expression
        : undefined;
    if (base === undefined) return undefined;
    const declaration = producerSlots
      .filter(
        (candidate) =>
          candidate.name === base.text &&
          candidate.start <= assignment.getStart(file.ast) &&
          isWithin(assignment, candidate.scope),
      )
      .sort(
        (left, right) =>
          scopeDepth(right.scope) - scopeDepth(left.scope) || right.start - left.start,
      )[0];
    if (declaration === undefined) return undefined;
    if (ts.isIdentifier(target)) return producerHandleTypeName(file, declaration.type);
    if (ts.isElementAccessExpression(target)) {
      const elementType = producerArrayElementTypeName(file, declaration.type);
      if (elementType !== undefined) return elementType;
      const argument = target.argumentExpression;
      const property =
        ts.isStringLiteral(argument) || ts.isNumericLiteral(argument) ? argument.text : undefined;
      return property === undefined
        ? undefined
        : producerTypeForProperty(declaration.type, property);
    }
    return ts.isPropertyAccessExpression(target)
      ? producerTypeForProperty(declaration.type, target.name.text)
      : undefined;
  };

  const transformer: ts.TransformerFactory<ts.SourceFile> = (context) => {
    const { factory } = context;
    const borrowDescriptorForType = (
      type: ts.TypeNode | undefined,
    ):
      | {
          readonly capability: 'readonly' | 'ref' | 'move';
          readonly color?: 'red' | 'green';
        }
      | undefined => {
      const text = type?.getText(file.ast).replaceAll(/\s/g, '') ?? '';
      const match = /^(Readonly|Ref|Move)<Network(?:<(.+)>)?>$/.exec(text);
      if (match === null) return undefined;
      const color = match[2] === 'R' ? 'red' : match[2] === 'G' ? 'green' : undefined;
      return {
        capability: match[1] === 'Readonly' ? 'readonly' : match[1] === 'Ref' ? 'ref' : 'move',
        ...(color === undefined ? {} : { color }),
      };
    };
    const networkCall = (node: ts.NewExpression, name?: string): ts.Expression => {
      const color = node.typeArguments?.[0]?.getText(file.ast);
      return dslCall(factory, 'network', [
        name === undefined ? factory.createVoidZero() : factory.createStringLiteral(name),
        color === 'R' || color === 'G'
          ? factory.createStringLiteral(color === 'R' ? 'red' : 'green')
          : factory.createVoidZero(),
        spanLiteral(factory, node),
      ]);
    };
    const colorForType = (node: ts.TypeNode | undefined): ts.Expression => {
      const type = node?.getText(file.ast).replaceAll(/\s/g, '') ?? '';
      return type === 'Network<R>'
        ? factory.createStringLiteral('red')
        : type === 'Network<G>'
          ? factory.createStringLiteral('green')
          : factory.createVoidZero();
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
    const visit: ts.Visitor = (node) => {
      if (ts.isEnumDeclaration(node)) {
        let nextNumericValue = 0;
        const properties = node.members.map((member) => {
          const name =
            ts.isIdentifier(member.name) || ts.isStringLiteral(member.name)
              ? member.name.text
              : member.name.getText(file.ast);
          let value: ts.Expression;
          if (member.initializer === undefined) {
            value = factory.createNumericLiteral(nextNumericValue);
            nextNumericValue += 1;
          } else {
            value = ts.visitNode(member.initializer, visit) as ts.Expression;
            const literal = member.initializer;
            if (ts.isNumericLiteral(literal)) {
              nextNumericValue = Number(literal.text) + 1;
            } else if (
              ts.isPrefixUnaryExpression(literal) &&
              literal.operator === ts.SyntaxKind.MinusToken &&
              ts.isNumericLiteral(literal.operand)
            ) {
              nextNumericValue = -Number(literal.operand.text) + 1;
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

      if (ts.isExpressionStatement(node)) {
        if (
          ts.isBinaryExpression(node.expression) &&
          node.expression.operatorToken.kind === ts.SyntaxKind.EqualsToken
        ) {
          return factory.updateExpressionStatement(
            node,
            ts.visitNode(node.expression, visit) as ts.Expression,
          );
        }
        return factory.updateExpressionStatement(
          node,
          dslCall(factory, 'discard', [
            ts.visitNode(node.expression, visit) as ts.Expression,
            spanLiteral(factory, node.expression),
          ]),
        );
      }

      if (
        ts.isReturnStatement(node) &&
        node.expression !== undefined &&
        enclosingFunctionDeclaration(node) !== undefined
      ) {
        const owner = enclosingFunctionDeclaration(node)!;
        return factory.updateReturnStatement(
          node,
          dslCall(factory, 'returnValue', [
            ts.visitNode(node.expression, visit) as ts.Expression,
            spanLiteral(factory, node),
            producerHandleTypeName(file, owner.type) === undefined
              ? factory.createVoidZero()
              : factory.createStringLiteral(producerHandleTypeName(file, owner.type)!),
          ]),
        );
      }

      if (ts.isFunctionDeclaration(node) && node.body !== undefined) {
        const name = node.name?.text ?? '<anonymous>';
        const parameterBindings = node.parameters.flatMap((parameter) => {
          if (!ts.isIdentifier(parameter.name)) return [];
          const producerType = producerHandleTypeName(file, parameter.type);
          if (producerType !== undefined) {
            return [
              factory.createExpressionStatement(
                factory.createAssignment(
                  parameter.name,
                  dslCall(factory, 'producerHandle', [
                    parameter.name,
                    factory.createStringLiteral(producerType),
                    spanLiteral(factory, parameter),
                  ]),
                ),
              ),
            ];
          }
          const descriptor = borrowDescriptorForType(parameter.type);
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
                      spanLiteral(factory, parameter),
                    ])
                  : dslCall(factory, 'borrowParameter', [
                      parameter.name,
                      factory.createStringLiteral(descriptor.capability),
                      factory.createStringLiteral(parameter.name.text),
                      descriptor.color === undefined
                        ? factory.createVoidZero()
                        : factory.createStringLiteral(descriptor.color),
                      spanLiteral(factory, parameter),
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
          node.parameters,
          node.type,
          body,
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
          node.condition === undefined
            ? undefined
            : (ts.visitNode(node.condition, visit) as ts.Expression),
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
          ts.visitNode(node.expression, visit) as ts.Expression,
          instrumentLoopBody(node.statement, 'while', factory.createVoidZero(), node, visit),
        );
      }

      if (ts.isDoStatement(node)) {
        return factory.updateDoStatement(
          node,
          instrumentLoopBody(node.statement, 'do', factory.createVoidZero(), node, visit),
          ts.visitNode(node.expression, visit) as ts.Expression,
        );
      }

      if (ts.isIdentifier(node) && wildcardNames[node.text] !== undefined) {
        return dslCall(factory, 'wildcardToken', [
          factory.createStringLiteral(wildcardNames[node.text]!),
        ]);
      }
      if (
        ts.isVariableDeclaration(node) &&
        (ts.isArrayBindingPattern(node.name) || ts.isObjectBindingPattern(node.name)) &&
        node.initializer
      ) {
        const array = ts.isArrayBindingPattern(node.name);
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
          node.name,
          undefined,
          undefined,
          initializer,
        );
      }
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
        let initializer: ts.Expression;
        if (
          ts.isNewExpression(node.initializer) &&
          ts.isIdentifier(node.initializer.expression) &&
          node.initializer.expression.text === 'Network'
        ) {
          initializer = networkCall(node.initializer, node.name.text);
        } else {
          initializer = ts.visitNode(node.initializer, visit) as ts.Expression;
        }
        const producerType = producerHandleTypeName(file, node.type);
        if (producerType !== undefined) {
          initializer = dslCall(factory, 'producerHandle', [
            initializer,
            factory.createStringLiteral(producerType),
            spanLiteral(factory, node),
          ]);
        } else if (!ts.isNewExpression(node.initializer)) {
          initializer = dslCall(factory, 'materialize', [
            initializer,
            factory.createStringLiteral(node.name.text),
            colorForType(node.type),
            spanLiteral(factory, node),
          ]);
        }
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

      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
        const wildcard = wildcardNames[node.expression.text];
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
          IF: 'decider',
          to: 'destinations',
          pair: 'pair',
        }[node.expression.text];
        if (mapped !== undefined) {
          return dslCall(factory, mapped, [
            ...node.arguments.map((argument) => ts.visitNode(argument, visit) as ts.Expression),
            spanLiteral(factory, node),
          ]);
        }
      }

      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
        const method = node.expression.name.text;
        const receiver = node.expression.expression;
        if (
          method === 'then' &&
          ts.isCallExpression(receiver) &&
          ts.isIdentifier(receiver.expression) &&
          receiver.expression.text === 'when' &&
          receiver.arguments.length === 1 &&
          node.arguments.length >= 1
        ) {
          return dslCall(factory, 'decider', [
            ts.visitNode(receiver.arguments[0]!, visit) as ts.Expression,
            ...node.arguments.map((argument) => ts.visitNode(argument, visit) as ts.Expression),
            spanLiteral(factory, node),
          ]);
        }
        if (method === 'to') {
          return dslCall(factory, 'attachTo', [
            ts.visitNode(receiver, visit) as ts.Expression,
            ...node.arguments.map((argument) => ts.visitNode(argument, visit) as ts.Expression),
            spanLiteral(factory, node),
          ]);
        }
        if (method === 'take') {
          return dslCall(factory, 'take', [
            ts.visitNode(receiver, visit) as ts.Expression,
            ...node.arguments.map((argument) => ts.visitNode(argument, visit) as ts.Expression),
            spanLiteral(factory, node),
          ]);
        }
        if (method === 'as' && node.arguments.length === 1) {
          return dslCall(factory, 'bindOutput', [
            ts.visitNode(receiver, visit) as ts.Expression,
            ts.visitNode(node.arguments[0]!, visit) as ts.Expression,
            spanLiteral(factory, node),
          ]);
        }
        if (method === 'at' && (node.arguments.length === 2 || node.arguments.length === 3)) {
          return dslCall(factory, 'place', [
            ts.visitNode(receiver, visit) as ts.Expression,
            ...node.arguments.map((argument) => ts.visitNode(argument, visit) as ts.Expression),
            spanLiteral(factory, node),
          ]);
        }
      }

      if (ts.isElementAccessExpression(node) && !isWriteTarget(node)) {
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
  // `transpileModule` constructs a short-lived compiler program. Besides doing work we do not
  // need, that path is not stable after TypeScript itself is bundled into a production Worker.
  // The compiler's syntax-only TypeScript transform is the same erasure stage used by emit and
  // keeps runtime elaboration deterministic in both Node and the browser.
  const syntaxTransforms = ts as typeof ts & {
    transformTypeScript: ts.TransformerFactory<ts.SourceFile>;
  };
  const erased = ts.transform(
    transformed.transformed[0]!,
    [syntaxTransforms.transformTypeScript],
    compilerOptions,
  );
  const javaScript = ts.createPrinter().printFile(erased.transformed[0]!);
  erased.dispose();
  transformed.dispose();
  return {
    format: 'comblang-elaboration-js',
    version: 1,
    fileId: file.id,
    code: javaScript,
  };
}

import ts from 'typescript';

import {
  networkTypeFromAnnotation,
  parseDslTypeText,
  type ParsedSourceFile,
} from '@comblang/language';

import { producerHandleTypeName } from './elaboration-transform-analysis.js';

export interface BindingTransformContext {
  readonly factory: ts.NodeFactory;
  readonly file: ParsedSourceFile;
  readonly testContextName?: string;
  readonly visit: ts.Visitor;
  dslCall(name: string, arguments_: readonly ts.Expression[]): ts.Expression;
  spanLiteral(node: ts.Node): ts.ObjectLiteralExpression;
}

export interface ElaborationBindingTransform {
  transformParameter(parameter: ts.ParameterDeclaration): ts.ParameterDeclaration;
  transformVariableDeclaration(node: ts.VariableDeclaration): ts.VariableDeclaration;
  transformNetworkConstruction(node: ts.NewExpression, name?: string): ts.Expression;
  transformTestInstantiation(
    node: ts.CallExpression,
    bindingName?: string,
  ): ts.Expression | undefined;
}

/** Creates the recursive binding/default/materialization family for one source transform. */
export function createElaborationBindingTransform(
  context: BindingTransformContext,
): ElaborationBindingTransform {
  const { factory, file, visit } = context;
  const bindingReader = (name: string): ts.Expression =>
    factory.createArrowFunction(
      undefined,
      undefined,
      [],
      undefined,
      factory.createToken(ts.SyntaxKind.EqualsGreaterThanToken),
      factory.createIdentifier(name),
    );
  const colorForType = (node: ts.TypeNode | undefined): ts.Expression => {
    const color = networkTypeFromAnnotation(node, file.ast)?.color;
    return color === undefined ? factory.createVoidZero() : factory.createStringLiteral(color);
  };
  const transformNetworkConstruction = (node: ts.NewExpression, name?: string): ts.Expression => {
    const type = parseDslTypeText(
      `Network${node.typeArguments?.[0] === undefined ? '' : `<${node.typeArguments[0].getText(file.ast)}>`}`,
    );
    const color = type?.kind === 'network' ? type.color : undefined;
    return context.dslCall('network', [
      name === undefined ? factory.createVoidZero() : factory.createStringLiteral(name),
      color === undefined ? factory.createVoidZero() : factory.createStringLiteral(color),
      context.spanLiteral(node),
      ...(name === undefined ? [] : [bindingReader(name)]),
    ]);
  };
  const transformTestInstantiation = (
    node: ts.CallExpression,
    bindingName?: string,
  ): ts.Expression | undefined => {
    if (
      context.testContextName === undefined ||
      node.questionDotToken !== undefined ||
      !ts.isPropertyAccessExpression(node.expression) ||
      node.expression.questionDotToken !== undefined ||
      !ts.isIdentifier(node.expression.expression) ||
      node.expression.expression.text !== context.testContextName ||
      node.expression.name.text !== 'instantiate' ||
      node.arguments.length < 1
    ) {
      return undefined;
    }
    return context.dslCall('instantiate', [
      factory.createStringLiteral(bindingName ?? `instance@${node.getStart(file.ast)}`),
      ...node.arguments.map((argument) => ts.visitNode(argument, visit) as ts.Expression),
      context.spanLiteral(node),
    ]);
  };
  const transformBindingInitializer = (
    initializer: ts.Expression,
    name: ts.Identifier,
    type: ts.TypeNode | undefined,
    source: ts.Node,
  ): ts.Expression => {
    const constructsNetwork =
      ts.isNewExpression(initializer) &&
      ts.isIdentifier(initializer.expression) &&
      initializer.expression.text === 'Network';
    const transformed = constructsNetwork
      ? transformNetworkConstruction(initializer as ts.NewExpression, name.text)
      : ((ts.isCallExpression(initializer)
          ? transformTestInstantiation(initializer, name.text)
          : undefined) ?? (ts.visitNode(initializer, visit) as ts.Expression));
    const producerType = producerHandleTypeName(file, type);
    if (producerType !== undefined) {
      return context.dslCall('producerHandle', [
        transformed,
        factory.createStringLiteral(producerType),
        factory.createStringLiteral(name.text),
        context.spanLiteral(source),
      ]);
    }
    return constructsNetwork
      ? transformed
      : context.dslCall('materialize', [
          transformed,
          factory.createStringLiteral(name.text),
          colorForType(type),
          context.spanLiteral(source),
          bindingReader(name.text),
        ]);
  };
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
                factory.createPropertyAssignment('property', factory.createStringLiteral(property)),
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
  const transformVariableDeclaration = (node: ts.VariableDeclaration): ts.VariableDeclaration => {
    if (ts.isArrayBindingPattern(node.name) || ts.isObjectBindingPattern(node.name)) {
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
      const initializer = context.dslCall(array ? 'materializeArray' : 'materializeObject', [
        ts.visitNode(node.initializer, visit) as ts.Expression,
        factory.createArrayLiteralExpression(descriptors),
        context.spanLiteral(node),
      ]);
      return factory.updateVariableDeclaration(
        node,
        bindingName,
        undefined,
        undefined,
        initializer,
      );
    }
    if (ts.isIdentifier(node.name) && node.initializer !== undefined) {
      return factory.updateVariableDeclaration(
        node,
        node.name,
        undefined,
        undefined,
        transformBindingInitializer(node.initializer, node.name, node.type, node),
      );
    }
    return node;
  };
  return Object.freeze({
    transformParameter,
    transformVariableDeclaration,
    transformNetworkConstruction,
    transformTestInstantiation,
  });
}

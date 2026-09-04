import ts from 'typescript';

import {
  parseDslTypeAnnotation,
  producerHandleTypeFromAnnotation,
  type ParsedSourceFile,
} from '@comblang/language';

interface ProducerSlotDeclaration {
  readonly name: string;
  readonly type: ts.TypeNode | undefined;
  readonly scope: ts.Node;
  readonly start: number;
}

export interface ElaborationTransformAnalysis {
  readonly runtimeParameter: string;
  readonly containsUnsupportedAsync: boolean;
  readonly signalNames: ReadonlySet<string>;
  readonly networkNames: ReadonlySet<string>;
  producerTypeForAssignment(
    target: ts.Expression,
    assignment: ts.BinaryExpression,
  ): string | undefined;
}

export function producerHandleTypeName(
  file: ParsedSourceFile,
  type: ts.TypeNode | undefined,
): string | undefined {
  return producerHandleTypeFromAnnotation(type, file.ast);
}

function producerArrayElementTypeName(
  file: ParsedSourceFile,
  type: ts.TypeNode | undefined,
): string | undefined {
  const syntax = parseDslTypeAnnotation(type, file.ast);
  return syntax?.kind === 'array' && syntax.element.kind === 'producer'
    ? syntax.element.producerType
    : undefined;
}

/** Collects source facts required by the DSL-sensitive AST rewrite. */
export function analyzeElaborationTransform(file: ParsedSourceFile): ElaborationTransformAnalysis {
  const sourceIdentifiers = new Set<string>();
  let containsUnsupportedAsync = false;
  const collectIdentifiers = (node: ts.Node): void => {
    if (ts.isIdentifier(node)) sourceIdentifiers.add(node.text);
    if (
      ts.isAwaitExpression(node) ||
      (ts.isForOfStatement(node) && node.awaitModifier !== undefined) ||
      (ts.canHaveModifiers(node) &&
        ts.getModifiers(node)?.some(({ kind }) => kind === ts.SyntaxKind.AsyncKeyword) === true)
    ) {
      containsUnsupportedAsync = true;
    }
    node.forEachChild(collectIdentifiers);
  };
  collectIdentifiers(file.ast);
  let runtimeParameter = '__dsl';
  for (let ordinal = 1; sourceIdentifiers.has(runtimeParameter); ordinal += 1) {
    runtimeParameter = `__dsl_${ordinal}`;
  }

  const signalNames = new Set<string>();
  const networkNames = new Set<string>();
  const collectDslBindings = (node: ts.Node): void => {
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
      if (parseDslTypeAnnotation(node.type, file.ast)?.kind === 'network') {
        networkNames.add(node.name.text);
      }
    }
    if (ts.isParameter(node) && ts.isIdentifier(node.name)) {
      const type = parseDslTypeAnnotation(node.type, file.ast);
      if (type?.kind === 'network' || (type?.kind === 'array' && type.element.kind === 'network')) {
        networkNames.add(node.name.text);
      }
    }
    node.forEachChild(collectDslBindings);
  };
  collectDslBindings(file.ast);

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

  return {
    runtimeParameter,
    containsUnsupportedAsync,
    signalNames,
    networkNames,
    producerTypeForAssignment,
  };
}

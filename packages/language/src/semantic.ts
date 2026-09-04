import ts from 'typescript';

import type { Diagnostic, SourceSpan } from '@comblang/shared';

import { spanForNode, type ParsedSourceFile } from './parser.js';
import { reservedDslValueNames } from './dsl-names.js';
import { createFunctionResolver } from './function-resolution.js';
import {
  parseDslTypeAnnotation,
  networkTypeFromAnnotation,
  producerHandleTypeFromAnnotation,
  type NetworkCapability,
  type NetworkTypeSyntax,
} from './dsl-type-syntax.js';

export type DslValueType = 'network' | 'number' | 'boolean' | 'signal' | 'signal-value' | 'unknown';
export type OperatorDomain =
  'circuit-arithmetic' | 'compile-time' | 'typed-constant' | 'unsupported';

export interface SemanticSummary {
  readonly kind: 'network-declaration' | 'function' | 'operator';
  readonly span: SourceSpan;
  readonly text: string;
  readonly valueType: DslValueType;
  readonly operator?: string;
  readonly operatorDomain?: OperatorDomain;
}

function typeFromAnnotation(node: ts.TypeNode | undefined): DslValueType {
  if (node === undefined) return 'unknown';
  if (node.kind === ts.SyntaxKind.NumberKeyword) return 'number';
  if (node.kind === ts.SyntaxKind.BooleanKeyword) return 'boolean';
  return parseDslTypeAnnotation(node)?.kind === 'network' ? 'network' : 'unknown';
}

function operatorText(kind: ts.SyntaxKind): string | undefined {
  switch (kind) {
    case ts.SyntaxKind.PlusToken:
      return '+';
    case ts.SyntaxKind.MinusToken:
      return '-';
    case ts.SyntaxKind.AsteriskToken:
      return '*';
    case ts.SyntaxKind.SlashToken:
      return '/';
    case ts.SyntaxKind.PercentToken:
      return '%';
    case ts.SyntaxKind.AsteriskAsteriskToken:
      return '**';
    case ts.SyntaxKind.LessThanLessThanToken:
      return '<<';
    case ts.SyntaxKind.GreaterThanGreaterThanToken:
      return '>>';
    case ts.SyntaxKind.AmpersandToken:
      return '&';
    case ts.SyntaxKind.BarToken:
      return '|';
    case ts.SyntaxKind.CaretToken:
      return '^';
    default:
      return undefined;
  }
}

export function classifyDslSemantics(file: ParsedSourceFile): readonly SemanticSummary[] {
  const summaries: SemanticSummary[] = [];
  const scopes: Map<string, DslValueType>[] = [new Map()];
  const resolveFunction = createFunctionResolver(file);

  const lookup = (name: string): DslValueType => {
    for (let index = scopes.length - 1; index >= 0; index -= 1) {
      const value = scopes[index]!.get(name);
      if (value !== undefined) return value;
    }
    return 'unknown';
  };

  const expressionType = (expression: ts.Expression): DslValueType => {
    if (ts.isNumericLiteral(expression)) return 'number';
    if (
      expression.kind === ts.SyntaxKind.TrueKeyword ||
      expression.kind === ts.SyntaxKind.FalseKeyword
    )
      return 'boolean';
    if (ts.isIdentifier(expression)) return lookup(expression.text);
    if (ts.isParenthesizedExpression(expression)) return expressionType(expression.expression);
    if (ts.isNewExpression(expression) && expression.expression.getText(file.ast) === 'Network') {
      return 'network';
    }
    if (ts.isCallExpression(expression) && ts.isIdentifier(expression.expression)) {
      if (expression.expression.text === 'Signal') return 'signal';
      if (expression.expression.text === 'CC' || expression.expression.text === 'IF') {
        return 'network';
      }
      return typeFromAnnotation(resolveFunction(expression.expression)?.type);
    }
    if (ts.isBinaryExpression(expression)) {
      const operator = operatorText(expression.operatorToken.kind);
      if (operator === undefined) return 'unknown';
      const left = expressionType(expression.left);
      const right = expressionType(expression.right);
      if (
        operator === '*' &&
        ((left === 'number' && right === 'signal') || (left === 'signal' && right === 'number'))
      ) {
        return 'signal-value';
      }
      return left === 'network' || right === 'network'
        ? 'network'
        : left === 'number' && right === 'number'
          ? 'number'
          : 'unknown';
    }
    return 'unknown';
  };

  const visit = (node: ts.Node): void => {
    if (ts.isFunctionDeclaration(node)) {
      summaries.push({
        kind: 'function',
        span: spanForNode(file, node),
        text: node.name?.text ?? '<anonymous>',
        valueType: typeFromAnnotation(node.type),
      });
      const scope = new Map<string, DslValueType>();
      for (const parameter of node.parameters) {
        if (ts.isIdentifier(parameter.name)) {
          scope.set(parameter.name.text, typeFromAnnotation(parameter.type));
        }
      }
      scopes.push(scope);
      node.body?.forEachChild(visit);
      scopes.pop();
      return;
    }

    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
      const annotated = typeFromAnnotation(node.type);
      const inferred =
        node.initializer === undefined ? 'unknown' : expressionType(node.initializer);
      const valueType = annotated === 'unknown' ? inferred : annotated;
      scopes.at(-1)!.set(node.name.text, valueType);
      if (valueType === 'network') {
        summaries.push({
          kind: 'network-declaration',
          span: spanForNode(file, node),
          text: node.name.text,
          valueType,
        });
      }
    }

    if (ts.isBinaryExpression(node)) {
      const operator = operatorText(node.operatorToken.kind);
      if (operator !== undefined) {
        const left = expressionType(node.left);
        const right = expressionType(node.right);
        const domain: OperatorDomain =
          operator === '*' &&
          ((left === 'number' && right === 'signal') || (left === 'signal' && right === 'number'))
            ? 'typed-constant'
            : left === 'network' || right === 'network'
              ? 'circuit-arithmetic'
              : left === 'number' && right === 'number'
                ? 'compile-time'
                : 'unsupported';
        summaries.push({
          kind: 'operator',
          span: spanForNode(file, node),
          text: node.getText(file.ast),
          valueType: domain === 'circuit-arithmetic' ? 'network' : expressionType(node),
          operator,
          operatorDomain: domain,
        });
      }
    }
    node.forEachChild(visit);
  };

  file.ast.forEachChild(visit);
  return summaries;
}

/** Reports DSL-invalid forms that are provable without executing compile-time control flow. */
export function validateDslSemantics(file: ParsedSourceFile): readonly Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const reportReservedBinding = (name: ts.BindingName): void => {
    if (ts.isIdentifier(name)) {
      if (reservedDslValueNames.has(name.text)) {
        diagnostics.push({
          code: 'CL1045',
          severity: 'error',
          message: `${name.text} is a reserved CombLang DSL identifier and cannot be declared or bound by user code.`,
          span: spanForNode(file, name),
        });
      }
      return;
    }
    for (const element of name.elements) {
      if (!ts.isOmittedExpression(element)) reportReservedBinding(element.name);
    }
  };
  const collectReservedBindings = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) || ts.isParameter(node)) {
      reportReservedBinding(node.name);
    } else if (
      (ts.isFunctionDeclaration(node) ||
        ts.isFunctionExpression(node) ||
        ts.isClassDeclaration(node) ||
        ts.isClassExpression(node) ||
        ts.isEnumDeclaration(node)) &&
      node.name !== undefined &&
      reservedDslValueNames.has(node.name.text)
    ) {
      diagnostics.push({
        code: 'CL1045',
        severity: 'error',
        message: `${node.name.text} is a reserved CombLang DSL identifier and cannot be declared or bound by user code.`,
        span: spanForNode(file, node.name),
      });
    }
    node.forEachChild(collectReservedBindings);
  };
  file.ast.forEachChild(collectReservedBindings);
  // A reserved binding makes textual DSL resolution intentionally unambiguous: compilation stops
  // at the declarations instead of cascading into misleading diagnostics for their later uses.
  if (diagnostics.length > 0) return diagnostics;
  const networkScopes: Set<string>[] = [new Set()];
  const networkArrayScopes: Set<string>[] = [new Set()];
  const capabilityScopes: Map<string, NetworkCapability>[] = [new Map()];
  const bindingScopes: Set<string>[] = [new Set()];
  interface ProducerSlotType {
    readonly direct?: string;
    readonly element?: string;
    readonly properties?: ReadonlyMap<string, string>;
  }
  const producerSlotScopes: Map<string, ProducerSlotType | undefined>[] = [new Map()];
  const resolveFunction = createFunctionResolver(file);
  const networkFunctionReturn = (name: ts.Identifier): NetworkTypeSyntax | undefined =>
    networkTypeFromAnnotation(resolveFunction(name)?.type, file.ast);
  const producerFunctionReturn = (name: ts.Identifier): string | undefined =>
    producerHandleTypeFromAnnotation(resolveFunction(name)?.type, file.ast);
  interface NetworkParameterType {
    readonly name: string;
    readonly type: NetworkTypeSyntax;
    readonly optional: boolean;
  }
  const isDslBuiltin = (name: string): boolean => reservedDslValueNames.has(name);

  const isNetworkType = (node: ts.TypeNode | undefined): boolean =>
    typeFromAnnotation(node) === 'network';
  const producerHandleTypeName = (node: ts.TypeNode | undefined): string | undefined =>
    producerHandleTypeFromAnnotation(node, file.ast);
  const isProducerHandleType = (node: ts.TypeNode | undefined): boolean =>
    producerHandleTypeName(node) !== undefined;
  const producerArrayElementTypeName = (node: ts.TypeNode | undefined): string | undefined => {
    const syntax = parseDslTypeAnnotation(node, file.ast);
    return syntax?.kind === 'array' && syntax.element.kind === 'producer'
      ? syntax.element.producerType
      : undefined;
  };
  const propertyNameText = (node: ts.PropertyName): string | undefined =>
    ts.isIdentifier(node) || ts.isStringLiteral(node) || ts.isNumericLiteral(node)
      ? node.text
      : undefined;
  const producerSlotTypeFromAnnotation = (
    node: ts.TypeNode | undefined,
  ): ProducerSlotType | undefined => {
    const direct = producerHandleTypeName(node);
    if (direct !== undefined) return { direct };
    const element = producerArrayElementTypeName(node);
    if (element !== undefined) return { element };
    if (node === undefined || !ts.isTypeLiteralNode(node)) return undefined;
    const properties = new Map<string, string>();
    for (const member of node.members) {
      if (!ts.isPropertySignature(member)) continue;
      const name = propertyNameText(member.name);
      const type = producerHandleTypeName(member.type);
      if (name !== undefined && type !== undefined) properties.set(name, type);
    }
    return properties.size === 0 ? undefined : { properties };
  };
  const isNetworkArrayType = (node: ts.TypeNode | undefined): boolean => {
    const syntax = parseDslTypeAnnotation(node, file.ast);
    return syntax?.kind === 'array' && syntax.element.kind === 'network';
  };
  const networkParametersOf = (
    declaration: ts.FunctionDeclaration | undefined,
  ): readonly (NetworkParameterType | undefined)[] | undefined =>
    declaration?.parameters.map((parameter) => {
      const type = networkTypeFromAnnotation(parameter.type, file.ast);
      if (type === undefined || !ts.isIdentifier(parameter.name)) return undefined;
      return {
        name: parameter.name.text,
        type,
        optional: parameter.questionToken !== undefined || parameter.initializer !== undefined,
      };
    });
  const addBindingNames = (name: ts.BindingName, bindings: Set<string>): void => {
    if (ts.isIdentifier(name)) {
      bindings.add(name.text);
      return;
    }
    for (const element of name.elements) {
      if (!ts.isOmittedExpression(element)) addBindingNames(element.name, bindings);
    }
  };
  const collectDirectStatementBindings = (
    statements: readonly ts.Statement[],
    bindings: Set<string>,
  ): void => {
    for (const statement of statements) {
      if (ts.isVariableStatement(statement)) {
        for (const declaration of statement.declarationList.declarations) {
          addBindingNames(declaration.name, bindings);
        }
      } else if (
        (ts.isFunctionDeclaration(statement) ||
          ts.isClassDeclaration(statement) ||
          ts.isEnumDeclaration(statement)) &&
        statement.name !== undefined
      ) {
        bindings.add(statement.name.text);
      }
    }
  };
  const lookupNetwork = (name: string): boolean => {
    for (let index = networkScopes.length - 1; index >= 0; index -= 1) {
      if (networkScopes[index]!.has(name)) return true;
      if (bindingScopes[index]!.has(name)) return false;
    }
    return false;
  };
  const lookupNetworkArray = (name: string): boolean => {
    for (let index = networkArrayScopes.length - 1; index >= 0; index -= 1) {
      if (networkArrayScopes[index]!.has(name)) return true;
      if (bindingScopes[index]!.has(name)) return false;
    }
    return false;
  };
  const lookupCapability = (name: string): NetworkCapability | undefined => {
    for (let index = capabilityScopes.length - 1; index >= 0; index -= 1) {
      const capability = capabilityScopes[index]!.get(name);
      if (capability !== undefined) return capability;
      if (bindingScopes[index]!.has(name)) return undefined;
    }
    return undefined;
  };
  const lookupProducerSlot = (name: string): ProducerSlotType | undefined => {
    for (let index = producerSlotScopes.length - 1; index >= 0; index -= 1) {
      const scope = producerSlotScopes[index]!;
      if (scope.has(name)) return scope.get(name);
      if (bindingScopes[index]!.has(name)) return undefined;
    }
    return undefined;
  };
  const producerTypeForAssignment = (target: ts.Expression): string | undefined => {
    if (ts.isIdentifier(target)) return lookupProducerSlot(target.text)?.direct;
    if (!ts.isPropertyAccessExpression(target) && !ts.isElementAccessExpression(target)) {
      return undefined;
    }
    if (!ts.isIdentifier(target.expression)) return undefined;
    const slot = lookupProducerSlot(target.expression.text);
    if (slot === undefined) return undefined;
    if (ts.isPropertyAccessExpression(target)) return slot.properties?.get(target.name.text);
    if (slot.element !== undefined) return slot.element;
    const argument = target.argumentExpression;
    const property =
      ts.isStringLiteral(argument) || ts.isNumericLiteral(argument) ? argument.text : undefined;
    return property === undefined ? undefined : slot.properties?.get(property);
  };
  const isNetworkArrayExpression = (node: ts.Expression): boolean => {
    if (ts.isParenthesizedExpression(node)) return isNetworkArrayExpression(node.expression);
    if (ts.isIdentifier(node)) return lookupNetworkArray(node.text);
    return (
      ts.isArrayLiteralExpression(node) &&
      node.elements.length > 0 &&
      node.elements.every((element) => ts.isExpression(element) && isNetworkExpression(element))
    );
  };
  const isNetworkExpression = (node: ts.Expression): boolean => {
    if (ts.isParenthesizedExpression(node)) return isNetworkExpression(node.expression);
    if (ts.isIdentifier(node)) return lookupNetwork(node.text);
    if (
      ts.isNewExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'Network' &&
      isDslBuiltin('Network')
    ) {
      return true;
    }
    if (ts.isElementAccessExpression(node)) {
      return isNetworkExpression(node.expression) || isNetworkArrayExpression(node.expression);
    }
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      networkFunctionReturn(node.expression) !== undefined
    ) {
      return true;
    }
    return false;
  };
  const isPairViewExpression = (node: ts.Expression): boolean => {
    if (ts.isParenthesizedExpression(node)) return isPairViewExpression(node.expression);
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'pair' &&
      isDslBuiltin('pair')
    ) {
      return true;
    }
    if (ts.isElementAccessExpression(node)) return isPairViewExpression(node.expression);
    return (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      ['Each', 'Anything', 'Any', 'Everything', 'All'].includes(node.expression.text) &&
      node.arguments.length === 1 &&
      isPairViewExpression(node.arguments[0]!)
    );
  };
  const capabilityOfNetworkExpression = (node: ts.Expression): NetworkCapability | undefined => {
    if (ts.isParenthesizedExpression(node)) return capabilityOfNetworkExpression(node.expression);
    if (ts.isIdentifier(node)) return lookupCapability(node.text);
    if (ts.isElementAccessExpression(node)) return capabilityOfNetworkExpression(node.expression);
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
      return networkFunctionReturn(node.expression)?.capability;
    }
    return isNetworkExpression(node) ? 'owned' : undefined;
  };
  const isWhenBuilderCall = (node: ts.CallExpression): boolean => {
    if (ts.isIdentifier(node.expression)) {
      return node.expression.text === 'when' && isDslBuiltin('when');
    }
    if (
      ts.isPropertyAccessExpression(node.expression) &&
      (node.expression.name.text === 'then' || node.expression.name.text === 'else') &&
      ts.isCallExpression(node.expression.expression)
    ) {
      return isWhenBuilderCall(node.expression.expression);
    }
    return false;
  };
  type ProducerCertainty = 'producer' | 'non-producer' | 'runtime';
  const producerCertainty = (node: ts.Expression): ProducerCertainty => {
    if (ts.isParenthesizedExpression(node)) return producerCertainty(node.expression);
    if (ts.isIdentifier(node) && lookupProducerSlot(node.text)?.direct !== undefined) {
      return 'producer';
    }
    if (ts.isBinaryExpression(node)) {
      if (operatorText(node.operatorToken.kind) === undefined) return 'runtime';
      const left = producerCertainty(node.left);
      const right = producerCertainty(node.right);
      if (
        isNetworkExpression(node.left) ||
        isNetworkExpression(node.right) ||
        left === 'producer' ||
        right === 'producer'
      ) {
        return 'producer';
      }
      return left === 'non-producer' && right === 'non-producer' ? 'non-producer' : 'runtime';
    }
    if (ts.isCallExpression(node)) {
      if (ts.isIdentifier(node.expression)) {
        return (node.expression.text === 'CC' && isDslBuiltin('CC')) ||
          (node.expression.text === 'IF' && isDslBuiltin('IF')) ||
          producerFunctionReturn(node.expression) !== undefined
          ? 'producer'
          : networkFunctionReturn(node.expression) !== undefined
            ? 'non-producer'
            : node.expression.text === 'Signal' && isDslBuiltin('Signal')
              ? 'non-producer'
              : 'runtime';
      }
      if (ts.isPropertyAccessExpression(node.expression)) {
        const method = node.expression.name.text;
        if ((method === 'then' || method === 'else') && isWhenBuilderCall(node)) return 'producer';
        if (method === 'as' || method === 'at') {
          return producerCertainty(node.expression.expression);
        }
      }
      return 'runtime';
    }
    if (isNetworkExpression(node)) return 'non-producer';
    if (
      ts.isNumericLiteral(node) ||
      ts.isStringLiteral(node) ||
      node.kind === ts.SyntaxKind.TrueKeyword ||
      node.kind === ts.SyntaxKind.FalseKeyword ||
      node.kind === ts.SyntaxKind.NullKeyword ||
      ts.isArrayLiteralExpression(node) ||
      ts.isObjectLiteralExpression(node)
    ) {
      return 'non-producer';
    }
    return 'runtime';
  };
  const isProducerExpression = (node: ts.Expression): boolean =>
    producerCertainty(node) === 'producer';
  const producerKindOfExpression = (
    node: ts.Expression,
  ): 'arithmetic' | 'decider' | 'constant' | undefined => {
    if (ts.isParenthesizedExpression(node)) return producerKindOfExpression(node.expression);
    if (ts.isBinaryExpression(node) && operatorText(node.operatorToken.kind) !== undefined) {
      return 'arithmetic';
    }
    if (!ts.isCallExpression(node)) return undefined;
    if (ts.isIdentifier(node.expression)) {
      if (node.expression.text === 'CC' && isDslBuiltin('CC')) return 'constant';
      if (node.expression.text === 'IF' && isDslBuiltin('IF')) return 'decider';
      const returned = producerFunctionReturn(node.expression);
      if (returned === 'ArithmeticCombinator') return 'arithmetic';
      if (returned === 'DeciderCombinator') return 'decider';
      if (returned === 'ConstantCombinator') return 'constant';
      return undefined;
    }
    if (ts.isPropertyAccessExpression(node.expression)) {
      if (
        (node.expression.name.text === 'then' || node.expression.name.text === 'else') &&
        isWhenBuilderCall(node)
      ) {
        return 'decider';
      }
      if (node.expression.name.text === 'as' || node.expression.name.text === 'at') {
        return producerKindOfExpression(node.expression.expression);
      }
    }
    return undefined;
  };
  const enclosingFunctionDeclaration = (node: ts.Node): ts.FunctionDeclaration | undefined => {
    for (let parent = node.parent; parent !== undefined; parent = parent.parent) {
      if (ts.isFunctionLike(parent)) {
        return ts.isFunctionDeclaration(parent) ? parent : undefined;
      }
    }
    return undefined;
  };
  const producerTypeAcceptsKind = (
    type: string,
    kind: 'arithmetic' | 'decider' | 'constant' | undefined,
  ): boolean =>
    kind === undefined ||
    type === 'Producer' ||
    (type === 'ArithmeticCombinator' && kind === 'arithmetic') ||
    (type === 'DeciderCombinator' && kind === 'decider') ||
    (type === 'ConstantCombinator' && kind === 'constant');
  const isDefinitelyNonSignal = (node: ts.Expression): boolean => {
    if (ts.isParenthesizedExpression(node)) return isDefinitelyNonSignal(node.expression);
    return (
      ts.isNumericLiteral(node) ||
      node.kind === ts.SyntaxKind.TrueKeyword ||
      node.kind === ts.SyntaxKind.FalseKeyword ||
      node.kind === ts.SyntaxKind.NullKeyword ||
      ts.isArrayLiteralExpression(node) ||
      ts.isObjectLiteralExpression(node) ||
      isNetworkExpression(node) ||
      isProducerExpression(node)
    );
  };
  const isDefinitelyNotString = (node: ts.Expression): boolean => {
    if (ts.isParenthesizedExpression(node)) return isDefinitelyNotString(node.expression);
    return (
      ts.isNumericLiteral(node) ||
      node.kind === ts.SyntaxKind.TrueKeyword ||
      node.kind === ts.SyntaxKind.FalseKeyword ||
      node.kind === ts.SyntaxKind.NullKeyword ||
      ts.isArrayLiteralExpression(node) ||
      ts.isObjectLiteralExpression(node) ||
      isNetworkExpression(node) ||
      isProducerExpression(node)
    );
  };
  const isDefinitelyNotOutputSignal = (node: ts.Expression): boolean => {
    if (ts.isParenthesizedExpression(node)) return isDefinitelyNotOutputSignal(node.expression);
    return (
      ts.isNumericLiteral(node) ||
      ts.isStringLiteral(node) ||
      node.kind === ts.SyntaxKind.TrueKeyword ||
      node.kind === ts.SyntaxKind.FalseKeyword ||
      node.kind === ts.SyntaxKind.NullKeyword ||
      ts.isArrayLiteralExpression(node) ||
      ts.isObjectLiteralExpression(node) ||
      isNetworkExpression(node) ||
      isProducerExpression(node) ||
      isPairViewExpression(node)
    );
  };
  const isDefinitelyInvalidNetworkArgument = (node: ts.Expression): boolean => {
    if (ts.isParenthesizedExpression(node))
      return isDefinitelyInvalidNetworkArgument(node.expression);
    if (isNetworkExpression(node) || isProducerExpression(node)) return false;
    return (
      ts.isNumericLiteral(node) ||
      ts.isStringLiteral(node) ||
      node.kind === ts.SyntaxKind.TrueKeyword ||
      node.kind === ts.SyntaxKind.FalseKeyword ||
      node.kind === ts.SyntaxKind.NullKeyword ||
      ts.isArrayLiteralExpression(node) ||
      ts.isObjectLiteralExpression(node) ||
      (ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === 'Signal' &&
        isDslBuiltin('Signal'))
    );
  };
  const report = (code: string, message: string, node: ts.Node): void => {
    diagnostics.push({ code, severity: 'error', message, span: spanForNode(file, node) });
  };
  const isTopLevelAwait = (node: ts.Node): boolean => {
    for (let parent = node.parent; parent !== undefined; parent = parent.parent) {
      if (ts.isFunctionLike(parent)) return false;
      if (ts.isSourceFile(parent)) return true;
    }
    return true;
  };

  const visit = (node: ts.Node): void => {
    const asyncModifier = ts.canHaveModifiers(node)
      ? ts.getModifiers(node)?.find(({ kind }) => kind === ts.SyntaxKind.AsyncKeyword)
      : undefined;
    if (asyncModifier !== undefined) {
      report(
        'CL1036',
        'Async functions, arrows, and methods are not supported by synchronous compile-time elaboration.',
        asyncModifier,
      );
    }
    if (ts.isFunctionDeclaration(node)) {
      const scope = new Set<string>();
      const arrayScope = new Set<string>();
      const capabilityScope = new Map<string, NetworkCapability>();
      const producerSlotScope = new Map<string, ProducerSlotType | undefined>();
      const bindingScope = new Set<string>();
      for (const parameter of node.parameters) {
        addBindingNames(parameter.name, bindingScope);
        if (ts.isIdentifier(parameter.name)) {
          producerSlotScope.set(
            parameter.name.text,
            producerSlotTypeFromAnnotation(parameter.type),
          );
        }
        if (ts.isIdentifier(parameter.name) && isNetworkType(parameter.type)) {
          scope.add(parameter.name.text);
          const capability =
            networkTypeFromAnnotation(parameter.type, file.ast)?.capability ?? 'owned';
          capabilityScope.set(
            parameter.name.text,
            capability === 'owned' ? 'readonly' : capability,
          );
        }
        if (ts.isIdentifier(parameter.name) && isNetworkArrayType(parameter.type)) {
          arrayScope.add(parameter.name.text);
        }
      }
      networkScopes.push(scope);
      networkArrayScopes.push(arrayScope);
      capabilityScopes.push(capabilityScope);
      producerSlotScopes.push(producerSlotScope);
      bindingScopes.push(bindingScope);
      if (node.body !== undefined) visit(node.body);
      networkScopes.pop();
      networkArrayScopes.pop();
      capabilityScopes.pop();
      producerSlotScopes.pop();
      bindingScopes.pop();
      return;
    }
    if (
      ts.isFunctionExpression(node) ||
      ts.isArrowFunction(node) ||
      ts.isMethodDeclaration(node) ||
      ts.isGetAccessorDeclaration(node) ||
      ts.isSetAccessorDeclaration(node) ||
      ts.isConstructorDeclaration(node)
    ) {
      const bindingScope = new Set<string>();
      for (const parameter of node.parameters) addBindingNames(parameter.name, bindingScope);
      networkScopes.push(new Set());
      networkArrayScopes.push(new Set());
      capabilityScopes.push(new Map());
      producerSlotScopes.push(new Map());
      bindingScopes.push(bindingScope);
      if (node.body !== undefined) visit(node.body);
      networkScopes.pop();
      networkArrayScopes.pop();
      capabilityScopes.pop();
      producerSlotScopes.pop();
      bindingScopes.pop();
      return;
    }
    if (ts.isCatchClause(node)) {
      const bindingScope = new Set<string>();
      if (node.variableDeclaration !== undefined) {
        addBindingNames(node.variableDeclaration.name, bindingScope);
      }
      networkScopes.push(new Set());
      networkArrayScopes.push(new Set());
      capabilityScopes.push(new Map());
      producerSlotScopes.push(new Map());
      bindingScopes.push(bindingScope);
      visit(node.block);
      networkScopes.pop();
      networkArrayScopes.pop();
      capabilityScopes.pop();
      producerSlotScopes.pop();
      bindingScopes.pop();
      return;
    }
    if (ts.isBlock(node)) {
      const bindingScope = new Set<string>();
      collectDirectStatementBindings(node.statements, bindingScope);
      networkScopes.push(new Set());
      networkArrayScopes.push(new Set());
      capabilityScopes.push(new Map());
      producerSlotScopes.push(new Map());
      bindingScopes.push(bindingScope);
      node.forEachChild(visit);
      networkScopes.pop();
      networkArrayScopes.pop();
      capabilityScopes.pop();
      producerSlotScopes.pop();
      bindingScopes.pop();
      return;
    }
    if (
      ts.isForStatement(node) ||
      ts.isForInStatement(node) ||
      ts.isForOfStatement(node) ||
      ts.isWhileStatement(node) ||
      ts.isDoStatement(node) ||
      ts.isSwitchStatement(node)
    ) {
      const bindingScope = new Set<string>();
      if (
        (ts.isForStatement(node) || ts.isForInStatement(node) || ts.isForOfStatement(node)) &&
        node.initializer !== undefined &&
        ts.isVariableDeclarationList(node.initializer)
      ) {
        for (const declaration of node.initializer.declarations) {
          addBindingNames(declaration.name, bindingScope);
        }
      }
      if (ts.isSwitchStatement(node)) {
        for (const clause of node.caseBlock.clauses) {
          collectDirectStatementBindings(clause.statements, bindingScope);
        }
      }
      networkScopes.push(new Set());
      networkArrayScopes.push(new Set());
      capabilityScopes.push(new Map());
      producerSlotScopes.push(new Map());
      bindingScopes.push(bindingScope);
      node.forEachChild(visit);
      networkScopes.pop();
      networkArrayScopes.pop();
      capabilityScopes.pop();
      producerSlotScopes.pop();
      bindingScopes.pop();
      return;
    }
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
      bindingScopes.at(-1)!.add(node.name.text);
      producerSlotScopes.at(-1)!.set(node.name.text, producerSlotTypeFromAnnotation(node.type));
      const producerType = producerHandleTypeName(node.type);
      if (
        producerType !== undefined &&
        node.initializer !== undefined &&
        (producerCertainty(node.initializer) === 'non-producer' ||
          !producerTypeAcceptsKind(producerType, producerKindOfExpression(node.initializer)))
      ) {
        report(
          'CL1044',
          `${node.type!.getText(file.ast)} requires a combinator producer initializer.`,
          node,
        );
      }
      if (
        isNetworkType(node.type) &&
        node.initializer !== undefined &&
        isPairViewExpression(node.initializer)
      ) {
        report(
          'CL1042',
          'pair(a, b) is a read-only input view and cannot be stored as an owned Network.',
          node,
        );
      }
      if (
        isNetworkType(node.type) ||
        (node.initializer !== undefined &&
          !isProducerHandleType(node.type) &&
          (isNetworkExpression(node.initializer) || isProducerExpression(node.initializer)))
      ) {
        networkScopes.at(-1)!.add(node.name.text);
        capabilityScopes
          .at(-1)!
          .set(
            node.name.text,
            networkTypeFromAnnotation(node.type, file.ast)?.capability ??
              (node.initializer === undefined
                ? undefined
                : capabilityOfNetworkExpression(node.initializer)) ??
              'owned',
          );
      }
      if (
        isNetworkArrayType(node.type) ||
        (node.initializer !== undefined && isNetworkArrayExpression(node.initializer))
      ) {
        networkArrayScopes.at(-1)!.add(node.name.text);
      }
    }
    if (
      ts.isVariableDeclaration(node) &&
      (ts.isArrayBindingPattern(node.name) || ts.isObjectBindingPattern(node.name)) &&
      node.initializer !== undefined &&
      isNetworkExpression(node.initializer)
    ) {
      report(
        'CL1046',
        'A Network value cannot be destructured; return an explicit array or object of Networks.',
        node.initializer,
      );
    }
    if (ts.isReturnStatement(node) && node.expression !== undefined) {
      const owner = enclosingFunctionDeclaration(node);
      const producerType = producerHandleTypeName(owner?.type);
      if (
        producerType !== undefined &&
        (producerCertainty(node.expression) === 'non-producer' ||
          !producerTypeAcceptsKind(producerType, producerKindOfExpression(node.expression)))
      ) {
        report(
          'CL1044',
          `${producerType} function must return a compatible combinator producer, not a materialized Network or another value.`,
          node,
        );
      }
      if (isPairViewExpression(node.expression)) {
        report(
          'CL1042',
          'pair(a, b) is a read-only input view and cannot carry ownership across a return.',
          node,
        );
      }
      const capability = capabilityOfNetworkExpression(node.expression);
      if (capability === 'readonly' || capability === 'ref') {
        report(
          'CL1040',
          `A ${capability === 'readonly' ? 'Readonly<Network>' : 'Ref<Network>'} borrow cannot escape its function.`,
          node,
        );
      }
    }
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      const producerType = producerTypeForAssignment(node.left);
      if (
        producerType !== undefined &&
        (producerCertainty(node.right) === 'non-producer' ||
          !producerTypeAcceptsKind(producerType, producerKindOfExpression(node.right)))
      ) {
        report(
          'CL1044',
          `${producerType} assignment requires a compatible unmaterialized combinator producer.`,
          node.right,
        );
      }
    }
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.PlusEqualsToken &&
      isPairViewExpression(node.left)
    ) {
      report(
        'CL1042',
        'pair(a, b) is a read-only input view and cannot receive a producer attachment.',
        node.left,
      );
    }
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.PlusEqualsToken &&
      isNetworkExpression(node.left) &&
      capabilityOfNetworkExpression(node.left) !== 'readonly' &&
      producerCertainty(node.right) === 'non-producer'
    ) {
      diagnostics.push({
        code: 'CL1034',
        severity: 'error',
        message:
          'Network += requires a combinator producer; constants and Networks are not implicit attachments.',
        span: spanForNode(file, node),
      });
    }
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.PlusEqualsToken &&
      capabilityOfNetworkExpression(node.left) === 'readonly'
    ) {
      report('CL1038', 'Cannot attach a producer through Readonly<Network>.', node.left);
    }
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.PlusEqualsToken &&
      ((ts.isCallExpression(node.left) &&
        ts.isIdentifier(node.left.expression) &&
        node.left.expression.text === 'to') ||
        (ts.isElementAccessExpression(node.left) &&
          ts.isCallExpression(node.left.expression) &&
          ts.isIdentifier(node.left.expression.expression) &&
          node.left.expression.expression.text === 'to')) &&
      isDslBuiltin('to')
    ) {
      const destinationCall: ts.CallExpression = ts.isCallExpression(node.left)
        ? node.left
        : (node.left.expression as ts.CallExpression);
      if (destinationCall.arguments.length < 1 || destinationCall.arguments.length > 2) {
        report(
          'CL1021',
          'Free to(...) requires one or two Network destinations; bind a Signal with to(...)[SIGNAL].',
          destinationCall,
        );
      }
      for (const argument of destinationCall.arguments) {
        if (capabilityOfNetworkExpression(argument) === 'readonly') {
          report('CL1038', 'Cannot attach a producer through Readonly<Network>.', argument);
        }
      }
    }
    if (
      ts.isElementAccessExpression(node) &&
      isNetworkExpression(node.expression) &&
      !isNetworkArrayExpression(node.expression) &&
      isDefinitelyNonSignal(node.argumentExpression)
    ) {
      report(
        'CL1019',
        'Network selection requires a Signal or wildcard; array indices apply only to Network collections.',
        node,
      );
    }
    if (
      ts.isImportDeclaration(node) ||
      ts.isImportEqualsDeclaration(node) ||
      ts.isExportDeclaration(node) ||
      ts.isExportAssignment(node)
    ) {
      report(
        'CL1036',
        'Phase 3 elaboration accepts one self-contained source file; imports and exports are not supported yet.',
        node,
      );
    }
    if (
      ts.canHaveModifiers(node) &&
      ts
        .getModifiers(node)
        ?.some(
          ({ kind }) =>
            kind === ts.SyntaxKind.ExportKeyword || kind === ts.SyntaxKind.DefaultKeyword,
        )
    ) {
      report(
        'CL1036',
        'Phase 3 declarations cannot use export/default modifiers in a single-file elaboration.',
        node,
      );
    }
    if (
      (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) ||
      (ts.isMetaProperty(node) && node.keywordToken === ts.SyntaxKind.ImportKeyword)
    ) {
      report(
        'CL1036',
        'Dynamic import and import.meta are outside the Phase 3 module boundary.',
        node,
      );
    }
    if (
      (ts.isAwaitExpression(node) ||
        (ts.isForOfStatement(node) && node.awaitModifier !== undefined)) &&
      isTopLevelAwait(node)
    ) {
      report(
        'CL1036',
        'Top-level await is not supported by synchronous compile-time elaboration.',
        node,
      );
    }
    if (
      ts.isNewExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'Network' &&
      isDslBuiltin('Network') &&
      (node.arguments?.length ?? 0) !== 0
    ) {
      report('CL1035', 'new Network() does not accept constructor arguments.', node);
    }
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
      const name = node.expression.text;
      const hasSpreadArgument = node.arguments.some(ts.isSpreadElement);
      const declaration = resolveFunction(node.expression);
      const networkParameters = hasSpreadArgument ? undefined : networkParametersOf(declaration);
      if (networkParameters !== undefined) {
        for (const [index, parameter] of networkParameters.entries()) {
          if (parameter === undefined) continue;
          const argument = node.arguments[index];
          const expected = `${parameter.type.capability === 'readonly' ? 'Readonly<Network>' : parameter.type.capability === 'ref' ? 'Ref<Network>' : parameter.type.capability === 'move' ? 'Move<Network>' : 'Network'} parameter ${parameter.name}`;
          if (argument === undefined && !parameter.optional) {
            report('CL1047', `${expected} requires an argument.`, node);
          } else if (argument !== undefined && isDefinitelyInvalidNetworkArgument(argument)) {
            report(
              'CL1047',
              `${expected} requires a Network or a producer expression that can be materialized as one.`,
              argument,
            );
          }
        }
      }
      const producerParameters = hasSpreadArgument
        ? undefined
        : declaration?.parameters.map((parameter) => producerHandleTypeName(parameter.type));
      if (producerParameters !== undefined) {
        for (const [index, producerType] of producerParameters.entries()) {
          const argument = node.arguments[index];
          if (producerType !== undefined && argument === undefined) {
            report(
              'CL1044',
              `${producerType} parameter requires a combinator producer argument.`,
              node,
            );
            continue;
          }
          if (
            producerType !== undefined &&
            argument !== undefined &&
            (producerCertainty(argument) === 'non-producer' ||
              !producerTypeAcceptsKind(producerType, producerKindOfExpression(argument)))
          ) {
            report(
              'CL1044',
              `${producerType} parameter requires a compatible unmaterialized combinator producer.`,
              argument,
            );
          }
        }
      }
      if (
        name === 'Signal' &&
        isDslBuiltin(name) &&
        (node.arguments.length < 1 || node.arguments.length > 3)
      ) {
        report(
          'CL1019',
          'Signal(name) or Signal(type, name, quality?) requires one to three arguments.',
          node,
        );
      }
      if (
        name === 'Signal' &&
        isDslBuiltin(name) &&
        node.arguments.length >= 1 &&
        node.arguments.length <= 3 &&
        node.arguments.some(isDefinitelyNotString)
      ) {
        report('CL1019', 'Signal(...) arguments must evaluate to strings.', node);
      }
      if (
        name === 'IF' &&
        isDslBuiltin(name) &&
        (node.arguments.length < 2 || node.arguments.length > 3)
      ) {
        report(
          'CL1014',
          'IF(condition, thenOutput, elseOutput?) requires two or three arguments; use an array or object for multiple outputs in one branch.',
          node,
        );
      }
      if (
        name === 'to' &&
        isDslBuiltin(name) &&
        (node.arguments.length < 1 || node.arguments.length > 2)
      ) {
        report(
          'CL1021',
          'to(...) requires one or two Network destinations; bind a Signal with to(...)[SIGNAL].',
          node,
        );
      }
      if (name === 'pair' && isDslBuiltin(name) && node.arguments.length !== 2) {
        report('CL1042', 'pair(a, b) requires exactly two Network values.', node);
      }
      if (
        name === 'pair' &&
        isDslBuiltin(name) &&
        node.arguments.length === 2 &&
        ts.isIdentifier(node.arguments[0]!) &&
        ts.isIdentifier(node.arguments[1]!) &&
        node.arguments[0]!.text === node.arguments[1]!.text &&
        isNetworkExpression(node.arguments[0]!)
      ) {
        report('CL1042', 'pair(a, b) requires two distinct logical Networks.', node);
      }
      if (name === 'to' && isDslBuiltin(name) && node.arguments.some(isPairViewExpression)) {
        report('CL1042', 'pair(a, b) cannot be a to(...) destination.', node);
      }
    }
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const receiver = node.expression.expression;
      const method = node.expression.name.text;
      const hasSpread = node.arguments.some(ts.isSpreadElement);
      if (
        method === 'as' &&
        node.arguments.length === 1 &&
        (isProducerExpression(receiver) || isNetworkExpression(receiver))
      ) {
        report(
          'CL1043',
          '.as(...) is not part of the Producer API; bind an arithmetic output through destination[SIGNAL] or producer.to(destination, SIGNAL).',
          node,
        );
      }
      if ((method === 'then' || method === 'else') && ts.isCallExpression(receiver)) {
        const whenCall = receiver;
        if (
          ts.isIdentifier(whenCall.expression) &&
          whenCall.expression.text === 'when' &&
          isDslBuiltin('when') &&
          (whenCall.arguments.length !== 1 || node.arguments.length === 0)
        ) {
          report(
            'CL1014',
            `when(condition).${method}(output, ...) requires one condition and at least one output.`,
            node,
          );
        }
      }
      if (isProducerExpression(receiver)) {
        if (method === 'as' && node.arguments.length !== 1) {
          report('CL1031', '.as(SIGNAL) requires exactly one output Signal.', node);
        }
        if (
          method === 'at' &&
          !hasSpread &&
          node.arguments.length !== 2 &&
          node.arguments.length !== 3
        ) {
          report('CL1035', '.at(x, y, direction?) requires two or three arguments.', node);
        }
        if (
          method === 'to' &&
          !hasSpread &&
          (node.arguments.length < 1 || node.arguments.length > 3)
        ) {
          report(
            'CL1021',
            '.to(...) requires one or two Network destinations and an optional output Signal.',
            node,
          );
        }
        if (
          method === 'to' &&
          !hasSpread &&
          node.arguments.length === 3 &&
          isDefinitelyNotOutputSignal(node.arguments[2]!)
        ) {
          report(
            'CL1021',
            'The third .to(...) argument must be an output Signal, not another destination or ordinary value.',
            node.arguments[2]!,
          );
        }
      }
      if (
        method === 'take' &&
        !hasSpread &&
        isNetworkExpression(receiver) &&
        node.arguments.length !== 1
      ) {
        report('CL1037', '.take(source) requires exactly one source Network.', node);
      }
      if (method === 'take' && isNetworkExpression(receiver) && node.arguments.length === 1) {
        if (node.arguments.some(isPairViewExpression)) {
          report('CL1042', 'pair(a, b) cannot participate in .take(...).', node);
        }
        const destinationCapability = capabilityOfNetworkExpression(receiver);
        const sourceCapability = capabilityOfNetworkExpression(node.arguments[0]!);
        if (
          destinationCapability === 'readonly' ||
          destinationCapability === 'ref' ||
          sourceCapability === 'readonly' ||
          sourceCapability === 'ref'
        ) {
          report(
            'CL1039',
            'Network.take(...) requires owned destination and source values; borrows cannot be consumed.',
            node,
          );
        }
      }
      if (method === 'take' && isPairViewExpression(receiver)) {
        report('CL1042', 'pair(a, b) cannot participate in .take(...).', node);
      }
      if (method === 'to' && isProducerExpression(receiver)) {
        if (node.arguments.some(isPairViewExpression)) {
          report('CL1042', 'pair(a, b) cannot be a .to(...) destination.', node);
        }
        for (const argument of node.arguments) {
          if (capabilityOfNetworkExpression(argument) === 'readonly') {
            report('CL1038', 'Cannot attach a producer through Readonly<Network>.', argument);
          }
        }
      }
    }
    node.forEachChild(visit);
  };

  collectDirectStatementBindings(file.ast.statements, bindingScopes[0]!);
  file.ast.forEachChild(visit);
  return diagnostics;
}

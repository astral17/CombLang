import ts from 'typescript';

import type { Diagnostic, SourceSpan } from '@comblang/shared';

import { spanForNode, type ParsedSourceFile } from './parser.js';

export type DslValueType = 'network' | 'number' | 'boolean' | 'signal' | 'signal-value' | 'unknown';
type NetworkCapability = 'owned' | 'readonly' | 'ref' | 'move';
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

function networkCapabilityFromAnnotation(
  node: ts.TypeNode | undefined,
): NetworkCapability | undefined {
  if (node === undefined) return undefined;
  const text = node.getText().replaceAll(/\s/g, '');
  if (/^Network(?:<.+>)?$/.test(text)) return 'owned';
  const wrapper = /^(Readonly|Ref|Move)<Network(?:<.+>)?>$/.exec(text)?.[1];
  return wrapper === 'Readonly'
    ? 'readonly'
    : wrapper === 'Ref'
      ? 'ref'
      : wrapper === 'Move'
        ? 'move'
        : undefined;
}

function typeFromAnnotation(node: ts.TypeNode | undefined): DslValueType {
  if (node === undefined) return 'unknown';
  if (node.kind === ts.SyntaxKind.NumberKeyword) return 'number';
  if (node.kind === ts.SyntaxKind.BooleanKeyword) return 'boolean';
  return networkCapabilityFromAnnotation(node) === undefined ? 'unknown' : 'network';
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
  const functions = new Map<string, DslValueType>();

  for (const statement of file.ast.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name !== undefined) {
      functions.set(statement.name.text, typeFromAnnotation(statement.type));
    }
  }

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
      return functions.get(expression.expression.text) ?? 'unknown';
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
  const networkScopes: Set<string>[] = [new Set()];
  const networkArrayScopes: Set<string>[] = [new Set()];
  const capabilityScopes: Map<string, NetworkCapability>[] = [new Map()];
  const producerFunctions = new Set<string>();
  const producerParameterTypes = new Map<string, readonly (string | undefined)[]>();
  const dslBuiltinNames = new Set(['Signal', 'Network', 'CC', 'IF', 'to', 'when', 'pair']);
  const shadowedDslBuiltins = new Set<string>();

  const collectBindingShadows = (name: ts.BindingName): void => {
    if (ts.isIdentifier(name)) {
      if (dslBuiltinNames.has(name.text)) shadowedDslBuiltins.add(name.text);
      return;
    }
    for (const element of name.elements) {
      if (!ts.isOmittedExpression(element)) collectBindingShadows(element.name);
    }
  };
  const collectShadows = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) || ts.isParameter(node)) collectBindingShadows(node.name);
    if (
      (ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) &&
      node.name !== undefined &&
      dslBuiltinNames.has(node.name.text)
    ) {
      shadowedDslBuiltins.add(node.name.text);
    }
    node.forEachChild(collectShadows);
  };
  file.ast.forEachChild(collectShadows);
  const isDslBuiltin = (name: string): boolean =>
    dslBuiltinNames.has(name) && !shadowedDslBuiltins.has(name);

  const isNetworkType = (node: ts.TypeNode | undefined): boolean =>
    typeFromAnnotation(node) === 'network';
  const producerHandleTypeName = (node: ts.TypeNode | undefined): string | undefined => {
    const text = node?.getText(file.ast).replaceAll(/\s/g, '') ?? '';
    return ['Producer', 'DeciderCombinator', 'ArithmeticCombinator', 'ConstantCombinator'].includes(
      text,
    )
      ? text
      : undefined;
  };
  const isProducerHandleType = (node: ts.TypeNode | undefined): boolean =>
    producerHandleTypeName(node) !== undefined;
  const isNetworkArrayType = (node: ts.TypeNode | undefined): boolean => {
    const text = node?.getText(file.ast).replaceAll(/\s/g, '') ?? '';
    return (
      /^Network(?:<.+>)?\[\]$/.test(text) ||
      /^(?:Array|ReadonlyArray)<Network(?:<.+>)?>$/.test(text)
    );
  };
  for (const statement of file.ast.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name !== undefined) {
      if (isNetworkType(statement.type)) producerFunctions.add(statement.name.text);
      producerParameterTypes.set(
        statement.name.text,
        statement.parameters.map((parameter) => producerHandleTypeName(parameter.type)),
      );
    }
  }
  const lookupNetwork = (name: string): boolean => {
    for (let index = networkScopes.length - 1; index >= 0; index -= 1) {
      if (networkScopes[index]!.has(name)) return true;
    }
    return false;
  };
  const lookupNetworkArray = (name: string): boolean => {
    for (let index = networkArrayScopes.length - 1; index >= 0; index -= 1) {
      if (networkArrayScopes[index]!.has(name)) return true;
    }
    return false;
  };
  const lookupCapability = (name: string): NetworkCapability | undefined => {
    for (let index = capabilityScopes.length - 1; index >= 0; index -= 1) {
      const capability = capabilityScopes[index]!.get(name);
      if (capability !== undefined) return capability;
    }
    return undefined;
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
    return isNetworkExpression(node) ? 'owned' : undefined;
  };
  type ProducerCertainty = 'producer' | 'non-producer' | 'runtime';
  const producerCertainty = (node: ts.Expression): ProducerCertainty => {
    if (ts.isParenthesizedExpression(node)) return producerCertainty(node.expression);
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
          producerFunctions.has(node.expression.text)
          ? 'producer'
          : node.expression.text === 'Signal' && isDslBuiltin('Signal')
            ? 'non-producer'
            : 'runtime';
      }
      if (ts.isPropertyAccessExpression(node.expression)) {
        const method = node.expression.name.text;
        if (method === 'then') return 'producer';
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
      return undefined;
    }
    if (ts.isPropertyAccessExpression(node.expression)) {
      if (node.expression.name.text === 'then') return 'decider';
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
    if (ts.isFunctionDeclaration(node)) {
      const scope = new Set<string>();
      const arrayScope = new Set<string>();
      const capabilityScope = new Map<string, NetworkCapability>();
      for (const parameter of node.parameters) {
        if (ts.isIdentifier(parameter.name) && isNetworkType(parameter.type)) {
          scope.add(parameter.name.text);
          const capability = networkCapabilityFromAnnotation(parameter.type) ?? 'owned';
          capabilityScope.set(parameter.name.text, capability);
          if (capability === 'owned') {
            report(
              'CL1041',
              'A bare Network parameter has no implicit ownership mode; use Readonly<Network>, Ref<Network>, or Move<Network>.',
              parameter,
            );
          }
        }
        if (ts.isIdentifier(parameter.name) && isNetworkArrayType(parameter.type)) {
          arrayScope.add(parameter.name.text);
        }
      }
      networkScopes.push(scope);
      networkArrayScopes.push(arrayScope);
      capabilityScopes.push(capabilityScope);
      if (node.body !== undefined) visit(node.body);
      networkScopes.pop();
      networkArrayScopes.pop();
      capabilityScopes.pop();
      return;
    }
    if (ts.isBlock(node)) {
      networkScopes.push(new Set());
      networkArrayScopes.push(new Set());
      capabilityScopes.push(new Map());
      node.forEachChild(visit);
      networkScopes.pop();
      networkArrayScopes.pop();
      capabilityScopes.pop();
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
      networkScopes.push(new Set());
      networkArrayScopes.push(new Set());
      capabilityScopes.push(new Map());
      node.forEachChild(visit);
      networkScopes.pop();
      networkArrayScopes.pop();
      capabilityScopes.pop();
      return;
    }
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
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
            networkCapabilityFromAnnotation(node.type) ??
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
      const producerParameters = producerParameterTypes.get(name);
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
      if (name === 'CC' && isDslBuiltin(name) && node.arguments.length === 0) {
        report('CL1024', 'CC(...) requires at least one Signal output entry.', node);
      }
      if (name === 'IF' && isDslBuiltin(name) && node.arguments.length < 2) {
        report('CL1014', 'IF(condition, output, ...) requires a condition and output.', node);
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
      if (
        method === 'as' &&
        ts.isCallExpression(receiver) &&
        ts.isIdentifier(receiver.expression) &&
        producerFunctions.has(receiver.expression.text)
      ) {
        report(
          'CL1043',
          `.as(SIGNAL) cannot cross the Network return boundary of ${receiver.expression.text}(...); bind the producer output inside that function.`,
          node,
        );
      }
      if (method === 'then' && ts.isCallExpression(receiver)) {
        const whenCall = receiver;
        if (
          ts.isIdentifier(whenCall.expression) &&
          whenCall.expression.text === 'when' &&
          isDslBuiltin('when') &&
          (whenCall.arguments.length !== 1 || node.arguments.length === 0)
        ) {
          report(
            'CL1014',
            'when(condition).then(output, ...) requires one condition and at least one output.',
            node,
          );
        }
      }
      if (isProducerExpression(receiver)) {
        if (method === 'as' && node.arguments.length !== 1) {
          report('CL1031', '.as(SIGNAL) requires exactly one output Signal.', node);
        }
        if (method === 'at' && node.arguments.length !== 2 && node.arguments.length !== 3) {
          report('CL1035', '.at(x, y, direction?) requires two or three arguments.', node);
        }
        if (method === 'to' && (node.arguments.length < 1 || node.arguments.length > 3)) {
          report(
            'CL1021',
            '.to(...) requires one or two Network destinations and an optional output Signal.',
            node,
          );
        }
      }
      if (method === 'take' && isNetworkExpression(receiver) && node.arguments.length !== 1) {
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

  file.ast.forEachChild(visit);
  return diagnostics;
}

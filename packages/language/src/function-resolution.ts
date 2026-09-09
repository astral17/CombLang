import ts from 'typescript';

import type { ParsedSourceFile } from './parser.js';

type ScopeKind = 'source' | 'function' | 'block' | 'loop' | 'catch' | 'class';

interface Scope {
  readonly kind: ScopeKind;
  readonly parent: Scope | undefined;
  readonly bindings: Map<string, Binding>;
}

interface Binding {
  kind: 'function' | 'other' | 'ambiguous';
  declaration: ts.FunctionDeclaration | undefined;
  uncertain: boolean;
}

type CallableNode =
  | ts.FunctionExpression
  | ts.ArrowFunction
  | ts.MethodDeclaration
  | ts.GetAccessorDeclaration
  | ts.SetAccessorDeclaration
  | ts.ConstructorDeclaration;

function isAssignmentOperator(kind: ts.SyntaxKind): boolean {
  return kind >= ts.SyntaxKind.FirstAssignment && kind <= ts.SyntaxKind.LastAssignment;
}

/** Resolve lexical bindings directly from the already parsed AST. */
export function createFunctionResolver(
  file: ParsedSourceFile,
): (identifier: ts.Identifier) => ts.FunctionDeclaration | undefined {
  const sourceScope: Scope = {
    kind: 'source',
    parent: undefined,
    bindings: new Map(),
  };
  const scopeOfNode = new Map<ts.Node, Scope>();

  const createScope = (kind: ScopeKind, parent: Scope): Scope => ({
    kind,
    parent,
    bindings: new Map(),
  });

  const nearestVariableScope = (scope: Scope): Scope => {
    for (let current: Scope | undefined = scope; current !== undefined; current = current.parent) {
      if (current.kind === 'function' || current.kind === 'source') return current;
    }
    return sourceScope;
  };

  const declare = (
    scope: Scope,
    name: string,
    kind: 'function' | 'other',
    declaration: ts.FunctionDeclaration | undefined,
  ): void => {
    const existing = scope.bindings.get(name);
    if (existing === undefined) {
      scope.bindings.set(name, { kind, declaration, uncertain: false });
      return;
    }
    existing.kind = 'ambiguous';
    existing.declaration = undefined;
  };

  const bindIdentifier = (
    identifier: ts.Identifier,
    scope: Scope,
    kind: 'function' | 'other',
    declaration: ts.FunctionDeclaration | undefined,
  ): void => {
    scopeOfNode.set(identifier, scope);
    declare(scope, identifier.text, kind, declaration);
  };

  const bindName = (
    name: ts.BindingName,
    scope: Scope,
    kind: 'function' | 'other',
    declaration: ts.FunctionDeclaration | undefined,
  ): void => {
    if (ts.isIdentifier(name)) {
      bindIdentifier(name, scope, kind, declaration);
      return;
    }
    for (const element of name.elements) {
      if (!ts.isOmittedExpression(element)) {
        bindName(element.name, scope, kind, declaration);
      }
    }
  };

  const visitBindingInitializers = (name: ts.BindingName, scope: Scope): void => {
    if (ts.isIdentifier(name)) return;
    for (const element of name.elements) {
      if (ts.isOmittedExpression(element)) continue;
      if (element.propertyName !== undefined && ts.isComputedPropertyName(element.propertyName)) {
        visit(element.propertyName.expression, scope);
      }
      visitBindingInitializers(element.name, scope);
      if (element.initializer !== undefined) visit(element.initializer, scope);
    }
  };

  const visitParameter = (parameter: ts.ParameterDeclaration, scope: Scope): void => {
    bindName(parameter.name, scope, 'other', undefined);
    visitBindingInitializers(parameter.name, scope);
    if (parameter.type !== undefined) visit(parameter.type, scope);
    if (parameter.initializer !== undefined) visit(parameter.initializer, scope);
  };

  const visitFunctionBody = (node: ts.Block, functionScope: Scope): void => {
    const bodyScope = createScope('block', functionScope);
    scopeOfNode.set(node, functionScope);
    for (const statement of node.statements) {
      if (ts.isFunctionDeclaration(statement)) {
        visitFunctionDeclaration(statement, functionScope);
      } else {
        visit(statement, bodyScope);
      }
    }
  };

  const visitFunctionDeclaration = (node: ts.FunctionDeclaration, parentScope: Scope): void => {
    if (node.name !== undefined) bindIdentifier(node.name, parentScope, 'function', node);
    // Default parameter initializers execute outside the function body's lexical/var
    // environment, so they must not resolve declarations introduced by that body.
    const parameterScope = createScope('block', parentScope);
    const functionScope = createScope('function', parameterScope);
    scopeOfNode.set(node, parentScope);
    if (node.typeParameters !== undefined) {
      for (const parameter of node.typeParameters) visit(parameter, parentScope);
    }
    for (const parameter of node.parameters) visitParameter(parameter, parameterScope);
    if (node.type !== undefined) visit(node.type, parameterScope);
    if (node.body !== undefined) visitFunctionBody(node.body, functionScope);
  };

  const visitCallable = (node: CallableNode, parentScope: Scope): void => {
    const parameterScope = createScope('block', parentScope);
    const functionScope = createScope('function', parameterScope);
    scopeOfNode.set(node, parentScope);

    if (ts.isFunctionExpression(node) && node.name !== undefined) {
      bindIdentifier(node.name, parameterScope, 'other', undefined);
    } else if (
      (ts.isMethodDeclaration(node) ||
        ts.isGetAccessorDeclaration(node) ||
        ts.isSetAccessorDeclaration(node)) &&
      ts.isComputedPropertyName(node.name)
    ) {
      visit(node.name.expression, parentScope);
    }

    if (node.typeParameters !== undefined) {
      for (const parameter of node.typeParameters) visit(parameter, parentScope);
    }
    for (const parameter of node.parameters) visitParameter(parameter, parameterScope);
    if (node.type !== undefined) visit(node.type, parameterScope);
    if (ts.isArrowFunction(node) && !ts.isBlock(node.body)) {
      visit(node.body, functionScope);
    } else if (node.body !== undefined && ts.isBlock(node.body)) {
      visitFunctionBody(node.body, functionScope);
    } else if (node.body !== undefined) {
      visit(node.body, functionScope);
    }
  };

  const visitVariableDeclaration = (node: ts.VariableDeclaration, scope: Scope): void => {
    const declarationList = node.parent;
    const bindingScope =
      ts.isVariableDeclarationList(declarationList) &&
      (declarationList.flags & ts.NodeFlags.BlockScoped) === 0
        ? nearestVariableScope(scope)
        : scope;
    bindName(node.name, bindingScope, 'other', undefined);
    visitBindingInitializers(node.name, scope);
    if (node.type !== undefined) visit(node.type, scope);
    if (node.initializer !== undefined) visit(node.initializer, scope);
  };

  const visitBlock = (node: ts.Block, parentScope: Scope): void => {
    const blockScope = createScope('block', parentScope);
    scopeOfNode.set(node, parentScope);
    for (const statement of node.statements) visit(statement, blockScope);
  };

  const visitLoop = (
    node: ts.ForStatement | ts.ForInStatement | ts.ForOfStatement,
    parentScope: Scope,
  ): void => {
    const initializer = node.initializer;
    if (initializer === undefined) {
      if (ts.isForStatement(node)) {
        if (node.condition !== undefined) visit(node.condition, parentScope);
        if (node.incrementor !== undefined) visit(node.incrementor, parentScope);
      }
      visit(node.statement, parentScope);
      return;
    }
    const hasBlockBinding =
      ts.isVariableDeclarationList(initializer) &&
      (initializer.flags & ts.NodeFlags.BlockScoped) !== 0;
    const loopScope = hasBlockBinding ? createScope('loop', parentScope) : parentScope;
    scopeOfNode.set(node, parentScope);

    if (ts.isVariableDeclarationList(initializer)) {
      for (const declaration of initializer.declarations) visit(declaration, loopScope);
    } else {
      visit(initializer, loopScope);
    }
    if (ts.isForStatement(node)) {
      if (node.condition !== undefined) visit(node.condition, loopScope);
      if (node.incrementor !== undefined) visit(node.incrementor, loopScope);
    } else {
      visit(node.expression, loopScope);
    }
    visit(node.statement, loopScope);
  };

  const visitCatchClause = (node: ts.CatchClause, parentScope: Scope): void => {
    const catchScope = createScope('catch', parentScope);
    scopeOfNode.set(node, parentScope);
    if (node.variableDeclaration !== undefined) {
      visit(node.variableDeclaration, catchScope);
    }
    visit(node.block, catchScope);
  };

  const visitClassLike = (
    node: ts.ClassDeclaration | ts.ClassExpression,
    parentScope: Scope,
  ): void => {
    if (ts.isClassDeclaration(node) && node.name !== undefined) {
      bindIdentifier(node.name, parentScope, 'other', undefined);
    }
    const classScope = createScope('class', parentScope);
    scopeOfNode.set(node, parentScope);
    if (ts.isClassExpression(node) && node.name !== undefined) {
      bindIdentifier(node.name, classScope, 'other', undefined);
    }
    for (const clause of node.heritageClauses ?? []) visit(clause, parentScope);
    for (const member of node.members) visit(member, classScope);
  };

  const visitImportDeclaration = (node: ts.ImportDeclaration, scope: Scope): void => {
    const clause = node.importClause;
    if (clause === undefined) return;
    if (clause.name !== undefined) bindIdentifier(clause.name, scope, 'other', undefined);
    if (clause.namedBindings === undefined) return;
    if (ts.isNamespaceImport(clause.namedBindings)) {
      bindIdentifier(clause.namedBindings.name, scope, 'other', undefined);
      return;
    }
    for (const element of clause.namedBindings.elements) {
      bindIdentifier(element.name, scope, 'other', undefined);
    }
  };

  function visit(node: ts.Node, scope: Scope): void {
    scopeOfNode.set(node, scope);
    if (ts.isIdentifier(node)) return;
    if (ts.isSourceFile(node)) {
      for (const statement of node.statements) visit(statement, sourceScope);
      return;
    }
    if (ts.isFunctionDeclaration(node)) {
      visitFunctionDeclaration(node, scope);
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
      visitCallable(node, scope);
      return;
    }
    if (ts.isBlock(node)) {
      visitBlock(node, scope);
      return;
    }
    if (ts.isVariableDeclaration(node)) {
      visitVariableDeclaration(node, scope);
      return;
    }
    if (ts.isForStatement(node) || ts.isForInStatement(node) || ts.isForOfStatement(node)) {
      visitLoop(node, scope);
      return;
    }
    if (ts.isCatchClause(node)) {
      visitCatchClause(node, scope);
      return;
    }
    if (ts.isClassDeclaration(node) || ts.isClassExpression(node)) {
      visitClassLike(node, scope);
      return;
    }
    if (ts.isEnumDeclaration(node)) {
      if (node.name !== undefined) bindIdentifier(node.name, scope, 'other', undefined);
      for (const member of node.members) {
        if (member.initializer !== undefined) visit(member.initializer, scope);
      }
      return;
    }
    if (ts.isImportDeclaration(node)) {
      visitImportDeclaration(node, scope);
      return;
    }
    if (ts.isImportEqualsDeclaration(node)) {
      bindIdentifier(node.name, scope, 'other', undefined);
      visit(node.moduleReference, scope);
      return;
    }
    if (ts.isModuleDeclaration(node)) {
      if (ts.isIdentifier(node.name)) bindIdentifier(node.name, scope, 'other', undefined);
      const moduleScope = createScope('block', scope);
      if (node.body === undefined) return;
      if (ts.isModuleBlock(node.body)) {
        for (const statement of node.body.statements) visit(statement, moduleScope);
      } else {
        visit(node.body, moduleScope);
      }
      return;
    }
    if (ts.isSwitchStatement(node)) {
      visit(node.expression, scope);
      const switchScope = createScope('block', scope);
      visit(node.caseBlock, switchScope);
      return;
    }
    node.forEachChild((child) => visit(child, scope));
  }

  visit(file.ast, sourceScope);

  const lookup = (identifier: ts.Identifier): Binding | undefined => {
    let scope = scopeOfNode.get(identifier);
    if (scope === undefined) {
      for (
        let current: ts.Node | undefined = identifier.parent;
        current;
        current = current.parent
      ) {
        scope = scopeOfNode.get(current);
        if (scope !== undefined) break;
      }
    }
    for (let current: Scope | undefined = scope ?? sourceScope; current; current = current.parent) {
      const binding = current.bindings.get(identifier.text);
      if (binding !== undefined) return binding;
    }
    return undefined;
  };

  const markTarget = (node: ts.Node): void => {
    if (ts.isIdentifier(node)) {
      const binding = lookup(node);
      if (binding !== undefined) binding.uncertain = true;
      return;
    }
    if (ts.isParenthesizedExpression(node) || ts.isSpreadElement(node)) {
      markTarget(node.expression);
      return;
    }
    if (ts.isArrayLiteralExpression(node)) {
      for (const element of node.elements) {
        if (!ts.isOmittedExpression(element)) markTarget(element);
      }
      return;
    }
    if (ts.isObjectLiteralExpression(node)) {
      for (const property of node.properties) {
        if (ts.isShorthandPropertyAssignment(property)) {
          markTarget(property.name);
        } else if (ts.isPropertyAssignment(property)) {
          markTarget(property.initializer);
        } else if (ts.isSpreadAssignment(property)) {
          markTarget(property.expression);
        }
      }
      return;
    }
    if (ts.isBinaryExpression(node) && isAssignmentOperator(node.operatorToken.kind)) {
      markTarget(node.left);
    }
  };

  const markMutations = (node: ts.Node): void => {
    if (ts.isBinaryExpression(node) && isAssignmentOperator(node.operatorToken.kind)) {
      markTarget(node.left);
    } else if (
      (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) &&
      (node.operator === ts.SyntaxKind.PlusPlusToken ||
        node.operator === ts.SyntaxKind.MinusMinusToken)
    ) {
      markTarget(node.operand);
    } else if (ts.isForInStatement(node) || ts.isForOfStatement(node)) {
      if (!ts.isVariableDeclarationList(node.initializer)) markTarget(node.initializer);
    }
    node.forEachChild(markMutations);
  };

  markMutations(file.ast);

  return (identifier) => {
    const binding = lookup(identifier);
    return binding?.kind === 'function' &&
      !binding.uncertain &&
      binding.declaration?.body !== undefined
      ? binding.declaration
      : undefined;
  };
}

import ts from 'typescript';
import { describe, expect, test } from 'vitest';

import { parseFile } from './parser.js';
import { createFunctionResolver } from './function-resolution.js';
import { classifyDslSemantics, validateDslSemantics } from './semantic.js';

function callIdentifiers(file: ReturnType<typeof parseFile>, name: string): ts.Identifier[] {
  const identifiers: ts.Identifier[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === name
    ) {
      identifiers.push(node.expression);
    }
    node.forEachChild(visit);
  };
  file.ast.forEachChild(visit);
  return identifiers;
}

function functionDeclarations(
  file: ReturnType<typeof parseFile>,
  name: string,
): ts.FunctionDeclaration[] {
  const declarations: ts.FunctionDeclaration[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isFunctionDeclaration(node) && node.name?.text === name) declarations.push(node);
    node.forEachChild(visit);
  };
  file.ast.forEachChild(visit);
  return declarations;
}

describe('AST lexical function resolver', () => {
  test('resolves top-level and nested forward declarations at their call sites', () => {
    const file = parseFile({
      path: 'forward-functions.ts',
      text: `const top = Gate();
function Outer() {
  const nested = Local();
  function Local() { return 1; }
}
function Gate() { return 1; }`,
    });
    const resolve = createFunctionResolver(file);
    const declarations = functionDeclarations(file, 'Gate');
    const local = functionDeclarations(file, 'Local')[0];
    const calls = callIdentifiers(file, 'Gate');
    const localCall = callIdentifiers(file, 'Local')[0];

    expect(resolve(calls[0]!)).toBe(declarations[0]);
    expect(resolve(localCall!)).toBe(local);
  });

  test('uses the nearest lexical binding for parameters, declarations, classes, enums, catches, loops, and destructuring', () => {
    const file = parseFile({
      path: 'binding-shadows.ts',
      text: `function Gate() { return 1; }
function parameter(Gate: unknown) { Gate(); }
function letShadow() { { let Gate = 1; Gate(); } }
function constShadow() { { const Gate = 1; Gate(); } }
function classShadow() { class Gate {} Gate(); }
function enumShadow() { enum Gate { Value } Gate(); }
function functionShadow() { function Gate() { return 2; } Gate(); }
function catchShadow() { try {} catch (Gate) { Gate(); } }
function loopShadow(values: unknown[]) { for (let Gate of values) { Gate(); } }
function destructured({ Gate }: { Gate: unknown }) { Gate(); }`,
    });
    const resolve = createFunctionResolver(file);
    const calls = callIdentifiers(file, 'Gate');
    const nestedGate = functionDeclarations(file, 'Gate')[1];

    expect(calls).toHaveLength(9);
    expect(calls.slice(0, 5).map((call) => resolve(call))).toEqual([
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
    ]);
    expect(resolve(calls[5]!)).toBe(nestedGate);
    expect(calls.slice(6).map((call) => resolve(call))).toEqual([undefined, undefined, undefined]);
  });

  test('hoists var bindings through the whole function scope without poisoning an outer binding', () => {
    const file = parseFile({
      path: 'var-hoisting.ts',
      text: `function Gate() { return 1; }
function before() { Gate(); var Gate = () => 2; }
function after() { { var Gate = () => 3; } Gate(); }
function untouched() { { let Gate = 4; } Gate(); }
function Body() { return 1; }
function bodyConflict() { Body(); function Body() { return 2; } var Body = () => 3; }`,
    });
    const resolve = createFunctionResolver(file);
    const calls = callIdentifiers(file, 'Gate');
    const declaration = functionDeclarations(file, 'Gate')[0];

    expect(calls.map((call) => resolve(call))).toEqual([undefined, undefined, declaration]);
    expect(resolve(callIdentifiers(file, 'Body')[0]!)).toBeUndefined();
  });

  test('keeps body declarations out of default parameter initializers', () => {
    const file = parseFile({
      path: 'parameter-environment.ts',
      text: `function Outer(value = Local()) {
  function Local() { return 1; }
  const bodyValue = Local();
}`,
    });
    const resolve = createFunctionResolver(file);
    const calls = callIdentifiers(file, 'Local');
    const declaration = functionDeclarations(file, 'Local')[0];

    expect(resolve(calls[0]!)).toBeUndefined();
    expect(resolve(calls[1]!)).toBe(declaration);
  });

  test('marks direct, update, destructuring, and for-in/of mutations uncertain', () => {
    const file = parseFile({
      path: 'function-mutations.ts',
      text: `function Direct() { return 1; }
Direct = () => 2;
Direct();
function Updated() { return 1; }
Updated++;
Updated();
function ArrayTarget() { return 1; }
[ArrayTarget] = [() => 2];
ArrayTarget();
function ObjectTarget() { return 1; }
({ ObjectTarget } = { ObjectTarget: () => 2 });
ObjectTarget();
function Iterated() { return 1; }
for (Iterated of []) {}
Iterated();`,
    });
    const resolve = createFunctionResolver(file);

    for (const name of ['Direct', 'Updated', 'ArrayTarget', 'ObjectTarget', 'Iterated']) {
      const declaration = functionDeclarations(file, name)[0];
      expect(resolve(callIdentifiers(file, name)[0]!)).toBeUndefined();
      expect(declaration).toBeDefined();
    }
  });

  test('reassignment of a shadow does not poison a same-named outer function', () => {
    const file = parseFile({
      path: 'shadow-mutation.ts',
      text: `function Gate() { return 1; }
function Outer() {
  { let Gate = 1; Gate = 2; Gate(); }
  Gate();
}
Gate();`,
    });
    const resolve = createFunctionResolver(file);
    const declaration = functionDeclarations(file, 'Gate')[0];

    expect(callIdentifiers(file, 'Gate').map((call) => resolve(call))).toEqual([
      undefined,
      declaration,
      declaration,
    ]);
  });

  test('returns undefined for duplicate or unsupported value bindings', () => {
    const file = parseFile({
      path: 'ambiguous-functions.ts',
      text: `function Duplicate() { return 1; }
function Duplicate() { return 2; }
Duplicate();
function Overloaded(): number;
function Overloaded(): number { return 1; }
Overloaded();
function Imported() { return 1; }
import { Imported as importedValue } from './external.js';
import { Imported } from './other.js';
Imported();
function unsupportedValue() {
  const Local = function Local() { return 1; };
  Local();
}`,
    });
    const resolve = createFunctionResolver(file);

    expect(resolve(callIdentifiers(file, 'Duplicate')[0]!)).toBeUndefined();
    expect(resolve(callIdentifiers(file, 'Overloaded')[0]!)).toBeUndefined();
    expect(resolve(callIdentifiers(file, 'Imported')[0]!)).toBeUndefined();
    expect(resolve(callIdentifiers(file, 'Local')[0]!)).toBeUndefined();
  });

  test('uses only the parsed AST and never creates a TypeScript Program', () => {
    const file = parseFile({
      path: 'no-program.ts',
      text: `const value = Resolved();
function Resolved() { return 1; }`,
    });
    const resolve = createFunctionResolver(file);

    expect(resolve(callIdentifiers(file, 'Resolved')[0]!)).toBe(
      functionDeclarations(file, 'Resolved')[0],
    );
    expect(createFunctionResolver.toString()).not.toContain('createProgram');
    expect(createFunctionResolver.toString()).not.toContain('getTypeChecker');
    expect(createFunctionResolver.toString()).not.toContain('CompilerHost');
  });

  test('keeps semantic classification and validation aligned for nested shadows', () => {
    const file = parseFile({
      path: 'semantic-function-resolution.ts',
      text: `function Read(): Network { return new Network(); }
function Outer(Read: unknown) {
  const shadowed = Read();
}
const output = Read();
output += CC();`,
    });

    expect(validateDslSemantics(file)).toEqual([]);
    expect(classifyDslSemantics(file)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'network-declaration',
          text: 'output',
          valueType: 'network',
        }),
      ]),
    );
    expect(classifyDslSemantics(file)).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'network-declaration', text: 'shadowed' }),
      ]),
    );
  });
});

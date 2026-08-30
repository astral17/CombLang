import ts from 'typescript';
import { describe, expect, test } from 'vitest';

import { parseDslTypeAnnotation, parseDslTypeText } from './dsl-type-syntax.js';

describe('DSL type annotation syntax', () => {
  test.each([
    ['Network', { kind: 'network', capability: 'owned' }],
    ['Network<G>', { kind: 'network', capability: 'owned', color: 'green' }],
    ['Readonly < Network < R > >', { kind: 'network', capability: 'readonly', color: 'red' }],
    ['Ref<Network>', { kind: 'network', capability: 'ref' }],
    ['Move<Network<G>>', { kind: 'network', capability: 'move', color: 'green' }],
    ['ArithmeticCombinator', { kind: 'producer', producerType: 'ArithmeticCombinator' }],
    [
      'ReadonlyArray<DeciderCombinator>',
      {
        kind: 'array',
        readonly: true,
        element: { kind: 'producer', producerType: 'DeciderCombinator' },
      },
    ],
    [
      'Network<R>[]',
      {
        kind: 'array',
        readonly: false,
        element: { kind: 'network', capability: 'owned', color: 'red' },
      },
    ],
  ])('parses %s', (text, expected) => {
    expect(parseDslTypeText(text)).toEqual(expected);
  });

  test('reads an annotation from the TypeScript AST', () => {
    const source = ts.createSourceFile(
      'type.ts',
      'const value: Ref<Network<G>> = input;',
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    );
    const declaration = (source.statements[0] as ts.VariableStatement).declarationList
      .declarations[0]!;

    expect(parseDslTypeAnnotation(declaration.type, source)).toEqual({
      kind: 'network',
      capability: 'ref',
      color: 'green',
    });
  });
});

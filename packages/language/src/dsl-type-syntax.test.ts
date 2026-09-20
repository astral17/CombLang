import ts from 'typescript';
import { describe, expect, test } from 'vitest';

import {
  parseDslParameterContract,
  parseDslTypeAnnotation,
  parseDslTypeText,
} from './dsl-type-syntax.js';

describe('DSL type annotation syntax', () => {
  test.each([
    ['Network', { kind: 'network', capability: 'owned' }],
    ['NetworkSignal', { kind: 'network-signal' }],
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

  test('parses recursive executed parameter contracts without erasing member order', () => {
    const source = ts.createSourceFile(
      'parameter.ts',
      'function f(value?: (Readonly<Network<R>> | number)) {}',
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    );
    const parameter = (source.statements[0] as ts.FunctionDeclaration).parameters[0]!;

    expect(
      parseDslParameterContract(parameter.type, source, parameter.questionToken !== undefined),
    ).toEqual({
      kind: 'union',
      text: '(Readonly<Network<R>> | number) | undefined',
      members: [
        { kind: 'network', capability: 'readonly', color: 'red', text: 'Readonly<Network<R>>' },
        { kind: 'primitive', value: 'number', text: 'number' },
        { kind: 'primitive', value: 'undefined', text: 'undefined' },
      ],
    });
  });

  test('keeps NetworkSignal as a nominal executed contract inside a union', () => {
    const source = ts.createSourceFile(
      'network-signal-parameter.ts',
      'function f(value: NetworkSignal | number) {}',
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    );
    const parameter = (source.statements[0] as ts.FunctionDeclaration).parameters[0]!;

    expect(parseDslParameterContract(parameter.type, source)).toEqual({
      kind: 'union',
      text: 'NetworkSignal | number',
      members: [
        { kind: 'network-signal', text: 'NetworkSignal' },
        { kind: 'primitive', value: 'number', text: 'number' },
      ],
    });
  });
});

import ts from 'typescript';
import { parseFile } from '@comblang/language';
import { describe, expect, test, vi } from 'vitest';

import { transformFunctionBoundaryNode } from './elaboration-transform-functions.js';

function transformFunctions(text: string): string {
  const file = parseFile({ path: 'functions.factorio.ts', text });
  const transformer: ts.TransformerFactory<ts.SourceFile> = (transformationContext) => {
    const { factory } = transformationContext;
    const visit: ts.Visitor = (node) =>
      transformFunctionBoundaryNode(node, {
        factory,
        file,
        visit,
        dslCall: (name, arguments_) =>
          factory.createCallExpression(
            factory.createPropertyAccessExpression(factory.createIdentifier('__dsl'), name),
            undefined,
            arguments_,
          ),
        spanLiteral: (item) =>
          factory.createObjectLiteralExpression([
            factory.createPropertyAssignment(
              'start',
              factory.createNumericLiteral(item.getStart(file.ast)),
            ),
            factory.createPropertyAssignment('end', factory.createNumericLiteral(item.getEnd())),
          ]),
        transformParameter: (parameter) => parameter,
      }) ?? ts.visitEachChild(node, visit, transformationContext);
    return (node) => ts.visitNode(node, visit) as ts.SourceFile;
  };
  const transformed = ts.transform(file.ast, [transformer]);
  const code = ts.createPrinter().printFile(transformed.transformed[0]!);
  transformed.dispose();
  return code;
}

describe('elaboration function-boundary transform', () => {
  test('emits one prologue operation for every supported parameter capability', () => {
    const code = transformFunctions(`function Configure(
  plain,
  owned: Network<G>,
  read: Readonly<Network<R>>,
  write: Ref<Network<G>>,
  moved: Move<Network>,
  producer: ArithmeticCombinator
): Readonly<Network<G>> {
  return read;
}`);

    expect(code).toContain('__dsl.implicitNetworkParameter(plain, "plain", void 0');
    expect(code).toContain('__dsl.implicitNetworkParameter(owned, "owned", "green"');
    expect(code).toContain('__dsl.borrowParameter(read, "readonly", "read", "red"');
    expect(code).toContain('__dsl.borrowParameter(write, "ref", "write", "green"');
    expect(code).toContain('__dsl.moveParameter(moved, "moved", void 0');
    expect(code).toContain('__dsl.producerHandle(producer, "ArithmeticCombinator", "producer"');
    expect(code).toContain('return __dsl.returnNetwork(read, "readonly", "green"');
  });

  test('does not apply an outer declaration return contract inside a nested callback', () => {
    const code = transformFunctions(`function Pick(input: Readonly<Network>): Network {
  const callback = () => { return input; };
  return callback();
}`);

    expect(code.match(/__dsl\.returnNetwork/g)).toHaveLength(1);
    expect(code).toContain('return input;');
  });

  test('closes function frames after both a normal return and an exception', () => {
    const code = transformFunctions(`function Identity(value) { return value; }
function Fail() { throw new Error('failure'); }
const result = Identity(3);
try { Fail(); } catch {}`);
    const events: string[] = [];
    const dsl = {
      enterFunction: (name: string) => events.push(`enter:${name}`),
      parameterSource: (_index: number, span: unknown) => span,
      implicitNetworkParameter: (value: unknown) => {
        events.push('parameter');
        return value;
      },
      returnValue: (value: unknown) => {
        events.push('return');
        return value;
      },
      exitInstance: () => events.push('exit'),
    };

    const result = Function('__dsl', `"use strict"; ${code}; return result;`)(dsl);

    expect(result).toBe(3);
    expect(events).toEqual(['enter:Identity', 'parameter', 'return', 'exit', 'enter:Fail', 'exit']);
  });
});

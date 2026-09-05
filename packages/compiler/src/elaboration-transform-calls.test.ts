import ts from 'typescript';
import { describe, expect, test } from 'vitest';

import { transformCallOrElementNode } from './elaboration-transform-calls.js';

function transformCalls(text: string): string {
  const source = ts.createSourceFile(
    'calls.factorio.ts',
    text,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const transformer: ts.TransformerFactory<ts.SourceFile> = (transformationContext) => {
    const { factory } = transformationContext;
    const visit: ts.Visitor = (node) =>
      transformCallOrElementNode(node, {
        factory,
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
              factory.createNumericLiteral(item.getStart(source)),
            ),
            factory.createPropertyAssignment('end', factory.createNumericLiteral(item.getEnd())),
          ]),
        transformTestInstantiation: () => undefined,
      }) ?? ts.visitEachChild(node, visit, transformationContext);
    return (node) => ts.visitNode(node, visit) as ts.SourceFile;
  };
  const transformed = ts.transform(source, [transformer]);
  const code = ts.createPrinter().printFile(transformed.transformed[0]!);
  transformed.dispose();
  return code;
}

describe('elaboration call/member transform', () => {
  test('keeps optional operations native while transforming their descendants', () => {
    const code = transformCalls(`target?.method(inner()); target?.[key()]; target?.(argument());`);

    expect(code).toContain('target?.method(__dsl.invoke(inner');
    expect(code).toContain('target?.[__dsl.invoke(key');
    expect(code).toContain('target?.(__dsl.invoke(argument');
    expect(code).not.toContain('__dsl.prepareMember(target');
  });

  test('lowers direct DSL calls and preserves source-bearing ordinary spread arguments', () => {
    const code = transformCalls(
      `Signal("signal-A"); CC(value); IF(test, yes, no); fn(first, ...rest);`,
    );

    expect(code).toContain('__dsl.signal("signal-A"');
    expect(code).toContain('__dsl.constant(value');
    expect(code).toContain('__dsl.deciderBranches(test, yes, no');
    expect(code).toContain('__dsl.invoke(fn, [{ value: first, source:');
    expect(code).toContain('...__dsl.spreadCallArguments(rest');
  });

  test('recognizes both fluent decider branch forms before generic member calls', () => {
    const code = transformCalls(
      `when(test).then(a, b).else(c); when(other).else(fallback); object.method(value);`,
    );

    expect(code.match(/__dsl\.deciderBranches/g)).toHaveLength(2);
    expect(code).toContain('__dsl.deciderBranches(test, [a, b], [c]');
    expect(code).toContain('__dsl.deciderBranches(other, void 0, [fallback]');
    expect(code).toContain('__dsl.invokePrepared(__dsl.prepareMember(object, "method"');
  });

  test('instruments element reads but leaves write targets to assignment lowering', () => {
    const code = transformCalls(
      `const read = items[key]; items[key] = value; items[key]++; --items[key]; delete items[key];`,
    );

    expect(code.match(/__dsl\.element\(items, key/g)).toHaveLength(1);
    expect(code).toContain('items[key] = value');
    expect(code).toContain('items[key]++');
    expect(code).toContain('--items[key]');
    expect(code).toContain('delete items[key]');
  });
});

import ts from 'typescript';
import { describe, expect, test, vi } from 'vitest';

import { transformControlFlowNode } from './elaboration-transform-control-flow.js';

function transformControlFlow(text: string): string {
  const source = ts.createSourceFile(
    'control-flow.factorio.ts',
    text,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const transformer: ts.TransformerFactory<ts.SourceFile> = (transformationContext) => {
    const { factory } = transformationContext;
    const visit: ts.Visitor = (node) =>
      transformControlFlowNode(node, {
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
      }) ?? ts.visitEachChild(node, visit, transformationContext);
    return (node) => ts.visitNode(node, visit) as ts.SourceFile;
  };
  const transformed = ts.transform(source, [transformer]);
  const code = ts.createPrinter().printFile(transformed.transformed[0]!);
  transformed.dispose();
  return code;
}

describe('elaboration control-flow transform', () => {
  test('guards finite conditions while preserving an omitted for condition', () => {
    const code = transformControlFlow(`if (condition) yes(); else no();
const selected = condition ? yes() : no();
while (condition) break;
do work(); while (condition);
for (; condition;) break;
for (;;) break;`);

    expect(code.match(/__dsl\.controlTest\(condition/g)).toHaveLength(5);
    expect(code).toContain('for (;;)');
    expect(code).toContain('__dsl.enterLoop("while"');
    expect(code).toContain('__dsl.enterLoop("do"');
  });

  test('balances every executed iteration across continue, break, and throw', () => {
    const code = transformControlFlow(`const seen = [];
for (let i = 0; i < 3; i++) {
  seen.push(i);
  if (i === 1) continue;
}
try {
  for (const value of [4, 5]) {
    seen.push(value);
    if (value === 5) throw new Error('stop');
  }
} catch {}`);
    const events: string[] = [];
    const dsl = {
      controlTest: (value: unknown) => value,
      enterLoop: (name: string, value: unknown) => events.push(`enter:${name}:${String(value)}`),
      exitInstance: () => events.push('exit'),
    };

    const seen = Function('__dsl', `"use strict"; ${code}; return seen;`)(dsl) as number[];

    expect(seen).toEqual([0, 1, 2, 4, 5]);
    expect(events).toEqual([
      'enter:i:0',
      'exit',
      'enter:i:1',
      'exit',
      'enter:i:2',
      'exit',
      'enter:value:4',
      'exit',
      'enter:value:5',
      'exit',
    ]);
  });

  test('keeps condition evaluation before the guard and executes one conditional branch', () => {
    const code = transformControlFlow(`const order = __dsl.order;
function condition() { order.push('condition'); return false; }
function yes() { order.push('yes'); }
function no() { order.push('no'); return 7; }
const result = condition() ? yes() : no();`);
    const order: string[] = [];
    const controlTest = vi.fn((value: unknown) => {
      order.push('guard');
      return value;
    });

    const result = Function(
      '__dsl',
      `"use strict"; ${code}; return result;`,
    )({
      order,
      controlTest,
      enterLoop: vi.fn(),
      exitInstance: vi.fn(),
    });

    expect(result).toBe(7);
    expect(order).toEqual(['condition', 'guard', 'no']);
    expect(controlTest).toHaveBeenCalledOnce();
  });
});

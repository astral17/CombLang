import ts from 'typescript';
import { parseFile } from '@comblang/language';
import { describe, expect, test } from 'vitest';

import { analyzeElaborationTransform } from './elaboration-transform-analysis.js';

describe('elaboration transform analysis', () => {
  test('selects a hygienic runtime parameter and detects unsupported async syntax', () => {
    const file = parseFile({
      path: 'analysis-async.factorio.ts',
      text: `const __dsl = 1;
const __dsl_1 = 2;
async function run() { await Promise.resolve(); }`,
    });

    const analysis = analyzeElaborationTransform(file);

    expect(analysis.runtimeParameter).toBe('__dsl_2');
    expect(analysis.containsUnsupportedAsync).toBe(true);
  });

  test('collects declared and destructured Signal/Network bindings', () => {
    const file = parseFile({
      path: 'analysis-bindings.factorio.ts',
      text: `const A = Signal("virtual", "signal-A");
const input = new Network();
const constants = CC(1 * A);
const [left, { nested: right }] = [input, { nested: input }];
function read(values: Readonly<Network>[]) { return values[0]; }`,
    });

    const analysis = analyzeElaborationTransform(file);

    expect(analysis.signalNames).toEqual(new Set(['A']));
    expect(analysis.networkNames).toEqual(
      new Set(['input', 'constants', 'values', 'left', 'right']),
    );
  });

  test('resolves the nearest typed Producer slot for assignments and properties', () => {
    const file = parseFile({
      path: 'analysis-producer-slots.factorio.ts',
      text: `let slot: ArithmeticCombinator;
slot = input + 1;
{
  let slot: DeciderCombinator;
  slot = IF(input > 0, input);
}
let items: ConstantCombinator[] = [];
items[0] = CC();
let record: { gate: DeciderCombinator } = { gate: IF(input > 0, input) };
record.gate = IF(input > 0, input);`,
    });
    const analysis = analyzeElaborationTransform(file);
    const assignments: ts.BinaryExpression[] = [];
    const collect = (node: ts.Node): void => {
      if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
        assignments.push(node);
      }
      node.forEachChild(collect);
    };
    collect(file.ast);

    expect(
      assignments.map((assignment) =>
        analysis.producerTypeForAssignment(assignment.left, assignment),
      ),
    ).toEqual([
      'ArithmeticCombinator',
      'DeciderCombinator',
      'ConstantCombinator',
      'DeciderCombinator',
    ]);
  });
});

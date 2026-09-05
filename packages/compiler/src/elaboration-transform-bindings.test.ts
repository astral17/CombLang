import ts from 'typescript';
import { parseFile } from '@comblang/language';
import { describe, expect, test } from 'vitest';

import {
  createElaborationBindingTransform,
  type ElaborationBindingTransform,
} from './elaboration-transform-bindings.js';

function transformBindings(text: string, testContextName?: string): string {
  const file = parseFile({ path: 'bindings.factorio.ts', text });
  const transformer: ts.TransformerFactory<ts.SourceFile> = (transformationContext) => {
    const { factory } = transformationContext;
    let bindings: ElaborationBindingTransform;
    const visit: ts.Visitor = (node) => {
      if (ts.isParameter(node)) return bindings.transformParameter(node);
      if (ts.isVariableDeclaration(node)) return bindings.transformVariableDeclaration(node);
      if (
        ts.isNewExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === 'Network'
      ) {
        return bindings.transformNetworkConstruction(node);
      }
      if (ts.isCallExpression(node)) {
        const instantiated = bindings.transformTestInstantiation(node);
        if (instantiated !== undefined) return instantiated;
      }
      return ts.visitEachChild(node, visit, transformationContext);
    };
    bindings = createElaborationBindingTransform({
      factory,
      file,
      ...(testContextName === undefined ? {} : { testContextName }),
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
    });
    return (source) => ts.visitNode(source, visit) as ts.SourceFile;
  };
  const transformed = ts.transform(file.ast, [transformer]);
  const code = ts.createPrinter().printFile(transformed.transformed[0]!);
  transformed.dispose();
  return code;
}

describe('elaboration binding transform', () => {
  test('distinguishes a named Network binding from an anonymous nested construction', () => {
    const code = transformBindings(`const direct = new Network<R>();
const nested = keep(new Network<G>());`);

    expect(code).toContain('__dsl.network("direct", "red"');
    expect(code).toContain('__dsl.materialize(keep(__dsl.network(void 0, "green"');
    expect(code).toContain('() => direct');
    expect(code).not.toContain('() => nested, () => nested');
  });

  test('carries tuple and object member types into materialization descriptors and defaults', () => {
    const code =
      transformBindings(`let [first, , third = fallback]: [Network<G>, Network, ArithmeticCombinator] = source;
let { gate: renamed, output = fallback }: { gate: DeciderCombinator; output: Network<R> } = record;`);

    expect(code).toContain('__dsl.materializeArray(source');
    expect(code).toContain('{ name: "first", color: "green" }');
    expect(code).toContain('producerType: "ArithmeticCombinator"');
    expect(code).toContain('__dsl.materializeObject(record');
    expect(code).toContain('name: "renamed", property: "gate"');
    expect(code).toContain('producerType: "DeciderCombinator"');
    expect(code).toContain('name: "output", property: "output", color: "red"');
    expect(code).toContain('__dsl.producerHandle(fallback, "ArithmeticCombinator", "third"');
    expect(code).toContain('__dsl.materialize(fallback, "output", "red"');
  });

  test('gives bound test instances a stable name and unbound calls a source identity', () => {
    const code = transformBindings(
      `const dut = t.instantiate(Build, input);
use(t.instantiate(Build, input));`,
      't',
    );

    expect(code).toContain('__dsl.instantiate("dut", Build, input');
    expect(code).toMatch(/__dsl\.instantiate\("instance@\d+", Build, input/);
  });

  test('transforms identifier and destructuring parameter defaults through the same policy', () => {
    const code = transformBindings(`function Build(
  input: Network<G> = source,
  [fallback = source]: [fallback?: Network<R>] = []
) {}`);

    expect(code).toContain('input: Network<G> = __dsl.materialize(source, "input", "green"');
    expect(code).toContain('fallback = __dsl.materialize(source, "fallback", "red"');
  });
});

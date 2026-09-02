import { transformElaborationModule } from '@comblang/compiler/elaboration-transform';
import { parseFile } from '@comblang/language';
import { describe, expect, test } from 'vitest';

import { createDebugDocument, inspectDebugNetwork, type DebugDocument } from './debug-document.js';
import { elaborateDirectPlan } from './direct-plan.js';
import { executeElaborationProgram } from './elaboration-program.js';
import { runDirectPlanTests } from './test-runner.js';

function plan(text: string) {
  return executeElaborationProgram(
    transformElaborationModule(parseFile({ path: 'debug.factorio.ts', text })),
  );
}

describe('portable debug document', () => {
  test('preserves repeated scopes, physical IDs, configuration, placement and source spans', () => {
    const text = `function Stage(input: Readonly<Network>): Network {
  const output = new Network();
  const copy: ArithmeticCombinator = (input + 1).at(4, 6, 2);
  output += copy;
  return output;
}
const input = new Network();
const first = Stage(input);
const second = Stage(input);`;
    const execution = elaborateDirectPlan(plan(text));
    const graph = {
      ...execution.circuit.graph,
      producers: [...execution.circuit.graph.producers].reverse(),
    };
    const document = createDebugDocument(execution.debug, graph);
    expect(JSON.parse(JSON.stringify(document))).toEqual(document);
    expect(document.scopes.map(({ path }) => path)).toEqual([
      [],
      ['function Stage'],
      ['function Stage #2'],
    ]);
    const producers = document.scopes.flatMap(({ producers }) => producers);
    expect(producers[0]).toMatchObject({
      id: execution.debug.scope(['function Stage']).combinator('copy').id,
      name: 'copy',
      placement: { x: 4, y: 6, direction: 2 },
      inputs: [execution.network('input').id],
      outputs: [execution.debug.scope(['function Stage']).network('output').id],
      config: { operation: 'add', right: { kind: 'constant', value: 1 } },
    });
    expect(text.slice(producers[0]!.source.start, producers[0]!.source.end)).toContain('input + 1');
    expect(producers[1]!.outputs).toEqual([
      execution.debug.scope(['function Stage #2']).network('output').id,
    ]);
    expect(producers[0]!.config).not.toBe(graph.producers[1]!.config);
    expect(document.scopes[0]!.networks[0]).not.toBe(execution.debug.root.network('input'));
  });

  test('keeps all moved aliases and connected producer roles without first-match guessing', () => {
    const execution = elaborateDirectPlan(
      plan(`const input = new Network();
const destination = new Network();
const source = new Network();
source += input + 1;
destination.take(source);
const output: Network = destination * 2;`),
    );
    const document = createDebugDocument(execution.debug, execution.circuit.graph);
    const id = execution.network('destination').id;
    const inspected = inspectDebugNetwork(document, id);
    expect(inspected.bindings.map(({ name, moved }) => ({ name, moved }))).toEqual([
      { name: 'destination', moved: false },
      { name: 'source', moved: true },
    ]);
    expect(inspected.producers).toHaveLength(2);
    expect(inspected.producers[0]!.outputs).toContain(id);
    expect(inspected.producers[1]!.inputs).toContain(id);
  });

  test('records both-color and else-output dependencies, not only condition inputs', () => {
    const execution = elaborateDirectPlan(
      plan(`const red = new Network<R>();
const green = new Network<G>();
const output = new Network();
output += pair(red, green) + 0;
output += when(red > 0).then(red).else(green);`),
    );
    const document = createDebugDocument(execution.debug, execution.circuit.graph);
    expect(document.scopes[0]!.producers[0]!.inputs).toEqual([
      execution.network('red').id,
      execution.network('green').id,
    ]);
    expect(document.scopes[0]!.producers[1]!.inputs).toEqual(
      document.scopes[0]!.producers[0]!.inputs,
    );
  });

  test('transports snapshots and exact failed-query scope for each independent test', () => {
    const result = runDirectPlanTests(
      plan(`function Stage(input: Readonly<Network>): Network {
  return input + 1;
}
const input = new Network();
const output = Stage(input);`),
      `test('query', ({ execution }) => {
  execution.debug.root.child('function Stage').network('missing');
});
test('structure', ({ execution }) => {
  execution.structure(execution.debug.scope(['function Stage'])).toHaveProducerCounts({ arithmetic: 2 });
});
test('trace', ({ session, network }) => { session.trace(network('output')); });`,
    );
    expect(result).toMatchObject({ passed: 1, failed: 2 });
    for (const entry of result.results.slice(0, 2))
      expect(entry.debugScopePath).toEqual(['function Stage']);
    const transported = JSON.parse(JSON.stringify(result.results[2]!));
    const debug = transported.debug as DebugDocument;
    const inspected = inspectDebugNetwork(debug, transported.trace.targets[0].networkId);
    expect(inspected.producers).toHaveLength(1);
    expect(inspected.producers[0]!.outputs).toContain(transported.trace.targets[0].networkId);
    expect(result.results[0]!.debug).not.toBe(result.results[1]!.debug);
  });
});

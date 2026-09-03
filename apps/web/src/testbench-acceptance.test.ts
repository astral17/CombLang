import { readFileSync } from 'node:fs';

import { Signal } from '@comblang/factorio';
import { elaborateDirectPlan, runDirectPlanTests } from '@comblang/runtime';
import { TraceReader, type TestAssertionDetails } from '@comblang/simulator';
import { describe, expect, test } from 'vitest';

import { compileSource } from './compile-source.js';
import { buildTestTraceTable } from './test-trace-view.js';
import { runWebTests } from './web-test-runner.js';

const A = Signal('virtual', 'signal-A');
const rareA = Signal('virtual', 'signal-A', 'rare');

function example(name: string) {
  const base = new URL(`../../../examples/testbench-${name}/`, import.meta.url);
  const source = readFileSync(new URL('main.factorio.ts', base), 'utf8');
  const tests = readFileSync(new URL('circuit.test.js', base), 'utf8');
  const compiled = compileSource({ path: 'main.factorio.ts', text: source });
  expect(compiled.diagnostics).toEqual([]);
  expect(compiled.compilerDiagnostics.filter(({ severity }) => severity === 'error')).toEqual([]);
  if (compiled.plan === undefined) throw new Error('Acceptance fixture did not compile.');
  return { source, tests, plan: compiled.plan };
}

describe('Phase 5 executable acceptance examples', () => {
  test.each(['memo', 'object'])(
    '%s runs identically through Node and browser adapters without changing topology',
    (name) => {
      const { plan, tests } = example(name);
      const before = JSON.stringify(plan);
      const topology = JSON.stringify(elaborateDirectPlan(plan).circuit.graph);
      const node = runDirectPlanTests(plan, tests);
      const browser = structuredClone(runWebTests(plan, tests));
      expect(node.results.filter(({ status }) => status === 'failed')).toEqual([]);
      expect(node).toMatchObject({ passed: 3, failed: 0 });
      expect(browser).toEqual(JSON.parse(JSON.stringify(node)));
      expect(JSON.stringify(plan)).toBe(before);
      expect(JSON.stringify(elaborateDirectPlan(plan).circuit.graph)).toBe(topology);
    },
  );

  test('MemoCell quiet-tail replay keeps both qualities and the one-tick input delay', () => {
    const { plan, tests } = example('memo');
    const result = runWebTests(plan, tests).results[0]!;
    expect(result.status).toBe('passed');
    const reader = new TraceReader(JSON.parse(JSON.stringify(result.trace)));
    const output = reader.targets[1]!;
    const rows = [...reader.snapshots({ targets: [output.id], fromTick: 0, toTick: 8 })];
    expect(
      rows.map(({ values }) => {
        const value = values[0]!.value;
        return value.kind === 'known' ? [value.bus.get(A), value.bus.get(rareA)] : 'Unknown';
      }),
    ).toEqual([[0, 0], [0, 0], ...Array.from({ length: 7 }, () => [7, 3])]);
    const detail = buildTestTraceTable(reader, 0, 9, output.id);
    expect(detail.columns.map(({ label }) => label)).toEqual([
      'virtual/signal-A',
      'virtual/signal-A@rare',
    ]);
    expect(detail.rows.at(-1)!.cells.map(({ lines }) => lines[0])).toEqual(['7', '3']);
    expect(result.trace!.events.filter(({ target }) => target === output.id)).toHaveLength(2);
    expect(reader.endTick).toBe(8);
  });

  test('object trace distinguishes isolated mock output from the aggregated Network and model clock', () => {
    const { plan, tests } = example('object');
    const results = runWebTests(plan, tests).results;
    const mockReader = new TraceReader(results[1]!.trace!);
    const snapshot = [...mockReader.snapshots({ fromTick: 6, toTick: 6 })][0]!;
    const values = snapshot.values.map(({ value }) =>
      value.kind === 'known' ? value.bus.get(A) : 'Unknown',
    );
    expect(values).toEqual([6, 14, 5]);
    expect(mockReader.targets[2]!.kind).toBe('object-output');
    const modelReader = new TraceReader(results[2]!.trace!);
    const modelRows = [...modelReader.snapshots({ fromTick: 0, toTick: 4 })];
    expect(
      modelRows.map(({ values }) =>
        values.map(({ value }) => (value.kind === 'known' ? value.bus.get(A) : 'Unknown')),
      ),
    ).toEqual([
      [0, 0, 0, 0, 0, 0],
      [3, 0, 1, 0, 3, 0],
      [3, 3, 1, 2, 3, 3],
      [3, 6, 4, 2, 3, 6],
      [3, 9, 7, 8, 3, 9],
    ]);
  });

  test('missing object model reports the full physical Unknown chain at the assertion line', () => {
    const { plan, tests } = example('object');
    const testSource = `${tests}\ntest('intentional failure', ({ session, network }) => {
  probe(session, network);
  session.trace(network('output'));
  session.tick(3);
  session.expect(network('output')).toBeKnown();
});`;
    const result = runWebTests(plan, testSource).results.at(-1)!;
    expect(result).toMatchObject({
      status: 'failed',
      failureKind: 'assertion',
      trace: { endTick: 3 },
      details: { tick: 3, actual: 'Unknown' },
    });
    expect(testSource.split('\n')[result.line! - 1]).toContain(
      "session.expect(network('output')).toBeKnown()",
    );
    const producers = result
      .debug!.scopes.flatMap(({ producers }) => producers)
      .filter(({ producerKind }) => producerKind === 'arithmetic');
    const expectedPath = [
      'testbench:object:acceptance-probe:sensor',
      ...producers.map(({ id }) => id),
    ];
    expect((result.details as TestAssertionDetails).origins).toEqual([
      {
        id: 'unmodeled:acceptance-probe:sensor:circuit',
        description: 'Unmodeled output acceptance-probe:sensor:circuit',
        path: expectedPath,
      },
    ]);
    const reader = new TraceReader(result.trace!);
    const table = buildTestTraceTable(reader, 3, 1, reader.targets[0]!.id);
    expect(table.rows[0]!.cells[0]!.origins?.[0]!.path).toEqual(expectedPath);
  });

  test('oscillating feedback fails settle at the requested boundary and retains its trace', () => {
    const compiled = compileSource({
      path: 'oscillator.factorio.ts',
      text: `const A = Signal('virtual', 'signal-A');
const output = new Network();
output += IF(output[A] == 0, 1 * A);`,
    });
    expect(compiled.compilerDiagnostics).toEqual([]);
    const result = runWebTests(
      compiled.plan!,
      `test('oscillator', ({ network, session }) => {
  session.trace(network('output'));
  session.settle({ maxTicks: 6 });
});`,
    ).results[0]!;
    expect(result).toMatchObject({
      status: 'failed',
      failureKind: 'runtime',
      line: 3,
      message: 'Circuit did not settle within 6 ticks.',
      trace: { endTick: 6 },
    });
    const reader = new TraceReader(result.trace!);
    expect(
      [...reader.snapshots()].map(({ values }) => {
        const value = values[0]!.value;
        return value.kind === 'known' ? value.bus.get(A) : 'Unknown';
      }),
    ).toEqual([0, 1, 0, 1, 0, 1, 0]);
  });

  test('a returned existing Network is queryable by its caller binding without extra hardware', () => {
    const { plan } = example('memo');
    const before = elaborateDirectPlan(plan);
    const result = runWebTests(
      plan,
      `test('caller binding', ({ network, session }) => {
  session.trace(network('output'));
});`,
    );
    expect(result).toMatchObject({ passed: 1, failed: 0 });
    const after = elaborateDirectPlan(plan);
    expect(after.network('output').id).toBe(
      after.debug.root.child('function MemoCell').network('out').id,
    );
    expect(after.circuit.graph).toEqual(before.circuit.graph);
  });
});

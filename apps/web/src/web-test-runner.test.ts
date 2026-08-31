import { describe, expect, it } from 'vitest';

import { compileSource } from './compile-source.js';
import { runWebTests } from './web-test-runner.js';

const source = `const A = Signal("virtual", "signal-A");
const input = new Network();
const output = new Network();
output += input + 1;`;

function plan() {
  const compiled = compileSource({ path: 'test.factorio.ts', text: source });
  if (compiled.plan === undefined) throw new Error('Fixture did not compile.');
  return compiled.plan;
}

describe('browser test runner', () => {
  it('runs every test against a fresh elaborated circuit', () => {
    const run = runWebTests(
      plan(),
      `const A = Signal("virtual", "signal-A");
test("passes", ({ network, drive, tick, expectSignal }) => {
  drive(network("input"), [[A, 4]]);
  tick(2);
  expectSignal(network("output"), A).toBe(5);
});
test("fresh session", ({ network, expectSignal }) => {
  expectSignal(network("output"), A).toBe(0);
});`,
    );
    expect(run).toMatchObject({ passed: 2, failed: 0 });
  });

  it('reports assertion failures without preventing later tests', () => {
    const run = runWebTests(
      plan(),
      `const A = Signal("virtual", "signal-A");
test("fails", ({ network, expectSignal }) => {
  expectSignal(network("output"), A).toBe(99);
});
test("still runs", ({ network, expectSignal }) => {
  expectSignal(network("output"), A).toBe(0);
});`,
    );
    expect(run).toMatchObject({ passed: 1, failed: 1 });
    expect(run.results[0]).toMatchObject({
      name: 'fails',
      status: 'failed',
      line: 3,
      message: expect.stringContaining('Expected: 99'),
    });
    expect(run.results[1]).toMatchObject({ name: 'still runs', status: 'passed' });
  });

  it('turns test-file execution errors into a visible result', () => {
    const run = runWebTests(plan(), 'throw new Error("broken test file");');
    expect(run).toMatchObject({
      passed: 0,
      failed: 1,
      results: [{ name: 'Test file', status: 'failed', message: 'broken test file' }],
    });
  });
});

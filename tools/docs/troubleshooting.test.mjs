import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import { compileSourceProgram } from '../../packages/runtime/src/source-compilation.js';
import { runExecutedDirectPlanTests } from '../../packages/runtime/src/test-runner.js';

const pageUrl = new URL('../../docs/troubleshooting.md', import.meta.url);
const page = readFileSync(pageUrl, 'utf8');
const examples = [...page.matchAll(/```ts\r?\n([\s\S]*?)```/g)].map((match) => match[1]);
const cases = [
  ['numeric source', 'CL1034', 'error', 1],
  ['third output', 'RT2028', 'error', 3],
  ['fixed color union', 'RT2014', 'error', 0],
  ['consumed alias', 'RT2012', 'error', 2],
  ['readonly alias return', 'CL1040', 'error', 0],
  ['unused output', 'CL2001', 'warning', 1],
];
const compile = (text) => compileSourceProgram({ path: 'troubleshooting.factorio.ts', text });

describe('runnable troubleshooting examples', () => {
  test('keeps exactly one problematic/corrected pair per case', () => {
    expect(examples).toHaveLength(2 * cases.length);
  });
  describe.each(cases.map((entry, index) => [index, ...entry]))(
    '%i: %s',
    (index, _name, code, severity, correctedCount) => {
      test('pins the documented rejection or non-fatal warning and its source span', () => {
        const source = examples[2 * index];
        const result = compile(source);
        expect(result.pipelineDiagnostics).toEqual([expect.objectContaining({ code, severity })]);
        const span = result.pipelineDiagnostics[0].span;
        expect(span.fileId).toBe(result.fileId);
        expect(span.start).toBeGreaterThanOrEqual(0);
        expect(span.end).toBeGreaterThan(span.start);
        expect(span.end).toBeLessThanOrEqual(source.length);
        if (severity === 'error') expect(result.resolvedCircuit).toBeUndefined();
        else expect(result.resolvedCircuit.ir.producers).toHaveLength(1);
      });
      test('compiles the stated resolution with its explicit hardware count', () => {
        const result = compile(examples[2 * index + 1]);
        expect(result.pipelineDiagnostics).toEqual([]);
        expect(result.resolvedCircuit.ir.producers).toHaveLength(correctedCount);
      });
    },
  );
  test('verifies counts and timing rather than only successful compilation', () => {
    for (const [index, targets, ticks, value] of [
      [0, ['output'], 1, 5],
      [1, ['first', 'second', 'third'], 2, 10],
      [3, ['output'], 2, 5],
      [5, ['output'], 1, 5],
    ]) {
      const result = compile(examples[2 * index + 1]);
      expect(
        runExecutedDirectPlanTests(
          result.execution,
          `test('documented result', ({ network, tick, expectSignal }) => {
            const A = Signal('virtual', 'signal-A');
            tick(${ticks});
            for (const name of ${JSON.stringify(targets)}) {
              expectSignal(network(name), A).toBe(${value});
            }
          });`,
        ),
      ).toMatchObject({ passed: 1, failed: 0 });
    }
  });
  test('corrects the readonly alias only by its return annotation, with no delay or hardware', () => {
    const source = examples[9];
    expect(source).toContain('function Alias(input: Readonly<Network>): Readonly<Network>');
    expect(source).toBe(examples[8].replace('): Network', '): Readonly<Network>'));
    const result = compile(source);
    expect(result.pipelineDiagnostics).toEqual([]);
    expect(result.plan.networks).toHaveLength(1);
    expect(result.plan.producers).toEqual([]);
    expect(result.plan.networkTransfers).toEqual([]);
    expect(result.execution.network('output').id).toBe(result.execution.network('input').id);
  });
  test('keeps owner writes and shared reads but forbids writes or consumption through the result', () => {
    const source = examples[9];
    for (const [use, code] of [
      ['output += CC();', 'CL1038'],
      ['input.take(output);', 'CL1039'],
    ]) {
      expect(compile(`${source}\n${use}`).pipelineDiagnostics).toEqual([
        expect.objectContaining({ code, severity: 'error' }),
      ]);
    }
    const result = compile(`${source}
const A = Signal('virtual', 'signal-A');
input += CC(5 * A);
const doubled = new Network();
doubled[A] += output[A] * 2;`);
    expect(result.pipelineDiagnostics).toEqual([]);
    expect(result.resolvedCircuit.ir.producers).toHaveLength(2);
    expect(
      runExecutedDirectPlanTests(
        result.execution,
        `test('same wire, no alias delay', ({ network, tick, expectSignal }) => {
      const A = Signal('virtual', 'signal-A');
      tick(1);
      expectSignal(network('input'), A).toBe(5);
      expectSignal(network('output'), A).toBe(5);
      expectSignal(network('doubled'), A).toBe(0);
      tick(1);
      expectSignal(network('doubled'), A).toBe(10);
    });`,
      ),
    ).toMatchObject({ passed: 1, failed: 0 });
  });
  test('keeps local links and section anchors valid', () => {
    for (const [, href] of page.matchAll(/\]\(([^)]+)\)/g)) {
      const [path, anchor] = href.split('#');
      const target = path ? fileURLToPath(new URL(path, pageUrl)) : fileURLToPath(pageUrl);
      expect(existsSync(resolve(target)), href).toBe(true);
      if (!anchor) continue;
      const headings = [...readFileSync(target, 'utf8').matchAll(/^#{1,6} (.+)$/gm)].map(
        ([, title]) =>
          title
            .trim()
            .toLowerCase()
            .replace(/[^\p{L}\p{N}_\- ]/gu, '')
            .replace(/ /g, '-'),
      );
      expect(headings, href).toContain(anchor);
    }
  });
});

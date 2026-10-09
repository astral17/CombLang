import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import { compileSourceProgram } from '../../packages/runtime/src/source-compilation.js';
import { runExecutedDirectPlanTests } from '../../packages/runtime/src/test-runner.js';
import { loadPrototypeInputJson } from '../../packages/prototypes/src/input.js';
import { parseProjectProfile } from '../../apps/cli/src/project-profile.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const read = (name) => readFileSync(resolve(root, 'docs', name), 'utf8');
const blocks = (text, language) =>
  [...text.matchAll(new RegExp('```' + language + '\\r?\\n([\\s\\S]*?)```', 'g'))].map(
    (match) => match[1],
  );

function compile(text, expectedWarnings = []) {
  const compilation = compileSourceProgram({ path: 'guide.factorio.ts', text });
  expect(compilation.pipelineDiagnostics.map(({ code, severity }) => ({ code, severity }))).toEqual(
    expectedWarnings.map((code) => ({ code, severity: 'warning' })),
  );
  expect(compilation.execution).toBeDefined();
  expect(compilation.resolvedCircuit).toBeDefined();
  return compilation;
}

describe('runnable user documentation', () => {
  const basics = blocks(read('circuit-basics.md'), 'ts');
  const counts = [1, 3, 2, 2, 3, 4];
  test('keeps all six basics examples standalone', () => {
    expect(basics).toHaveLength(counts.length);
  });
  test.each(counts.map((count, index) => [index, count]))(
    'compiles basics example %i with %i physical combinators',
    (index, count) => {
      expect(compile(basics[index]).resolvedCircuit.ir.producers).toHaveLength(count);
    },
  );
  test('runs the literal getting-started test against its literal circuit', () => {
    const page = read('getting-started.md');
    const sources = blocks(page, 'ts');
    const tests = blocks(page, 'js');
    expect(sources).toHaveLength(1);
    expect(tests).toHaveLength(1);
    const compilation = compile(sources[0]);
    expect(compilation.resolvedCircuit.ir.producers).toHaveLength(3);
    expect(runExecutedDirectPlanTests(compilation.execution, tests[0])).toMatchObject({
      passed: 1,
      failed: 0,
    });
  });
  test('loads the literal environment metadata with every bundled dependency named', async () => {
    const examples = blocks(read('prototype-environment.md'), 'json');
    expect(examples).toHaveLength(2);
    const metadata = JSON.parse(examples[0]);
    expect(metadata).toEqual(
      JSON.parse(
        readFileSync(
          resolve(root, 'packages/prototypes/generated/space-age-2.1.17.metadata.json'),
          'utf8',
        ),
      ),
    );
    const loaded = await loadPrototypeInputJson(
      JSON.stringify({
        item: {
          'iron-plate': { type: 'item', name: 'iron-plate', stack_size: 100 },
        },
        fluid: {},
        recipe: {},
        quality: {},
        'recipe-category': {},
        'virtual-signal': {},
      }),
      { factorioDumpMetadata: examples[0] },
    );
    expect(loaded.format).toBe('factorio-data-raw');
    expect(loaded.database.environment).toMatchObject(metadata);
    expect(loaded.prototypes.stackSize('iron-plate')).toBe(100);
    expect(loaded.database.capabilities.entityCircuitCapabilities).toBe(false);
    expect(loaded.warnings.map(({ code }) => code)).toEqual(['PD2002']);
  });
  test('parses the literal data-only project without treating its placeholder as a real pin', () => {
    const project = parseProjectProfile(
      blocks(read('prototype-environment.md'), 'json')[1],
      'comblang.json',
    );
    expect(project).toEqual({
      schemaVersion: 1,
      source: 'main.factorio.ts',
      tests: 'circuit.test.js',
      prototypes: { path: 'data/prototypes.json', identity: '<reported identity>' },
    });
  });
  test('matches the loop guide count and tick claim', () => {
    const compilation = compile(basics[5]);
    expect(
      runExecutedDirectPlanTests(
        compilation.execution,
        `test('loop', ({ network, tick, expectSignal }) => {
          const A = Signal('virtual', 'signal-A');
          const output = network('output');
          expectSignal(output, A).toBe(0);
          tick(2);
          expectSignal(output, A).toBe(30);
        });`,
      ),
    ).toMatchObject({ passed: 1, failed: 0 });
  });
  test('compiles every Network API example and verifies transfer and pipeline timing', () => {
    const examples = blocks(read('api/network.md'), 'ts');
    expect(examples).toHaveLength(3);
    expect(compile(examples[0]).resolvedCircuit.ir.producers).toHaveLength(0);
    for (const [index, name, ticks, value] of [
      [1, 'first', 1, 5],
      [2, 'output', 2, 10],
    ]) {
      const compilation = compile(examples[index]);
      expect(compilation.resolvedCircuit.ir.producers).toHaveLength(2);
      expect(
        runExecutedDirectPlanTests(
          compilation.execution,
          `test('API timing', ({ network, tick, expectSignal }) => {
            const A = Signal('virtual', 'signal-A');
            const output = network('${name}');
            tick(${ticks});
            expectSignal(output, A).toBe(${value});
          });`,
        ),
      ).toMatchObject({ passed: 1, failed: 0 });
    }
  });
  test.each([
    ['api/signal.md', [0, 2, 1]],
    ['api/combinator.md', [2, 2, 2, 2]],
  ])('compiles complete examples from %s without hidden prerequisites', (name, counts) => {
    const examples = blocks(read(name), 'ts');
    expect(examples).toHaveLength(counts.length);
    for (const [index, count] of counts.entries()) {
      const expectedWarnings =
        name === 'api/combinator.md' && (index === 0 || index === 3) ? ['CL2001'] : [];
      const compilation = compile(examples[index], expectedWarnings);
      expect(compilation.resolvedCircuit.ir.producers).toHaveLength(count);
    }
  });
  test('checks quality-aware Signal selection and both Combinator output colors', () => {
    for (const [name, index, targets, expected] of [
      ['api/signal.md', 1, ['output'], 22],
      ['api/combinator.md', 1, ['output', 'mirror'], 10],
      ['api/combinator.md', 2, ['output'], 10],
      ['api/combinator.md', 3, ['output', 'mirror'], 10],
    ]) {
      const compilation = compile(
        blocks(read(name), 'ts')[index],
        name === 'api/combinator.md' && index === 3 ? ['CL2001'] : [],
      );
      const result = runExecutedDirectPlanTests(
        compilation.execution,
        `test('API output', ({ network, tick, expectSignal }) => {
          const A = Signal('virtual', 'signal-A');
          tick(2);
          for (const name of ${JSON.stringify(targets)}) {
            expectSignal(network(name), A).toBe(${expected});
          }
        });`,
      );
      expect(result).toMatchObject({ passed: 1, failed: 0 });
    }
  });
  test.each([
    'README.md',
    'getting-started.md',
    'circuit-basics.md',
    'api/network.md',
    'api/signal.md',
    'api/combinator.md',
    'prototype-environment.md',
    'prototype-normalization.md',
    'prototype-truth-sources.md',
  ])('keeps %s relative documentation targets and section anchors valid', (name) => {
    for (const [, href] of read(name).matchAll(/\]\(([^)]+)\)/g)) {
      if (/^[a-z]+:|^\//i.test(href)) continue;
      const [path, anchor] = href.split('#');
      const target = path
        ? resolve(root, 'docs', dirname(name), path)
        : resolve(root, 'docs', name);
      expect(existsSync(target), `${name}: ${href}`).toBe(true);
      if (!anchor) continue;
      const headings = [...readFileSync(target, 'utf8').matchAll(/^#{1,6} (.+)$/gm)].map(
        ([, title]) =>
          title
            .trim()
            .toLowerCase()
            .replace(/[^\p{L}\p{N}_\- ]/gu, '')
            .replace(/ /g, '-'),
      );
      expect(headings, `${name}: ${href}`).toContain(anchor);
    }
  });
});

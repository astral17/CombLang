import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  loadPrototypeDatabase,
  syntheticPrototypeDatabase,
  validatePrototypeDatabase,
} from '@comblang/prototypes';

import { run } from './main.js';

const temporaryDirectories: string[] = [];

async function sourceFile(text: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'comblang-cli-'));
  temporaryDirectories.push(directory);
  const path = join(directory, 'main.factorio.ts');
  await writeFile(path, text, 'utf8');
  return path;
}

async function circuitTestFiles(
  source: string,
  tests: string,
): Promise<readonly [source: string, tests: string]> {
  const directory = await mkdtemp(join(tmpdir(), 'comblang-cli-test-'));
  temporaryDirectories.push(directory);
  const sourcePath = join(directory, 'main.factorio.ts');
  const testPath = join(directory, 'circuit.test.js');
  await Promise.all([writeFile(sourcePath, source, 'utf8'), writeFile(testPath, tests, 'utf8')]);
  return [sourcePath, testPath];
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

describe('factorio-dsl check', () => {
  test('uses an explicitly injected prototype environment', async () => {
    const path = await sourceFile(`const PLATE = Signal(prototypes.item['iron-plate'].name);
const source = CC(prototypes.item['iron-plate'].stackSize * PLATE);`);
    const { prototypes } = await loadPrototypeDatabase(syntheticPrototypeDatabase());
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    expect(await run(['check', '--json', path], { prototypes })).toBe(0);
    expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toMatchObject({
      diagnostics: [],
      producerCount: 1,
    });
  });

  test('rejects a reserved DSL binding before executed elaboration', async () => {
    const path = await sourceFile(`const CC = () => 123;
CC();`);
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    expect(await run(['check', '--json', path])).toBe(1);
    const result = JSON.parse(String(log.mock.calls[0]?.[0]));
    expect(result.diagnostics).toEqual([
      expect.objectContaining({ code: 'CL1045', severity: 'error', span: expect.any(Object) }),
    ]);
    expect(result.producerCount).toBe(0);
  });

  test('runs executed circuit validation and reports producer totals as JSON', async () => {
    const path = await sourceFile(`const CHEST = Signal("chest");
const input = CC(5 * CHEST);`);
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    expect(await run(['check', '--json', path])).toBe(0);
    expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toMatchObject({
      diagnostics: [],
      producerCount: 1,
    });
  });

  test('reports executed capability descriptors as JSON audit data', async () => {
    const path = await sourceFile(`function Scale(input: Readonly<Network<R>>): Network {
  return input + 1;
}
const input = new Network<R>();
const output: Network = Scale(input);`);
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    expect(await run(['check', '--json', path])).toBe(0);
    expect(JSON.parse(String(log.mock.calls[0]?.[0])).capabilityUses).toMatchObject([
      { network: 'input', capability: 'readonly', parameter: 'input', fixedColor: 'red' },
    ]);
  });

  test('reports successful transfer and pair descriptors as JSON audit data', async () => {
    const path = await sourceFile(`const A = Signal("virtual", "signal-A");
const red = new Network<R>();
const green = new Network<G>();
const observed: Network = pair(red, green)[A] + 0;
const destination = new Network();
const source = new Network();
destination.take(source);`);
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    expect(await run(['check', '--json', path])).toBe(0);
    const result = JSON.parse(String(log.mock.calls[0]?.[0]));
    expect(result.networkPairs).toMatchObject([{ networks: ['red', 'green'] }]);
    expect(result.networkTransfers).toMatchObject([
      { destination: 'destination', source: 'source' },
    ]);
  });

  test('reports semantic errors in branches that execution would skip', async () => {
    const path = await sourceFile(`const output = new Network();
if (false) {
  output += 5;
}`);
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    expect(await run(['check', path])).toBe(1);
    expect(String(error.mock.calls[0]?.[0])).toContain(
      '3:3 - error CL1034: Network += requires a combinator producer',
    );
  });

  test('preserves structured ownership diagnostics from executed aliases', async () => {
    const path = await sourceFile(`const destination = new Network();
const source = new Network();
const aliases = [source];
destination.take(source);
const output: Network = aliases[0] + 1;`);
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    expect(await run(['check', '--json', path])).toBe(1);
    const result = JSON.parse(String(log.mock.calls[0]?.[0]));
    expect(result.diagnostics).toEqual([
      expect.objectContaining({ code: 'RT2012', severity: 'error', related: expect.any(Array) }),
    ]);
  });

  test('reports runtime borrow conflicts that conservative semantics cannot prove', async () => {
    const path = await sourceFile(`const network = new Network();
function Invalid(_read: Readonly<Network>): void {
  network += CC(1 * Signal("virtual", "signal-A"));
}
Invalid(network);`);
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    expect(await run(['check', '--json', path])).toBe(1);
    const result = JSON.parse(String(log.mock.calls[0]?.[0]));
    expect(result.diagnostics).toEqual([
      expect.objectContaining({ code: 'RT2016', severity: 'error', related: expect.any(Array) }),
    ]);
  });

  test('reports caller-side use after a Move parameter transfer', async () => {
    const path = await sourceFile(`function Pass(input: Move<Network>): Network { return input; }
const input = new Network();
const result = Pass(input);
const output: Network = input + 1;`);
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    expect(await run(['check', '--json', path])).toBe(1);
    const result = JSON.parse(String(log.mock.calls[0]?.[0]));
    expect(result.diagnostics).toEqual([
      expect.objectContaining({ code: 'RT2012', severity: 'error', related: expect.any(Array) }),
    ]);
  });

  test('reports a duplicate to(...) destination at the attachment statement', async () => {
    const statement = 'to(a, a) += input + 0;';
    const path = await sourceFile(`const input = new Network();
const a = new Network();
${statement}`);
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    expect(await run(['check', '--json', path])).toBe(1);
    const result = JSON.parse(String(log.mock.calls[0]?.[0]));
    expect(result.diagnostics).toEqual([
      expect.objectContaining({ code: 'RT2004', severity: 'error', span: expect.any(Object) }),
    ]);
  });

  test('checks a both-colors pair input through the executed pipeline', async () => {
    const path = await sourceFile(`const A = Signal("virtual", "signal-A");
const red: Network<R> = CC(2 * A);
const green: Network<G> = CC(3 * A);
const output: Network = pair(red, green)[A] + 0;`);
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    expect(await run(['check', '--json', path])).toBe(0);
    expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toMatchObject({
      diagnostics: [],
      producerCount: 3,
    });
  });

  test('checks stored combinators and selected free fan-out destinations', async () => {
    const path = await sourceFile(`const A = Signal("virtual", "signal-A");
const input = new Network();
let comb: DeciderCombinator = when(input > 0).then(input);
const first = new Network();
const second = new Network();
to(first, second)[A] += comb;`);
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    expect(await run(['check', '--json', path])).toBe(0);
    expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toMatchObject({
      diagnostics: [],
      producerCount: 1,
    });
  });

  test('reports a materialized Network at its combinator return statement', async () => {
    const path = await sourceFile(`function test(input: Readonly<Network>): ArithmeticCombinator {
  let tmp = input + 0;
  return tmp;
}
const input = new Network();
const output = test(input);`);
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    expect(await run(['check', path])).toBe(1);
    expect(String(error.mock.calls[0]?.[0])).toContain(
      '3:3 - error CL1044: ArithmeticCombinator function must return',
    );
  });

  test('keeps a producer stored in a dynamic container slot live', async () => {
    const path = await sourceFile(`function test(input: Readonly<Network>): ArithmeticCombinator {
  let tmp = [];
  tmp[1] = input + 0;
  return tmp[1];
}
const input = new Network();
const output: Network = test(input);`);
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    expect(await run(['check', '--json', path])).toBe(0);
    expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toMatchObject({
      diagnostics: [],
      producerCount: 1,
    });
  });

  test('reports repeated Producer attachment through a fluent alias', async () => {
    const path = await sourceFile(`const A = Signal('virtual', 'signal-A');
const input = new Network();
const producer: ArithmeticCombinator = input + 0;
const configured: ArithmeticCombinator = producer.at(1, 2);
const first = new Network();
const second = new Network();
first += producer;
second += configured;`);
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    expect(await run(['check', '--json', path])).toBe(1);
    expect(JSON.parse(String(log.mock.calls[0]?.[0])).diagnostics).toEqual([
      expect.objectContaining({ code: 'RT2006', related: expect.any(Array) }),
    ]);
  });

  test('warns only after execution for an unused producer in a container', async () => {
    const path = await sourceFile(`const input = new Network();
const tmp = [];
tmp[1] = input + 0;`);
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    expect(await run(['check', '--json', path])).toBe(0);
    expect(JSON.parse(String(log.mock.calls[0]?.[0])).diagnostics).toEqual([
      expect.objectContaining({ code: 'CL2001', severity: 'warning' }),
    ]);
  });

  test('passes a stored Producer through a concrete function parameter', async () => {
    const path = await sourceFile(`function Identity(value: ArithmeticCombinator): Producer {
  return value;
}
const input = new Network();
const producer: ArithmeticCombinator = input + 0;
const output: Network = Identity(producer);`);
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    expect(await run(['check', '--json', path])).toBe(0);
    expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toMatchObject({
      diagnostics: [],
      producerCount: 1,
    });
  });

  test('checks concrete Producer types through container destructuring', async () => {
    const path = await sourceFile(`const input = new Network();
const arithmetic: ArithmeticCombinator = input + 0;
const decider: DeciderCombinator = when(input > 0).then(input);
const values = [arithmetic, decider];
let [firstProducer, secondProducer]: [ArithmeticCombinator, DeciderCombinator] = values;
const first = new Network();
const second = new Network();
first += firstProducer;
second += secondProducer;`);
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    expect(await run(['check', '--json', path])).toBe(0);
    expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toMatchObject({
      diagnostics: [],
      producerCount: 2,
    });
  });

  test('checks concrete Producer types on later typed slot assignments', async () => {
    const path = await sourceFile(`const input = new Network();
let direct: ArithmeticCombinator;
direct = input + 0;
let slots: DeciderCombinator[] = [];
slots[0] = when(input > 0).then(input);
const first = new Network();
const second = new Network();
first += direct;
second += slots[0];`);
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    expect(await run(['check', '--json', path])).toBe(0);
    expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toMatchObject({
      diagnostics: [],
      producerCount: 2,
    });
  });

  test('reports a structured output Signal conflict from fluent attachment', async () => {
    const path = await sourceFile(`const A = Signal('virtual', 'signal-A');
const B = Signal('virtual', 'signal-B');
const input = new Network();
const output = new Network();
IF(input[A] > 0, input[A]).to(output, B);`);
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    expect(await run(['check', '--json', path])).toBe(1);
    expect(JSON.parse(String(log.mock.calls[0]?.[0])).diagnostics).toEqual([
      expect.objectContaining({ code: 'RT2023', severity: 'error', related: expect.any(Array) }),
    ]);
  });

  test('accepts ordinary assignment as moved container-slot replacement', async () => {
    const path = await sourceFile(`function Advance(input: Move<Network>): Network {
  input += input + 1;
  return input;
}
const stages: Network[] = [new Network()];
stages[0] = Advance(stages[0]);
const output: Network = stages[0] + 1;`);
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    expect(await run(['check', '--json', path])).toBe(0);
    expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toMatchObject({
      diagnostics: [],
      producerCount: 2,
    });
  });
});

describe('factorio-dsl prototypes normalize', () => {
  test('writes a validated Prototype DB from a native dump and explicit metadata', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'comblang-prototype-dump-'));
    temporaryDirectories.push(directory);
    const dumpPath = join(directory, 'data-raw-dump.json');
    const metadataPath = join(directory, 'metadata.json');
    const outputPath = join(directory, 'prototypes.json');
    await Promise.all([
      writeFile(
        dumpPath,
        JSON.stringify({
          item: { plate: { type: 'item', name: 'plate', stack_size: 100 } },
          fluid: { water: { type: 'fluid', name: 'water' } },
          recipe: {
            plate: {
              type: 'recipe',
              name: 'plate',
              ingredients: [],
              results: [{ type: 'item', name: 'plate', amount: 1 }],
            },
          },
          'recipe-category': {
            crafting: { type: 'recipe-category', name: 'crafting' },
          },
          quality: { normal: { type: 'quality', name: 'normal', level: 0 } },
          'virtual-signal': {
            'signal-A': { type: 'virtual-signal', name: 'signal-A' },
          },
        }),
        'utf8',
      ),
      writeFile(
        metadataPath,
        JSON.stringify({
          factorioVersion: '2.1.16',
          expansions: [],
          mods: [{ name: 'base', version: '2.1.16' }],
        }),
        'utf8',
      ),
    ]);
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    expect(await run(['prototypes', 'normalize', dumpPath, metadataPath, outputPath])).toBe(0);
    const database = validatePrototypeDatabase(JSON.parse(await readFile(outputPath, 'utf8')));
    expect(database.items).toEqual([{ key: 'item:plate', name: 'plate', stackSize: 100 }]);
    expect(database.recipes[0]).toMatchObject({ categories: ['crafting'], energy: 0.5 });
    expect(String(log.mock.calls[0]?.[0])).toContain('1 item(s), 1 recipe(s)');
  });
});

describe('factorio-dsl test', () => {
  test('returns shared structured results and trace documents as JSON', async () => {
    const [sourcePath, testPath] = await circuitTestFiles(
      `const A = Signal("virtual", "signal-A");
const input = new Network();
const output: Network = input + 1;`,
      `const A = Signal("virtual", "signal-A");
test("traced pass", ({ network, drive, tick, expectSignal, session }) => {
  session.trace(network("output"));
  drive(network("input"), [[A, 4]]);
  tick(2);
  expectSignal(network("output"), A).toBe(5);
});
test("debug failure", ({ execution }) => {
  execution.debug.root.network("missing");
});`,
    );
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    expect(await run(['test', '--json', sourcePath, testPath])).toBe(1);
    const result = JSON.parse(String(log.mock.calls[0]?.[0]));
    expect(result.diagnostics).toEqual([]);
    expect(result.tests).toMatchObject({ passed: 1, failed: 1 });
    expect(result.tests.results[0]).toMatchObject({
      name: 'traced pass',
      status: 'passed',
      trace: {
        format: 'comblang-trace',
        version: 1,
        targets: [{ kind: 'network' }],
      },
    });
    expect(result.tests.results[1]).toMatchObject({
      name: 'debug failure',
      status: 'failed',
      failureKind: 'debug-query',
      code: 'DBG1001',
      candidates: expect.any(Array),
    });
  });

  test('does not execute a test file when circuit compilation fails', async () => {
    const [sourcePath, testPath] = await circuitTestFiles(
      'const output = new Network();\noutput += 5;',
      'throw new Error("must not run");',
    );
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    expect(await run(['test', '--json', sourcePath, testPath])).toBe(1);
    const result = JSON.parse(String(log.mock.calls[0]?.[0]));
    expect(result.diagnostics).not.toEqual([]);
    expect(result).not.toHaveProperty('tests');
  });
});

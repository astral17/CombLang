import { describe, expect, test } from 'vitest';
import { loadPrototypeDatabase, syntheticPrototypeDatabase } from '@comblang/prototypes';

import { compileSource } from './compile-source.js';

describe('browser source compilation', () => {
  test('keeps implicit parameter warnings visible without blocking compilation', () => {
    const text = `function Double(input) { return input * 2; }
function Triple(input: Network) { return input * 3; }
const input = CC(); const a = Double(input); const b = Double(input); const c = Triple(input);`;
    const result = compileSource({ path: 'implicit.factorio.ts', text });
    expect(result.plan?.producers).toHaveLength(4);
    expect(result.compilerDiagnostics).toEqual([
      expect.objectContaining({ code: 'CL2002', severity: 'warning' }),
      expect.objectContaining({ code: 'CL2002', severity: 'warning' }),
    ]);
    expect(
      result.compilerDiagnostics.map(({ span }) => text.slice(span!.start, span!.end)),
    ).toEqual(['input', 'input: Network']);
  });

  test('compiles spread placement and attachment through the shared runtime', () => {
    const result = compileSource({
      path: 'main.factorio.ts',
      text: `const output = new Network();
const coordinates = [1, 2, 4];
CC().at(...coordinates).to(...[output]);`,
    });
    expect(result.compilerDiagnostics).toEqual([]);
    expect(result.plan?.producers).toMatchObject([
      {
        kind: 'constant',
        placement: { x: 1, y: 2, direction: 4 },
        destinations: [{ network: 'output' }],
      },
    ]);
  });

  test('retains the argument span for a function stored in an object', () => {
    const argument = 'values[0]';
    const text = `function Read(input: Readonly<Network>): Network { return input + 0; }
const helpers = { read: Read };
const values = [5];
helpers.read(${argument});`;
    const result = compileSource({ path: 'main.factorio.ts', text });
    expect(result.plan).toBeUndefined();
    const diagnostic = result.compilerDiagnostics.find(({ code }) => code === 'RT2015');
    expect(diagnostic?.span).toBeDefined();
    expect(text.slice(diagnostic!.span!.start, diagnostic!.span!.end)).toBe(argument);
  });

  test('accepts an explicitly injected prototype environment', async () => {
    const { prototypes } = await loadPrototypeDatabase(syntheticPrototypeDatabase());
    const result = compileSource(
      {
        path: 'main.factorio.ts',
        text: `const PLATE = Signal(prototypes.item['iron-plate'].name);
const source = CC(prototypes.item['iron-plate'].stackSize * PLATE);`,
      },
      { prototypes },
    );

    expect(result.compilerDiagnostics).toEqual([]);
    expect(result.plan?.producers[0]).toMatchObject({
      kind: 'constant',
      outputs: [{ signal: { name: 'iron-plate' }, value: 100 }],
    });
  });

  test('rejects reserved DSL bindings without executing the transformed program', () => {
    const declaration = 'const ANY = 5;';
    const text = `${declaration}\nthrow new Error("must not execute");`;
    const result = compileSource({
      path: 'main.factorio.ts',
      text,
    });
    const diagnostic = result.compilerDiagnostics.find(({ code }) => code === 'CL1045');

    expect(result.plan).toBeUndefined();
    expect(diagnostic).toMatchObject({ severity: 'error', span: expect.any(Object) });
    expect(
      diagnostic?.span === undefined
        ? undefined
        : text.slice(diagnostic.span.start, diagnostic.span.end),
    ).toBe('ANY');
  });

  test('keeps capability, pair, and transfer descriptors in the browser result plan', () => {
    const text = `function Inspect(input: Readonly<Network>, output: Ref<Network>): void {
  output += input + 1;
}
const input = new Network();
const output = new Network();
Inspect(input, output);
const both = pair(input, output);
const merged = new Network();
merged.take(output);`;
    const result = compileSource({ path: 'main.factorio.ts', text });

    expect(result.plan?.capabilityUses).toMatchObject([
      { network: 'input', capability: 'readonly', parameter: 'input' },
      { network: 'output', capability: 'ref', parameter: 'output' },
    ]);
    expect(result.plan?.networkPairs).toMatchObject([{ networks: ['input', 'output'] }]);
    expect(result.plan?.networkTransfers).toMatchObject([
      { destination: 'merged', source: 'output' },
    ]);
  });

  test('attaches a duplicate to(...) destination diagnostic to its source statement', () => {
    const statement = 'to(a, a) += input + 0;';
    const text = `const input = new Network();
const a = new Network();
${statement}`;
    const result = compileSource({ path: 'main.factorio.ts', text });
    const duplicate = result.compilerDiagnostics.find(({ code }) => code === 'RT2004');

    expect(duplicate).toMatchObject({ severity: 'error', span: expect.any(Object) });
    expect(
      duplicate?.span === undefined
        ? undefined
        : text.slice(duplicate.span.start, duplicate.span.end),
    ).toBe(statement.slice(0, -1));
  });

  test('attaches a pair color conflict to the pair expression', () => {
    const expression = 'pair(first, second)';
    const text = `const first = new Network<R>();
const second = new Network<R>();
const inputs = ${expression};`;
    const result = compileSource({ path: 'main.factorio.ts', text });
    const conflict = result.compilerDiagnostics.find(({ code }) => code === 'RT2010');

    expect(conflict).toMatchObject({ severity: 'error', span: expect.any(Object) });
    expect(
      conflict?.span === undefined ? undefined : text.slice(conflict.span.start, conflict.span.end),
    ).toBe(expression);
  });

  test('rejects .as on a Network returned by a source function', () => {
    const expression = 'Gate(input).as(A)';
    const text = `const A = Signal('virtual', 'signal-A');
function Gate(input: Readonly<Network>): Network {
  return IF(input > 0, input);
}
const input = new Network();
const output: Network = ${expression};`;
    const result = compileSource({ path: 'main.factorio.ts', text });
    const diagnostic = result.compilerDiagnostics.find(({ code }) => code === 'CL1043');

    expect(result.plan).toBeUndefined();
    expect(diagnostic).toMatchObject({ severity: 'error', span: expect.any(Object) });
    expect(text.slice(diagnostic!.span!.start, diagnostic!.span!.end)).toBe(expression);
  });

  test('attaches an incompatible combinator return diagnostic to return', () => {
    const returned = 'return tmp;';
    const text = `function test(input: Readonly<Network>): ArithmeticCombinator {
  let tmp = input + 0;
  ${returned}
}`;
    const result = compileSource({ path: 'main.factorio.ts', text });
    const diagnostic = result.compilerDiagnostics.find(({ code }) => code === 'CL1044');

    expect(result.plan).toBeUndefined();
    expect(diagnostic).toMatchObject({ severity: 'error', span: expect.any(Object) });
    expect(text.slice(diagnostic!.span!.start, diagnostic!.span!.end)).toBe(returned);
  });

  test('attaches repeated Producer use to the second attachment', () => {
    const repeated = 'second += configured;';
    const text = `const A = Signal('virtual', 'signal-A');
const input = new Network();
const producer: ArithmeticCombinator = input + 0;
const configured: ArithmeticCombinator = producer.at(1, 2);
const first = new Network();
const second = new Network();
first += producer;
${repeated}`;
    const result = compileSource({ path: 'main.factorio.ts', text });
    const diagnostic = result.compilerDiagnostics.find(({ code }) => code === 'RT2006');

    expect(result.plan).toBeUndefined();
    expect(diagnostic).toMatchObject({
      severity: 'error',
      span: expect.any(Object),
      related: expect.any(Array),
    });
    expect(text.slice(diagnostic!.span!.start, diagnostic!.span!.end)).toBe(repeated.slice(0, -1));
  });

  test('reports a dynamic concrete Producer parameter mismatch at the call argument', () => {
    const parameter = 'value: ArithmeticCombinator';
    const argument = 'values[0]';
    const text = `function Configure(${parameter}): ArithmeticCombinator {
  return value;
}
const input = new Network();
const values = [when(input > 0).then(input)];
const output = Configure(${argument});`;
    const result = compileSource({ path: 'main.factorio.ts', text });
    const diagnostic = result.compilerDiagnostics.find(({ code }) => code === 'RT2022');

    expect(result.plan).toBeUndefined();
    expect(diagnostic).toMatchObject({ severity: 'error', span: expect.any(Object) });
    expect(text.slice(diagnostic!.span!.start, diagnostic!.span!.end)).toBe(argument);
  });

  test('reports a dynamic Producer tuple mismatch at its destructuring boundary', () => {
    const declaration = 'let [producer]: [ArithmeticCombinator] = values;';
    const text = `const input = new Network();
const values = [when(input > 0).then(input)];
${declaration}`;
    const result = compileSource({ path: 'main.factorio.ts', text });
    const diagnostic = result.compilerDiagnostics.find(({ code }) => code === 'RT2022');

    expect(result.plan).toBeUndefined();
    expect(diagnostic).toMatchObject({ severity: 'error', span: expect.any(Object) });
    expect(text.slice(diagnostic!.span!.start, diagnostic!.span!.end)).toBe(
      declaration.slice(4, -1),
    );
  });

  test('reports a dynamic Producer mismatch at its typed assignment boundary', () => {
    const assigned = 'values[0]';
    const text = `const input = new Network();
const values = [when(input > 0).then(input)];
let slots: ArithmeticCombinator[] = [];
slots[0] = ${assigned};`;
    const result = compileSource({ path: 'main.factorio.ts', text });
    const diagnostic = result.compilerDiagnostics.find(({ code }) => code === 'RT2022');

    expect(result.plan).toBeUndefined();
    expect(diagnostic).toMatchObject({ severity: 'error', span: expect.any(Object) });
    expect(text.slice(diagnostic!.span!.start, diagnostic!.span!.end)).toBe(assigned);
  });

  test('reports a structured output Signal conflict from the common attachment path', () => {
    const expression = 'to(output)[B] += IF(input[A] > 0, input[A])';
    const text = `const A = Signal('virtual', 'signal-A');
const B = Signal('virtual', 'signal-B');
const input = new Network();
const output = new Network();
${expression};`;
    const result = compileSource({ path: 'main.factorio.ts', text });
    const diagnostic = result.compilerDiagnostics.find(({ code }) => code === 'RT2023');

    expect(result.plan).toBeUndefined();
    expect(diagnostic).toMatchObject({
      severity: 'error',
      span: expect.any(Object),
      related: expect.any(Array),
    });
    expect(text.slice(diagnostic!.span!.start, diagnostic!.span!.end)).toBe(expression);
  });

  test('reports stale ownership through an alias of a replaced container slot', () => {
    const staleUse = 'alias + 1';
    const text = `function Pass(input: Move<Network>): Network { return input; }
const values: Network[] = [new Network()];
const alias = values[0];
values[0] = Pass(values[0]);
const output: Network = ${staleUse};`;
    const result = compileSource({ path: 'main.factorio.ts', text });
    const diagnostic = result.compilerDiagnostics.find(({ code }) => code === 'RT2012');

    expect(result.plan).toBeUndefined();
    expect(diagnostic).toMatchObject({
      severity: 'error',
      span: expect.any(Object),
      related: expect.any(Array),
    });
    expect(text.slice(diagnostic!.span!.start, diagnostic!.span!.end)).toBe(staleUse);
  });
});

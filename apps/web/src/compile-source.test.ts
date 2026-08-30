import { describe, expect, test } from 'vitest';

import { compileSource } from './compile-source.js';

describe('browser source compilation', () => {
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
const configured: ArithmeticCombinator = producer.as(A);
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

  test('reports a dynamic concrete Producer parameter mismatch at its boundary', () => {
    const parameter = 'value: ArithmeticCombinator';
    const text = `function Configure(${parameter}): ArithmeticCombinator {
  return value;
}
const input = new Network();
const values = [when(input > 0).then(input)];
const output = Configure(values[0]);`;
    const result = compileSource({ path: 'main.factorio.ts', text });
    const diagnostic = result.compilerDiagnostics.find(({ code }) => code === 'RT2022');

    expect(result.plan).toBeUndefined();
    expect(diagnostic).toMatchObject({ severity: 'error', span: expect.any(Object) });
    expect(text.slice(diagnostic!.span!.start, diagnostic!.span!.end)).toBe(parameter);
  });
});

import { transformElaborationModule } from '@comblang/compiler';
import { signal } from '@comblang/factorio';
import { parseFile, validateDslSemantics } from '@comblang/language';
import { describe, expect, test } from 'vitest';

import { elaborateDirectPlan } from './direct-plan.js';
import { executeElaborationProgram } from './elaboration-program.js';

function execute(text: string) {
  const file = parseFile({ path: 'implicit.factorio.ts', text });
  return executeElaborationProgram(transformElaborationModule(file));
}

describe('implicit Network function parameters', () => {
  test('executes nested untyped helpers with the same circuit output and tick latency', () => {
    const plan = execute(`function Double(input) { return input * 2; }
function Pipeline(input: Network): Network { return Double(input) + 1; }
const input = CC(5 * Signal('virtual', 'signal-A'));
const output = Pipeline(input);`);
    const execution = elaborateDirectPlan(plan);
    const session = execution.createTestSession();
    const output = execution.network('output');
    const A = signal('virtual', 'signal-A');
    session.tick(2);
    session.expectSignal(output, A).toBe(0);
    session.tick();
    session.expectSignal(output, A).toBe(11);
    expect(plan.producers).toHaveLength(3);
    expect(plan.diagnostics?.map(({ code }) => code)).toEqual(['CL2002', 'CL2002']);
  });

  test.each([
    { parameter: 'input', expectedUses: 0, warning: false },
    { parameter: 'input: Network', expectedUses: 0, warning: true },
  ])(
    'uses the declared parameter boundary for $parameter',
    ({ parameter, expectedUses, warning }) => {
      const source = `function Double(${parameter}): Network { return input * 2; }
const input = CC(5 * Signal('virtual', 'signal-A'));
for (let i = 0; i < 3; i++) { const output = Double(input); }
input += CC();`;
      const file = parseFile({ path: 'implicit.factorio.ts', text: source });
      expect(validateDslSemantics(file)).toEqual([]);
      const plan = execute(source);
      expect(plan.producers).toHaveLength(5);
      expect(plan.capabilityUses).toHaveLength(expectedUses);
      expect(plan.capabilityUses?.every(({ capability }) => capability === 'readonly')).toBe(true);
      expect(plan.diagnostics).toEqual(
        warning ? [expect.objectContaining({ code: 'CL2002', severity: 'warning' })] : [],
      );
      if (warning) {
        const span = plan.diagnostics![0]!.span!;
        expect(source.slice(span.start, span.end)).toBe(parameter);
      }
      expect(() => elaborateDirectPlan(plan)).not.toThrow();
    },
  );

  test('keeps ordinary values, optional/default arguments, arrays, and objects unchanged and warning-free', () => {
    const plan = execute(`function Identity(input) { return input; }
function Add(input = 3) { return input + 2; }
function Optional(input) { if (input === undefined) return 7; return input; }
const arr = [1, 2]; const obj = { value: 5 };
if (Identity(arr) !== arr || Identity(obj) !== obj || Identity(null) !== null ||
    Identity(5) !== 5 || Add() !== 5 || Optional() !== 7) throw new Error('changed JavaScript');`);
    expect(plan.diagnostics).toEqual([]);
    expect(plan.capabilityUses).toEqual([]);
  });

  test('warns for a generic parameter only when it receives a Network', () => {
    const plan = execute(`function Double(input) { return input * 2; }
if (Double(3) !== 6) throw new Error('wrong number');
const input = new Network();
const output = Double(input);
function Unused(other: Network) { return other * 2; }`);
    expect(plan.diagnostics?.map(({ code }) => code)).toEqual(['CL2002']);
    expect(plan.capabilityUses).toEqual([]);
  });

  test('keeps generic Combinator handles but narrows an annotated Network argument', () => {
    const plan = execute(`function Identity(input) { return input; }
function Read(input: Network) { return input * 2; }
const comb: Producer = CC();
const copied: Producer = Identity(comb);
const output = new Network();
copied.to(output);
const doubled = Read(CC());`);
    expect(plan.producers).toHaveLength(3);
    expect(plan.capabilityUses).toEqual([]);
    expect(plan.diagnostics?.map(({ code }) => code)).toEqual(['CL2002']);
    expect(() => elaborateDirectPlan(plan)).not.toThrow();
  });

  test('retains colors and explicit capabilities without extra implicit warnings', () => {
    const plan = execute(`function Green(input: Network<G>) { return input * 2; }
function Explicit(input: Readonly<Network>) { return input * 3; }
function Write(input: Ref<Network>) { input += CC(); }
    const input = new Network();
    const green = Green(input); const explicit = Explicit(input); Write(input);`);
    expect(plan.capabilityUses?.map(({ capability }) => capability)).toEqual(['readonly', 'ref']);
    expect(plan.capabilityUses?.[0]?.fixedColor).toBeUndefined();
    expect(plan.diagnostics?.map(({ code }) => code)).toEqual(['CL2002']);
    expect(() => elaborateDirectPlan(plan)).not.toThrow();
  });

  test('does not borrow, move, or block ordinary aliases at an unrestricted boundary', () => {
    const source = `let captured;
function Use(input: Network) { captured = input; input += CC(); return input; }
const input = new Network(); const returned = Use(input);
captured += CC(); returned += CC();`;
    expect(validateDslSemantics(parseFile({ path: 'implicit.factorio.ts', text: source }))).toEqual(
      [],
    );
    const plan = execute(source);
    expect(plan.capabilityUses).toEqual([]);
    expect(plan.diagnostics?.map(({ code }) => code)).toEqual(['CL2002']);
  });

  test('keeps a captured unrestricted reference usable after the call', () => {
    const plan = execute(`let captured;
function Capture(input) { captured = input; }
const input = new Network(); Capture(input); captured += CC();`);
    expect(plan.capabilityUses).toEqual([]);
    expect(plan.diagnostics?.map(({ code }) => code)).toEqual(['CL2002']);
  });

  test('releases no implicit borrow when an unrestricted call throws', () => {
    const plan = execute(`function Fail(input) { throw new Error('failure'); }
const input = new Network();
try { Fail(input); } catch {}
input += CC();`);
    expect(plan.producers).toHaveLength(1);
    expect(() => elaborateDirectPlan(plan)).not.toThrow();
  });

  test('dispatches Network | number and Network | undefined at execution time', () => {
    const source = `function Scale(input: Network | number) {
  return typeof input === 'number' ? input * 2 : input * 2;
}
function Optional(input: Network | undefined) {
  return input === undefined ? 7 : input * 2;
}
if (Scale(3) !== 6 || Optional(undefined) !== 7) throw new Error('wrong ordinary branch');
const input = new Network(); const scaled = Scale(input); const same = Optional(input);`;
    const plan = execute(source);
    expect(plan.capabilityUses).toEqual([]);
    expect(plan.diagnostics?.map(({ code }) => code)).toEqual(['CL2002', 'CL2002']);
    expect(() => elaborateDirectPlan(plan)).not.toThrow();
  });

  test('uses an explicit capability branch only when a union receives a Network', () => {
    const source = `function Read(input: Readonly<Network> | number) {
  return typeof input === 'number' ? input * 2 : input * 2;
}
if (Read(3) !== 6) throw new Error('wrong numeric branch');
const input = new Network(); const output = Read(input);`;
    const plan = execute(source);
    expect(plan.capabilityUses).toMatchObject([{ capability: 'readonly', parameter: 'input' }]);
    expect(plan.diagnostics).toEqual([]);
    expect(() => elaborateDirectPlan(plan)).not.toThrow();
  });

  test('preserves exact any values while marking a direct Network as transparent', () => {
    const source = `function Identity(input: any) { return input; }
const input = new Network(); const alias = Identity(input); alias += CC();
const comb = CC(); const copied = Identity(comb); const output = new Network(); copied.to(output);
const object = { value: 5 }; if (Identity(object) !== object) throw new Error('changed any');`;
    const plan = execute(source);
    expect(plan.capabilityUses).toEqual([]);
    expect(plan.diagnostics?.map(({ code }) => code)).toEqual(['CL2002']);
    expect(() => elaborateDirectPlan(plan)).not.toThrow();
  });

  test('narrows a Combinator to its primary Network facet at a bare Network boundary', () => {
    const source = `function Touch(input: Network) { input += CC(); }
const comb = CC(); Touch(comb);`;
    const plan = execute(source);
    expect(plan.capabilityUses).toEqual([]);
    expect(plan.diagnostics?.map(({ code }) => code)).toEqual(['CL2002']);
    expect(() => elaborateDirectPlan(plan)).not.toThrow();
  });

  test('returns transparent aliases through arrays and plain objects without moving them', () => {
    const source = `function Through(input: Network): Network {
  const array = [input]; const object = { input }; return object.input;
}
const input = new Network(); const alias = Through(input); alias += CC(); input += CC();`;
    const plan = execute(source);
    expect(plan.capabilityUses).toEqual([]);
    expect(plan.diagnostics?.map(({ code }) => code)).toEqual(['CL2002']);
    expect(() => elaborateDirectPlan(plan)).not.toThrow();
  });

  test('transfers a Network created by a default parameter instead of treating it as caller-owned', () => {
    const source = `let captured;
function Default(input: Network = (captured = new Network())): Network { return input; }
const output = Default(); output += CC(); captured += CC();`;
    expect(() => execute(source)).toThrowError(expect.objectContaining({ code: 'RT2012' }));
  });

  test('does not let a native typed callback steal the pending outer default invocation', () => {
    const source = `let captured;
function Default(input: Network = [0].map((_value: any) => (captured = new Network()))[0]): Network {
  return input;
}
const output = Default(); output += CC(); captured += CC();`;
    expect(() => execute(source)).toThrowError(expect.objectContaining({ code: 'RT2012' }));
  });

  test('consuming through a transparent parameter invalidates every caller alias', () => {
    const source = `function Consume(input: Network) {
  const destination = new Network(); destination.take(input);
}
const input = new Network(); const alias = input; Consume(input); alias += CC();`;
    expect(() => execute(source)).toThrowError(expect.objectContaining({ code: 'RT2012' }));
  });

  test.each([
    'function Consume(input: Network): Network { const out = new Network(); out.take(input); return input; }',
    'function Consume(input: Network) { const out = new Network(); out.take(input); return { input }; }',
  ])('rejects returning an already consumed transparent alias: %s', (declaration) => {
    const source = `${declaration}\nconst input = new Network(); Consume(input);`;
    try {
      execute(source);
      expect.fail('Expected the return of a consumed alias to fail');
    } catch (error) {
      expect(error).toMatchObject({ code: 'RT2012' });
      const span = (error as { span: { start: number; end: number } }).span;
      expect(source.slice(span.start, span.end)).toContain('return');
    }
  });

  test('keeps active outer borrows authoritative for later unrestricted writes', () => {
    const source = `function Write(input: Network) { input += CC(); }
function ReadOnly(input: Readonly<Network>) { Write(input); }
const input = new Network(); ReadOnly(input);`;
    expect(() => execute(source)).toThrowError(expect.objectContaining({ code: 'RT2015' }));
  });

  test('instruments arrow and function-expression parameter contracts with call provenance', () => {
    const source = `const arrow = (input: Network | number) => input;
const expression = function (input: Network | number) { return input; };
const native = (value: number) => value + 1;
if (arrow(3) !== 3 || native(4) !== 5) throw new Error('wrong callback');
const input = new Network(); const a = arrow(input); const b = expression(input);`;
    const plan = execute(source);
    expect(plan.capabilityUses).toEqual([]);
    expect(plan.diagnostics?.map(({ code }) => code)).toEqual(['CL2002', 'CL2002']);
    expect(() => elaborateDirectPlan(plan)).not.toThrow();
  });

  test('applies unrestricted warnings and exact-value behavior to untyped arrows and expressions', () => {
    const source = `const arrow = (input) => input;
const expression = function (input) { return input; };
if (arrow(3) !== 3 || expression('ok') !== 'ok') throw new Error('wrong ordinary value');
const input = new Network(); const alias = arrow(input); alias += CC();
const comb = CC(); const copied = expression(comb); const output = new Network(); copied.to(output);`;
    const plan = execute(source);
    expect(plan.diagnostics?.map(({ code }) => code)).toEqual(['CL2002']);
    expect(plan.producers).toHaveLength(2);
    expect(() => elaborateDirectPlan(plan)).not.toThrow();
  });

  test('reports invalid typed arrow and function-expression arguments at their call sites', () => {
    for (const declaration of [
      'const read = (input: Readonly<Network>) => input * 2; read(5);',
      'const read = function (input: Readonly<Network>) { return input * 2; }; read(5);',
    ]) {
      try {
        execute(declaration);
        expect.fail('Expected an argument failure');
      } catch (error) {
        expect(error).toMatchObject({ code: 'RT2015' });
        const span = (error as { span: { start: number; end: number } }).span;
        expect(declaration.slice(span.start, span.end)).toBe('5');
      }
    }
  });

  test('reports non-Network typed arguments at the call site', () => {
    const source = `function Read(input: Network) { return input * 2; }
const values = [5]; const output = Read(values[0]);`;
    try {
      execute(source);
      expect.fail('Expected an argument failure');
    } catch (error) {
      expect(error).toMatchObject({ code: 'RT2015' });
      const span = (error as { span: { start: number; end: number } }).span;
      expect(source.slice(span.start, span.end)).toBe('values[0]');
    }
  });
});

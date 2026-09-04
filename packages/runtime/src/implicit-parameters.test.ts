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

  test.each(['input', 'input: Network'])(
    'borrows %s for reads and warns once per declaration',
    (parameter) => {
      const source = `function Double(${parameter}): Network { return input * 2; }
const input = CC(5 * Signal('virtual', 'signal-A'));
for (let i = 0; i < 3; i++) { const output = Double(input); }
input += CC();`;
      const file = parseFile({ path: 'implicit.factorio.ts', text: source });
      expect(validateDslSemantics(file)).toEqual([]);
      const plan = execute(source);
      expect(plan.producers).toHaveLength(5);
      expect(plan.capabilityUses).toHaveLength(3);
      expect(plan.capabilityUses?.every(({ capability }) => capability === 'readonly')).toBe(true);
      expect(plan.diagnostics).toEqual([
        expect.objectContaining({ code: 'CL2002', severity: 'warning' }),
      ]);
      const span = plan.diagnostics![0]!.span!;
      expect(source.slice(span.start, span.end)).toBe(parameter);
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
    expect(plan.capabilityUses).toHaveLength(1);
  });

  test('keeps generic Producer handles but contextually materializes an annotated Network argument', () => {
    const plan = execute(`function Identity(input) { return input; }
function Read(input: Network) { return input * 2; }
const comb: Producer = CC();
const copied: Producer = Identity(comb);
const output = new Network();
copied.to(output);
const doubled = Read(CC());`);
    expect(plan.producers).toHaveLength(3);
    expect(plan.capabilityUses).toHaveLength(1);
    expect(plan.diagnostics?.map(({ code }) => code)).toEqual(['CL2002']);
    expect(() => elaborateDirectPlan(plan)).not.toThrow();
  });

  test('retains colors and explicit capabilities without extra implicit warnings', () => {
    const plan = execute(`function Green(input: Network<G>) { return input * 2; }
function Explicit(input: Readonly<Network>) { return input * 3; }
function Write(input: Ref<Network>) { input += CC(); }
const input = new Network();
const green = Green(input); const explicit = Explicit(input); Write(input);`);
    expect(plan.capabilityUses?.map(({ capability }) => capability)).toEqual([
      'readonly',
      'readonly',
      'ref',
    ]);
    expect(plan.capabilityUses?.[0]?.fixedColor).toBe('green');
    expect(plan.diagnostics?.map(({ code }) => code)).toEqual(['CL2002']);
    expect(() => elaborateDirectPlan(plan)).not.toThrow();
  });

  test.each([
    'input += CC();',
    'input.take(new Network());',
    'const out = new Network(); out.take(input);',
    'return input;',
  ])('rejects invalid implicit borrowing at the body operation: %s', (body) => {
    const source = `function Invalid(input) { ${body} }
const input = new Network(); Invalid(input);`;
    expect(validateDslSemantics(parseFile({ path: 'implicit.factorio.ts', text: source }))).toEqual(
      [],
    );
    try {
      execute(source);
      expect.fail('Expected a capability failure');
    } catch (error) {
      expect(error).toMatchObject({
        code: expect.stringMatching(/^RT201/),
        span: expect.any(Object),
      });
      const span = (error as { span: { start: number; end: number } }).span;
      expect(span.start).toBeGreaterThanOrEqual(source.indexOf(body));
      expect(span.start).toBeLessThan(source.indexOf('\n'));
    }
  });

  test('expires captured borrows after the call and releases the caller on thrown errors', () => {
    expect(() =>
      execute(`let captured;
function Capture(input) { captured = input; }
const input = new Network(); Capture(input); captured += CC();`),
    ).toThrow('expired Readonly<Network> parameter input');
    const plan = execute(`function Fail(input) { throw new Error('failure'); }
const input = new Network();
try { Fail(input); } catch {}
input += CC();`);
    expect(plan.producers).toHaveLength(1);
    expect(() => elaborateDirectPlan(plan)).not.toThrow();
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

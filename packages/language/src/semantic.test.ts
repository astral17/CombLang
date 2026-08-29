import { describe, expect, test } from 'vitest';

import { parseFile } from './parser.js';
import { classifyDslSemantics, validateDslSemantics } from './semantic.js';

describe('DSL semantic classifier', () => {
  test('classifies Network arithmetic separately from compile-time arithmetic', () => {
    const parsed = parseFile({
      path: 'scale.ts',
      text: `function Scale(input: Readonly<Network>): Network {
  const compileTime = 2 * 5;
  return input * compileTime;
}`,
    });

    expect(classifyDslSemantics(parsed)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'operator',
          text: '2 * 5',
          operatorDomain: 'compile-time',
        }),
        expect.objectContaining({
          kind: 'operator',
          text: 'input * compileTime',
          operatorDomain: 'circuit-arithmetic',
        }),
      ]),
    );
  });

  test('recognizes owned and readonly Network declarations', () => {
    const parsed = parseFile({
      path: 'networks.ts',
      text: `const red = new Network<R>();
const alias: Readonly<Network> = red;`,
    });

    expect(
      classifyDslSemantics(parsed).filter((summary) => summary.kind === 'network-declaration'),
    ).toHaveLength(2);
  });

  test('rejects definite Network += non-producers even in an unexecuted branch', () => {
    const parsed = parseFile({
      path: 'invalid-attachment.ts',
      text: `const input = new Network();
if (false) {
  input += 5;
}
let count = 1;
count += 2;`,
    });

    expect(validateDslSemantics(parsed)).toEqual([
      expect.objectContaining({
        code: 'CL1034',
        severity: 'error',
        message: expect.stringContaining('Network += requires a combinator producer'),
      }),
    ]);
    const span = validateDslSemantics(parsed)[0]!.span!;
    expect(parsed.text.slice(span.start, span.end)).toBe('input += 5');
  });

  test('accepts producer expressions and Network-returning structural calls', () => {
    const parsed = parseFile({
      path: 'valid-attachments.ts',
      text: `function Delay(input: Readonly<Network>): Network { return input + 0; }
const input = new Network();
const output = new Network();
output += input + 1;
output += IF(input > 0, input);
output += Delay(input);`,
    });

    expect(validateDslSemantics(parsed)).toEqual([]);
  });

  test('checks definite DSL call arity without executing the branch', () => {
    const parsed = parseFile({
      path: 'invalid-builtins.ts',
      text: `if (false) {
  Signal();
  new Network(1);
  CC();
  IF(new Network());
  (new Network() + 1).as();
  (new Network() + 1).at(1);
  (new Network() + 1).to();
  when(new Network() > 0).then();
}`,
    });

    expect(validateDslSemantics(parsed).map(({ code }) => code)).toEqual([
      'CL1019',
      'CL1035',
      'CL1024',
      'CL1014',
      'CL1031',
      'CL1035',
      'CL1021',
      'CL1014',
    ]);
  });

  test('does not claim ordinary JavaScript methods with DSL-like names', () => {
    const parsed = parseFile({
      path: 'ordinary-methods.ts',
      text: `const value = {
  as() { return 1; },
  at() { return 2; },
  to() { return 3; },
};
value.as();
value.at();
value.to();`,
    });

    expect(validateDslSemantics(parsed)).toEqual([]);
  });

  test('tracks Network arrays and defers heterogeneous element values to runtime', () => {
    const typed = parseFile({
      path: 'network-array.ts',
      text: `const output = new Network();
const arr: Network[] = [new Network(), new Network()];
for (let i = 0; i < arr.length; i++) output += arr[i] * 2;`,
    });
    const heterogeneous = parseFile({
      path: 'mixed-array.ts',
      text: `const output = new Network();
const arr = [new Network(), 5];
for (let i = 0; i < arr.length; i++) output += arr[i] * 2;`,
    });

    expect(validateDslSemantics(typed)).toEqual([]);
    expect(validateDslSemantics(heterogeneous)).toEqual([]);
  });

  test('does not validate possibly shadowed DSL builtin names as definite DSL calls', () => {
    const parsed = parseFile({
      path: 'shadowed-builtins.ts',
      text: `function Signal(value: string) { return value; }
function CC() { return 1; }
class Network { constructor(value: number) {} }
Signal("ordinary");
CC();
new Network(1);`,
    });

    expect(validateDslSemantics(parsed)).toEqual([]);
  });

  test('separates invalid Network selections from collection indexing', () => {
    const parsed = parseFile({
      path: 'selections.ts',
      text: `const A = Signal("virtual", "signal-A");
const input = new Network();
const networks: Network[] = [input];
const dynamic = getSignal();
input[5];
input["signal-A"];
input[dynamic];
input[A];
networks[0];`,
    });

    const diagnostics = validateDslSemantics(parsed);
    expect(diagnostics.map(({ code }) => code)).toEqual(['CL1019']);
    expect(diagnostics.map(({ span }) => span && parsed.text.slice(span.start, span.end))).toEqual([
      'input[5]',
    ]);
  });

  test('rejects only definitely non-string Signal factory arguments', () => {
    const parsed = parseFile({
      path: 'signal-arguments.ts',
      text: `const dynamicType = getType();
Signal("chest");
Signal(dynamicType, "signal-A");
Signal("virtual", "signal-A", "legendary");
Signal(5);
Signal(5, "signal-A");
Signal("virtual", false);`,
    });

    expect(
      validateDslSemantics(parsed).map(
        ({ span }) => span && parsed.text.slice(span.start, span.end),
      ),
    ).toEqual(['Signal(5)', 'Signal(5, "signal-A")', 'Signal("virtual", false)']);
  });

  test('diagnoses source outside the single-file synchronous module boundary', () => {
    const parsed = parseFile({
      path: 'module-boundary.ts',
      text: `import type { External } from "./external.js";
export const value = 1;
const lazy = import("./lazy.js");
const url = import.meta.url;
await Promise.resolve();
async function allowed() { await Promise.resolve(); }`,
    });

    const diagnostics = validateDslSemantics(parsed);
    expect(diagnostics.map(({ code }) => code)).toEqual([
      'CL1036',
      'CL1036',
      'CL1036',
      'CL1036',
      'CL1036',
    ]);
    expect(diagnostics.map(({ message }) => message)).toEqual([
      expect.stringContaining('one self-contained source file'),
      expect.stringContaining('export/default'),
      expect.stringContaining('Dynamic import'),
      expect.stringContaining('Dynamic import'),
      expect.stringContaining('Top-level await'),
    ]);
  });

  test('allows await inside an ordinary async function', () => {
    const parsed = parseFile({
      path: 'async-function.ts',
      text: `async function load() {
  await Promise.resolve(1);
}`,
    });

    expect(validateDslSemantics(parsed)).toEqual([]);
  });

  test('keeps Network facts inside lexical block and loop scopes', () => {
    const parsed = parseFile({
      path: 'lexical-scopes.ts',
      text: `{
  const inner = new Network();
  inner += 5;
}
inner += 5;
for (let loopNet = new Network(); false;) {
  loopNet += 5;
}
loopNet += 5;`,
    });

    const diagnostics = validateDslSemantics(parsed);
    expect(diagnostics.map(({ span }) => span && parsed.text.slice(span.start, span.end))).toEqual([
      'inner += 5',
      'loopNet += 5',
    ]);
  });

  test('tracks provable aliases and homogeneous Network containers', () => {
    const parsed = parseFile({
      path: 'aliases.ts',
      text: `const input = new Network();
const output = new Network();
const alias = input;
const networks = [alias, new Network()];
output += alias + 1;
output += networks[0] + 2;
const holder = { dynamic: input };
output += holder.dynamic + 3;`,
    });

    expect(validateDslSemantics(parsed)).toEqual([]);
  });

  test('validates .take arity only for a definite Network receiver', () => {
    const parsed = parseFile({
      path: 'take-arity.ts',
      text: `const destination = new Network();
destination.take();
destination.take(new Network(), new Network());
const ordinary = { take() {} };
ordinary.take();`,
    });

    expect(validateDslSemantics(parsed).map(({ code }) => code)).toEqual(['CL1037', 'CL1037']);
  });

  test('enforces definite Readonly and Ref parameter capabilities', () => {
    const parsed = parseFile({
      path: 'capabilities.ts',
      text: `function Invalid(readonlyOutput: Readonly<Network>, refOutput: Ref<Network>, input: Readonly<Network>): Network {
  const alias = readonlyOutput;
  readonlyOutput += input + 1;
  alias += input + 1;
  (input + 2).to(readonlyOutput);
  to(readonlyOutput) += input + 3;
  refOutput += input + 4;
  refOutput.take(input);
  return input;
}`,
    });

    expect(validateDslSemantics(parsed).map(({ code }) => code)).toEqual([
      'CL1038',
      'CL1038',
      'CL1038',
      'CL1038',
      'CL1039',
      'CL1040',
    ]);
  });

  test('recognizes color-qualified Ref and Move Network annotations', () => {
    const parsed = parseFile({
      path: 'capability-types.ts',
      text: `function Connect(output: Ref<Network<G>>, input: Readonly<Network<R>>, owned: Move<Network>): void {
  output += input + 1;
  owned.take(new Network());
}`,
    });

    expect(validateDslSemantics(parsed)).toEqual([]);
  });

  test('requires an explicit capability for Network parameters', () => {
    const parsed = parseFile({
      path: 'bare-parameter.ts',
      text: `function Implicit(input: Network): Network { return input; }
function Explicit(input: Move<Network>): Network { return input; }`,
    });

    expect(validateDslSemantics(parsed)).toEqual([
      expect.objectContaining({ code: 'CL1041', message: expect.stringContaining('no implicit') }),
    ]);
  });
});

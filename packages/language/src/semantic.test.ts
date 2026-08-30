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

  test('rejects .as after a declared Network return boundary', () => {
    const call = 'Gate(input).as(A)';
    const parsed = parseFile({
      path: 'function-return-as.ts',
      text: `const A = Signal('virtual', 'signal-A');
function Gate(input: Readonly<Network>): Network {
  return IF(input > 0, input);
}
const input = new Network();
const output: Network = ${call};`,
    });
    const diagnostics = validateDslSemantics(parsed);

    expect(diagnostics).toContainEqual(expect.objectContaining({ code: 'CL1043' }));
    const diagnostic = diagnostics.find(({ code }) => code === 'CL1043')!;
    expect(parsed.text.slice(diagnostic.span!.start, diagnostic.span!.end)).toBe(call);
  });

  test('accepts stored Producer handles and rejects definite non-producer initializers', () => {
    const valid = parseFile({
      path: 'stored-producer.ts',
      text: `const input = new Network();
let comb: DeciderCombinator = when(input > 0).then(input);
const output = new Network();
output += comb;`,
    });
    const invalid = parseFile({
      path: 'invalid-stored-producer.ts',
      text: `let comb: DeciderCombinator = 5;`,
    });

    expect(validateDslSemantics(valid)).toEqual([]);
    expect(validateDslSemantics(invalid)).toContainEqual(
      expect.objectContaining({ code: 'CL1044', severity: 'error' }),
    );
  });

  test('reports a materialized Network at its incompatible combinator return', () => {
    const returned = 'return tmp;';
    const parsed = parseFile({
      path: 'materialized-producer-return.ts',
      text: `function test(input: Readonly<Network>): ArithmeticCombinator {
  let tmp = input + 0;
  ${returned}
}`,
    });
    const diagnostic = validateDslSemantics(parsed).find(({ code }) => code === 'CL1044');

    expect(diagnostic).toMatchObject({ severity: 'error', span: expect.any(Object) });
    expect(parsed.text.slice(diagnostic!.span!.start, diagnostic!.span!.end)).toBe(returned);
  });

  test('rejects a definitely wrong concrete combinator kind', () => {
    const parsed = parseFile({
      path: 'wrong-producer-kind.ts',
      text: `const input = new Network();
function test(): ArithmeticCombinator {
  return when(input > 0).then(input);
}`,
    });

    expect(validateDslSemantics(parsed)).toContainEqual(
      expect.objectContaining({ code: 'CL1044', severity: 'error' }),
    );
  });

  test('checks statically known concrete Producer function arguments', () => {
    const call = 'Configure(when(input > 0).then(input))';
    const parsed = parseFile({
      path: 'wrong-producer-parameter.ts',
      text: `function Configure(value: ArithmeticCombinator): Producer {
  return value;
}
const input = new Network();
const output: Network = ${call};`,
    });
    const diagnostic = validateDslSemantics(parsed).find(({ code }) => code === 'CL1044');

    expect(diagnostic).toMatchObject({ severity: 'error', span: expect.any(Object) });
    expect(parsed.text.slice(diagnostic!.span!.start, diagnostic!.span!.end)).toBe(
      'when(input > 0).then(input)',
    );

    const missing = parseFile({
      path: 'missing-producer-parameter.ts',
      text: `function Configure(value: ArithmeticCombinator): Producer { return value; }
const output = Configure();`,
    });
    expect(validateDslSemantics(missing)).toContainEqual(
      expect.objectContaining({ code: 'CL1044', severity: 'error' }),
    );
  });

  test('checks definite writes to typed Producer variables and container slots', () => {
    const wrongDirect = 'when(input > 0).then(input)';
    const wrongArray = 'CC(1 * A)';
    const wrongProperty = 'input + 0';
    const parsed = parseFile({
      path: 'wrong-producer-assignments.ts',
      text: `const A = Signal('virtual', 'signal-A');
const input = new Network();
let direct: ArithmeticCombinator;
direct = ${wrongDirect};
let slots: DeciderCombinator[] = [];
slots[0] = ${wrongArray};
let record: {constant: ConstantCombinator} = {};
record.constant = ${wrongProperty};`,
    });
    const diagnostics = validateDslSemantics(parsed).filter(({ code }) => code === 'CL1044');

    expect(diagnostics).toHaveLength(3);
    expect(diagnostics.map(({ span }) => parsed.text.slice(span!.start, span!.end))).toEqual([
      wrongDirect,
      wrongArray,
      wrongProperty,
    ]);
  });

  test('defers uncertain Producer assignments to runtime and respects lexical shadows', () => {
    const parsed = parseFile({
      path: 'dynamic-producer-assignments.ts',
      text: `let value: ArithmeticCombinator;
const values = getValues();
value = values[0];
{
  let value = 1;
  value = 2;
}
let slots: ArithmeticCombinator[] = [];
slots[0] = values[1];`,
    });

    expect(validateDslSemantics(parsed)).toEqual([]);
  });

  test('reserves the third Signal argument for fluent .to(...) only', () => {
    const parsed = parseFile({
      path: 'free-to-third-argument.ts',
      text: `const A = Signal('virtual', 'signal-A');
const input = new Network();
const first = new Network();
const second = new Network();
to(first, second, A) += input + 0;`,
    });

    expect(validateDslSemantics(parsed)).toContainEqual(
      expect.objectContaining({ code: 'CL1021', severity: 'error' }),
    );
  });

  test('rejects a definitely non-Signal third fluent .to(...) argument', () => {
    const third = 'second';
    const parsed = parseFile({
      path: 'fluent-to-third-destination.ts',
      text: `const input = new Network();
const first = new Network();
const second = new Network();
(input + 0).to(first, second, ${third});`,
    });
    const diagnostic = validateDslSemantics(parsed).find(({ code }) => code === 'CL1021');

    expect(diagnostic).toMatchObject({ severity: 'error', span: expect.any(Object) });
    expect(parsed.text.slice(diagnostic!.span!.start, diagnostic!.span!.end)).toBe(third);
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

  test('rejects bindings that shadow reserved free DSL identifiers', () => {
    const parsed = parseFile({
      path: 'reserved-builtins.ts',
      text: `function Signal(value: string) { return value; }
function CC() { return 1; }
class Network { constructor(value: number) {} }
Signal("ordinary");
CC();
new Network(1);
const { Any } = values;
function configure(All: number) { return All; }
const EACH = 5;`,
    });

    const reserved = validateDslSemantics(parsed).filter(({ code }) => code === 'CL1045');
    expect(reserved).toHaveLength(6);
    expect(
      reserved.map(({ span }) =>
        span === undefined ? undefined : parsed.text.slice(span.start, span.end),
      ),
    ).toEqual(['Signal', 'CC', 'Network', 'Any', 'All', 'EACH']);
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

  test('rejects definite pair ownership and destination misuse', () => {
    const parsed = parseFile({
      path: 'pair-misuse.ts',
      text: `const a = new Network();
const b = new Network();
const input = pair(a, b);
const owner: Network = pair(a, b);
pair(a, b) += a + 0;
to(pair(a, b)) += a + 0;
(a + 0).to(pair(a, b));
a.take(pair(a, b));
function Leak(): Network { return pair(a, b); }
pair(a);
pair(a, a);`,
    });

    expect(validateDslSemantics(parsed).map(({ code }) => code)).toEqual([
      'CL1042',
      'CL1042',
      'CL1042',
      'CL1042',
      'CL1042',
      'CL1042',
      'CL1042',
      'CL1042',
    ]);
  });
});

import { parseFile } from '@comblang/language';
import { describe, expect, test } from 'vitest';

import { compileDirectPlan } from './direct-plan.js';

describe('direct elaboration plan compiler', () => {
  test('compiles Scale without executing source', () => {
    const file = parseFile({
      path: 'scale.factorio.ts',
      text: `function Scale(input: Readonly<Network>): Network {
  return input * 10;
}
const input = new Network<R>();
const output: Network = Scale(input);`,
    });

    const result = compileDirectPlan(file);
    expect(result.diagnostics).toEqual([]);
    expect(result.plan).toMatchObject({
      format: 'comblang-direct-plan',
      networks: [{ name: 'input', fixedColor: 'red' }, { name: 'output' }],
      producers: [
        {
          kind: 'arithmetic',
          left: { kind: 'each', network: 'input' },
          operation: 'multiply',
          right: { kind: 'constant', value: 10 },
          output: { kind: 'each' },
          destinations: [{ network: 'output' }],
        },
      ],
    });
  });

  test('lowers the structural MemoCell benchmark with feedback and fan-out', () => {
    const file = parseFile({
      path: 'memo-cell.factorio.ts',
      text: `const SIGNAL_A = Signal("virtual", "signal-A");
function MemoCell(input: Readonly<Network>): Network {
  let out = new Network();
  let mem = new Network();
  to(out, mem) += input + 0;
  to(out, mem) += IF(input === 0 && mem !== 0, mem);
  return out;
}
let test: Network = CC(1 * SIGNAL_A);
let output = MemoCell(test);`,
    });

    const result = compileDirectPlan(file);
    expect(result.diagnostics).toEqual([]);
    expect(result.plan?.networks).toMatchObject([
      { name: 'test' },
      { name: 'output', instancePath: ['MemoCell:output'] },
      { name: '$local:1:mem', instancePath: ['MemoCell:output'] },
    ]);
    expect(result.plan?.producers).toHaveLength(3);
    expect(result.plan?.producers).toMatchObject([
      { kind: 'constant', destinations: [{ network: 'test' }] },
      {
        kind: 'arithmetic',
        left: { kind: 'each', network: 'test' },
        operation: 'add',
        right: { kind: 'constant', value: 0 },
        destinations: [{ network: 'output' }, { network: '$local:1:mem' }],
      },
      {
        kind: 'decider',
        condition: {
          kind: 'and',
          conditions: [
            { kind: 'compare-each', network: 'test', comparator: '=', constant: 0 },
            {
              kind: 'compare-each',
              network: '$local:1:mem',
              comparator: '!=',
              constant: 0,
            },
          ],
        },
        output: { kind: 'each', network: '$local:1:mem' },
        destinations: [{ network: 'output' }, { network: '$local:1:mem' }],
      },
    ]);
  });

  test('diagnoses an incomplete MemoCell instead of returning a partial CC-only plan', () => {
    const file = parseFile({
      path: 'incomplete-memo-cell.factorio.ts',
      text: `const SIGNAL_A = Signal("virtual", "signal-A");
function MemoCell(input: Readonly<Network>): Network {
  let out = new Network();
  let mem = new Network();
  to(out, mem) += input + 0;
  to(out, mem) += IF(input == 0 && mem != 0, mem);
}
let test: Network = CC(1 * SIGNAL_A);
let output = MemoCell(input);`,
    });

    const result = compileDirectPlan(file);
    expect(result.plan).toBeUndefined();
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({ code: 'CL1033', severity: 'error' }),
    );
  });

  test('reports an unsupported Network call', () => {
    const file = parseFile({
      path: 'unsupported.factorio.ts',
      text: 'const output: Network = Unknown(input, 2);',
    });

    expect(compileDirectPlan(file).diagnostics).toContainEqual(
      expect.objectContaining({ code: 'CL1001', severity: 'error' }),
    );
  });

  test('lowers a left-associative circuit chain through a temporary Network', () => {
    const file = parseFile({
      path: 'pipeline.factorio.ts',
      text: `function Pipeline(input: Readonly<Network>): Network {
  return input * 10 + 5;
}
const input = new Network<G>();
const output: Network = Pipeline(input);`,
    });

    const result = compileDirectPlan(file);
    expect(result.diagnostics).toEqual([]);
    expect(result.plan).toMatchObject({
      networks: [{ name: 'input', fixedColor: 'green' }, { name: 'output' }, { name: '$tmp:1' }],
      producers: [
        {
          operation: 'multiply',
          destinations: [{ network: '$tmp:1' }],
        },
        {
          left: { kind: 'each', network: '$tmp:1' },
          operation: 'add',
          right: { kind: 'constant', value: 5 },
          destinations: [{ network: 'output' }],
        },
      ],
    });
  });

  test('folds an ordinary integer subexpression without adding a combinator', () => {
    const file = parseFile({
      path: 'fold.factorio.ts',
      text: `function Fold(input: Readonly<Network>): Network {
  return input * (2 + 3);
}
const input = new Network<R>();
const output: Network = Fold(input);`,
    });

    const result = compileDirectPlan(file);
    expect(result.diagnostics).toEqual([]);
    expect(result.plan?.producers).toMatchObject([
      {
        left: { kind: 'each', network: 'input' },
        operation: 'multiply',
        right: { kind: 'constant', value: 5 },
        destinations: [{ network: 'output' }],
      },
    ]);
    expect(result.plan?.networks.map(({ name }) => name)).toEqual(['input', 'output']);
  });

  test('resolves compile-time and circuit-valued local bindings', () => {
    const file = parseFile({
      path: 'bindings.factorio.ts',
      text: `function Pipeline(input: Readonly<Network>): Network {
  const base = 2 + 3;
  const scale = base * 2;
  const bias = 10 / 2;
  const scaled = input * scale;
  return scaled + bias;
}
const input = new Network<R>();
const output: Network = Pipeline(input);`,
    });

    const result = compileDirectPlan(file);
    expect(result.diagnostics).toEqual([]);
    expect(result.plan?.producers).toMatchObject([
      {
        operation: 'multiply',
        right: { kind: 'constant', value: 10 },
        destinations: [{ network: '$local:1:scaled' }],
      },
      {
        left: { kind: 'each', network: '$local:1:scaled' },
        operation: 'add',
        right: { kind: 'constant', value: 5 },
        destinations: [{ network: 'output' }],
      },
    ]);
    expect(result.plan?.networks).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: '$local:1:scaled' })]),
    );
  });

  test('composes multiple arithmetic Network function calls in source order', () => {
    const file = parseFile({
      path: 'composed.factorio.ts',
      text: `function Scale(input: Readonly<Network>): Network {
  const scaled = input * 5;
  return scaled;
}
function Bias(input: Readonly<Network>): Network {
  return input + 5;
}
const input = new Network<R>();
const middle: Network = Scale(input);
const output: Network = Bias(middle);`,
    });

    const result = compileDirectPlan(file);
    expect(result.diagnostics).toEqual([]);
    expect(result.plan?.producers).toMatchObject([
      {
        operation: 'multiply',
        destinations: [{ network: 'middle' }],
      },
      {
        left: { kind: 'each', network: 'middle' },
        operation: 'add',
        destinations: [{ network: 'output' }],
      },
    ]);
    expect(result.plan?.networks.map(({ name }) => name)).toEqual(['input', 'middle', 'output']);
    expect(result.plan?.networks.map(({ name, instancePath }) => [name, instancePath])).toEqual([
      ['input', []],
      ['middle', ['Scale:middle']],
      ['output', ['Bias:output']],
    ]);
    expect(result.plan?.producers.map(({ instancePath }) => instancePath)).toEqual([
      ['Scale:middle'],
      ['Bias:output'],
    ]);
    expect(
      result.plan?.producers.flatMap(({ destinations }) =>
        destinations.map(({ instancePath }) => instancePath),
      ),
    ).toEqual([['Scale:middle'], ['Bias:output']]);
  });

  test('attaches a producer call to an existing Network with +=', () => {
    const file = parseFile({
      path: 'attachment.factorio.ts',
      text: `function Scale(input: Readonly<Network>): Network {
  return input * 10;
}
const input = new Network<R>();
const output = new Network();
output += Scale(input);`,
    });

    const result = compileDirectPlan(file);
    expect(result.diagnostics).toEqual([]);
    expect(result.plan?.networks.map(({ name, instancePath }) => [name, instancePath])).toEqual([
      ['input', []],
      ['output', []],
    ]);
    expect(result.plan?.producers).toMatchObject([
      {
        kind: 'arithmetic',
        operation: 'multiply',
        destinations: [{ network: 'output', instancePath: ['Scale:output'] }],
        instancePath: ['Scale:output'],
      },
    ]);
  });

  test('fans one producer out to two Networks with .to(...)', () => {
    const file = parseFile({
      path: 'fan-out.factorio.ts',
      text: `function Delay(input: Readonly<Network>): Network {
  return input + 0;
}
const input = new Network<R>();
const output = new Network();
const mirror = new Network();
Delay(input).to(output, mirror);`,
    });

    const result = compileDirectPlan(file);
    expect(result.diagnostics).toEqual([]);
    expect(result.plan?.producers).toMatchObject([
      {
        kind: 'arithmetic',
        destinations: [
          { network: 'output', instancePath: ['Delay:output+mirror'] },
          { network: 'mirror', instancePath: ['Delay:output+mirror'] },
        ],
        instancePath: ['Delay:output+mirror'],
      },
    ]);
  });

  test('validates .to(...) destination count and identity', () => {
    const file = parseFile({
      path: 'invalid-fan-out.factorio.ts',
      text: `function Delay(input: Readonly<Network>): Network {
  return input + 0;
}
const input = new Network<R>();
const output = new Network();
Delay(input).to(output, output);`,
    });

    expect(compileDirectPlan(file).diagnostics).toContainEqual(
      expect.objectContaining({ code: 'CL1021', severity: 'error' }),
    );
  });

  test('rejects Network += Network and unknown attachment destinations', () => {
    const networkMerge = parseFile({
      path: 'network-merge.factorio.ts',
      text: `const input = new Network<R>();
const output = new Network();
output += input;`,
    });
    const unknownDestination = parseFile({
      path: 'unknown-attachment.factorio.ts',
      text: `function Scale(input: Readonly<Network>): Network {
  return input * 10;
}
const input = new Network<R>();
missing += Scale(input);`,
    });

    expect(compileDirectPlan(networkMerge).diagnostics).toContainEqual(
      expect.objectContaining({ code: 'CL1017', severity: 'error' }),
    );
    expect(compileDirectPlan(unknownDestination).diagnostics).toContainEqual(
      expect.objectContaining({ code: 'CL1016', severity: 'error' }),
    );
  });

  test('lowers direct two-input arithmetic into a two-output destination set', () => {
    const file = parseFile({
      path: 'direct-arithmetic.factorio.ts',
      text: `const a = new Network();
const b = new Network();
const c = new Network();
const d = new Network();
to(c, d) += a + b;`,
    });

    const result = compileDirectPlan(file);
    expect(result.diagnostics).toEqual([]);
    expect(result.plan?.producers).toMatchObject([
      {
        kind: 'arithmetic',
        left: { kind: 'each', network: 'a' },
        operation: 'add',
        right: { kind: 'each', network: 'b' },
        destinations: [{ network: 'c' }, { network: 'd' }],
      },
    ]);
  });

  test('binds specific-signal arithmetic to an explicit destination Signal', () => {
    const file = parseFile({
      path: 'signal-arithmetic.factorio.ts',
      text: `const LEFT = Signal("virtual", "signal-A");
const RIGHT = Signal("virtual", "signal-B");
const RESULT = Signal("virtual", "signal-C");
const a = new Network();
const b = new Network();
const out = new Network();
out[RESULT] += a[LEFT] + b[RIGHT];`,
    });

    const result = compileDirectPlan(file);
    expect(result.diagnostics).toEqual([]);
    expect(result.plan?.producers).toMatchObject([
      {
        kind: 'arithmetic',
        left: { kind: 'signal', network: 'a', signal: { name: 'signal-A' } },
        right: { kind: 'signal', network: 'b', signal: { name: 'signal-B' } },
        output: { kind: 'signal', signal: { name: 'signal-C' } },
        destinations: [{ network: 'out' }],
      },
    ]);
  });

  test('binds a function result Signal across two destinations', () => {
    const file = parseFile({
      path: 'signal-function.factorio.ts',
      text: `const VALUE = Signal("virtual", "signal-A");
const RESULT = Signal("virtual", "signal-C");
function Double(input: Readonly<Network>): Network {
  return input[VALUE] * 2;
}
const input = new Network();
const out = new Network();
const mirror = new Network();
to(out, mirror, RESULT) += Double(input);`,
    });

    const result = compileDirectPlan(file);
    expect(result.diagnostics).toEqual([]);
    expect(result.plan?.producers).toMatchObject([
      {
        kind: 'arithmetic',
        left: { kind: 'signal', network: 'input', signal: { name: 'signal-A' } },
        output: { kind: 'signal', signal: { name: 'signal-C' } },
        destinations: [{ network: 'out' }, { network: 'mirror' }],
      },
    ]);
  });

  test('binds a function result through one selected fluent destination', () => {
    const file = parseFile({
      path: 'single-selected-function.factorio.ts',
      text: `const VALUE = Signal("virtual", "signal-A");
const RESULT = Signal("virtual", "signal-C");
function Double(input: Readonly<Network>): Network {
  return input[VALUE] * 2;
}
const input = new Network();
const out = new Network();
Double(input).to(out[RESULT]);`,
    });

    expect(compileDirectPlan(file).plan?.producers[0]).toMatchObject({
      kind: 'arithmetic',
      output: { kind: 'signal', signal: { name: 'signal-C' } },
      destinations: [{ network: 'out' }],
    });
  });

  test('rejects element-access Signal binding on a fan-out destination', () => {
    const file = parseFile({
      path: 'selected-fanout.factorio.ts',
      text: `const RESULT = Signal("virtual", "signal-C");
const input = new Network();
const out = new Network();
const mirror = new Network();
to(out, mirror)[RESULT] += input + 1;`,
    });

    expect(compileDirectPlan(file).diagnostics).toContainEqual(
      expect.objectContaining({ code: 'CL1023', severity: 'error' }),
    );
  });

  test('rejects an undeclared destination Signal binding', () => {
    const file = parseFile({
      path: 'unknown-output-signal.factorio.ts',
      text: `const input = new Network();
const output = new Network();
output[UNKNOWN] += input + 1;`,
    });

    expect(compileDirectPlan(file).diagnostics).toContainEqual(
      expect.objectContaining({ code: 'CL1019', severity: 'error' }),
    );
  });

  test('lowers a direct IF feedback attachment', () => {
    const file = parseFile({
      path: 'direct-if.factorio.ts',
      text: `const a = new Network();
a += IF(a > 0, a);`,
    });

    const result = compileDirectPlan(file);
    expect(result.diagnostics).toEqual([]);
    expect(result.plan?.producers).toMatchObject([
      {
        kind: 'decider',
        condition: { kind: 'compare-each', network: 'a' },
        output: { kind: 'each', network: 'a' },
        destinations: [{ network: 'a' }],
      },
    ]);
  });

  test('warns and checks a standalone IF through an unused sink', () => {
    const file = parseFile({
      path: 'standalone-if.factorio.ts',
      text: `const a = new Network();
const d = new Network();
IF(a > 0, d);`,
    });

    const result = compileDirectPlan(file);
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({ code: 'CL2001', severity: 'warning' }),
    );
    expect(result.plan?.producers).toMatchObject([
      { kind: 'decider', destinations: [{ network: '$unused:1' }] },
    ]);
  });

  test('lowers attached and standalone when(...).then(...) deciders', () => {
    const attached = parseFile({
      path: 'attached-when.factorio.ts',
      text: `const a = new Network();
a += when(a > 0).then(a);`,
    });
    const standalone = parseFile({
      path: 'standalone-when.factorio.ts',
      text: `const a = new Network();
const b = new Network();
const c = new Network();
when(a > 0 && b > 0).then(c);`,
    });

    const attachedResult = compileDirectPlan(attached);
    expect(attachedResult.diagnostics).toEqual([]);
    expect(attachedResult.plan?.producers).toMatchObject([
      { kind: 'decider', destinations: [{ network: 'a' }] },
    ]);
    const standaloneResult = compileDirectPlan(standalone);
    expect(standaloneResult.diagnostics).toContainEqual(
      expect.objectContaining({ code: 'CL2001', severity: 'warning' }),
    );
    expect(standaloneResult.plan?.producers).toMatchObject([
      {
        kind: 'decider',
        condition: { kind: 'and' },
        output: { kind: 'each', network: 'c' },
        destinations: [{ network: '$unused:1' }],
      },
    ]);
  });

  test('warns and lowers standalone arithmetic', () => {
    const file = parseFile({
      path: 'standalone-arithmetic.factorio.ts',
      text: `const a = new Network();
const b = new Network();
a + b;`,
    });

    const result = compileDirectPlan(file);
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({ code: 'CL2001', severity: 'warning' }),
    );
    expect(result.plan?.producers).toMatchObject([
      { kind: 'arithmetic', destinations: [{ network: '$unused:1' }] },
    ]);
  });

  test('lowers CC through contextual, existing, and multi-output destinations', () => {
    const file = parseFile({
      path: 'constant-combinators.factorio.ts',
      text: `const A = Signal("virtual", "signal-A");
const B = Signal("virtual", "signal-B");
const contextual: Network = CC(5 * A, -2 * B);
const existing = new Network();
existing += CC(1 * A);
const first = new Network();
const second = new Network();
to(first, second) += CC(B * 7);`,
    });

    const result = compileDirectPlan(file);
    expect(result.diagnostics).toEqual([]);
    expect(result.plan?.producers).toMatchObject([
      {
        kind: 'constant',
        outputs: [
          { signal: { name: 'signal-A' }, value: 5 },
          { signal: { name: 'signal-B' }, value: -2 },
        ],
        destinations: [{ network: 'contextual' }],
      },
      {
        kind: 'constant',
        outputs: [{ signal: { name: 'signal-A' }, value: 1 }],
        destinations: [{ network: 'existing' }],
      },
      {
        kind: 'constant',
        outputs: [{ signal: { name: 'signal-B' }, value: 7 }],
        destinations: [{ network: 'first' }, { network: 'second' }],
      },
    ]);
  });

  test('materializes direct producers through contextual Network declarations', () => {
    const parsed = parseFile({
      path: 'contextual-producers.factorio.ts',
      text: `const A = Signal("virtual", "signal-A");
const a = new Network();
const b = new Network();
const sum: Network = a + b;
const gated: Network = IF(sum[A] > 0, sum[A]);
const final: Network = when(gated[A] > 0).then(gated[A]);`,
    });
    const result = compileDirectPlan(parsed);

    expect(result.diagnostics).toEqual([]);
    expect(result.plan?.networks.map(({ name }) => name)).toEqual([
      'a',
      'b',
      'sum',
      'gated',
      'final',
    ]);
    expect(result.plan?.producers).toMatchObject([
      { kind: 'arithmetic', destinations: [{ network: 'sum' }] },
      { kind: 'decider', destinations: [{ network: 'gated' }] },
      { kind: 'decider', destinations: [{ network: 'final' }] },
    ]);
  });

  test('lowers a constant EACH decider output without an arithmetic producer', () => {
    const parsed = parseFile({
      path: 'constant-each-output.factorio.ts',
      text: `const input = new Network();
const output: Network = IF(input > 0, 0x00ff00 * EACH);`,
    });
    const result = compileDirectPlan(parsed);

    expect(result.diagnostics).toEqual([]);
    expect(result.plan?.producers).toMatchObject([
      {
        kind: 'decider',
        output: { kind: 'each-constant', value: 0x00ff00 },
        destinations: [{ network: 'output' }],
      },
    ]);
  });

  test('validates constant EACH decider output counts', () => {
    const parsed = parseFile({
      path: 'invalid-constant-each-output.factorio.ts',
      text: `const input = new Network();
const output: Network = IF(input > 0, 2147483648 * EACH);`,
    });

    expect(compileDirectPlan(parsed).diagnostics).toContainEqual(
      expect.objectContaining({ code: 'CL1027', severity: 'error' }),
    );
  });

  test('accepts explicit Each(network) and network[EACH] selections', () => {
    const parsed = parseFile({
      path: 'explicit-each.factorio.ts',
      text: `const input = new Network();
const scaled: Network = Each(input) * 2;
const output: Network = IF(scaled[EACH] > 0, Each(scaled));`,
    });
    const result = compileDirectPlan(parsed);

    expect(result.diagnostics).toEqual([]);
    expect(result.plan?.producers).toMatchObject([
      {
        kind: 'arithmetic',
        left: { kind: 'each', network: 'input' },
        destinations: [{ network: 'scaled' }],
      },
      {
        kind: 'decider',
        condition: { kind: 'compare-each', network: 'scaled' },
        output: { kind: 'each', network: 'scaled' },
        destinations: [{ network: 'output' }],
      },
    ]);
  });

  test('validates explicit Each selections', () => {
    const parsed = parseFile({
      path: 'invalid-explicit-each.factorio.ts',
      text: `const output: Network = Each(1) * 2;`,
    });

    expect(compileDirectPlan(parsed).diagnostics).toContainEqual(
      expect.objectContaining({ code: 'CL1028', severity: 'error' }),
    );
  });

  test('lowers Anything and Everything condition selections', () => {
    const parsed = parseFile({
      path: 'quantifier-conditions.factorio.ts',
      text: `const A = Signal("virtual", "signal-A");
const input = new Network();
const any: Network = IF(Anything(input) > 0, input[A]);
const all: Network = IF(0 < input[EVERYTHING], input[A]);`,
    });
    const result = compileDirectPlan(parsed);

    expect(result.diagnostics).toEqual([]);
    expect(result.plan?.producers).toMatchObject([
      {
        kind: 'decider',
        condition: {
          kind: 'compare-wildcard',
          network: 'input',
          wildcard: 'anything',
          comparator: '>',
          constant: 0,
        },
      },
      {
        kind: 'decider',
        condition: {
          kind: 'compare-wildcard',
          network: 'input',
          wildcard: 'everything',
          comparator: '>',
          constant: 0,
        },
      },
    ]);
  });

  test('rejects an EACH output without an Each condition', () => {
    const parsed = parseFile({
      path: 'invalid-quantifier-output.factorio.ts',
      text: `const input = new Network();
const output: Network = IF(Anything(input) > 0, input);`,
    });

    expect(compileDirectPlan(parsed).diagnostics).toContainEqual(
      expect.objectContaining({ code: 'CL1029', severity: 'error' }),
    );
  });

  test('lowers Anything and Everything decider outputs', () => {
    const parsed = parseFile({
      path: 'quantifier-outputs.factorio.ts',
      text: `const input = new Network();
const any: Network = IF(input > 0, Anything(input));
const all: Network = IF(Anything(input) > 0, input[EVERYTHING]);`,
    });
    const result = compileDirectPlan(parsed);

    expect(result.diagnostics).toEqual([]);
    expect(result.plan?.producers).toMatchObject([
      {
        kind: 'decider',
        output: { kind: 'wildcard', network: 'input', wildcard: 'anything' },
      },
      {
        kind: 'decider',
        output: { kind: 'wildcard', network: 'input', wildcard: 'everything' },
      },
    ]);
  });

  test('rejects Everything output with an Each condition', () => {
    const parsed = parseFile({
      path: 'invalid-everything-output.factorio.ts',
      text: `const input = new Network();
const output: Network = IF(input > 0, Everything(input));`,
    });

    expect(compileDirectPlan(parsed).diagnostics).toContainEqual(
      expect.objectContaining({ code: 'CL1030', severity: 'error' }),
    );
  });

  test('accepts Any and All aliases in call and element-access forms', () => {
    const parsed = parseFile({
      path: 'quantifier-aliases.factorio.ts',
      text: `const A = Signal("virtual", "signal-A");
const input = new Network();
const anyCondition: Network = IF(Any(input) > 0, input[A]);
const allCondition: Network = IF(input[ALL] > 0, input[A]);
const anyOutput: Network = IF(input > 0, input[ANY]);
const allOutput: Network = IF(Any(input) > 0, All(input));`,
    });
    const result = compileDirectPlan(parsed);

    expect(result.diagnostics).toEqual([]);
    expect(result.plan?.producers).toMatchObject([
      { condition: { kind: 'compare-wildcard', wildcard: 'anything' } },
      { condition: { kind: 'compare-wildcard', wildcard: 'everything' } },
      { output: { kind: 'wildcard', wildcard: 'anything' } },
      { output: { kind: 'wildcard', wildcard: 'everything' } },
    ]);
  });

  test('validates CC entries and duplicate Signals', () => {
    const malformed = parseFile({
      path: 'malformed-cc.factorio.ts',
      text: `const A = Signal("virtual", "signal-A");
const out = new Network();
out += CC(A);`,
    });
    const duplicate = parseFile({
      path: 'duplicate-cc.factorio.ts',
      text: `const A = Signal("virtual", "signal-A");
const out = new Network();
out += CC(1 * A, 2 * A);`,
    });

    expect(compileDirectPlan(malformed).diagnostics).toContainEqual(
      expect.objectContaining({ code: 'CL1024', severity: 'error' }),
    );
    expect(compileDirectPlan(duplicate).diagnostics).toContainEqual(
      expect.objectContaining({ code: 'CL1025', severity: 'error' }),
    );
  });

  test('lowers compact IF to one Each decider', () => {
    const file = parseFile({
      path: 'gate.factorio.ts',
      text: `function Gate(input: Readonly<Network>): Network {
  return IF(input > 40, input);
}
const input = new Network<R>();
const output: Network = Gate(input);`,
    });

    const result = compileDirectPlan(file);
    expect(result.diagnostics).toEqual([]);
    expect(result.plan?.producers).toMatchObject([
      {
        kind: 'decider',
        condition: {
          kind: 'compare-each',
          network: 'input',
          comparator: '>',
          constant: 40,
        },
        output: { kind: 'each', network: 'input' },
        destinations: [{ network: 'output' }],
        instancePath: ['Gate:output'],
      },
    ]);
  });

  test('lowers a declared Signal selection to a specific-signal decider', () => {
    const file = parseFile({
      path: 'signal-gate.factorio.ts',
      text: `const SIGNAL_A = Signal("virtual", "signal-A");
function Gate(input: Readonly<Network>): Network {
  return IF(input[SIGNAL_A] > 40, input[SIGNAL_A]);
}
const input = new Network<R>();
const output: Network = Gate(input);`,
    });

    const result = compileDirectPlan(file);
    expect(result.diagnostics).toEqual([]);
    expect(result.plan?.producers).toMatchObject([
      {
        kind: 'decider',
        condition: {
          kind: 'compare-signal',
          network: 'input',
          signal: { type: 'virtual', name: 'signal-A' },
          comparator: '>',
          constant: 40,
        },
        output: {
          kind: 'signal',
          network: 'input',
          signal: { type: 'virtual', name: 'signal-A' },
        },
      },
    ]);
  });

  test('validates Signal declarations and infers a specific arithmetic output fallback', () => {
    const incompleteSignal = parseFile({
      path: 'incomplete-signal.factorio.ts',
      text: 'const SIGNAL_A = Signal();',
    });
    const nameOnlySignal = parseFile({
      path: 'name-only-signal.factorio.ts',
      text: `const CHEST = Signal("chest");
function Count(input: Readonly<Network>): Network {
  return input[CHEST] + 1;
}
const input = new Network<R>();
const output: Network = Count(input);`,
    });
    const unresolvedArithmeticOutput = parseFile({
      path: 'signal-arithmetic.factorio.ts',
      text: `const SIGNAL_A = Signal("virtual", "signal-A");
function Scale(input: Readonly<Network>): Network {
  return input[SIGNAL_A] * 2;
}
const input = new Network<R>();
const output: Network = Scale(input);`,
    });

    expect(compileDirectPlan(incompleteSignal).diagnostics).toContainEqual(
      expect.objectContaining({ code: 'CL1019', severity: 'error' }),
    );
    expect(compileDirectPlan(nameOnlySignal).plan?.producers).toMatchObject([
      {
        kind: 'arithmetic',
        left: { kind: 'signal', signal: { type: 'item', name: 'chest' } },
        output: { kind: 'signal', signal: { type: 'item', name: 'chest' } },
      },
    ]);
    expect(compileDirectPlan(unresolvedArithmeticOutput).plan?.producers).toMatchObject([
      {
        kind: 'arithmetic',
        left: { kind: 'signal', signal: { name: 'signal-A' } },
        output: { kind: 'signal', signal: { name: 'signal-A' } },
      },
    ]);
  });

  test('binds an arithmetic producer output with .as(Signal) without adding hardware', () => {
    const file = parseFile({
      path: 'arithmetic-as.factorio.ts',
      text: `const INPUT = Signal("virtual", "signal-A");
const RESULT = Signal("virtual", "signal-B");
function Remap(input: Readonly<Network>): Network {
  return (input[INPUT] + 1).as(RESULT);
}
const input = new Network<R>();
const output: Network = Remap(input);`,
    });

    const result = compileDirectPlan(file);
    expect(result.diagnostics).toEqual([]);
    expect(result.plan?.producers).toHaveLength(1);
    expect(result.plan?.producers[0]).toMatchObject({
      kind: 'arithmetic',
      left: { kind: 'signal', signal: { name: 'signal-A' } },
      output: { kind: 'signal', signal: { name: 'signal-B' } },
      destinations: [{ network: 'output' }],
    });
  });

  test('binds a compact decider output with .as(Signal)', () => {
    const file = parseFile({
      path: 'decider-as.factorio.ts',
      text: `const RESULT = Signal("virtual", "signal-B");
function Gate(input: Readonly<Network>): Network {
  return IF(input > 0, input).as(RESULT);
}
const input = new Network<R>();
const output: Network = Gate(input);`,
    });

    const result = compileDirectPlan(file);
    expect(result.diagnostics).toEqual([]);
    expect(result.plan?.producers[0]).toMatchObject({
      kind: 'decider',
      output: { kind: 'signal', network: 'input', signal: { name: 'signal-B' } },
    });
  });

  test('rejects malformed and conflicting .as(Signal) bindings', () => {
    const malformed = parseFile({
      path: 'malformed-as.factorio.ts',
      text: `function Scale(input: Readonly<Network>): Network {
  return (input + 1).as(UNKNOWN);
}
const input = new Network<R>();
const output: Network = Scale(input);`,
    });
    const conflicting = parseFile({
      path: 'conflicting-as.factorio.ts',
      text: `const A = Signal("virtual", "signal-A");
const B = Signal("virtual", "signal-B");
const input = new Network<R>();
const output = new Network();
output[A] += (input + 1).as(B);`,
    });

    expect(compileDirectPlan(malformed).diagnostics).toContainEqual(
      expect.objectContaining({ code: 'CL1031', severity: 'error' }),
    );
    expect(compileDirectPlan(conflicting).diagnostics).toContainEqual(
      expect.objectContaining({ code: 'CL1032', severity: 'error' }),
    );
  });

  test('keeps compound IF predicates inside one decider descriptor', () => {
    const file = parseFile({
      path: 'window.factorio.ts',
      text: `function Window(input: Readonly<Network>): Network {
  return IF((input > 40 && input < 50) || input === 100, input);
}
const input = new Network<R>();
const output: Network = Window(input);`,
    });

    const result = compileDirectPlan(file);
    expect(result.diagnostics).toEqual([]);
    expect(result.plan?.producers).toHaveLength(1);
    expect(result.plan?.producers[0]).toMatchObject({
      kind: 'decider',
      condition: {
        kind: 'or',
        conditions: [
          {
            kind: 'and',
            conditions: [
              { kind: 'compare-each', comparator: '>', constant: 40 },
              { kind: 'compare-each', comparator: '<', constant: 50 },
            ],
          },
          { kind: 'compare-each', comparator: '=', constant: 100 },
        ],
      },
    });
  });

  test('normalizes negated IF predicates with comparison inversion and De Morgan', () => {
    const file = parseFile({
      path: 'negated-window.factorio.ts',
      text: `function Window(input: Readonly<Network>): Network {
  return IF(!(40 >= input || input >= 50), input);
}
const input = new Network<R>();
const output: Network = Window(input);`,
    });

    const result = compileDirectPlan(file);
    expect(result.diagnostics).toEqual([]);
    expect(result.plan?.producers).toHaveLength(1);
    expect(result.plan?.producers[0]).toMatchObject({
      kind: 'decider',
      condition: {
        kind: 'and',
        conditions: [
          { kind: 'compare-each', comparator: '>', constant: 40 },
          { kind: 'compare-each', comparator: '<', constant: 50 },
        ],
      },
    });
  });

  test.each([
    ['40 < input', '>'],
    ['40 <= input', '>='],
    ['40 > input', '<'],
    ['40 >= input', '<='],
    ['40 === input', '='],
    ['40 !== input', '!='],
  ] as const)('canonicalizes a left-side constant: %s', (condition, expectedComparator) => {
    const file = parseFile({
      path: 'reversed-comparison.factorio.ts',
      text: `function Gate(input: Readonly<Network>): Network {
  return IF(${condition}, input);
}
const input = new Network<R>();
const output: Network = Gate(input);`,
    });

    const result = compileDirectPlan(file);
    expect(result.diagnostics).toEqual([]);
    expect(result.plan?.producers[0]).toMatchObject({
      kind: 'decider',
      condition: {
        kind: 'compare-each',
        network: 'input',
        comparator: expectedComparator,
        constant: 40,
      },
    });
  });

  test('rejects unsupported compact IF shapes explicitly', () => {
    const file = parseFile({
      path: 'invalid-gate.factorio.ts',
      text: `function Gate(input: Readonly<Network>): Network {
  return IF(input < input, input);
}
const input = new Network<R>();
const output: Network = Gate(input);`,
    });

    expect(compileDirectPlan(file).diagnostics).toContainEqual(
      expect.objectContaining({ code: 'CL1014', severity: 'error' }),
    );
  });

  test('lowers a two-Network signal comparison into one decider', () => {
    const file = parseFile({
      path: 'network-comparison.factorio.ts',
      text: `const SIGNAL_A = Signal("virtual", "signal-A");
function Greater(
  value: Readonly<Network>,
  threshold: Readonly<Network>,
): Network {
  return IF(value[SIGNAL_A] > threshold[SIGNAL_A], value[SIGNAL_A]);
}
const value = new Network<R>();
const threshold = new Network();
const output: Network = Greater(value, threshold);`,
    });

    const result = compileDirectPlan(file);
    expect(result.diagnostics).toEqual([]);
    expect(result.plan?.producers).toMatchObject([
      {
        kind: 'decider',
        condition: {
          kind: 'compare-signals',
          left: { network: 'value' },
          comparator: '>',
          right: { network: 'threshold' },
        },
        output: { kind: 'signal', network: 'value' },
      },
    ]);
  });

  test('rejects circular local bindings', () => {
    const file = parseFile({
      path: 'invalid-binding.factorio.ts',
      text: `function Invalid(input: Readonly<Network>): Network {
  const first = second;
  const second = first;
  return input * first;
}
const input = new Network<R>();
const output: Network = Invalid(input);`,
    });

    expect(compileDirectPlan(file).diagnostics).toContainEqual(
      expect.objectContaining({ code: 'CL1010', severity: 'error' }),
    );
  });

  test.each([
    ['fractional result', 'input * (1 / 2)', 'CL1007'],
    ['division by zero', 'input * (1 / 0)', 'CL1007'],
    ['out-of-range circuit constant', 'input + (2147483647 + 1)', 'CL1008'],
  ])('reports invalid compile-time arithmetic: %s', (_case, expression, code) => {
    const file = parseFile({
      path: 'invalid-fold.factorio.ts',
      text: `function Invalid(input: Readonly<Network>): Network {
  return ${expression};
}
const input = new Network<R>();
const output: Network = Invalid(input);`,
    });

    expect(compileDirectPlan(file).diagnostics).toContainEqual(
      expect.objectContaining({ code, severity: 'error' }),
    );
  });

  test('rejects a pure integer result where a Network producer is required', () => {
    const file = parseFile({
      path: 'constant-result.factorio.ts',
      text: `function Constant(_input: Readonly<Network>): Network {
  return 2 + 3;
}
const input = new Network<R>();
const output: Network = Constant(input);`,
    });

    expect(compileDirectPlan(file).diagnostics).toContainEqual(
      expect.objectContaining({ code: 'CL1009', severity: 'error' }),
    );
  });
});

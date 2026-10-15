import { describe, expect, test } from 'vitest';
import {
  createTrustedEntityReplayContext,
  generateBlueprintJson,
  syntheticZeroPortEntityProfile,
} from '@comblang/compiler';
import type { EntityProfile } from '@comblang/compiler/entity';
import type { EntityPrototype } from '@comblang/prototypes';
import * as sourceApi from './source-compilation.js';
import type { EntityPrototypeResolver } from './entity-registry.js';

const options = { label: 'Source Math parameter capture', maxDeciderConditionRows: 1024 };

function parameterHost() {
  const families = [
    'constant-combinator',
    'arithmetic-combinator',
    'decider-combinator',
    'selector-combinator',
  ] as const;
  const profiles = families.map((family, index) => ({
    ...structuredClone(syntheticZeroPortEntityProfile),
    ref: {
      ...syntheticZeroPortEntityProfile.ref,
      prototypeKey: `entity:${family}` as EntityProfile['ref']['prototypeKey'],
      profileId: `profile:source-math-parameter-${index}` as EntityProfile['ref']['profileId'],
    },
    prototypeType: family,
  }));
  const trustedEntityReplayContext = createTrustedEntityReplayContext({
    database: profiles[0]!.ref.database,
    source: 'synthetic',
    evidenceIdentity: 'source-math-parameter-test-evidence',
    policyIdentity: 'source-math-parameter-test-policy',
    profiles,
  });
  const prototypes = families.map((family) => ({
    key: `entity:${family}` as EntityPrototype['key'],
    name: family,
    type: family,
    tileWidth: 1,
    tileHeight: 1,
  })) as EntityPrototype[];
  const entityPrototypeResolver: EntityPrototypeResolver = {
    database: trustedEntityReplayContext.database,
    getEntity(nameOrKey) {
      return prototypes.find(({ key, name }) => key === nameOrKey || name === nameOrKey);
    },
  };
  return { trustedEntityReplayContext, entityPrototypeResolver };
}

function compile(text: string) {
  return sourceApi.compileSourceProgram(
    { path: 'source-math-parameters.factorio.ts', text },
    parameterHost(),
  );
}

function filterCounts(pair: ReturnType<typeof sourceApi.bindSourceCompilationCircuit>): number[] {
  const blueprint = generateBlueprintJson(pair.resolvedCircuit.ir).blueprint;
  const behavior = blueprint.entities[0]!.control_behavior as {
    sections: { sections: { filters: { count: number }[] }[] };
  };
  return behavior.sections.sections[0]!.filters.map(({ count }) => count);
}

describe('source Math calls with nominal numeric parameters', () => {
  test('captures all five original builtins through aliases, getters, computed members and spread', () => {
    const text = `const A = Signal('virtual', 'signal-A');
const B = Signal('virtual', 'signal-B');
const C = Signal('virtual', 'signal-C');
const D = Signal('virtual', 'signal-D');
const E = Signal('virtual', 'signal-E');
const F = Signal('virtual', 'signal-F');
const G = Signal('virtual', 'signal-G');
const H = Signal('virtual', 'signal-H');
const I = Signal('virtual', 'signal-I');
const amount = Param.number('Amount', 8, { variable: 'x' });
const { abs, max } = Math;
const math = Math;
const mathView = { get log2() { return Math.log2; } };
const output = new Network();
const absolute = abs(amount - 20);
const logarithm = mathView.log2(amount);
const sign = math['sign'](amount - 20);
const maximum = max(amount, ...[16, 24]);
const minimum = math.min(amount, 4);
const nested = Math.abs(Math.max(amount, 16) - 22);
const fractionalCount = Math.abs(amount / 4);
const duplicateAbsolute = Math.abs(amount - 20);
output += Constant({ sections: [{ filters: [
  { signal: A, value: amount },
  { signal: B, value: absolute },
  { signal: C, value: logarithm },
  { signal: D, value: sign },
  { signal: E, value: maximum },
  { signal: F, value: minimum },
  { signal: G, value: nested },
  { signal: H, value: fractionalCount },
  { signal: I, value: duplicateAbsolute },
] }] });`;
    const compilation = compile(text);
    expect(compilation.pipelineDiagnostics).toEqual([]);
    expect(compilation.resolvedCircuit).toBeDefined();

    const native = sourceApi.exportSourceCompilationNativeBlueprint(compilation, options);
    expect(native.parameters).toEqual([
      { type: 'number', number: '8', name: 'Amount', variable: 'x' },
      { type: 'number', number: '12', formula: 'abs((x - 20))', dependent: true },
      { type: 'number', number: '3', formula: 'log2(x)', dependent: true },
      { type: 'number', number: '-1', formula: 'sign((x - 20))', dependent: true },
      { type: 'number', number: '24', formula: 'max(x, 16, 24)', dependent: true },
      { type: 'number', number: '4', formula: 'min(x, 4)', dependent: true },
      { type: 'number', number: '6', formula: 'abs((max(x, 16) - 22))', dependent: true },
      { type: 'number', number: '2', formula: 'abs((x / 4))', dependent: true },
    ]);

    const amount = sourceApi.listSourceCompilationParameters(compilation)[0]!.parameter;
    expect(filterCounts(sourceApi.bindSourceCompilationCircuit(compilation))).toEqual([
      8, 12, 3, -1, 24, 4, 6, 2, 12,
    ]);
    expect(
      filterCounts(
        sourceApi.bindSourceCompilationCircuit(compilation, [{ parameter: amount, value: 16 }]),
      ),
    ).toEqual([16, 4, 4, -1, 24, 4, 6, 4, 4]);
    expect(filterCounts(sourceApi.bindSourceCompilationCircuit(compilation, []))).toEqual([
      8, 12, 3, -1, 24, 4, 6, 2, 12,
    ]);
  });

  test('uses the prepared original getter result and stable implementations after Math is replaced', () => {
    const getterKey = '__comblang_source_math_getter_count';
    const argumentKey = '__comblang_source_math_argument_count';
    const orderKey = '__comblang_source_math_effect_order';
    const globals = globalThis as Record<string, unknown>;
    const getterExisted = Object.hasOwn(globals, getterKey);
    const argumentExisted = Object.hasOwn(globals, argumentKey);
    const orderExisted = Object.hasOwn(globals, orderKey);
    const oldGetterCount = globals[getterKey];
    const oldArgumentCount = globals[argumentKey];
    const oldOrder = globals[orderKey];
    const originalAbs = Math.abs;
    globals[getterKey] = 0;
    globals[argumentKey] = 0;
    globals[orderKey] = [];
    try {
      const compilation = compile(`const A = Signal('virtual', 'signal-A');
const B = Signal('virtual', 'signal-B');
const C = Signal('virtual', 'signal-C');
const amount = Param.number('Amount', 8, { variable: 'x' });
const output = new Network();
const math = { get abs() { globalThis.${orderKey}.push('abs-callee'); globalThis.${getterKey} += 1; return Math.abs; } };
const value = math.abs((globalThis.${orderKey}.push('abs-argument'), globalThis.${argumentKey} += 1, (Math.abs = () => 999), amount));
const maxView = { get max() { globalThis.${orderKey}.push('max-callee'); return Math.max; } };
const maximum = maxView.max((globalThis.${orderKey}.push('max-argument'), amount), ...(globalThis.${orderKey}.push('max-spread'), [16, 24]));
output += Constant({ sections: [{ filters: [
  { signal: A, value: amount },
  { signal: B, value },
  { signal: C, value: maximum },
] }] });`);
      expect(compilation.pipelineDiagnostics).toEqual([]);
      expect(globals[getterKey]).toBe(1);
      expect(globals[argumentKey]).toBe(1);
      expect(globals[orderKey]).toEqual([
        'abs-callee',
        'abs-argument',
        'max-callee',
        'max-argument',
        'max-spread',
      ]);

      const amount = sourceApi.listSourceCompilationParameters(compilation)[0]!.parameter;
      expect(
        filterCounts(
          sourceApi.bindSourceCompilationCircuit(compilation, [{ parameter: amount, value: 20 }]),
        ),
      ).toEqual([20, 20, 24]);

      Math.abs = () => 1234;
      expect(
        filterCounts(
          sourceApi.bindSourceCompilationCircuit(compilation, [{ parameter: amount, value: 20 }]),
        ),
      ).toEqual([20, 20, 24]);
    } finally {
      Math.abs = originalAbs;
      if (getterExisted) globals[getterKey] = oldGetterCount;
      else delete globals[getterKey];
      if (argumentExisted) globals[argumentKey] = oldArgumentCount;
      else delete globals[argumentKey];
      if (orderExisted) globals[orderKey] = oldOrder;
      else delete globals[orderKey];
    }
  });

  test('binds function nodes only in reviewed local slots and recovers after a failed binding', () => {
    const key = '__comblang_source_math_slot_runs';
    const globals = globalThis as Record<string, unknown>;
    const existed = Object.hasOwn(globals, key);
    const previous = globals[key];
    globals[key] = 0;
    try {
      const compilation = compile(`globalThis.${key} += 1;
const A = Signal('virtual', 'signal-A');
const B = Signal('virtual', 'signal-B');
const E = Signal('virtual', 'signal-E');
const C = Signal('virtual', 'signal-C');
const D = Signal('virtual', 'signal-D');
const amount = Param.number('Amount', 8, { variable: 'x' });
const input = new Network();
const output = new Network();
input += CC(1 * A);
output += Constant({ sections: [{ multiplier: Math.log2(amount), filters: [
  { signal: A, value: amount },
  { signal: B, value: Math.abs(amount - 20) },
  { signal: E, value: Math.abs(amount / 2) },
] }] });
output += Arithmetic({ left: input[A], operation: 'add', right: Math.sign(amount - 10), output: C });
output += Decider({ condition: input[A] > Math.max(amount, 10), outputs: [input[A]] });
output += IF(input[A] > Math.min(amount, 12), [input[A]], { fallback: 1 * D });
output += when(input[A] > Math.abs(amount - 20)).then(input[A]);
output += Selector({ input, operation: 'select', index: Math.min(amount, 12) });`);
      expect(compilation.pipelineDiagnostics).toEqual([]);
      const originalArtifact = structuredClone(sourceApi.sourceCompilationArtifact(compilation));
      const parameter = sourceApi.listSourceCompilationParameters(compilation)[0]!.parameter;
      const entities = (
        overrides: readonly { parameter: typeof parameter; value: number }[] = [],
      ) =>
        generateBlueprintJson(
          sourceApi.bindSourceCompilationCircuit(compilation, overrides).resolvedCircuit.ir,
        ).blueprint.entities;
      const inspect = (items: ReturnType<typeof entities>) => {
        const constants = items.filter(({ name }) => name === 'constant-combinator');
        const arithmetic = items.find(({ name }) => name === 'arithmetic-combinator')!;
        const deciders = items.filter(({ name }) => name === 'decider-combinator');
        const selector = items.find(({ name }) => name === 'selector-combinator')!;
        return {
          sourceCounts: (
            constants[1]!.control_behavior as {
              sections: { sections: { multiplier: number; filters: { count: number }[] }[] };
            }
          ).sections.sections[0],
          arithmetic: arithmetic.control_behavior,
          deciders: deciders.map(({ control_behavior }) => control_behavior),
          selector: selector.control_behavior,
        };
      };

      const defaults = entities();
      expect(inspect(defaults)).toMatchObject({
        sourceCounts: { multiplier: 3, filters: [{ count: 8 }, { count: 12 }, { count: 4 }] },
        arithmetic: { arithmetic_conditions: { second_constant: -1 } },
        deciders: [
          { decider_conditions: { conditions: [{ constant: 10 }] } },
          { decider_conditions: { conditions: [{ constant: 8 }] } },
          { decider_conditions: { conditions: [{ constant: 12 }] } },
        ],
        selector: { index_constant: 8 },
      });
      expect(inspect(entities([{ parameter, value: 16 }]))).toMatchObject({
        sourceCounts: {
          multiplier: 4,
          filters: [{ count: 16 }, { count: 4 }, { count: 8 }],
        },
        arithmetic: { arithmetic_conditions: { second_constant: 1 } },
        deciders: [
          { decider_conditions: { conditions: [{ constant: 16 }] } },
          { decider_conditions: { conditions: [{ constant: 12 }] } },
          { decider_conditions: { conditions: [{ constant: 4 }] } },
        ],
        selector: { index_constant: 12 },
      });
      expect(entities()).toEqual(defaults);
      expect(() => entities([{ parameter, value: 0 }])).toThrowError(
        expect.objectContaining({ code: 'CP1000' }),
      );
      expect(() => entities([{ parameter, value: 9 }])).toThrowError(
        expect.objectContaining({ code: 'CP1000' }),
      );
      expect(inspect(entities([{ parameter, value: 16 }]))).toMatchObject({
        sourceCounts: { multiplier: 4 },
      });
      expect(globals[key]).toBe(1);
      const defaultsPair = sourceApi.bindSourceCompilationCircuit(compilation);
      const changedPair = sourceApi.bindSourceCompilationCircuit(compilation, [
        { parameter, value: 16 },
      ]);
      expect(defaultsPair.plan.entities.map(({ id, placement }) => ({ id, placement }))).toEqual(
        changedPair.plan.entities.map(({ id, placement }) => ({ id, placement })),
      );
      expect(
        defaultsPair.plan.producers.map(({ entityId, kind, placement }) => ({
          entityId,
          kind,
          placement,
        })),
      ).toEqual(
        changedPair.plan.producers.map(({ entityId, kind, placement }) => ({
          entityId,
          kind,
          placement,
        })),
      );
      expect(sourceApi.sourceCompilationArtifact(compilation)).toEqual(originalArtifact);
      expect(() => sourceApi.exportSourceCompilationNativeBlueprint(compilation, options)).toThrow(
        expect.objectContaining({ code: 'CP1002' }),
      );
    } finally {
      if (existed) globals[key] = previous;
      else delete globals[key];
    }
  });

  test('keeps equal-default formula collisions local and rejects them atomically on native export', () => {
    const text = `const amount = Param.number('Amount', 8, { variable: 'x' });
const output = new Network();
output += Constant({ sections: [{ filters: [
  { signal: Signal('virtual', 'signal-A'), value: amount },
  { signal: Signal('virtual', 'signal-B'), value: Math.min(amount, 4) },
  { signal: Signal('virtual', 'signal-C'), value: Math.abs(amount / 2) },
] }] });`;
    const compilation = compile(text);
    expect(compilation.pipelineDiagnostics).toEqual([]);
    expect(filterCounts(sourceApi.bindSourceCompilationCircuit(compilation))).toEqual([8, 4, 4]);
    const artifact = structuredClone(sourceApi.sourceCompilationArtifact(compilation));
    expect(() => sourceApi.exportSourceCompilationNativeBlueprint(compilation, options)).toThrow(
      expect.objectContaining({ code: 'CP1002' }),
    );
    expect(sourceApi.sourceCompilationArtifact(compilation)).toEqual(artifact);
  });

  test('rejects a number parameter from another source capture session at the call argument', () => {
    const key = '__comblang_foreign_source_math_parameter';
    const globals = globalThis as Record<string, unknown>;
    const existed = Object.hasOwn(globals, key);
    const previous = globals[key];
    try {
      const owner = compile(`const amount = Param.number('Foreign', 5);
globalThis.${key} = amount;`);
      expect(owner.pipelineDiagnostics).toEqual([]);

      const text = `const amount = Param.number('Local', 2);
const value = Math.abs(globalThis.${key});
const output = new Network();
output += Constant({ sections: [{ filters: [{ signal: Signal('virtual', 'signal-A'), value: amount }] }] });`;
      const compilation = compile(text);
      expect(compilation.resolvedCircuit).toBeUndefined();
      expect(compilation.pipelineDiagnostics).toEqual([
        expect.objectContaining({
          code: 'RT2027',
          span: expect.objectContaining({
            start: text.indexOf(`globalThis.${key}`),
            end: text.indexOf(`globalThis.${key}`) + `globalThis.${key}`.length,
          }),
        }),
      ]);
    } finally {
      if (existed) globals[key] = previous;
      else delete globals[key];
    }
  });

  test('preserves ordinary parameter-free JavaScript Math behavior', () => {
    const key = '__comblang_source_math_ordinary_values';
    const globals = globalThis as Record<string, unknown>;
    const existed = Object.hasOwn(globals, key);
    const previous = globals[key];
    try {
      const compilation = compile(
        `globalThis.${key} = [Math.max(), Math.min(5), Math.log2(0), Math.sign(-0), Math.abs('5'), Math?.abs?.(-5)];`,
      );
      expect(compilation.pipelineDiagnostics).toEqual([]);
      const values = globals[key] as number[];
      expect(values.slice(0, 3)).toEqual([-Infinity, 5, -Infinity]);
      expect(Object.is(values[3], -0)).toBe(true);
      expect(values[4]).toBe(5);
      expect(values[5]).toBe(5);
    } finally {
      if (existed) globals[key] = previous;
      else delete globals[key];
    }
  });

  test.each([
    ['Math.floor(amount)', 'Math.floor', 'RT2029'],
    ['Math.abs.bind(Math)(amount)', 'Math.abs.bind', 'RT2029'],
    ['Math.abs.call(Math, amount)', 'Math.abs.call', 'RT2029'],
    ['Math.abs.apply(Math, [amount])', 'Math.abs.apply', 'CP1001'],
    ['Math.abs(amount, 1)', 'Math.abs', 'RT2027'],
    ['Math.max(amount)', 'Math.max', 'RT2027'],
  ])('keeps unsupported wrappers and invalid arity located: %s', (expression, marker, code) => {
    const text = `const amount = Param.number('Amount', 8, { variable: 'x' });
const value = ${expression};
const output = new Network();
output += Constant({ sections: [{ filters: [{ signal: Signal('virtual', 'signal-A'), value: amount }, { signal: Signal('virtual', 'signal-B'), value }] }] });`;
    const compilation = compile(text);
    expect(compilation.resolvedCircuit).toBeUndefined();
    expect(compilation.pipelineDiagnostics).toHaveLength(1);
    expect(compilation.pipelineDiagnostics[0]).toMatchObject({
      code,
      span: expect.any(Object),
    });
    if (code !== 'CP1001') {
      expect(compilation.pipelineDiagnostics[0]!.span).toMatchObject({
        start: text.indexOf(marker),
        end: text.indexOf(expression) + expression.length,
      });
    }
  });

  test.each([
    ['Math.max(amount, Infinity)', 'Infinity'],
    ["Math.max(amount, Signal('virtual', 'signal-A'))", "Signal('virtual', 'signal-A')"],
  ])('locates rejected nonnumeric call operands: %s', (expression, offendingArgument) => {
    const text = `const amount = Param.number('Amount', 8, { variable: 'x' });
const value = ${expression};
const output = new Network();
output += Constant({ sections: [{ filters: [{ signal: Signal('virtual', 'signal-A'), value: amount }, { signal: Signal('virtual', 'signal-B'), value }] }] });`;
    const compilation = compile(text);
    expect(compilation.resolvedCircuit).toBeUndefined();
    expect(compilation.pipelineDiagnostics).toEqual([
      expect.objectContaining({
        code: 'RT2027',
        span: expect.objectContaining({
          start: text.indexOf(offendingArgument),
          end: text.indexOf(offendingArgument) + offendingArgument.length,
        }),
      }),
    ]);
  });

  test('checks symbolic arity before authenticating the evaluated operands', () => {
    const call = "Math.abs(amount, Signal('virtual', 'signal-A'))";
    const text = `const amount = Param.number('Amount', 8, { variable: 'x' });
const value = ${call};
const output = new Network();
output += Constant({ sections: [{ filters: [{ signal: Signal('virtual', 'signal-A'), value: amount }] }] });`;
    const compilation = compile(text);
    expect(compilation.resolvedCircuit).toBeUndefined();
    expect(compilation.pipelineDiagnostics).toEqual([
      expect.objectContaining({
        code: 'RT2027',
        message: expect.stringContaining('requires exactly one arguments'),
        span: expect.objectContaining({
          start: text.indexOf(call),
          end: text.indexOf(call) + call.length,
        }),
      }),
    ]);
  });

  test('accepts the 255-argument max boundary and rejects 256 symbolic arguments', () => {
    const validText = `const amount = Param.number('Amount', 8, { variable: 'x' });
const values = Array(254).fill(1);
const result = Math.max(amount, ...values);
const output = new Network();
output += Constant({ sections: [{ filters: [
  { signal: Signal('virtual', 'signal-A'), value: amount },
  { signal: Signal('virtual', 'signal-B'), value: result },
] }] });`;
    const valid = compile(validText);
    expect(valid.pipelineDiagnostics).toEqual([]);
    expect(valid.resolvedCircuit).toBeDefined();

    const invalidCall = 'Math.max(amount, ...Array(255).fill(1))';
    const invalidText = `const amount = Param.number('Amount', 8, { variable: 'x' });
const result = ${invalidCall};
const output = new Network();
output += Constant({ sections: [{ filters: [{ signal: Signal('virtual', 'signal-A'), value: amount }] }] });`;
    const invalid = compile(invalidText);
    expect(invalid.resolvedCircuit).toBeUndefined();
    expect(invalid.pipelineDiagnostics).toEqual([
      expect.objectContaining({
        code: 'RT2027',
        span: expect.objectContaining({
          start: invalidText.indexOf('Math.max'),
          end: invalidText.indexOf(invalidCall) + invalidCall.length,
        }),
      }),
    ]);
  });

  test('does not admit a shadowed Math method by name', () => {
    const text = `const amount = Param.number('Amount', 8, { variable: 'x' });
const Math = { abs: (value: unknown) => value };
const value = Math.abs(amount);
const output = new Network();
output += Constant({ sections: [{ filters: [{ signal: Signal('virtual', 'signal-A'), value: amount }] }] });`;
    const compilation = compile(text);
    expect(compilation.resolvedCircuit).toBeUndefined();
    expect(compilation.pipelineDiagnostics).toEqual([
      expect.objectContaining({
        code: 'RT2029',
        span: expect.objectContaining({ start: text.indexOf('Math.abs(amount)') }),
      }),
    ]);
  });
});

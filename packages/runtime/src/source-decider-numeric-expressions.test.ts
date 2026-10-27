import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';

import {
  createTrustedEntityReplayContext,
  syntheticZeroPortEntityProfile,
} from '@comblang/compiler';
import type { EntityProfile } from '@comblang/compiler/entity';
import { signal } from '@comblang/factorio';
import type { EntityPrototype } from '@comblang/prototypes';

import type { EntityPrototypeResolver } from './entity-registry.js';
import { executeResolvedDirectPlan } from './direct-plan.js';
import {
  bindSourceCompilationCircuit,
  compileSourceProgram,
  listSourceCompilationParameters,
  sourceCompilationArtifact,
} from './source-compilation.js';

function parameterHost() {
  const families = ['constant-combinator', 'decider-combinator'] as const;
  const profiles = families.map((family, index) => ({
    ...structuredClone(syntheticZeroPortEntityProfile),
    ref: {
      ...syntheticZeroPortEntityProfile.ref,
      prototypeKey: `entity:${family}` as EntityProfile['ref']['prototypeKey'],
      profileId: `profile:source-decider-expression-${index}` as EntityProfile['ref']['profileId'],
    },
    prototypeType: family,
  }));
  const trustedEntityReplayContext = createTrustedEntityReplayContext({
    database: profiles[0]!.ref.database,
    source: 'synthetic',
    evidenceIdentity: 'source-decider-expression-test-evidence',
    policyIdentity: 'source-decider-expression-test-policy',
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
  const compilation = compileSourceProgram(
    { path: 'source-decider-numeric-expressions.factorio.ts', text },
    parameterHost(),
  );
  expect(compilation.pipelineDiagnostics).toEqual([]);
  expect(compilation.resolvedCircuit).toBeDefined();
  return compilation;
}

describe('source numeric expressions in exact Decider thresholds', () => {
  test('compiles the documented local threshold example and rebinds its default', () => {
    const documentation = readFileSync(
      new URL('../../../docs/api/parameters.md', import.meta.url),
      'utf8',
    );
    const example = documentation.match(
      /^### Local fluent Decider threshold\r?\n[\s\S]*?```typescript\r?\n([\s\S]*?)```/m,
    )?.[1];
    if (example === undefined) throw new Error('Expected the complete Decider threshold example.');
    const compilation = compile(example);
    const amount = listSourceCompilationParameters(compilation)[0]!.parameter;
    const defaults = bindSourceCompilationCircuit(compilation);
    const overridden = bindSourceCompilationCircuit(compilation, [{ parameter: amount, value: 3 }]);

    expect(defaults.plan.producers.find(({ kind }) => kind === 'decider')).toMatchObject({
      kind: 'decider',
      condition: { kind: 'compare-signal', constant: 9 },
    });
    expect(overridden.plan.producers.find(({ kind }) => kind === 'decider')).toMatchObject({
      kind: 'decider',
      condition: { kind: 'compare-signal', constant: 5 },
    });
  });

  test('accepts safe integer thresholds outside int32 range before wrapping', () => {
    const compilation = compile(`const A = Signal('virtual', 'signal-A');
const amount = Param.number('Amount', 2147483648);
const threshold = amount + 0;
const input = new Network();
const output = new Network();
output += Decider({ condition: input[A] > threshold, outputs: [input[A]] });`);
    const amount = listSourceCompilationParameters(compilation)[0]!.parameter;
    const defaults = bindSourceCompilationCircuit(compilation);
    const overridden = bindSourceCompilationCircuit(compilation, [
      { parameter: amount, value: 2147483649 },
    ]);

    expect(defaults.plan.producers.find(({ kind }) => kind === 'decider')).toMatchObject({
      condition: { kind: 'compare-signal', constant: -2147483648 },
    });
    expect(overridden.plan.producers.find(({ kind }) => kind === 'decider')).toMatchObject({
      condition: { kind: 'compare-signal', constant: -2147483647 },
    });
  });

  test.each([
    [
      'left operand',
      `output += Decider({ condition: threshold > input[A], outputs: [input[A]] });`,
      'RT2029',
    ],
    ['ordinary JavaScript comparison', `const invalid = threshold > 0;`, 'RT2029'],
    ['truthiness', `if (threshold) {}`, 'RT2029'],
    [
      'negation',
      `output += Decider({ condition: !(input[A] > threshold), outputs: [input[A]] });`,
      'RT2027',
    ],
  ])('rejects a derived threshold in the unsupported %s context', (_name, statement, code) => {
    const text = `const A = Signal('virtual', 'signal-A');
const amount = Param.number('Amount', 5);
const threshold = amount + 1;
const input = new Network();
const output = new Network();
${statement}`;
    const compilation = compileSourceProgram(
      { path: 'unsupported-decider-numeric-threshold.factorio.ts', text },
      parameterHost(),
    );
    expect(compilation.pipelineDiagnostics).toEqual([
      expect.objectContaining({
        code,
        span: expect.objectContaining({ fileId: compilation.fileId }),
      }),
    ]);
    expect(compilation.resolvedCircuit).toBeUndefined();
  });

  test('does not accept a structural lookalike or an expression from another session', () => {
    const foreignKey = '__comblang_foreign_decider_numeric_expression';
    const globals = globalThis as Record<string, unknown>;
    const had = Object.hasOwn(globals, foreignKey);
    const previous = globals[foreignKey];
    try {
      compile(`const A = Signal('virtual', 'signal-A');
const amount = Param.number('Amount', 5);
const threshold = amount + 1;
globalThis.${foreignKey} = threshold;
const input = new Network();
const output = new Network();
output += Decider({ condition: input[A] > threshold, outputs: [input[A]] });`);

      const foreign = `const A = Signal('virtual', 'signal-A');
const amount = Param.number('Amount', 2);
const input = new Network();
const output = new Network();
output += Decider({ condition: input[A] > globalThis.${foreignKey}, outputs: [input[A]] });`;
      const foreignCompilation = compileSourceProgram(
        { path: 'foreign-decider-numeric-threshold.factorio.ts', text: foreign },
        parameterHost(),
      );
      expect(foreignCompilation.pipelineDiagnostics).toEqual([
        expect.objectContaining({
          code: 'RT2027',
          message: expect.stringContaining('different parameter session'),
        }),
      ]);
      expect(foreignCompilation.resolvedCircuit).toBeUndefined();

      const lookalike = `const A = Signal('virtual', 'signal-A');
const input = new Network();
const output = new Network();
const fake = { kind: 'binary', operator: 'add', left: { kind: 'literal', value: 5 }, right: { kind: 'literal', value: 1 } };
output += Decider({ condition: input[A] > fake, outputs: [input[A]] });`;
      const lookalikeCompilation = compileSourceProgram(
        { path: 'lookalike-decider-numeric-threshold.factorio.ts', text: lookalike },
        parameterHost(),
      );
      expect(lookalikeCompilation.pipelineDiagnostics).not.toEqual([]);
      expect(lookalikeCompilation.resolvedCircuit).toBeUndefined();
    } finally {
      if (had) globals[foreignKey] = previous;
      else delete globals[foreignKey];
    }
  });

  test('binds a retained expression through nested conditions and Each without changing topology', () => {
    const key = '__comblang_decider_numeric_expression_runs';
    const globals = globalThis as Record<string, unknown>;
    const had = Object.hasOwn(globals, key);
    const previous = globals[key];
    globals[key] = 0;
    const text = `globalThis.${key} += 1;
const A = Signal('virtual', 'signal-A', 'rare');
const B = Signal('virtual', 'signal-B', 'legendary');
const amount = Param.number('Amount', 5);
function makeThreshold() { return amount * 2 - 1; }
const thresholds = [makeThreshold()];
const threshold = thresholds[0];
const input = new Network();
const secondary = new Network();
const result = new Network();
input += Constant({ sections: [{ filters: [{ signal: A, value: 7 }] }] });
const condition = (pair(input, secondary)[A] > threshold || input[A] == 0)
  && (Each(input) < threshold || input[A] != 0);
result += Decider({
  condition,
  outputs: [input[A], input[A], 2 * B],
  elseOutputs: [3 * B],
});`;

    try {
      const compilation = compile(text);
      const originalArtifact = structuredClone(sourceCompilationArtifact(compilation));
      const amount = listSourceCompilationParameters(compilation)[0]!.parameter;
      const defaults = bindSourceCompilationCircuit(compilation);
      const overridden = bindSourceCompilationCircuit(compilation, [
        { parameter: amount, value: 3 },
      ]);
      const reset = bindSourceCompilationCircuit(compilation, []);
      const defaultDecider = defaults.plan.producers.find(({ kind }) => kind === 'decider');
      const overriddenDecider = overridden.plan.producers.find(({ kind }) => kind === 'decider');
      if (defaultDecider?.kind !== 'decider' || overriddenDecider?.kind !== 'decider') {
        throw new Error('Expected the exact captured Decider producer.');
      }

      expect(defaultDecider.condition).toMatchObject({
        kind: 'and',
        conditions: [
          {
            kind: 'or',
            conditions: [
              {
                kind: 'compare-signal',
                comparator: '>',
                constant: 9,
                refKind: 'pair',
                networks: ['input', 'secondary'],
              },
              { kind: 'compare-signal', comparator: '=', constant: 0 },
            ],
          },
          {
            kind: 'or',
            conditions: [
              { kind: 'compare-each', comparator: '<', constant: 9 },
              { kind: 'compare-signal', comparator: '!=', constant: 0 },
            ],
          },
        ],
      });
      expect(overriddenDecider.condition).toMatchObject({
        kind: 'and',
        conditions: [
          {
            kind: 'or',
            conditions: [
              {
                kind: 'compare-signal',
                comparator: '>',
                constant: 5,
                refKind: 'pair',
                networks: ['input', 'secondary'],
              },
              { kind: 'compare-signal', comparator: '=', constant: 0 },
            ],
          },
          {
            kind: 'or',
            conditions: [
              { kind: 'compare-each', comparator: '<', constant: 5 },
              { kind: 'compare-signal', comparator: '!=', constant: 0 },
            ],
          },
        ],
      });
      expect(overriddenDecider.outputs).toEqual(defaultDecider.outputs);
      expect(overriddenDecider.elseOutputs).toEqual(defaultDecider.elseOutputs);
      expect(overriddenDecider.outputs?.[0]).toMatchObject({
        kind: 'signal',
        signal: { type: 'virtual', name: 'signal-A', quality: 'rare' },
      });
      expect(overridden.plan.producers.map(({ entityId }) => entityId)).toEqual(
        defaults.plan.producers.map(({ entityId }) => entityId),
      );
      expect(overridden.plan.entities.map(({ id }) => id)).toEqual(
        defaults.plan.entities.map(({ id }) => id),
      );
      expect(overridden.resolvedCircuit.ir.networks).toEqual(defaults.resolvedCircuit.ir.networks);
      expect(overridden.plan.networkPairs).toEqual(defaults.plan.networkPairs);
      expect(overridden.plan.networkPairs).toHaveLength(1);
      expect(
        overridden.resolvedCircuit.ir.entities.map(({ id, placement }) => ({ id, placement })),
      ).toEqual(
        defaults.resolvedCircuit.ir.entities.map(({ id, placement }) => ({ id, placement })),
      );
      expect(reset.plan).toEqual(defaults.plan);
      expect(reset.resolvedCircuit).toEqual(defaults.resolvedCircuit);
      expect(sourceCompilationArtifact(compilation)).toEqual(originalArtifact);
      expect(globals[key]).toBe(1);

      const observed = (pair: typeof defaults) => {
        const replay = executeResolvedDirectPlan(pair.plan, pair.resolvedCircuit);
        const session = replay.createTestSession();
        session.tick(3);
        const bus = session.read(replay.network('result'));
        return {
          a: bus.get(signal('virtual', 'signal-A', 'rare')) ?? 0,
          b: bus.get(signal('virtual', 'signal-B', 'legendary')) ?? 0,
        };
      };
      expect(observed(defaults)).toEqual({ a: 0, b: 3 });
      expect(observed(overridden)).toEqual({ a: 14, b: 2 });
      expect(observed(reset)).toEqual({ a: 0, b: 3 });
    } finally {
      if (had) globals[key] = previous;
      else delete globals[key];
    }
  });

  test.each([
    ['fractional', 0.25, 'amount * 2'],
    ['non-finite', 1e308, 'amount * 2'],
    ['unsafe integer', Number.MAX_SAFE_INTEGER, 'amount * 2'],
  ])(
    'keeps %s threshold defaults source-linked and rejects them before int32 wrapping',
    (_label, value, expression) => {
      const text = `const A = Signal('virtual', 'signal-A');
const amount = Param.number('Amount', ${value});
const input = new Network();
const output = new Network();
output += Decider({ condition: input[A] > (${expression}), outputs: [input[A]] });`;
      const compilation = compileSourceProgram(
        { path: 'invalid-decider-numeric-threshold.factorio.ts', text },
        parameterHost(),
      );
      const diagnostic = compilation.pipelineDiagnostics[0];
      expect(compilation.pipelineDiagnostics).toHaveLength(1);
      expect(diagnostic).toMatchObject({
        code: 'RT2027',
        span: expect.objectContaining({ fileId: compilation.fileId }),
      });
      expect(text.slice(diagnostic!.span!.start, diagnostic!.span!.end)).toContain(expression);
      expect(compilation.resolvedCircuit).toBeUndefined();
    },
  );

  test('a failed override leaves prior pairs intact and a later valid bind succeeds', () => {
    const text = `const A = Signal('virtual', 'signal-A');
const amount = Param.number('Amount', 5);
const threshold = amount * 2;
const input = new Network();
const output = new Network();
input += Constant({ sections: [{ filters: [{ signal: A, value: 20 }] }] });
output += Decider({ condition: input[A] > threshold, outputs: [input[A]] });`;
    const compilation = compile(text);
    const parameter = listSourceCompilationParameters(compilation)[0]!.parameter;
    const defaults = bindSourceCompilationCircuit(compilation);
    const defaultSnapshot = structuredClone(defaults);

    expect(() =>
      bindSourceCompilationCircuit(compilation, [{ parameter, value: Number.MAX_SAFE_INTEGER }]),
    ).toThrow();
    const retried = bindSourceCompilationCircuit(compilation, [{ parameter, value: 7 }]);
    const defaultDecider = defaults.plan.producers.find(({ kind }) => kind === 'decider');
    const retriedDecider = retried.plan.producers.find(({ kind }) => kind === 'decider');
    expect(defaultDecider).toMatchObject({
      kind: 'decider',
      condition: { kind: 'compare-signal', constant: 10 },
    });
    expect(retriedDecider).toMatchObject({
      kind: 'decider',
      condition: { kind: 'compare-signal', constant: 14 },
    });
    expect(defaults).toEqual(defaultSnapshot);
    expect(compilation.plan?.producers).not.toEqual(retried.plan.producers);
  });
});

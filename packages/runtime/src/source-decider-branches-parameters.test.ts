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
} from './source-compilation.js';

function parameterHost() {
  const families = ['constant-combinator', 'decider-combinator'] as const;
  const profiles = families.map((family, index) => ({
    ...structuredClone(syntheticZeroPortEntityProfile),
    ref: {
      ...syntheticZeroPortEntityProfile.ref,
      prototypeKey: `entity:${family}` as EntityProfile['ref']['prototypeKey'],
      profileId: `profile:source-decider-branches-${index}` as EntityProfile['ref']['profileId'],
    },
    prototypeType: family,
  }));
  const trustedEntityReplayContext = createTrustedEntityReplayContext({
    database: profiles[0]!.ref.database,
    source: 'synthetic',
    evidenceIdentity: 'source-decider-branches-test-evidence',
    policyIdentity: 'source-decider-branches-test-policy',
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
  return compileSourceProgram(
    { path: 'source-decider-branches-parameters.factorio.ts', text },
    parameterHost(),
  );
}

describe('parameterized Decider branch construction', () => {
  test('compiles the documented parameterized fluent threshold example', () => {
    const documentation = readFileSync(
      new URL('../../../docs/api/decider.md', import.meta.url),
      'utf8',
    );
    const example = documentation.match(
      /## Parameterized thresholds[\s\S]*?```ts\r?\n([\s\S]*?)```/,
    )?.[1];
    if (example === undefined) throw new Error('Expected the fluent Decider parameter example.');
    const compilation = compile(example);
    expect(compilation.pipelineDiagnostics).toEqual([]);
    expect(listSourceCompilationParameters(compilation)).toHaveLength(1);
  });

  test('compiles and binds the documented parameterized EACH output-count example', () => {
    const documentation = readFileSync(
      new URL('../../../docs/api/decider.md', import.meta.url),
      'utf8',
    );
    const example = documentation.match(
      /## Parameterized EACH output counts[\s\S]*?```ts\r?\n([\s\S]*?)```/,
    )?.[1];
    if (example === undefined) throw new Error('Expected the EACH output-count example.');
    const compilation = compile(example);
    expect(compilation.pipelineDiagnostics).toEqual([]);
    expect(listSourceCompilationParameters(compilation)).toMatchObject([
      { label: 'Count', defaultValue: 2 },
    ]);
    expect(bindSourceCompilationCircuit(compilation).plan.producers).toMatchObject([
      { kind: 'decider', outputs: [{ kind: 'each-constant', value: 2 }] },
    ]);
  });

  test('compiles and binds the documented parameterized Anything/Everything output-count example', () => {
    const documentation = readFileSync(
      new URL('../../../docs/api/decider.md', import.meta.url),
      'utf8',
    );
    const example = documentation.match(
      /## Parameterized Anything and Everything output counts[\s\S]*?```ts\r?\n([\s\S]*?)```/,
    )?.[1];
    if (example === undefined) throw new Error('Expected the wildcard output-count example.');
    const compilation = compile(example);
    expect(compilation.pipelineDiagnostics).toEqual([]);
    const bound = bindSourceCompilationCircuit(compilation);
    expect(bound.plan.producers).toMatchObject([
      {
        kind: 'decider',
        outputs: [{ kind: 'wildcard-constant', wildcard: 'anything', value: 2 }],
        elseOutputs: [{ kind: 'wildcard-constant', wildcard: 'everything', value: 2 }],
      },
    ]);
  });

  test.each([
    ['ANYTHING', 'anything'],
    ['ANY', 'anything'],
    ['EVERYTHING', 'everything'],
    ['ALL', 'everything'],
  ] as const)(
    'binds direct parameter count for %s constant output slots',
    (wildcard, normalizedWildcard) => {
      const text = `const A = Signal('virtual', 'signal-A');
const amount = Param.number('Count', 2);
const input = new Network();
const output = new Network();
output += IF(input[A] > 0, amount * ${wildcard});`;
      const compilation = compile(text);
      expect(compilation.pipelineDiagnostics).toEqual([]);
      const parameter = listSourceCompilationParameters(compilation)[0]!.parameter;
      const defaults = bindSourceCompilationCircuit(compilation);
      const overridden = bindSourceCompilationCircuit(compilation, [{ parameter, value: 9 }]);
      expect(defaults.plan.producers).toMatchObject([
        {
          kind: 'decider',
          outputs: [{ kind: 'wildcard-constant', wildcard: normalizedWildcard, value: 2 }],
        },
      ]);
      expect(overridden.plan.producers).toMatchObject([
        {
          kind: 'decider',
          outputs: [{ kind: 'wildcard-constant', wildcard: normalizedWildcard, value: 9 }],
        },
      ]);
    },
  );

  test.each(['ANYTHING', 'EVERYTHING'])(
    'keeps derived parameter expressions outside the %s constant output slot',
    (wildcard) => {
      const text = `const A = Signal('virtual', 'signal-A');
const amount = Param.number('Count', 2);
const derived = amount + 1;
const input = new Network();
const output = new Network();
output += IF(input[A] > 0, derived * ${wildcard});`;
      const compilation = compile(text);
      const countStart = text.indexOf(`derived * ${wildcard}`);

      expect(compilation.pipelineDiagnostics).toEqual([
        expect.objectContaining({
          code: 'RT2027',
          span: {
            fileId: compilation.fileId,
            start: countStart,
            end: countStart + `derived * ${wildcard}`.length,
          },
        }),
      ]);
      expect(compilation.resolvedCircuit).toBeUndefined();
    },
  );

  test('parameter binding retains literal Anything and Everything constant rows', () => {
    const compilation = compile(`const A = Signal('virtual', 'signal-A');
const amount = Param.number('Threshold', 2);
const input = new Network();
const output = new Network();
output += Decider({ condition: input[A] > amount, outputs: [7 * EVERYTHING, 3 * ANYTHING] });`);
    expect(compilation.pipelineDiagnostics).toEqual([]);
    const parameter = listSourceCompilationParameters(compilation)[0]!.parameter;
    const defaults = bindSourceCompilationCircuit(compilation);
    const bound = bindSourceCompilationCircuit(compilation, [{ parameter, value: 5 }]);
    expect(defaults.plan.producers).toMatchObject([
      {
        kind: 'decider',
        condition: { constant: 2 },
        outputs: [
          { kind: 'wildcard-constant', wildcard: 'everything', value: 7 },
          { kind: 'wildcard-constant', wildcard: 'anything', value: 3 },
        ],
      },
    ]);
    expect(bound.plan.producers).toMatchObject([
      {
        kind: 'decider',
        condition: { constant: 5 },
        outputs: [
          { kind: 'wildcard-constant', wildcard: 'everything', value: 7 },
          { kind: 'wildcard-constant', wildcard: 'anything', value: 3 },
        ],
      },
    ]);
  });

  test('preserves parameterized wildcard count rows across exact containers and late fluent aliases', () => {
    const compilation = compile(`const A = Signal('virtual', 'signal-A');
const amount = Param.number('Count', 2);
const input = new Network();
const output = new Network();
const exact = Decider({
  condition: input[A] > 0,
  outputs: [[amount * ANYTHING, 3 * EVERYTHING], { duplicate: ANY * amount }],
  elseOutputs: [ALL * amount],
});
output += exact;
const gate = when(input[A] > 0).then(2 * EVERYTHING);
output += gate;
const alias = gate;
alias.then(amount * ANY);
gate.else(4 * ALL);`);
    expect(compilation.pipelineDiagnostics).toEqual([]);

    const parameter = listSourceCompilationParameters(compilation)[0]!.parameter;
    const defaults = bindSourceCompilationCircuit(compilation);
    const overridden = bindSourceCompilationCircuit(compilation, [{ parameter, value: 9 }]);
    const deciders = (pair: typeof defaults) =>
      pair.plan.producers.filter((producer) => producer.kind === 'decider');
    expect(deciders(defaults)).toMatchObject([
      {
        outputs: [
          { kind: 'wildcard-constant', wildcard: 'anything', value: 2 },
          { kind: 'wildcard-constant', wildcard: 'everything', value: 3 },
          { kind: 'wildcard-constant', wildcard: 'anything', value: 2 },
        ],
        elseOutputs: [{ kind: 'wildcard-constant', wildcard: 'everything', value: 2 }],
      },
      {
        outputs: [
          { kind: 'wildcard-constant', wildcard: 'everything', value: 2 },
          { kind: 'wildcard-constant', wildcard: 'anything', value: 2 },
        ],
        elseOutputs: [{ kind: 'wildcard-constant', wildcard: 'everything', value: 4 }],
      },
    ]);
    expect(deciders(overridden)).toMatchObject([
      {
        outputs: [
          { kind: 'wildcard-constant', wildcard: 'anything', value: 9 },
          { kind: 'wildcard-constant', wildcard: 'everything', value: 3 },
          { kind: 'wildcard-constant', wildcard: 'anything', value: 9 },
        ],
        elseOutputs: [{ kind: 'wildcard-constant', wildcard: 'everything', value: 9 }],
      },
      {
        outputs: [
          { kind: 'wildcard-constant', wildcard: 'everything', value: 2 },
          { kind: 'wildcard-constant', wildcard: 'anything', value: 9 },
        ],
        elseOutputs: [{ kind: 'wildcard-constant', wildcard: 'everything', value: 4 }],
      },
    ]);
  });

  test.each(['ANYTHING', 'ANY'])(
    'allows parameterized %s outputs with an Each condition',
    (wildcard) => {
      const compilation = compile(`const amount = Param.number('Count', 0);
const input = new Network();
const output = new Network();
output += IF(input[EACH] > 0, amount * ${wildcard});`);

      expect(compilation.pipelineDiagnostics).toEqual([]);
      expect(bindSourceCompilationCircuit(compilation).plan.producers).toMatchObject([
        {
          kind: 'decider',
          outputs: [{ kind: 'wildcard-constant', wildcard: 'anything', value: 0 }],
        },
      ]);
    },
  );

  test('rejects a zero-default Everything count appended through a fluent alias under Each', () => {
    const expression = 'amount * EVERYTHING';
    const text = `const A = Signal('virtual', 'signal-A');
const amount = Param.number('Count', 0);
const input = new Network();
const output = new Network();
const gate = when(input[EACH] > 0).then(1 * A);
output += gate;
const alias = gate;
alias.else(${expression});`;
    const compilation = compile(text);
    const diagnostic = compilation.pipelineDiagnostics.find(({ code }) => code === 'RT2027');

    expect(diagnostic).toMatchObject({
      severity: 'error',
      span: {
        fileId: compilation.fileId,
        start: text.indexOf(expression),
        end: text.indexOf(expression) + expression.length,
      },
    });
    expect(compilation.resolvedCircuit).toBeUndefined();
  });

  test.each([
    [
      'exact normal branch',
      `output += Decider({ condition: input[EACH] > amount, outputs: [amount * EVERYTHING] });`,
    ],
    ['IF else branch', `output += IF(input[EACH] > 0, 1 * A, { fallback: amount * EVERYTHING });`],
    [
      'late fluent normal branch through alias',
      `const gate = when(input[EACH] > 0).then(1 * A);\noutput += gate;\nconst alias = gate;\nalias.then(amount * EVERYTHING);`,
    ],
  ] as const)(
    'rejects a zero-default Everything count in %s with a located diagnostic',
    (_form, body) => {
      const expression = 'amount * EVERYTHING';
      const text = `const A = Signal('virtual', 'signal-A');\nconst amount = Param.number('Count', 0);\nconst input = new Network();\nconst output = new Network();\n${body}`;
      const compilation = compile(text);
      const diagnostic = compilation.pipelineDiagnostics.find(({ code }) => code === 'RT2027');

      expect(diagnostic).toMatchObject({
        severity: 'error',
        span: { fileId: compilation.fileId },
      });
      expect(diagnostic?.span?.start).toBeLessThanOrEqual(text.indexOf(expression));
      expect(diagnostic?.span?.end).toBeGreaterThanOrEqual(
        text.indexOf(expression) + expression.length,
      );
      expect(text.slice(diagnostic?.span?.start, diagnostic?.span?.end)).toContain(expression);
      expect(compilation.resolvedCircuit).toBeUndefined();
    },
  );

  test('captures late fluent branches after attachment and placement, with one producer and one source execution', () => {
    const counterKey = '__comblang_parameterized_decider_source_runs';
    const globals = globalThis as Record<string, unknown>;
    const hadCounter = Object.hasOwn(globals, counterKey);
    const previousCounter = globals[counterKey];
    globals[counterKey] = 0;
    try {
      const text = `const A = Signal('virtual', 'signal-A');
const B = Signal('virtual', 'signal-B');
const amount = Param.number('Amount', 3);
const threshold = amount + 1;
const input = new Network();
const output = new Network();
input += CC(6 * A);
const gate = when((input[A] > threshold || input[A] == 0) && (input[A] < threshold || input[A] != 0))
  .at(3, 4, 2)
  .then(input[A]);
output += gate;
const alias = gate;
try { alias.then(7); } catch (error) {}
alias.else(2 * B);
alias.then(3 * B);
alias.else(4 * B);`;
      const compilation = compile(`globalThis.${counterKey} += 1;\n${text}`);
      expect(compilation.pipelineDiagnostics).toEqual([]);
      expect(globals[counterKey]).toBe(1);
      const parameter = listSourceCompilationParameters(compilation)[0]!.parameter;
      const defaults = bindSourceCompilationCircuit(compilation);
      const defaultSnapshot = structuredClone(defaults);
      const priorOverride = bindSourceCompilationCircuit(compilation, [{ parameter, value: 5 }]);
      const priorOverrideSnapshot = structuredClone(priorOverride);
      expect(() =>
        bindSourceCompilationCircuit(compilation, [{ parameter, value: Number.MAX_SAFE_INTEGER }]),
      ).toThrow();
      expect(defaults).toEqual(defaultSnapshot);
      expect(priorOverride).toEqual(priorOverrideSnapshot);
      const overridden = bindSourceCompilationCircuit(compilation, [{ parameter, value: 7 }]);
      const reset = bindSourceCompilationCircuit(compilation, []);
      const defaultDeciders = defaults.plan.producers.filter(({ kind }) => kind === 'decider');
      const defaultDecider = defaultDeciders[0];
      const overriddenDecider = overridden.plan.producers.find(({ kind }) => kind === 'decider');
      if (defaultDecider?.kind !== 'decider' || overriddenDecider?.kind !== 'decider') {
        throw new Error('Expected the captured fluent Decider producer.');
      }

      expect(defaultDeciders).toHaveLength(1);
      expect(defaultDecider.condition).toMatchObject({
        kind: 'and',
        conditions: [
          { kind: 'or', conditions: [{ kind: 'compare-signal', constant: 4 }, { constant: 0 }] },
          { kind: 'or', conditions: [{ kind: 'compare-signal', constant: 4 }, { constant: 0 }] },
        ],
      });
      expect(overriddenDecider.condition).toMatchObject({
        kind: 'and',
        conditions: [
          { kind: 'or', conditions: [{ kind: 'compare-signal', constant: 8 }, { constant: 0 }] },
          { kind: 'or', conditions: [{ kind: 'compare-signal', constant: 8 }, { constant: 0 }] },
        ],
      });
      expect(defaultDecider.outputs).toHaveLength(2);
      expect(defaultDecider.outputs?.[0]).toMatchObject({
        kind: 'signal',
        signal: { name: 'signal-A' },
      });
      expect(defaultDecider.outputs?.[1]).toMatchObject({ kind: 'signal-constant', value: 3 });
      expect(defaultDecider.elseOutputs).toHaveLength(2);
      expect(defaultDecider.elseOutputs?.map((row) => row.kind)).toEqual([
        'signal-constant',
        'signal-constant',
      ]);
      expect(
        defaultDecider.elseOutputs?.map((row) => row.kind === 'signal-constant' && row.value),
      ).toEqual([2, 4]);
      expect(overridden.plan.producers.map(({ entityId }) => entityId)).toEqual(
        defaults.plan.producers.map(({ entityId }) => entityId),
      );
      const deciderEntity = defaults.resolvedCircuit.ir.entities.find(
        ({ id }) => id === defaultDecider.entityId,
      );
      expect(deciderEntity).toBeDefined();
      expect(defaults.plan.entities.find(({ id }) => id === defaultDecider.entityId)).toMatchObject(
        {
          placement: { x: 3, y: 4, direction: 2 },
        },
      );
      expect(reset.plan).toEqual(defaults.plan);
      expect(globals[counterKey]).toBe(1);

      const observe = (pair: typeof defaults) => {
        const replay = executeResolvedDirectPlan(pair.plan, pair.resolvedCircuit);
        const session = replay.createTestSession();
        session.tick(3);
        const bus = session.read(replay.network('output'));
        return {
          a: bus.get(signal('virtual', 'signal-A')) ?? 0,
          b: bus.get(signal('virtual', 'signal-B')) ?? 0,
        };
      };
      expect(observe(defaults)).toEqual({ a: 6, b: 3 });
      expect(observe(overridden)).toEqual({ a: 0, b: 6 });
      expect(globals[counterKey]).toBe(1);
    } finally {
      if (hadCounter) globals[counterKey] = previousCounter;
      else delete globals[counterKey];
    }
  });

  test('rolls back a caught failed parameterized Decider creation before the next capture and bind', () => {
    const compilation = compile(`const A = Signal('virtual', 'signal-A');
const amount = Param.number('Amount', 2);
const input = new Network();
try {
  Decider({ condition: input[A] > amount, outputs: [7] });
} catch (error) {}
const valid = Decider({ condition: input[A] > amount, outputs: [input[A]] });
const output = new Network();
output += valid;`);
    expect(compilation.pipelineDiagnostics).toEqual([]);
    const deciders = compilation.plan?.producers.filter(({ kind }) => kind === 'decider');
    expect(deciders).toHaveLength(1);
    expect(deciders?.[0]).toMatchObject({
      entityId: 'entity:1',
      debugCaptureIds: ['producer:1'],
    });
    const parameter = listSourceCompilationParameters(compilation)[0]!.parameter;
    expect(bindSourceCompilationCircuit(compilation).plan.producers).toHaveLength(1);
    expect(
      bindSourceCompilationCircuit(compilation, [{ parameter, value: 5 }]).plan.producers,
    ).toMatchObject([{ debugCaptureIds: ['producer:1'], condition: { constant: 5 } }]);
  });

  test('keeps exact, fluent when and IF branch rows equivalent for the same parameterized condition', () => {
    const compilation = compile(`const A = Signal('virtual', 'signal-A');
const B = Signal('virtual', 'signal-B');
const amount = Param.number('Amount', 5);
const input = new Network();
const exact = Decider({ condition: input[A] > amount, outputs: [input[A], 2 * B], elseOutputs: [3 * B] });
const fluent = when(input[A] > amount).then([input[A], 2 * B]).else({ fallback: 3 * B });
const branched = IF(input[A] > amount, [input[A], 2 * B], { fallback: 3 * B });
const exactOutput = new Network();
const fluentOutput = new Network();
const branchedOutput = new Network();
exactOutput += exact;
fluentOutput += fluent;
branchedOutput += branched;`);
    expect(compilation.pipelineDiagnostics).toEqual([]);
    const parameter = listSourceCompilationParameters(compilation)[0]!.parameter;
    const defaults = bindSourceCompilationCircuit(compilation);
    const overridden = bindSourceCompilationCircuit(compilation, [{ parameter, value: 9 }]);
    const producers = defaults.plan.producers.filter((producer) => producer.kind === 'decider');
    const overriddenProducers = overridden.plan.producers.filter(
      (producer) => producer.kind === 'decider',
    );

    expect(producers).toHaveLength(3);
    const signature = ({ condition, outputs, elseOutputs }: (typeof producers)[number]) => ({
      condition,
      outputs,
      elseOutputs,
    });
    expect(signature(producers[1]!)).toEqual(signature(producers[0]!));
    expect(signature(producers[2]!)).toEqual(signature(producers[0]!));
    expect(overriddenProducers.map(({ condition }) => condition)).toEqual([
      overriddenProducers[0]?.condition,
      overriddenProducers[0]?.condition,
      overriddenProducers[0]?.condition,
    ]);
    expect(overriddenProducers[0]?.condition).toMatchObject({ constant: 9 });
  });

  test('binds fluent and exact else-only Deciders without inventing a true row', () => {
    const elseOnly = compile(`const A = Signal('virtual', 'signal-A');
const amount = Param.number('Amount', 2);
const input = new Network();
input += CC(3 * A);
const gate = when(input[A] > amount).else(input[A]);
const fluentOutput = new Network();
fluentOutput += gate;
const exact = Decider({ condition: input[A] > amount, outputs: [], elseOutputs: [input[A]] });
const exactOutput = new Network();
exactOutput += exact;`);
    expect(elseOnly.pipelineDiagnostics).toEqual([]);
    const parameter = listSourceCompilationParameters(elseOnly)[0]!.parameter;
    const defaults = bindSourceCompilationCircuit(elseOnly);
    const overridden = bindSourceCompilationCircuit(elseOnly, [{ parameter, value: 5 }]);
    const reset = bindSourceCompilationCircuit(elseOnly, []);
    const defaultDeciders = defaults.plan.producers.filter(
      (producer) => producer.kind === 'decider',
    );
    const overriddenDeciders = overridden.plan.producers.filter(
      (producer) => producer.kind === 'decider',
    );
    expect(defaultDeciders).toHaveLength(2);
    for (const decider of defaultDeciders) {
      expect(decider).toMatchObject({ outputs: [], elseOutputs: [{ kind: 'signal' }] });
      expect(decider.output).toEqual(decider.elseOutputs?.[0]);
      expect(
        defaults.plan.entities.find(({ id }) => id === decider.entityId)?.configuration,
      ).toEqual({
        mode: 'decider',
        condition: decider.condition,
        outputs: [],
        elseOutputs: decider.elseOutputs,
      });
    }
    expect(overriddenDeciders.map(({ entityId }) => entityId)).toEqual(
      defaultDeciders.map(({ entityId }) => entityId),
    );
    expect(reset.plan).toEqual(defaults.plan);

    const observe = (pair: typeof defaults, networkName: string) => {
      const replay = executeResolvedDirectPlan(pair.plan, pair.resolvedCircuit);
      const session = replay.createTestSession();
      session.tick(3);
      return session.read(replay.network(networkName)).get(signal('virtual', 'signal-A')) ?? 0;
    };
    expect(observe(defaults, 'fluentOutput')).toBe(0);
    expect(observe(defaults, 'exactOutput')).toBe(0);
    expect(observe(overridden, 'fluentOutput')).toBe(3);
    expect(observe(overridden, 'exactOutput')).toBe(3);

    const outputless = compileSourceProgram(
      {
        path: 'outputless-parameterized-decider.factorio.ts',
        text: `const A = Signal('virtual', 'signal-A');
const amount = Param.number('Amount', 2);
const input = new Network();
Decider({ condition: input[A] > amount, outputs: [], elseOutputs: [] });`,
      },
      parameterHost(),
    );
    expect(outputless.pipelineDiagnostics).toEqual([expect.objectContaining({ code: 'RT2027' })]);
    expect(outputless.resolvedCircuit).toBeUndefined();
  });

  test('retains ordinary forms without canonical authority and refuses parameterized forms without it', () => {
    const ordinary = compileSourceProgram({
      path: 'ordinary-decider-branches.factorio.ts',
      text: `const A = Signal('virtual', 'signal-A');
const input = new Network();
const gate = when(input[A] > 2).then(input[A]);
const branch = IF(input[A] > 2, [input[A]], { fallback: input[A] });
const output = new Network();
output += gate;
output += branch;`,
    });
    expect(ordinary.pipelineDiagnostics).toEqual([]);
    expect(ordinary.resolvedCircuit).toBeDefined();

    for (const form of [
      `when(input[A] > amount).then(input[A]);`,
      `IF(input[A] > amount, input[A]);`,
    ]) {
      const source = `const A = Signal('virtual', 'signal-A');
const amount = Param.number('Amount', 2);
const input = new Network();
${form}`;
      const untrusted = compileSourceProgram({
        path: 'untrusted-parameterized-decider.factorio.ts',
        text: source,
      });
      expect(untrusted.pipelineDiagnostics).toEqual([
        expect.objectContaining({
          code: 'RT2027',
          span: expect.objectContaining({ fileId: untrusted.fileId }),
        }),
      ]);
      expect(untrusted.resolvedCircuit).toBeUndefined();
    }
  });
});

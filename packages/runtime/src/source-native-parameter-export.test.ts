import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { decodeBlueprintExchange, stringifyLosslessJson } from '@comblang/blueprint';
import {
  createTrustedEntityReplayContext,
  generateBlueprintJson,
  syntheticZeroPortEntityProfile,
} from '@comblang/compiler';
import type { EntityProfile } from '@comblang/compiler/entity';
import type { EntityPrototype } from '@comblang/prototypes';
import { signal } from '@comblang/factorio';
import { emitNativeBlueprintJson } from '../../compiler/src/native-blueprint-emitter.js';
import { buildNativeBlueprintFcir } from '../../compiler/src/native-blueprint-projector.js';
import { BlueprintParameterError } from '../../compiler/src/blueprint-parameters.js';
import { validateNativeBlueprintFcir } from '../../compiler/src/native-blueprint-ir.js';
import * as sourceApi from './source-compilation.js';
import type { EntityPrototypeResolver } from './entity-registry.js';
import { executeResolvedDirectPlan } from './direct-plan.js';

const options = { label: 'Source parameter export', maxDeciderConditionRows: 1024 };

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
      profileId: `profile:source-native-parameter-${index}` as EntityProfile['ref']['profileId'],
    },
    prototypeType: family,
  }));
  const trustedEntityReplayContext = createTrustedEntityReplayContext({
    database: profiles[0]!.ref.database,
    source: 'synthetic',
    evidenceIdentity: 'source-native-parameter-test-evidence',
    policyIdentity: 'source-native-parameter-test-policy',
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
  const compilation = sourceApi.compileSourceProgram(
    { path: 'source-native-parameters.factorio.ts', text },
    parameterHost(),
  );
  expect(compilation.pipelineDiagnostics).toEqual([]);
  expect(compilation.resolvedCircuit).toBeDefined();
  return compilation;
}

function exportFailure(compilation: sourceApi.LocalSourceCompilation): BlueprintParameterError {
  try {
    sourceApi.exportSourceCompilationNativeBlueprint(compilation, options);
  } catch (error) {
    expect(error).toBeInstanceOf(BlueprintParameterError);
    return error as BlueprintParameterError;
  }
  throw new Error('Expected an atomic native export rejection.');
}

const exactSource = `const A = Signal('virtual', 'signal-A');
const amount = Param.number('Amount', 5);
const output = new Network();
const constant = Constant({ sections: [{ filters: [{ signal: A, value: amount }] }] });
output += constant;`;

const mixedSource = `${exactSource}
const input = new Network();
output += Arithmetic({ left: amount, operation: 'add', right: amount, output: A });
output += Decider({ condition: input[A] > amount, outputs: [input[A]], elseOutputs: [1 * A] });
output += Selector({ input, operation: 'select', index: amount });`;

describe('owning source native parameter export', () => {
  test('exports grouped power formulas while retaining exact physical Constant defaults', () => {
    const compilation = compile(`const A = Signal('virtual', 'signal-A');
const B = Signal('virtual', 'signal-B');
const C = Signal('virtual', 'signal-C');
const D = Signal('virtual', 'signal-D');
const E = Signal('virtual', 'signal-E');
const amount = Param.number('Amount', 3, { variable: 'x' });
const output = new Network();
output += Constant({ sections: [{ filters: [
  { signal: A, value: amount },
  { signal: B, value: (-amount) ** 2 },
  { signal: C, value: -(amount ** 2) },
  { signal: D, value: (-2) ** amount },
  { signal: E, value: 2 ** amount },
] }] });`);
    const native = sourceApi.exportSourceCompilationNativeBlueprint(compilation, options);
    expect(native.parameters).toEqual([
      { type: 'number', number: '3', name: 'Amount', variable: 'x' },
      { type: 'number', number: '9', formula: '(((-x)) ^ (2))', dependent: true },
      { type: 'number', number: '-9', formula: '(-((x) ^ (2)))', dependent: true },
      { type: 'number', number: '-8', formula: '((-2) ^ (x))', dependent: true },
      { type: 'number', number: '8', formula: '((2) ^ (x))', dependent: true },
    ]);
    const json = emitNativeBlueprintJson(native);
    expect(json.blueprint.entities[0]).toMatchObject({
      control_behavior: {
        sections: {
          sections: [
            {
              filters: [
                { name: 'signal-A', count: 3 },
                { name: 'signal-B', count: 9 },
                { name: 'signal-C', count: -9 },
                { name: 'signal-D', count: -8 },
                { name: 'signal-E', count: 8 },
              ],
            },
          ],
        },
      },
    });
  });

  test('projects fractional and large formula literals while keeping raw defaults in int32', () => {
    const compilation = compile(
      [
        "const A = Signal('virtual', 'signal-A');",
        "const B = Signal('virtual', 'signal-B');",
        "const C = Signal('virtual', 'signal-C');",
        "const D = Signal('virtual', 'signal-D');",
        "const E = Signal('virtual', 'signal-E');",
        "const amount = Param.number('Amount', 10, { variable: 'x' });",
        "const root = Param.number('Root', 9, { variable: 'y' });",
        'const output = new Network();',
        'output += Constant({ sections: [{ filters: [',
        '{ signal: A, value: amount },',
        '{ signal: B, value: amount * 0.5 + 1 },',
        '{ signal: C, value: (amount + 2147483648) - 2147483647 },',
        '{ signal: D, value: root },',
        '{ signal: E, value: root ** 0.5 },',
        '] }] });',
      ].join('\n'),
    );
    const declarations = sourceApi.listSourceCompilationParameters(compilation);
    const amount = declarations.find(({ label }) => label === 'Amount')!.parameter;
    const root = declarations.find(({ label }) => label === 'Root')!.parameter;
    const original = structuredClone(sourceApi.sourceCompilationArtifact(compilation));
    const native = sourceApi.exportSourceCompilationNativeBlueprint(compilation, options);

    expect(native.parameters).toEqual([
      { type: 'number', number: '10', name: 'Amount', variable: 'x' },
      { type: 'number', number: '9', name: 'Root', variable: 'y' },
      { type: 'number', number: '6', formula: '((x * 0.5) + 1)', dependent: true },
      {
        type: 'number',
        number: '11',
        formula: '((x + 2147483648) - 2147483647)',
        dependent: true,
      },
      { type: 'number', number: '3', formula: '((y) ^ (0.5))', dependent: true },
    ]);

    const counts = (pair: ReturnType<typeof sourceApi.bindSourceCompilationCircuit>) => {
      const behavior = generateBlueprintJson(pair.resolvedCircuit.ir).blueprint.entities[0]!
        .control_behavior as {
        sections: { sections: { filters: { count: number }[] }[] };
      };
      return behavior.sections.sections[0]!.filters.map(({ count }) => count);
    };
    const defaults = sourceApi.bindSourceCompilationCircuit(compilation);
    const overridden = sourceApi.bindSourceCompilationCircuit(compilation, [
      { parameter: amount, value: 14 },
      { parameter: root, value: 16 },
    ]);
    expect(counts(defaults)).toEqual([10, 6, 11, 9, 3]);
    expect(counts(overridden)).toEqual([14, 8, 15, 16, 4]);
    expect(() =>
      sourceApi.bindSourceCompilationCircuit(compilation, [
        { parameter: amount, value: 11 },
        { parameter: root, value: 16 },
      ]),
    ).toThrow(expect.objectContaining({ code: 'CP1000' }));
    expect(() =>
      sourceApi.bindSourceCompilationCircuit(compilation, [
        { parameter: amount, value: 14 },
        { parameter: root, value: 2 },
      ]),
    ).toThrow(expect.objectContaining({ code: 'CP1000' }));

    const nativeJson = emitNativeBlueprintJson(native);
    expect(nativeJson.blueprint.entities[0]!.control_behavior).toMatchObject({
      sections: {
        sections: [
          {
            filters: [
              { name: 'signal-A', count: 10 },
              { name: 'signal-B', count: 6 },
              { name: 'signal-C', count: 11 },
              { name: 'signal-D', count: 9 },
              { name: 'signal-E', count: 3 },
            ],
          },
        ],
      },
    });
    expect(sourceApi.sourceCompilationArtifact(compilation)).toEqual(original);
  });

  test.each([false, true])(
    'Arithmetic Signal output still rejects native metadata (mixed numeric: %s) without losing concrete defaults',
    (mixed) => {
      const text = `${mixed ? "const amount = Param.number('Amount', 5);\n" : ''}const channel = Param.signal('Result', Signal('virtual', 'signal-B'));
const output = new Network();
output += Arithmetic({ left: 2, operation: 'add', right: ${mixed ? 'amount' : '5'}, output: channel });`;
      const compilation = compile(text);
      const original = structuredClone(sourceApi.sourceCompilationArtifact(compilation));
      const error = exportFailure(compilation);
      expect(error).toMatchObject({
        code: 'CP1002',
        path: `$.parameters[${mixed ? 1 : 0}]`,
        span: sourceApi
          .listSourceCompilationParameters(compilation)
          .find(({ label }) => label === 'Result')!.source,
      });
      expect(text.slice(error.span!.start, error.span!.end)).toBe(
        "Param.signal('Result', Signal('virtual', 'signal-B'))",
      );
      const concrete = generateBlueprintJson(compilation.resolvedCircuit!.ir);
      expect(concrete.blueprint).not.toHaveProperty('parameters');
      expect(concrete.blueprint.entities).toHaveLength(1);
      expect(concrete.blueprint.entities[0]).toMatchObject({
        control_behavior: {
          arithmetic_conditions: {
            first_constant: 2,
            second_constant: 5,
            output_signal: { name: 'signal-B' },
          },
        },
      });
      const bound = sourceApi.bindSourceCompilationCircuit(compilation);
      const replay = executeResolvedDirectPlan(bound.plan, bound.resolvedCircuit);
      expect(
        replay.circuit
          .createSimulation()
          .step()
          .read(replay.network('output').id)
          .get(signal('virtual', 'signal-B')),
      ).toBe(7);
      expect(sourceApi.sourceCompilationArtifact(compilation)).toEqual(original);
    },
  );

  test('compiles the complete documented numeric metadata example and exports its exact rows', () => {
    const page = readFileSync(
      new URL('../../../docs/native-objects-deciders-and-parameters.md', import.meta.url),
      'utf8',
    );
    const example = page.match(/### Numeric metadata[\s\S]*?```ts\r?\n([\s\S]*?)```/)?.[1];
    expect(example).toBeDefined();
    const compilation = compile(example!);
    expect(
      sourceApi.exportSourceCompilationNativeBlueprint(compilation, options).parameters,
    ).toEqual([
      { type: 'number', number: '5', name: 'Multiplier', variable: 'x' },
      { type: 'number', number: '111', name: 'Limit', formula: 'x * 2', dependent: true },
    ]);
  });

  test.each([
    { variable: '', formula: '', dependent: false },
    { formula: ' 未知(x) + ( \n', dependent: true },
    { variable: 'x', formula: 'x + missing', dependent: false },
    { variable: 'same', formula: 'other + 1' },
  ])('copies opaque metadata and keeps exact declaration order: %j', (metadata) => {
    const compilation =
      compile(`const first = Param.number('First', 5, ${JSON.stringify(metadata)});
const second = Param.number('Second', 111, { variable: 'same', formula: 'same + (', dependent: true });
const output = new Network();
output += Constant({ sections: [{ filters: [
  { signal: Signal('virtual', 'signal-A'), value: first },
  { signal: Signal('virtual', 'signal-B'), value: second },
  { signal: Signal('virtual', 'signal-C'), value: first },
] }] });`);
    const native = sourceApi.exportSourceCompilationNativeBlueprint(compilation, options);
    expect(native.parameters).toEqual([
      { type: 'number', number: '5', name: 'First', ...metadata },
      {
        type: 'number',
        number: '111',
        name: 'Second',
        variable: 'same',
        formula: 'same + (',
        dependent: true,
      },
    ]);
    expect(native.entities).toHaveLength(1);
    expect(native.parameters!.every(Object.isFrozen)).toBe(true);
    validateNativeBlueprintFcir(native);
    expect(
      JSON.parse(JSON.stringify(emitNativeBlueprintJson(native))).blueprint.parameters,
    ).toEqual(native.parameters);
  });

  test.each(['', ', {}', ', undefined'])(
    'keeps absent and empty metadata native shapes unchanged: %s',
    (suffix) => {
      const compilation = compile(
        exactSource.replace("Param.number('Amount', 5)", `Param.number('Amount', 5${suffix})`),
      );
      const declarations = sourceApi.listSourceCompilationParameters(compilation);
      expect(declarations[0]).not.toHaveProperty('metadata');
      expect(
        sourceApi.exportSourceCompilationNativeBlueprint(compilation, options).parameters,
      ).toEqual([{ type: 'number', number: '5', name: 'Amount' }]);
    },
  );

  test('exports repeated metadata handles across families without source rerun or artifact mutation', () => {
    const key = '__comblang_formula_metadata_executions';
    const globals = globalThis as Record<string, unknown>;
    const existed = Object.hasOwn(globals, key);
    const previous = globals[key];
    globals[key] = 0;
    try {
      const compilation = compile(
        `globalThis.${key} += 1;\n${mixedSource.replace("Param.number('Amount', 5)", "Param.number('Amount', 5, { variable: 'x', formula: 'unknown(x)', dependent: false })")}`,
      );
      const before = structuredClone(sourceApi.sourceCompilationArtifact(compilation));
      const plan = compilation.plan;
      const circuit = compilation.resolvedCircuit;
      const parameter = sourceApi.listSourceCompilationParameters(compilation)[0]!.parameter;
      sourceApi.bindSourceCompilationCircuit(compilation, [{ parameter, value: 41 }]);
      const first = sourceApi.exportSourceCompilationNativeBlueprint(compilation, options);
      const second = sourceApi.exportSourceCompilationNativeBlueprint(compilation, options);
      expect(second).toEqual(first);
      expect(first.parameters).toEqual([
        {
          type: 'number',
          number: '5',
          name: 'Amount',
          variable: 'x',
          formula: 'unknown(x)',
          dependent: false,
        },
      ]);
      expect(first.entities).toEqual(buildNativeBlueprintFcir(circuit!.ir, options).entities);
      expect(first.wires).toEqual(buildNativeBlueprintFcir(circuit!.ir, options).wires);
      expect(globals[key]).toBe(1);
      expect(compilation.plan).toBe(plan);
      expect(compilation.resolvedCircuit).toBe(circuit);
      expect(sourceApi.sourceCompilationArtifact(compilation)).toEqual(before);
    } finally {
      if (existed) globals[key] = previous;
      else delete globals[key];
    }
  });

  test.each([
    {
      declarations:
        "const amount = Param.number('Unused formula', 5, { formula: 'x + 1', dependent: true });",
      value: '3',
      path: '$.parameters[0]',
    },
    {
      declarations: "const amount = Param.number('Out of range', 2147483648, { formula: '0' });",
      value: 'amount',
      path: '$.parameters[0].defaultValue',
    },
    {
      declarations:
        "const amount = Param.number('First', 5, { variable: 'x' }); const duplicate = Param.number('Second', 5, { variable: 'y', formula: 'x' });",
      value: 'amount',
      path: '$.parameters[1].defaultValue',
    },
  ])(
    'metadata does not relax unused/int32/original constraints: $path',
    ({ declarations, value, path }) => {
      const compilation = compile(`${declarations}
const output = new Network();
output += Constant({ sections: [{ filters: [
  { signal: Signal('virtual', 'signal-A'), value: ${value} },
  ${declarations.includes('duplicate') ? "{ signal: Signal('virtual', 'signal-B'), value: duplicate }," : ''}
] }] });`);
      expect(exportFailure(compilation)).toMatchObject({ code: 'CP1002', path });
    },
  );

  test('preserves positional numeric formula metadata with defaults in actual Constant slots', () => {
    const compilation =
      compile(`const multiplier = Param.number('Multiplier', 5, { variable: 'x' });
const limit = Param.number('Limit', 111, { formula: ${JSON.stringify(' x * 2\n')}, dependent: true });
const output = new Network();
output += Constant({ sections: [{ filters: [
  { signal: Signal('virtual', 'signal-A'), value: multiplier },
  { signal: Signal('virtual', 'signal-B'), value: limit },
] }] });`);
    const native = sourceApi.exportSourceCompilationNativeBlueprint(compilation, options);
    expect(native.parameters).toEqual([
      { type: 'number', number: '5', name: 'Multiplier', variable: 'x' },
      { type: 'number', number: '111', name: 'Limit', formula: ' x * 2\n', dependent: true },
    ]);
    expect(emitNativeBlueprintJson(native).blueprint.parameters).toEqual(native.parameters);
    expect(
      sourceApi
        .listSourceCompilationParameters(compilation)
        .map(({ defaultValue }) => defaultValue),
    ).toEqual([5, 111]);
  });

  test.each([
    ['AND', 'input[A] > amount && input[A] < upper', [5, 19], ['and', 'and']],
    ['OR', 'input[A] > amount || input[A] < upper', [5, 19], ['and', 'or']],
    [
      'distributed AND',
      '(input[A] > amount || input[A] == 0) && (input[A] < upper || input[A] == 5)',
      [5, 19, 5, 5, 0, 19, 0, 5],
      ['and', 'and', 'or', 'and', 'or', 'and', 'or', 'and'],
    ],
    [
      'repeated handle',
      'input[A] > amount && (input[A] < upper || input[A] != amount)',
      [5, 19, 5, 5],
      ['and', 'and', 'or', 'and'],
    ],
    [
      'two repeated handles',
      '(input[A] > upper || input[A] > amount) && (input[A] <= upper || input[A] != amount)',
      [19, 19, 19, 5, 5, 19, 5, 5],
      ['and', 'and', 'or', 'and', 'or', 'and', 'or', 'and'],
    ],
  ])(
    'exports %s leaf occurrences in the existing native row order',
    (_name, condition, constants, types) => {
      const compilation = compile(`const A = Signal('virtual', 'signal-A');
const upper = Param.number('Upper', 19);
const amount = Param.number('Amount', 5);
const input = new Network();
const output = new Network();
output += Decider({ condition: ${condition}, outputs: [input[A], 2 * A], elseOutputs: [3 * A] });`);
      const before = structuredClone(sourceApi.sourceCompilationArtifact(compilation));
      const declarations = sourceApi.listSourceCompilationParameters(compilation);
      sourceApi.bindSourceCompilationParameters(
        compilation,
        declarations.map(({ parameter }, index) => ({ parameter, value: 70 + index })),
      );
      const native = sourceApi.exportSourceCompilationNativeBlueprint(compilation, options);
      expect(native.parameters).toEqual([
        { type: 'number', number: '19', name: 'Upper' },
        { type: 'number', number: '5', name: 'Amount' },
      ]);
      expect(native.entities).toEqual(
        buildNativeBlueprintFcir(compilation.resolvedCircuit!.ir, options).entities,
      );
      expect(native.wires).toEqual(
        buildNativeBlueprintFcir(compilation.resolvedCircuit!.ir, options).wires,
      );
      expect(native.entities).toHaveLength(1);
      const behavior = emitNativeBlueprintJson(native).blueprint.entities[0]!.control_behavior as {
        decider_conditions: { conditions: { constant: number; compare_type: string }[] };
      };
      expect(behavior.decider_conditions.conditions.map(({ constant }) => constant)).toEqual(
        constants,
      );
      expect(
        behavior.decider_conditions.conditions.map(({ compare_type }) => compare_type),
      ).toEqual(types);
      expect(sourceApi.sourceCompilationArtifact(compilation)).toEqual(before);
    },
  );

  test('retains row expansion limits and retryability for parameterized compound conditions', () => {
    const compilation = compile(`${exactSource}
const input = new Network();
output += Decider({ condition: (input[A] > amount || input[A] == 0) && (input[A] < 19 || input[A] == 5), outputs: [input[A]] });`);
    const before = structuredClone(sourceApi.sourceCompilationArtifact(compilation));
    expect(() =>
      sourceApi.exportSourceCompilationNativeBlueprint(compilation, {
        ...options,
        maxDeciderConditionRows: 7,
      }),
    ).toThrow(/limit of 7 rows/);
    expect(sourceApi.sourceCompilationArtifact(compilation)).toEqual(before);
    const native = sourceApi.exportSourceCompilationNativeBlueprint(compilation, {
      ...options,
      maxDeciderConditionRows: 8,
    });
    expect(native.parameters).toEqual([{ type: 'number', number: '5', name: 'Amount' }]);
    expect(native.entities).toHaveLength(2);
  });

  test('rejects equal originals across two compound leaves without returning partial metadata', () => {
    const compilation = compile(`${exactSource}
const other = Param.number('Other', 5);
const input = new Network();
output += Decider({ condition: input[A] > amount || input[A] < other, outputs: [input[A]] });`);
    const before = structuredClone(sourceApi.sourceCompilationArtifact(compilation));
    expect(exportFailure(compilation)).toMatchObject({
      code: 'CP1002',
      path: '$.parameters[1].defaultValue',
    });
    expect(sourceApi.sourceCompilationArtifact(compilation)).toEqual(before);
  });

  test.each(['selector', 'scalar decider', 'wildcard decider'])(
    'exports a real %s numeric slot without changing concrete artifacts',
    (family) => {
      const device =
        family === 'selector'
          ? "Selector({ input, operation: 'select', index: amount, selectMax: false })"
          : `Decider({ condition: ${family === 'scalar decider' ? 'input[A]' : 'Each(input)'} > amount, outputs: [input[A]] })`;
      const compilation = compile(`const A = Signal('virtual', 'signal-A');
const amount = Param.number('Amount', 5);
const input = new Network();
const output = new Network();
output += ${device};`);
      const before = structuredClone(sourceApi.sourceCompilationArtifact(compilation));
      const concrete = buildNativeBlueprintFcir(compilation.resolvedCircuit!.ir, options);
      const native = sourceApi.exportSourceCompilationNativeBlueprint(compilation, options);
      expect(native.parameters).toEqual([{ type: 'number', number: '5', name: 'Amount' }]);
      expect(native.entities).toEqual(concrete.entities);
      expect(native.wires).toEqual(concrete.wires);
      const json = emitNativeBlueprintJson(native);
      expect(json.blueprint.parameters).toEqual(native.parameters);
      expect(json.blueprint.entities[0]).toMatchObject({
        control_behavior:
          family === 'selector'
            ? { operation: 'select', index_constant: 5, select_max: false }
            : {
                decider_conditions: {
                  conditions: [
                    {
                      constant: 5,
                      comparator: '>',
                      first_signal: {
                        type: 'virtual',
                        name: family === 'scalar decider' ? 'signal-A' : 'signal-each',
                      },
                    },
                  ],
                },
              },
      });
      expect(sourceApi.sourceCompilationArtifact(compilation)).toEqual(before);
    },
  );

  test('exports a real Constant count through the normal emitter without changing concrete artifacts', () => {
    const compilation = compile(exactSource);
    const original = structuredClone(sourceApi.sourceCompilationArtifact(compilation));
    const concrete = buildNativeBlueprintFcir(compilation.resolvedCircuit!.ir, options);
    const native = sourceApi.exportSourceCompilationNativeBlueprint(compilation, options);
    const json = emitNativeBlueprintJson(native);
    expect(native.parameters).toEqual([{ type: 'number', number: '5', name: 'Amount' }]);
    expect(native.entities).toEqual(concrete.entities);
    expect(native.wires).toEqual(concrete.wires);
    expect(native.entities).toHaveLength(1);
    expect(json.blueprint.entities[0]).toMatchObject({
      name: 'constant-combinator',
      control_behavior: {
        sections: { sections: [{ filters: [{ type: 'virtual', name: 'signal-A', count: 5 }] }] },
      },
    });
    expect(json.blueprint.parameters).toEqual(native.parameters);
    expect(sourceApi.sourceCompilationArtifact(compilation)).toEqual(original);
  });

  test('projects authenticated Constant Signal defaults to placeholders without changing local binding', () => {
    const key = '__comblang_native_signal_export_runs';
    const globals = globalThis as Record<string, unknown>;
    const existed = Object.hasOwn(globals, key);
    const previous = globals[key];
    globals[key] = 0;
    try {
      const compilation = compile(`globalThis.${key} += 1;
const amount = Param.number('Amount', 5);
const channel = Param.signal('Channel', Signal('virtual', 'signal-A'));
const output = new Network();
output += Constant({ sections: [{ filters: [
  { signal: channel, value: amount },
  { signal: channel, value: amount },
  { signal: Signal('item', 'iron-plate'), value: 7 },
  { signal: Signal('fluid', 'water'), value: 11 },
] }] });
output += Constant({ sections: [{ filters: [{ signal: Signal('virtual', 'signal-A'), value: 13 }] }] });
output += Constant({ sections: [{ filters: [{ signal: Signal('virtual', 'signal-A'), value: 17 }] }] });`);
      const artifact = structuredClone(sourceApi.sourceCompilationArtifact(compilation));
      const declarations = sourceApi.listSourceCompilationParameters(compilation);
      const localParameter = declarations.find(({ kind }) => kind === 'signal')!.parameter;
      const local = sourceApi.bindSourceCompilationParameters(compilation, [
        { parameter: localParameter, value: signal('virtual', 'signal-B') },
      ]);
      const filtersByEntity = (
        entities: ReturnType<typeof generateBlueprintJson>['blueprint']['entities'],
      ) =>
        entities.map(
          (entity) =>
            (
              entity.control_behavior as {
                sections: {
                  sections: { filters: { type?: string; name: string; count: number }[] }[];
                };
              }
            ).sections.sections[0]!.filters,
        );
      const localRows = filtersByEntity(generateBlueprintJson(local).blueprint.entities);
      expect(
        localRows.map((rows) => rows.map(({ type, name, count }) => ({ type, name, count }))),
      ).toEqual([
        [
          { type: 'virtual', name: 'signal-B', count: 5 },
          { type: 'virtual', name: 'signal-B', count: 5 },
          { type: undefined, name: 'iron-plate', count: 7 },
          { type: 'fluid', name: 'water', count: 11 },
        ],
        [{ type: 'virtual', name: 'signal-A', count: 13 }],
        [{ type: 'virtual', name: 'signal-A', count: 17 }],
      ]);

      const defaultPair = sourceApi.bindSourceCompilationCircuit(compilation);
      const defaultRows = filtersByEntity(
        generateBlueprintJson(defaultPair.resolvedCircuit.ir).blueprint.entities,
      );
      expect(
        defaultRows.map((rows) => rows.map(({ type, name, count }) => ({ type, name, count }))),
      ).toEqual([
        [
          { type: 'virtual', name: 'signal-A', count: 5 },
          { type: 'virtual', name: 'signal-A', count: 5 },
          { type: undefined, name: 'iron-plate', count: 7 },
          { type: 'fluid', name: 'water', count: 11 },
        ],
        [{ type: 'virtual', name: 'signal-A', count: 13 }],
        [{ type: 'virtual', name: 'signal-A', count: 17 }],
      ]);

      expect(() =>
        sourceApi.exportSourceCompilationNativeBlueprint(compilation, {
          ...options,
          maxDeciderConditionRows: 0,
        }),
      ).toThrow(RangeError);
      expect(sourceApi.sourceCompilationArtifact(compilation)).toEqual(artifact);
      const native = sourceApi.exportSourceCompilationNativeBlueprint(compilation, options);
      const retry = sourceApi.exportSourceCompilationNativeBlueprint(compilation, options);
      expect(retry).toEqual(native);
      expect(globals[key]).toBe(1);
      expect(native.parameters).toEqual([
        { type: 'number', number: '5', name: 'Amount' },
        {
          type: 'id',
          id: 'parameter-0',
          name: 'Channel',
          'quality-condition': { quality: 'normal', comparator: '=' },
        },
      ]);
      const rows = filtersByEntity(emitNativeBlueprintJson(native).blueprint.entities);
      expect(
        rows.map((entityRows) =>
          entityRows.map(({ type, name, count }) => ({ type, name, count })),
        ),
      ).toEqual([
        [
          { type: undefined, name: 'parameter-0', count: 5 },
          { type: undefined, name: 'parameter-0', count: 5 },
          { type: undefined, name: 'iron-plate', count: 7 },
          { type: 'fluid', name: 'water', count: 11 },
        ],
        [{ type: undefined, name: 'parameter-0', count: 13 }],
        [{ type: undefined, name: 'parameter-0', count: 17 }],
      ]);
      expect(sourceApi.sourceCompilationArtifact(compilation)).toEqual(artifact);
      expect(native.wires).toEqual(
        buildNativeBlueprintFcir(compilation.resolvedCircuit!.ir, options).wires,
      );
      expect(native.entities).toHaveLength(3);
    } finally {
      if (existed) globals[key] = previous;
      else delete globals[key];
    }
  });

  test('replays the generated Constant Signal template against the reported placed export', async () => {
    const compilation =
      compile(`const channel = Param.signal('Channel', Signal('virtual', 'signal-A'));
const output = new Network();
output += Constant({
  sections: [
    {
      filters: [
        { signal: channel, value: 5 },
        { signal: Signal('item', 'iron-plate'), value: 7 },
        { signal: Signal('fluid', 'water'), value: 11 },
      ],
    },
  ],
}).at(4.5, -0.5);
output += Constant({
  sections: [{ filters: [{ signal: Signal('virtual', 'signal-A'), value: 13 }] }],
}).at(4.5, 0.5);`);
    const native = sourceApi.exportSourceCompilationNativeBlueprint(compilation, options);
    const generated = emitNativeBlueprintJson(native);
    type EvidenceFilter = { type?: string; name: string; count: number };
    type EvidenceEntity = {
      position: { x: number; y: number };
      direction?: number;
      control_behavior?: unknown;
    };
    type EvidenceBlueprint = {
      entities: readonly EvidenceEntity[];
      parameters?: readonly unknown[];
      wires: readonly (readonly number[])[];
    };
    const generatedBlueprint = generated.blueprint as unknown as EvidenceBlueprint;
    const exchange = readFileSync(
      new URL(
        '../../../fixtures/blueprint-exchange/factorio-2.1.21/generated-signal-placed.txt',
        import.meta.url,
      ),
      'utf8',
    ).replace(/\r?\n$/, '');
    const placedDocument = await decodeBlueprintExchange(exchange);
    const placed = JSON.parse(stringifyLosslessJson(placedDocument)) as {
      blueprint: EvidenceBlueprint;
    };

    expect(generated.blueprint.parameters).toEqual([
      {
        type: 'id',
        id: 'parameter-0',
        name: 'Channel',
        'quality-condition': { quality: 'normal', comparator: '=' },
      },
    ]);
    const filterRows = (blueprint: EvidenceBlueprint) =>
      blueprint.entities.map((entity) => {
        const behavior = entity.control_behavior as {
          sections: { sections: { filters: EvidenceFilter[] }[] };
        };
        return behavior.sections.sections.flatMap((section) => section.filters);
      });
    const summarize = (rows: ReturnType<typeof filterRows>[number]) =>
      rows.map(({ type, name, count }) => ({ type, name, count }));
    const generatedRows = filterRows(generatedBlueprint);
    expect(generatedRows.map(summarize)).toEqual([
      [
        { type: undefined, name: 'parameter-0', count: 5 },
        { type: undefined, name: 'iron-plate', count: 7 },
        { type: 'fluid', name: 'water', count: 11 },
      ],
      [{ type: undefined, name: 'parameter-0', count: 13 }],
    ]);
    for (const entityRows of generatedRows) {
      for (const row of entityRows.filter(({ name }) => name === 'parameter-0')) {
        expect(row).not.toHaveProperty('type');
      }
    }

    expect(placed.blueprint).not.toHaveProperty('parameters');
    const placedRows = filterRows(placed.blueprint);
    expect(placedRows.map(summarize)).toEqual(
      generatedRows.map((rows) =>
        rows.map((row) =>
          row.name === 'parameter-0'
            ? { type: 'virtual', name: 'signal-B', count: row.count }
            : { type: row.type, name: row.name, count: row.count },
        ),
      ),
    );
    expect(placed.blueprint.wires).toEqual([[1, 1, 2, 1]]);
    expect(generatedBlueprint.wires).toEqual(placed.blueprint.wires);
    expect(
      placed.blueprint.entities.map(({ position, direction }) => ({
        position: { x: position.x - 12, y: position.y + 1 },
        direction,
      })),
    ).toEqual(
      generatedBlueprint.entities.map(({ position, direction }) => ({
        position,
        direction,
      })),
    );
  });

  test('replays the generated Constant numeric formula against the reported placed export', async () => {
    const key = '__comblang_native_constant_number_formula_runs';
    const globals = globalThis as Record<string, unknown>;
    const existed = Object.hasOwn(globals, key);
    const previous = globals[key];
    globals[key] = 0;
    try {
      type EvidenceFilter = {
        type?: string;
        name: string;
        quality?: string;
        comparator?: string;
        count: number;
      };
      type EvidenceEntity = {
        name: string;
        position: { x: number; y: number };
        direction?: number;
        control_behavior: unknown;
      };
      type EvidenceBlueprint = {
        entities: readonly EvidenceEntity[];
        parameters?: readonly unknown[];
        wires?: readonly unknown[];
      };
      const compilation = compile(`globalThis.${key} += 1;
const amount = Param.number('Amount', 5, { variable: 'x' });
const output = new Network();
output += Constant({
  sections: [
    {
      filters: [
        { signal: Signal('virtual', 'signal-A'), value: amount },
        { signal: Signal('virtual', 'signal-B'), value: amount * 2 },
      ],
    },
  ],
}).at(0.5, 0.5);`);
      const amount = sourceApi.listSourceCompilationParameters(compilation)[0]!.parameter;
      const defaults = sourceApi.bindSourceCompilationCircuit(compilation);
      const overridden = sourceApi.bindSourceCompilationCircuit(compilation, [
        { parameter: amount, value: 9 },
      ]);
      const counts = (pair: typeof defaults) => {
        const behavior = generateBlueprintJson(pair.resolvedCircuit.ir).blueprint.entities[0]!
          .control_behavior as {
          sections: { sections: { filters: { count: number }[] }[] };
        };
        return behavior.sections.sections.flatMap((section) =>
          section.filters.map(({ count }) => count),
        );
      };
      expect(counts(defaults)).toEqual([5, 10]);
      expect(counts(overridden)).toEqual([9, 18]);

      const native = sourceApi.exportSourceCompilationNativeBlueprint(compilation, options);
      expect(native.parameters).toEqual([
        { type: 'number', number: '5', name: 'Amount', variable: 'x' },
        { type: 'number', number: '10', formula: '(x * 2)', dependent: true },
      ]);
      const nativeTemplate = emitNativeBlueprintJson(native)
        .blueprint as unknown as EvidenceBlueprint;
      const exchange = readFileSync(
        new URL(
          '../../../fixtures/blueprint-exchange/factorio-2.1.21/generated-number-formula-placed.txt',
          import.meta.url,
        ),
        'utf8',
      ).replace(/\r?\n$/, '');
      const placedDocument = await decodeBlueprintExchange(exchange);
      const placed = JSON.parse(stringifyLosslessJson(placedDocument)) as {
        blueprint: EvidenceBlueprint;
      };
      expect(placed.blueprint).not.toHaveProperty('parameters');
      expect(placed.blueprint).not.toHaveProperty('wires');
      expect(nativeTemplate.entities).toHaveLength(1);
      expect(placed.blueprint.entities).toHaveLength(1);

      const filterRows = (entity: EvidenceEntity) => {
        const behavior = entity.control_behavior as {
          sections: { sections: { filters: EvidenceFilter[] }[] };
        };
        return behavior.sections.sections.flatMap((section) => section.filters);
      };
      expect(filterRows(nativeTemplate.entities[0]!)).toMatchObject([{ count: 5 }, { count: 10 }]);
      const generated = generateBlueprintJson(overridden.resolvedCircuit.ir)
        .blueprint as unknown as EvidenceBlueprint;
      const summarize = (entity: EvidenceEntity, position: EvidenceEntity['position']) => ({
        name: entity.name,
        position,
        direction: entity.direction,
        filters: filterRows(entity).map(({ type, name, quality, comparator, count }) => ({
          type,
          name,
          quality,
          comparator,
          count,
        })),
      });
      const generatedEntity = generated.entities[0]!;
      const placedEntity = placed.blueprint.entities[0]!;
      expect(
        summarize(placedEntity, {
          x: placedEntity.position.x - 12,
          y: placedEntity.position.y + 2,
        }),
      ).toEqual(summarize(generatedEntity, generatedEntity.position));
      expect(globals[key]).toBe(1);
    } finally {
      if (existed) globals[key] = previous;
      else delete globals[key];
    }
  });

  test('allocates distinct Signal originals in source order and changes only Constant identities', () => {
    const compilation =
      compile(`const first = Param.signal('First', Signal('virtual', 'signal-B', 'normal'));
const amount = Param.number('Amount', 19, { variable: 'amount', formula: '2 + 17' });
const second = Param.signal('Second', Signal('virtual', 'signal-A'));
const output = new Network();
output += Constant({ isOn: false, sections: [
  { active: false, multiplier: 1.5, group: 'Stored', filters: [
    { signal: second, value: amount },
    { signal: Signal('item', 'parameter-0'), value: 3 },
    { signal: Signal('item', 'iron-plate', 'rare'), value: 7 },
  ] },
  { multiplier: -2, filters: [
    { signal: first, value: 13 },
    { signal: Signal('virtual', 'signal-A', 'normal'), value: 5 },
  ] },
] }).at(4, -2);
output += Constant({ sections: [{ filters: [
  { signal: Signal('virtual', 'signal-B'), value: 11 },
] }] }).at(-4, 2);`);
    const artifact = structuredClone(sourceApi.sourceCompilationArtifact(compilation));
    const native = sourceApi.exportSourceCompilationNativeBlueprint(compilation, options);
    expect(native.parameters).toEqual([
      {
        type: 'id',
        id: 'parameter-1',
        name: 'First',
        'quality-condition': { quality: 'normal', comparator: '=' },
      },
      { type: 'number', number: '19', name: 'Amount', variable: 'amount', formula: '2 + 17' },
      {
        type: 'id',
        id: 'parameter-2',
        name: 'Second',
        'quality-condition': { quality: 'normal', comparator: '=' },
      },
    ]);
    const document = emitNativeBlueprintJson(native);
    const restored = structuredClone(document);
    const seen: string[] = [];
    for (const entity of restored.blueprint.entities) {
      const behavior = entity.control_behavior as {
        sections: { sections: { filters: { name: string; type?: string }[] }[] };
      };
      for (const section of behavior.sections.sections) {
        for (const filter of section.filters) {
          if (filter.name !== 'parameter-1' && filter.name !== 'parameter-2') continue;
          seen.push(filter.name);
          expect(filter).not.toHaveProperty('type');
          filter.name = filter.name === 'parameter-1' ? 'signal-B' : 'signal-A';
          filter.type = 'virtual';
        }
      }
    }
    expect(seen).toEqual(['parameter-2', 'parameter-1', 'parameter-2', 'parameter-1']);
    const { parameters: _parameters, ...restoredBlueprint } = restored.blueprint;
    expect(restoredBlueprint).toEqual(
      emitNativeBlueprintJson(buildNativeBlueprintFcir(compilation.resolvedCircuit!.ir, options))
        .blueprint,
    );
    expect(sourceApi.sourceCompilationArtifact(compilation)).toEqual(artifact);
    expect(Object.isFrozen(native)).toBe(true);
    expect(Object.isFrozen(native.entities)).toBe(true);
    expect(Object.isFrozen(native.entities[0]!.native.control_behavior)).toBe(true);
    expect(sourceApi.exportSourceCompilationNativeBlueprint(compilation, options)).toEqual(native);
  });

  test('skips occupied Constant filter names and rejects exhaustion of the reviewed placeholder pool', () => {
    const skipped = compile(`const channel = Param.signal('Channel', Signal('virtual', 'signal-A'));
const output = new Network();
output += Constant({ sections: [{ filters: [
  { signal: Signal('item', 'parameter-0'), value: 1 },
  { signal: Signal('fluid', 'parameter-2'), value: 2 },
] }] });
output += Constant({ sections: [{ filters: [{ signal: channel, value: 5 }] }] });`);
    expect(sourceApi.exportSourceCompilationNativeBlueprint(skipped, options).parameters).toEqual([
      {
        type: 'id',
        id: 'parameter-1',
        name: 'Channel',
        'quality-condition': { quality: 'normal', comparator: '=' },
      },
    ]);

    const occupiedConstants = Array.from(
      { length: 10 },
      (_, index) =>
        `output += Constant({ sections: [{ filters: [{ signal: Signal('item', 'parameter-${index}'), value: ${index} }] }] });`,
    ).join('\n');
    const exhausted =
      compile(`const channel = Param.signal('Channel', Signal('virtual', 'signal-A'));
const output = new Network();
${occupiedConstants}
output += Constant({ sections: [{ filters: [{ signal: channel, value: 5 }] }] });`);
    const artifact = structuredClone(sourceApi.sourceCompilationArtifact(exhausted));
    expect(exportFailure(exhausted)).toMatchObject({
      code: 'CP1002',
      path: '$.parameters[0]',
      span: sourceApi.listSourceCompilationParameters(exhausted)[0]!.source,
      message: expect.stringContaining('parameter-9'),
    });
    expect(sourceApi.sourceCompilationArtifact(exhausted)).toEqual(artifact);
  });

  test.each([
    ["Signal('item', 'iron-plate')", '$.parameters[0].defaultValue'],
    ["Signal('virtual', 'signal-A', 'legendary')", '$.parameters[0].defaultValue'],
    ["Signal('virtual', 'parameter-0')", '$.parameters[0].defaultValue'],
  ])('rejects unsupported Signal default %s at its declaration', (defaultValue, path) => {
    const compilation = compile(`const channel = Param.signal('Channel', ${defaultValue});
const output = new Network();
output += Constant({ sections: [{ filters: [{ signal: channel, value: 5 }] }] });`);
    const artifact = structuredClone(sourceApi.sourceCompilationArtifact(compilation));
    expect(exportFailure(compilation)).toMatchObject({
      code: 'CP1002',
      path,
      span: sourceApi.listSourceCompilationParameters(compilation)[0]!.source,
    });
    expect(sourceApi.sourceCompilationArtifact(compilation)).toEqual(artifact);
  });

  test.each(["Signal('item', 'signal-A')", "Signal('virtual', 'signal-A', 'legendary')"])(
    'rejects same-name namespace/quality ambiguity from %s at the declaration',
    (conflictingSignal) => {
      const compilation =
        compile(`const channel = Param.signal('Channel', Signal('virtual', 'signal-A'));
const output = new Network();
output += Constant({ sections: [{ filters: [{ signal: channel, value: 5 }] }] });
output += Constant({ sections: [{ filters: [{ signal: ${conflictingSignal}, value: 7 }] }] });`);
      expect(exportFailure(compilation)).toMatchObject({
        code: 'CP1002',
        path: '$.parameters[0].defaultValue',
        span: sourceApi.listSourceCompilationParameters(compilation)[0]!.source,
      });
    },
  );

  test('rejects unused Signal handles, duplicate canonical originals and non-Constant circuits atomically', () => {
    const unused = compile(`const A = Signal('virtual', 'signal-A');
const channel = Param.signal('Channel', A);
const output = new Network();
output += Constant({ sections: [{ filters: [{ signal: A, value: 5 }] }] });`);
    expect(exportFailure(unused)).toMatchObject({ code: 'CP1002', path: '$.parameters[0]' });

    const duplicate = compile(`const first = Param.signal('First', Signal('virtual', 'signal-A'));
const second = Param.signal('Second', Signal('virtual', 'signal-A', 'normal'));
const output = new Network();
output += Constant({ sections: [{ filters: [
  { signal: first, value: 5 },
  { signal: second, value: 7 },
] }] });`);
    expect(exportFailure(duplicate)).toMatchObject({
      code: 'CP1002',
      path: '$.parameters[1].defaultValue',
    });

    const mixed = compile(`const channel = Param.signal('Channel', Signal('virtual', 'signal-A'));
const input = new Network();
const output = new Network();
output += Constant({ sections: [{ filters: [{ signal: channel, value: 5 }] }] });
output += Arithmetic({ left: input[Signal('virtual', 'signal-A')], operation: 'add', right: 1, output: Signal('virtual', 'signal-B') });`);
    const artifact = structuredClone(sourceApi.sourceCompilationArtifact(mixed));
    expect(exportFailure(mixed)).toMatchObject({
      code: 'CP1002',
      path: '$.parameters[0]',
    });
    expect(sourceApi.sourceCompilationArtifact(mixed)).toEqual(artifact);
  });

  test('rejects unlinked physical Entities in Signal export while leaving numeric export unaffected', () => {
    const compilation =
      compile(`const channel = Param.signal('Channel', Signal('virtual', 'signal-A'));
const extra = Entity('constant-combinator');
const output = new Network();
output += Constant({ sections: [{ filters: [{ signal: channel, value: 5 }] }] });
void extra;`);
    expect(exportFailure(compilation)).toMatchObject({
      code: 'CP1002',
      path: '$.parameters[0]',
      message: expect.stringContaining('unlinked physical Entities'),
    });
  });

  test.each([-2147483648, -0, 0, 2147483647])(
    'exports Selector original %s with either ordering and a concrete Signal index',
    (original) => {
      for (const selectMax of [false, true]) {
        const compilation = compile(`const A = Signal('virtual', 'signal-A', 'legendary');
const amount = Param.number('Amount', ${Object.is(original, -0) ? '-0' : original});
const input = new Network();
const secondary = new Network();
const output = new Network();
output += Selector({ input: pair(input, secondary), operation: 'select', index: A, selectMax: false });
output += Selector({ input: pair(input, secondary), operation: 'select', index: amount, selectMax: ${selectMax} }).at(2, 3);
output += Selector({ input, operation: 'count', output: A });`);
        const native = sourceApi.exportSourceCompilationNativeBlueprint(compilation, options);
        expect(native.parameters).toEqual([
          { type: 'number', number: String(original), name: 'Amount' },
        ]);
        const baseline = buildNativeBlueprintFcir(compilation.resolvedCircuit!.ir, options);
        expect(native.entities).toEqual(baseline.entities);
        expect(native.wires).toEqual(baseline.wires);
        const entities = emitNativeBlueprintJson(native).blueprint.entities;
        expect(entities[0]).toMatchObject({
          entity_number: 1,
          control_behavior: {
            operation: 'select',
            index_signal: { name: 'signal-A', quality: 'legendary' },
          },
        });
        expect(entities[1]).toMatchObject({
          entity_number: 2,
          position: { x: 2, y: 3 },
          control_behavior: {
            operation: 'select',
            select_max: selectMax,
            index_constant: original === 0 ? 0 : original,
          },
        });
        expect(entities[2]).toMatchObject({
          entity_number: 3,
          control_behavior: {
            operation: 'count',
            count_signal: { name: 'signal-A', quality: 'legendary' },
          },
        });
      }
    },
  );

  test.each([
    ['>', 0, '>'],
    ['<', -7, '<'],
    ['>=', -2147483648, '≥'],
    ['<=', 2147483647, '≤'],
    ['==', -0, '='],
    ['!=', -5, '≠'],
  ] as const)(
    'exports Decider comparison %s with original %s and unchanged ordered then/else rows',
    (operator, original, comparator) => {
      const compilation = compile(`const A = Signal('virtual', 'signal-A', 'legendary');
const amount = Param.number('Amount', ${Object.is(original, -0) ? '-0' : original});
const input = new Network();
const secondary = new Network();
const output = new Network();
output += Decider({ condition: pair(input, secondary)[A] ${operator} amount, outputs: [input[A], 2 * A, 2 * A], elseOutputs: [secondary[A], 3 * A] }).at(4, 5, 2);`);
      const before = structuredClone(sourceApi.sourceCompilationArtifact(compilation));
      const native = sourceApi.exportSourceCompilationNativeBlueprint(compilation, options);
      expect(native.parameters).toEqual([
        { type: 'number', number: String(original), name: 'Amount' },
      ]);
      const baseline = buildNativeBlueprintFcir(compilation.resolvedCircuit!.ir, options);
      expect(native.entities).toEqual(baseline.entities);
      expect(native.wires).toEqual(baseline.wires);
      expect(emitNativeBlueprintJson(native).blueprint.entities[0]).toMatchObject({
        position: { x: 4, y: 5 },
        direction: 2,
        control_behavior: {
          decider_conditions: {
            conditions: [
              {
                constant: original === 0 ? 0 : original,
                comparator,
                first_signal: { name: 'signal-A', quality: 'legendary' },
                first_signal_networks: { red: true, green: true },
              },
            ],
            outputs: [{ copy_count_from_input: true }, { constant: 2 }, { constant: 2 }],
            else_outputs: [{ copy_count_from_input: true }, { constant: 3 }],
          },
        },
      });
      expect(sourceApi.sourceCompilationArtifact(compilation)).toEqual(before);
    },
  );

  test('shares one nominal handle across four families without allocating extra topology', () => {
    const compilation = compile(mixedSource);
    const native = sourceApi.exportSourceCompilationNativeBlueprint(compilation, options);
    expect(native.parameters).toEqual([{ type: 'number', number: '5', name: 'Amount' }]);
    expect(native.entities).toHaveLength(4);
    expect(native.entities).toEqual(
      buildNativeBlueprintFcir(compilation.resolvedCircuit!.ir, options).entities,
    );
    const entities = emitNativeBlueprintJson(native).blueprint.entities;
    expect(entities[1]).toMatchObject({
      control_behavior: { arithmetic_conditions: { first_constant: 5, second_constant: 5 } },
    });
    expect(entities[2]).toMatchObject({
      control_behavior: { decider_conditions: { conditions: [{ constant: 5 }] } },
    });
    expect(entities[3]).toMatchObject({ control_behavior: { index_constant: 5 } });
  });

  test('orders distinct metadata by declarations rather than new-family occurrence order', () => {
    const compilation = compile(`const A = Signal('virtual', 'signal-A');
const first = Param.number('First', 5);
const second = Param.number('Second', -9);
const input = new Network();
const output = new Network();
output += Selector({ input, operation: 'select', index: second });
output += Decider({ condition: input[A] > first, outputs: [input[A]] });
output += Arithmetic({ left: second, operation: 'add', right: first, output: A });
output += Constant({ sections: [{ filters: [{ signal: A, value: first }] }] });`);
    const native = sourceApi.exportSourceCompilationNativeBlueprint(compilation, options);
    expect(native.parameters).toEqual([
      { type: 'number', number: '5', name: 'First' },
      { type: 'number', number: '-9', name: 'Second' },
    ]);
    expect(native.entities).toEqual(
      buildNativeBlueprintFcir(compilation.resolvedCircuit!.ir, options).entities,
    );
  });

  test('retains nominal declaration order, repeated uses, duplicate labels and matching concrete literals', () => {
    const compilation = compile(`const A = Signal('virtual', 'signal-A');
const B = Signal('virtual', 'signal-B');
const first = Param.number('Same label', 7);
const second = Param.number('Same label', -9);
const output = new Network();
output += Constant({ sections: [{ filters: [{ signal: A, value: second }, { signal: B, value: first }] }] });
output += Constant({ sections: [{ filters: [{ signal: A, value: first }, { signal: B, value: 7 }] }] });`);
    const native = sourceApi.exportSourceCompilationNativeBlueprint(compilation, options);
    const baseline = buildNativeBlueprintFcir(compilation.resolvedCircuit!.ir, options);
    expect(native.parameters).toEqual([
      { type: 'number', number: '7', name: 'Same label' },
      { type: 'number', number: '-9', name: 'Same label' },
    ]);
    expect(native.entities).toHaveLength(2);
    expect(native.entities).toEqual(baseline.entities);
    expect(native.wires).toEqual(baseline.wires);
    expect(emitNativeBlueprintJson(native).blueprint.entities[1]).toMatchObject({
      control_behavior: { sections: { sections: [{ filters: [{ count: 7 }, { count: 7 }] }] } },
    });
  });

  test.each([-2147483648, -5, -0, 0, 2147483647])(
    'preserves int32 original %s including an explicit zero filter',
    (original) => {
      const compilation = compile(
        exactSource.replace(
          "'Amount', 5",
          `'Amount', ${Object.is(original, -0) ? '-0' : String(original)}`,
        ),
      );
      const native = sourceApi.exportSourceCompilationNativeBlueprint(compilation, options);
      expect(native.parameters).toEqual([
        { type: 'number', number: String(original), name: 'Amount' },
      ]);
      expect(emitNativeBlueprintJson(native).blueprint.entities[0]).toMatchObject({
        control_behavior: {
          sections: { sections: [{ filters: [{ count: original === 0 ? 0 : original }] }] },
        },
      });
      expect(native.entities).toEqual(
        buildNativeBlueprintFcir(compilation.resolvedCircuit!.ir, options).entities,
      );
    },
  );

  test.each(['5', '-0'])(
    'rejects distinct handles sharing original %s at the second declaration',
    (original) => {
      const text = `const A = Signal('virtual', 'signal-A');
const first = Param.number('First', ${original});
const second = Param.number('Second', ${original === '-0' ? '0' : original});
const output = new Network();
output += Constant({ sections: [{ filters: [{ signal: A, value: first }] }] });
output += Constant({ sections: [{ filters: [{ signal: A, value: second }] }] });`;
      const compilation = compile(text);
      const declarations = sourceApi.listSourceCompilationParameters(compilation);
      const before = structuredClone(sourceApi.sourceCompilationArtifact(compilation));
      expect(() =>
        sourceApi.exportSourceCompilationNativeBlueprint(compilation, options),
      ).toThrowError(
        expect.objectContaining({
          code: 'CP1002',
          path: '$.parameters[1].defaultValue',
          span: declarations[1]!.source,
          message: expect.stringContaining(
            `"First" at ${declarations[0]!.source.fileId}:${declarations[0]!.source.start}-${declarations[0]!.source.end}`,
          ),
        }),
      );
      expect(sourceApi.sourceCompilationArtifact(compilation)).toEqual(before);
      expect(sourceApi.bindSourceCompilationParameters(compilation).producers).toHaveLength(2);
    },
  );

  test('returns deeply immutable validated FCIR', () => {
    const native = sourceApi.exportSourceCompilationNativeBlueprint(compile(exactSource), options);
    validateNativeBlueprintFcir(native);
    expect(Object.isFrozen(native)).toBe(true);
    expect(Object.isFrozen(native.parameters)).toBe(true);
    expect(Object.isFrozen(native.parameters![0])).toBe(true);
    expect(Object.isFrozen(native.entities[0]!.native)).toBe(true);
    expect(() => Reflect.set(native.parameters![0]!, 'number', '19')).not.toThrow();
    expect(native.parameters![0]).toMatchObject({ number: '5' });
  });

  test('exports both Arithmetic constant operands and shares declarations with Constant counts', () => {
    const compilation = compile(`const A = Signal('virtual', 'signal-A');
const first = Param.number('First', 5);
const second = Param.number('Second', -9);
const output = new Network();
output += Arithmetic({ left: second, operation: 'add', right: first, output: A });
output += Constant({ sections: [{ filters: [{ signal: A, value: first }] }] });
output += Arithmetic({ left: first, operation: 'multiply', right: first, output: A });`);
    const original = structuredClone(sourceApi.sourceCompilationArtifact(compilation));
    const native = sourceApi.exportSourceCompilationNativeBlueprint(compilation, options);
    const concrete = buildNativeBlueprintFcir(compilation.resolvedCircuit!.ir, options);
    expect(native.parameters).toEqual([
      { type: 'number', number: '5', name: 'First' },
      { type: 'number', number: '-9', name: 'Second' },
    ]);
    expect(native.entities).toEqual(concrete.entities);
    expect(native.wires).toEqual(concrete.wires);
    const entities = emitNativeBlueprintJson(native).blueprint.entities;
    expect(entities[0]).toMatchObject({
      control_behavior: { arithmetic_conditions: { first_constant: -9, second_constant: 5 } },
    });
    expect(entities[2]).toMatchObject({
      control_behavior: { arithmetic_conditions: { first_constant: 5, second_constant: 5 } },
    });
    expect(sourceApi.sourceCompilationArtifact(compilation)).toEqual(original);
  });

  test.each([-2147483648, -0, 0, 2147483647])(
    'exports Arithmetic original %s on either operand without capturing the signal input',
    (original) => {
      for (const side of ['left', 'right'] as const) {
        const compilation = compile(`const A = Signal('virtual', 'signal-A');
const amount = Param.number('Amount', ${Object.is(original, -0) ? '-0' : original});
const input = new Network();
const output = new Network();
output += Arithmetic({ left: ${side === 'left' ? 'amount' : 'input[A]'}, operation: 'add', right: ${side === 'right' ? 'amount' : 'input[A]'}, output: A });`);
        const native = sourceApi.exportSourceCompilationNativeBlueprint(compilation, options);
        expect(native.parameters).toEqual([
          { type: 'number', number: String(original), name: 'Amount' },
        ]);
        expect(native.entities).toEqual(
          buildNativeBlueprintFcir(compilation.resolvedCircuit!.ir, options).entities,
        );
        expect(emitNativeBlueprintJson(native).blueprint.entities[0]).toMatchObject({
          control_behavior: {
            arithmetic_conditions: {
              [side === 'left' ? 'first_constant' : 'second_constant']:
                original === 0 ? 0 : original,
              [side === 'left' ? 'second_signal' : 'first_signal']: {
                type: 'virtual',
                name: 'signal-A',
              },
            },
          },
        });
      }
    },
  );

  test.each([
    "Arithmetic({ left: other, operation: 'add', right: 2, output: A })",
    'Decider({ condition: input[A] > other, outputs: [input[A]] })',
    "Selector({ input, operation: 'select', index: other })",
  ])('rejects equal originals across Constant and %s without changing either capture', (device) => {
    const compilation = compile(`${exactSource}
const other = Param.number('Other', 5);
const input = new Network();
output += ${device};`);
    const before = structuredClone(sourceApi.sourceCompilationArtifact(compilation));
    expect(exportFailure(compilation)).toMatchObject({
      code: 'CP1002',
      path: '$.parameters[1].defaultValue',
      span: sourceApi.listSourceCompilationParameters(compilation)[1]!.source,
      message: expect.stringContaining('"Amount" at'),
    });
    expect(sourceApi.bindSourceCompilationParameters(compilation).producers).toHaveLength(2);
    expect(sourceApi.sourceCompilationArtifact(compilation)).toEqual(before);
  });

  test('exports Arithmetic defaults independently of previous concrete overrides', () => {
    const compilation = compile(`const A = Signal('virtual', 'signal-A');
const amount = Param.number('Amount', 5);
const output = new Network();
output += Arithmetic({ left: amount, operation: 'multiply', right: 2, output: A });`);
    const parameter = sourceApi.listSourceCompilationParameters(compilation)[0]!.parameter;
    sourceApi.bindSourceCompilationParameters(compilation, [{ parameter, value: 17 }]);
    const native = sourceApi.exportSourceCompilationNativeBlueprint(compilation, options);
    expect(native.parameters).toEqual([{ type: 'number', number: '5', name: 'Amount' }]);
    expect(emitNativeBlueprintJson(native).blueprint.entities[0]).toMatchObject({
      control_behavior: { arithmetic_conditions: { first_constant: 5, second_constant: 2 } },
    });
  });

  test.each([
    [
      'symbolic Selector Signal index',
      "Param.signal('Channel', A)",
      "Selector({ input, operation: 'select', index: amount })",
      '$.parameters[0]',
    ],
    [
      'symbolic Selector count output',
      "Param.signal('Channel', A)",
      "Selector({ input, operation: 'count', output: amount })",
      '$.parameters[0]',
    ],
    [
      'unused number',
      "Param.number('Amount', 5)",
      'Constant({ sections: [{ filters: [{ signal: A, value: 3 }] }] })',
      '$.parameters[0]',
    ],
    [
      'above int32',
      "Param.number('Amount', 2147483648)",
      'Constant({ sections: [{ filters: [{ signal: A, value: amount }] }] })',
      '$.parameters[0].defaultValue',
    ],
    [
      'below int32',
      "Param.number('Amount', -2147483649)",
      'Constant({ sections: [{ filters: [{ signal: A, value: amount }] }] })',
      '$.parameters[0].defaultValue',
    ],
    [
      'fractional original',
      "Param.number('Amount', 1.5)",
      'Constant({ sections: [{ filters: [{ signal: A, value: 3 }] }] })',
      '$.parameters[0].defaultValue',
    ],
  ])(
    'rejects %s with a located semantic path while concrete binding still works',
    (_name, declaration, device, path) => {
      const text = `const A = Signal('virtual', 'signal-A');
const amount = ${declaration};
const input = new Network();
const output = new Network();
output += ${device};`;
      const compilation = compile(text);
      const original = structuredClone(sourceApi.sourceCompilationArtifact(compilation));
      const error = exportFailure(compilation);
      expect(error).toMatchObject({ code: 'CP1002', path, span: { fileId: compilation.fileId } });
      expect(error.span!.end).toBeGreaterThan(error.span!.start);
      if (path.startsWith('$.parameters')) {
        expect(error.span).toEqual(
          sourceApi.listSourceCompilationParameters(compilation)[0]!.source,
        );
      } else {
        expect(text.slice(error.span!.start, error.span!.end)).toContain(device);
      }
      expect(sourceApi.bindSourceCompilationParameters(compilation).producers).toHaveLength(1);
      expect(
        sourceApi.bindSourceCompilationCircuit(compilation).resolvedCircuit.ir.producers,
      ).toHaveLength(1);
      expect(sourceApi.sourceCompilationArtifact(compilation)).toEqual(original);
    },
  );

  test.each([
    [
      'AND condition',
      'output += Decider({ condition: (input[A] > amount) && (input[A] < 9), outputs: [input[A]] });',
    ],
    [
      'OR condition',
      'output += Decider({ condition: (input[A] > amount) || (input[A] < 9), outputs: [input[A]] });',
    ],
  ])(
    'exports a count also used in compound %s without changing the owning artifact',
    (_name, extra) => {
      const compilation = compile(`${mixedSource}\n${extra}`);
      const original = structuredClone(sourceApi.sourceCompilationArtifact(compilation));
      const native = sourceApi.exportSourceCompilationNativeBlueprint(compilation, options);
      expect(native.parameters).toEqual([{ type: 'number', number: '5', name: 'Amount' }]);
      expect(native.entities).toEqual(
        buildNativeBlueprintFcir(compilation.resolvedCircuit!.ir, options).entities,
      );
      expect(sourceApi.bindSourceCompilationParameters(compilation).producers).toHaveLength(5);
      expect(sourceApi.sourceCompilationArtifact(compilation)).toEqual(original);
    },
  );

  test('allows plain unparameterized Arithmetic, Decider and Selector beside a marked count', () => {
    const compilation = compile(`${exactSource}
const input = new Network();
output += Arithmetic({ left: input[A], operation: 'add', right: 2, output: A });
output += Decider({ condition: (input[A] > 3) && (input[A] < 9 || input[A] != 0), outputs: [input[A]] });
output += Selector({ input, operation: 'select', index: 1 });`);
    const native = sourceApi.exportSourceCompilationNativeBlueprint(compilation, options);
    expect(native.entities).toHaveLength(4);
    expect(native.parameters).toHaveLength(1);
    expect(native.entities).toEqual(
      buildNativeBlueprintFcir(compilation.resolvedCircuit!.ir, options).entities,
    );
  });

  test.each([false, true])(
    'rejects native multiplier metadata after successful source compilation (count use: %s)',
    (alsoCount) => {
      const text = `const A = Signal('virtual', 'signal-A');
const amount = Param.number('Amount', 1);
const output = new Network();
output += Constant({ sections: [{ multiplier: amount, filters: [{ signal: A, value: ${alsoCount ? 'amount' : '3'} }] }] });`;
      const compilation = compile(text);
      const original = structuredClone(sourceApi.sourceCompilationArtifact(compilation));
      const error = exportFailure(compilation);
      expect(error).toMatchObject({
        code: 'CP1002',
        path: '$.constantTemplates[0].sections[0].multiplier',
        span: expect.objectContaining({
          start: text.indexOf('Constant('),
          end: text.lastIndexOf(';'),
        }),
      });
      expect(error.message).toContain('symbolic multipliers');
      const concrete = generateBlueprintJson(compilation.resolvedCircuit!.ir);
      expect(concrete.blueprint).not.toHaveProperty('parameters');
      expect(concrete.blueprint.entities[0]).toMatchObject({
        control_behavior: {
          sections: { sections: [{ multiplier: 1, filters: [{ count: alsoCount ? 1 : 3 }] }] },
        },
      });
      expect(sourceApi.bindSourceCompilationCircuit(compilation).plan).toEqual(compilation.plan);
      expect(sourceApi.sourceCompilationArtifact(compilation)).toEqual(original);
    },
  );

  test('fractional multiplier declaration retains native original-int32 preflight precedence', () => {
    const compilation = compile(`const scale = Param.number('Scale', 0.5);
const output = new Network();
output += Constant({ sections: [{ multiplier: scale, filters: [] }] });`);
    expect(exportFailure(compilation)).toMatchObject({
      code: 'CP1002',
      path: '$.parameters[0].defaultValue',
      span: sourceApi.listSourceCompilationParameters(compilation)[0]!.source,
    });
    expect(compilation.plan!.producers[0]).toMatchObject({
      configuration: { sections: [{ multiplier: 0.5 }] },
    });
  });

  test('exports a typed Arithmetic formula while preserving its concrete local binding', () => {
    const text = `const A = Signal('virtual', 'signal-A');
const amount = Param.number('Amount', 5, { variable: 'x' });
const output = new Network();
const constantEquivalent = amount * 0;
output += Arithmetic({ left: amount, operation: 'add', right: constantEquivalent, output: A });`;
    const compilation = sourceApi.compileSourceProgram(
      { path: 'native-derived-arithmetic.factorio.ts', text },
      parameterHost(),
    );
    expect(compilation.pipelineDiagnostics).toEqual([]);
    const originalArtifact = structuredClone(sourceApi.sourceCompilationArtifact(compilation));
    const originalPair = sourceApi.bindSourceCompilationCircuit(compilation);
    const originalJson = generateBlueprintJson(originalPair.resolvedCircuit.ir);
    const native = sourceApi.exportSourceCompilationNativeBlueprint(compilation, options);
    expect(native.parameters).toEqual([
      { type: 'number', number: '5', name: 'Amount', variable: 'x' },
      { type: 'number', number: '0', formula: '(x * 0)', dependent: true },
    ]);
    const overridden = sourceApi.bindSourceCompilationCircuit(compilation, [
      { parameter: sourceApi.listSourceCompilationParameters(compilation)[0]!.parameter, value: 9 },
    ]);
    expect(
      generateBlueprintJson(overridden.resolvedCircuit.ir).blueprint.entities.find(
        ({ name }) => name === 'arithmetic-combinator',
      )!.control_behavior,
    ).toMatchObject({ arithmetic_conditions: { second_constant: 0 } });
    expect(generateBlueprintJson(originalPair.resolvedCircuit.ir)).toEqual(originalJson);
    expect(sourceApi.bindSourceCompilationCircuit(compilation)).toEqual(originalPair);
    expect(sourceApi.sourceCompilationArtifact(compilation)).toEqual(originalArtifact);
  });

  test('exports a direct Constant count dependency and its typed expression without changing local binding', () => {
    const key = '__comblang_native_constant_formula_runs';
    const globals = globalThis as Record<string, unknown>;
    const existed = Object.hasOwn(globals, key);
    const previous = globals[key];
    globals[key] = 0;
    try {
      const compilation = compile(`globalThis.${key} += 1;
const amount = Param.number('Amount', 5, { variable: 'x' });
const output = new Network();
output += Constant({ sections: [{ filters: [
  { signal: Signal('virtual', 'signal-A'), value: amount },
  { signal: Signal('virtual', 'signal-B'), value: amount * 2 },
] }] });`);
      const original = structuredClone(sourceApi.sourceCompilationArtifact(compilation));
      const amount = sourceApi.listSourceCompilationParameters(compilation)[0]!.parameter;
      const defaults = sourceApi.bindSourceCompilationCircuit(compilation);
      const overridden = sourceApi.bindSourceCompilationCircuit(compilation, [
        { parameter: amount, value: 9 },
      ]);
      const counts = (pair: typeof defaults) => {
        const behavior = generateBlueprintJson(pair.resolvedCircuit.ir).blueprint.entities[0]!
          .control_behavior as {
          sections: { sections: { filters: { count: number }[] }[] };
        };
        return behavior.sections.sections.flatMap((section) =>
          section.filters.map(({ count }) => count),
        );
      };
      expect(counts(defaults)).toEqual([5, 10]);
      expect(counts(overridden)).toEqual([9, 18]);
      expect(generateBlueprintJson(overridden.resolvedCircuit.ir).blueprint).not.toHaveProperty(
        'parameters',
      );

      const native = sourceApi.exportSourceCompilationNativeBlueprint(compilation, options);
      expect(native.parameters).toEqual([
        { type: 'number', number: '5', name: 'Amount', variable: 'x' },
        { type: 'number', number: '10', formula: '(x * 2)', dependent: true },
      ]);
      expect(emitNativeBlueprintJson(native).blueprint.entities[0]!.control_behavior).toMatchObject(
        {
          sections: {
            sections: [{ filters: [{ count: 5 }, { count: 10 }] }],
          },
        },
      );
      expect(native.entities).toEqual(
        buildNativeBlueprintFcir(compilation.resolvedCircuit!.ir, options).entities,
      );
      expect(sourceApi.exportSourceCompilationNativeBlueprint(compilation, options)).toEqual(
        native,
      );
      expect(globals[key]).toBe(1);
      expect(sourceApi.sourceCompilationArtifact(compilation)).toEqual(original);
    } finally {
      if (existed) globals[key] = previous;
      else delete globals[key];
    }
  });

  test('renders multiple explicit variables and every supported operator without reassociation', () => {
    const compilation = compile(`const amount = Param.number('Amount', 5, { variable: 'x' });
const second = Param.number('Second', 4, { variable: 'y' });
const output = new Network();
output += Constant({ sections: [{ filters: [
  { signal: Signal('virtual', 'signal-A'), value: amount },
  { signal: Signal('virtual', 'signal-B'), value: second },
  { signal: Signal('virtual', 'signal-C'), value: -(amount + second * 2 - 3) },
] }] });`);
    const native = sourceApi.exportSourceCompilationNativeBlueprint(compilation, options);
    expect(native.parameters).toEqual([
      { type: 'number', number: '5', name: 'Amount', variable: 'x' },
      { type: 'number', number: '4', name: 'Second', variable: 'y' },
      { type: 'number', number: '-10', formula: '(-((x + (y * 2)) - 3))', dependent: true },
    ]);
    expect(native.entities[0]!.native.control_behavior).toMatchObject({
      sections: {
        sections: [{ filters: [{ count: 5 }, { count: 4 }, { count: -10 }] }],
      },
    });
  });

  test('retains nested multiplication and addition precedence in a native Constant formula', () => {
    const key = '__comblang_native_constant_nested_formula_runs';
    const globals = globalThis as Record<string, unknown>;
    const existed = Object.hasOwn(globals, key);
    const previous = globals[key];
    globals[key] = 0;
    try {
      const compilation = compile(`globalThis.${key} += 1;
const amount = Param.number('Amount', 5, { variable: 'x' });
const output = new Network();
output += Constant({ sections: [{ filters: [
  { signal: Signal('virtual', 'signal-A'), value: amount },
  { signal: Signal('virtual', 'signal-B'), value: (amount * 2 + 3) * 5 },
] }] });`);
      const amount = sourceApi.listSourceCompilationParameters(compilation)[0]!.parameter;
      const defaults = sourceApi.bindSourceCompilationCircuit(compilation);
      const overridden = sourceApi.bindSourceCompilationCircuit(compilation, [
        { parameter: amount, value: 9 },
      ]);
      const counts = (pair: typeof defaults) => {
        const behavior = generateBlueprintJson(pair.resolvedCircuit.ir).blueprint.entities[0]!
          .control_behavior as {
          sections: { sections: { filters: { count: number }[] }[] };
        };
        return behavior.sections.sections.flatMap((section) =>
          section.filters.map(({ count }) => count),
        );
      };
      expect(counts(defaults)).toEqual([5, 65]);
      expect(counts(overridden)).toEqual([9, 105]);

      const native = sourceApi.exportSourceCompilationNativeBlueprint(compilation, options);
      expect(native.parameters).toEqual([
        { type: 'number', number: '5', name: 'Amount', variable: 'x' },
        {
          type: 'number',
          number: '65',
          formula: '(((x * 2) + 3) * 5)',
          dependent: true,
        },
      ]);
      expect(globals[key]).toBe(1);
    } finally {
      if (existed) globals[key] = previous;
      else delete globals[key];
    }
  });

  test('deduplicates repeated same-default formula rows in first captured occurrence order', () => {
    const compilation = compile(`const amount = Param.number('Amount', 5, { variable: 'x' });
const output = new Network();
for (let index = 0; index < 2; index += 1) {
  output += Constant({ sections: [{ filters: [
    { signal: Signal('virtual', 'signal-A'), value: amount },
    { signal: Signal('virtual', 'signal-B'), value: amount * 2 },
  ] }] });
}`);
    const native = sourceApi.exportSourceCompilationNativeBlueprint(compilation, options);
    expect(native.parameters).toEqual([
      { type: 'number', number: '5', name: 'Amount', variable: 'x' },
      { type: 'number', number: '10', formula: '(x * 2)', dependent: true },
    ]);
    expect(native.entities).toHaveLength(2);
    expect(
      native.entities.map(({ native: entity }) => {
        const behavior = entity.control_behavior as {
          sections: { sections: { filters: { count: number }[] }[] };
        };
        return behavior.sections.sections[0]!.filters.map(({ count }) => count);
      }),
    ).toEqual([
      [5, 10],
      [5, 10],
    ]);
  });

  test('shares numeric formulas across Arithmetic and Constant in deterministic capture order', () => {
    const compilation = compile(`const A = Signal('virtual', 'signal-A');
const B = Signal('virtual', 'signal-B');
const amount = Param.number('Amount', 5, { variable: 'x' });
const factor = Param.number('Factor', 2, { variable: 'y' });
const output = new Network();
output += Arithmetic({ left: amount, operation: 'add', right: (amount * 2 + 3) * 5, output: A });
output += Arithmetic({ left: (amount + factor) * 2, operation: 'multiply', right: factor, output: B });
output += Arithmetic({ left: amount, operation: 'add', right: amount * 2, output: A });
output += Constant({ sections: [{ filters: [
  { signal: A, value: amount },
  { signal: B, value: amount * 2 },
] }] });`);
    const original = structuredClone(sourceApi.sourceCompilationArtifact(compilation));
    const native = sourceApi.exportSourceCompilationNativeBlueprint(compilation, options);
    expect(native.parameters).toEqual([
      { type: 'number', number: '5', name: 'Amount', variable: 'x' },
      { type: 'number', number: '2', name: 'Factor', variable: 'y' },
      { type: 'number', number: '65', formula: '(((x * 2) + 3) * 5)', dependent: true },
      { type: 'number', number: '14', formula: '((x + y) * 2)', dependent: true },
      { type: 'number', number: '10', formula: '(x * 2)', dependent: true },
    ]);
    expect(native.entities).toEqual(
      buildNativeBlueprintFcir(compilation.resolvedCircuit!.ir, options).entities,
    );
    expect(native.wires).toEqual(
      buildNativeBlueprintFcir(compilation.resolvedCircuit!.ir, options).wires,
    );
    const entities = emitNativeBlueprintJson(native).blueprint.entities;
    expect(entities[0]!.control_behavior).toMatchObject({
      arithmetic_conditions: { first_constant: 5, second_constant: 65 },
    });
    expect(entities[1]!.control_behavior).toMatchObject({
      arithmetic_conditions: { first_constant: 14, second_constant: 2 },
    });
    expect(entities[2]!.control_behavior).toMatchObject({
      arithmetic_conditions: { first_constant: 5, second_constant: 10 },
    });
    expect(entities[3]!.control_behavior).toMatchObject({
      sections: { sections: [{ filters: [{ count: 5 }, { count: 10 }] }] },
    });
    expect(sourceApi.sourceCompilationArtifact(compilation)).toEqual(original);
  });

  test('exports divided formula defaults exactly and rejects same-original collisions', () => {
    const compilation = compile(`const A = Signal('virtual', 'signal-A');
const B = Signal('virtual', 'signal-B');
const amount = Param.number('Amount', 10, { variable: 'x' });
const output = new Network();
output += Constant({ sections: [{ filters: [
  { signal: A, value: amount },
  { signal: B, value: (amount / 2) + 3 },
] }] });`);
    const original = structuredClone(sourceApi.sourceCompilationArtifact(compilation));
    const native = sourceApi.exportSourceCompilationNativeBlueprint(compilation, options);
    expect(native.parameters).toEqual([
      { type: 'number', number: '10', name: 'Amount', variable: 'x' },
      { type: 'number', number: '8', formula: '((x / 2) + 3)', dependent: true },
    ]);
    expect(emitNativeBlueprintJson(native).blueprint.entities[0]!.control_behavior).toMatchObject({
      sections: { sections: [{ filters: [{ count: 10 }, { count: 8 }] }] },
    });
    expect(sourceApi.sourceCompilationArtifact(compilation)).toEqual(original);
    const amount = sourceApi.listSourceCompilationParameters(compilation)[0]!.parameter;
    const bound = sourceApi.bindSourceCompilationCircuit(compilation, [
      { parameter: amount, value: 14 },
    ]);
    expect(bound.plan.producers[0]).toMatchObject({
      configuration: { sections: [{ filters: [{ value: 14 }, { value: 10 }] }] },
    });
    expect(generateBlueprintJson(bound.resolvedCircuit.ir).blueprint).not.toHaveProperty(
      'parameters',
    );

    const collision = compile(`const A = Signal('virtual', 'signal-A');
const B = Signal('virtual', 'signal-B');
const C = Signal('virtual', 'signal-C');
const amount = Param.number('Amount', 10, { variable: 'x' });
const output = new Network();
output += Constant({ sections: [{ filters: [
  { signal: A, value: amount },
  { signal: B, value: amount / 2 + 3 },
  { signal: C, value: amount - 2 },
] }] });`);
    expect(exportFailure(collision)).toMatchObject({ code: 'CP1002' });

    const rightSide = compile(`const A = Signal('virtual', 'signal-A');
const B = Signal('virtual', 'signal-B');
const amount = Param.number('Amount', 5, { variable: 'x' });
const output = new Network();
output += Constant({ sections: [{ filters: [
  { signal: A, value: amount },
  { signal: B, value: 20 / amount },
] }] });`);
    const rightSideNative = sourceApi.exportSourceCompilationNativeBlueprint(rightSide, options);
    expect(rightSideNative.parameters).toEqual([
      { type: 'number', number: '5', name: 'Amount', variable: 'x' },
      { type: 'number', number: '4', formula: '(20 / x)', dependent: true },
    ]);
  });

  test('keeps the documented native Arithmetic formula example executable', () => {
    const page = readFileSync(new URL('../../../docs/api/parameters.md', import.meta.url), 'utf8');
    const source = page.match(
      /### Bounded typed native numeric formulas[\s\S]*?```javascript\r?\n([\s\S]*?)\r?\n```/,
    )?.[1];
    expect(source).toBeDefined();
    const compilation = compile(source!);
    const native = sourceApi.exportSourceCompilationNativeBlueprint(compilation, options);
    expect(native.parameters).toEqual([
      { type: 'number', number: '5', name: 'Amount', variable: 'x' },
      { type: 'number', number: '10', formula: '(x * 2)', dependent: true },
      { type: 'number', number: '65', formula: '(((x * 2) + 3) * 5)', dependent: true },
    ]);
    expect(emitNativeBlueprintJson(native).blueprint.entities[0]!.control_behavior).toMatchObject({
      arithmetic_conditions: { first_constant: 5, second_constant: 65 },
    });
  });

  test.each([
    ['left', 'literal'],
    ['right', 'literal'],
    ['left', 'signal'],
    ['right', 'signal'],
  ] as const)(
    'exports an Arithmetic formula on the %s with a parameterless or signal opposite operand (%s)',
    (side, otherKind) => {
      const opposite = otherKind === 'signal' ? 'input[A]' : '7';
      const left = side === 'left' ? 'amount * 2' : opposite;
      const right = side === 'right' ? 'amount * 2' : opposite;
      const compilation = compile(`const A = Signal('virtual', 'signal-A');
const amount = Param.number('Amount', 5, { variable: 'x' });
const input = new Network(), output = new Network();
output += Arithmetic({ left: ${left}, operation: 'add', right: ${right}, output: A });
output += Arithmetic({ left: amount, operation: 'add', right: 1, output: A });`);
      const native = sourceApi.exportSourceCompilationNativeBlueprint(compilation, options);
      expect(native.parameters).toEqual([
        { type: 'number', number: '5', name: 'Amount', variable: 'x' },
        { type: 'number', number: '10', formula: '(x * 2)', dependent: true },
      ]);
      const behavior = emitNativeBlueprintJson(native).blueprint.entities[0]!.control_behavior as {
        arithmetic_conditions: Record<string, unknown>;
      };
      const constantField = side === 'left' ? 'first_constant' : 'second_constant';
      expect(behavior.arithmetic_conditions[constantField]).toBe(10);
      if (otherKind === 'signal') {
        const signalField = side === 'left' ? 'second_signal' : 'first_signal';
        expect(behavior.arithmetic_conditions[signalField]).toMatchObject({ name: 'signal-A' });
      } else {
        const otherConstantField = side === 'left' ? 'second_constant' : 'first_constant';
        expect(behavior.arithmetic_conditions[otherConstantField]).toBe(7);
      }
    },
  );

  test('uses original defaults across rebind, reset and retry without re-executing source', () => {
    const key = '__comblang_native_arithmetic_formula_runs';
    const globals = globalThis as Record<string, unknown>;
    const existed = Object.hasOwn(globals, key);
    const previous = globals[key];
    globals[key] = 0;
    try {
      const compilation = compile(`globalThis.${key} += 1;
const A = Signal('virtual', 'signal-A');
const amount = Param.number('Amount', 5, { variable: 'x' });
const output = new Network();
output += Arithmetic({ left: amount, operation: 'add', right: (amount * 2 + 3) * 5, output: A });`);
      const original = structuredClone(sourceApi.sourceCompilationArtifact(compilation));
      const parameter = sourceApi.listSourceCompilationParameters(compilation)[0]!.parameter;
      const values = (pair: ReturnType<typeof sourceApi.bindSourceCompilationCircuit>) =>
        emitNativeBlueprintJson(buildNativeBlueprintFcir(pair.resolvedCircuit.ir, options))
          .blueprint.entities[0]!.control_behavior;
      const defaults = sourceApi.bindSourceCompilationCircuit(compilation);
      const overridden = sourceApi.bindSourceCompilationCircuit(compilation, [
        { parameter, value: 9 },
      ]);
      const reset = sourceApi.bindSourceCompilationCircuit(compilation);
      expect(values(defaults)).toMatchObject({
        arithmetic_conditions: { first_constant: 5, second_constant: 65 },
      });
      expect(values(overridden)).toMatchObject({
        arithmetic_conditions: { first_constant: 9, second_constant: 105 },
      });
      expect(values(reset)).toMatchObject({
        arithmetic_conditions: { first_constant: 5, second_constant: 65 },
      });
      const first = sourceApi.exportSourceCompilationNativeBlueprint(compilation, options);
      expect(first.parameters).toEqual([
        { type: 'number', number: '5', name: 'Amount', variable: 'x' },
        { type: 'number', number: '65', formula: '(((x * 2) + 3) * 5)', dependent: true },
      ]);
      expect(sourceApi.exportSourceCompilationNativeBlueprint(compilation, options)).toEqual(first);
      expect(globals[key]).toBe(1);
      expect(sourceApi.sourceCompilationArtifact(compilation)).toEqual(original);
    } finally {
      if (existed) globals[key] = previous;
      else delete globals[key];
    }
  });

  test('requires an independent direct physical numeric use for every formula dependency', () => {
    const compilation = compile(`const A = Signal('virtual', 'signal-A');
const amount = Param.number('Amount', 5, { variable: 'x' });
const output = new Network();
output += Arithmetic({ left: amount * 2, operation: 'add', right: 1, output: A });`);
    expect(exportFailure(compilation)).toMatchObject({
      code: 'CP1002',
      path: '$.arithmeticTemplates[0].left.value',
      message: expect.stringContaining('direct Constant count, Arithmetic constant operand'),
    });
  });

  test('allows a direct Selector index to retain an Arithmetic formula dependency', () => {
    const compilation = compile(`const A = Signal('virtual', 'signal-A');
const amount = Param.number('Amount', 5, { variable: 'x' });
const input = new Network(), output = new Network();
output += Arithmetic({ left: amount * 2, operation: 'add', right: 1, output: A });
output += Selector({ input, operation: 'select', index: amount });`);
    const native = sourceApi.exportSourceCompilationNativeBlueprint(compilation, options);
    expect(native.parameters).toEqual([
      { type: 'number', number: '5', name: 'Amount', variable: 'x' },
      { type: 'number', number: '10', formula: '(x * 2)', dependent: true },
    ]);
    expect(native.entities).toHaveLength(2);
    expect(
      emitNativeBlueprintJson(native).blueprint.entities.map(({ control_behavior }) => {
        const behavior = control_behavior as { index_constant?: number } | undefined;
        return behavior?.index_constant;
      }),
    ).toEqual([undefined, 5]);
  });

  test('allows a direct Decider threshold to retain an Arithmetic formula dependency', () => {
    const compilation = compile(`const A = Signal('virtual', 'signal-A');
const amount = Param.number('Amount', 5, { variable: 'x' });
const input = new Network(), output = new Network();
output += Arithmetic({ left: input[A], operation: 'add', right: amount * 2, output: A });
output += Decider({ condition: input[A] > amount, outputs: [input[A]] });`);
    const native = sourceApi.exportSourceCompilationNativeBlueprint(compilation, options);
    expect(native.parameters).toEqual([
      { type: 'number', number: '5', name: 'Amount', variable: 'x' },
      { type: 'number', number: '10', formula: '(x * 2)', dependent: true },
    ]);
    expect(native.entities).toHaveLength(2);
  });

  test('does not retain a formula-only dependency through a Decider expression threshold', () => {
    const compilation = compile(`const A = Signal('virtual', 'signal-A');
const amount = Param.number('Amount', 5, { variable: 'x' });
const input = new Network(), output = new Network();
output += Decider({ condition: input[A] > amount * 2, outputs: [input[A]] });`);
    expect(exportFailure(compilation)).toMatchObject({
      code: 'CP1002',
      path: '$.deciderTemplates[0].condition.right.value',
      message: expect.stringContaining('must also occur as a direct Constant count'),
    });
  });

  test.each([
    {
      name: 'missing explicit variable',
      declaration: "const amount = Param.number('Amount', 5);",
      expression: 'amount + 1',
      expectedPath: '$.parameters[0].metadata.variable',
      expectedMessage: 'require an explicit variable name',
    },
    {
      name: 'evaluated default outside signed int32',
      declaration: "const amount = Param.number('Amount', 2147483647, { variable: 'x' });",
      expression: 'amount + 1',
      expectedPath: '$.deciderTemplates[0].condition.conditions[1].right.value',
      expectedMessage: 'signed int32 integers',
    },
  ])(
    'rejects derived Decider formula: $name',
    ({ declaration, expression, expectedPath, expectedMessage }) => {
      const compilation = compile(`const A = Signal('virtual', 'signal-A');
${declaration}
const input = new Network(), output = new Network();
output += Decider({ condition: input[A] > amount && input[A] < ${expression}, outputs: [input[A]] });`);
      const original = structuredClone(sourceApi.sourceCompilationArtifact(compilation));
      const error = exportFailure(compilation);
      expect(error).toMatchObject({ code: 'CP1002', path: expectedPath });
      expect(error.message).toContain(expectedMessage);
      expect(sourceApi.sourceCompilationArtifact(compilation)).toEqual(original);
    },
  );

  test.each([
    [
      'exact Decider',
      'output += Decider({ condition: input[A] > amount && input[A] < amount + 1, outputs: [input[A]] });',
    ],
    [
      'IF',
      'output += IF(input[A] > amount && input[A] < amount + 1, [input[A]], { fallback: 1 * A });',
    ],
  ])('exports derived thresholds in %s configurations', (_form, configuration) => {
    const compilation = compile(`const A = Signal('virtual', 'signal-A');
const amount = Param.number('Amount', 5, { variable: 'x' });
const input = new Network(), output = new Network();
${configuration}`);
    const native = sourceApi.exportSourceCompilationNativeBlueprint(compilation, options);
    expect(native.parameters).toEqual([
      { type: 'number', number: '5', name: 'Amount', variable: 'x' },
      { type: 'number', number: '6', formula: '(x + 1)', dependent: true },
    ]);
    const rows = (
      emitNativeBlueprintJson(native).blueprint.entities[0]!.control_behavior as {
        decider_conditions: { conditions: { constant: number }[] };
      }
    ).decider_conditions.conditions;
    expect(rows.map(({ constant }) => constant)).toEqual([5, 6]);
    expect(native.entities).toEqual(
      buildNativeBlueprintFcir(compilation.resolvedCircuit!.ir, options).entities,
    );
  });

  test.each([
    ['>', '>'],
    ['<', '<'],
    ['>=', '≥'],
    ['<=', '≤'],
    ['==', '='],
    ['!=', '≠'],
  ] as const)(
    'exports scalar and Each Decider threshold formulas with comparator %s',
    (operator, projectedComparator) => {
      for (const quantifier of ['scalar', 'Each'] as const) {
        const left = quantifier === 'Each' ? 'Each(input)' : 'input[A]';
        const compilation = compile(`const A = Signal('virtual', 'signal-A');
const amount = Param.number('Amount', 5, { variable: 'x' });
const input = new Network(), output = new Network();
output += Decider({ condition: ${left} >= amount && ${left} ${operator} amount + 1, outputs: [input[A]] });`);
        const native = sourceApi.exportSourceCompilationNativeBlueprint(compilation, options);
        expect(native.parameters).toEqual([
          { type: 'number', number: '5', name: 'Amount', variable: 'x' },
          { type: 'number', number: '6', formula: '(x + 1)', dependent: true },
        ]);
        const rows = (
          emitNativeBlueprintJson(native).blueprint.entities[0]!.control_behavior as {
            decider_conditions: {
              conditions: {
                constant: number;
                comparator: string;
                first_signal: { name: string };
              }[];
            };
          }
        ).decider_conditions.conditions;
        expect(rows.map(({ constant }) => constant)).toEqual([5, 6]);
        expect(rows[1]?.comparator).toBe(projectedComparator);
        expect(rows.map(({ first_signal }) => first_signal.name)).toEqual(
          quantifier === 'Each' ? ['signal-each', 'signal-each'] : ['signal-A', 'signal-A'],
        );
        expect(native.entities).toEqual(
          buildNativeBlueprintFcir(compilation.resolvedCircuit!.ir, options).entities,
        );
      }
    },
  );

  test.each([
    {
      name: 'missing explicit variable',
      declaration: "const amount = Param.number('Amount', 5);",
      expression: 'amount * 2',
      expectedPath: '$.parameters[0].metadata.variable',
      expectedMessage: 'require an explicit variable name',
    },
    {
      name: 'dependent formula leaf',
      declaration:
        "const amount = Param.number('Amount', 5, { variable: 'x', formula: '', dependent: true });",
      expression: 'amount * 2',
      expectedPath: '$.parameters[0].metadata',
      expectedMessage: 'direct leaf parameters without formula metadata',
    },
    {
      name: 'formula default outside signed int32',
      declaration: "const amount = Param.number('Amount', 2147483647, { variable: 'x' });",
      expression: 'amount + 1',
      expectedPath: '$.arithmeticTemplates[0].right.value',
      expectedMessage: 'signed int32 integers',
    },
    {
      name: 'raw declared original outside signed int32',
      declaration: "const amount = Param.number('Amount', 2147483648, { variable: 'x' });",
      expression: 'amount * 2',
      expectedPath: '$.parameters[0].defaultValue',
      expectedMessage: 'signed int32 integer',
    },
    {
      name: 'large literal produces a final default outside signed int32',
      declaration: "const amount = Param.number('Amount', 5, { variable: 'x' });",
      expression: 'amount + 2147483648',
      expectedPath: '$.arithmeticTemplates[0].right.value',
      expectedMessage: 'signed int32 integers',
    },
  ])(
    'rejects Arithmetic formula dependency case: $name',
    ({ declaration, expression, expectedPath, expectedMessage }) => {
      const compilation = compile(`const A = Signal('virtual', 'signal-A');
${declaration}
const output = new Network();
output += Arithmetic({ left: amount, operation: 'add', right: ${expression}, output: A });`);
      const error = exportFailure(compilation);
      expect(error).toMatchObject({ code: 'CP1002', path: expectedPath });
      expect(error.message).toContain(expectedMessage);
    },
  );

  test('rejects a derived original collision with a declaration and conflicting formulas atomically', () => {
    const declaredCollision = compile(`const A = Signal('virtual', 'signal-A');
const amount = Param.number('Amount', 5, { variable: 'x' });
const target = Param.number('Target', 10, { variable: 'y' });
const output = new Network();
output += Arithmetic({ left: amount, operation: 'add', right: amount * 2, output: A });
output += Arithmetic({ left: target, operation: 'add', right: 1, output: A });`);
    const declaredCollisionArtifact = structuredClone(
      sourceApi.sourceCompilationArtifact(declaredCollision),
    );
    expect(exportFailure(declaredCollision)).toMatchObject({
      code: 'CP1002',
      path: '$.arithmeticTemplates[0].right.value',
      message: expect.stringContaining('collides with a declared number original'),
    });
    expect(sourceApi.sourceCompilationArtifact(declaredCollision)).toEqual(
      declaredCollisionArtifact,
    );

    const conflicting = compile(`const A = Signal('virtual', 'signal-A');
const amount = Param.number('Amount', 5, { variable: 'x' });
const other = Param.number('Other', 7, { variable: 'y' });
const output = new Network();
output += Arithmetic({ left: amount, operation: 'add', right: amount + 1, output: A });
output += Arithmetic({ left: other, operation: 'add', right: other - 1, output: A });`);
    const conflictingArtifact = structuredClone(sourceApi.sourceCompilationArtifact(conflicting));
    expect(exportFailure(conflicting)).toMatchObject({
      code: 'CP1002',
      path: '$.arithmeticTemplates[1].right.value',
      message: expect.stringContaining('already used by a different formula'),
    });
    expect(sourceApi.sourceCompilationArtifact(conflicting)).toEqual(conflictingArtifact);
  });

  test('allows linked Selector producers in the closed native formula circuit', () => {
    const compilation = compile(`const A = Signal('virtual', 'signal-A');
const amount = Param.number('Amount', 5, { variable: 'x' });
const input = new Network(), output = new Network();
output += Arithmetic({ left: amount, operation: 'add', right: amount * 2, output: A });
output += Selector({ input, operation: 'select', index: amount });`);
    const native = sourceApi.exportSourceCompilationNativeBlueprint(compilation, options);
    expect(native.parameters).toEqual([
      { type: 'number', number: '5', name: 'Amount', variable: 'x' },
      { type: 'number', number: '10', formula: '(x * 2)', dependent: true },
    ]);
    expect(native.entities).toEqual(
      buildNativeBlueprintFcir(compilation.resolvedCircuit!.ir, options).entities,
    );
  });

  test('rejects unlinked physical Entities in Decider formula mode', () => {
    const compilation = compile(`const A = Signal('virtual', 'signal-A');
const amount = Param.number('Amount', 5, { variable: 'x' });
const input = new Network(), output = new Network();
const orphan = Entity('entity:constant-combinator');
void orphan;
output += Decider({ condition: input[A] > amount && input[A] < amount * 2, outputs: [input[A]] });`);
    expect(exportFailure(compilation)).toMatchObject({
      code: 'CP1002',
      path: '$.deciderTemplates[0].condition.conditions[1].right.value',
      message: expect.stringContaining('unlinked physical Entities'),
    });
  });

  test('rejects an unlinked physical Entity in a Constant/Arithmetic formula circuit', () => {
    const compilation = compile(`const A = Signal('virtual', 'signal-A');
const amount = Param.number('Amount', 5, { variable: 'x' });
const output = new Network();
const orphan = Entity('entity:constant-combinator');
void orphan;
output += Arithmetic({ left: amount, operation: 'add', right: amount * 2, output: A });`);
    expect(exportFailure(compilation)).toMatchObject({
      code: 'CP1002',
      path: '$.arithmeticTemplates[0].right.value',
      message: expect.stringContaining('unlinked physical Entities'),
    });
  });

  test.each([
    {
      name: 'missing direct dependency use',
      declarations: `const amount = Param.number('Amount', 5, { variable: 'x' });`,
      filters: `{ signal: Signal('virtual', 'signal-A'), value: amount * 2 }`,
      path: '$.constantTemplates[0].sections[0].filters[0].value',
      message: 'must also occur as a direct Constant count',
    },
    {
      name: 'missing explicit variable',
      declarations: `const amount = Param.number('Amount', 5);`,
      filters: `{ signal: Signal('virtual', 'signal-A'), value: amount },
  { signal: Signal('virtual', 'signal-B'), value: amount * 2 }`,
      path: '$.parameters[0].metadata.variable',
      message: 'require an explicit variable name',
    },
    {
      name: 'reserved builtin variable',
      declarations: `const amount = Param.number('Amount', 5, { variable: 'abs' });`,
      filters: `{ signal: Signal('virtual', 'signal-A'), value: amount },
  { signal: Signal('virtual', 'signal-B'), value: amount * 2 }`,
      path: '$.parameters[0].metadata.variable',
      message: 'non-reserved identifiers',
    },
    {
      name: 'malformed variable identifier',
      declarations: `const amount = Param.number('Amount', 5, { variable: '1bad' });`,
      filters: `{ signal: Signal('virtual', 'signal-A'), value: amount },
  { signal: Signal('virtual', 'signal-B'), value: amount * 2 }`,
      path: '$.parameters[0].metadata.variable',
      message: 'non-reserved identifiers',
    },
    {
      name: 'duplicate typed-mode variables',
      declarations: `const amount = Param.number('Amount', 5, { variable: 'x' });
const other = Param.number('Other', 7, { variable: 'x' });`,
      filters: `{ signal: Signal('virtual', 'signal-A'), value: amount },
  { signal: Signal('virtual', 'signal-B'), value: other },
  { signal: Signal('virtual', 'signal-C'), value: amount + other }`,
      path: '$.parameters[1].metadata.variable',
      message: 'already used by declaration',
    },
    {
      name: 'dependent formula leaf',
      declarations: `const amount = Param.number('Amount', 5, { variable: 'x', formula: '', dependent: true });`,
      filters: `{ signal: Signal('virtual', 'signal-A'), value: amount },
  { signal: Signal('virtual', 'signal-B'), value: amount * 2 }`,
      path: '$.parameters[0].metadata',
      message: 'direct leaf parameters without formula metadata',
    },
    {
      name: 'derived original collides with declared original',
      declarations: `const amount = Param.number('Amount', 5, { variable: 'x' });
const target = Param.number('Target', 10, { variable: 'y' });`,
      filters: `{ signal: Signal('virtual', 'signal-A'), value: amount },
  { signal: Signal('virtual', 'signal-B'), value: target },
  { signal: Signal('virtual', 'signal-C'), value: amount * 2 }`,
      path: '$.constantTemplates[0].sections[0].filters[2].value',
      message: 'collides with a declared number original',
    },
    {
      name: 'equal derived original has a different formula',
      declarations: `const amount = Param.number('Amount', 5, { variable: 'x' });
const other = Param.number('Other', 7, { variable: 'y' });`,
      filters: `{ signal: Signal('virtual', 'signal-A'), value: amount },
  { signal: Signal('virtual', 'signal-B'), value: other },
  { signal: Signal('virtual', 'signal-C'), value: amount + 1 },
  { signal: Signal('virtual', 'signal-D'), value: other - 1 }`,
      path: '$.constantTemplates[0].sections[0].filters[3].value',
      message: 'already used by a different formula',
    },
    {
      name: 'evaluated default is outside int32',
      declarations: `const amount = Param.number('Amount', 2147483647, { variable: 'x' });`,
      filters: `{ signal: Signal('virtual', 'signal-A'), value: amount },
  { signal: Signal('virtual', 'signal-B'), value: amount + 1 }`,
      path: '$.constantTemplates[0].sections[0].filters[1].value',
      message: 'signed int32 integers',
    },
    {
      name: 'large expression literal produces a final default outside int32',
      declarations: `const amount = Param.number('Amount', 5, { variable: 'x' });`,
      filters: `{ signal: Signal('virtual', 'signal-A'), value: amount },
  { signal: Signal('virtual', 'signal-B'), value: amount + 2147483648 }`,
      path: '$.constantTemplates[0].sections[0].filters[1].value',
      message: 'signed int32 integers',
    },
    {
      name: 'reserved recipe reference variable',
      declarations: `const amount = Param.number('Amount', 5, { variable: 'p12_recipe' });`,
      filters: `{ signal: Signal('virtual', 'signal-A'), value: amount },
  { signal: Signal('virtual', 'signal-B'), value: amount * 2 }`,
      path: '$.parameters[0].metadata.variable',
      message: 'non-reserved identifiers',
    },
  ])('rejects typed native formula: $name', ({ declarations, filters, path, message }) => {
    const compilation = compile(`${declarations}
const output = new Network();
output += Constant({ sections: [{ filters: [${filters}] }] });`);
    const original = structuredClone(sourceApi.sourceCompilationArtifact(compilation));
    const error = exportFailure(compilation);
    expect(error).toMatchObject({ code: 'CP1002', path });
    expect(error.message).toContain(message);
    expect(
      sourceApi.exportSourceCompilationNativeBlueprint.bind(null, compilation, options),
    ).toThrow(expect.objectContaining({ code: 'CP1002', path }));
    expect(sourceApi.sourceCompilationArtifact(compilation)).toEqual(original);
  });

  test('allows linked Constant and Arithmetic producers with a typed formula', () => {
    const mixed = compile(`const amount = Param.number('Amount', 5, { variable: 'x' });
const input = new Network(), output = new Network();
output += Constant({ sections: [{ filters: [
  { signal: Signal('virtual', 'signal-A'), value: amount },
  { signal: Signal('virtual', 'signal-B'), value: amount * 2 },
] }] });
output += Arithmetic({ left: input[Signal('virtual', 'signal-A')], operation: 'add', right: 1, output: Signal('virtual', 'signal-B') });`);
    const native = sourceApi.exportSourceCompilationNativeBlueprint(mixed, options);
    expect(native.parameters).toEqual([
      { type: 'number', number: '5', name: 'Amount', variable: 'x' },
      { type: 'number', number: '10', formula: '(x * 2)', dependent: true },
    ]);
    expect(native.entities).toHaveLength(2);
  });

  test('deduplicates shared formulas across Selector, Decider, Arithmetic and Constant in family order', () => {
    const compilation = compile(`const A = Signal('virtual', 'signal-A');
const B = Signal('virtual', 'signal-B');
const C = Signal('virtual', 'signal-C');
const amount = Param.number('Amount', 5, { variable: 'x' });
const input = new Network(), output = new Network();
const selectorInput = new Network();
const directSelectorOutput = new Network(), formulaSelectorOutput = new Network();
const next = amount + 1;
directSelectorOutput += Selector({ input: selectorInput, operation: 'select', index: amount });
formulaSelectorOutput += Selector({ input: selectorInput, operation: 'select', index: next });
output += Constant({ sections: [{ filters: [
  { signal: A, value: amount },
  { signal: B, value: amount * 2 },
  { signal: C, value: amount * 3 },
] }] });
output += Arithmetic({ left: input[A], operation: 'add', right: amount * 2, output: B });
output += Decider({ condition: input[A] > amount && input[A] < amount + 1 && input[A] != amount * 2, outputs: [input[A]] });`);
    const native = sourceApi.exportSourceCompilationNativeBlueprint(compilation, options);
    expect(native.parameters).toEqual([
      { type: 'number', number: '5', name: 'Amount', variable: 'x' },
      { type: 'number', number: '6', formula: '(x + 1)', dependent: true },
      { type: 'number', number: '10', formula: '(x * 2)', dependent: true },
      { type: 'number', number: '15', formula: '(x * 3)', dependent: true },
    ]);
    expect(native.entities).toEqual(
      buildNativeBlueprintFcir(compilation.resolvedCircuit!.ir, options).entities,
    );
    const entities = emitNativeBlueprintJson(native).blueprint.entities;
    expect(entities[0]!.control_behavior).toMatchObject({ operation: 'select', index_constant: 5 });
    expect(entities[1]!.control_behavior).toMatchObject({ operation: 'select', index_constant: 6 });
    expect(entities[2]!.control_behavior).toMatchObject({
      sections: { sections: [{ filters: [{ count: 5 }, { count: 10 }, { count: 15 }] }] },
    });
    expect(entities[3]!.control_behavior).toMatchObject({
      arithmetic_conditions: { second_constant: 10 },
    });
    expect(entities[4]!.control_behavior).toMatchObject({
      decider_conditions: { conditions: [{ constant: 5 }, { constant: 6 }, { constant: 10 }] },
    });
  });

  test('rejects conflicting formula originals across Selector and Arithmetic families', () => {
    const compilation = compile(`const A = Signal('virtual', 'signal-A');
const amount = Param.number('Amount', 5, { variable: 'x' });
const other = Param.number('Other', 7, { variable: 'y' });
const input = new Network(), output = new Network();
const selectorInput = new Network();
const directIndexOutput = new Network(), formulaIndexOutput = new Network();
directIndexOutput += Selector({ input: selectorInput, operation: 'select', index: amount });
formulaIndexOutput += Selector({ input: selectorInput, operation: 'select', index: amount + 1 });
output += Decider({ condition: input[A] > other, outputs: [input[A]] });
output += Arithmetic({ left: input[A], operation: 'add', right: other - 1, output: A });`);
    expect(exportFailure(compilation)).toMatchObject({
      code: 'CP1002',
      path: '$.arithmeticTemplates[0].right.value',
      message: expect.stringContaining('already used by a different formula'),
    });
  });

  test('exports Selector index formulas retained only by direct Selector index use', () => {
    let sourceExecutions = 0;
    const compilation = sourceApi.compileSourceProgram(
      {
        path: 'native-selector-index-formula.factorio.ts',
        text: `const amount = Param.number('Amount', 5, { variable: 'x' });
const next = amount + 1;
const input = new Network();
const directOutput = new Network();
const formulaOutput = new Network();
directOutput += Selector({ input, operation: 'select', index: amount });
formulaOutput += Selector({ input, operation: 'select', index: next });`,
      },
      parameterHost(),
      [],
      (stage) => {
        if (stage === 'execute') sourceExecutions += 1;
      },
    );
    expect(compilation.pipelineDiagnostics).toEqual([]);
    const original = structuredClone(sourceApi.sourceCompilationArtifact(compilation));
    const parameter = sourceApi.listSourceCompilationParameters(compilation)[0]!.parameter;
    const defaults = sourceApi.bindSourceCompilationCircuit(compilation);
    const overridden = sourceApi.bindSourceCompilationCircuit(compilation, [
      { parameter, value: 9 },
    ]);
    const reset = sourceApi.bindSourceCompilationCircuit(compilation, []);
    const native = sourceApi.exportSourceCompilationNativeBlueprint(compilation, options);

    expect(defaults.plan.producers.filter(({ kind }) => kind === 'selector')).toMatchObject([
      { operation: 'select', index: 5 },
      { operation: 'select', index: 6 },
    ]);
    expect(overridden.plan.producers.filter(({ kind }) => kind === 'selector')).toMatchObject([
      { operation: 'select', index: 9 },
      { operation: 'select', index: 10 },
    ]);
    expect(reset).toEqual(defaults);
    expect(native.parameters).toEqual([
      { type: 'number', number: '5', name: 'Amount', variable: 'x' },
      { type: 'number', number: '6', formula: '(x + 1)', dependent: true },
    ]);
    expect(native.entities).toEqual(
      buildNativeBlueprintFcir(compilation.resolvedCircuit!.ir, options).entities,
    );
    expect(
      emitNativeBlueprintJson(native).blueprint.entities.map(({ control_behavior }) => {
        const behavior = control_behavior as
          { operation?: string; index_constant?: number; index_signal?: unknown } | undefined;
        return behavior?.operation === undefined
          ? undefined
          : [behavior.operation, behavior.index_constant, behavior.index_signal];
      }),
    ).toEqual([
      ['select', 5, undefined],
      ['select', 6, undefined],
    ]);
    expect(sourceApi.sourceCompilationArtifact(compilation)).toEqual(original);
    expect(sourceExecutions).toBe(1);
  });

  test.each([
    { original: 5, direct: false, message: 'must also occur as a direct Constant count' },
    { original: 2147483647, direct: true, message: 'signed int32 integers' },
  ])(
    'keeps Selector formula-only retention and native default bounds strict ($original)',
    ({ original, direct, message }) => {
      const compilation =
        compile(`const amount = Param.number('Amount', ${original}, { variable: 'x' });
const input = new Network();
const output = new Network();
${direct ? `output += Selector({ input, operation: 'select', index: amount });\n` : ''}output += Selector({ input, operation: 'select', index: amount + 1 });`);
      const error = exportFailure(compilation);
      expect(error.code).toBe('CP1002');
      expect(error.path).toBe(`$.selectorTemplates[${direct ? 1 : 0}].index`);
      expect(error.message).toContain(message);
    },
  );

  test('exports registered formulas in final fluent Decider thresholds without changing rows', () => {
    const key = '__comblang_native_decider_formula_runs';
    const globals = globalThis as Record<string, unknown>;
    const existed = Object.hasOwn(globals, key);
    const previous = globals[key];
    globals[key] = 0;
    try {
      const compilation = compile(`globalThis.${key} += 1;
const A = Signal('virtual', 'signal-A');
const B = Signal('virtual', 'signal-B');
const amount = Param.number('Amount', 5, { variable: 'x' });
const input = new Network();
const output = new Network();
const gate = when((input[A] >= amount) && ((input[A] > amount * 2 || input[A] == 0) && (input[A] < 10 || input[A] != 1)))
  .at(4, 5, 2)
  .then(input[A]);
output += gate;
gate.else(2 * B);
gate.then(3 * B);
gate.else(4 * B);`);
      const original = structuredClone(sourceApi.sourceCompilationArtifact(compilation));
      const parameter = sourceApi.listSourceCompilationParameters(compilation)[0]!.parameter;
      const defaults = sourceApi.bindSourceCompilationCircuit(compilation);
      const overridden = sourceApi.bindSourceCompilationCircuit(compilation, [
        { parameter, value: 9 },
      ]);
      const reset = sourceApi.bindSourceCompilationCircuit(compilation, []);
      expect(() =>
        sourceApi.bindSourceCompilationCircuit(compilation, [
          { parameter, value: Number.MAX_SAFE_INTEGER },
        ]),
      ).toThrow();
      const beforeLimitedExport = structuredClone(sourceApi.sourceCompilationArtifact(compilation));
      expect(() =>
        sourceApi.exportSourceCompilationNativeBlueprint(compilation, {
          ...options,
          maxDeciderConditionRows: 11,
        }),
      ).toThrow(/limit of 11 rows/);
      expect(sourceApi.sourceCompilationArtifact(compilation)).toEqual(beforeLimitedExport);
      const native = sourceApi.exportSourceCompilationNativeBlueprint(compilation, {
        ...options,
        maxDeciderConditionRows: 12,
      });
      expect(native.parameters).toEqual([
        { type: 'number', number: '5', name: 'Amount', variable: 'x' },
        { type: 'number', number: '10', formula: '(x * 2)', dependent: true },
      ]);
      expect(native.entities).toEqual(
        buildNativeBlueprintFcir(compilation.resolvedCircuit!.ir, options).entities,
      );
      const exportedDecider = emitNativeBlueprintJson(native).blueprint.entities[0]!;
      const conditionRows = (
        exportedDecider.control_behavior as {
          decider_conditions: { conditions: { constant: number; comparator: string }[] };
        }
      ).decider_conditions.conditions;
      expect(conditionRows).toHaveLength(12);
      expect(
        conditionRows.filter(({ constant, comparator }) => constant === 10 && comparator === '>'),
      ).toHaveLength(2);
      expect(
        conditionRows.filter(({ constant, comparator }) => constant === 10 && comparator === '<'),
      ).toHaveLength(2);
      expect(exportedDecider).toMatchObject({
        entity_number: 1,
        position: { x: 4, y: 5 },
        direction: 2,
        control_behavior: {
          decider_conditions: {
            outputs: [
              { copy_count_from_input: true, signal: { name: 'signal-A' } },
              { constant: 3, signal: { name: 'signal-B' } },
            ],
            else_outputs: [
              { constant: 2, signal: { name: 'signal-B' } },
              { constant: 4, signal: { name: 'signal-B' } },
            ],
          },
        },
      });
      const conditionConstants = (pair: typeof defaults) =>
        emitNativeBlueprintJson(buildNativeBlueprintFcir(pair.resolvedCircuit.ir, options))
          .blueprint.entities[0]!.control_behavior as {
          decider_conditions: { conditions: { constant: number }[] };
        };
      const defaultsRows = conditionConstants(defaults).decider_conditions.conditions;
      const overriddenRows = conditionConstants(overridden).decider_conditions.conditions;
      expect(defaultsRows.filter(({ constant }) => constant === 10)).toHaveLength(4);
      expect(overriddenRows.filter(({ constant }) => constant === 18)).toHaveLength(2);
      expect(reset.plan).toEqual(defaults.plan);
      expect(sourceApi.exportSourceCompilationNativeBlueprint(compilation, options)).toEqual(
        native,
      );
      expect(globals[key]).toBe(1);
      expect(sourceApi.sourceCompilationArtifact(compilation)).toEqual(original);
    } finally {
      if (existed) globals[key] = previous;
      else delete globals[key];
    }
  });

  test('rejects an unlinked physical Entity in an otherwise Constant-only formula circuit', () => {
    const compilation = compile(`const amount = Param.number('Amount', 5, { variable: 'x' });
const output = new Network();
const orphan = Entity('entity:constant-combinator');
void orphan;
output += Constant({ sections: [{ filters: [
  { signal: Signal('virtual', 'signal-A'), value: amount },
  { signal: Signal('virtual', 'signal-B'), value: amount * 2 },
] }] });`);
    const error = exportFailure(compilation);
    expect(error).toMatchObject({
      code: 'CP1002',
      path: '$.constantTemplates[0].sections[0].filters[1].value',
    });
    expect(error.message).toContain('unlinked physical Entities');
  });

  test.each([
    [
      'zero-default filter count',
      `const amount = Param.number('Amount', 5);
const output = new Network();
output += Constant({ sections: [{ filters: [{ signal: Signal('virtual', 'signal-A'), value: amount - amount }] }] });`,
      'filter',
    ],
    [
      'reciprocal section multiplier',
      `const scale = Param.number('Scale', 2);
const output = new Network();
output += Constant({ sections: [{ multiplier: scale ** -1, filters: [] }] });`,
      'power-multiplier',
    ],
    [
      'unit-default section multiplier',
      `const scale = Param.number('Scale', 2);
const output = new Network();
output += Constant({ sections: [{ multiplier: scale * 0.5, filters: [] }] });`,
      'multiplier',
    ],
  ])(
    'keeps a derived Constant %s root local and rejects native formula export',
    (_name, body, slot) => {
      const compilation = compile(body);
      const parameter = sourceApi.listSourceCompilationParameters(compilation)[0]!.parameter;
      const bound = sourceApi.bindSourceCompilationCircuit(compilation, [
        { parameter, value: slot === 'filter' ? 9 : 3 },
      ]);
      expect(bound.plan.producers[0]).toMatchObject(
        slot === 'filter'
          ? { configuration: { sections: [{ multiplier: 1, filters: [{ value: 0 }] }] } }
          : {
              configuration: {
                sections: [{ multiplier: slot === 'power-multiplier' ? 1 / 3 : 1.5, filters: [] }],
              },
            },
      );
      expect(exportFailure(compilation)).toMatchObject({
        code: 'CP1002',
        span: expect.objectContaining({ fileId: compilation.fileId }),
      });
    },
  );

  test.each([
    [
      'Decider({ condition: input[A] > amount, outputs: [amount * A] })',
      'RT2027',
      'Numeric expressions accept only finite numbers and owning number parameters.',
    ],
    [
      'Decider({ condition: input[A] > amount, outputs: [input[A]], elseOutputs: [amount * A] })',
      'RT2027',
      'Numeric expressions accept only finite numbers and owning number parameters.',
    ],
  ])(
    'retains real source diagnostics for unreachable numeric use in %s',
    (device, code, message) => {
      const text = `${exactSource}\nconst input = new Network();\noutput += ${device};`;
      const compilation = sourceApi.compileSourceProgram(
        { path: 'unreachable-numeric-slot.factorio.ts', text },
        parameterHost(),
      );
      expect(compilation.pipelineDiagnostics).toEqual([
        expect.objectContaining({
          code,
          message,
          span: expect.objectContaining({ fileId: compilation.fileId }),
        }),
      ]);
      expect(compilation.pipelineDiagnostics[0]!.span!.end).toBeGreaterThan(
        compilation.pipelineDiagnostics[0]!.span!.start,
      );
      expect(compilation.resolvedCircuit).toBeUndefined();
      expect(() => sourceApi.exportSourceCompilationNativeBlueprint(compilation, options)).toThrow(
        TypeError,
      );
    },
  );

  test('binds a derived Decider threshold locally but refuses native-template export', () => {
    const text = `${exactSource}
const input = new Network();
const threshold = amount + 1;
const gate = when(input[A] > threshold).at(4, 5, 2).then(input[A]);
output += gate;
gate.else(1 * A);`;
    const compilation = compile(text);
    const original = structuredClone(sourceApi.sourceCompilationArtifact(compilation));
    const amount = sourceApi.listSourceCompilationParameters(compilation)[0]!.parameter;
    const defaults = sourceApi.bindSourceCompilationCircuit(compilation);
    const overridden = sourceApi.bindSourceCompilationCircuit(compilation, [
      { parameter: amount, value: 9 },
    ]);
    const condition = (pair: typeof defaults) => {
      const decider = pair.plan.producers.find(({ kind }) => kind === 'decider');
      if (decider?.kind !== 'decider') throw new Error('Expected an exact Decider.');
      return decider.condition;
    };

    expect(condition(defaults)).toMatchObject({ kind: 'compare-signal', constant: 6 });
    expect(condition(overridden)).toMatchObject({ kind: 'compare-signal', constant: 10 });
    expect(defaults.plan.producers.find(({ kind }) => kind === 'decider')).toMatchObject({
      outputs: [{ kind: 'signal' }],
      elseOutputs: [{ kind: 'signal-constant', value: 1 }],
    });
    expect(exportFailure(compilation)).toMatchObject({
      code: 'CP1002',
      span: expect.objectContaining({ fileId: compilation.fileId }),
    });
    expect(
      condition(
        sourceApi.bindSourceCompilationCircuit(compilation, [{ parameter: amount, value: 7 }]),
      ),
    ).toMatchObject({ kind: 'compare-signal', constant: 8 });
    expect(sourceApi.sourceCompilationArtifact(compilation)).toEqual(original);
  });

  test('exports direct-number fluent Deciders from their final attached branch configuration', () => {
    const compilation = compile(`const A = Signal('virtual', 'signal-A');
const B = Signal('virtual', 'signal-B');
const amount = Param.number('Amount', 5);
const input = new Network();
const output = new Network();
const gate = when(input[A] > amount).at(4, 5, 2).then(input[A]);
output += gate;
gate.else(2 * B);
gate.then(3 * B);
gate.else(4 * B);`);
    const native = sourceApi.exportSourceCompilationNativeBlueprint(compilation, options);
    expect(native.entities).toHaveLength(1);
    expect(emitNativeBlueprintJson(native).blueprint.entities[0]).toMatchObject({
      position: { x: 4, y: 5 },
      direction: 2,
      control_behavior: {
        decider_conditions: {
          conditions: [{ constant: 5 }],
          outputs: [{ copy_count_from_input: true }, { constant: 3 }],
          else_outputs: [{ constant: 2 }, { constant: 4 }],
        },
      },
    });
  });

  test('does not grant export authority to copied compilations or transport artifacts', () => {
    const compilation = compile(mixedSource);
    expect(() => structuredClone(compilation)).toThrow();
    const { execution, ...cloneable } = compilation;
    for (const copy of [
      { ...compilation },
      structuredClone(cloneable),
      sourceApi.sourceCompilationArtifact(compilation),
      structuredClone(sourceApi.sourceCompilationArtifact(compilation)),
      { ...structuredClone(cloneable), execution: execution! },
      { ...compilation, parameters: sourceApi.listSourceCompilationParameters(compilation) },
    ]) {
      expect(() => sourceApi.exportSourceCompilationNativeBlueprint(copy, options)).toThrow(
        'Compilation has no host-local source parameter declarations.',
      );
    }
    expect(
      sourceApi.exportSourceCompilationNativeBlueprint(compilation, options).parameters,
    ).toHaveLength(1);
  });

  test('keeps two owning compilations independent of concrete overrides and foreign handles', () => {
    const first = compile(mixedSource);
    const second = compile(mixedSource.replace("'Amount', 5", "'Amount', 9"));
    const firstParameter = sourceApi.listSourceCompilationParameters(first)[0]!.parameter;
    const secondParameter = sourceApi.listSourceCompilationParameters(second)[0]!.parameter;
    expect(firstParameter).not.toBe(secondParameter);
    sourceApi.bindSourceCompilationParameters(first, [{ parameter: firstParameter, value: 30 }]);
    sourceApi.bindSourceCompilationParameters(second, [{ parameter: secondParameter, value: 40 }]);
    expect(() =>
      sourceApi.bindSourceCompilationParameters(first, [{ parameter: secondParameter, value: 99 }]),
    ).toThrow('different parameter session');
    expect(sourceApi.exportSourceCompilationNativeBlueprint(first, options).parameters).toEqual([
      { type: 'number', number: '5', name: 'Amount' },
    ]);
    expect(sourceApi.exportSourceCompilationNativeBlueprint(second, options).parameters).toEqual([
      { type: 'number', number: '9', name: 'Amount' },
    ]);
    for (const compilation of [first, second]) {
      const native = sourceApi.exportSourceCompilationNativeBlueprint(compilation, options);
      expect(native.entities).toEqual(
        buildNativeBlueprintFcir(compilation.resolvedCircuit!.ir, options).entities,
      );
      expect(native.wires).toEqual(
        buildNativeBlueprintFcir(compilation.resolvedCircuit!.ir, options).wires,
      );
    }
  });

  test.each([false, true])(
    'exports repeated mixed loop captures without source re-execution or concrete changes (rich sections: %s)',
    (richSections) => {
      const key = '__comblangSourceNativeExportExecutions';
      const globalRecord = globalThis as Record<string, unknown>;
      const had = Object.hasOwn(globalRecord, key);
      const previous = globalRecord[key];
      globalRecord[key] = 0;
      try {
        const compilation = compile(`globalThis.${key} += 1;
const normal = Signal('item', 'iron-plate', 'normal');
const legendary = Signal('item', 'iron-plate', 'legendary');
const amount = Param.number('Amount', 5);
const input = new Network();
const arithmeticOutput = new Network();
const output = new Network();
for (let i = 0; i < 3; i += 1) {
  output += Constant({ isOn: false, sections: [
    { active: true, ${richSections ? "group: 'primary', multiplier: 0.5," : ''} filters: [{ signal: normal, value: amount }, { signal: legendary, value: amount }] },
    { active: false, ${richSections ? "group: 'backup', multiplier: 3," : ''} filters: [{ signal: normal, value: amount }] }
  ] });
  arithmeticOutput += Arithmetic({ left: amount, operation: 'add', right: amount, output: normal }).at(i, 4);
  output += Decider({ condition: input[normal] > amount && (input[normal] < i + 9 || input[normal] != amount), outputs: [input[legendary], 2 * normal], elseOutputs: [3 * legendary] }).at(i, 5);
  output += Selector({ input, operation: 'select', index: amount, selectMax: false }).at(i, 6);
}`);
        const original = structuredClone(sourceApi.sourceCompilationArtifact(compilation));
        const declarations = sourceApi.listSourceCompilationParameters(compilation);
        const parameter = declarations[0]!.parameter;
        const bindings = [{ parameter, value: 13 }];
        const before = sourceApi.bindSourceCompilationCircuit(compilation, bindings);
        const baseline = buildNativeBlueprintFcir(compilation.resolvedCircuit!.ir, options);
        const first = sourceApi.exportSourceCompilationNativeBlueprint(compilation, options);
        const second = sourceApi.exportSourceCompilationNativeBlueprint(compilation, options);
        expect(first).toEqual(second);
        expect(first).not.toBe(second);
        expect(first.parameters).toEqual([{ type: 'number', number: '5', name: 'Amount' }]);
        expect(first.entities).toHaveLength(12);
        expect(first.entities).toEqual(baseline.entities);
        expect(first.wires).toEqual(baseline.wires);
        const json = emitNativeBlueprintJson(first);
        expect(structuredClone(json)).toEqual(json);
        expect(JSON.parse(JSON.stringify(json))).toEqual(json);
        for (const entity of json.blueprint.entities.filter(
          ({ name }) => name === 'constant-combinator',
        )) {
          expect(entity).toMatchObject({
            control_behavior: {
              is_on: false,
              sections: {
                sections: [
                  {
                    active: true,
                    ...(richSections ? { group: 'primary', multiplier: 0.5 } : { multiplier: 1 }),
                    filters: [
                      { name: 'iron-plate', quality: 'normal', count: 5 },
                      { name: 'iron-plate', quality: 'legendary', count: 5 },
                    ],
                  },
                  {
                    active: false,
                    ...(richSections ? { group: 'backup', multiplier: 3 } : { multiplier: 1 }),
                    filters: [{ count: 5 }],
                  },
                ],
              },
            },
          });
        }
        for (let i = 0; i < 3; i += 1) {
          expect(json.blueprint.entities[4 * i + 1]).toMatchObject({
            position: { x: i, y: 4 },
            control_behavior: { arithmetic_conditions: { first_constant: 5, second_constant: 5 } },
          });
          expect(json.blueprint.entities[4 * i + 2]).toMatchObject({
            position: { x: i, y: 5 },
            control_behavior: {
              decider_conditions: {
                conditions: [
                  { constant: 5, compare_type: 'and' },
                  { constant: i + 9, compare_type: 'and' },
                  { constant: 5, compare_type: 'or' },
                  { constant: 5, compare_type: 'and' },
                ],
                outputs: [{ signal: { quality: 'legendary' } }, { constant: 2 }],
                else_outputs: [{ signal: { quality: 'legendary' }, constant: 3 }],
              },
            },
          });
          expect(json.blueprint.entities[4 * i + 3]).toMatchObject({
            position: { x: i, y: 6 },
            control_behavior: { operation: 'select', index_constant: 5, select_max: false },
          });
        }
        const after = sourceApi.bindSourceCompilationCircuit(compilation, bindings);
        expect(after).toEqual(before);
        const defaultsPair = sourceApi.bindSourceCompilationCircuit(compilation);
        const simulateArithmetic = (
          pair: ReturnType<typeof sourceApi.bindSourceCompilationCircuit>,
        ) => {
          const replay = executeResolvedDirectPlan(pair.plan, pair.resolvedCircuit);
          return replay.circuit
            .createSimulation()
            .step()
            .read(replay.network('arithmeticOutput').id)
            .get(signal('item', 'iron-plate', 'normal'));
        };
        if (richSections) {
          expect(() => simulateArithmetic(defaultsPair)).toThrow(
            'Constant configuration is unsupported for evaluation: non-unit-multiplier, group.',
          );
          expect(() => simulateArithmetic(after)).toThrow(
            'Constant configuration is unsupported for evaluation: non-unit-multiplier, group.',
          );
        } else {
          expect(simulateArithmetic(defaultsPair)).toBe(30);
          expect(simulateArithmetic(before)).toBe(78);
          expect(simulateArithmetic(after)).toBe(78);
        }
        const boundNative = buildNativeBlueprintFcir(after.resolvedCircuit.ir, options);
        expect(boundNative.wires).toEqual(first.wires);
        const boundJson = emitNativeBlueprintJson(boundNative);
        expect(boundJson.blueprint.entities[1]).toMatchObject({
          control_behavior: { arithmetic_conditions: { first_constant: 13, second_constant: 13 } },
        });
        expect(boundJson.blueprint.entities[2]).toMatchObject({
          control_behavior: {
            decider_conditions: {
              conditions: [{ constant: 13 }, { constant: 9 }, { constant: 13 }, { constant: 13 }],
            },
          },
        });
        expect(boundJson.blueprint.entities[3]).toMatchObject({
          control_behavior: { index_constant: 13 },
        });
        const overridden = sourceApi.bindSourceCompilationParameters(compilation, [
          { parameter, value: 17 },
        ]);
        expect(overridden.producers.map(({ id }) => id)).toEqual(
          compilation.resolvedCircuit!.ir.producers.map(({ id }) => id),
        );
        expect(overridden.entities.map(({ id }) => id)).toEqual(
          compilation.resolvedCircuit!.ir.entities.map(({ id }) => id),
        );
        expect(overridden.networks).toEqual(compilation.resolvedCircuit!.ir.networks);
        expect(sourceApi.bindSourceCompilationCircuit(compilation).plan).toEqual(compilation.plan);
        expect(sourceApi.sourceCompilationArtifact(compilation)).toEqual(original);
        expect(sourceApi.listSourceCompilationParameters(compilation)).toEqual(declarations);
        expect(globalRecord[key]).toBe(1);
      } finally {
        if (had) globalRecord[key] = previous;
        else delete globalRecord[key];
      }
    },
  );

  test('emits ordinary cloneable JSON without handles, symbols or provenance', () => {
    const json = emitNativeBlueprintJson(
      sourceApi.exportSourceCompilationNativeBlueprint(compile(exactSource), options),
    );
    expect(structuredClone(json)).toEqual(json);
    expect(JSON.parse(JSON.stringify(json))).toEqual(json);
    function assertJson(value: unknown) {
      expect(typeof value).not.toBe('symbol');
      expect(typeof value).not.toBe('function');
      if (value === null || typeof value !== 'object') return;
      expect(Object.getPrototypeOf(value)).toBe(
        Array.isArray(value) ? Array.prototype : Object.prototype,
      );
      expect(Object.getOwnPropertySymbols(value)).toEqual([]);
      expect(value).not.toHaveProperty('captureId');
      expect(value).not.toHaveProperty('source');
      expect(value).not.toHaveProperty('parameter');
      Object.values(value).forEach(assertJson);
    }
    assertJson(json);
  });

  test('preserves exact parameter-free bytes and rejects its lack of captured declarations', () => {
    const compilation = compile(exactSource.replace("Param.number('Amount', 5)", '5'));
    expect(() => sourceApi.exportSourceCompilationNativeBlueprint(compilation, options)).toThrow(
      TypeError,
    );
    expect(JSON.stringify(generateBlueprintJson(compilation.resolvedCircuit!.ir, options))).toBe(
      '{"blueprint":{"item":"blueprint","label":"Source parameter export","version":562949953421312,"icons":[{"signal":{"type":"item","name":"blueprint"},"index":1}],"entities":[{"entity_number":1,"name":"constant-combinator","control_behavior":{"is_on":true,"sections":{"sections":[{"index":1,"active":true,"multiplier":1,"filters":[{"index":1,"type":"virtual","name":"signal-A","quality":"normal","comparator":"=","count":5}]}]}},"position":{"x":0.5,"y":0.5},"direction":4}],"wires":[]}}',
    );
  });
});

import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
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

describe('owning source native numeric parameter export', () => {
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
      'signal declaration',
      "Param.signal('Channel', A)",
      'Constant({ sections: [{ filters: [{ signal: amount, value: 5 }] }] })',
      '$.parameters[0]',
    ],
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
    'retains the existing source rejection of a direct parameter multiplier (count use: %s)',
    (alsoCount) => {
      const text = `const A = Signal('virtual', 'signal-A');
const amount = Param.number('Amount', 5);
const output = new Network();
${alsoCount ? 'output += Constant({ sections: [{ filters: [{ signal: A, value: amount }] }] });' : ''}
output += Constant({ sections: [{ multiplier: amount, filters: [{ signal: A, value: 3 }] }] });`;
      const compilation = sourceApi.compileSourceProgram(
        { path: 'unreachable-parameter-multiplier.factorio.ts', text },
        parameterHost(),
      );
      expect(compilation.pipelineDiagnostics).toEqual([
        expect.objectContaining({
          code: 'RT2027',
          message: '$.configuration.sections[0].multiplier: expected a finite number.',
          span: expect.objectContaining({ start: text.lastIndexOf('Constant(') }),
        }),
      ]);
      expect(compilation.resolvedCircuit).toBeUndefined();
      expect(() => sourceApi.exportSourceCompilationNativeBlueprint(compilation, options)).toThrow(
        TypeError,
      );
      expect(() => sourceApi.bindSourceCompilationParameters(compilation)).toThrow(TypeError);
    },
  );

  test.each([
    [
      'Decider({ condition: input[A] > amount, outputs: [amount * A] })',
      'EX1001',
      'A typed Signal value must use numericCount * Signal.',
    ],
    [
      'Decider({ condition: input[A] > amount, outputs: [input[A]], elseOutputs: [amount * A] })',
      'EX1001',
      'A typed Signal value must use numericCount * Signal.',
    ],
    [
      'Decider({ condition: input[A] > (amount + 1), outputs: [input[A]] })',
      'CP1001',
      '$.parameter: Blueprint parameter handles are symbolic configuration slots and cannot be coerced to JavaScript primitives.',
    ],
    [
      "Selector({ input, operation: 'select', index: amount + 1 })",
      'CP1001',
      '$.parameter: Blueprint parameter handles are symbolic configuration slots and cannot be coerced to JavaScript primitives.',
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

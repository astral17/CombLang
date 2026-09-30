import { describe, expect, test } from 'vitest';
import {
  createTrustedEntityReplayContext,
  generateBlueprintJson,
  syntheticZeroPortEntityProfile,
} from '@comblang/compiler';
import type { EntityProfile } from '@comblang/compiler/entity';
import type { EntityPrototype } from '@comblang/prototypes';
import { emitNativeBlueprintJson } from '../../compiler/src/native-blueprint-emitter.js';
import { buildNativeBlueprintFcir } from '../../compiler/src/native-blueprint-projector.js';
import { BlueprintParameterError } from '../../compiler/src/blueprint-parameters.js';
import { validateNativeBlueprintFcir } from '../../compiler/src/native-blueprint-ir.js';
import * as sourceApi from './source-compilation.js';
import type { EntityPrototypeResolver } from './entity-registry.js';

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

describe('owning source native numeric parameter export', () => {
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

  test.each([
    [
      'signal declaration',
      "Param.signal('Channel', A)",
      'Constant({ sections: [{ filters: [{ signal: amount, value: 5 }] }] })',
      '$.parameters[0]',
    ],
    [
      'unused number',
      "Param.number('Amount', 5)",
      'Constant({ sections: [{ filters: [{ signal: A, value: 3 }] }] })',
      '$.parameters[0]',
    ],
    [
      'Arithmetic',
      "Param.number('Amount', 5)",
      "Arithmetic({ left: input[A], operation: 'add', right: amount, output: A })",
      '$.arithmeticTemplates[0]',
    ],
    [
      'Decider',
      "Param.number('Amount', 5)",
      'Decider({ condition: input[A] > amount, outputs: [input[A]] })',
      '$.deciderTemplates[0]',
    ],
    [
      'Selector',
      "Param.number('Amount', 5)",
      "Selector({ input, operation: 'select', index: amount })",
      '$.selectorTemplates[0]',
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
      'Arithmetic',
      "output += Arithmetic({ left: input[A], operation: 'add', right: amount, output: A });",
      '$.arithmeticTemplates[0]',
    ],
    [
      'Decider',
      'output += Decider({ condition: input[A] > amount, outputs: [input[A]] });',
      '$.deciderTemplates[0]',
    ],
    [
      'Selector',
      "output += Selector({ input, operation: 'select', index: amount });",
      '$.selectorTemplates[0]',
    ],
  ])(
    'rejects a count also used in unsupported %s instead of returning partial metadata',
    (_name, extra, path) => {
      const compilation = compile(`${exactSource}\nconst input = new Network();\n${extra}`);
      const original = structuredClone(sourceApi.sourceCompilationArtifact(compilation));
      expect(exportFailure(compilation)).toMatchObject({ code: 'CP1002', path });
      expect(sourceApi.bindSourceCompilationParameters(compilation).producers).toHaveLength(2);
      expect(sourceApi.sourceCompilationArtifact(compilation)).toEqual(original);
    },
  );

  test('allows plain unparameterized Arithmetic, Decider and Selector beside a marked count', () => {
    const compilation = compile(`${exactSource}
const input = new Network();
output += Arithmetic({ left: input[A], operation: 'add', right: 2, output: A });
output += Decider({ condition: input[A] > 3, outputs: [input[A]] });
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

  test('does not grant export authority to copied compilations or transport artifacts', () => {
    const compilation = compile(exactSource);
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
    const first = compile(exactSource);
    const second = compile(exactSource.replace("'Amount', 5", "'Amount', 9"));
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
  });

  test('exports repeated loop captures without source re-execution or changes to qualities, sections or bindings', () => {
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
const output = new Network();
for (let i = 0; i < 3; i += 1) {
  output += Constant({ isOn: false, sections: [
    { active: true, group: 'primary', multiplier: 0.5, filters: [{ signal: normal, value: amount }, { signal: legendary, value: amount }] },
    { active: false, group: 'backup', multiplier: 3, filters: [{ signal: normal, value: amount }] }
  ] });
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
      expect(first.entities).toHaveLength(3);
      expect(first.entities).toEqual(baseline.entities);
      expect(first.wires).toEqual(baseline.wires);
      for (const entity of emitNativeBlueprintJson(first).blueprint.entities) {
        expect(entity).toMatchObject({
          control_behavior: {
            is_on: false,
            sections: {
              sections: [
                {
                  active: true,
                  group: 'primary',
                  multiplier: 0.5,
                  filters: [
                    { name: 'iron-plate', quality: 'normal', count: 5 },
                    { name: 'iron-plate', quality: 'legendary', count: 5 },
                  ],
                },
                { active: false, group: 'backup', multiplier: 3, filters: [{ count: 5 }] },
              ],
            },
          },
        });
      }
      const after = sourceApi.bindSourceCompilationCircuit(compilation, bindings);
      expect(after).toEqual(before);
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
  });

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

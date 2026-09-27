import { describe, expect, test } from 'vitest';

import {
  createTrustedEntityReplayContext,
  syntheticZeroPortEntityProfile,
} from '@comblang/compiler';
import type { EntityProfile } from '@comblang/compiler/entity';
import type { EntityPrototype } from '@comblang/prototypes';
import { parseFile, reservedDslValueNames, validateDslSemantics } from '@comblang/language';

import {
  bindSourceCompilationParameters,
  compileSourceProgram,
  listSourceCompilationParameters,
  sourceCompilationArtifact,
} from './source-compilation.js';
import type { EntityPrototypeResolver } from './entity-registry.js';
import { transformElaborationModule } from '@comblang/compiler';
import { executeElaborationProgram } from './elaboration-program.js';
import { canonicalDirectPlan } from './canonical-circuit.js';
import { tryElaborateDirectPlan } from './direct-plan.js';

function parameterHost() {
  const families = ['arithmetic-combinator', 'constant-combinator', 'decider-combinator'] as const;
  const profiles = families.map((family, index) => ({
    ...structuredClone(syntheticZeroPortEntityProfile),
    ref: {
      ...syntheticZeroPortEntityProfile.ref,
      prototypeKey: `entity:${family}` as EntityProfile['ref']['prototypeKey'],
      profileId: `profile:source-parameter-${index}` as EntityProfile['ref']['profileId'],
    },
    prototypeType: family,
  }));
  const trustedEntityReplayContext = createTrustedEntityReplayContext({
    database: profiles[0]!.ref.database,
    source: 'synthetic',
    evidenceIdentity: 'source-parameter-test-evidence',
    policyIdentity: 'source-parameter-test-policy',
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

const source = `const A = Signal('virtual', 'signal-A');
const B = Signal('virtual', 'signal-B');
const amount = Param.number('Amount', 5);
const channel = Param.signal('Channel', Signal('virtual', 'signal-C'));
const input = new Network();
const output = new Network();
const arithmetic = Arithmetic({ left: input[A], operation: 'add', right: amount, output: B });
const constant = Constant({ sections: [{ filters: [{ signal: channel, value: amount }] }] });
const decider = Decider({ condition: input[A] > amount, outputs: [input[A]] });
output += arithmetic;
output += constant;
output += decider;`;

describe('ordinary source parameter declarations', () => {
  test('reserves Param and compiles exact supported defaults into a concrete plan', () => {
    const parsed = parseFile({ path: 'source-parameters.factorio.ts', text: source });
    expect(reservedDslValueNames.has('Param')).toBe(true);
    expect(validateDslSemantics(parsed)).toEqual([]);

    const compilation = compileSourceProgram(
      { path: 'source-parameters.factorio.ts', text: source },
      parameterHost(),
    );

    expect(compilation.pipelineDiagnostics).toEqual([]);
    expect(compilation.plan?.producers.map(({ kind }) => kind)).toEqual([
      'arithmetic',
      'constant',
      'decider',
    ]);
    expect(compilation.plan?.entities).toHaveLength(3);
    expect(compilation.plan?.producers.every(({ entityId }) => entityId !== undefined)).toBe(true);
    expect(compilation.resolvedCircuit?.ir.entities).toHaveLength(3);
    expect(JSON.stringify(compilation.plan)).not.toContain('Amount');
    expect(JSON.stringify(compilation.plan)).not.toContain('Channel');
    expect(compilation.plan?.producers.find(({ kind }) => kind === 'constant')).toMatchObject({
      configuration: {
        sections: [{ filters: [{ signal: { type: 'virtual', name: 'signal-C' }, value: 5 }] }],
      },
    });
  });

  test('lists host-local declarations and atomically binds them into a fresh concrete NCIR', () => {
    const compilation = compileSourceProgram(
      { path: 'source-parameters.factorio.ts', text: source },
      parameterHost(),
    );
    const declarations = listSourceCompilationParameters(compilation);

    expect(
      declarations.map(({ kind, label, defaultValue }) => ({ kind, label, defaultValue })),
    ).toEqual([
      { kind: 'number', label: 'Amount', defaultValue: 5 },
      { kind: 'signal', label: 'Channel', defaultValue: { type: 'virtual', name: 'signal-C' } },
    ]);

    const bound = bindSourceCompilationParameters(compilation, [
      { parameter: declarations[0]!.parameter, value: 12 },
      {
        parameter: declarations[1]!.parameter,
        value: { type: 'virtual', name: 'signal-D' },
      },
    ]);

    expect(bound).not.toBe(compilation.execution?.circuit.ir);
    expect(bound.producers.find(({ kind }) => kind === 'arithmetic')).toMatchObject({
      config: { right: { kind: 'constant', value: 12 } },
    });
    expect(bound.producers.find(({ kind }) => kind === 'constant')).toMatchObject({
      config: {
        configuration: {
          sections: [{ filters: [{ signal: { type: 'virtual', name: 'signal-D' }, value: 12 }] }],
        },
      },
    });
    expect(bound.producers.find(({ kind }) => kind === 'decider')).toMatchObject({
      config: {
        condition: {
          kind: 'compare',
          right: { kind: 'constant', value: 12 },
        },
      },
    });
    expect(compilation.execution?.circuit.ir.producers).not.toEqual(bound.producers);
  });

  test('keeps nominal handles, templates and host binding state out of the artifact', () => {
    const compilation = compileSourceProgram(
      { path: 'source-parameters.factorio.ts', text: source },
      parameterHost(),
    );
    const artifact = sourceCompilationArtifact(compilation);

    expect(structuredClone(artifact)).toEqual(artifact);
    expect(artifact).not.toHaveProperty('parameters');
    expect(artifact).not.toHaveProperty('parameterTemplates');
    expect(artifact).not.toHaveProperty('session');
    expect(artifact).not.toHaveProperty('elaborationJavaScript');
    expect(JSON.stringify(artifact)).not.toContain('declareBlueprint');
    expect(artifact.plan?.producers.some(({ kind }) => kind === 'constant')).toBe(true);
    expect('execution' in artifact).toBe(false);
  });

  test('retains parameter-free output and rejects invalid declarations with source spans', () => {
    const parameterFreeSource = {
      path: 'parameter-free.factorio.ts',
      text: "const A = Signal('virtual', 'signal-A'); const output = new Network(); output += CC(2 * A);",
    };
    const parameterFree = compileSourceProgram(parameterFreeSource);
    const ordinarySource = parameterFree.elaborationJavaScript;
    expect(listSourceCompilationParameters(parameterFree)).toEqual([]);
    expect(JSON.stringify(sourceCompilationArtifact(parameterFree))).not.toContain('parameters');
    expect(ordinarySource).not.toContain('declareBlueprint');
    const directPlan = canonicalDirectPlan(
      executeElaborationProgram(transformElaborationModule(parseFile(parameterFreeSource))),
    );
    expect(parameterFree.plan).toEqual(directPlan);
    expect(parameterFree.plan?.producers).toMatchObject([
      {
        kind: 'constant',
        outputs: [{ signal: { type: 'virtual', name: 'signal-A' }, value: 2 }],
      },
    ]);
    expect(parameterFree.resolvedCircuit).toEqual(
      tryElaborateDirectPlan(directPlan).resolvedCircuit,
    );
    const incidentalRuntimeName = compileSourceProgram({
      path: 'incidental-runtime-name.factorio.ts',
      text: 'const declareBlueprintNumberParameter = 5; const output = new Network();',
    });
    expect(listSourceCompilationParameters(incidentalRuntimeName)).toEqual([]);
    expect(sourceCompilationArtifact(incidentalRuntimeName)).toHaveProperty(
      'elaborationJavaScript',
    );

    for (const invalid of [
      `Param.number('missing default');`,
      `Param.number('too many', 1, 2);`,
      `Param.unknown('not supported', 1);`,
      `Param.number('invalid default', NaN);`,
      `Param.number('wrong default kind', '5');`,
      `Param.signal('forged default', { type: 'virtual', name: 'signal-A' });`,
    ]) {
      const compilation = compileSourceProgram({
        path: 'invalid-parameter.factorio.ts',
        text: invalid,
      });
      expect(compilation.pipelineDiagnostics).toEqual([
        expect.objectContaining({
          code: expect.stringMatching(/^(CL1050|CP1000|EX1001)$/),
          severity: 'error',
          span: expect.any(Object),
        }),
      ]);
    }
  });

  test('rejects handles escaping through control flow, coercion, arbitrary calls and wrong slots', () => {
    const unsupported = [
      `const amount = Param.number('Amount', 5); if (amount) {}`,
      `const amount = Param.number('Amount', 5); const gate = !amount; if (gate) {}`,
      `const amount = Param.number('Amount', 5); amount + 1;`,
      `const amount = Param.number('Amount', 5); const record = { [amount]: 1 };`,
      `const amount = Param.number('Amount', 5); for (let index = 0; index < amount; index++) {}`,
      `const amount = Param.number('Amount', 5); Number(amount);`,
      `const amount = Param.number('Amount', 5); Boolean(amount);`,
      `const A = Signal('virtual', 'signal-A'); const input = new Network(); const amount = Param.number('Amount', 5); IF(input[A] > amount, input[A]);`,
      `const A = Signal('virtual', 'signal-A'); const input = new Network(); const amount = Param.number('Amount', 5); when(input[A] > amount).then(input[A]);`,
    ];
    for (const text of unsupported) {
      const compilation = compileSourceProgram({ path: 'parameter-misuse.factorio.ts', text });
      expect(compilation.pipelineDiagnostics).toHaveLength(1);
      if (compilation.pipelineDiagnostics[0]?.span === undefined) {
        throw new Error(`Missing source location for misuse: ${text}`);
      }
      expect(compilation.pipelineDiagnostics[0]).toMatchObject({
        severity: 'error',
        span: expect.any(Object),
      });
    }

    const wrongSlot = `const A = Signal('virtual', 'signal-A');
const channel = Param.signal('Channel', Signal('virtual', 'signal-B'));
const input = new Network();
const sum = Arithmetic({ left: input[A], operation: 'add', right: channel, output: A });`;
    const wrongSlotCompilation = compileSourceProgram(
      { path: 'parameter-wrong-slot.factorio.ts', text: wrongSlot },
      parameterHost(),
    );
    expect(wrongSlotCompilation.pipelineDiagnostics).toEqual([
      expect.objectContaining({ severity: 'error', span: expect.any(Object) }),
    ]);
  });

  test('seals delayed declarations and keeps nominal ownership isolated between compilations', () => {
    const globalKey = '__comblang_source_parameter_delayed_call__';
    const globalRecord = globalThis as Record<string, unknown>;
    const hadPriorValue = Object.hasOwn(globalRecord, globalKey);
    const priorValue = globalRecord[globalKey];
    const text = `const amount = Param.number('Amount', 5);
globalThis.${globalKey} = () => Param.number('Late', 6);`;
    try {
      const first = compileSourceProgram({ path: 'parameter-isolation.factorio.ts', text });
      const second = compileSourceProgram({ path: 'parameter-isolation.factorio.ts', text });
      const firstParameter = listSourceCompilationParameters(first)[0]!.parameter;
      const secondParameter = listSourceCompilationParameters(second)[0]!.parameter;
      expect(firstParameter).not.toBe(secondParameter);
      expect(() =>
        bindSourceCompilationParameters(first, [{ parameter: secondParameter, value: 7 }]),
      ).toThrow('parameter belongs to a different parameter session');
      expect(() => bindSourceCompilationParameters({ ...first }, [])).toThrow(
        'Compilation has no host-local source parameter declarations',
      );

      const delayed = globalRecord[globalKey] as () => unknown;
      expect(() => delayed()).toThrow('elaboration runtime is sealed');
    } finally {
      if (!hadPriorValue) delete globalRecord[globalKey];
      else globalRecord[globalKey] = priorValue;
    }
  });

  test('preserves default binding, topology and physical identities', () => {
    const compilation = compileSourceProgram(
      { path: 'source-parameters.factorio.ts', text: source },
      parameterHost(),
    );
    if (compilation.execution === undefined) throw new Error('Expected a canonical execution.');

    const defaults = bindSourceCompilationParameters(compilation);
    expect(defaults).toEqual(compilation.execution.circuit.ir);
    const overridden = bindSourceCompilationParameters(compilation, [
      { parameter: listSourceCompilationParameters(compilation)[0]!.parameter, value: 12 },
    ]);
    expect(overridden.networks).toEqual(compilation.execution.circuit.ir.networks);
    expect(overridden.entities.map(({ id }) => id)).toEqual(
      compilation.execution.circuit.ir.entities.map(({ id }) => id),
    );
    expect(overridden.producers.map(({ id }) => id)).toEqual(
      compilation.execution.circuit.ir.producers.map(({ id }) => id),
    );
  });

  test('validates malformed, duplicate, foreign and kind-mismatched bindings atomically', () => {
    const first = compileSourceProgram(
      { path: 'source-parameters.factorio.ts', text: source },
      parameterHost(),
    );
    const second = compileSourceProgram(
      { path: 'source-parameters.factorio.ts', text: source },
      parameterHost(),
    );
    const firstParameters = listSourceCompilationParameters(first);
    const secondParameters = listSourceCompilationParameters(second);

    expect(() =>
      bindSourceCompilationParameters(first, [
        { parameter: firstParameters[0]!.parameter, value: 2 },
        { parameter: firstParameters[0]!.parameter, value: 3 },
      ]),
    ).toThrow('duplicate binding');
    expect(() =>
      bindSourceCompilationParameters(first, [
        { parameter: secondParameters[0]!.parameter, value: 2 },
      ]),
    ).toThrow('parameter belongs to a different parameter session');
    expect(() =>
      bindSourceCompilationParameters(first, [
        { parameter: firstParameters[0]!.parameter } as never,
      ]),
    ).toThrow('value is required');

    const before = structuredClone(first.execution?.circuit.ir);
    expect(() =>
      bindSourceCompilationParameters(first, [
        { parameter: firstParameters[0]!.parameter, value: 11 },
        { parameter: firstParameters[1]!.parameter, value: 11 },
      ]),
    ).toThrow();
    expect(first.execution?.circuit.ir).toEqual(before);
  });

  test('records the remaining JavaScript handle-property escape for Sol review', () => {
    const compilation = compileSourceProgram({
      path: 'parameter-property-escape.factorio.ts',
      text: `const amount = Param.number('Amount', 5);
if (amount.defaultValue) {}`,
    });

    // The ordinary source transform cannot distinguish this metadata read from other JS values.
    expect(compilation.pipelineDiagnostics).toEqual([]);
  });
});

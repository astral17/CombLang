import { describe, expect, test } from 'vitest';

import {
  createTrustedEntityReplayContext,
  generateBlueprintJson,
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
import { executeElaborationProgramWithParameters } from './elaboration-program.js';
import { bindCapturedSourceConfigurationTemplates } from './executed-blueprint-configuration-binding.js';
import { canonicalDirectPlan } from './canonical-circuit.js';
import { tryElaborateDirectPlan } from './direct-plan.js';
import { bindExecutedPlanConfigurationSet } from './executed-blueprint-configuration-binding.js';
import { createExecutedProducerCaptureReference } from './executed-blueprint-configuration-binding.js';
import { createBlueprintConfigurationSet } from '../../compiler/src/blueprint-configuration-set.js';
import { createSelectorConfigurationTemplate } from '../../compiler/src/selector-configuration-template.js';
import { createBlueprintParameterSession } from '../../compiler/src/blueprint-parameters.js';
import {
  canonicalBlueprintParameterHandle,
  findBlueprintParameterHandle,
} from '../../compiler/src/blueprint-parameters.js';

function parameterHost() {
  const families = [
    'arithmetic-combinator',
    'constant-combinator',
    'decider-combinator',
    'selector-combinator',
  ] as const;
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

  test('preserves source-view identity through aliases and ordinary containers', () => {
    const compilation = compileSourceProgram(
      {
        path: 'parameter-view-aliases.factorio.ts',
        text: `const amount = Param.number('Amount', 5);
const alias = amount;
const box = { values: [alias] };
const input = new Network();
const output = new Network();
const arithmetic = Arithmetic({
  left: input[Signal('virtual', 'signal-A')],
  operation: 'add',
  right: box.values[0],
  output: Signal('virtual', 'signal-B'),
});
output += arithmetic;`,
      },
      parameterHost(),
    );

    expect(compilation.pipelineDiagnostics).toEqual([]);
    expect(compilation.plan?.producers).toMatchObject([
      { kind: 'arithmetic', right: { kind: 'constant', value: 5 } },
    ]);
    expect(listSourceCompilationParameters(compilation)).toMatchObject([
      { kind: 'number', label: 'Amount', defaultValue: 5 },
    ]);
  });

  test('keeps the escaped source view distinct from the host-listed handle', () => {
    const key = Symbol.for('comblang.test.source-parameter-view');
    const globalRecord = globalThis as Record<PropertyKey, unknown>;
    const hadPriorValue = Object.hasOwn(globalRecord, key);
    const priorValue = globalRecord[key];
    try {
      const compilation = compileSourceProgram(
        {
          path: 'parameter-view-host-boundary.factorio.ts',
          text: `const amount = Param.number('Amount', 5);
globalThis[Symbol.for('comblang.test.source-parameter-view')] = amount;
const input = new Network();
const output = new Network();
const arithmetic = Arithmetic({
  left: input[Signal('virtual', 'signal-A')],
  operation: 'add',
  right: amount,
  output: Signal('virtual', 'signal-B'),
});
output += arithmetic;`,
        },
        parameterHost(),
      );
      const sourceView = globalRecord[key] as object;
      const hostHandle = listSourceCompilationParameters(compilation)[0]!.parameter;

      expect(compilation.pipelineDiagnostics).toEqual([]);
      expect(Object.is(sourceView, hostHandle)).toBe(false);
      expect(canonicalBlueprintParameterHandle(sourceView)).toBe(hostHandle);
      expect(findBlueprintParameterHandle(sourceView)).toMatchObject({
        kind: 'number',
        label: 'Amount',
        defaultValue: 5,
      });
      expect(() => Reflect.ownKeys(sourceView)).toThrowError(
        expect.objectContaining({ code: 'CP1001' }),
      );
      expect(
        bindSourceCompilationParameters(compilation, [
          { parameter: sourceView as never, value: 9 },
        ]).producers.find(({ kind }) => kind === 'arithmetic'),
      ).toMatchObject({ kind: 'arithmetic', config: { right: { kind: 'constant', value: 9 } } });
      const artifact = sourceCompilationArtifact(compilation);
      expect(artifact).not.toHaveProperty('parameters');
      expect(JSON.stringify(artifact.plan)).not.toContain('Amount');
      expect(JSON.stringify(artifact.resolvedCircuit)).not.toContain('Amount');
    } finally {
      if (!hadPriorValue) delete globalRecord[key];
      else globalRecord[key] = priorValue;
    }
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

  test('captures the three exact Selector parameter slots and binds paired NCIR atomically', () => {
    const text = `const numberIndex = Param.number('Index', 2);
const signalIndex = Param.signal('Selected signal', Signal('virtual', 'signal-B'));
const countOutput = Param.signal('Count output', Signal('virtual', 'signal-C'));
const input = new Network();
const secondary = new Network();
const output = new Network();
const byNumber = Selector({ input, operation: 'select', index: numberIndex }).at(2, 3);
const bySignal = Selector({ input: pair(input, secondary), operation: 'select', selectMax: false, index: signalIndex });
const counted = Selector({ input, operation: 'count', output: countOutput });
output += byNumber;
output += bySignal;
output += counted;`;
    const compilation = compileSourceProgram(
      { path: 'source-selector-parameters.factorio.ts', text },
      parameterHost(),
    );

    expect(compilation.pipelineDiagnostics).toEqual([]);
    expect(JSON.stringify(compilation.plan)).not.toMatch(/Index|Selected signal|Count output/);
    expect(compilation.plan?.producers.filter(({ kind }) => kind === 'selector')).toMatchObject([
      { operation: 'select', selectMax: true, index: 2 },
      {
        operation: 'select',
        selectMax: false,
        index: { type: 'virtual', name: 'signal-B' },
      },
      { operation: 'count', output: { type: 'virtual', name: 'signal-C' } },
    ]);
    expect(compilation.resolvedCircuit?.ir.entities).toHaveLength(3);
    expect(
      listSourceCompilationParameters(compilation).map(({ kind, label, defaultValue }) => ({
        kind,
        label,
        defaultValue,
      })),
    ).toEqual([
      { kind: 'number', label: 'Index', defaultValue: 2 },
      {
        kind: 'signal',
        label: 'Selected signal',
        defaultValue: { type: 'virtual', name: 'signal-B' },
      },
      {
        kind: 'signal',
        label: 'Count output',
        defaultValue: { type: 'virtual', name: 'signal-C' },
      },
    ]);

    const declarations = listSourceCompilationParameters(compilation);
    const before = compilation.execution?.circuit.ir;
    const bound = bindSourceCompilationParameters(compilation, [
      { parameter: declarations[0]!.parameter, value: 7 },
      {
        parameter: declarations[1]!.parameter,
        value: { type: 'virtual', name: 'signal-D' },
      },
      {
        parameter: declarations[2]!.parameter,
        value: { type: 'virtual', name: 'signal-E' },
      },
    ]);

    const boundSelectors = bound.producers.filter(({ kind }) => kind === 'selector');
    expect(boundSelectors.map(({ config }) => config)).toMatchObject([
      { operation: 'select', selectMax: true, index: 7 },
      {
        operation: 'select',
        selectMax: false,
        index: { type: 'virtual', name: 'signal-D' },
      },
      { operation: 'count', output: { type: 'virtual', name: 'signal-E' } },
    ]);
    for (const producer of boundSelectors) {
      expect(
        bound.entities.find(({ id }) => id === producer.entityId)?.configuration,
      ).toMatchObject({ mode: 'selector' });
    }
    expect(bound.networks).toEqual(before?.networks);
    expect(bound.entities.map(({ id }) => id)).toEqual(before?.entities.map(({ id }) => id));
    expect(bound.entities.map(({ placement }) => placement)).toEqual(
      before?.entities.map(({ placement }) => placement),
    );
    expect(bound.producers.map(({ id }) => id)).toEqual(before?.producers.map(({ id }) => id));
    expect(compilation.execution?.circuit.ir).toEqual(before);
    const artifact = sourceCompilationArtifact(compilation);
    expect(artifact).not.toHaveProperty('selectorTemplates');
    expect(artifact).not.toHaveProperty('execution');
    expect(artifact).not.toHaveProperty('elaborationJavaScript');
    expect(structuredClone(artifact)).toEqual(artifact);
    expect(JSON.stringify(generateBlueprintJson(bound))).not.toMatch(
      /Index|Selected signal|Count output|BlueprintParameter/,
    );
    expect(() =>
      bindSourceCompilationParameters(compilation, [
        { parameter: declarations[0]!.parameter, value: 1.5 },
      ]),
    ).toThrow();
    expect(() =>
      bindSourceCompilationParameters(compilation, [
        { parameter: declarations[1]!.parameter, value: 7 },
      ]),
    ).toThrow();
    expect(compilation.execution?.circuit.ir).toEqual(before);
  });

  test('rejects missing and duplicate physical Selector capture assignments', () => {
    const compilation = compileSourceProgram(
      {
        path: 'selector-capture-assignment.factorio.ts',
        text: `const index = Param.number('Index', 1);
const input = new Network();
const output = new Network();
const selector = Selector({ input, operation: 'select', index });
output += selector;`,
      },
      parameterHost(),
    );
    const execution = compilation.execution;
    const producer = execution?.circuit.ir.producers.find(({ kind }) => kind === 'selector');
    const planSelector = compilation.plan?.producers.find(({ kind }) => kind === 'selector');
    const captureId = planSelector?.debugCaptureIds?.[0];
    if (execution === undefined || producer?.kind !== 'selector' || captureId === undefined) {
      throw new Error('Expected a captured exact Selector Producer.');
    }
    const session = createBlueprintParameterSession();
    const parameter = session.number('Index', { defaultValue: 0 });
    const template = createSelectorConfigurationTemplate(session, {
      operation: 'select',
      input: producer.config.input,
      selectMax: true,
      index: parameter,
    });
    const capture = createExecutedProducerCaptureReference(execution, captureId);
    const missingSet = createBlueprintConfigurationSet(session, [
      { key: 'selector', kind: 'selector', template },
    ]);
    expect(() => bindExecutedPlanConfigurationSet(execution, missingSet, [])).toThrow(
      'missing Producer capture assignment',
    );

    const duplicateSet = createBlueprintConfigurationSet(session, [
      { key: 'selector-a', kind: 'selector', template },
      { key: 'selector-b', kind: 'selector', template },
    ]);
    expect(() =>
      bindExecutedPlanConfigurationSet(execution, duplicateSet, [
        { key: 'selector-a', captureId: capture },
        { key: 'selector-b', captureId: capture },
      ]),
    ).toThrow('Producer capture');
  });

  test('preserves parameter-free Selector defaults and reports wrong slot kinds at the value span', () => {
    const parameterFreeSource = {
      path: 'parameter-free-selector.factorio.ts',
      text: `const input = new Network();
const output = new Network();
const selected = Selector({ input, operation: 'select' });
output += selected;`,
    };
    const parameterFree = compileSourceProgram(parameterFreeSource, parameterHost());
    const directPlan = canonicalDirectPlan(
      executeElaborationProgram(transformElaborationModule(parseFile(parameterFreeSource)), {
        trustedEntityReplayContext: parameterHost().trustedEntityReplayContext,
        entityPrototypeResolver: parameterHost().entityPrototypeResolver,
      }),
    );
    expect(parameterFree.pipelineDiagnostics).toEqual([]);
    expect(listSourceCompilationParameters(parameterFree)).toEqual([]);
    expect(parameterFree.plan).toEqual(directPlan);
    expect(parameterFree.plan?.producers).toMatchObject([
      { kind: 'selector', operation: 'select', selectMax: true, index: 0 },
    ]);

    const wrongSlotSource = `const numberParameter = Param.number('Not a signal', 4);
const input = new Network();
Selector({ input, operation: 'count', output: numberParameter });`;
    const wrongSlot = compileSourceProgram(
      { path: 'selector-wrong-parameter-kind.factorio.ts', text: wrongSlotSource },
      parameterHost(),
    );
    expect(wrongSlot.pipelineDiagnostics).toEqual([
      expect.objectContaining({
        severity: 'error',
        span: expect.objectContaining({ start: wrongSlotSource.lastIndexOf('numberParameter') }),
      }),
    ]);

    const symbolicMaxSource = `const max = Param.signal('Max', Signal('virtual', 'signal-max'));
const input = new Network();
Selector({ input, operation: 'select', selectMax: max, index: 0 });`;
    const symbolicMax = compileSourceProgram(
      { path: 'selector-symbolic-max.factorio.ts', text: symbolicMaxSource },
      parameterHost(),
    );
    expect(symbolicMax.pipelineDiagnostics).toEqual([
      expect.objectContaining({
        severity: 'error',
        span: expect.objectContaining({ start: symbolicMaxSource.lastIndexOf('max') }),
      }),
    ]);
  });

  test('rejects foreign and forged handles in exact Selector parameter slots', () => {
    const foreignKey = Symbol.for('comblang.test.foreign-selector-parameter');
    const forgedKey = Symbol.for('comblang.test.forged-selector-parameter');
    const globalRecord = globalThis as Record<PropertyKey, unknown>;
    const previous = new Map<PropertyKey, { readonly had: boolean; readonly value: unknown }>([
      [
        foreignKey,
        { had: Object.hasOwn(globalRecord, foreignKey), value: globalRecord[foreignKey] },
      ],
      [forgedKey, { had: Object.hasOwn(globalRecord, forgedKey), value: globalRecord[forgedKey] }],
    ]);
    globalRecord[foreignKey] = createBlueprintParameterSession().number('foreign', {
      defaultValue: 5,
    });
    globalRecord[forgedKey] = { kind: 'number', label: 'forged', defaultValue: 5 };
    try {
      for (const [key, message] of [
        ['comblang.test.foreign-selector-parameter', 'different parameter session'],
        ['comblang.test.forged-selector-parameter', 'unregistered parameter-like object'],
      ] as const) {
        const text = `const local = Param.number('Local', 1);
const input = new Network();
Selector({ input, operation: 'select', index: globalThis[Symbol.for('${key}')] });`;
        const compilation = compileSourceProgram(
          { path: 'selector-foreign-parameter.factorio.ts', text },
          parameterHost(),
        );
        expect(compilation.pipelineDiagnostics).toEqual([
          expect.objectContaining({
            code: 'RT2027',
            message: expect.stringContaining(message),
            span: expect.objectContaining({ start: text.lastIndexOf('globalThis') }),
          }),
        ]);
      }
    } finally {
      for (const [key, value] of previous) {
        if (value.had) globalRecord[key] = value.value;
        else delete globalRecord[key];
      }
    }
  });

  test('captures repeated physical Selectors and rolls back templates with failed instances', () => {
    const environment = parameterHost();
    const source = `const index = Param.number('Index', 1);
const inputA = new Network();
const inputB = new Network();
function Gate(input: Network) {
  const selector = Selector({ input, operation: 'select', index });
  const sink = new Network();
  sink += selector;
  return selector;
}
const first = t.instantiate(Gate, inputA);
const second = t.instantiate(Gate, inputB);
const outputA = new Network();
const outputB = new Network();
outputA += first.value;
outputB += second.value;`;
    const parsed = parseFile({ path: 'selector-capture-rollback.factorio.ts', text: source });
    const program = transformElaborationModule(parsed, { testContextName: 't' });
    const dynamic = executeElaborationProgramWithParameters(program, environment);

    expect(dynamic.plan.producers.filter(({ kind }) => kind === 'selector')).toHaveLength(2);
    expect(dynamic.plan.entities).toHaveLength(2);
    expect(dynamic.selectorTemplates).toHaveLength(2);
    expect(new Set(dynamic.selectorTemplates.map(({ captureId }) => captureId)).size).toBe(2);
    const lowered = tryElaborateDirectPlan(dynamic.plan, environment.trustedEntityReplayContext);
    expect(lowered.diagnostics).toEqual([]);
    const bound = bindCapturedSourceConfigurationTemplates(dynamic, lowered.execution!, [
      { parameter: dynamic.parameters[0]!.handle, value: 8 },
    ]);
    expect(
      bound.producers.filter(({ kind }) => kind === 'selector').map(({ config }) => config),
    ).toMatchObject([
      { operation: 'select', index: 8 },
      { operation: 'select', index: 8 },
    ]);
    const missingCapture = {
      ...dynamic,
      selectorTemplates: dynamic.selectorTemplates.map((entry) => ({
        ...entry,
        captureId: 'missing-selector-capture',
      })),
    };
    expect(() =>
      bindCapturedSourceConfigurationTemplates(missingCapture, lowered.execution!),
    ).toThrow('capture must identify exactly one source Selector Producer');
    const duplicateCapture = {
      ...dynamic,
      selectorTemplates: [...dynamic.selectorTemplates, dynamic.selectorTemplates[0]!],
    };
    expect(() =>
      bindCapturedSourceConfigurationTemplates(duplicateCapture, lowered.execution!),
    ).toThrow('Selector capture IDs must be unique');

    const rollbackSource = `const index = Param.number('Index', 1);
function Broken(input: Network) {
  const selector = Selector({ input, operation: 'select', index });
  const sink = new Network();
  sink += selector;
  const invalid: unknown = 1;
  Selector(invalid);
}
const input = new Network();
try { t.instantiate(Broken, input); } catch {}
const selector = Selector({ input, operation: 'select', index });
const output = new Network();
output += selector;`;
    const rollbackProgram = transformElaborationModule(
      parseFile({ path: 'selector-failed-instance.factorio.ts', text: rollbackSource }),
      { testContextName: 't' },
    );
    const rolledBack = executeElaborationProgramWithParameters(rollbackProgram, environment);
    expect(rolledBack.plan.producers.filter(({ kind }) => kind === 'selector')).toHaveLength(1);
    expect(rolledBack.plan.entities).toHaveLength(1);
    expect(rolledBack.plan.debugInstances).toEqual([]);
    expect(rolledBack.selectorTemplates).toHaveLength(1);
    expect(rolledBack.selectorTemplates[0]?.captureId).toBe(
      rolledBack.plan.producers[0]?.debugCaptureIds?.[0],
    );
  });

  test('binds Selector parameters alongside Arithmetic, Constant, and Decider captures', () => {
    const text = `${source}\nconst selector = Selector({ input, operation: 'select', index: amount });\noutput += selector;`;
    const compilation = compileSourceProgram(
      { path: 'mixed-source-configuration-parameters.factorio.ts', text },
      parameterHost(),
    );
    expect(compilation.pipelineDiagnostics).toEqual([]);
    expect(compilation.plan?.producers.map(({ kind }) => kind)).toEqual([
      'arithmetic',
      'constant',
      'decider',
      'selector',
    ]);

    const declarations = listSourceCompilationParameters(compilation);
    const original = compilation.execution?.circuit.ir;
    const bound = bindSourceCompilationParameters(compilation, [
      { parameter: declarations[0]!.parameter, value: 9 },
      {
        parameter: declarations[1]!.parameter,
        value: { type: 'virtual', name: 'signal-D' },
      },
    ]);
    expect(bound.producers.find(({ kind }) => kind === 'selector')).toMatchObject({
      kind: 'selector',
      config: { operation: 'select', index: 9 },
    });
    expect(bound.networks).toEqual(original?.networks);
    expect(bound.entities.map(({ id }) => id)).toEqual(original?.entities.map(({ id }) => id));
    expect(bound.producers.map(({ id }) => id)).toEqual(original?.producers.map(({ id }) => id));
    expect(compilation.execution?.circuit.ir).toEqual(original);
    const artifact = sourceCompilationArtifact(compilation);
    expect(artifact).not.toHaveProperty('selectorTemplates');
    expect(JSON.stringify(bound)).not.toContain('Amount');
    expect(JSON.stringify(bound)).not.toContain('Selected signal');
  });

  test('rejects source parameter property and reflection escapes while retaining host metadata', () => {
    const reads = [
      'amount.defaultValue;',
      'const alias = amount; alias.label;',
      'amount?.kind;',
      "amount['source'];",
      'const { defaultValue } = amount;',
      "const key = 'label'; amount[key];",
      'Object.keys(amount);',
      'Reflect.ownKeys(amount);',
      "Object.getOwnPropertyDescriptor(amount, 'label');",
      '({ ...amount });',
      'JSON.stringify(amount);',
      'if (amount.defaultValue) {}',
    ];

    for (const read of reads) {
      const text = `const amount = Param.number('Amount', 5);\n${read}`;
      const declarationStart = text.indexOf('Param.number');
      const declarationEnd = text.indexOf(');') + 1;
      const compilation = compileSourceProgram({
        path: 'parameter-property-escape.factorio.ts',
        text,
      });

      expect(compilation.pipelineDiagnostics, read).toHaveLength(1);
      const [diagnostic] = compilation.pipelineDiagnostics;
      expect(diagnostic?.severity).toBe('error');
      expect(['CP1001', 'RT2029']).toContain(diagnostic?.code);
      expect(diagnostic?.span).toBeDefined();
      expect([declarationStart, text.indexOf(read)]).toContain(diagnostic?.span?.start);
    }

    const hostCompilation = compileSourceProgram({
      path: 'parameter-host-metadata.factorio.ts',
      text: `const amount = Param.number('Amount', 5);
const ordinary = { label: 'ordinary' };
ordinary.label;`,
    });
    expect(hostCompilation.pipelineDiagnostics).toEqual([]);
    expect(listSourceCompilationParameters(hostCompilation)).toMatchObject([
      { kind: 'number', label: 'Amount', defaultValue: 5 },
    ]);
  });
});

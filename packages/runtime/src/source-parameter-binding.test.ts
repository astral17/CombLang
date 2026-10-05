import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';

import {
  createTrustedEntityReplayContext,
  generateBlueprintJson,
  syntheticZeroPortEntityProfile,
} from '@comblang/compiler';
import { constantConfigurationLimits, signal } from '@comblang/factorio';
import { parseDiagnosticPolicy } from '@comblang/shared';
import type { EntityProfile } from '@comblang/compiler/entity';
import type { EntityPrototype } from '@comblang/prototypes';
import { BlueprintParameterError } from '../../compiler/src/blueprint-parameters.js';
import {
  compileSourceProgram,
  bindSourceCompilationCircuit,
  listSourceCompilationParameters,
  sourceCompilationArtifact,
} from './source-compilation.js';
import type {
  BoundSourceCompilationCircuit,
  LocalSourceCompilation,
} from './source-compilation.js';
import type { EntityPrototypeResolver } from './entity-registry.js';
import { executeResolvedDirectPlan } from './direct-plan.js';
import { createSourceParameterBindingSession } from '@comblang/runtime/source-parameter-binding';

function parameterHost() {
  const profile: EntityProfile = {
    ...structuredClone(syntheticZeroPortEntityProfile),
    ref: {
      ...syntheticZeroPortEntityProfile.ref,
      prototypeKey: 'entity:constant-combinator' as EntityProfile['ref']['prototypeKey'],
      profileId: 'profile:source-parameter-binding' as EntityProfile['ref']['profileId'],
    },
    prototypeType: 'constant-combinator',
  };
  const trustedEntityReplayContext = createTrustedEntityReplayContext({
    database: profile.ref.database,
    source: 'synthetic',
    evidenceIdentity: 'source-parameter-binding-test-evidence',
    policyIdentity: 'source-parameter-binding-test-policy',
    profiles: [profile],
  });
  const prototype: EntityPrototype = {
    key: 'entity:constant-combinator' as EntityPrototype['key'],
    name: 'constant-combinator',
    type: 'constant-combinator',
    tileWidth: 1,
    tileHeight: 1,
  };
  const entityPrototypeResolver: EntityPrototypeResolver = {
    database: trustedEntityReplayContext.database,
    getEntity(nameOrKey) {
      return nameOrKey === prototype.key || nameOrKey === prototype.name ? prototype : undefined;
    },
  };
  return { trustedEntityReplayContext, entityPrototypeResolver };
}

const runCounterKey = '__comblang_source_parameter_binding_runs';
const source = `globalThis.${runCounterKey} = Number(globalThis.${runCounterKey} ?? 0) + 1;
const amount = Param.number('Amount', 5, { variable: 'x', formula: 'x * 2', dependent: true });
const channel = Param.signal('Channel', Signal('virtual', 'signal-A'));
const output = new Network();
output += Constant({ sections: [{ filters: [{ signal: channel, value: amount }] }] });`;

function compile(text = source): LocalSourceCompilation {
  const compilation = compileSourceProgram(
    { path: 'source-parameter-binding.factorio.ts', text },
    parameterHost(),
  );
  expect(compilation.pipelineDiagnostics.filter(({ severity }) => severity === 'error')).toEqual(
    [],
  );
  expect(compilation.plan).toBeDefined();
  expect(compilation.resolvedCircuit).toBeDefined();
  return compilation;
}

function expectParameterError(action: () => unknown): BlueprintParameterError {
  try {
    action();
  } catch (error) {
    expect(error).toBeInstanceOf(BlueprintParameterError);
    return error as BlueprintParameterError;
  }
  throw new Error('Expected a BlueprintParameterError.');
}

function expectFrozenTree(value: unknown): void {
  if (value === null || typeof value !== 'object') return;
  expect(Object.isFrozen(value)).toBe(true);
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    expect(descriptor && 'value' in descriptor).toBe(true);
    if (descriptor && 'value' in descriptor) expectFrozenTree(descriptor.value);
  }
}

function constantConfiguration(pair: BoundSourceCompilationCircuit) {
  const producer = pair.plan.producers.find(({ kind }) => kind === 'constant');
  if (producer?.kind !== 'constant' || !('configuration' in producer)) {
    throw new Error('Expected an exact Constant producer.');
  }
  return producer.configuration;
}

describe('host-local source parameter binding sessions', () => {
  test('lists detached immutable descriptors only for the owning successful compilation', () => {
    const compilation = compile();
    const session = createSourceParameterBindingSession(compilation);
    expect(session.parameters).toMatchObject([
      {
        id: 0,
        kind: 'number',
        label: 'Amount',
        defaultValue: 5,
        metadata: { variable: 'x', formula: 'x * 2', dependent: true },
      },
      {
        id: 1,
        kind: 'signal',
        label: 'Channel',
        defaultValue: { type: 'virtual', name: 'signal-A' },
      },
    ]);
    expect(Object.keys(session.parameters[0]!)).toEqual([
      'id',
      'kind',
      'label',
      'defaultValue',
      'source',
      'metadata',
    ]);
    expect(structuredClone(session.parameters)).toEqual(session.parameters);
    expectFrozenTree(session.parameters);
    expect(JSON.stringify(session.parameters)).not.toMatch(/handle|capture|execution|template/i);

    const sourceSpan = session.parameters[0]!.source;
    expect(Object.isFrozen(sourceSpan)).toBe(true);
    expect(sourceSpan).not.toBe(listSourceCompilationParameters(compilation)[0]!.source);
    expect(session.parameters[1]!.defaultValue).not.toBe(
      listSourceCompilationParameters(compilation)[1]!.defaultValue,
    );
    expect(() => createSourceParameterBindingSession({ ...compilation })).toThrow(TypeError);
    expect(() =>
      createSourceParameterBindingSession(sourceCompilationArtifact(compilation)),
    ).toThrow(TypeError);
    expect(() =>
      createSourceParameterBindingSession(structuredClone(sourceCompilationArtifact(compilation))),
    ).toThrow(TypeError);

    const unparameterized = compile(`const output = new Network();`);
    expect(() => createSourceParameterBindingSession(unparameterized)).toThrow(TypeError);
    const failed = compileSourceProgram(
      {
        path: 'source-parameter-binding-error.factorio.ts',
        text: `const amount = Param.number('Amount', 5);\nConstant({ invalid: true });`,
      },
      parameterHost(),
    );
    expect(failed.pipelineDiagnostics.some(({ severity }) => severity === 'error')).toBe(true);
    expect(() => createSourceParameterBindingSession(failed)).toThrow(TypeError);
    const policyError = compileSourceProgram(
      {
        path: 'source-parameter-binding-policy.factorio.ts',
        text: `const amount = Param.number('Amount', 5);
Constant({ sections: [{ filters: [{ signal: Signal('virtual', 'signal-A'), value: amount }] }] });`,
      },
      {
        ...parameterHost(),
        diagnosticPolicy: parseDiagnosticPolicy({
          rules: { 'producer.unused-output': { severity: 'error' } },
        }),
      },
    );
    expect(policyError.plan).toBeDefined();
    expect(policyError.pipelineDiagnostics).toContainEqual(
      expect.objectContaining({ code: 'CL2001', severity: 'error' }),
    );
    expect(() => createSourceParameterBindingSession(policyError)).toThrow(TypeError);
  });

  test('binds fresh snapshots, resets to defaults, and preserves strict paired replay without rerunning source', () => {
    const globals = globalThis as Record<string, unknown>;
    const had = Object.hasOwn(globals, runCounterKey);
    const before = globals[runCounterKey];
    globals[runCounterKey] = 0;
    try {
      const compilation = compile();
      const artifact = structuredClone(sourceCompilationArtifact(compilation));
      const session = createSourceParameterBindingSession(compilation);
      const defaults = session.bind();
      const replayDefaults = executeResolvedDirectPlan(defaults.plan, defaults.resolvedCircuit);
      expect(
        replayDefaults.circuit
          .createSimulation()
          .step()
          .read(replayDefaults.network('output').id)
          .get(signal('virtual', 'signal-A')),
      ).toBe(5);

      const firstSnapshot = session.bind([
        { id: 0, value: 8 },
        { id: 1, value: signal('virtual', 'signal-C') },
      ]);
      expect(firstSnapshot.resolvedCircuit.ir.entities[0]!.configuration).toMatchObject({
        mode: 'constant',
        value: { sections: [{ filters: [{ signal: { name: 'signal-C' }, value: 8 }] }] },
      });
      const invalidSnapshot = expectParameterError(() =>
        session.bind([
          { id: 0, value: 9 },
          { id: 1, value: 'signal-invalid' },
        ]),
      );
      expect(invalidSnapshot).toMatchObject({
        code: 'CP1000',
        path: '$.overrides[1].value',
        span: session.parameters[1]!.source,
      });
      expect(firstSnapshot.resolvedCircuit.ir.entities[0]!.configuration).toMatchObject({
        mode: 'constant',
        value: { sections: [{ filters: [{ signal: { name: 'signal-C' }, value: 8 }] }] },
      });

      const replacementSignal = { type: 'virtual', name: 'signal-B', quality: 'excellent' };
      const overridden = session.bind([
        Object.assign(Object.create(null), { id: 0, value: 11 }),
        { id: 1, value: replacementSignal },
      ]);
      replacementSignal.name = 'signal-mutated-after-bind';
      const replay = executeResolvedDirectPlan(overridden.plan, overridden.resolvedCircuit);
      expect(
        replay.circuit
          .createSimulation()
          .step()
          .read(replay.network('output').id)
          .get(signal('virtual', 'signal-B', 'excellent')),
      ).toBe(11);
      expect(overridden.resolvedCircuit.ir.entities[0]!.configuration).toMatchObject({
        mode: 'constant',
        value: {
          sections: [
            {
              filters: [
                { signal: { type: 'virtual', name: 'signal-B', quality: 'excellent' }, value: 11 },
              ],
            },
          ],
        },
      });
      const blueprintJson = generateBlueprintJson(overridden.resolvedCircuit.ir);
      expect(blueprintJson.blueprint.entities[0]?.control_behavior).toMatchObject({
        sections: { sections: [{ filters: [{ count: 11 }] }] },
      });

      const listed = listSourceCompilationParameters(compilation);
      const existingBinderPair = bindSourceCompilationCircuit(compilation, [
        { parameter: listed[0]!.parameter, value: 11 },
        { parameter: listed[1]!.parameter, value: signal('virtual', 'signal-B', 'excellent') },
      ]);
      expect(overridden).toEqual(existingBinderPair);
      const defaultJson = generateBlueprintJson(defaults.resolvedCircuit.ir);
      const overrideJson = generateBlueprintJson(overridden.resolvedCircuit.ir);
      expect(overrideJson.blueprint.wires).toEqual(defaultJson.blueprint.wires);
      expect(overrideJson.blueprint.entities[0]?.entity_number).toBe(
        defaultJson.blueprint.entities[0]?.entity_number,
      );
      expect(overridden.plan.networks).toEqual(defaults.plan.networks);
      expect(overridden.resolvedCircuit.ir.networks).toEqual(defaults.resolvedCircuit.ir.networks);
      expect(overridden.resolvedCircuit.ir.producers.map(({ id }) => id)).toEqual(
        defaults.resolvedCircuit.ir.producers.map(({ id }) => id),
      );
      expect(overridden.resolvedCircuit.ir.entities.map(({ id }) => id)).toEqual(
        defaults.resolvedCircuit.ir.entities.map(({ id }) => id),
      );
      expect(() => executeResolvedDirectPlan(defaults.plan, overridden.resolvedCircuit)).toThrow();
      expect(
        session.bind([{ id: 1, value: signal('virtual', 'signal-C') }]).resolvedCircuit.ir
          .entities[0]?.configuration,
      ).toMatchObject({
        mode: 'constant',
        value: {
          sections: [{ filters: [{ signal: { type: 'virtual', name: 'signal-C' }, value: 5 }] }],
        },
      });
      expect(session.bind([])).toEqual(defaults);
      expect(session.bind(undefined)).toEqual(defaults);
      expect(session.bind([{ id: 0, value: 11 }])).not.toEqual(overridden);
      expect(globals[runCounterKey]).toBe(1);
      expect(sourceCompilationArtifact(compilation)).toEqual(artifact);
    } finally {
      if (had) globals[runCounterKey] = before;
      else delete globals[runCounterKey];
    }
  });

  test('validates override records, IDs and values with exact paths and declaration spans', () => {
    const session = createSourceParameterBindingSession(compile());
    const amountSpan = session.parameters[0]!.source;
    const channelSpan = session.parameters[1]!.source;

    for (const invalid of [null, {}, '[]']) {
      const error = expectParameterError(() => session.bind(invalid));
      expect(error).toMatchObject({ code: 'CP1000', path: '$.overrides' });
    }
    for (const invalidId of [-1, 1.5, Number.MAX_SAFE_INTEGER, '0']) {
      const error = expectParameterError(() => session.bind([{ id: invalidId, value: 9 }]));
      expect(error).toMatchObject({ code: 'CP1000', path: '$.overrides[0].id' });
      expect(error.span).toBeUndefined();
    }
    const unknown = expectParameterError(() => session.bind([{ id: 99, value: 9 }]));
    expect(unknown).toMatchObject({ code: 'CP1000', path: '$.overrides[0].id' });
    expect(unknown.span).toBeUndefined();
    const duplicate = expectParameterError(() =>
      session.bind([
        { id: 0, value: 8 },
        { id: 0, value: 9 },
      ]),
    );
    expect(duplicate).toMatchObject({
      code: 'CP1000',
      path: '$.overrides[1].id',
      span: amountSpan,
    });

    let coercions = 0;
    const coercible = {
      valueOf() {
        coercions += 1;
        return 6;
      },
      [Symbol.toPrimitive]() {
        coercions += 1;
        return 6;
      },
    };
    for (const value of [undefined, '5', Infinity, NaN, coercible]) {
      const error = expectParameterError(() => session.bind([{ id: 0, value }]));
      expect(error).toMatchObject({
        code: 'CP1000',
        path: '$.overrides[0].value',
        span: amountSpan,
      });
    }
    expect(coercions).toBe(0);
    for (const value of [undefined, 'signal-A']) {
      const error = expectParameterError(() => session.bind([{ id: 1, value }]));
      expect(error).toMatchObject({
        code: 'CP1000',
        path: '$.overrides[0].value',
        span: channelSpan,
      });
    }

    let getterCalls = 0;
    const accessor = Object.defineProperty({ id: 0 }, 'value', {
      enumerable: true,
      get() {
        getterCalls += 1;
        return 7;
      },
    });
    expectParameterError(() => session.bind([accessor]));
    const signalAccessor = Object.defineProperty({}, 'type', {
      enumerable: true,
      get() {
        getterCalls += 1;
        return 'virtual';
      },
    });
    const signalError = expectParameterError(() =>
      session.bind([{ id: 1, value: signalAccessor }]),
    );
    expect(signalError).toMatchObject({
      code: 'CP1000',
      path: '$.overrides[0].value.type',
      span: channelSpan,
    });
    expect(getterCalls).toBe(0);

    const extra = expectParameterError(() => session.bind([{ id: 0, value: 6, extra: true }]));
    expect(extra).toMatchObject({ code: 'CP1000', path: '$.overrides[0].extra' });
    const missing = expectParameterError(() => session.bind([{ id: 0 }]));
    expect(missing).toMatchObject({
      code: 'CP1000',
      path: '$.overrides[0].value',
      span: amountSpan,
    });
    expectParameterError(() => session.bind(Array(constantConfigurationLimits.maxNodes + 1)));
    expect(expectParameterError(() => session.bind(Array(1)))).toMatchObject({
      code: 'CP1000',
      path: '$.overrides[0]',
    });
    expect(expectParameterError(() => session.bind([{ value: 5 }]))).toMatchObject({
      code: 'CP1000',
      path: '$.overrides[0].id',
    });
    const symbolField = { id: 0, value: 5, [Symbol('extra')]: true };
    expect(expectParameterError(() => session.bind([symbolField]))).toMatchObject({
      code: 'CP1000',
      path: '$.overrides[0]',
    });
  });

  test('delegates slot-domain validation to the existing binder and allows unused declarations', () => {
    const shared = compile(`const amount = Param.number('Amount', 2);
const A = Signal('virtual', 'signal-A');
const output = new Network();
output += Constant({ sections: [{ multiplier: amount, filters: [{ signal: A, value: amount }] }] });`);
    const session = createSourceParameterBindingSession(shared);
    let failure: unknown;
    try {
      session.bind([{ id: 0, value: 0.5 }]);
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({ code: 'CP1000', span: session.parameters[0]!.source });
    expect((failure as BlueprintParameterError).path).toContain('filters[0].value');

    const large = session.bind([{ id: 0, value: 2147483648 }]);
    expect(constantConfiguration(large)).toMatchObject({
      sections: [{ multiplier: 2147483648, filters: [{ value: -2147483648 }] }],
    });

    const multiplierOnly = compile(`const scale = Param.number('Scale', 1);
const output = new Network();
output += Constant({ sections: [{ multiplier: scale, filters: [{ signal: Signal('virtual', 'signal-A'), value: 1 }] }] });`);
    const multiplierPair = createSourceParameterBindingSession(multiplierOnly).bind([
      { id: 0, value: 0.5 },
    ]);
    expect(constantConfiguration(multiplierPair).sections[0]!.multiplier).toBe(0.5);

    const unusedCompilation = compile(`const unused = Param.number('Unused', 3);
const output = new Network();
output += Constant({ sections: [{ filters: [{ signal: Signal('virtual', 'signal-A'), value: 2 }] }] });`);
    const unusedSession = createSourceParameterBindingSession(unusedCompilation);
    const unusedPair = unusedSession.bind();
    expect(unusedPair.plan.producers).toHaveLength(1);
    expect(unusedPair.plan.entities).toHaveLength(1);
    expect(unusedPair.plan.entities).toEqual(unusedCompilation.plan!.entities);
    expect(unusedPair.resolvedCircuit.ir.entities).toEqual(
      unusedCompilation.resolvedCircuit!.ir.entities,
    );
    expect(expectParameterError(() => unusedSession.bind([{ id: 0, value: 9 }]))).toMatchObject({
      code: 'CP1001',
      path: '$.bindings',
      message: expect.stringContaining('not used by this configuration set'),
    });
    expect(unusedSession.bind()).toEqual(unusedPair);
  });

  test('keeps identical declarations independently addressable and executes the documented host example', () => {
    const duplicateCompilation = compile(`const first = Param.number('Same', 5);
const second = Param.number('Same', 5);
const A = Signal('virtual', 'signal-A');
const B = Signal('virtual', 'signal-B');
const output = new Network();
output += Constant({ sections: [{ filters: [{ signal: A, value: first }, { signal: B, value: second }] }] });`);
    const session = createSourceParameterBindingSession(duplicateCompilation);
    expect(
      session.parameters.map(({ id, label, defaultValue }) => ({ id, label, defaultValue })),
    ).toEqual([
      { id: 0, label: 'Same', defaultValue: 5 },
      { id: 1, label: 'Same', defaultValue: 5 },
    ]);
    const secondOnly = session.bind([{ id: 1, value: 9 }]);
    expect(constantConfiguration(secondOnly)).toMatchObject({
      sections: [{ filters: [{ value: 5 }, { value: 9 }] }],
    });
    const firstOnly = session.bind([{ id: 0, value: 9 }]);
    expect(constantConfiguration(firstOnly)).toMatchObject({
      sections: [{ filters: [{ value: 9 }, { value: 5 }] }],
    });

    const page = readFileSync(
      new URL('../../../docs/native-objects-deciders-and-parameters.md', import.meta.url),
      'utf8',
    );
    const snippet = page.match(
      /### Descriptor-based local binding[\s\S]*?```ts\r?\n([\s\S]*?)```/,
    )?.[1];
    expect(snippet).toBeDefined();
    const compilation = compile();
    const bound = Function(
      'compilation',
      'createSourceParameterBindingSession',
      'executeResolvedDirectPlan',
      `${snippet}\nreturn bound;`,
    )(compilation, createSourceParameterBindingSession, executeResolvedDirectPlan);
    expect(bound).toMatchObject({ plan: expect.any(Object), resolvedCircuit: expect.any(Object) });
  });
});

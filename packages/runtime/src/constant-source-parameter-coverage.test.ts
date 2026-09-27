import {
  generateBlueprintJson,
  createTrustedEntityReplayContext,
  syntheticZeroPortEntityProfile,
  transformElaborationModule,
} from '@comblang/compiler';
import type { EntityProfile } from '@comblang/compiler/entity';
import { signal } from '@comblang/factorio';
import { parseFile, validateDslSemantics } from '@comblang/language';
import type { EntityPrototype } from '@comblang/prototypes';
import { sourceFileId } from '@comblang/shared';
import { describe, expect, test } from 'vitest';
import { inspectConstantConfigurationTemplate } from '../../compiler/src/constant-configuration-template.js';
import { createBlueprintParameterSession } from '../../compiler/src/blueprint-parameters.js';
import {
  ConstantConfigurationSourceError,
  normalizeConstantConfigurationSourceWithParameters,
} from './constant-configuration-source.js';
import { bindCapturedSourceConfigurationTemplates } from './executed-blueprint-configuration-binding.js';
import { tryElaborateDirectPlan } from './direct-plan.js';
import { executeElaborationProgramWithParameters } from './elaboration-program.js';

const sourceFile = sourceFileId('constant-source-parameter-coverage.ts');

function environment() {
  const constantProfile: EntityProfile = {
    ...structuredClone(syntheticZeroPortEntityProfile),
    ref: {
      ...syntheticZeroPortEntityProfile.ref,
      prototypeKey: 'entity:constant-combinator' as EntityProfile['ref']['prototypeKey'],
      profileId: 'profile:constant-parameter-canonical' as EntityProfile['ref']['profileId'],
    },
    prototypeType: 'constant-combinator',
  };
  const arithmeticProfile: EntityProfile = {
    ...structuredClone(syntheticZeroPortEntityProfile),
    ref: {
      ...syntheticZeroPortEntityProfile.ref,
      prototypeKey: 'entity:arithmetic-combinator' as EntityProfile['ref']['prototypeKey'],
      profileId: 'profile:arithmetic-parameter-canonical' as EntityProfile['ref']['profileId'],
    },
    prototypeType: 'arithmetic-combinator',
  };
  const profiles = [constantProfile, arithmeticProfile];
  const context = createTrustedEntityReplayContext({
    database: constantProfile.ref.database,
    source: 'synthetic',
    evidenceIdentity: 'constant-source-parameter-evidence',
    policyIdentity: 'constant-source-parameter-policy',
    profiles,
  });
  const prototypes: readonly EntityPrototype[] = [
    {
      key: constantProfile.ref.prototypeKey as EntityPrototype['key'],
      name: 'constant-combinator',
      type: 'constant-combinator',
      tileWidth: 1,
      tileHeight: 1,
    },
    {
      key: arithmeticProfile.ref.prototypeKey as EntityPrototype['key'],
      name: 'arithmetic-combinator',
      type: 'arithmetic-combinator',
      tileWidth: 1,
      tileHeight: 1,
    },
  ];
  return {
    trustedEntityReplayContext: context,
    entityPrototypeResolver: {
      database: context.database,
      getEntity(nameOrKey: string): EntityPrototype | undefined {
        return prototypes.find(
          (prototype) => nameOrKey === prototype.key || nameOrKey === prototype.name,
        );
      },
    },
  };
}

function execute(
  text: string,
  declarations?: (runtime: string) => string,
  testContextName?: string,
) {
  const parsed = parseFile({ path: sourceFile, text });
  expect(validateDslSemantics(parsed)).toEqual([]);
  const transformed =
    testContextName === undefined
      ? transformElaborationModule(parsed)
      : transformElaborationModule(parsed, { testContextName });
  const code =
    declarations === undefined
      ? transformed.code
      : `${declarations(transformed.runtimeParameter)}\n${transformed.code}`;
  return executeElaborationProgramWithParameters({ ...transformed, code }, environment());
}

describe('exact Constant source parameter capture', () => {
  test('uses declared defaults in the concrete producer and captures the exact filter slots', () => {
    const execution = execute(
      `
const exact = Constant({ isOn: true, sections: [{ filters: [{ signal: signalSlot, value: amount }] }] });
const output = new Network();
output += exact;`,
      (runtime) => `
const defaultSignal = ${runtime}.signal('virtual', 'signal-default', { start: 0, end: 1 });
const signalSlot = ${runtime}.declareBlueprintSignalParameter('signal slot', defaultSignal, undefined, { start: 0, end: 1 });
const amount = ${runtime}.declareBlueprintNumberParameter('amount', 5, undefined, { start: 0, end: 1 });`,
    );

    expect(execution.plan.producers).toHaveLength(1);
    expect(execution.plan.producers[0]).toMatchObject({
      kind: 'constant',
      configuration: {
        isOn: true,
        sections: [
          { filters: [{ signal: { type: 'virtual', name: 'signal-default' }, value: 5 }] },
        ],
      },
    });
    expect(execution.plan.entities).toHaveLength(1);
    expect(execution.plan.entities[0]?.configuration).toMatchObject({
      mode: 'constant',
      value: {
        sections: [
          { filters: [{ signal: { type: 'virtual', name: 'signal-default' }, value: 5 }] },
        ],
      },
    });
    expect(execution.plan).not.toHaveProperty('constantTemplates');
    expect(JSON.stringify(execution.plan)).not.toContain('constantTemplates');

    const captured = execution as typeof execution & {
      readonly constantTemplates?: readonly {
        readonly captureId: string;
        readonly template: unknown;
        readonly source: unknown;
      }[];
    };
    expect(captured.constantTemplates).toHaveLength(1);
    expect(captured.constantTemplates?.[0]?.captureId).toBe(
      execution.plan.producers[0]?.debugCaptureIds?.[0],
    );
    expect(captured.constantTemplates?.[0]?.source).toEqual(execution.plan.producers[0]?.source);
    expect(Object.isFrozen(captured.constantTemplates?.[0]?.source)).toBe(true);
    expect(
      inspectConstantConfigurationTemplate(
        captured.constantTemplates?.[0]?.template,
        '$.constantTemplates[0].template',
      ).session,
    ).toBe(execution.session);
    expect(
      inspectConstantConfigurationTemplate(
        captured.constantTemplates?.[0]?.template,
        '$.constantTemplates[0].template',
      ).usedParameters,
    ).toEqual(execution.parameters.map(({ handle }) => handle));
  });

  test('reports a wrong-kind direct filter slot at its Constant call span', () => {
    const text = `
const exact = Constant({ sections: [{ filters: [{ signal: amount, value: 1 }] }] });`;
    const parsed = parseFile({ path: sourceFile, text });
    const callStart = text.indexOf('Constant(');
    const callEnd = text.indexOf(';', callStart);
    let caught: unknown;
    try {
      execute(
        text,
        (runtime) =>
          `const amount = ${runtime}.declareBlueprintNumberParameter('amount', 5, undefined, { start: 0, end: 1 });`,
      );
    } catch (error) {
      caught = error;
    }
    expect(caught).toMatchObject({
      code: 'RT2027',
      span: { fileId: parsed.id, start: callStart, end: callEnd },
    });
    expect(caught).toHaveProperty(
      'message',
      expect.stringContaining('expected a signal parameter'),
    );
  });

  test.each([
    [
      'nested filter expression',
      `const A = Signal('virtual', 'signal-A');
const exact = Constant({ sections: [{ filters: [[A, amount]] }] });`,
    ],
    [
      'non-filter multiplier slot',
      `const A = Signal('virtual', 'signal-A');
const exact = Constant({ sections: [{ multiplier: amount, filters: [[A, 1]] }] });`,
    ],
  ])('rejects %s instead of capturing it', (_label, text) => {
    const parsed = parseFile({ path: sourceFile, text });
    const callStart = text.indexOf('Constant(');
    const callEnd = text.indexOf(';', callStart);
    let caught: unknown;
    try {
      execute(
        text,
        (runtime) =>
          `const amount = ${runtime}.declareBlueprintNumberParameter('amount', 5, undefined, { start: 0, end: 1 });`,
      );
    } catch (error) {
      caught = error;
    }
    expect(caught).toMatchObject({
      code: 'RT2027',
      span: { fileId: parsed.id, start: callStart, end: callEnd },
    });
  });

  test('rejects foreign and forged parameter handles in direct filter slots', () => {
    const foreignKey = Symbol.for('comblang.test.foreign-constant-number');
    const forgedKey = Symbol.for('comblang.test.forged-constant-number');
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
      for (const [key, symbolKey, message] of [
        [
          foreignKey,
          'comblang.test.foreign-constant-number',
          'parameter belongs to a different parameter session',
        ],
        [forgedKey, 'comblang.test.forged-constant-number', 'unregistered parameter-like object'],
      ] as const) {
        const text = `const A = Signal('virtual', 'signal-A');
const exact = Constant({ sections: [{ filters: [{ signal: A, value: globalThis[Symbol.for('${symbolKey}')] }] }] });`;
        expect(() => execute(text)).toThrowError(
          expect.objectContaining({ message: expect.stringContaining(message) }),
        );
      }
    } finally {
      for (const [key, value] of previous) {
        if (value.had) globalRecord[key] = value.value;
        else delete globalRecord[key];
      }
    }
  });

  test('rejects missing defaults at either direct filter slot', () => {
    const session = createBlueprintParameterSession();
    const amount = session.number('amount');
    const signalSlot = session.signal('signal');
    const A = signal('virtual', 'signal-A');
    const context = {
      isSignal: (value: unknown): value is typeof A => value === A,
      isSignalValue: (_value: unknown): _value is never => false,
    };
    expect(() =>
      normalizeConstantConfigurationSourceWithParameters(
        { sections: [{ filters: [{ signal: A, value: amount }] }] },
        context,
        session,
      ),
    ).toThrowError(
      expect.objectContaining({
        name: 'ConstantConfigurationSourceError',
        message: expect.stringContaining('number parameter requires a numeric default'),
      } satisfies Partial<ConstantConfigurationSourceError>),
    );
    expect(() =>
      normalizeConstantConfigurationSourceWithParameters(
        { sections: [{ filters: [{ signal: signalSlot, value: 1 }] }] },
        context,
        session,
      ),
    ).toThrowError(
      expect.objectContaining({
        name: 'ConstantConfigurationSourceError',
        message: expect.stringContaining('Signal parameter requires a concrete default'),
      } satisfies Partial<ConstantConfigurationSourceError>),
    );
  });

  test('captures distinct dynamic producers and rolls back a failed enclosing instance', () => {
    const host = environment();
    const execution = execute(
      `
const A = Signal('virtual', 'signal-A');
function Make() {
  const exact = Constant({ sections: [{ filters: [{ signal: A, value: amount }] }] });
  const sink = new Network();
  sink += exact;
  return exact;
}
function Broken() {
  const exact = Constant({ sections: [{ filters: [{ signal: A, value: amount }] }] });
  const sink = new Network();
  sink += exact;
  return [exact, () => {}];
}
try { t.instantiate(Broken); } catch (error) { const caught = true; }
const first = t.instantiate(Make);
const second = t.instantiate(Make);`,
      (runtime) =>
        `const amount = ${runtime}.declareBlueprintNumberParameter('amount', 5, undefined, { start: 0, end: 1 });`,
      't',
    );

    expect(execution.plan.producers).toHaveLength(2);
    expect(execution.plan.entities).toHaveLength(2);
    expect(execution.constantTemplates).toHaveLength(2);
    expect(execution.constantTemplates.map(({ captureId }) => captureId)).toEqual([
      'producer:1',
      'producer:3',
    ]);
    expect(execution.plan.producers.map(({ debugCaptureIds }) => debugCaptureIds)).toEqual([
      ['producer:1', 'producer:2'],
      ['producer:3', 'producer:4'],
    ]);
    expect(new Set(execution.constantTemplates.map(({ captureId }) => captureId)).size).toBe(2);
    expect(execution.plan.debugInstances).toHaveLength(2);
    expect(
      tryElaborateDirectPlan(execution.plan, host.trustedEntityReplayContext).diagnostics,
    ).toEqual([]);
  });

  test('binds mixed Arithmetic and Constant captures atomically without changing topology', () => {
    const host = environment();
    const text = `
const A = Signal('virtual', 'signal-A');
const input = new Network();
const arithmetic = Arithmetic({ left: input[A], operation: 'add', right: amount, output: A });
const arithmeticOutput = new Network();
arithmeticOutput += arithmetic;
const exact = Constant({ sections: [{ filters: [{ signal: signalSlot, value: amount }] }] }).at(4, 5);
const constantOutput = new Network();
constantOutput += exact;`;
    const execution = execute(
      text,
      (runtime) => `
const defaultSignal = ${runtime}.signal('virtual', 'signal-default', { start: 0, end: 1 });
const signalSlot = ${runtime}.declareBlueprintSignalParameter('signal slot', defaultSignal, undefined, { start: 0, end: 1 });
const amount = ${runtime}.declareBlueprintNumberParameter('amount', 5, undefined, { start: 0, end: 1 });`,
    );
    const lowered = tryElaborateDirectPlan(execution.plan, host.trustedEntityReplayContext);
    expect(lowered.diagnostics).toEqual([]);
    expect(execution.arithmeticTemplates).toHaveLength(1);
    expect(execution.constantTemplates).toHaveLength(1);
    const canonicalExecution = lowered.execution!;
    const originalIr = canonicalExecution.circuit.ir;
    const originalConstant = originalIr.producers.find(({ kind }) => kind === 'constant')!;
    const originalArithmetic = originalIr.producers.find(({ kind }) => kind === 'arithmetic')!;
    const originalEntity = originalIr.entities.find(({ id }) => id === originalConstant.entityId)!;

    const defaultCircuit = bindCapturedSourceConfigurationTemplates(execution, canonicalExecution);
    expect(defaultCircuit).toEqual(originalIr);
    const boundCircuit = bindCapturedSourceConfigurationTemplates(execution, canonicalExecution, [
      { parameter: execution.parameters[0]!.handle, value: signal('virtual', 'signal-bound') },
      { parameter: execution.parameters[1]!.handle, value: 7 },
    ]);
    const boundConstant = boundCircuit.producers.find(({ kind }) => kind === 'constant')!;
    const boundArithmetic = boundCircuit.producers.find(({ kind }) => kind === 'arithmetic')!;
    const boundEntity = boundCircuit.entities.find(({ id }) => id === originalEntity.id)!;

    expect(boundCircuit.networks.map(({ id }) => id)).toEqual(
      originalIr.networks.map(({ id }) => id),
    );
    expect(boundCircuit.producers.map(({ id }) => id)).toEqual(
      originalIr.producers.map(({ id }) => id),
    );
    expect(boundCircuit.entities.map(({ id }) => id)).toEqual(
      originalIr.entities.map(({ id }) => id),
    );
    expect(boundArithmetic).toMatchObject({
      kind: 'arithmetic',
      config: { right: { kind: 'constant', value: 7 } },
    });
    expect(boundConstant).toMatchObject({
      kind: 'constant',
      config: {
        configuration: {
          sections: [{ filters: [{ signal: signal('virtual', 'signal-bound'), value: 7 }] }],
        },
      },
    });
    expect(boundEntity.configuration).toMatchObject({
      mode: 'constant',
      value: {
        sections: [{ filters: [{ signal: signal('virtual', 'signal-bound'), value: 7 }] }],
      },
    });
    expect(boundEntity.placement).toEqual(originalEntity.placement);
    expect(originalArithmetic).toMatchObject({
      kind: 'arithmetic',
      config: { right: { kind: 'constant', value: 5 } },
    });
    const json = JSON.stringify(generateBlueprintJson(boundCircuit));
    expect(json).not.toContain('constantTemplates');
    expect(json).not.toContain('signal slot');
    expect(json).not.toContain('amount');
    const beforeInvalidBinding = JSON.stringify(canonicalExecution.circuit.ir);
    expect(() =>
      bindCapturedSourceConfigurationTemplates(execution, canonicalExecution, [
        { parameter: execution.parameters[1]!.handle, value: Number.MAX_SAFE_INTEGER + 1 },
      ]),
    ).toThrowError(expect.objectContaining({ code: 'CP1000' }));
    expect(JSON.stringify(canonicalExecution.circuit.ir)).toBe(beforeInvalidBinding);

    const constantCapture = execution.constantTemplates[0]!;
    const missingCapture = {
      ...execution,
      constantTemplates: [{ ...constantCapture, captureId: 'producer:missing' }],
    };
    expect(() =>
      bindCapturedSourceConfigurationTemplates(missingCapture, canonicalExecution),
    ).toThrowError(expect.objectContaining({ path: '$.constantTemplates[0].captureId' }));
    const duplicateCapture = {
      ...execution,
      constantTemplates: [constantCapture, constantCapture],
    };
    expect(() =>
      bindCapturedSourceConfigurationTemplates(duplicateCapture, canonicalExecution),
    ).toThrowError(expect.objectContaining({ path: '$.constantTemplates[1].captureId' }));
  });
});

import { canonicalizeConstantConfiguration, signal } from '@comblang/factorio';
import { transformElaborationModule } from '@comblang/compiler/elaboration-transform';
import { generateBlueprintJson } from '@comblang/compiler/blueprint-json';
import { createTrustedEntityReplayContext } from '@comblang/compiler/entity-replay-context';
import { syntheticZeroPortEntityProfile } from '@comblang/compiler/entity-fixtures';
import type { EntityProfile } from '@comblang/compiler/entity';
import { parseFile } from '@comblang/language';
import type { EntityPrototype } from '@comblang/prototypes';
import type { SourceFileId, SourceSpan } from '@comblang/shared';
import type { DirectElaborationPlan } from '@comblang/compiler/direct-plan-schema';
import { describe, expect, test } from 'vitest';

import { createBlueprintConfigurationSet } from '../../compiler/src/blueprint-configuration-set.js';
import { createBlueprintParameterSession } from '../../compiler/src/blueprint-parameters.js';
import { createArithmeticConfigurationTemplate } from '../../compiler/src/arithmetic-configuration-template.js';
import { createConstantConfigurationTemplate } from '../../compiler/src/constant-configuration-template.js';
import {
  bindExecutedPlanConfigurationSet,
  createExecutedProducerCaptureReference,
} from './executed-blueprint-configuration-binding.js';
import { elaborateDirectPlan } from './direct-plan.js';
import { executeElaborationProgram } from './elaboration-program.js';
import { createSimulationFromNativeCircuitIr } from './elaboration.js';
import type { EntityPrototypeResolver } from './entity-registry.js';

const A = signal('virtual', 'signal-A');
const B = signal('virtual', 'signal-B');
const source = {
  fileId: 'capture-assignment.factorio.ts' as SourceFileId,
  start: 10,
  end: 20,
} satisfies SourceSpan;

function containsHandle(
  value: unknown,
  handles: ReadonlySet<object>,
  seen = new Set<object>(),
): boolean {
  if (value === null || typeof value !== 'object') return false;
  if (handles.has(value)) return true;
  if (seen.has(value)) return false;
  seen.add(value);
  return Reflect.ownKeys(value).some((key) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return (
      descriptor !== undefined &&
      'value' in descriptor &&
      containsHandle(descriptor.value, handles, seen)
    );
  });
}

function fixture() {
  const plan: DirectElaborationPlan = {
    format: 'comblang-direct-plan',
    networks: [
      { name: 'input', fixedColor: 'red', source, instancePath: [] },
      { name: 'output', fixedColor: 'green', source, instancePath: [] },
    ],
    producers: [
      {
        kind: 'constant',
        configuration: canonicalizeConstantConfiguration({
          sections: [{ filters: [{ signal: A, value: 7 }] }],
        }),
        debugCaptureIds: ['capture:constant'],
        destinations: [{ network: 'input', source, instancePath: [] }],
        source,
        instancePath: [],
      },
      {
        kind: 'arithmetic',
        left: { kind: 'signal', signal: A, refKind: 'single', network: 'input' },
        operation: 'add',
        right: { kind: 'constant', value: 5 },
        output: { kind: 'signal', signal: B },
        debugCaptureIds: ['capture:arithmetic'],
        destinations: [{ network: 'output', source, instancePath: [] }],
        source,
        instancePath: [],
      },
    ],
    entities: [],
  };
  const execution = elaborateDirectPlan(plan);
  const session = createBlueprintParameterSession();
  const amount = session.number('amount', { defaultValue: 7 });
  const offset = session.number('offset', { defaultValue: 5 });
  const set = createBlueprintConfigurationSet(session, [
    {
      key: 'source',
      kind: 'constant',
      template: createConstantConfigurationTemplate(session, {
        sections: [{ filters: [{ signal: A, value: amount }] }],
      }),
    },
    {
      key: 'sum',
      kind: 'arithmetic',
      template: createArithmeticConfigurationTemplate(session, {
        left: {
          kind: 'signal',
          signal: A,
          refKind: 'single',
          network: execution.network('input').id,
        },
        operation: 'add',
        right: { kind: 'constant', value: offset },
        output: { kind: 'signal', signal: B },
      }),
    },
  ]);
  const constantCapture = createExecutedProducerCaptureReference(execution, 'capture:constant');
  const arithmeticCapture = createExecutedProducerCaptureReference(execution, 'capture:arithmetic');

  return { plan, execution, session, amount, offset, set, constantCapture, arithmeticCapture };
}

describe('executed-plan configuration assignment', () => {
  test('resolves captures through the execution debug index and delegates one concrete replacement', () => {
    const { execution, amount, offset, set, constantCapture, arithmeticCapture } = fixture();
    const original = execution.circuit.ir;
    const constantId = execution.debug.scopes
      .flatMap((scope) => scope.producers)
      .find((entry) => entry.descriptor.debugCaptureIds?.includes('capture:constant'))!.id;
    const arithmeticId = execution.debug.scopes
      .flatMap((scope) => scope.producers)
      .find((entry) => entry.descriptor.debugCaptureIds?.includes('capture:arithmetic'))!.id;

    const replaced = bindExecutedPlanConfigurationSet(
      execution,
      set,
      [
        { key: 'source', captureId: constantCapture },
        { key: 'sum', captureId: arithmeticCapture },
      ],
      [
        { parameter: amount, value: 9 },
        { parameter: offset, value: 3 },
      ],
    );

    expect(replaced).not.toBe(original);
    expect(Object.isFrozen(replaced)).toBe(true);
    expect(Object.isFrozen(replaced.producers)).toBe(true);
    expect(replaced.producers.map(({ id }) => id)).toEqual(original.producers.map(({ id }) => id));
    expect(replaced.networks).toEqual(original.networks);
    expect(replaced.producers.map(({ destinations }) => destinations)).toEqual(
      original.producers.map(({ destinations }) => destinations),
    );
    expect(replaced.producers.find(({ id }) => id === constantId)?.config).toMatchObject({
      configuration: { sections: [{ filters: [{ value: 9 }] }] },
    });
    expect(replaced.producers.find(({ id }) => id === arithmeticId)?.config).toMatchObject({
      right: { kind: 'constant', value: 3 },
    });
    expect(original.producers.find(({ id }) => id === constantId)?.config).toMatchObject({
      configuration: { sections: [{ filters: [{ value: 7 }] }] },
    });
  });

  test('rejects malformed bounded capture assignment data without invoking accessors', () => {
    const { execution, set, constantCapture, arithmeticCapture } = fixture();
    const expectInvalid = (captures: unknown, path: string, code = 'CP1000') => {
      expect(() => bindExecutedPlanConfigurationSet(execution, set, captures)).toThrowError(
        expect.objectContaining({ code, path }),
      );
    };

    expectInvalid(new Array(1), '$.captures[0]');
    expectInvalid(
      [{ key: 'source', captureId: constantCapture, extra: true }],
      '$.captures[0].extra',
    );
    expectInvalid([{ key: 'source' }], '$.captures[0].captureId');
    const accessor = { key: 'source' } as Record<string, unknown>;
    let getterCalls = 0;
    Object.defineProperty(accessor, 'captureId', {
      enumerable: true,
      get() {
        getterCalls += 1;
        return constantCapture;
      },
    });
    expectInvalid([accessor], '$.captures[0].captureId');
    expect(getterCalls).toBe(0);
    expectInvalid([{ key: 'unknown', captureId: constantCapture }], '$.captures[0].key', 'CP1001');
    expectInvalid([{ key: 'source', captureId: 'capture:missing' }], '$.captures[0].captureId');
    expectInvalid(
      [
        { key: 'source', captureId: constantCapture },
        { key: 'source', captureId: arithmeticCapture },
      ],
      '$.captures[1].key',
      'CP1001',
    );
    expectInvalid(
      [
        { key: 'source', captureId: constantCapture },
        { key: 'sum', captureId: constantCapture },
      ],
      '$.captures[1].captureId',
      'CP1001',
    );
    expectInvalid([], '$.captures', 'CP1001');
  });

  test('rejects cross-execution capture references and configuration-kind mismatches', () => {
    const first = fixture();
    const second = fixture();
    expect(() =>
      bindExecutedPlanConfigurationSet(second.execution, second.set, [
        { key: 'source', captureId: first.constantCapture },
        { key: 'sum', captureId: second.arithmeticCapture },
      ]),
    ).toThrowError(expect.objectContaining({ code: 'CP1001', path: '$.captures[0].captureId' }));
    expect(() =>
      bindExecutedPlanConfigurationSet(first.execution, first.set, [
        { key: 'source', captureId: first.arithmeticCapture },
        { key: 'sum', captureId: first.constantCapture },
      ]),
    ).toThrowError(expect.objectContaining({ code: 'CP1001', path: '$.captures[0].captureId' }));
  });

  test('reports two aliases of one Producer at the capture assignment path', () => {
    const { plan, session, amount } = fixture();
    const first = plan.producers[0]!;
    const execution = elaborateDirectPlan({
      ...plan,
      producers: [
        { ...first, debugCaptureIds: ['capture:constant', 'capture:constant-alias'] },
        plan.producers[1]!,
      ],
    });
    const template = createConstantConfigurationTemplate(session, {
      sections: [{ filters: [{ signal: A, value: amount }] }],
    });
    const set = createBlueprintConfigurationSet(session, [
      { key: 'first', kind: 'constant', template },
      { key: 'alias', kind: 'constant', template },
    ]);
    const firstCapture = createExecutedProducerCaptureReference(execution, 'capture:constant');
    const aliasCapture = createExecutedProducerCaptureReference(
      execution,
      'capture:constant-alias',
    );

    expect(() =>
      bindExecutedPlanConfigurationSet(execution, set, [
        { key: 'first', captureId: firstCapture },
        { key: 'alias', captureId: aliasCapture },
      ]),
    ).toThrowError(
      expect.objectContaining({ code: 'CP1001', path: '$.captures[1].captureId', span: source }),
    );
  });

  test('rejects sets and parameter handles without their original registration provenance', () => {
    const { execution, set, amount, constantCapture, arithmeticCapture } = fixture();
    expect(() =>
      bindExecutedPlanConfigurationSet(execution, { ...set }, [
        { key: 'source', captureId: constantCapture },
        { key: 'sum', captureId: arithmeticCapture },
      ]),
    ).toThrowError(expect.objectContaining({ code: 'CP1002', path: '$.set' }));

    const otherSession = createBlueprintParameterSession();
    const foreignAmount = otherSession.number('foreign', { defaultValue: 1 });
    expect(() =>
      bindExecutedPlanConfigurationSet(
        execution,
        set,
        [
          { key: 'source', captureId: constantCapture },
          { key: 'sum', captureId: arithmeticCapture },
        ],
        [{ parameter: foreignAmount, value: 2 }],
      ),
    ).toThrowError(expect.objectContaining({ code: 'CP1001', path: '$.bindings[0].parameter' }));
    expect(amount).toBeDefined();
  });

  test('binds repeated executed-source captures with Blueprint and simulator parity', () => {
    const profile: EntityProfile = {
      ...syntheticZeroPortEntityProfile,
      ref: {
        ...syntheticZeroPortEntityProfile.ref,
        prototypeKey: 'entity:constant-combinator',
        profileId:
          'profile:executed-capture-parity' as typeof syntheticZeroPortEntityProfile.ref.profileId,
      },
      prototypeType: 'constant-combinator',
    };
    const trustedEntityReplayContext = createTrustedEntityReplayContext({
      database: profile.ref.database,
      source: 'synthetic',
      evidenceIdentity: 'executed-capture-parity-evidence',
      policyIdentity: 'executed-capture-parity-policy',
      profiles: [profile],
    });
    const entityPrototypeResolver: EntityPrototypeResolver = {
      database: trustedEntityReplayContext.database,
      getEntity(nameOrKey) {
        return nameOrKey === 'entity:constant-combinator' || nameOrKey === 'constant-combinator'
          ? {
              key: 'entity:constant-combinator' as EntityPrototype['key'],
              name: 'constant-combinator',
              type: 'constant-combinator',
              tileWidth: 1,
              tileHeight: 1,
            }
          : undefined;
      },
    };
    const parsed = parseFile({
      path: 'executed-capture-parity.factorio.ts',
      text: `const A = Signal('virtual', 'signal-A');
const B = Signal('virtual', 'signal-B');
const input = new Network();
const output = new Network();
function Source(): ConstantCombinator {
  return Constant({ sections: [{ filters: [[A, 7]] }] });
}
function Add(input: Readonly<Network>): ArithmeticCombinator {
  return input + 5;
}
for (let i = 0; i < 2; i++) {
  const source = t.instantiate(Source);
  const sum = t.instantiate(Add, input);
  input += source.value;
  output += sum.value;
}`,
    });
    const plan = executeElaborationProgram(
      transformElaborationModule(parsed, { testContextName: 't' }),
      { trustedEntityReplayContext, entityPrototypeResolver },
    );
    expect(plan.diagnostics).toEqual([]);
    expect(plan.producers.map(({ kind }) => kind)).toEqual([
      'constant',
      'arithmetic',
      'constant',
      'arithmetic',
    ]);
    const execution = elaborateDirectPlan(plan, trustedEntityReplayContext);
    const original = execution.circuit.ir;
    const originalPlanText = JSON.stringify(plan);
    const originalDebug = execution.debug;
    const session = createBlueprintParameterSession();
    const amount = session.number('amount', { defaultValue: 7 });
    const offset = session.number('offset', { defaultValue: 5 });
    const firstConstant = execution.circuit.ir.producers.find(
      (producer) => producer.kind === 'constant',
    );
    const firstArithmetic = execution.circuit.ir.producers.find(
      (producer) => producer.kind === 'arithmetic',
    );
    if (
      firstConstant?.kind !== 'constant' ||
      firstConstant.config.configuration === undefined ||
      firstArithmetic?.kind !== 'arithmetic' ||
      firstArithmetic.config.right.kind !== 'constant'
    ) {
      throw new Error('Expected exact Constant and constant-operand Arithmetic source captures.');
    }
    const constantConfiguration = firstConstant.config.configuration;
    const constantTemplate = createConstantConfigurationTemplate(session, {
      ...constantConfiguration,
      sections: constantConfiguration.sections.map((section, sectionIndex) => ({
        ...section,
        filters: section.filters.map((filter, filterIndex) =>
          sectionIndex === 0 && filterIndex === 0 ? { ...filter, value: amount } : filter,
        ),
      })),
    });
    const arithmeticTemplate = createArithmeticConfigurationTemplate(session, {
      ...firstArithmetic.config,
      right: { ...firstArithmetic.config.right, value: offset },
    });
    const configurationSet = createBlueprintConfigurationSet(
      session,
      plan.producers.map((producer, index) => ({
        key: `producer-${index + 1}`,
        kind: producer.kind,
        template: producer.kind === 'constant' ? constantTemplate : arithmeticTemplate,
      })),
    );
    const captureAssignments = plan.producers.map((producer, index) => {
      const captureId = producer.debugCaptureIds?.[0];
      if (captureId === undefined) throw new Error(`Producer ${index + 1} has no debug capture.`);
      return {
        key: `producer-${index + 1}`,
        captureId: createExecutedProducerCaptureReference(execution, captureId),
      };
    });
    let wrongKindError: unknown;
    try {
      bindExecutedPlanConfigurationSet(execution, configurationSet, [
        { key: captureAssignments[0]!.key, captureId: captureAssignments[1]!.captureId },
      ]);
    } catch (error) {
      wrongKindError = error;
    }
    const defaults = bindExecutedPlanConfigurationSet(
      execution,
      configurationSet,
      captureAssignments,
    );
    const defaultsBeforeOverrides = JSON.stringify(defaults);
    const overrides = bindExecutedPlanConfigurationSet(
      execution,
      configurationSet,
      captureAssignments,
      [
        { parameter: amount, value: 9 },
        { parameter: offset, value: 3 },
      ],
    );
    const outputNetwork = execution.network('output').id;
    const ticks = (ir: typeof original) => {
      const simulation = createSimulationFromNativeCircuitIr(ir);
      return Array.from({ length: 4 }, () => simulation.step().read(outputNetwork).toJSON());
    };
    const manualCircuit = (constantValue: number, arithmeticValue: number) => {
      const producers = original.producers.map((producer) => {
        if (producer.kind === 'constant') {
          const configuration = producer.config.configuration;
          if (configuration === undefined)
            throw new Error('Expected exact Constant configuration.');
          return {
            ...producer,
            config: {
              configuration: canonicalizeConstantConfiguration({
                ...configuration,
                sections: configuration.sections.map((section, sectionIndex) => ({
                  ...section,
                  filters: section.filters.map((filter, filterIndex) =>
                    sectionIndex === 0 && filterIndex === 0
                      ? { ...filter, value: constantValue }
                      : filter,
                  ),
                })),
              }),
            },
          };
        }
        if (producer.kind === 'arithmetic') {
          if (producer.config.right.kind !== 'constant') {
            throw new Error('Expected a concrete Arithmetic operand.');
          }
          return {
            ...producer,
            config: {
              ...producer.config,
              right: { ...producer.config.right, value: arithmeticValue },
            },
          };
        }
        return producer;
      });
      return {
        ...original,
        producers,
        entities: original.entities.map((entity) => {
          const linkedProducer = producers.find(({ entityId }) => entityId === entity.id);
          if (
            linkedProducer?.kind !== 'constant' ||
            linkedProducer.entityId === undefined ||
            linkedProducer.config.configuration === undefined
          ) {
            return entity;
          }
          return {
            ...entity,
            configuration: {
              mode: 'constant' as const,
              value: linkedProducer.config.configuration,
            },
          };
        }),
      };
    };
    const defaultManual = manualCircuit(7, 5);
    const overrideManual = manualCircuit(9, 3);

    const constantDescriptors = plan.producers.filter(({ kind }) => kind === 'constant');
    expect(constantDescriptors[1]?.source).toEqual(constantDescriptors[0]?.source);
    expect(wrongKindError).toMatchObject({
      code: 'CP1001',
      path: '$.captures[0].captureId',
      span: plan.producers[1]!.source,
      message: expect.stringContaining(
        `instance ${JSON.stringify(plan.producers[1]!.instancePath.join(' / '))}`,
      ),
    });
    expect(
      new Set(constantDescriptors.map(({ instancePath }) => JSON.stringify(instancePath))).size,
    ).toBe(2);
    expect(generateBlueprintJson(defaults)).toEqual(generateBlueprintJson(defaultManual));
    expect(generateBlueprintJson(overrides)).toEqual(generateBlueprintJson(overrideManual));
    expect(ticks(defaults)).toEqual(ticks(defaultManual));
    expect(ticks(overrides)).toEqual(ticks(overrideManual));
    expect(JSON.stringify(overrides)).not.toContain('amount');
    expect(JSON.stringify(overrides)).not.toContain('offset');
    expect(containsHandle(overrides, new Set<object>([amount, offset]))).toBe(false);
    expect(JSON.stringify(defaults)).toBe(defaultsBeforeOverrides);
    expect(execution.circuit.ir).toBe(original);
    expect(execution.debug).toBe(originalDebug);
    expect(JSON.stringify(plan)).toBe(originalPlanText);
    expect(defaults).not.toBe(overrides);
  });
});

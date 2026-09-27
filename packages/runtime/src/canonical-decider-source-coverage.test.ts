import {
  createTrustedEntityReplayContext,
  generateBlueprintJson,
  syntheticZeroPortEntityProfile,
  transformElaborationModule,
} from '@comblang/compiler';
import type { EntityProfile } from '@comblang/compiler/entity';
import type { DirectElaborationPlan } from '@comblang/compiler/direct-plan-schema';
import { signal, SparseBus } from '@comblang/factorio';
import type { EntityPrototype } from '@comblang/prototypes';
import { parseFile, validateDslSemantics } from '@comblang/language';
import { sourceFileId } from '@comblang/shared';
import { describe, expect, test } from 'vitest';
import { compileSourceProgram } from './source-compilation.js';
import {
  executeElaborationProgram,
  executeElaborationProgramWithParameters,
} from './elaboration-program.js';
import { bindCapturedSourceConfigurationTemplates } from './executed-blueprint-configuration-binding.js';
import { createSimulationFromNativeCircuitIr } from './elaboration.js';
import { tryElaborateDirectPlan } from './direct-plan.js';
import { createDebugDocument } from './debug-document.js';
import { createBlueprintParameterSession } from '../../compiler/src/blueprint-parameters.js';

const sourceFile = sourceFileId('canonical-decider-source-coverage.ts');

function exactEnvironment(includeMixed = false) {
  const profile: EntityProfile = {
    ...structuredClone(syntheticZeroPortEntityProfile),
    ref: {
      ...syntheticZeroPortEntityProfile.ref,
      prototypeKey: 'entity:decider-combinator',
      profileId: 'profile:source-coverage-decider-canonical' as EntityProfile['ref']['profileId'],
    },
    prototypeType: 'decider-combinator',
  };
  const extraProfiles = includeMixed
    ? (['arithmetic-combinator', 'constant-combinator'] as const).map((family) => ({
        ...structuredClone(syntheticZeroPortEntityProfile),
        ref: {
          ...syntheticZeroPortEntityProfile.ref,
          prototypeKey: `entity:${family}`,
          profileId:
            `profile:source-coverage-${family}-canonical` as EntityProfile['ref']['profileId'],
        },
        prototypeType: family,
      }))
    : [];
  const context = createTrustedEntityReplayContext({
    database: profile.ref.database,
    source: 'synthetic',
    evidenceIdentity: 'source-coverage-decider-evidence',
    policyIdentity: 'source-coverage-decider-policy',
    profiles: [profile, ...extraProfiles],
  });
  const prototypes = new Map<string, EntityPrototype>([
    [
      'entity:decider-combinator',
      {
        key: 'entity:decider-combinator',
        name: 'decider-combinator',
        type: 'decider-combinator',
        tileWidth: 1,
        tileHeight: 1,
      },
    ],
    ...(includeMixed
      ? (['arithmetic-combinator', 'constant-combinator'] as const).map(
          (family) =>
            [
              `entity:${family}`,
              { key: `entity:${family}`, name: family, type: family, tileWidth: 1, tileHeight: 1 },
            ] as const,
        )
      : []),
  ]);
  return {
    context,
    trustedEntityReplayContext: context,
    entityPrototypeResolver: {
      database: context.database,
      getEntity(nameOrKey: string): EntityPrototype | undefined {
        return prototypes.get(nameOrKey);
      },
    },
  };
}

const exactSource = `const A = Signal('virtual', 'signal-A');
const B = Signal('virtual', 'signal-B');
const input = new Network();
const exact: DeciderCombinator = Decider({
  condition: input[A] > 0,
  outputs: [input[A], 1 * B],
  elseOutputs: [input[B]],
});
const output = new Network();
output += exact;`;

function exactPlan(text = exactSource): DirectElaborationPlan {
  const parsed = parseFile({ path: sourceFile, text });
  expect(validateDslSemantics(parsed)).toEqual([]);
  const plan = executeElaborationProgram(transformElaborationModule(parsed), exactEnvironment());
  expect(plan).not.toHaveProperty('version');
  return plan;
}

function exactParameterizedExecution(
  text: string,
  options: {
    readonly signalParameter?: boolean;
    readonly includeMixed?: boolean;
    readonly missingDefault?: boolean;
    readonly testContextName?: string;
    readonly environment?: ReturnType<typeof exactEnvironment>;
  } = {},
) {
  const parsed = parseFile({ path: sourceFile, text });
  expect(validateDslSemantics(parsed)).toEqual([]);
  const transformed = transformElaborationModule(
    parsed,
    options.testContextName === undefined ? {} : { testContextName: options.testContextName },
  );
  const declaration = options.signalParameter
    ? `const amount = ${transformed.runtimeParameter}.declareBlueprintSignalParameter('amount', ${transformed.runtimeParameter}.signal('virtual', 'signal-A', { start: 0, end: 1 }), undefined, { start: 0, end: 1 });`
    : `const amount = ${transformed.runtimeParameter}.declareBlueprintNumberParameter('amount', ${options.missingDefault ? 'undefined' : '5'}, undefined, { start: 0, end: 1 });`;
  return executeElaborationProgramWithParameters(
    { ...transformed, code: `${declaration}\n${transformed.code}` },
    options.environment ?? exactEnvironment(options.includeMixed ?? false),
  );
}

describe('executed canonical Decider source contract', () => {
  test('captures a direct number threshold without putting its handle in the concrete plan', () => {
    const source = `const A = Signal('virtual', 'signal-A');
const input = new Network();
const exact: DeciderCombinator = Decider({ condition: input[A] > amount, outputs: [input[A]] });
const output = new Network();
output += exact;`;
    const parsed = parseFile({ path: sourceFile, text: source });
    const callStart = source.indexOf('Decider(');
    const callEnd = source.indexOf(';', callStart);
    const execution = exactParameterizedExecution(source);

    expect(execution.plan.producers).toHaveLength(1);
    expect(execution.plan.producers[0]).toMatchObject({
      kind: 'decider',
      condition: {
        kind: 'compare-signal',
        signal: { type: 'virtual', name: 'signal-A' },
        comparator: '>',
        constant: 5,
      },
      entityId: execution.plan.entities[0]?.id,
    });
    expect(execution.plan.producers[0]?.debugCaptureIds).toEqual(['producer:1']);
    expect(execution.plan.entities[0]?.configuration).toMatchObject({
      mode: 'decider',
      condition: { kind: 'compare-signal', constant: 5 },
    });
    expect(JSON.stringify(execution.plan)).not.toContain('amount');
    const workerTransfer = structuredClone(execution.plan);
    expect(workerTransfer).toEqual(execution.plan);
    expect(workerTransfer).not.toHaveProperty('session');
    expect(workerTransfer).not.toHaveProperty('parameters');
    expect(workerTransfer).not.toHaveProperty('deciderTemplates');
    expect(JSON.stringify(workerTransfer)).not.toContain('deciderTemplates');
    expect(execution.parameters).toHaveLength(1);
    expect(execution).toMatchObject({
      deciderTemplates: [
        {
          captureId: execution.plan.producers[0]?.debugCaptureIds?.[0],
          source: { fileId: parsed.id, start: callStart, end: callEnd },
          template: {
            condition: {
              kind: 'compare',
              comparator: '>',
              right: { kind: 'constant', value: execution.parameters[0]?.handle },
            },
          },
        },
      ],
    });
  });

  test('rejects a Signal parameter in the direct numeric threshold slot at the Decider use', () => {
    const source = `const A = Signal('virtual', 'signal-A');
const input = new Network();
const exact = Decider({ condition: input[A] > amount, outputs: [input[A]] });`;
    const parsed = parseFile({ path: sourceFile, text: source });
    const useStart = source.indexOf('input[A] > amount');
    const useEnd = useStart + 'input[A] > amount'.length;

    expect(() => exactParameterizedExecution(source, { signalParameter: true })).toThrowError(
      expect.objectContaining({
        code: 'RT2027',
        span: { fileId: parsed.id, start: useStart, end: useEnd },
      }),
    );
  });

  test('rejects missing defaults, reversed slots, forged handles, and foreign handles', () => {
    const source = `const A = Signal('virtual', 'signal-A');
const input = new Network();
const exact = Decider({ condition: input[A] > amount, outputs: [input[A]] });`;
    const parsed = parseFile({ path: sourceFile, text: source });
    expect(() => exactParameterizedExecution(source, { missingDefault: true })).toThrowError(
      expect.objectContaining({
        code: 'EX1001',
        span: { fileId: parsed.id, start: 0, end: 1 },
        message: expect.stringContaining('number declarations require a finite positional default'),
      }),
    );

    const reversed = source.replace('input[A] > amount', 'amount < input[A]');
    expect(() => exactParameterizedExecution(reversed)).toThrowError(
      expect.objectContaining({ code: 'RT2027' }),
    );

    const foreignKey = Symbol.for('comblang.test.foreign-decider-number');
    const forgedKey = Symbol.for('comblang.test.forged-decider-number');
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
      for (const [symbolKey, message] of [
        ['comblang.test.foreign-decider-number', 'different parameter session'],
        ['comblang.test.forged-decider-number', 'unregistered parameter-like object'],
      ] as const) {
        const invalid = source.replace(
          'input[A] > amount',
          `input[A] > globalThis[Symbol.for('${symbolKey}')]`,
        );
        expect(() => exactParameterizedExecution(invalid)).toThrowError(
          expect.objectContaining({
            code: 'RT2027',
            message: expect.stringContaining(message),
          }),
        );
      }
    } finally {
      for (const [key, value] of previous) {
        if (value.had) globalRecord[key] = value.value;
        else delete globalRecord[key];
      }
    }
  });

  test('preserves nested AND/OR condition order around a direct parameter threshold', () => {
    const source = `const A = Signal('virtual', 'signal-A');
const B = Signal('virtual', 'signal-B');
const input = new Network();
const exact = Decider({ condition: (input[A] > amount) && (input[B] <= 2 || input[A] != 0), outputs: [input[A]] });`;
    const execution = exactParameterizedExecution(source);
    expect(execution.plan.producers[0]).toMatchObject({
      kind: 'decider',
      condition: {
        kind: 'and',
        conditions: [
          { kind: 'compare-signal', comparator: '>', constant: 5 },
          {
            kind: 'or',
            conditions: [
              { kind: 'compare-signal', comparator: '<=', constant: 2 },
              { kind: 'compare-signal', comparator: '!=', constant: 0 },
            ],
          },
        ],
      },
    });
    expect(execution.deciderTemplates[0]?.template).toMatchObject({
      condition: {
        kind: 'and',
        conditions: [
          {
            kind: 'compare',
            right: { kind: 'constant', value: execution.parameters[0]?.handle },
          },
          { kind: 'or', conditions: [{ kind: 'compare' }, { kind: 'compare' }] },
        ],
      },
    });
  });

  test('does not leak exact Decider parameters into IF, when, or negated conditions', () => {
    const prefixes = [
      `const exact = IF(input[A] > amount, input[A]);`,
      `const exact = when(input[A] > amount).then(input[A]);`,
      `const exact = Decider({ condition: !(input[A] > amount), outputs: [input[A]] });`,
    ];
    for (const statement of prefixes) {
      const source = `const A = Signal('virtual', 'signal-A');\nconst input = new Network();\n${statement}`;
      expect(() => exactParameterizedExecution(source)).toThrowError(
        expect.objectContaining({
          code: 'RT2027',
          message: expect.stringContaining('only in exact Decider configuration conditions'),
        }),
      );
    }
  });

  test('binds the Decider threshold through the paired NCIR and linked Entity', () => {
    const source = `const A = Signal('virtual', 'signal-A');
const input = new Network();
const exact = Decider({ condition: input[A] > amount, outputs: [input[A]] }).at(4, 5, 2);
const output = new Network();
output += exact;`;
    const environment = exactEnvironment();
    const captured = exactParameterizedExecution(source, { environment });
    const lowered = tryElaborateDirectPlan(captured.plan, environment.context);
    expect(lowered.diagnostics).toEqual([]);
    const execution = lowered.execution!;
    const original = execution.circuit.ir;
    const defaultBound = bindCapturedSourceConfigurationTemplates(captured, execution);
    const bound = bindCapturedSourceConfigurationTemplates(captured, execution, [
      { parameter: captured.parameters[0]!.handle, value: 7 },
    ]);
    const originalProducer = original.producers.find(({ kind }) => kind === 'decider')!;
    const boundProducer = bound.producers.find(({ kind }) => kind === 'decider')!;
    const originalEntity = original.entities.find(({ id }) => id === originalProducer.entityId)!;
    const boundEntity = bound.entities.find(({ id }) => id === originalEntity.id)!;

    expect(defaultBound).toEqual(original);
    expect(bound.networks.map(({ id }) => id)).toEqual(original.networks.map(({ id }) => id));
    expect(bound.producers.map(({ id }) => id)).toEqual(original.producers.map(({ id }) => id));
    expect(bound.entities.map(({ id }) => id)).toEqual(original.entities.map(({ id }) => id));
    expect(originalProducer).toMatchObject({
      kind: 'decider',
      config: { condition: { kind: 'compare', right: { kind: 'constant', value: 5 } } },
    });
    expect(boundProducer).toMatchObject({
      kind: 'decider',
      config: { condition: { kind: 'compare', right: { kind: 'constant', value: 7 } } },
    });
    expect(boundEntity.configuration).toMatchObject({
      mode: 'decider',
      condition: { kind: 'compare', right: { kind: 'constant', value: 7 } },
    });
    expect(originalEntity.placement).toBeDefined();
    expect(boundEntity.placement).toEqual(originalEntity.placement);
    const serialized = JSON.stringify(generateBlueprintJson(bound));
    expect(serialized).not.toContain('amount');
    expect(serialized).not.toContain('deciderTemplates');
    expect(serialized).not.toContain('"kind":"number"');

    const input = execution.network('input').id;
    const output = execution.network('output').id;
    const simulate = (ir: typeof original) =>
      createSimulationFromNativeCircuitIr(ir, [
        { network: input, values: new SparseBus([[signal('virtual', 'signal-A'), 7]]) },
      ])
        .step()
        .read(output)
        .get(signal('virtual', 'signal-A'));
    expect(simulate(original)).toBe(7);
    expect(simulate(bound)).toBe(0);
    expect(execution.circuit.ir).toBe(original);
    const beforeInvalidBinding = JSON.stringify(execution.circuit.ir);
    expect(() =>
      bindCapturedSourceConfigurationTemplates(captured, execution, [
        { parameter: captured.parameters[0]!.handle, value: Number.MAX_SAFE_INTEGER + 1 },
      ]),
    ).toThrowError(expect.objectContaining({ code: 'CP1000' }));
    expect(JSON.stringify(execution.circuit.ir)).toBe(beforeInvalidBinding);

    const template = captured.deciderTemplates[0]!;
    const missingCapture = {
      ...captured,
      deciderTemplates: [{ ...template, captureId: 'producer:missing' }],
    };
    expect(() => bindCapturedSourceConfigurationTemplates(missingCapture, execution)).toThrowError(
      expect.objectContaining({ path: '$.deciderTemplates[0].captureId' }),
    );
    const duplicateCapture = {
      ...captured,
      deciderTemplates: [template, template],
    };
    expect(() =>
      bindCapturedSourceConfigurationTemplates(duplicateCapture, execution),
    ).toThrowError(expect.objectContaining({ path: '$.deciderTemplates[1].captureId' }));
    const foreignSession = exactParameterizedExecution(source, { environment });
    const foreignTemplate = { ...captured, deciderTemplates: foreignSession.deciderTemplates };
    expect(() => bindCapturedSourceConfigurationTemplates(foreignTemplate, execution)).toThrowError(
      expect.objectContaining({ path: '$.deciderTemplates[0].template' }),
    );
  });

  test('applies one number binding to Arithmetic, Constant count, and Decider threshold', () => {
    const source = `const A = Signal('virtual', 'signal-A');
const input = new Network();
const arithmetic = Arithmetic({ left: input[A], operation: 'add', right: amount, output: A });
const arithmeticOutput = new Network();
arithmeticOutput += arithmetic;
const constant = Constant({ sections: [{ filters: [{ signal: A, value: amount }] }] });
const constantOutput = new Network();
constantOutput += constant;
const decider = Decider({ condition: input[A] > amount, outputs: [input[A]] });
const deciderOutput = new Network();
deciderOutput += decider;`;
    const environment = exactEnvironment(true);
    const captured = exactParameterizedExecution(source, { environment });
    const lowered = tryElaborateDirectPlan(captured.plan, environment.context);
    expect(lowered.diagnostics).toEqual([]);
    expect(captured.arithmeticTemplates).toHaveLength(1);
    expect(captured.constantTemplates).toHaveLength(1);
    expect(captured.deciderTemplates).toHaveLength(1);

    const execution = lowered.execution!;
    const original = execution.circuit.ir;
    const bound = bindCapturedSourceConfigurationTemplates(captured, execution, [
      { parameter: captured.parameters[0]!.handle, value: 7 },
    ]);
    expect(bound.producers.find(({ kind }) => kind === 'arithmetic')).toMatchObject({
      kind: 'arithmetic',
      config: { right: { kind: 'constant', value: 7 } },
    });
    expect(bound.producers.find(({ kind }) => kind === 'constant')).toMatchObject({
      kind: 'constant',
      config: { configuration: { sections: [{ filters: [{ value: 7 }] }] } },
    });
    expect(bound.producers.find(({ kind }) => kind === 'decider')).toMatchObject({
      kind: 'decider',
      config: { condition: { kind: 'compare', right: { kind: 'constant', value: 7 } } },
    });
    expect(bound.entities.map(({ id }) => id)).toEqual(original.entities.map(({ id }) => id));
    expect(original.producers.find(({ kind }) => kind === 'decider')).toMatchObject({
      config: { condition: { kind: 'compare', right: { kind: 'constant', value: 5 } } },
    });
  });

  test('captures distinct dynamic Deciders and rolls back a failed enclosing instance', () => {
    const environment = exactEnvironment();
    const dynamicSource = `const A = Signal('virtual', 'signal-A');
const inputA = new Network();
const inputB = new Network();
function Gate(source: Network) {
  const exact = Decider({ condition: source[A] > amount, outputs: [source[A]] });
  const sink = new Network();
  sink += exact;
  return exact;
}
const first = t.instantiate(Gate, inputA);
const second = t.instantiate(Gate, inputB);
const outputA = new Network();
const outputB = new Network();
outputA += first.value;
outputB += second.value;`;
    const dynamic = exactParameterizedExecution(dynamicSource, {
      environment,
      testContextName: 't',
    });
    expect(dynamic.deciderTemplates).toHaveLength(2);
    expect(new Set(dynamic.deciderTemplates.map(({ captureId }) => captureId)).size).toBe(2);
    const lowered = tryElaborateDirectPlan(dynamic.plan, environment.context);
    expect(lowered.diagnostics).toEqual([]);
    const bound = bindCapturedSourceConfigurationTemplates(dynamic, lowered.execution!, [
      { parameter: dynamic.parameters[0]!.handle, value: 8 },
    ]);
    expect(bound.producers.filter(({ kind }) => kind === 'decider')).toHaveLength(2);
    expect(
      bound.producers
        .filter((producer) => producer.kind === 'decider')
        .every(
          (producer) =>
            producer.kind === 'decider' &&
            producer.config.condition.kind === 'compare' &&
            producer.config.condition.right.kind === 'constant' &&
            producer.config.condition.right.value === 8,
        ),
    ).toBe(true);

    const rollbackSource = `const A = Signal('virtual', 'signal-A');
function Broken() {
  Decider({ condition: input[A] > amount, outputs: [input[A]] });
  const invalid: unknown = 1;
  Decider({ condition: invalid, outputs: [input[A]] });
}
const input = new Network();
try { t.instantiate(Broken); } catch {}
const exact = Decider({ condition: input[A] > amount, outputs: [input[A]] });
const output = new Network();
output += exact;`;
    const rolledBack = exactParameterizedExecution(rollbackSource, {
      environment,
      testContextName: 't',
    });
    expect(rolledBack.plan.producers).toHaveLength(1);
    expect(rolledBack.plan.entities).toHaveLength(1);
    expect(rolledBack.deciderTemplates).toHaveLength(1);
    expect(rolledBack.deciderTemplates[0]?.captureId).toBe('producer:1');
  });

  test('normalizes exact rows once and retains one linked Entity', () => {
    const plan = exactPlan();
    expect(plan.producers).toHaveLength(1);
    expect(plan.entities).toHaveLength(1);
    expect(plan.producers[0]).toMatchObject({
      kind: 'decider',
      entityId: expect.any(String),
      outputs: [
        { kind: 'signal', refKind: 'single', network: 'input' },
        { kind: 'signal-constant', signal: signal('virtual', 'signal-B'), value: 1 },
      ],
      elseOutputs: [{ kind: 'signal', refKind: 'single', network: 'input' }],
    });
    const producer = plan.producers[0];
    if (producer?.kind !== 'decider') throw new Error('Expected a Decider producer.');
    expect(producer.outputOrigins ?? []).toHaveLength(2);
    expect(producer.elseOutputOrigins ?? []).toHaveLength(1);
    expect((producer.outputOrigins ?? []).every((origin) => origin.syntaxIntent === 'exact')).toBe(
      true,
    );
    expect(producer.elseOutputOrigins?.[0]?.syntaxIntent).toBe('exact');
    expect(plan.entities[0]?.configuration).toMatchObject({
      mode: 'decider',
      outputs: producer.outputs,
      elseOutputs: producer.elseOutputs,
    });
  });

  test('lowers through the existing simulator and resolved transport', () => {
    const plan = exactPlan();
    const lowered = tryElaborateDirectPlan(plan, exactEnvironment().context);
    expect(lowered.diagnostics).toEqual([]);
    expect(lowered.execution?.circuit.graph).not.toHaveProperty('version');
    expect(lowered.execution?.circuit.ir).not.toHaveProperty('version');
    expect(lowered.execution?.circuit.ir.producers[0]).toMatchObject({
      kind: 'decider',
      entityId: plan.producers[0]!.entityId,
      outputOrigins: plan.producers[0]!.kind === 'decider' ? plan.producers[0]!.outputOrigins : [],
    });
    expect(lowered.resolvedCircuit?.format).toBe('comblang-resolved-circuit');
    expect(lowered.execution?.circuit.createSimulation()).toBeDefined();
    const blueprint = generateBlueprintJson(lowered.execution!.circuit.ir);
    expect(blueprint.blueprint.entities).toHaveLength(1);
    expect(blueprint.blueprint.entities[0]).toMatchObject({ name: 'decider-combinator' });
    const debugProducer = lowered.execution!.debug.root.combinator(1).descriptor;
    expect(debugProducer.kind).toBe('decider');
    if (debugProducer.kind === 'decider' && 'outputOrigins' in debugProducer)
      expect(debugProducer.outputOrigins).toHaveLength(2);
    const debugDocument = createDebugDocument(
      lowered.execution!.debug,
      lowered.execution!.circuit.graph,
    );
    expect(debugDocument.version).toBe(2);
    expect(debugDocument.scopes[0]?.producers[0]?.outputOrigins).toHaveLength(2);
  });

  test('requires trusted Entity authority for exact Decider configuration', () => {
    const parsed = parseFile({ path: sourceFile, text: exactSource });
    expect(() => executeElaborationProgram(transformElaborationModule(parsed))).toThrow(
      'trusted base entity:decider-combinator Entity profile',
    );
  });

  test('rolls back a caught invalid exact call before the next producer', () => {
    const source = `const A = Signal('virtual', 'signal-A');
const input = new Network();
const cycle: unknown[] = [];
cycle.push(cycle);
try {
  Decider({ condition: input[A] > 0, outputs: cycle });
} catch {}
const good: DeciderCombinator = Decider({ condition: input[A] > 0, outputs: [input[A]] });
const output = new Network();
output += good;`;
    const plan = exactPlan(source);
    expect(plan.producers).toHaveLength(1);
    expect(plan.entities).toHaveLength(1);
    expect(plan.producers[0]?.entityId).toBe(plan.entities[0]?.id);
  });

  test('rejects malformed exact records and output containers before allocation', () => {
    const expectFailure = (body: string, message: string) => {
      const parsed = parseFile({
        path: sourceFile,
        text: `const A = Signal('virtual', 'signal-A');
const input = new Network();
${body}`,
      });
      expect(validateDslSemantics(parsed)).toEqual([]);
      expect(() =>
        executeElaborationProgram(transformElaborationModule(parsed), exactEnvironment()),
      ).toThrow(message);
    };

    expectFailure(
      `const condition: unknown = 1;
const gate = Decider({ condition, outputs: [input] });`,
      'condition must be a circuit Condition',
    );
    expectFailure(
      `const gate = Decider({ condition: input[A] > 0, outputs: [], elseOutputs: [] });`,
      'requires at least one output row',
    );
    expectFailure(
      `const config = { condition: input[A] > 0, outputs: [input] };
Object.defineProperty(config, 'elseOutputs', { enumerable: true, get() { return input; } });
const gate = Decider(config);`,
      'plain data record',
    );
    expectFailure(
      `const config = { condition: input[A] > 0, outputs: [input], extra: input };
const gate = Decider(config);`,
      'exactly condition, outputs',
    );
    expectFailure(
      `const config = { condition: input[A] > 0, outputs: [input] };
config[Symbol('extra')] = input;
const gate = Decider(config);`,
      'plain data record',
    );
    expectFailure(
      `const rows: unknown[] = [];
rows.push(rows);
const gate = Decider({ condition: input[A] > 0, outputs: rows });`,
      'cannot be cyclic',
    );
    expectFailure(
      `const gate = Decider({ condition: input[A] > 0, outputs: [{ foreign: 1 }] });`,
      'output',
    );
  });

  test('rejects missing, corrupt, or unavailable trusted Decider authority', () => {
    const parsed = parseFile({ path: sourceFile, text: exactSource });
    expect(validateDslSemantics(parsed)).toEqual([]);
    const transformed = transformElaborationModule(parsed);

    expect(() => executeElaborationProgram(transformed)).toThrow(
      'trusted base entity:decider-combinator Entity profile',
    );

    const unavailable = exactEnvironment();
    unavailable.entityPrototypeResolver = {
      ...unavailable.entityPrototypeResolver,
      getEntity: () => undefined,
    };
    expect(() => executeElaborationProgram(transformed, unavailable)).toThrow(
      'not available in the selected provider',
    );

    const corrupt = exactEnvironment();
    corrupt.entityPrototypeResolver = {
      ...corrupt.entityPrototypeResolver,
      getEntity: () => ({
        key: 'entity:decider-combinator',
        name: 'custom-decider',
        type: 'decider-combinator',
        tileWidth: 1,
        tileHeight: 1,
      }),
    };
    expect(() => executeElaborationProgram(transformed, corrupt)).toThrow(
      'does not match base provider prototype data',
    );

    const wrongFamily = exactEnvironment();
    const wrongProfile = {
      ...structuredClone(syntheticZeroPortEntityProfile),
      ref: {
        ...syntheticZeroPortEntityProfile.ref,
        prototypeKey: 'entity:decider-combinator',
        profileId:
          'profile:source-coverage-wrong-family-canonical' as EntityProfile['ref']['profileId'],
      },
      prototypeType: 'arithmetic-combinator' as const,
    };
    wrongFamily.context = createTrustedEntityReplayContext({
      database: wrongProfile.ref.database,
      source: 'synthetic',
      evidenceIdentity: 'source-coverage-wrong-family-evidence',
      policyIdentity: 'source-coverage-wrong-family-policy',
      profiles: [wrongProfile],
    });
    wrongFamily.trustedEntityReplayContext = wrongFamily.context;
    expect(() => executeElaborationProgram(transformed, wrongFamily)).toThrow(
      'does not assert prototypeType "decider-combinator"',
    );
  });

  test('rolls back corrupt ergonomic authority before direct and delayed linking', () => {
    const run = (source: string) => {
      const environment = exactEnvironment();
      let firstLookup = true;
      const getEntity = environment.entityPrototypeResolver.getEntity.bind(
        environment.entityPrototypeResolver,
      );
      environment.entityPrototypeResolver = {
        ...environment.entityPrototypeResolver,
        getEntity(nameOrKey: string) {
          const prototype = getEntity(nameOrKey);
          if (firstLookup && nameOrKey === 'entity:decider-combinator') {
            firstLookup = false;
            return { ...prototype!, name: 'corrupt-decider' };
          }
          return prototype;
        },
      };
      const plan = executeElaborationProgram(
        transformElaborationModule(parseFile({ path: sourceFile, text: source })),
        environment,
      );
      expect(plan).not.toHaveProperty('version');
      expect(plan.producers).toHaveLength(1);
      expect(plan.entities).toHaveLength(1);
      expect(plan.producers[0]?.entityId).toBe(plan.entities[0]?.id);
      return plan;
    };

    run(`const input = new Network();
try {
  IF(input > 0, input);
} catch {}
const valid = IF(input > 0, input);
const output = new Network();
output += valid;`);

    run(`const input = new Network();
const gate = when(input > 0);
try {
  gate.then(input);
} catch {}
gate.then(input);
const output = new Network();
output += gate;`);
  });

  test('covers exact output modes, nested flattening, duplicate rows, and computed records', () => {
    const source = `const A = Signal('virtual', 'signal-A');
const B = Signal('virtual', 'signal-B');
const input = new Network();
const config = {
  condition: Each(input) > 0,
  outputs: [[input[A], { nested: [input, Each(input)] }], [1 * A, 2 * EACH]],
  elseOutputs: [input[A], input[A]],
};
const gate: DeciderCombinator = Decider(config);
const output = new Network();
    output += gate;`;
    const plan = exactPlan(source);
    const producer = plan.producers[0];
    expect(producer?.kind).toBe('decider');
    if (producer?.kind !== 'decider') throw new Error('Expected a Decider producer.');
    expect(producer.outputs).toHaveLength(5);
    expect(producer.elseOutputs).toHaveLength(2);
    expect((producer.outputs ?? []).map((row) => row.kind)).toEqual([
      'signal',
      'each',
      'each',
      'signal-constant',
      'each-constant',
    ]);
    expect(producer.elseOutputs?.[0]).toEqual(producer.elseOutputs?.[1]);
    expect((producer.outputOrigins ?? []).map((origin) => origin.ordinal)).toEqual([0, 1, 2, 3, 4]);
    expect((producer.outputOrigins ?? []).every((origin) => origin.syntaxIntent === 'exact')).toBe(
      true,
    );
  });

  test('retains branch, ordinal, span, and nested loop provenance for generated exact rows', () => {
    const source = `const A = Signal('virtual', 'signal-A');
const input = new Network();
function Build(input) {
  const output = new Network();
  for (const amount of [1, 1, 2]) {
    const gate: DeciderCombinator = Decider({
      condition: input[A] > 0,
      outputs: [amount * A, amount * A],
      elseOutputs: [input[A], input[A]],
    });
    output += gate;
  }
  return output;
}
const output = Build(input);`;
    const plan = exactPlan(source);
    const producers = plan.producers.filter((candidate) => candidate.kind === 'decider');
    expect(producers).toHaveLength(3);
    expect(producers.map((producer) => producer.instancePath.at(-1))).toEqual([
      'for amount=1',
      'for amount=1#2',
      'for amount=2',
    ]);
    for (const [index, producer] of producers.entries()) {
      expect(producer.outputs).toHaveLength(2);
      expect(producer.elseOutputs).toHaveLength(2);
      expect(producer.outputOrigins?.map((origin) => origin.branch)).toEqual(['normal', 'normal']);
      expect(producer.outputOrigins?.map((origin) => origin.ordinal)).toEqual([0, 1]);
      expect(producer.outputOrigins?.map((origin) => origin.instancePath.at(-1))).toEqual([
        `for amount=${[1, 1, 2][index]}${index === 1 ? '#2' : ''}`,
        `for amount=${[1, 1, 2][index]}${index === 1 ? '#2' : ''}`,
      ]);
      expect(
        producer.outputOrigins?.every((origin) =>
          source.slice(origin.source.start, origin.source.end).includes('amount * A'),
        ),
      ).toBe(true);
      expect(producer.elseOutputOrigins?.map((origin) => origin.branch)).toEqual(['else', 'else']);
      expect(producer.elseOutputOrigins?.map((origin) => origin.ordinal)).toEqual([0, 1]);
      expect(
        producer.elseOutputOrigins?.every((origin) =>
          source.slice(origin.source.start, origin.source.end).includes('input[A]'),
        ),
      ).toBe(true);
    }

    const resolved = tryElaborateDirectPlan(plan, exactEnvironment().context);
    expect(resolved.diagnostics).toEqual([]);
    const resolvedProducers = resolved.execution?.circuit.ir.producers.filter(
      (candidate) => candidate.kind === 'decider',
    );
    expect(resolvedProducers?.map((producer) => producer.outputOrigins)).toEqual(
      producers.map((producer) => producer.outputOrigins),
    );
    expect(resolvedProducers?.map((producer) => producer.elseOutputOrigins)).toEqual(
      producers.map((producer) => producer.elseOutputOrigins),
    );
  });

  test('allows an empty normal branch when the false branch carries rows', () => {
    const source = `const A = Signal('virtual', 'signal-A');
const input = new Network();
const gate: DeciderCombinator = Decider({ condition: Each(input) > 0, outputs: [], elseOutputs: [input] });
const output = new Network();
output += gate;`;
    const plan = exactPlan(source);
    const producer = plan.producers[0];
    expect(producer?.kind).toBe('decider');
    if (producer?.kind !== 'decider') throw new Error('Expected a Decider producer.');
    expect(producer.outputs).toEqual([]);
    expect(producer.elseOutputs).toHaveLength(1);
    expect(producer.outputOrigins).toEqual([]);
    expect(producer.elseOutputOrigins?.[0]?.branch).toBe('else');
  });

  test('accepts false-only exact records and canonicalizes empty branches', () => {
    const source = `const A = Signal('virtual', 'signal-A');
const input = new Network();
const omitted: DeciderCombinator = Decider({ condition: input[A] > 0, elseOutputs: input[A] });
const explicitUndefined: DeciderCombinator = Decider({ condition: input[A] > 0, outputs: undefined, elseOutputs: [input[A]] });
const emptyElse: DeciderCombinator = Decider({ condition: input[A] > 0, outputs: [input[A]], elseOutputs: undefined });
const output = new Network();
output += omitted;
output += explicitUndefined;
output += emptyElse;`;
    const plan = exactPlan(source);
    expect(plan.producers).toHaveLength(3);
    for (const producer of plan.producers.slice(0, 2)) {
      if (producer.kind !== 'decider') throw new Error('Expected Decider producers.');
      expect(producer.outputs).toEqual([]);
      expect(producer.elseOutputs).toHaveLength(1);
      expect(producer.outputOrigins).toEqual([]);
      expect(producer.elseOutputOrigins).toHaveLength(1);
    }
    const emptyElseProducer = plan.producers[2];
    if (emptyElseProducer?.kind !== 'decider') throw new Error('Expected a Decider producer.');
    expect(emptyElseProducer.outputs).toHaveLength(1);
    expect(emptyElseProducer.elseOutputs).toBeUndefined();
  });

  test('accepts a single output value in either exact branch field', () => {
    const source = `const A = Signal('virtual', 'signal-A');
const input = new Network();
const gate: DeciderCombinator = Decider({ condition: Each(input) > 0, outputs: input[A], elseOutputs: input });
const output = new Network();
output += gate;`;
    const plan = exactPlan(source);
    const producer = plan.producers[0];
    expect(producer?.kind).toBe('decider');
    if (producer?.kind !== 'decider') throw new Error('Expected a Decider producer.');
    expect(producer.outputs).toHaveLength(1);
    expect(producer.elseOutputs).toHaveLength(1);
  });

  test('source compilation exposes canonical execution and resolved circuit', () => {
    const environment = exactEnvironment();
    const result = compileSourceProgram({ path: sourceFile, text: exactSource }, environment);
    expect(result.pipelineDiagnostics).toEqual([]);
    expect(result.plan).not.toHaveProperty('version');
    expect(result.execution?.circuit.ir).not.toHaveProperty('version');
    expect(result.resolvedCircuit?.format).toBe('comblang-resolved-circuit');
  });

  test.each([
    {
      name: 'normal Each output',
      source: `const A = Signal('virtual', 'signal-A');
const input = new Network();
const exact: DeciderCombinator = Decider({ condition: input[A] > 0, outputs: [Each(input)] });
const output = new Network();
output += exact;`,
      field: 'outputs: [Each(input)]',
      message: 'Decider Each output requires a final condition set that uses Each',
    },
    {
      name: 'alternate Everything output',
      source: `const A = Signal('virtual', 'signal-A');
const input = new Network();
const exact: DeciderCombinator = Decider({ condition: Each(input) > 0, outputs: [input[A]], elseOutputs: [Everything(input)] });
const output = new Network();
output += exact;`,
      field: 'elseOutputs: [Everything(input)]',
      message: 'Decider Everything output is invalid when the final condition set uses Each',
    },
  ])('source compilation points exact $name at its field rows', ({ source, field, message }) => {
    const result = compileSourceProgram({ path: sourceFile, text: source }, exactEnvironment());
    const fieldStart = source.indexOf(field);
    const valueStart = source.indexOf('[', fieldStart);
    const valueEnd = source.indexOf(']', valueStart) + 1;
    expect(result.plan).toBeUndefined();
    expect(result.pipelineDiagnostics).toEqual([
      expect.objectContaining({
        code: 'RT2027',
        message: expect.stringContaining(message),
        span: {
          fileId: sourceFileId(sourceFile),
          start: valueStart,
          end: valueEnd,
        },
      }),
    ]);
  });

  test('links ergonomic IF and mutable when to one stable Entity under trusted authority', () => {
    const source = `const A = Signal('virtual', 'signal-A');
const input = new Network();
const first: DeciderCombinator = when(Each(input) > 0).then(input);
first.then(1 * A).else(input);
const second: DeciderCombinator = IF(Each(input) > 0, input[A], input[A]);
const output = new Network();
output += first;
output += second;`;
    const plan = exactPlan(source);
    expect(plan).not.toHaveProperty('version');
    expect(plan.entities).toHaveLength(2);
    expect(plan.producers).toHaveLength(2);
    const linkedIds = plan.producers.map((producer) => producer.entityId);
    expect(linkedIds.every((id) => id !== undefined)).toBe(true);
    expect(new Set(linkedIds).size).toBe(2);
    const firstProducer = plan.producers[0];
    expect(firstProducer?.kind === 'decider' ? firstProducer.outputs : []).toHaveLength(2);
    expect(firstProducer?.kind === 'decider' ? firstProducer.elseOutputs : undefined).toHaveLength(
      1,
    );
  });

  test('preserves row sources through direct, chained, computed, aliased, and spread calls', () => {
    const source = `const A = Signal('virtual', 'signal-A');
const input = new Network();
const gate: DeciderCombinator = when(input > 0);
gate.then(input[A]);
const thenAlias = gate.then;
const rows = [1 * A, input[A]];
thenAlias(...rows);
const elseAlias = gate['else'];
elseAlias(input[A]);
const output = new Network();
output += gate;`;
    const plan = exactPlan(source);
    expect(plan).not.toHaveProperty('version');
    const producer = plan.producers[0];
    if (producer?.kind !== 'decider') throw new Error('Expected a Decider producer.');
    expect(producer.outputs).toHaveLength(3);
    expect(producer.elseOutputs).toHaveLength(1);
    expect((producer.outputOrigins ?? []).map((origin) => origin.source.start)).toEqual([
      source.indexOf('input[A]', source.indexOf('gate.then(input[A])')),
      source.indexOf('...rows'),
      source.indexOf('...rows'),
    ]);
    expect(producer.elseOutputOrigins?.[0]?.source.start).toBe(
      source.indexOf('input[A]', source.indexOf('elseAlias(input[A])')),
    );
    expect((producer.outputOrigins ?? []).map((origin) => origin.ordinal)).toEqual([0, 1, 2]);
    expect(producer.elseOutputOrigins?.[0]?.ordinal).toBe(0);
  });

  test('uses exact branch initializer spans for literal records', () => {
    const source = `const A = Signal('virtual', 'signal-A');
const input = new Network();
const gate: DeciderCombinator = Decider({
  condition: input > 0,
  outputs: 1 * A,
  elseOutputs: input[A],
});
const output = new Network();
output += gate;`;
    const plan = exactPlan(source);
    const producer = plan.producers[0];
    if (producer?.kind !== 'decider') throw new Error('Expected a Decider producer.');
    const outputOrigin = producer.outputOrigins?.[0];
    const elseOutputOrigin = producer.elseOutputOrigins?.[0];
    if (outputOrigin === undefined || elseOutputOrigin === undefined)
      throw new Error('Expected Decider output origins.');
    expect(source.slice(outputOrigin.source.start, outputOrigin.source.end)).toBe('1 * A');
    expect(source.slice(elseOutputOrigin.source.start, elseOutputOrigin.source.end)).toBe(
      'input[A]',
    );
  });

  test('moves producer-owned pre-link placement onto the single linked Entity', () => {
    const source = `const input = new Network();
const gate: DeciderCombinator = when(input > 0).at(3, 4, 8);
gate.then(input);
const output = new Network();
output += gate;`;
    const plan = exactPlan(source);
    expect(plan).not.toHaveProperty('version');
    expect(plan.producers[0]).not.toHaveProperty('placement');
    expect(plan.entities[0]?.placement).toEqual({ x: 3, y: 4, direction: 8 });
  });

  test('selects cumulative output for mixed linked Constant, Arithmetic, and Decider producers', () => {
    const parsed = parseFile({
      path: sourceFile,
      text: `const A = Signal('virtual', 'signal-A');
const input = new Network();
const constant: ConstantCombinator = CC(2 * A);
const arithmetic: ArithmeticCombinator = Arithmetic({ left: input[A], operation: 'add', right: 1, output: A });
const decider: DeciderCombinator = IF(input[A] > 0, input[A]);
const output = new Network();
output += constant;
output += arithmetic;
output += decider;`,
    });
    expect(validateDslSemantics(parsed)).toEqual([]);
    const plan = executeElaborationProgram(
      transformElaborationModule(parsed),
      exactEnvironment(true),
    );
    expect(plan).not.toHaveProperty('version');
    expect(plan.entities).toHaveLength(3);
    expect(plan.producers).toHaveLength(3);
    expect(plan.producers.map((producer) => producer.kind)).toEqual([
      'constant',
      'arithmetic',
      'decider',
    ]);
    expect(plan.producers.every((producer) => producer.entityId !== undefined)).toBe(true);
  });

  test('keeps ergonomic IF/when in v2 when no trusted Entity authority is supplied', () => {
    const parsed = parseFile({
      path: sourceFile,
      text: `const input = new Network();
const output = new Network();
output += IF(input > 0, input);`,
    });
    const plan = executeElaborationProgram(transformElaborationModule(parsed));
    expect(plan).not.toHaveProperty('version');
  });
});

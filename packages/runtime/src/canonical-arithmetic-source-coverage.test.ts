import {
  createTrustedEntityReplayContext,
  generateBlueprintJson,
  syntheticZeroPortEntityProfile,
  transformElaborationModule,
} from '@comblang/compiler';
import type { EntityId, EntityProfile } from '@comblang/compiler/entity';
import type { DirectElaborationPlan } from '@comblang/compiler/direct-plan-schema';
import { signal, SparseBus } from '@comblang/factorio';
import { parseFile, validateDslSemantics } from '@comblang/language';
import type { EntityPrototype } from '@comblang/prototypes';
import { sourceFileId } from '@comblang/shared';
import { describe, expect, test } from 'vitest';
import {
  createArithmeticConfigurationTemplate,
  inspectArithmeticConfigurationTemplate,
} from '../../compiler/src/arithmetic-configuration-template.js';
import { createBlueprintParameterSession } from '../../compiler/src/blueprint-parameters.js';
import { bindCapturedSourceArithmeticTemplates } from './executed-blueprint-configuration-binding.js';
import { createSimulationFromNativeCircuitIr } from './elaboration.js';
import { tryElaborateDirectPlan } from './direct-plan.js';
import {
  ElaborationExecutionError,
  executeElaborationProgram,
  executeElaborationProgramWithParameters,
} from './elaboration-program.js';

const sourceFile = sourceFileId('canonical-arithmetic-source-coverage.ts');
const operations = [
  'add',
  'subtract',
  'multiply',
  'divide',
  'modulo',
  'power',
  'left-shift',
  'right-shift',
  'bit-and',
  'bit-or',
  'bit-xor',
] as const;

function profileFor(
  prototypeKey: string,
  profileId: string,
  prototypeType?: EntityProfile['prototypeType'],
): EntityProfile {
  return {
    ...structuredClone(syntheticZeroPortEntityProfile),
    ref: {
      ...syntheticZeroPortEntityProfile.ref,
      prototypeKey,
      profileId: profileId as EntityProfile['ref']['profileId'],
    },
    ...(prototypeType === undefined ? {} : { prototypeType }),
  };
}

function exactEnvironment(includeStructural = false) {
  const profiles = [
    profileFor(
      'entity:arithmetic-combinator',
      'profile:source-coverage-arithmetic-canonical',
      'arithmetic-combinator',
    ),
    profileFor(
      'entity:constant-combinator',
      'profile:source-coverage-constant-canonical',
      'constant-combinator',
    ),
    ...(includeStructural
      ? [profileFor('entity:synthetic-structural', 'profile:source-coverage-structural-v3')]
      : []),
  ];
  const context = createTrustedEntityReplayContext({
    database: profiles[0]!.ref.database,
    source: 'synthetic',
    evidenceIdentity: 'source-coverage-arithmetic-evidence',
    policyIdentity: 'source-coverage-arithmetic-policy',
    profiles,
  });
  const prototypes = new Map<string, EntityPrototype>([
    [
      'entity:arithmetic-combinator',
      {
        key: 'entity:arithmetic-combinator' as EntityPrototype['key'],
        name: 'arithmetic-combinator',
        type: 'arithmetic-combinator',
        tileWidth: 1,
        tileHeight: 1,
      },
    ],
    [
      'entity:constant-combinator',
      {
        key: 'entity:constant-combinator' as EntityPrototype['key'],
        name: 'constant-combinator',
        type: 'constant-combinator',
        tileWidth: 1,
        tileHeight: 1,
      },
    ],
    [
      'entity:synthetic-structural',
      {
        key: 'entity:synthetic-structural' as EntityPrototype['key'],
        name: 'synthetic-structural',
        type: 'container',
        tileWidth: 1,
        tileHeight: 1,
      },
    ],
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

function exactPlan(text: string, environment = exactEnvironment()): DirectElaborationPlan {
  const parsed = parseFile({ path: sourceFile, text });
  expect(validateDslSemantics(parsed)).toEqual([]);
  const plan = executeElaborationProgram(transformElaborationModule(parsed), environment);
  expect(plan).not.toHaveProperty('version');
  return plan;
}

function executeWithParameter(
  text: string,
  declaration: (runtimeParameter: string) => string = (runtimeParameter) =>
    `const amount = ${runtimeParameter}.declareBlueprintNumberParameter('amount', 4, undefined, { start: 0, end: 1 });`,
) {
  const parsed = parseFile({ path: sourceFile, text });
  const transformed = transformElaborationModule(parsed);
  return executeElaborationProgramWithParameters(
    {
      ...transformed,
      code: `${declaration(transformed.runtimeParameter)}\n${transformed.code}`,
    },
    exactEnvironment(),
  );
}

function expectArithmeticUseFailure(
  text: string,
  message: string,
  declaration?: (runtimeParameter: string) => string,
): void {
  const parsed = parseFile({ path: sourceFile, text });
  const start = text.indexOf('Arithmetic(');
  const end = text.indexOf(');', start) + 1;
  let caught: unknown;
  try {
    executeWithParameter(text, declaration);
  } catch (error) {
    caught = error;
  }
  expect(caught).toMatchObject({
    code: 'RT2027',
    span: { fileId: parsed.id, start, end },
  });
  expect(caught).toHaveProperty('message', expect.stringContaining(message));
}

function failureFor(text: string, environment = exactEnvironment()): ElaborationExecutionError {
  const parsed = parseFile({ path: sourceFile, text });
  try {
    executeElaborationProgram(transformElaborationModule(parsed), environment);
    throw new Error('Expected exact Arithmetic source to fail.');
  } catch (error) {
    if (error instanceof ElaborationExecutionError) return error;
    throw error;
  }
}

describe('executed canonical Arithmetic source contract', () => {
  test('captures one exact Arithmetic parameter use beside its default-valued plan', () => {
    const text = `
const A = Signal('virtual', 'signal-A');
function Add() {
  const exact: ArithmeticCombinator = Arithmetic({ left: 2, operation: 'add', right: amount, output: A });
  const sink = new Network();
  sink += exact;
  return exact;
}
const dut = t.instantiate(Add);`;
    const parsed = parseFile({ path: sourceFile, text });
    const transformed = transformElaborationModule(parsed, { testContextName: 't' });
    const callStart = text.indexOf('Arithmetic(');
    const callEnd = text.indexOf(';', callStart);
    const useSpan = { fileId: parsed.id, start: callStart, end: callEnd };
    const program = {
      ...transformed,
      code: `const amount = ${transformed.runtimeParameter}.declareBlueprintNumberParameter(
  'amount', 4, undefined, { start: 0, end: 1 }
);\n${transformed.code}`,
    };
    const execution = executeElaborationProgramWithParameters(program, exactEnvironment());

    expect(execution.plan.producers).toHaveLength(1);
    expect(execution.plan.producers[0]).toMatchObject({
      kind: 'arithmetic',
      left: { kind: 'constant', value: 2 },
      operation: 'add',
      right: { kind: 'constant', value: 4 },
      output: { kind: 'signal', signal: { type: 'virtual', name: 'signal-A' } },
    });
    expect(execution.parameters).toHaveLength(1);
    const captureId = execution.plan.producers[0]?.debugCaptureIds?.[0];
    expect(captureId).toEqual(expect.any(String));
    expect(execution).toHaveProperty('arithmeticTemplates');
    const templates = (
      execution as unknown as {
        readonly arithmeticTemplates: readonly {
          readonly captureId: string;
          readonly template: { readonly right: unknown };
          readonly source: unknown;
        }[];
      }
    ).arithmeticTemplates;
    expect(templates).toHaveLength(1);
    expect(templates[0]).toMatchObject({
      captureId,
      template: { right: { kind: 'constant', value: execution.parameters[0]!.handle } },
      source: useSpan,
    });
  });

  test('captures distinct host-local templates for repeated producers in one function', () => {
    const text = `
const A = Signal('virtual', 'signal-A');
function AddMany() {
  const producers = [];
  for (let index = 0; index < 2; index += 1) {
    const exact = Arithmetic({ left: 2, operation: 'add', right: amount, output: A });
    const sink = new Network();
    sink += exact;
    producers.push(exact);
  }
  return producers;
}
const dut = t.instantiate(AddMany);`;
    const parsed = parseFile({ path: sourceFile, text });
    const transformed = transformElaborationModule(parsed, { testContextName: 't' });
    const execution = executeElaborationProgramWithParameters(
      {
        ...transformed,
        code: `const amount = ${transformed.runtimeParameter}.declareBlueprintNumberParameter(
  'amount', 4, undefined, { start: 0, end: 1 }
);\n${transformed.code}`,
      },
      exactEnvironment(),
    );

    const captureIds = execution.plan.producers.map((producer) => producer.debugCaptureIds?.[0]);
    expect(captureIds).toHaveLength(2);
    expect(new Set(captureIds).size).toBe(2);
    expect(execution.plan.producers.map((producer) => producer.debugCaptureIds)).toEqual([
      ['producer:1', 'producer:3'],
      ['producer:2', 'producer:4'],
    ]);
    expect(execution.arithmeticTemplates).toHaveLength(2);
    expect(execution.arithmeticTemplates.map(({ captureId }) => captureId)).toEqual(captureIds);
    expect(Object.isFrozen(execution.arithmeticTemplates)).toBe(true);
    for (const record of execution.arithmeticTemplates) {
      expect(Object.isFrozen(record)).toBe(true);
      expect(Object.isFrozen(record.template)).toBe(true);
    }
  });

  test.each(['left', 'right'] as const)(
    'normalizes a direct source number slot in the %s operand to its default',
    (slot) => {
      const left = slot === 'left' ? 'amount' : '2';
      const right = slot === 'right' ? 'amount' : '3';
      const execution = executeWithParameter(`
const A = Signal('virtual', 'signal-A');
const exact = Arithmetic({ left: ${left}, operation: 'add', right: ${right}, output: A });
const sink = new Network();
sink += exact;`);

      expect(execution.plan.producers[0]).toMatchObject({
        kind: 'arithmetic',
        left: { kind: 'constant', value: slot === 'left' ? 4 : 2 },
        operation: 'add',
        right: { kind: 'constant', value: slot === 'right' ? 4 : 3 },
      });
      expect(execution.arithmeticTemplates).toHaveLength(1);
      expect(execution.arithmeticTemplates[0]?.captureId).toBe(
        execution.plan.producers[0]?.debugCaptureIds?.[0],
      );
    },
  );

  test('normalizes one number handle used in both direct constant slots', () => {
    const execution = executeWithParameter(`
const A = Signal('virtual', 'signal-A');
const exact = Arithmetic({ left: amount, operation: 'add', right: amount, output: A });
const sink = new Network();
sink += exact;`);

    expect(execution.plan.producers[0]).toMatchObject({
      kind: 'arithmetic',
      left: { kind: 'constant', value: 4 },
      right: { kind: 'constant', value: 4 },
    });
    expect(execution.arithmeticTemplates).toHaveLength(1);
    expect(execution.arithmeticTemplates[0]?.captureId).toBe(
      execution.plan.producers[0]?.debugCaptureIds?.[0],
    );
  });

  test('rejects a non-circuit-integer parameter default at the Arithmetic use', () => {
    expectArithmeticUseFailure(
      `const A = Signal('virtual', 'signal-A');
const exact = Arithmetic({ left: 2, operation: 'add', right: amount, output: A });`,
      'safe integers before int32 normalization',
      (runtimeParameter) =>
        `const amount = ${runtimeParameter}.declareBlueprintNumberParameter('amount', Number.MAX_SAFE_INTEGER + 1, undefined, { start: 0, end: 1 });`,
    );
  });

  test('rejects wrong-kind, foreign-session, and forged direct parameter slots at the call span', () => {
    const wrongKind = `const A = Signal('virtual', 'signal-A');
const exact = Arithmetic({ left: 2, operation: 'add', right: amount, output: A });`;
    const wrongKindError = (() => {
      try {
        executeWithParameter(
          wrongKind,
          (runtimeParameter) => `
const source = ${runtimeParameter}.signal('virtual', 'signal-parameter', { start: 0, end: 1 });
const amount = ${runtimeParameter}.declareBlueprintSignalParameter('signal slot', source, undefined, { start: 0, end: 1 });`,
        );
      } catch (error) {
        return error;
      }
      return undefined;
    })();
    const wrongKindSpan = (() => {
      const parsed = parseFile({ path: sourceFile, text: wrongKind });
      const start = wrongKind.indexOf('Arithmetic(');
      return { fileId: parsed.id, start, end: wrongKind.indexOf(');', start) + 1 };
    })();
    expect(wrongKindError).toMatchObject({ code: 'RT2027', span: wrongKindSpan });
    expect(wrongKindError).toHaveProperty(
      'message',
      expect.stringContaining('expected a number parameter, received signal'),
    );

    const foreignKey = Symbol.for('comblang.test.foreign-blueprint-number');
    const forgedKey = Symbol.for('comblang.test.forged-blueprint-number');
    const globalRecord = globalThis as Record<PropertyKey, unknown>;
    const oldForeign = globalRecord[foreignKey];
    const oldForged = globalRecord[forgedKey];
    const hadForeign = Object.hasOwn(globalRecord, foreignKey);
    const hadForged = Object.hasOwn(globalRecord, forgedKey);
    globalRecord[foreignKey] = createBlueprintParameterSession().number('foreign', {
      defaultValue: 4,
    });
    globalRecord[forgedKey] = { kind: 'number', label: 'forged', defaultValue: 4 };
    try {
      const invalidSlots: readonly (readonly [string, string])[] = [
        [
          'comblang.test.foreign-blueprint-number',
          'parameter belongs to a different parameter session',
        ],
        ['comblang.test.forged-blueprint-number', 'unregistered parameter-like object'],
      ];
      for (const [key, message] of invalidSlots) {
        const text = `const A = Signal('virtual', 'signal-A');
const exact = Arithmetic({ left: 2, operation: 'add', right: globalThis[Symbol.for('${key}')], output: A });`;
        expectArithmeticUseFailure(text, message);
      }
    } finally {
      if (hadForeign) globalRecord[foreignKey] = oldForeign;
      else delete globalRecord[foreignKey];
      if (hadForged) globalRecord[forgedKey] = oldForged;
      else delete globalRecord[forgedKey];
    }
  });

  test('rolls back a caught invalid slot before capturing the following valid producer', () => {
    const text = `
const A = Signal('virtual', 'signal-A');
const input = new Network();
function Add(source: Network) {
  try {
    Arithmetic({ left: 2, operation: 'add', right: invalidAmount, output: A });
  } catch (error) {
    const caught = true;
  }
  const exact = Arithmetic({ left: source[A], operation: 'add', right: amount, output: A });
  const sink = new Network();
  sink += exact;
  return exact;
}
const dut = t.instantiate(Add, input);`;
    const parsed = parseFile({ path: sourceFile, text });
    const transformed = transformElaborationModule(parsed, { testContextName: 't' });
    const environment = exactEnvironment();
    const execution = executeElaborationProgramWithParameters(
      {
        ...transformed,
        code: `const invalidAmount = ${transformed.runtimeParameter}.declareBlueprintNumberParameter(
  'invalid', Number.MAX_SAFE_INTEGER + 1, undefined, { start: 0, end: 1 }
);
const amount = ${transformed.runtimeParameter}.declareBlueprintNumberParameter(
  'amount', 4, undefined, { start: 0, end: 1 }
);\n${transformed.code}`,
      },
      environment,
    );

    expect(execution.plan.producers).toHaveLength(1);
    const producer = execution.plan.producers[0]!;
    const record = execution.arithmeticTemplates[0]!;
    expect(producer).toMatchObject({
      kind: 'arithmetic',
      left: {
        kind: 'signal',
        refKind: 'single',
        network: 'input',
        signal: signal('virtual', 'signal-A'),
      },
      right: { kind: 'constant', value: 4 },
      instancePath: expect.arrayContaining(['DUT dut']),
    });
    expect(execution.arithmeticTemplates).toHaveLength(1);
    expect(record.captureId).toBe(producer.debugCaptureIds?.[0]);
    expect(record.source).toEqual(producer.source);
    expect(Object.isFrozen(record.source)).toBe(true);
    const registration = inspectArithmeticConfigurationTemplate(record.template, '$.template');
    expect(registration.session).toBe(execution.session);
    expect(registration.usedParameters).toEqual([execution.parameters[1]!.handle]);
    expect(record.template.left).toEqual({
      kind: 'signal',
      refKind: 'single',
      network: 'input',
      signal: signal('virtual', 'signal-A'),
    });
    expect(record.template.right).toEqual({
      kind: 'constant',
      value: execution.parameters[1]!.handle,
    });
    const lowered = tryElaborateDirectPlan(execution.plan, environment.context);
    expect(lowered.diagnostics).toEqual([]);
    const bound = bindCapturedSourceArithmeticTemplates(execution, lowered.execution!, [
      { parameter: execution.parameters[1]!.handle, value: 7 },
    ]);
    expect(bound.producers).toHaveLength(1);
    expect(bound.producers[0]).toMatchObject({
      kind: 'arithmetic',
      config: { right: { kind: 'constant', value: 7 } },
    });
  });

  test('rolls back templates and capture IDs from a failed t.instantiate before the next producer', () => {
    const parsed = parseFile({
      path: sourceFile,
      text: `
const A = Signal('virtual', 'signal-A');
function Bad() {
  const exact = Arithmetic({ left: 2, operation: 'add', right: amount, output: A });
  const sink = new Network();
  sink += exact;
  return [exact, () => {}];
}
try {
  const failed = t.instantiate(Bad);
} catch (error) {
  const caught = true;
}
const exact = Arithmetic({ left: 3, operation: 'add', right: amount, output: A });
const sink = new Network();
sink += exact;`,
    });
    const transformed = transformElaborationModule(parsed, { testContextName: 't' });
    const execution = executeElaborationProgramWithParameters(
      {
        ...transformed,
        code: `const amount = ${transformed.runtimeParameter}.declareBlueprintNumberParameter(
  'amount', 4, undefined, { start: 0, end: 1 }
);\n${transformed.code}`,
      },
      exactEnvironment(),
    );

    expect(execution.plan.producers).toHaveLength(1);
    expect(execution.plan.producers[0]?.debugCaptureIds).toEqual(['producer:1']);
    expect(execution.arithmeticTemplates).toHaveLength(1);
    expect(execution.arithmeticTemplates[0]?.captureId).toBe('producer:1');
    expect(execution.arithmeticTemplates[0]?.template.right).toEqual({
      kind: 'constant',
      value: execution.parameters[0]!.handle,
    });
  });

  test('does not retain a nested debug instance when its outer instance rolls back', () => {
    const parsed = parseFile({
      path: sourceFile,
      text: `
const A = Signal('virtual', 'signal-A');
function Inner() {
  const exact = Arithmetic({ left: 2, operation: 'add', right: amount, output: A });
  const sink = new Network();
  sink += exact;
  return exact;
}
function Outer() {
  const nested = t.instantiate(Inner);
  return [nested, () => {}];
}
try {
  const failed = t.instantiate(Outer);
} catch (error) {
  const caught = true;
}
const valid = t.instantiate(Inner);`,
    });
    const transformed = transformElaborationModule(parsed, { testContextName: 't' });
    const execution = executeElaborationProgramWithParameters(
      {
        ...transformed,
        code: `const amount = ${transformed.runtimeParameter}.declareBlueprintNumberParameter(
  'amount', 4, undefined, { start: 0, end: 1 }
);\n${transformed.code}`,
      },
      exactEnvironment(),
    );

    expect(execution.plan.producers).toHaveLength(1);
    expect(execution.arithmeticTemplates).toHaveLength(1);
    expect(execution.plan.debugInstances).toHaveLength(1);
    expect(execution.plan.debugInstances?.[0]?.name).toBe('valid');
  });

  test('withholds a previously created symbolic producer after an uncaught failure', () => {
    const parsed = parseFile({
      path: sourceFile,
      text: `
const A = Signal('virtual', 'signal-A');
function Add() {
  const exact = Arithmetic({ left: 2, operation: 'add', right: amount, output: A });
  const sink = new Network();
  sink += exact;
  throw new Error('failure after symbolic producer');
}
const dut = t.instantiate(Add);`,
    });
    const transformed = transformElaborationModule(parsed, { testContextName: 't' });
    const program = {
      ...transformed,
      code: `const amount = ${transformed.runtimeParameter}.declareBlueprintNumberParameter(
  'amount', 4, undefined, { start: 0, end: 1 }
);\n${transformed.code}`,
    };

    expect(() => executeElaborationProgramWithParameters(program, exactEnvironment())).toThrow(
      'failure after symbolic producer',
    );
  });

  test('does not substitute source number handles into operator sugar or JavaScript control flow', () => {
    expect(() =>
      executeWithParameter(`
const input = new Network();
const output = new Network();
output += input + amount;`),
    ).toThrow('Circuit arithmetic currently requires a Network or numeric operand.');

    expect(() => executeWithParameter('if (amount) {}')).toThrow(
      'cannot be used as a JavaScript control-flow value',
    );
  });

  test('keeps parameter templates outside direct, canonical, linked Entity and resolved data', () => {
    const environment = exactEnvironment();
    const parsed = parseFile({
      path: sourceFile,
      text: `
const A = Signal('virtual', 'signal-A');
function Add() {
  const exact = Arithmetic({ left: 2, operation: 'add', right: amount, output: A });
  const sink = new Network();
  sink += exact;
  return exact;
}
const dut = t.instantiate(Add);`,
    });
    const transformed = transformElaborationModule(parsed, { testContextName: 't' });
    const execution = executeElaborationProgramWithParameters(
      {
        ...transformed,
        code: `const amount = ${transformed.runtimeParameter}.declareBlueprintNumberParameter(
  'amount', 4, undefined, { start: 0, end: 1 }
);\n${transformed.code}`,
      },
      environment,
    );
    const lowered = tryElaborateDirectPlan(execution.plan, environment.context);

    expect(execution.arithmeticTemplates).toHaveLength(1);
    expect(execution.plan).not.toHaveProperty('arithmeticTemplates');
    expect(execution.plan.producers[0]).toMatchObject({
      kind: 'arithmetic',
      right: { kind: 'constant', value: 4 },
    });
    expect(execution.plan.entities[0]?.configuration).toMatchObject({ mode: 'arithmetic' });
    expect(lowered.diagnostics).toEqual([]);
    expect(lowered.resolvedCircuit?.format).toBe('comblang-resolved-circuit');
    expect(lowered.resolvedCircuit?.ir.entities[0]?.configuration).toMatchObject({
      mode: 'arithmetic',
    });

    const serialized = JSON.stringify({
      plan: execution.plan,
      canonicalExecution: lowered.execution?.circuit,
      resolvedCircuit: lowered.resolvedCircuit,
    });
    expect(serialized).not.toContain('amount');
    expect(serialized).not.toContain('arithmeticTemplates');
    expect(serialized).not.toContain('"kind":"number"');
  });

  test.each(operations)('accepts canonical operation %s', (operation) => {
    const plan = exactPlan(`const A = Signal('virtual', 'signal-A');
const exact: ArithmeticCombinator = Arithmetic({ left: 2, operation: '${operation}', right: 3, output: A });
const output = new Network();
output += exact;`);

    expect(plan.producers).toHaveLength(1);
    expect(plan.producers[0]).toMatchObject({
      kind: 'arithmetic',
      entityId: expect.any(String),
      operation,
      left: { kind: 'constant', value: 2 },
      right: { kind: 'constant', value: 3 },
    });
    expect(plan.entities).toHaveLength(1);
  });

  test.each([
    {
      name: 'signal selection',
      prelude: 'const input = new Network();',
      left: 'input[A]',
      expected: { kind: 'signal', refKind: 'single', network: 'input' },
    },
    {
      name: 'bare Network',
      prelude: 'const input = new Network();',
      left: 'input',
      expected: { kind: 'each', refKind: 'single', network: 'input' },
    },
    {
      name: 'Pair',
      prelude: `const red: Network<R> = new Network<R>();
const green: Network<G> = new Network<G>();`,
      left: 'pair(red, green)',
      expected: { kind: 'each', refKind: 'pair', networks: ['red', 'green'] },
    },
    {
      name: 'Combinator',
      prelude: `const input = new Network();
const source: ArithmeticCombinator = input + 1;`,
      left: 'source',
      expected: { kind: 'each', refKind: 'single', network: '$combinator:1:primary' },
    },
    {
      name: 'selected Each',
      prelude: 'const input = new Network();',
      left: 'Each(input)',
      expected: { kind: 'each', refKind: 'single', network: 'input' },
    },
  ])('accepts $name operands through executed source', ({ prelude, left, expected }) => {
    const plan = exactPlan(`const A = Signal('virtual', 'signal-A');
${prelude}
const exact: ArithmeticCombinator = Arithmetic({ left: ${left}, operation: 'add', right: 2, output: A });
const output = new Network();
output += exact;`);
    const producer = plan.producers.at(-1)!;

    expect(producer.kind).toBe('arithmetic');
    if (producer.kind === 'arithmetic') expect(producer.left).toMatchObject(expected);
  });

  test('accepts dynamic config returns, generated exact calls, Each output, and int32 bounds', () => {
    const plan = exactPlan(`const A = Signal('virtual', 'signal-A');
const input = new Network();
function makeConfig(operation: string) {
  return { left: 2, operation, right: 2147483648, output: EACH };
}
const output = new Network();
const dynamic: ArithmeticCombinator = Arithmetic(makeConfig('add'));
output += dynamic;
for (let index = 0; index < 2; index++) {
  const exact: ArithmeticCombinator = Arithmetic({ left: index === 0 ? input[A] : Each(input), operation: 'add', right: 2147483648, output: EACH });
  output += exact;
}`);

    expect(plan.producers).toHaveLength(3);
    expect(plan.entities).toHaveLength(3);
    expect(plan.producers).toMatchObject([
      {
        kind: 'arithmetic',
        left: { kind: 'constant', value: 2 },
        right: { kind: 'constant', value: -2147483648 },
        output: { kind: 'each' },
      },
      {
        kind: 'arithmetic',
        left: { kind: 'signal' },
        right: { kind: 'constant', value: -2147483648 },
        output: { kind: 'each' },
      },
      {
        kind: 'arithmetic',
        left: { kind: 'each' },
        right: { kind: 'constant', value: -2147483648 },
        output: { kind: 'each' },
      },
    ]);
    expect(plan.producers.slice(1).map(({ instancePath }) => instancePath.at(-1))).toEqual([
      'for index=0',
      'for index=1',
    ]);
  });

  test.each([
    {
      name: 'Anything operand',
      config: '{ left: Anything(input), operation: "add", right: 2, output: A }',
      message: 'Anything/Everything',
    },
    {
      name: 'Everything operand',
      config: '{ left: Everything(input), operation: "add", right: 2, output: A }',
      message: 'Anything/Everything',
    },
    {
      name: 'unsafe number',
      config: '{ left: 1.5, operation: "add", right: 2, output: A }',
      message: 'safe integers',
    },
    {
      name: 'string operand',
      config: '{ left: "input", operation: "add", right: 2, output: A }',
      message: 'Circuit arithmetic',
    },
    {
      name: 'missing output',
      config: '{ left: input[A], operation: "add", right: 2 }',
      message: 'missing required field',
    },
    {
      name: 'unknown key',
      config: '{ left: input[A], operation: "add", right: 2, output: A, extra: true }',
      message: 'exactly left, operation, right, and output',
    },
    {
      name: 'selected output',
      config: '{ left: input[A], operation: "add", right: 2, output: input[A] }',
      message: 'output must be a concrete Signal',
    },
  ])('rejects $name with a located runtime diagnostic', ({ config, message }) => {
    const text = `const A = Signal('virtual', 'signal-A');
const input = new Network();
const exact = Arithmetic(${config});`;
    const error = failureFor(text);

    expect(error).toMatchObject({ code: 'RT2027', span: expect.any(Object) });
    expect(error.message).toContain(message);
    expect(error.span.start).toBeLessThan(error.span.end);
    expect(text.slice(error.span.start, error.span.end)).toContain('left');
  });

  test('preserves exact placement, .to, selected free destination, and two output lanes', () => {
    const plan = exactPlan(`const A = Signal('virtual', 'signal-A');
const input = new Network();
const exact: ArithmeticCombinator = Arithmetic({ left: input[A], operation: 'add', right: 2, output: A }).at(3.5, -1, 8);
const first = new Network();
const second = new Network();
exact.to(first);
to(second)[A] += exact;`);
    const producer = plan.producers[0]!;

    expect(producer).toMatchObject({
      kind: 'arithmetic',
      entityId: expect.any(String),
      destinations: [{}, {}],
    });
    expect(producer).not.toHaveProperty('placement');
    expect(plan.entities[0]).toMatchObject({
      placement: { x: 3.5, y: -1, direction: 8 },
    });
  });

  test('retains CL2001 for an unused exact result', () => {
    const plan = exactPlan(`const A = Signal('virtual', 'signal-A');
const input = new Network();
const exact: ArithmeticCombinator = Arithmetic({ left: input[A], operation: 'add', right: 2, output: A });`);

    expect(plan.producers).toHaveLength(1);
    expect(plan.diagnostics).toContainEqual(
      expect.objectContaining({ code: 'CL2001', severity: 'warning' }),
    );
  });

  test('keeps ergonomic Arithmetic without a provider and upgrades it with one', () => {
    const source = `const input = new Network();
const output = new Network();
output += input + 1;`;
    const profileFree = executeElaborationProgram(
      transformElaborationModule(parseFile({ path: sourceFile, text: source })),
    );
    expect(profileFree).not.toHaveProperty('version');
    expect(profileFree.producers[0]).not.toHaveProperty('entityId');

    const environment = exactEnvironment();
    const providerBacked = executeElaborationProgram(
      transformElaborationModule(parseFile({ path: sourceFile, text: source })),
      environment,
    );
    expect(providerBacked).not.toHaveProperty('version');
    expect(providerBacked.producers[0]).toMatchObject({
      kind: 'arithmetic',
      entityId: expect.any(String),
    });
    expect(providerBacked.entities).toHaveLength(1);
  });

  test('keeps mixed linked Constant and Arithmetic one Entity per producer in preview', () => {
    const environment = exactEnvironment();
    const plan = exactPlan(
      `const A = Signal('virtual', 'signal-A');
const input = new Network();
const exact: ArithmeticCombinator = Arithmetic({ left: input[A], operation: 'multiply', right: 2, output: A });
const constant: ConstantCombinator = Constant({ sections: [] });
const output = new Network();
output += exact;
output += constant;`,
      environment,
    );
    const lowered = tryElaborateDirectPlan(plan, environment.context);

    expect(lowered.diagnostics).toEqual([]);
    expect(lowered.execution?.circuit.ir.entities).toHaveLength(2);
    expect(new Set(plan.producers.map(({ entityId }) => entityId)).size).toBe(2);
    const blueprint = generateBlueprintJson(lowered.execution!.circuit.ir).blueprint;
    expect(blueprint.entities).toHaveLength(2);
    expect(blueprint.entities.map(({ name }) => name)).toEqual([
      'arithmetic-combinator',
      'constant-combinator',
    ]);
  });

  test('preserves an unrelated structural Entity configuration beside linked computation', () => {
    const environment = exactEnvironment(true);
    const plan = exactPlan(
      `const A = Signal('virtual', 'signal-A');
const structural = Entity('entity:synthetic-structural', { raw: {} });
const input = new Network();
const exact: ArithmeticCombinator = Arithmetic({ left: input[A], operation: 'add', right: 2, output: A });
const output = new Network();
output += exact;`,
      environment,
    );
    const structuralEntity = plan.entities.find(
      ({ profile }) => profile.prototypeKey === 'entity:synthetic-structural',
    );

    expect(structuralEntity?.configuration).toEqual({ mode: 'raw', payload: {} });
    const lowered = tryElaborateDirectPlan(plan, environment.context);
    expect(lowered.diagnostics).toEqual([]);
    expect(
      lowered.execution?.circuit.ir.entities.find(
        ({ profile }) => profile.prototypeKey === 'entity:synthetic-structural',
      )?.configuration,
    ).toEqual({ mode: 'raw', payload: {} });
  });

  test('binds a captured source Arithmetic slot into its matching canonical execution', () => {
    const environment = exactEnvironment();
    const text = `
const A = Signal('virtual', 'signal-A');
const input = new Network();
function Add(source: Network) {
  const exact: ArithmeticCombinator = Arithmetic({ left: source[A], operation: 'add', right: amount, output: A });
  const sink = new Network();
  sink += exact;
  return exact;
}
const dut = t.instantiate(Add, input);
const output = new Network();
output += dut.value;`;
    const parsed = parseFile({ path: sourceFile, text });
    const transformed = transformElaborationModule(parsed, { testContextName: 't' });
    const sourceExecution = executeElaborationProgramWithParameters(
      {
        ...transformed,
        code: `const amount = ${transformed.runtimeParameter}.declareBlueprintNumberParameter(
  'amount', 4, undefined, { start: 0, end: 1 }
);\n${transformed.code}`,
      },
      environment,
    );
    const lowered = tryElaborateDirectPlan(sourceExecution.plan, environment.context);

    expect(lowered.diagnostics).toEqual([]);
    expect(sourceExecution.arithmeticTemplates).toHaveLength(1);
    const canonicalExecution = lowered.execution!;
    const defaultCircuit = bindCapturedSourceArithmeticTemplates(
      sourceExecution,
      canonicalExecution,
    );
    const originalIr = canonicalExecution.circuit.ir;
    const originalProducer = originalIr.producers.find(({ kind }) => kind === 'arithmetic')!;
    const originalEntity = originalIr.entities.find(
      ({ id }) => id === sourceExecution.plan.producers[0]?.entityId,
    )!;
    const boundCircuit = bindCapturedSourceArithmeticTemplates(
      sourceExecution,
      canonicalExecution,
      [{ parameter: sourceExecution.parameters[0]!.handle, value: 7 }],
    );
    const boundProducer = boundCircuit.producers.find(({ kind }) => kind === 'arithmetic')!;
    const boundEntity = boundCircuit.entities.find(({ id }) => id === originalEntity.id)!;

    expect(defaultCircuit).toEqual(originalIr);
    expect(boundCircuit.networks.map(({ id }) => id)).toEqual(
      originalIr.networks.map(({ id }) => id),
    );
    expect(boundCircuit.producers.map(({ id }) => id)).toEqual(
      originalIr.producers.map(({ id }) => id),
    );
    expect(boundCircuit.entities.map(({ id }) => id)).toEqual(
      originalIr.entities.map(({ id }) => id),
    );
    expect(originalProducer).toMatchObject({
      kind: 'arithmetic',
      config: { right: { kind: 'constant', value: 4 } },
    });
    expect(boundProducer).toMatchObject({
      kind: 'arithmetic',
      config: { right: { kind: 'constant', value: 7 } },
    });
    expect(originalEntity.configuration).toMatchObject({
      mode: 'arithmetic',
      right: { kind: 'constant', value: 4 },
    });
    expect(boundEntity.configuration).toMatchObject({
      mode: 'arithmetic',
      right: { kind: 'constant', value: 7 },
    });
    const boundBlueprint = generateBlueprintJson(boundCircuit);
    const serializedBlueprint = JSON.stringify(boundBlueprint);
    expect(serializedBlueprint).not.toContain('arithmeticTemplates');
    expect(serializedBlueprint).not.toContain('amount');
    expect(serializedBlueprint).not.toContain('"kind":"number"');

    const inputNetwork = canonicalExecution.network('input').id;
    const outputNetwork = canonicalExecution.network('output').id;
    const simulated = (ir: typeof originalIr) =>
      createSimulationFromNativeCircuitIr(ir, [
        { network: inputNetwork, values: new SparseBus([[signal('virtual', 'signal-A'), 3]]) },
      ])
        .step()
        .read(outputNetwork)
        .get(signal('virtual', 'signal-A'));
    expect(simulated(originalIr)).toBe(7);
    expect(simulated(boundCircuit)).toBe(10);
    expect(canonicalExecution.circuit.ir).toBe(originalIr);
    expect(sourceExecution.plan.producers[0]).toMatchObject({
      kind: 'arithmetic',
      right: { kind: 'constant', value: 4 },
    });
  });

  test('binds one shared source slot to each distinct dynamic Arithmetic producer', () => {
    const environment = exactEnvironment();
    const text = `
const A = Signal('virtual', 'signal-A');
const inputA = new Network();
const inputB = new Network();
function Add(source: Network) {
  const exact: ArithmeticCombinator = Arithmetic({ left: source[A], operation: 'add', right: amount, output: A });
  const sink = new Network();
  sink += exact;
  return exact;
}
const first = t.instantiate(Add, inputA);
const second = t.instantiate(Add, inputB);
const outputA = new Network();
const outputB = new Network();
outputA += first.value;
outputB += second.value;`;
    const parsed = parseFile({ path: sourceFile, text });
    const transformed = transformElaborationModule(parsed, { testContextName: 't' });
    const sourceExecution = executeElaborationProgramWithParameters(
      {
        ...transformed,
        code: `const amount = ${transformed.runtimeParameter}.declareBlueprintNumberParameter(
  'amount', 4, undefined, { start: 0, end: 1 }
);\n${transformed.code}`,
      },
      environment,
    );
    const lowered = tryElaborateDirectPlan(sourceExecution.plan, environment.context);
    expect(lowered.diagnostics).toEqual([]);
    const execution = lowered.execution!;
    const templates = sourceExecution.arithmeticTemplates;
    expect(templates).toHaveLength(2);
    expect(new Set(templates.map(({ captureId }) => captureId)).size).toBe(2);
    const bound = bindCapturedSourceArithmeticTemplates(sourceExecution, execution, [
      { parameter: sourceExecution.parameters[0]!.handle, value: 7 },
    ]);
    expect(bound.producers.filter(({ kind }) => kind === 'arithmetic')).toHaveLength(2);
    expect(
      bound.producers
        .filter((producer) => producer.kind === 'arithmetic')
        .map((producer) => (producer.kind === 'arithmetic' ? producer.config.right : undefined)),
    ).toEqual([
      { kind: 'constant', value: 7 },
      { kind: 'constant', value: 7 },
    ]);
    expect(new Set(bound.producers.map(({ id }) => id)).size).toBe(2);
    const simulate = (networkName: string, inputName: string, value: number) =>
      createSimulationFromNativeCircuitIr(bound, [
        {
          network: execution.network(inputName).id,
          values: new SparseBus([[signal('virtual', 'signal-A'), value]]),
        },
      ])
        .step()
        .read(execution.network(networkName).id)
        .get(signal('virtual', 'signal-A'));
    expect(simulate('outputA', 'inputA', 2)).toBe(9);
    expect(simulate('outputB', 'inputB', 5)).toBe(12);
  });

  test('rejects cross-plan executions, missing or duplicate captures, and incompatible bindings', () => {
    const environment = exactEnvironment();
    const text = `
const A = Signal('virtual', 'signal-A');
const input = new Network();
const exact: ArithmeticCombinator = Arithmetic({ left: input[A], operation: 'add', right: amount, output: A });
const output = new Network();
output += exact;`;
    const first = executeWithParameter(text);
    const second = executeWithParameter(text.replace("'amount', 4", "'amount', 5"));
    const firstExecution = tryElaborateDirectPlan(first.plan, environment.context).execution!;
    const secondExecution = tryElaborateDirectPlan(second.plan, environment.context).execution!;
    const capture = first.arithmeticTemplates[0]!;
    const originalIr = JSON.stringify(firstExecution.circuit.ir);
    const originalTemplate = capture.template;

    expect(() => bindCapturedSourceArithmeticTemplates(first, secondExecution)).toThrowError(
      expect.objectContaining({ code: 'CP1001', path: '$.execution' }),
    );
    const missingCapture = {
      ...first,
      arithmeticTemplates: [{ ...capture, captureId: 'producer:missing' }],
    };
    expect(() =>
      bindCapturedSourceArithmeticTemplates(missingCapture, firstExecution),
    ).toThrowError(
      expect.objectContaining({ code: 'CP1001', path: '$.arithmeticTemplates[0].captureId' }),
    );
    const duplicateCapture = {
      ...first,
      arithmeticTemplates: [capture, capture],
    };
    expect(() =>
      bindCapturedSourceArithmeticTemplates(duplicateCapture, firstExecution),
    ).toThrowError(
      expect.objectContaining({ code: 'CP1001', path: '$.arithmeticTemplates[1].captureId' }),
    );

    const missingNetworkTemplate = createArithmeticConfigurationTemplate(first.session, {
      left: {
        kind: 'signal',
        refKind: 'single',
        signal: signal('virtual', 'signal-A'),
        network: 'missing-network' as never,
      },
      operation: 'add',
      right: capture.template.right,
      output: capture.template.output,
    });
    const missingNetwork = {
      ...first,
      arithmeticTemplates: [{ ...capture, template: missingNetworkTemplate }],
    };
    expect(() =>
      bindCapturedSourceArithmeticTemplates(missingNetwork, firstExecution),
    ).toThrowError(
      expect.objectContaining({
        code: 'CP1001',
        path: '$.arithmeticTemplates[0].template.left.network',
      }),
    );

    expect(() =>
      bindCapturedSourceArithmeticTemplates(first, firstExecution, [
        { parameter: first.parameters[0]!.handle, value: Number.MAX_SAFE_INTEGER + 1 },
      ]),
    ).toThrowError(expect.objectContaining({ code: 'CP1000' }));

    const fixedFieldTemplate = createArithmeticConfigurationTemplate(first.session, {
      left: { kind: 'constant', value: 2 },
      operation: 'add',
      right: capture.template.right,
      output: capture.template.output,
    });
    const fixedFieldMismatch = {
      ...first,
      arithmeticTemplates: [{ ...capture, template: fixedFieldTemplate }],
    };
    expect(() =>
      bindCapturedSourceArithmeticTemplates(fixedFieldMismatch, firstExecution),
    ).toThrowError(expect.objectContaining({ code: 'CP1001' }));
    expect(JSON.stringify(firstExecution.circuit.ir)).toBe(originalIr);
    expect(first.arithmeticTemplates[0]?.template).toBe(originalTemplate);
    expect(first.parameters[0]?.handle).toBe(
      capture.template.right.kind === 'constant' ? capture.template.right.value : undefined,
    );
  });

  test('rejects a parameterized Arithmetic capture redirected to a different Producer kind', () => {
    const environment = exactEnvironment();
    const parsed = parseFile({
      path: sourceFile,
      text: `
const A = Signal('virtual', 'signal-A');
const input = new Network();
const exact: ArithmeticCombinator = Arithmetic({ left: input[A], operation: 'add', right: amount, output: A });
const arithmeticSink = new Network();
arithmeticSink += exact;
function MakeConstant() {
  const value: ConstantCombinator = Constant({ sections: [] });
  const sink = new Network();
  sink += value;
  return value;
}
const capturedConstant = t.instantiate(MakeConstant);`,
    });
    const transformed = transformElaborationModule(parsed, { testContextName: 't' });
    const sourceExecution = executeElaborationProgramWithParameters(
      {
        ...transformed,
        code: `const amount = ${transformed.runtimeParameter}.declareBlueprintNumberParameter(
  'amount', 4, undefined, { start: 0, end: 1 }
);\n${transformed.code}`,
      },
      environment,
    );
    const constantCapture = sourceExecution.plan.producers.find(({ kind }) => kind === 'constant')
      ?.debugCaptureIds?.[0];
    expect(constantCapture).toBeDefined();
    const redirected = {
      ...sourceExecution,
      arithmeticTemplates: sourceExecution.arithmeticTemplates.map((record) => ({
        ...record,
        captureId: constantCapture!,
      })),
    };
    const execution = tryElaborateDirectPlan(sourceExecution.plan, environment.context).execution!;
    expect(() => bindCapturedSourceArithmeticTemplates(redirected, execution)).toThrowError(
      expect.objectContaining({ code: 'CP1001', path: '$.arithmeticTemplates[0].captureId' }),
    );
  });

  test('binds a producer input even when source ownership moves afterward', () => {
    const environment = exactEnvironment();
    const parsed = parseFile({
      path: sourceFile,
      text: `
const A = Signal('virtual', 'signal-A');
function Pass(input: Move<Network>): Network { return input; }
const input = new Network();
const exact: ArithmeticCombinator = Arithmetic({ left: input[A], operation: 'add', right: amount, output: A });
const sink = new Network();
sink += exact;
const moved = Pass(input);`,
    });
    const transformed = transformElaborationModule(parsed);
    const sourceExecution = executeElaborationProgramWithParameters(
      {
        ...transformed,
        code: `const amount = ${transformed.runtimeParameter}.declareBlueprintNumberParameter(
  'amount', 4, undefined, { start: 0, end: 1 }
);\n${transformed.code}`,
      },
      environment,
    );
    const lowered = tryElaborateDirectPlan(sourceExecution.plan, environment.context);
    expect(lowered.diagnostics).toEqual([]);
    const bound = bindCapturedSourceArithmeticTemplates(sourceExecution, lowered.execution!, [
      { parameter: sourceExecution.parameters[0]!.handle, value: 7 },
    ]);
    expect(bound.producers[0]).toMatchObject({
      kind: 'arithmetic',
      config: { right: { kind: 'constant', value: 7 } },
    });
  });

  test('returns an unchanged circuit through the existing binder when no Arithmetic slots were captured', () => {
    const environment = exactEnvironment();
    const sourceExecution = executeWithParameter(`
const A = Signal('virtual', 'signal-A');
const exact: ArithmeticCombinator = Arithmetic({ left: 2, operation: 'add', right: 3, output: A });
const output = new Network();
output += exact;`);
    const lowered = tryElaborateDirectPlan(sourceExecution.plan, environment.context);
    expect(lowered.diagnostics).toEqual([]);
    expect(sourceExecution.arithmeticTemplates).toHaveLength(0);
    const bound = bindCapturedSourceArithmeticTemplates(sourceExecution, lowered.execution!);
    expect(bound).toEqual(lowered.execution!.circuit.ir);
  });
});

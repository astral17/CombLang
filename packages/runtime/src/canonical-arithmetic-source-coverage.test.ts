import {
  createTrustedEntityReplayContext,
  generateBlueprintJson,
  syntheticZeroPortEntityProfile,
  transformElaborationModule,
} from '@comblang/compiler';
import type { EntityId, EntityProfile } from '@comblang/compiler/entity';
import type { DirectElaborationPlan } from '@comblang/compiler/direct-plan-schema';
import { signal } from '@comblang/factorio';
import { parseFile, validateDslSemantics } from '@comblang/language';
import type { EntityPrototype } from '@comblang/prototypes';
import { sourceFileId } from '@comblang/shared';
import { describe, expect, test } from 'vitest';
import { tryElaborateDirectPlan } from './direct-plan.js';
import { ElaborationExecutionError, executeElaborationProgram } from './elaboration-program.js';

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
});

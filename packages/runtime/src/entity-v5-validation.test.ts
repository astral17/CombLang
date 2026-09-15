import { describe, expect, test } from 'vitest';
import { signal } from '@comblang/factorio';
import type { EntityId, EntityProfile } from '@comblang/compiler/entity';
import {
  createTrustedEntityReplayContext,
  entityReplayContextRef,
} from '@comblang/compiler/entity-replay-context';
import { syntheticZeroPortEntityProfile } from '@comblang/compiler/entity-fixtures';
import type { DirectElaborationPlanV5 } from '@comblang/compiler/entity-v5';
import { sourceFileId, sourceSpan } from '@comblang/shared';
import { validateEntityV5DirectPlan } from './entity-v5-validation.js';

const source = sourceSpan(sourceFileId('entity-v5-validation.ts'), 0, 1);

function profileFor(kind: 'arithmetic-combinator' | 'constant-combinator'): EntityProfile {
  return {
    ...structuredClone(syntheticZeroPortEntityProfile),
    ref: {
      ...syntheticZeroPortEntityProfile.ref,
      prototypeKey: `entity:fixture-${kind}`,
      profileId: `profile:fixture-${kind}-v5` as EntityProfile['ref']['profileId'],
    },
    prototypeType: kind,
  };
}

function contextFor(profiles: readonly EntityProfile[] = [profileFor('arithmetic-combinator')]) {
  return createTrustedEntityReplayContext({
    database: profiles[0]!.ref.database,
    source: 'synthetic',
    evidenceIdentity: 'v5-validation-evidence',
    policyIdentity: 'v5-validation-policy',
    profiles,
  });
}

function arithmeticPlan(context: ReturnType<typeof contextFor>): DirectElaborationPlanV5 {
  const profile = context.profiles[0]!;
  const configuration = {
    mode: 'arithmetic' as const,
    left: {
      kind: 'each' as const,
      refKind: 'pair' as const,
      networks: ['input-red', 'input-green'] as const,
    },
    operation: 'multiply' as const,
    right: { kind: 'constant' as const, value: 3 },
    output: { kind: 'signal' as const, signal: signal('virtual', 'signal-A') },
  };
  const { mode: _mode, ...producerConfiguration } = configuration;
  return {
    format: 'comblang-direct-plan',
    version: 5,
    context: entityReplayContextRef(context),
    networks: [
      { name: 'input-red', fixedColor: 'red', generation: 0, source, instancePath: ['input'] },
      { name: 'input-green', fixedColor: 'green', generation: 0, source, instancePath: ['input'] },
    ],
    producers: [
      {
        kind: 'arithmetic',
        entityId: 'entity:arithmetic' as EntityId,
        ...producerConfiguration,
        destinations: [],
        source,
        instancePath: ['Arithmetic'],
      },
    ],
    entities: [
      {
        id: 'entity:arithmetic' as EntityId,
        profile: profile.ref,
        configuration,
        connectorBindings: [],
        placement: { x: 1, y: 2 },
        provenance: {
          source,
          instancePath: ['Entity:arithmetic'],
          expansionStack: [],
          creationRevision: 1,
        },
        ordinal: 1,
      },
    ],
  };
}

function mixedPlan(context: ReturnType<typeof contextFor>): DirectElaborationPlanV5 {
  const arithmetic = arithmeticPlan(context);
  const constantProfile = context.profiles.find(
    ({ prototypeType }) => prototypeType === 'constant-combinator',
  )!;
  return {
    ...arithmetic,
    producers: [
      ...arithmetic.producers,
      {
        kind: 'constant',
        entityId: 'entity:constant' as EntityId,
        outputs: [],
        destinations: [],
        source,
        instancePath: ['Constant'],
      },
    ],
    entities: [
      ...arithmetic.entities,
      {
        id: 'entity:constant' as EntityId,
        profile: constantProfile.ref,
        configuration: { mode: 'constant', value: { isOn: true, sections: [] } },
        connectorBindings: [],
        placement: { x: 4, y: 5 },
        provenance: {
          source,
          instancePath: ['Entity:constant'],
          expansionStack: [],
          creationRevision: 2,
        },
        ordinal: 2,
      },
    ],
  };
}

describe('Entity v5 computation plan validation', () => {
  test('accepts mixed linked Constant and Arithmetic and returns an immutable canonical copy', () => {
    const context = contextFor([
      profileFor('arithmetic-combinator'),
      profileFor('constant-combinator'),
    ]);
    const input = mixedPlan(context);
    const before = structuredClone(input);
    const result = validateEntityV5DirectPlan(input, context);

    expect(result.diagnostics).toEqual([]);
    expect(result.value?.plan.version).toBe(5);
    expect(result.value?.plan.producers.map(({ kind }) => kind)).toEqual([
      'arithmetic',
      'constant',
    ]);
    expect(result.value?.plan.entities.map(({ configuration }) => configuration?.mode)).toEqual([
      'arithmetic',
      'constant',
    ]);
    expect(Object.isFrozen(result.value?.plan)).toBe(true);
    expect(Object.isFrozen(result.value?.plan.networks)).toBe(true);
    expect(Object.isFrozen(result.value?.plan.networks[0])).toBe(true);
    expect(Object.isFrozen(result.value?.plan.networks[0]?.instancePath)).toBe(true);
    const arithmetic = result.value?.plan.entities[0]?.configuration;
    if (arithmetic?.mode !== 'arithmetic') throw new Error('Expected Arithmetic configuration.');
    if (arithmetic.left.kind !== 'each' || arithmetic.left.refKind !== 'pair')
      throw new Error('Expected a pair Each operand.');
    if (arithmetic.output.kind !== 'signal') throw new Error('Expected a signal output.');
    expect(Object.isFrozen(arithmetic)).toBe(true);
    expect(Object.isFrozen(arithmetic.left)).toBe(true);
    expect(Object.isFrozen(arithmetic.left.networks)).toBe(true);
    expect(Object.isFrozen(arithmetic.output.signal)).toBe(true);
    expect(Object.isFrozen(result.value?.plan.entities[0]?.placement)).toBe(true);
    expect(Object.isFrozen(result.value?.plan.entities[0]?.provenance)).toBe(true);
    expect(Object.isFrozen(result.value?.plan.entities[0]?.provenance.instancePath)).toBe(true);
    expect(input).toEqual(before);
    expect(Object.isFrozen(input.entities[0]?.configuration)).toBe(false);
    expect(
      Object.isFrozen((input.entities[0]?.configuration as unknown as { left: object }).left),
    ).toBe(false);

    const callerOwned = input.entities[0]!.configuration as unknown as {
      left: { networks: [string, string] };
    };
    callerOwned.left.networks[0] = 'caller-mutated';
    expect(
      (arithmetic as unknown as { left: { networks: readonly [string, string] } }).left.networks[0],
    ).toBe('input-red');
    expect(Reflect.set(arithmetic.left as object, 'networks', 99)).toBe(false);
    expect(
      (arithmetic as unknown as { left: { networks: readonly [string, string] } }).left.networks[0],
    ).toBe('input-red');
  });

  test('rejects association, placement, family, and configuration drift before allocation', () => {
    const context = contextFor();
    const valid = arithmeticPlan(context);
    const first = (input: unknown) => validateEntityV5DirectPlan(input, context).diagnostics[0];

    const { entityId: _entityId, ...withoutAssociation } = valid.producers[0]!;
    expect(first({ ...valid, producers: [withoutAssociation] })).toMatchObject({
      code: 'RT5002',
      message: expect.stringContaining('must have one linked'),
    });
    expect(
      first({ ...valid, producers: [{ ...valid.producers[0], entityId: 'entity:missing' }] }),
    ).toMatchObject({
      code: 'RT5002',
      message: expect.stringContaining('does not exist'),
    });
    expect(
      first({ ...valid, producers: [{ ...valid.producers[0], placement: { x: 0, y: 0 } }] }),
    ).toMatchObject({
      code: 'RT5002',
      message: expect.stringContaining('must omit placement'),
    });
    expect(
      first({
        ...valid,
        entities: [
          {
            ...valid.entities[0],
            configuration: { ...valid.entities[0]!.configuration!, operation: 'add' },
          },
        ],
      }),
    ).toMatchObject({
      code: 'RT5003',
      message: expect.stringContaining('must equal'),
    });

    const wrongFamilyContext = contextFor([profileFor('constant-combinator')]);
    expect(
      validateEntityV5DirectPlan(arithmeticPlan(wrongFamilyContext), wrongFamilyContext)
        .diagnostics[0],
    ).toMatchObject({
      code: 'RT5002',
      message: expect.stringContaining('arithmetic-combinator'),
    });
    expect(
      first({ ...valid, entities: [...valid.entities, { ...valid.entities[0], ordinal: 2 }] }),
    ).toMatchObject({
      code: 'RT5002',
      message: expect.stringContaining('unique'),
    });
  });

  test('rejects linked Decider, unknown fields, accessors, stale context, and old envelopes', () => {
    const context = contextFor();
    const valid = arithmeticPlan(context);
    const producer = valid.producers[0]!;
    const decider = {
      kind: 'decider' as const,
      entityId: producer.entityId,
      condition: {
        kind: 'compare-each' as const,
        refKind: 'single' as const,
        network: 'input',
        comparator: '>' as const,
        constant: 0,
      },
      output: { kind: 'each-constant' as const, value: 1 },
      destinations: [],
      source,
      instancePath: ['Decider'],
    };
    expect(
      validateEntityV5DirectPlan({ ...valid, producers: [decider] }, context).diagnostics[0],
    ).toMatchObject({
      code: 'RT5002',
      message: expect.stringContaining('only Arithmetic or Constant'),
    });

    const rootWithUnknown = { ...valid, unexpected: true };
    expect(validateEntityV5DirectPlan(rootWithUnknown, context).diagnostics[0]).toMatchObject({
      code: 'RT5000',
    });

    const accessor = { ...valid } as Record<string, unknown>;
    Object.defineProperty(accessor, 'version', {
      enumerable: true,
      get: () => {
        throw new Error('must not execute');
      },
    });
    expect(validateEntityV5DirectPlan(accessor, context).diagnostics[0]).toMatchObject({
      code: 'RT5000',
    });

    expect(
      validateEntityV5DirectPlan({ ...valid, version: 4 }, context).diagnostics[0],
    ).toMatchObject({ code: 'RT1001' });
    expect(
      validateEntityV5DirectPlan(
        {
          ...valid,
          context: { ...valid.context, unexpected: true },
        },
        context,
      ).diagnostics[0],
    ).toMatchObject({ code: 'RT5000' });
    expect(
      validateEntityV5DirectPlan(
        {
          ...valid,
          context: { ...valid.context, policyIdentity: 'stale-policy' },
        },
        context,
      ).diagnostics[0],
    ).toMatchObject({ code: 'RT5001' });
  });
});

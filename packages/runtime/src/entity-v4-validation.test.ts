import { describe, expect, test } from 'vitest';
import { signal } from '@comblang/factorio';
import { sourceFileId, sourceSpan } from '@comblang/shared';
import type { EntityProfile } from '@comblang/compiler/entity';
import {
  createTrustedEntityReplayContext,
  entityReplayContextRef,
} from '@comblang/compiler/entity-replay-context';
import { syntheticZeroPortEntityProfile } from '@comblang/compiler/entity-fixtures';
import { validateEntityV4DirectPlan } from './entity-v4-validation.js';
import { validateEntityDirectPlan } from './entity-plan-validation.js';

const source = sourceSpan(sourceFileId('entity-v4.ts'), 0, 1);

function contextFor(profile: EntityProfile) {
  return createTrustedEntityReplayContext({
    database: profile.ref.database,
    source: 'synthetic',
    evidenceIdentity: 'v4-evidence',
    policyIdentity: 'v4-policy',
    profiles: [profile],
  });
}

function constantProfile(prototypeType: string | undefined = 'constant-combinator'): EntityProfile {
  return {
    ...structuredClone(syntheticZeroPortEntityProfile),
    ref: {
      ...syntheticZeroPortEntityProfile.ref,
      prototypeKey: 'entity:fixture-constant',
      profileId: 'profile:fixture-constant-v1' as EntityProfile['ref']['profileId'],
    },
    ...(prototypeType === undefined ? {} : { prototypeType }),
  };
}

function planFor(context: ReturnType<typeof contextFor>) {
  const profile = context.profiles[0]!;
  const configuration = {
    mode: 'constant' as const,
    value: { isOn: true, sections: [] },
  };
  return {
    format: 'comblang-direct-plan' as const,
    version: 4 as const,
    context: entityReplayContextRef(context),
    networks: [],
    producers: [
      {
        kind: 'constant' as const,
        entityId: 'entity:1',
        outputs: [],
        destinations: [],
        source,
        instancePath: ['Constant'],
      },
    ],
    entities: [
      {
        id: 'entity:1',
        profile: profile.ref,
        configuration,
        connectorBindings: [],
        placement: { x: 3, y: 4, direction: 8 },
        provenance: {
          source,
          instancePath: ['Entity:1'],
          expansionStack: [],
          creationRevision: 1,
        },
        ordinal: 1,
      },
    ],
  };
}

describe('Entity v4 computation plan validation', () => {
  test('accepts one exact Constant configuration association before allocation', () => {
    const context = contextFor(constantProfile());
    const result = validateEntityV4DirectPlan(planFor(context), context);

    expect(result.diagnostics).toEqual([]);
    expect(result.value?.plan.version).toBe(4);
    expect(result.value?.plan.producers[0]).toMatchObject({
      kind: 'constant',
      entityId: 'entity:1',
    });
    expect(result.value?.plan.entities[0]?.configuration).toEqual({
      mode: 'constant',
      value: { isOn: true, sections: [] },
    });
    expect(Object.isFrozen(result.value?.plan)).toBe(true);
  });

  test('rejects a placement on a linked producer, output drift, wrong family, and legacy identity', () => {
    const context = contextFor(constantProfile());
    const valid = planFor(context);

    expect(
      validateEntityV4DirectPlan(
        {
          ...valid,
          producers: [{ ...valid.producers[0], placement: { x: 0, y: 0 } }],
        },
        context,
      ).diagnostics[0],
    ).toMatchObject({ code: 'RT4002' });

    expect(
      validateEntityV4DirectPlan(
        {
          ...valid,
          producers: [
            {
              ...valid.producers[0],
              outputs: [{ signal: signal('virtual', 'signal-A'), value: 1 }],
            },
          ],
        },
        context,
      ).diagnostics[0],
    ).toMatchObject({ code: 'RT4003' });

    const wrongFamilyContext = contextFor(constantProfile('arithmetic-combinator'));
    expect(
      validateEntityV4DirectPlan(planFor(wrongFamilyContext), wrongFamilyContext).diagnostics[0],
    ).toMatchObject({ code: 'RT4002' });

    expect(
      validateEntityV4DirectPlan(
        {
          ...valid,
          context: { ...valid.context, profileSetIdentity: 'entity-profile-set-v1:legacy' },
        },
        context,
      ).diagnostics[0],
    ).toMatchObject({ code: 'RT4001' });
  });

  test('does not accept v3-shaped configured records as v4 computation', () => {
    const context = contextFor(constantProfile());
    const v3 = planFor(context);
    expect(validateEntityV4DirectPlan({ ...v3, version: 3 }, context).diagnostics[0]).toMatchObject(
      {
        code: 'RT1001',
        message: expect.stringContaining('version'),
      },
    );
  });

  test('uses the shared Constant evaluator for active, off, duplicate, zero, and quality values', () => {
    const context = contextFor(constantProfile());
    const valid = planFor(context);
    const configured = {
      ...valid,
      producers: [
        {
          ...valid.producers[0],
          outputs: [{ signal: signal('virtual', 'signal-B', 'normal'), value: 3 }],
        },
      ],
      entities: [
        {
          ...valid.entities[0],
          configuration: {
            mode: 'constant' as const,
            value: {
              isOn: true,
              sections: [
                {
                  active: false,
                  multiplier: 1,
                  filters: [{ signal: signal('virtual', 'signal-A'), value: 9 }],
                },
                {
                  active: true,
                  multiplier: 1,
                  filters: [
                    { signal: signal('virtual', 'signal-A'), value: 0 },
                    { signal: signal('virtual', 'signal-B', 'normal'), value: 3 },
                    { signal: signal('virtual', 'signal-B', 'normal'), value: 0 },
                  ],
                },
              ],
            },
          },
        },
      ],
    };
    expect(validateEntityV4DirectPlan(configured, context).diagnostics).toEqual([]);

    const unsupported = {
      ...valid,
      entities: [
        {
          ...valid.entities[0],
          configuration: {
            mode: 'constant' as const,
            value: {
              isOn: true,
              sections: [{ active: true, group: 'grouped', multiplier: 2, filters: [] }],
            },
          },
        },
      ],
    };
    expect(validateEntityV4DirectPlan(unsupported, context).diagnostics[0]).toMatchObject({
      code: 'RT4003',
      message: expect.stringContaining('unsupported Constant configuration'),
    });
  });

  test('rejects every invalid v4 association before a caller can allocate topology', () => {
    const context = contextFor(constantProfile());
    const valid = planFor(context);
    const first = (input: unknown) => validateEntityV4DirectPlan(input, context).diagnostics[0];

    expect(
      first({ ...valid, producers: [{ ...valid.producers[0], entityId: 'entity:missing' }] }),
    ).toMatchObject({ code: 'RT4002', message: expect.stringContaining('does not exist') });
    expect(
      first({ ...valid, producers: [...valid.producers, { ...valid.producers[0] }] }),
    ).toMatchObject({ code: 'RT4002', message: expect.stringContaining('at most one') });
    for (const kind of ['arithmetic', 'decider'] as const) {
      expect(first({ ...valid, producers: [{ kind, entityId: 'entity:1' }] })).toMatchObject({
        code: 'RT4002',
        message: expect.stringContaining('only a Constant'),
      });
    }
    const { configuration: _configuration, ...entityWithoutConfiguration } = valid.entities[0]!;
    expect(first({ ...valid, entities: [entityWithoutConfiguration] })).toMatchObject({
      code: 'RT4002',
      message: expect.stringContaining('must declare'),
    });
    const { entityId: _entityId, ...producerWithoutAssociation } = valid.producers[0]!;
    expect(first({ ...valid, producers: [producerWithoutAssociation] })).toMatchObject({
      code: 'RT4002',
      message: expect.stringContaining('must have one linked'),
    });
    expect(
      first({
        ...valid,
        entities: [
          {
            ...valid.entities[0],
            profile: { ...valid.entities[0]!.profile, profileId: 'profile:unknown' },
          },
        ],
      }),
    ).toMatchObject({
      code: expect.any(String),
    });

    const { prototypeType: _prototypeType, ...unknownFamilyProfile } = constantProfile();
    const unknownFamilyContext = contextFor(unknownFamilyProfile);
    expect(
      validateEntityV4DirectPlan(planFor(unknownFamilyContext), unknownFamilyContext)
        .diagnostics[0],
    ).toMatchObject({
      code: 'RT4002',
      message: expect.stringContaining('constant-combinator'),
    });
  });

  test('contains malformed v4 data as diagnostics and delegates bounded Constant input checks', () => {
    const context = contextFor(constantProfile());
    const valid = planFor(context);
    const diagnostic = (input: unknown) => {
      expect(() => validateEntityV4DirectPlan(input, context)).not.toThrow();
      return validateEntityV4DirectPlan(input, context).diagnostics[0];
    };
    for (const input of [
      { ...valid, extra: true },
      { ...valid, producers: [{ ...valid.producers[0], extra: true }] },
      { ...valid, entities: [{ ...valid.entities[0], extra: true }] },
      {
        ...valid,
        entities: [
          {
            ...valid.entities[0],
            configuration: { ...valid.entities[0]!.configuration, extra: true },
          },
        ],
      },
    ])
      expect(diagnostic(input)).toMatchObject({ code: 'RT4000' });

    const accessorProducer = { ...valid.producers[0] } as Record<string, unknown>;
    Object.defineProperty(accessorProducer, 'entityId', {
      enumerable: true,
      get: () => {
        throw new Error('must not execute');
      },
    });
    expect(diagnostic({ ...valid, producers: [accessorProducer] })).toMatchObject({
      code: 'RT4000',
    });
    const sparse = [] as unknown[];
    sparse.length = 1;
    expect(diagnostic({ ...valid, producers: sparse })).toMatchObject({ code: 'RT4000' });
    expect(diagnostic({ ...valid, producers: new Array(100_001) })).toMatchObject({
      code: 'RT4000',
    });

    for (const configuration of [
      { isOn: true, sections: [{ group: 'group', filters: [] }] },
      { isOn: true, sections: [{ multiplier: 2, filters: [] }] },
      { isOn: true, sections: Array.from({ length: 2048 }, () => ({ filters: [] })) },
      { isOn: true, sections: [{ group: 'x'.repeat(262_144), filters: [] }] },
    ]) {
      expect(
        diagnostic({
          ...valid,
          entities: [
            { ...valid.entities[0], configuration: { mode: 'constant', value: configuration } },
          ],
        }),
      ).toMatchObject({ code: expect.stringMatching(/^RT400[03]$/) });
    }
    const cyclic: { isOn: boolean; sections: unknown[] } = { isOn: true, sections: [] };
    cyclic.sections.push(cyclic);
    expect(
      diagnostic({
        ...valid,
        entities: [{ ...valid.entities[0], configuration: { mode: 'constant', value: cyclic } }],
      }),
    ).toMatchObject({ code: 'RT4000', message: expect.stringContaining('cycles are not allowed') });
  });

  test('keeps v2/v3 readers isolated from the v4 envelope without mutating old input', () => {
    const context = contextFor(constantProfile());
    const v4 = planFor(context);
    const snapshot = structuredClone(v4);
    expect(validateEntityDirectPlan(v4 as never, context).value).toBeUndefined();
    expect(validateEntityV4DirectPlan({ ...v4, version: 2 }, context).value).toBeUndefined();
    expect(v4).toEqual(snapshot);
  });
});

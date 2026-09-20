import { describe, expect, test } from 'vitest';
import type { EntityProfile } from '@comblang/compiler/entity';
import type { DirectElaborationPlanV7 } from '@comblang/compiler/entity-v7';
import { syntheticZeroPortEntityProfile } from '@comblang/compiler/entity-fixtures';
import {
  createTrustedEntityReplayContext,
  entityReplayContextRef,
} from '@comblang/compiler/entity-replay-context';
import type { EntityPrototype } from '@comblang/prototypes';

import type { EntityPrototypeResolver } from './entity-registry.js';
import { compileSourceProgram } from './source-compilation.js';
import { tryElaborateEntityV7DirectPlan, validateEntityV7DirectPlan } from './entity-v7.js';
import { hydrateResolvedEntityV7Circuit } from './resolved-entity-v7.js';

function fixture(): {
  context: ReturnType<typeof createTrustedEntityReplayContext>;
  plan: DirectElaborationPlanV7;
} {
  const prototypeKey = 'entity:selector-combinator' as EntityPrototype['key'];
  const profile: EntityProfile = {
    ...syntheticZeroPortEntityProfile,
    prototypeType: 'selector-combinator',
    ref: { ...syntheticZeroPortEntityProfile.ref, prototypeKey },
  };
  const prototype = {
    key: prototypeKey,
    name: 'selector-combinator',
    type: 'selector-combinator',
  } as EntityPrototype;
  const context = createTrustedEntityReplayContext({
    database: profile.ref.database,
    source: 'synthetic',
    evidenceIdentity: 'v7-validation-evidence',
    policyIdentity: 'v7-validation-policy',
    profiles: [profile],
  });
  const entityPrototypeResolver: EntityPrototypeResolver = {
    database: profile.ref.database,
    getEntity(nameOrKey) {
      return nameOrKey === prototype.key || nameOrKey === prototype.name ? prototype : undefined;
    },
  };
  const compilation = compileSourceProgram(
    {
      path: 'entity-v7-validation.factorio.ts',
      text: `const A = Signal('virtual', 'signal-A');
const input = new Network();
const output = new Network();
const selector: SelectorCombinator = Selector({ input, operation: 'count', output: A });
output += selector;`,
    },
    { trustedEntityReplayContext: context, entityPrototypeResolver },
  );
  if (compilation.pipelineDiagnostics.length > 0)
    throw new Error(compilation.pipelineDiagnostics[0]!.message);
  if (compilation.plan === undefined || compilation.plan.version !== 7)
    throw new Error('Expected a v7 fixture plan.');
  return { context, plan: compilation.plan };
}

function mixedFixture(kind: 'arithmetic' | 'decider') {
  const profileSpecs = [
    ['selector-combinator', 'selector-combinator', 'profile:v7-selector'],
    [
      kind === 'arithmetic' ? 'arithmetic-combinator' : 'decider-combinator',
      kind === 'arithmetic' ? 'arithmetic-combinator' : 'decider-combinator',
      `profile:v7-${kind}`,
    ],
  ] as const;
  const profiles = profileSpecs.map(([name, prototypeType, profileId]) => ({
    ...syntheticZeroPortEntityProfile,
    prototypeType,
    ref: {
      ...syntheticZeroPortEntityProfile.ref,
      prototypeKey: `entity:${name}` as EntityProfile['ref']['prototypeKey'],
      profileId: profileId as EntityProfile['ref']['profileId'],
    },
  }));
  const prototypes = profileSpecs.map(([name, type]) => ({
    key: `entity:${name}`,
    name,
    type,
  })) as EntityPrototype[];
  const context = createTrustedEntityReplayContext({
    database: profiles[0]!.ref.database,
    source: 'synthetic',
    evidenceIdentity: `v7-${kind}-evidence`,
    policyIdentity: `v7-${kind}-policy`,
    profiles,
  });
  const entityPrototypeResolver: EntityPrototypeResolver = {
    database: profiles[0]!.ref.database,
    getEntity(nameOrKey) {
      return prototypes.find(({ key, name }) => nameOrKey === key || nameOrKey === name);
    },
  };
  const computation =
    kind === 'arithmetic'
      ? `const arithmetic: ArithmeticCombinator = Arithmetic({ left: input[A], operation: 'add', right: 1, output: A });
output += arithmetic;`
      : `const decider: DeciderCombinator = Decider({ condition: input[A] > 0, outputs: input[A] });
output += decider;`;
  const compilation = compileSourceProgram(
    {
      path: `entity-v7-mixed-${kind}.factorio.ts`,
      text: `const A = Signal('virtual', 'signal-A');
const input = new Network();
const output = new Network();
${computation}
const selector: SelectorCombinator = Selector({ input, operation: 'count', output: A });
output += selector;`,
    },
    { trustedEntityReplayContext: context, entityPrototypeResolver },
  );
  if (compilation.pipelineDiagnostics.length > 0)
    throw new Error(compilation.pipelineDiagnostics[0]!.message);
  if (compilation.plan === undefined || compilation.plan.version !== 7)
    throw new Error('Expected a mixed v7 fixture plan.');
  if (compilation.resolvedCircuit?.format !== 'comblang-resolved-entity-v7')
    throw new Error('Expected a mixed resolved v7 fixture.');
  return { context, plan: compilation.plan, resolved: compilation.resolvedCircuit };
}

describe('Entity v7 validation', () => {
  test('accepts one exact linked Selector and returns an immutable copy', () => {
    const { context, plan } = fixture();
    const result = validateEntityV7DirectPlan(structuredClone(plan), context);

    expect(result.diagnostics).toEqual([]);
    expect(result.value?.plan.version).toBe(7);
    expect(result.value?.plan.entities[0]?.configuration).toMatchObject({
      mode: 'selector',
      operation: 'count',
    });
    expect(Object.isFrozen(result.value?.plan)).toBe(true);
    expect(Object.isFrozen(result.value?.plan.entities[0]?.configuration)).toBe(true);
  });

  test('rejects root drift, linked placement, and configuration drift before allocation', () => {
    const { context, plan } = fixture();
    const withRootDrift = { ...structuredClone(plan), unexpected: true };
    expect(validateEntityV7DirectPlan(withRootDrift, context).diagnostics[0]).toMatchObject({
      code: 'RT7000',
      message: expect.stringContaining('$.unexpected'),
    });

    const linkedPlacement = {
      ...structuredClone(plan),
      producers: [{ ...plan.producers[0]!, placement: { x: 1, y: 2 } }],
    } as DirectElaborationPlanV7;
    expect(validateEntityV7DirectPlan(linkedPlacement, context).diagnostics[0]).toMatchObject({
      code: 'RT7000',
      message: expect.stringContaining('must omit placement'),
    });

    const entity = plan.entities[0]!;
    const configurationDrift = {
      ...structuredClone(plan),
      entities: [
        {
          ...entity,
          configuration: {
            ...entity.configuration!,
            output: { type: 'virtual', name: 'signal-B' },
          },
        },
      ],
    } as DirectElaborationPlanV7;
    expect(validateEntityV7DirectPlan(configurationDrift, context).diagnostics[0]).toMatchObject({
      code: 'RT7000',
      message: expect.stringContaining('must equal'),
    });
  });

  test('requires exact Selector authority and never lowers an unlinked v7 envelope', () => {
    const { context, plan } = fixture();
    const unlinked = {
      ...structuredClone(plan),
      producers: plan.producers.map(({ entityId: _entityId, ...producer }) => producer),
      entities: [],
    } as DirectElaborationPlanV7;
    expect(validateEntityV7DirectPlan(unlinked, context).diagnostics[0]).toMatchObject({
      code: 'RT7000',
      message: expect.stringContaining('at least one linked Selector'),
    });
    expect(tryElaborateEntityV7DirectPlan(unlinked, context).execution).toBeUndefined();

    const duplicateLink = {
      ...structuredClone(plan),
      producers: [plan.producers[0]!, { ...plan.producers[0]! }],
    } as DirectElaborationPlanV7;
    expect(validateEntityV7DirectPlan(duplicateLink, context).diagnostics[0]).toMatchObject({
      code: 'RT7000',
      message: expect.stringContaining('only one linked producer'),
    });
  });

  test('binds the replay context reference to the trusted v7 context', () => {
    const { context, plan } = fixture();
    const stale = {
      ...structuredClone(plan),
      context: entityReplayContextRef(
        createTrustedEntityReplayContext({
          database: context.database,
          source: 'synthetic',
          evidenceIdentity: 'stale-evidence',
          policyIdentity: 'stale-policy',
          profiles: [],
        }),
      ),
    };
    expect(validateEntityV7DirectPlan(stale, context).diagnostics).not.toEqual([]);
  });

  test('rejects inherited Arithmetic tampering instead of accepting through v3 projection', () => {
    const { context, plan } = mixedFixture('arithmetic');
    const arithmeticEntity = plan.entities.find(
      (entity) => entity.configuration?.mode === 'arithmetic',
    );
    if (arithmeticEntity?.configuration?.mode !== 'arithmetic')
      throw new Error('Expected linked Arithmetic Entity.');
    const tampered = structuredClone(plan) as unknown as DirectElaborationPlanV7 & {
      entities: Array<DirectElaborationPlanV7['entities'][number]>;
    };
    const entity = tampered.entities.find(({ id }) => id === arithmeticEntity.id)!;
    (entity as { configuration?: unknown }).configuration = {
      ...arithmeticEntity.configuration,
      right: { kind: 'constant', value: 2 },
    };
    expect(validateEntityV7DirectPlan(tampered, context).diagnostics).not.toEqual([]);
  });

  test('rejects inherited Decider configuration and output-origin tampering', () => {
    const { context, plan } = mixedFixture('decider');
    const deciderEntity = plan.entities.find((entity) => entity.configuration?.mode === 'decider');
    const deciderIndex = plan.producers.findIndex((producer) => producer.kind === 'decider');
    if (deciderEntity?.configuration?.mode !== 'decider' || deciderIndex < 0)
      throw new Error('Expected linked Decider Entity and Producer.');
    const tampered = structuredClone(plan) as unknown as DirectElaborationPlanV7 & {
      entities: Array<DirectElaborationPlanV7['entities'][number]>;
      producers: Array<DirectElaborationPlanV7['producers'][number]>;
    };
    const entity = tampered.entities.find(({ id }) => id === deciderEntity.id)!;
    (entity as { configuration?: unknown }).configuration = {
      ...deciderEntity.configuration,
      outputs: [],
    };
    const producer = tampered.producers[deciderIndex];
    if (producer?.kind !== 'decider') throw new Error('Expected a Decider Producer.');
    (producer as unknown as { outputOrigins: Array<Record<string, unknown>> }).outputOrigins[0] = {
      ...producer.outputOrigins[0]!,
      ordinal: 99,
    };
    expect(validateEntityV7DirectPlan(tampered, context).diagnostics).not.toEqual([]);
  });

  test('rejects inherited Arithmetic and Decider tampering in resolved v7 artifacts', () => {
    for (const kind of ['arithmetic', 'decider'] as const) {
      const { resolved } = mixedFixture(kind);
      const tampered = structuredClone(resolved) as typeof resolved & {
        ir: {
          entities: Array<(typeof resolved.ir.entities)[number]>;
        };
      };
      const entity = tampered.ir.entities.find(({ configuration }) => configuration?.mode === kind);
      if (entity === undefined || entity.configuration?.mode !== kind)
        throw new Error(`Expected linked ${kind} Entity.`);
      (entity as { configuration?: unknown }).configuration =
        kind === 'arithmetic'
          ? { ...entity.configuration, right: { kind: 'constant', value: 2 } }
          : { ...entity.configuration, outputs: [] };
      expect(() => hydrateResolvedEntityV7Circuit(tampered)).toThrow();
    }
  });
});

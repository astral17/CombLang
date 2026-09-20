import { describe, expect, test } from 'vitest';
import type { EntityProfile } from '@comblang/compiler/entity';
import type { DirectElaborationPlan } from '@comblang/compiler/direct-plan-schema';
import { generateBlueprintJson } from '@comblang/compiler/blueprint-json';
import type { NativeCircuitIr } from '@comblang/compiler/ir';
import {
  createTrustedEntityReplayContext,
  type TrustedEntityReplayContext,
} from '@comblang/compiler/entity-replay-context';
import { syntheticZeroPortEntityProfile } from '@comblang/compiler/entity-fixtures';
import type { EntityPrototype } from '@comblang/prototypes';

import type { EntityPrototypeResolver } from './entity-registry.js';
import { validateCanonicalDirectPlan, tryElaborateDirectPlan } from './direct-plan.js';
import { hydrateResolvedCircuit } from './resolved-circuit.js';
import { parseResolvedCircuit, validateResolvedCircuit } from '@comblang/compiler/resolved-circuit';
import { compileSourceProgram } from './source-compilation.js';
import { runDirectPlanTests } from './test-runner.js';

type DataRecord = Record<string, any>;

function record(value: unknown): DataRecord {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Expected a data record.');
  return value as DataRecord;
}

function canonicalHost(): {
  trustedEntityReplayContext: TrustedEntityReplayContext;
  entityPrototypeResolver: EntityPrototypeResolver;
} {
  const families = [
    ['constant-combinator', 'constant-combinator'],
    ['arithmetic-combinator', 'arithmetic-combinator'],
    ['decider-combinator', 'decider-combinator'],
    ['selector-combinator', 'selector-combinator'],
    ['structural', 'container'],
  ] as const;
  const profiles = families.map(([name, prototypeType], index) => ({
    ...syntheticZeroPortEntityProfile,
    prototypeType,
    ref: {
      ...syntheticZeroPortEntityProfile.ref,
      prototypeKey: `entity:${name}` as EntityProfile['ref']['prototypeKey'],
      profileId: `profile:canonical-${index}` as EntityProfile['ref']['profileId'],
    },
  }));
  const prototypes = families.map(([name, type]) => ({
    key: `entity:${name}`,
    name,
    type,
  })) as EntityPrototype[];
  const trustedEntityReplayContext = createTrustedEntityReplayContext({
    database: profiles[0]!.ref.database,
    source: 'synthetic',
    evidenceIdentity: 'canonical-circuit-evidence',
    policyIdentity: 'canonical-circuit-policy',
    profiles,
  });
  const entityPrototypeResolver: EntityPrototypeResolver = {
    database: profiles[0]!.ref.database,
    getEntity(nameOrKey) {
      return prototypes.find(({ key, name }) => nameOrKey === key || nameOrKey === name);
    },
  };
  return { trustedEntityReplayContext, entityPrototypeResolver };
}

function mixedSource() {
  return {
    path: 'canonical-mixed.factorio.ts',
    text: `const A = Signal('virtual', 'signal-A');
const input = new Network();
const output = new Network();
const structural = Entity('entity:structural');
const constant: ConstantCombinator = Constant({ sections: [{ filters: [[A, 1]] }] });
const arithmetic: ArithmeticCombinator = Arithmetic({ left: input[A], operation: 'add', right: 1, output: A });
const decider: DeciderCombinator = Decider({ condition: input[A] > 0, outputs: [input[A]] });
const selector: SelectorCombinator = Selector({ input, operation: 'count', output: A });
output += constant;
output += arithmetic;
output += decider;
output += selector;
void structural;`,
  };
}

function assertCanonicalPlan(
  value: unknown,
  expectedEntities = 5,
  expectedLinked = 4,
  expectedConfigured = 4,
): DataRecord {
  const plan = record(value);
  expect(plan.format).toBe('comblang-direct-plan');
  expect(Object.hasOwn(plan, 'version')).toBe(false);
  expect(Array.isArray(plan.producers)).toBe(true);
  expect(Array.isArray(plan.entities)).toBe(true);
  expect(plan.entities).toHaveLength(expectedEntities);
  expect(plan.context === undefined).toBe(expectedEntities === 0);
  const linked = plan.producers.filter((producer: unknown) => 'entityId' in record(producer));
  expect(linked).toHaveLength(expectedLinked);
  expect(new Set(linked.map((producer: DataRecord) => producer.entityId)).size).toBe(
    expectedLinked,
  );
  expect(
    plan.entities.filter((entity: DataRecord) => entity.configuration !== undefined),
  ).toHaveLength(expectedConfigured);
  return plan;
}

function assertCanonicalResolved(
  value: unknown,
  expectedEntities = 5,
  expectedLinked = 4,
): DataRecord {
  const resolved = record(value);
  expect(resolved.format).toBe('comblang-resolved-circuit');
  expect(Object.hasOwn(resolved, 'version')).toBe(false);
  expect(resolved.planFingerprint).toMatch(/^plan-fnv1a64:[0-9a-f]{16}$/);
  const ir = record(resolved.ir);
  expect(Object.hasOwn(ir, 'version')).toBe(false);
  expect(ir.entities).toHaveLength(expectedEntities);
  expect(ir.producers.filter((producer: unknown) => 'entityId' in record(producer))).toHaveLength(
    expectedLinked,
  );
  return resolved;
}

describe('canonical circuit contract', () => {
  test('compiles a mixed Entity circuit through one cloneable canonical pipeline', () => {
    const compilation = compileSourceProgram(mixedSource(), canonicalHost());
    expect(compilation.pipelineDiagnostics).toEqual([]);

    const plan = assertCanonicalPlan(compilation.plan);
    const resolved = assertCanonicalResolved(compilation.resolvedCircuit);
    const preview = generateBlueprintJson(resolved.ir as unknown as NativeCircuitIr);
    expect(preview.blueprint.entities).toHaveLength(5);
    expect(
      validateCanonicalDirectPlan(plan, canonicalHost().trustedEntityReplayContext).diagnostics,
    ).toEqual([]);
    expect(() => structuredClone(plan)).not.toThrow();
    expect(() => structuredClone(resolved)).not.toThrow();
    const clonedResolved = structuredClone(resolved);
    expect(validateResolvedCircuit(clonedResolved).diagnostics).toEqual([]);
    expect(generateBlueprintJson(record(clonedResolved).ir as NativeCircuitIr)).toEqual(preview);

    const execution = record(compilation.execution);
    expect(execution.circuit).toBeDefined();
    const circuit = record(execution.circuit);
    const ir = record(circuit.ir);
    const graph = record(circuit.graph);
    expect(Object.hasOwn(ir, 'version')).toBe(false);
    expect(Object.hasOwn(graph, 'version')).toBe(false);
    expect(ir.entities).toHaveLength(5);
    const physicalLinked = ir.producers.filter(
      (producer: unknown) => 'entityId' in record(producer),
    );
    expect(new Set(physicalLinked.map((producer: DataRecord) => producer.entityId)).size).toBe(4);
    expect(
      physicalLinked.every((producer: DataRecord) =>
        ir.entities.some((entity: DataRecord) => entity.id === producer.entityId),
      ),
    ).toBe(true);
    const session = (
      compilation.execution as { createTestSession(): { tick(): void } }
    ).createTestSession();
    expect(() => session.tick()).not.toThrow();
    expect(() => hydrateResolvedCircuit(resolved).createSimulation().step()).not.toThrow();
    expect(() => hydrateResolvedCircuit(clonedResolved).createSimulation().step()).not.toThrow();

    const canonicalExecution = tryElaborateDirectPlan(
      plan,
      canonicalHost().trustedEntityReplayContext,
    );
    expect(canonicalExecution.diagnostics).toEqual([]);
    expect(canonicalExecution.execution).toBeDefined();
    expect(Object.hasOwn(record(canonicalExecution.execution).circuit, 'version')).toBe(false);
  });

  test('keeps an entity-free circuit in the same canonical shape without profile context', () => {
    const compilation = compileSourceProgram({
      path: 'canonical-entity-free.factorio.ts',
      text: `const A = Signal('virtual', 'signal-A');
const input = new Network();
const output = new Network();
const constant: ConstantCombinator = CC(2 * A);
output += constant;`,
    });
    expect(compilation.pipelineDiagnostics).toEqual([]);
    const plan = assertCanonicalPlan(compilation.plan, 0, 0, 0);
    expect(plan.entities).toEqual([]);
    expect(plan.context).toBeUndefined();
    expect(validateCanonicalDirectPlan(plan).diagnostics).toEqual([]);
    const resolved = assertCanonicalResolved(compilation.resolvedCircuit, 0, 0);
    expect(record(resolved.ir).entities).toEqual([]);
    const execution = tryElaborateDirectPlan(plan as unknown as DirectElaborationPlan);
    expect(execution.diagnostics).toEqual([]);
    expect(execution.execution).toBeDefined();
    expect(Object.hasOwn(record(record(execution.execution).circuit).graph, 'version')).toBe(false);
    expect(Object.hasOwn(record(record(execution.execution).circuit).ir, 'version')).toBe(false);
    const canonicalExecution = tryElaborateDirectPlan(plan);
    expect(canonicalExecution.diagnostics).toEqual([]);
    expect(canonicalExecution.execution).toBeDefined();
    expect(() => hydrateResolvedCircuit(resolved).createSimulation().step()).not.toThrow();
    expect(
      runDirectPlanTests(
        plan as unknown as DirectElaborationPlan,
        `test('canonical plan', ({ tick }) => { tick(); });`,
      ),
    ).toMatchObject({ passed: 1, failed: 0 });
  });

  test('validates a canonical Constant-only Entity plan through one family entrypoint', () => {
    const compilation = compileSourceProgram(
      {
        path: 'canonical-constant-only.factorio.ts',
        text: `const A = Signal('virtual', 'signal-A');
const output = new Network();
const constant: ConstantCombinator = Constant({ sections: [{ filters: [[A, 1]] }] });
output += constant;`,
      },
      canonicalHost(),
    );
    expect(compilation.pipelineDiagnostics).toEqual([]);
    const plan = assertCanonicalPlan(compilation.plan, 1, 1, 1);
    const validation = validateCanonicalDirectPlan(
      plan,
      canonicalHost().trustedEntityReplayContext,
    );
    expect(validation.diagnostics).toEqual([]);
    expect(validation.value).toBeDefined();
    expect(Object.hasOwn(validation.value!, 'version')).toBe(false);
    expect((validation.value!.producers[0] as DataRecord).entityId).toBe(
      (validation.value!.entities[0] as DataRecord).id,
    );
  });

  test('rejects canonical lineage and association tampering', () => {
    const compilation = compileSourceProgram(mixedSource(), canonicalHost());
    const plan = record(compilation.plan);
    const withOrphanEntity = structuredClone(plan) as DataRecord;
    const orphanProducers = withOrphanEntity.producers as DataRecord[];
    orphanProducers[0] = { ...orphanProducers[0], entityId: 'entity:foreign' };
    expect(
      validateCanonicalDirectPlan(withOrphanEntity, canonicalHost().trustedEntityReplayContext)
        .value,
    ).toBeUndefined();

    const withDuplicateAssociation = structuredClone(plan) as DataRecord;
    const duplicateProducers = withDuplicateAssociation.producers as DataRecord[];
    duplicateProducers[1] = { ...duplicateProducers[1], entityId: duplicateProducers[0]!.entityId };
    expect(
      validateCanonicalDirectPlan(
        withDuplicateAssociation,
        canonicalHost().trustedEntityReplayContext,
      ).value,
    ).toBeUndefined();

    const withLinkedPlacement = structuredClone(plan) as DataRecord;
    const placedProducers = withLinkedPlacement.producers as DataRecord[];
    placedProducers[0] = { ...placedProducers[0], placement: { x: 1, y: 2 } };
    expect(
      validateCanonicalDirectPlan(withLinkedPlacement, canonicalHost().trustedEntityReplayContext)
        .value,
    ).toBeUndefined();

    const withBadDeciderOrigins = structuredClone(plan) as DataRecord;
    const decider = (withBadDeciderOrigins.producers as DataRecord[]).find(
      (producer) => producer.kind === 'decider',
    );
    expect(decider).toBeDefined();
    const origins = decider!.outputOrigins as DataRecord[];
    origins[0] = { ...origins[0], ordinal: 99 };
    expect(
      validateCanonicalDirectPlan(withBadDeciderOrigins, canonicalHost().trustedEntityReplayContext)
        .diagnostics[0]?.message,
    ).toMatch(/dense|align/i);

    const resolved = record(compilation.resolvedCircuit);
    const withVersion = structuredClone(resolved) as DataRecord;
    withVersion.version = 7;
    expect(() => parseResolvedCircuit(withVersion)).toThrow(/unknown field/i);

    const withForeignEntity = structuredClone(resolved) as DataRecord;
    const producers = record(withForeignEntity.ir).producers as DataRecord[];
    producers[0] = { ...producers[0], entityId: 'entity:foreign' };
    expect(validateResolvedCircuit(withForeignEntity).value).toBeUndefined();

    const withDuplicateResolvedAssociation = structuredClone(resolved) as DataRecord;
    const linkedResolvedProducers = (
      record(withDuplicateResolvedAssociation.ir).producers as DataRecord[]
    ).filter((producer) => producer.entityId !== undefined);
    const allResolvedProducers = record(withDuplicateResolvedAssociation.ir)
      .producers as DataRecord[];
    const duplicateIndex = allResolvedProducers.indexOf(linkedResolvedProducers[1]!);
    allResolvedProducers[duplicateIndex] = {
      ...allResolvedProducers[duplicateIndex],
      entityId: linkedResolvedProducers[0]!.entityId,
    };
    expect(
      validateResolvedCircuit(withDuplicateResolvedAssociation).diagnostics[0]?.message,
    ).toMatch(/only one|duplicate/i);

    const withResolvedLinkedPlacement = structuredClone(resolved) as DataRecord;
    const placedResolvedProducers = record(withResolvedLinkedPlacement.ir)
      .producers as DataRecord[];
    const placedIndex = placedResolvedProducers.findIndex(
      (producer) => producer.entityId !== undefined,
    );
    placedResolvedProducers[placedIndex] = {
      ...placedResolvedProducers[placedIndex],
      placement: { x: 1, y: 2 },
    };
    expect(validateResolvedCircuit(withResolvedLinkedPlacement).diagnostics[0]?.message).toMatch(
      /placement|linked/i,
    );

    const withResolvedOrphanEntity = structuredClone(resolved) as DataRecord;
    const orphanResolvedProducers = record(withResolvedOrphanEntity.ir).producers as DataRecord[];
    const orphanIndex = orphanResolvedProducers.findIndex(
      (producer) => producer.entityId !== undefined,
    );
    orphanResolvedProducers[orphanIndex] = {
      ...orphanResolvedProducers[orphanIndex],
      entityId: undefined,
    };
    expect(validateResolvedCircuit(withResolvedOrphanEntity).diagnostics[0]?.message).toMatch(
      /configured Entity|linked physical Producer/i,
    );

    const withBadResolvedDeciderOrigins = structuredClone(resolved) as DataRecord;
    const resolvedDecider = (
      record(withBadResolvedDeciderOrigins.ir).producers as DataRecord[]
    ).find((producer) => producer.kind === 'decider')!;
    const resolvedOrigins = resolvedDecider.outputOrigins as DataRecord[];
    resolvedOrigins[0] = { ...resolvedOrigins[0], ordinal: 99 };
    expect(validateResolvedCircuit(withBadResolvedDeciderOrigins).diagnostics[0]?.message).toMatch(
      /dense|align/i,
    );

    const withNetworkHole = structuredClone(resolved) as DataRecord;
    const networks = record(withNetworkHole.ir).networks as unknown[];
    delete networks[0];
    expect(validateResolvedCircuit(withNetworkHole).diagnostics[0]?.message).toMatch(/holes/i);
  });

  test('rejects a canonical producer when its Entity profile belongs to another family', () => {
    const host = canonicalHost();
    const compilation = compileSourceProgram(
      {
        path: 'canonical-family-tamper.factorio.ts',
        text: `const A = Signal('virtual', 'signal-A');
const output = new Network();
const constant: ConstantCombinator = Constant({ sections: [{ filters: [[A, 1]] }] });
output += constant;`,
      },
      host,
    );
    expect(compilation.pipelineDiagnostics).toEqual([]);
    const plan = structuredClone(compilation.plan) as DataRecord;
    const entity = record((plan.entities as DataRecord[])[0]);
    const arithmeticProfile = host.trustedEntityReplayContext.profiles.find(
      (profile) => profile.prototypeType === 'arithmetic-combinator',
    );
    expect(arithmeticProfile).toBeDefined();
    entity.profile = arithmeticProfile!.ref;

    const validation = validateCanonicalDirectPlan(plan, host.trustedEntityReplayContext);
    expect(validation.value).toBeUndefined();
    expect(validation.diagnostics[0]?.message).toMatch(/constant-combinator|family/i);
  });

  test('rejects computation configuration tampering for every canonical family', () => {
    const host = canonicalHost();
    const compilation = compileSourceProgram(mixedSource(), host);
    expect(compilation.pipelineDiagnostics).toEqual([]);

    const directCases: readonly [string, (plan: DataRecord) => void][] = [
      [
        'Constant filter value',
        (plan) => {
          const entity = (plan.entities as DataRecord[]).find((candidate) =>
            String(record(candidate.profile).prototypeKey).endsWith('constant-combinator'),
          )!;
          const configuration = record(entity.configuration);
          const value = record(configuration.value);
          const sections = value.sections as DataRecord[];
          const filters = record(sections[0]).filters as DataRecord[];
          filters[0] = { ...filters[0], value: Number(filters[0]!.value) + 1 };
        },
      ],
      [
        'Arithmetic right operand',
        (plan) => {
          const entity = (plan.entities as DataRecord[]).find((candidate) =>
            String(record(candidate.profile).prototypeKey).endsWith('arithmetic-combinator'),
          )!;
          const configuration = record(entity.configuration);
          const right = record(configuration.right);
          configuration.right = { ...right, value: Number(right.value) + 1 };
        },
      ],
      [
        'Decider output row',
        (plan) => {
          const entity = (plan.entities as DataRecord[]).find((candidate) =>
            String(record(candidate.profile).prototypeKey).endsWith('decider-combinator'),
          )!;
          const configuration = record(entity.configuration);
          const outputs = configuration.outputs as DataRecord[];
          const output = record(outputs[0]);
          const signal = record(output.signal);
          outputs[0] = { ...output, signal: { ...signal, name: 'signal-tampered' } };
        },
      ],
      [
        'Selector output',
        (plan) => {
          const entity = (plan.entities as DataRecord[]).find((candidate) =>
            String(record(candidate.profile).prototypeKey).endsWith('selector-combinator'),
          )!;
          const configuration = record(entity.configuration);
          const output = record(configuration.output);
          configuration.output = { ...output, name: 'signal-tampered' };
        },
      ],
      [
        'Selector index operation',
        (plan) => {
          const entity = (plan.entities as DataRecord[]).find((candidate) =>
            String(record(candidate.profile).prototypeKey).endsWith('selector-combinator'),
          )!;
          const configuration = record(entity.configuration);
          configuration.operation = 'select';
          configuration.selectMax = true;
          configuration.index = 2;
          delete configuration.output;
        },
      ],
      [
        'Unknown computation field',
        (plan) => {
          const entity = (plan.entities as DataRecord[]).find((candidate) =>
            String(record(candidate.profile).prototypeKey).endsWith('arithmetic-combinator'),
          )!;
          record(entity.configuration).unexpected = true;
        },
      ],
      [
        'Unknown Constant field',
        (plan) => {
          const entity = (plan.entities as DataRecord[]).find((candidate) =>
            String(record(candidate.profile).prototypeKey).endsWith('constant-combinator'),
          )!;
          record(entity.configuration).unexpected = true;
        },
      ],
      [
        'Unknown Decider field',
        (plan) => {
          const entity = (plan.entities as DataRecord[]).find((candidate) =>
            String(record(candidate.profile).prototypeKey).endsWith('decider-combinator'),
          )!;
          record(entity.configuration).unexpected = true;
        },
      ],
      [
        'Unknown Selector field',
        (plan) => {
          const entity = (plan.entities as DataRecord[]).find((candidate) =>
            String(record(candidate.profile).prototypeKey).endsWith('selector-combinator'),
          )!;
          record(entity.configuration).unexpected = true;
        },
      ],
      [
        'Cyclic computation configuration',
        (plan) => {
          const entity = (plan.entities as DataRecord[]).find((candidate) =>
            String(record(candidate.profile).prototypeKey).endsWith('arithmetic-combinator'),
          )!;
          const configuration = record(entity.configuration);
          configuration.left = configuration;
        },
      ],
    ];

    for (const [name, mutate] of directCases) {
      const tampered = structuredClone(compilation.plan) as DataRecord;
      for (const entity of tampered.entities as DataRecord[]) {
        if (entity.configuration !== undefined)
          entity.configuration = structuredClone(entity.configuration);
      }
      mutate(tampered);
      const validation = validateCanonicalDirectPlan(tampered, host.trustedEntityReplayContext);
      expect(validation.value, name).toBeUndefined();
      expect(validation.diagnostics[0]?.message, name).toMatch(
        /configuration|Producer|unknown|field|Selector/i,
      );
    }

    const resolvedCases: readonly [string, (resolved: DataRecord) => void][] = [
      [
        'resolved Constant filter value',
        (resolved) => {
          const entities = record(resolved.ir).entities as DataRecord[];
          const entity = entities.find(
            (candidate) => candidate.prototypeName === 'constant-combinator',
          )!;
          const value = record(record(entity.configuration).value);
          const filters = record((value.sections as DataRecord[])[0]).filters as DataRecord[];
          filters[0] = { ...filters[0], value: Number(filters[0]!.value) + 1 };
        },
      ],
      [
        'resolved Arithmetic right operand',
        (resolved) => {
          const entities = record(resolved.ir).entities as DataRecord[];
          const entity = entities.find(
            (candidate) => candidate.prototypeName === 'arithmetic-combinator',
          )!;
          const configuration = record(entity.configuration);
          const right = record(configuration.right);
          configuration.right = { ...right, value: Number(right.value) + 1 };
        },
      ],
      [
        'resolved Decider output row',
        (resolved) => {
          const entities = record(resolved.ir).entities as DataRecord[];
          const entity = entities.find(
            (candidate) => candidate.prototypeName === 'decider-combinator',
          )!;
          const configuration = record(entity.configuration);
          const outputs = configuration.outputs as DataRecord[];
          const output = record(outputs[0]);
          const signal = record(output.signal);
          outputs[0] = {
            ...output,
            signal: { ...signal, signal: { ...record(signal.signal), name: 'signal-tampered' } },
          };
        },
      ],
      [
        'resolved Selector output',
        (resolved) => {
          const entities = record(resolved.ir).entities as DataRecord[];
          const entity = entities.find(
            (candidate) => candidate.prototypeName === 'selector-combinator',
          )!;
          const configuration = record(entity.configuration);
          configuration.output = { ...record(configuration.output), name: 'signal-tampered' };
        },
      ],
      [
        'resolved Selector index operation',
        (resolved) => {
          const entities = record(resolved.ir).entities as DataRecord[];
          const entity = entities.find(
            (candidate) => candidate.prototypeName === 'selector-combinator',
          )!;
          const configuration = record(entity.configuration);
          configuration.operation = 'select';
          configuration.selectMax = true;
          configuration.index = 2;
          delete configuration.output;
        },
      ],
      [
        'resolved unknown computation field',
        (resolved) => {
          const entities = record(resolved.ir).entities as DataRecord[];
          const entity = entities.find(
            (candidate) => candidate.prototypeName === 'arithmetic-combinator',
          )!;
          record(entity.configuration).unexpected = true;
        },
      ],
      [
        'resolved unknown Constant field',
        (resolved) => {
          const entities = record(resolved.ir).entities as DataRecord[];
          const entity = entities.find(
            (candidate) => candidate.prototypeName === 'constant-combinator',
          )!;
          record(entity.configuration).unexpected = true;
        },
      ],
      [
        'resolved unknown Decider field',
        (resolved) => {
          const entities = record(resolved.ir).entities as DataRecord[];
          const entity = entities.find(
            (candidate) => candidate.prototypeName === 'decider-combinator',
          )!;
          record(entity.configuration).unexpected = true;
        },
      ],
      [
        'resolved unknown Selector field',
        (resolved) => {
          const entities = record(resolved.ir).entities as DataRecord[];
          const entity = entities.find(
            (candidate) => candidate.prototypeName === 'selector-combinator',
          )!;
          record(entity.configuration).unexpected = true;
        },
      ],
    ];

    for (const [name, mutate] of resolvedCases) {
      const tampered = structuredClone(compilation.resolvedCircuit) as DataRecord;
      for (const entity of record(tampered.ir).entities as DataRecord[]) {
        if (entity.configuration !== undefined)
          entity.configuration = structuredClone(entity.configuration);
      }
      mutate(tampered);
      const validation = validateResolvedCircuit(tampered);
      expect(validation.value, name).toBeUndefined();
      expect(validation.diagnostics[0]?.message, name).toMatch(
        /configuration|Producer|unknown|field|Selector/i,
      );
      expect(() => hydrateResolvedCircuit(tampered), name).toThrow();
    }
  });

  test('rejects non-data canonical plan payloads before family validation', () => {
    const compilation = compileSourceProgram({
      path: 'canonical-data-boundary.factorio.ts',
      text: `const A = Signal('virtual', 'signal-A');
const input = new Network();
const output = new Network();
const constant: ConstantCombinator = CC(2 * A);
output += constant;`,
    });
    const plan = structuredClone(compilation.plan) as DataRecord;
    const networks = plan.networks as DataRecord[];
    Object.defineProperty(networks[0]!, 'name', {
      configurable: true,
      get() {
        return 'accessor-network';
      },
    });
    expect(validateCanonicalDirectPlan(plan).diagnostics[0]?.message).toMatch(/accessors/i);

    const symbolPlan = structuredClone(compilation.plan) as DataRecord;
    Object.defineProperty(symbolPlan, Symbol('foreign'), { value: true, enumerable: true });
    expect(validateCanonicalDirectPlan(symbolPlan).diagnostics[0]?.message).toMatch(/symbol/i);

    const holePlan = structuredClone(compilation.plan) as DataRecord;
    const producers = holePlan.producers as unknown[];
    producers.length += 1;
    expect(validateCanonicalDirectPlan(holePlan).diagnostics[0]?.message).toMatch(/holes/i);
  });
});

import { signal } from '@comblang/factorio';
import { loadPrototypeDatabase } from '@comblang/prototypes';
import builtinPrototypeDatabase from '../../../packages/prototypes/generated/space-age-2.1.17.json';
import type { DirectElaborationPlanV3 } from '@comblang/compiler/entity';
import type { NativeCircuitIrV4 } from '@comblang/compiler/entity-v4';
import type { ResolvedSourceCircuit } from '@comblang/compiler/resolved-source-circuit';
import type { ResolvedEntityV6Circuit } from '@comblang/compiler/resolved-entity-v6';
import {
  syntheticSharedTwoColorEntityProfile,
  syntheticZeroPortEntityProfile,
} from '@comblang/compiler/entity-fixtures';
import type { EntityProfile } from '@comblang/compiler/entity';
import { createTrustedEntityReplayContext } from '@comblang/compiler/entity-replay-context';
import {
  generateEntityBlueprintJson,
  generateEntityComputationBlueprintJson,
} from '@comblang/compiler/blueprint-json';
import type { EntityPrototype } from '@comblang/prototypes';
import type { EntityPrototypeResolver } from '@comblang/runtime/entity-registry';
import {
  conservativeEntityProvisioningPolicy,
  EntityProvisioningService,
} from '@comblang/runtime/entity-provisioning';
import { describe, expect, test } from 'vitest';

import { blueprintJsonForArtifact, blueprintJsonForPlan } from './blueprint-demo.js';
import { compileSource } from './compile-source.js';
import { createSourceCircuitArtifact } from './source-circuit-artifact.js';
import { sourcePreviewDiagnostic } from './source-diagnostics.js';
import {
  runSourceCircuitDemo,
  runSourcePlanDemo,
  SourceSimulationController,
} from './source-demo.js';

function assertResolvedV3(value: unknown): asserts value is ResolvedSourceCircuit {
  if (
    value === null ||
    typeof value !== 'object' ||
    (value as { readonly format?: unknown }).format !== 'comblang-resolved-source-circuit'
  ) {
    throw new Error('Expected a resolved v3 source circuit.');
  }
}

function exactDeciderEnvironment() {
  const profile: EntityProfile = {
    ...structuredClone(syntheticZeroPortEntityProfile),
    ref: {
      ...syntheticZeroPortEntityProfile.ref,
      prototypeKey: 'entity:decider-combinator',
      profileId: 'profile:web-artifact-decider-v6' as EntityProfile['ref']['profileId'],
    },
    prototypeType: 'decider-combinator',
  };
  const trustedEntityReplayContext = createTrustedEntityReplayContext({
    database: profile.ref.database,
    source: 'synthetic',
    evidenceIdentity: 'web-artifact-decider-v6-evidence',
    policyIdentity: 'web-artifact-decider-v6-policy',
    profiles: [profile],
  });
  const prototype: EntityPrototype = {
    key: 'entity:decider-combinator',
    name: 'decider-combinator',
    type: 'decider-combinator',
    tileWidth: 1,
    tileHeight: 2,
  };
  return {
    trustedEntityReplayContext,
    entityPrototypeResolver: {
      database: profile.ref.database,
      getEntity(nameOrKey: string) {
        return nameOrKey === prototype.key || nameOrKey === prototype.name ? prototype : undefined;
      },
    } as EntityPrototypeResolver,
  };
}

describe('source circuit artifact', () => {
  test('requires a correlated resolved circuit for every v3 artifact consumer at compile time', () => {
    if (false) {
      const plan = {} as DirectElaborationPlanV3;
      // @ts-expect-error Bare v3 artifact construction must not be callable.
      createSourceCircuitArtifact(plan);
      // @ts-expect-error Bare v3 blueprint convenience must not be callable.
      blueprintJsonForPlan(plan);
      // @ts-expect-error Bare v3 simulation convenience must not be callable.
      new SourceSimulationController(plan);
      // @ts-expect-error Bare v3 demo convenience must not be callable.
      runSourcePlanDemo(plan);
      const v4 = {} as NativeCircuitIrV4;
      // @ts-expect-error v4 linked Constant IR requires the dedicated adapter.
      generateEntityBlueprintJson(v4);
      generateEntityComputationBlueprintJson(v4);
    }
    expect(true).toBe(true);
  });

  test('replays a host-bound v3 source artifact into the blueprint and simulation consumers', () => {
    const profile = syntheticSharedTwoColorEntityProfile;
    const trustedEntityReplayContext = createTrustedEntityReplayContext({
      database: profile.ref.database,
      source: 'synthetic',
      evidenceIdentity: 'comblang-synthetic-evidence-v1',
      policyIdentity: 'comblang-entity-policy-v1',
      profiles: [profile],
    });
    const prototype = {
      key: profile.ref.prototypeKey,
      name: 'synthetic-shared-two-color',
      type: 'container',
    } as EntityPrototype;
    const entityPrototypeResolver: EntityPrototypeResolver = {
      database: profile.ref.database,
      getEntity(nameOrKey) {
        return nameOrKey === prototype.key || nameOrKey === prototype.name ? prototype : undefined;
      },
    };
    const compiled = compileSource(
      {
        path: 'entity-preview.factorio.ts',
        text: `const entity = Entity('synthetic-shared-two-color', {
  rule: 'shared-circuit-condition',
  lanes: ['shared-red', 'shared-green'],
  condition: NativeCondition(Signal('virtual', 'signal-A'), '>', 0),
}).at(3.5, -1, 4);`,
      },
      { trustedEntityReplayContext, entityPrototypeResolver },
    );
    const plan = compiled.plan;
    if (plan === undefined || plan.version !== 3) throw new Error('Expected a v3 source plan.');
    const resolvedCircuit = compiled.resolvedCircuit;
    assertResolvedV3(resolvedCircuit);
    const artifact = createSourceCircuitArtifact(plan, resolvedCircuit);
    const controller = new SourceSimulationController(artifact);
    const demo = runSourceCircuitDemo(artifact, 0, 0);

    expect(artifact.plan.version).toBe(3);
    expect(artifact.resolvedCircuit.planFingerprint).toMatch(/^v1-[0-9a-f]{16}$/);
    expect(artifact.execution.circuit.ir.version).toBe(3);
    expect(artifact.blueprint.blueprint.entities).toEqual([
      expect.objectContaining({
        name: 'synthetic-shared-two-color',
        entity_number: 1,
        position: { x: 3.5, y: -1 },
        direction: 4,
        control_behavior: {
          circuit_condition: {
            first_signal: { type: 'virtual', name: 'signal-A' },
            first_signal_networks: { red: true, green: true },
            comparator: '>',
            constant: 0,
          },
        },
      }),
    ]);
    expect(demo.combinators).toBe(0);
    expect(controller.timeline).toHaveLength(1);
  });

  test('hydrates a v4 Constant artifact without provider authority or a duplicate blueprint object', async () => {
    const { prototypes } = await loadPrototypeDatabase(builtinPrototypeDatabase);
    const provisioned = new EntityProvisioningService().provision(
      prototypes,
      conservativeEntityProvisioningPolicy,
    );
    const compiled = compileSource(
      {
        path: 'exact-constant-preview.factorio.ts',
        text: `const A = Signal('virtual', 'signal-A');
const exact = Constant({ isOn: false, sections: [{ active: false, filters: [[A, 2], [A, 0]] }] }).at(3.5, -1, 8);
const output = new Network();
const alias: Network = output;
output += exact;`,
      },
      {
        trustedEntityReplayContext: provisioned.trustedEntityReplayContext,
        entityPrototypeResolver: provisioned.entityPrototypeResolver,
      },
    );
    if (
      compiled.plan === undefined ||
      compiled.plan.version !== 4 ||
      compiled.resolvedCircuit?.format !== 'comblang-resolved-entity-v4'
    ) {
      throw new Error('Expected a resolved v4 Constant artifact.');
    }

    const artifact = createSourceCircuitArtifact(compiled.plan, compiled.resolvedCircuit);
    const controller = new SourceSimulationController(artifact);
    const entity = artifact.blueprint.blueprint.entities[0];

    expect(artifact.execution.circuit.ir.version).toBe(4);
    expect(artifact.execution.debug.scopes).toEqual([
      { networks: [{ planName: 'output', id: artifact.execution.network('output').id }] },
    ]);
    expect(artifact.execution.network('alias')).toBe(artifact.execution.network('output'));
    expect(artifact.blueprint.blueprint.entities).toHaveLength(1);
    expect(entity).toMatchObject({
      entity_number: 1,
      name: 'constant-combinator',
      position: { x: 3.5, y: -1 },
      direction: 8,
      control_behavior: {
        is_on: false,
        sections: {
          sections: [
            {
              index: 1,
              active: false,
              filters: [
                { index: 1, type: 'virtual', name: 'signal-A', quality: 'normal', count: 2 },
                { index: 2, type: 'virtual', name: 'signal-A', quality: 'normal', count: 0 },
              ],
            },
          ],
        },
      },
    });
    expect(controller.timeline).toHaveLength(1);
  });

  test('hydrates cumulative v5 Arithmetic preview with one native blueprint object', async () => {
    const { prototypes } = await loadPrototypeDatabase(builtinPrototypeDatabase);
    const provisioned = new EntityProvisioningService().provision(
      prototypes,
      conservativeEntityProvisioningPolicy,
    );
    const compiled = compileSource(
      {
        path: 'exact-arithmetic-preview.factorio.ts',
        text: `const A = Signal('virtual', 'signal-A');
const input = new Network();
const exact: ArithmeticCombinator = Arithmetic({ left: input[A], operation: 'multiply', right: 2, output: A }).at(3.5, -1, 8);
const output = new Network();
output += exact;`,
      },
      {
        trustedEntityReplayContext: provisioned.trustedEntityReplayContext,
        entityPrototypeResolver: provisioned.entityPrototypeResolver,
      },
    );
    if (
      compiled.plan === undefined ||
      compiled.plan.version !== 5 ||
      compiled.resolvedCircuit?.format !== 'comblang-resolved-entity-v5'
    ) {
      throw new Error('Expected a resolved v5 Arithmetic artifact.');
    }
    const artifact = createSourceCircuitArtifact(compiled.plan, compiled.resolvedCircuit);
    const controller = new SourceSimulationController(artifact);
    expect(artifact.execution.circuit.ir.version).toBe(5);
    expect(artifact.blueprint.blueprint.entities).toHaveLength(1);
    expect(artifact.blueprint.blueprint.entities[0]).toMatchObject({
      entity_number: 1,
      name: 'arithmetic-combinator',
      position: { x: 3.5, y: -1 },
      direction: 8,
      control_behavior: {
        arithmetic_conditions: {
          operation: '*',
          first_signal: { type: 'virtual', name: 'signal-A' },
          second_constant: 2,
          output_signal: { type: 'virtual', name: 'signal-A' },
        },
      },
    });
    expect(controller.timeline).toHaveLength(1);
  });

  test('hydrates a linked v6 Decider artifact and keeps row origins out of blueprint JSON', () => {
    const environment = exactDeciderEnvironment();
    const compiled = compileSource(
      {
        path: 'exact-decider-preview.factorio.ts',
        text: `const A = Signal('virtual', 'signal-A');
const input = new Network();
const exact: DeciderCombinator = Decider({ condition: input[A] > 0, outputs: [input[A]], elseOutputs: [1 * A] }).at(3.5, -1, 8);
const output = new Network();
output += exact;`,
      },
      environment,
    );
    if (
      compiled.plan === undefined ||
      compiled.plan.version !== 6 ||
      compiled.resolvedCircuit?.format !== 'comblang-resolved-entity-v6'
    ) {
      throw new Error('Expected a resolved v6 Decider artifact.');
    }

    const artifact = createSourceCircuitArtifact(compiled.plan, compiled.resolvedCircuit);
    expect(artifact.execution.circuit.ir.version).toBe(6);
    expect(artifact.execution.circuit.ir.producers[0]).toMatchObject({
      kind: 'decider',
      entityId: artifact.execution.circuit.ir.entities[0]?.id,
      outputOrigins: [{ branch: 'normal', ordinal: 0 }],
      elseOutputOrigins: [{ branch: 'else', ordinal: 0 }],
    });
    expect(artifact.blueprint.blueprint.entities).toEqual([
      expect.objectContaining({
        entity_number: 1,
        name: 'decider-combinator',
        position: { x: 3.5, y: -1 },
        direction: 8,
        control_behavior: {
          decider_conditions: expect.objectContaining({
            outputs: [expect.objectContaining({})],
            else_outputs: [expect.objectContaining({})],
          }),
        },
      }),
    ]);
    expect(JSON.stringify(artifact.blueprint)).not.toContain('outputOrigins');
  });

  test('rejects stale, context-mismatched, and malformed v6 preview inputs', () => {
    const environment = exactDeciderEnvironment();
    const compile = (count: number) =>
      compileSource(
        {
          path: 'v6-correlation.factorio.ts',
          text: `const A = Signal('virtual', 'signal-A');
const input = new Network();
const gate: DeciderCombinator = Decider({ condition: input[A] > 0, outputs: [${count} * A] });
const output = new Network();
output += gate;`,
        },
        environment,
      );
    const first = compile(1);
    const second = compile(2);
    if (
      first.plan?.version !== 6 ||
      first.resolvedCircuit?.format !== 'comblang-resolved-entity-v6' ||
      second.plan?.version !== 6 ||
      second.resolvedCircuit?.format !== 'comblang-resolved-entity-v6'
    ) {
      throw new Error('Expected two resolved v6 Decider artifacts.');
    }
    const firstPlan = first.plan;
    const firstResolved = first.resolvedCircuit;
    const secondResolved = second.resolvedCircuit;

    expect(firstResolved.planFingerprint).not.toBe(secondResolved.planFingerprint);
    expect(() => createSourceCircuitArtifact(firstPlan, secondResolved)).toThrow(
      /fingerprint does not match/,
    );
    const contextMismatch = {
      ...firstResolved,
      ir: {
        ...firstResolved.ir,
        context: { ...firstResolved.ir.context, evidenceIdentity: 'wrong-evidence' },
      },
    };
    expect(() => createSourceCircuitArtifact(firstPlan, contextMismatch)).toThrow(
      /context does not match/,
    );
    const malformed = {
      ...firstResolved,
      ir: { ...firstResolved.ir, version: 5 },
    } as unknown as ResolvedEntityV6Circuit;
    expect(() => createSourceCircuitArtifact(firstPlan, malformed)).toThrow();
  });

  test('rejects stale and modified v3 plans even when context and record counts match', () => {
    const profile = syntheticSharedTwoColorEntityProfile;
    const trustedEntityReplayContext = createTrustedEntityReplayContext({
      database: profile.ref.database,
      source: 'synthetic',
      evidenceIdentity: 'comblang-synthetic-evidence-v1',
      policyIdentity: 'comblang-entity-policy-v1',
      profiles: [profile],
    });
    const prototype = {
      key: profile.ref.prototypeKey,
      name: 'synthetic-shared-two-color',
      type: 'container',
    } as EntityPrototype;
    const environment = {
      trustedEntityReplayContext,
      entityPrototypeResolver: {
        database: profile.ref.database,
        getEntity(nameOrKey: string) {
          return nameOrKey === prototype.key || nameOrKey === prototype.name
            ? prototype
            : undefined;
        },
      } as EntityPrototypeResolver,
    };
    const compile = (bias: number) =>
      compileSource(
        {
          path: `correlation-${bias}.factorio.ts`,
          text: `const entity = Entity('synthetic-shared-two-color');
const input = new Network();
const output = new Network();
output += input + ${bias};`,
        },
        environment,
      );
    const first = compile(1);
    const second = compile(2);
    const firstPlan = first.plan;
    const firstResolved = first.resolvedCircuit;
    const secondPlan = second.plan;
    const secondResolved = second.resolvedCircuit;
    if (
      firstPlan === undefined ||
      firstPlan.version !== 3 ||
      firstResolved?.format !== 'comblang-resolved-source-circuit' ||
      secondPlan === undefined ||
      secondPlan.version !== 3 ||
      secondResolved?.format !== 'comblang-resolved-source-circuit'
    ) {
      throw new Error('Expected two resolved v3 source compilations.');
    }
    expect(firstPlan.context).toEqual(secondPlan.context);
    expect(firstPlan.producers).toHaveLength(secondPlan.producers.length);
    expect(firstPlan.entities).toHaveLength(secondPlan.entities.length);
    expect(firstResolved.planFingerprint).not.toBe(secondResolved.planFingerprint);

    expect(() => createSourceCircuitArtifact(firstPlan, secondResolved)).toThrow(
      /fingerprint does not match/,
    );
    const modifiedPlan = {
      ...firstPlan,
      producers: firstPlan.producers.map((producer) =>
        producer.kind === 'arithmetic'
          ? { ...producer, right: { kind: 'constant' as const, value: 99 } }
          : producer,
      ),
    };
    expect(() => createSourceCircuitArtifact(modifiedPlan, firstResolved)).toThrow(
      /fingerprint does not match/,
    );
  });

  test('hydrates a mixed combinator and Entity source without replaying the Entity plan', () => {
    const profile = syntheticSharedTwoColorEntityProfile;
    const trustedEntityReplayContext = createTrustedEntityReplayContext({
      database: profile.ref.database,
      source: 'synthetic',
      evidenceIdentity: 'comblang-synthetic-evidence-v1',
      policyIdentity: 'comblang-entity-policy-v1',
      profiles: [profile],
    });
    const prototype = {
      key: profile.ref.prototypeKey,
      name: 'synthetic-shared-two-color',
      type: 'container',
    } as EntityPrototype;
    const compiled = compileSource(
      {
        path: 'mixed-entity-preview.factorio.ts',
        text: `const entity = Entity('synthetic-shared-two-color');
const input = new Network<R>();
const output: Network = input + 1;`,
      },
      {
        trustedEntityReplayContext,
        entityPrototypeResolver: {
          database: profile.ref.database,
          getEntity(nameOrKey) {
            return nameOrKey === prototype.key || nameOrKey === prototype.name
              ? prototype
              : undefined;
          },
        },
      },
    );
    const plan = compiled.plan;
    const resolvedCircuit = compiled.resolvedCircuit;
    if (
      plan === undefined ||
      plan.version !== 3 ||
      resolvedCircuit?.format !== 'comblang-resolved-source-circuit'
    ) {
      throw new Error('Expected a resolved mixed v3 source compilation.');
    }

    const artifact = createSourceCircuitArtifact(plan, resolvedCircuit);
    const demo = runSourceCircuitDemo(artifact, 3, 1);

    expect(demo).toMatchObject({ combinators: 1, outputValue: 4 });
    expect(artifact.execution.circuit.ir.entities).toHaveLength(1);
  });

  test('turns missing, malformed, and mismatched resolved data into WEB1001 preview diagnostics', () => {
    const profile = syntheticSharedTwoColorEntityProfile;
    const trustedEntityReplayContext = createTrustedEntityReplayContext({
      database: profile.ref.database,
      source: 'synthetic',
      evidenceIdentity: 'comblang-synthetic-evidence-v1',
      policyIdentity: 'comblang-entity-policy-v1',
      profiles: [profile],
    });
    const prototype = {
      key: profile.ref.prototypeKey,
      name: 'synthetic-shared-two-color',
      type: 'container',
    } as EntityPrototype;
    const compiled = compileSource(
      {
        path: 'invalid-resolved-preview.factorio.ts',
        text: "Entity('synthetic-shared-two-color');",
      },
      {
        trustedEntityReplayContext,
        entityPrototypeResolver: {
          database: profile.ref.database,
          getEntity(nameOrKey) {
            return nameOrKey === prototype.key || nameOrKey === prototype.name
              ? prototype
              : undefined;
          },
        },
      },
    );
    const plan = compiled.plan;
    const resolvedCircuit = compiled.resolvedCircuit;
    if (
      plan === undefined ||
      plan.version !== 3 ||
      resolvedCircuit?.format !== 'comblang-resolved-source-circuit'
    ) {
      throw new Error('Expected a resolved Entity source compilation.');
    }

    const malformed = structuredClone(resolvedCircuit) as { format: string };
    malformed.format = 'wrong';
    const mismatched = structuredClone(resolvedCircuit) as any;
    mismatched.ir.context.evidenceIdentity = 'evidence:other';
    const captureError = (action: () => void): unknown => {
      try {
        action();
      } catch (error) {
        return error;
      }
      throw new Error('Expected invalid resolved data to fail.');
    };
    for (const error of [
      captureError(() => createSourceCircuitArtifact(plan, undefined as never)),
      captureError(() => createSourceCircuitArtifact(plan, malformed as never)),
      captureError(() => createSourceCircuitArtifact(plan, mismatched)),
    ]) {
      expect(sourcePreviewDiagnostic(error)).toMatchObject({ code: 'WEB1001', severity: 'error' });
    }
  });

  test('shares one elaborated circuit across preview consumers and fresh simulations', () => {
    const compiled = compileSource({
      path: 'shared-preview.factorio.ts',
      text: `const A = Signal("virtual", "signal-A");
const input = new Network();
const output = new Network();
output += input * 2;`,
    });
    expect(compiled.compilerDiagnostics).toEqual([]);

    const artifact = createSourceCircuitArtifact(compiled.plan!);
    const controller = new SourceSimulationController(artifact);
    const demo = runSourceCircuitDemo(artifact, 3);
    controller.reset();

    expect(Object.isFrozen(artifact)).toBe(true);
    expect(demo.outputValue).toBe(6);
    expect(blueprintJsonForArtifact(artifact)).toBe(artifact.blueprint);
    expect(artifact.blueprint.blueprint.entities).toHaveLength(1);

    const input = controller.timeline[0]!.networks.find(({ name }) => name === 'input')!;
    controller.setSignalAt(0, input.id, signal('virtual', 'signal-A'), 4);
    controller.stepFrom(0);
    expect(controller.signalValueAt(1, 'output', signal('virtual', 'signal-A'))).toBe(8);
  });
});

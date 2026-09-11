import { signal } from '@comblang/factorio';
import type { DirectElaborationPlanV3 } from '@comblang/compiler/entity';
import { syntheticSharedTwoColorEntityProfile } from '@comblang/compiler/entity-fixtures';
import { createTrustedEntityReplayContext } from '@comblang/compiler/entity-replay-context';
import type { EntityPrototype } from '@comblang/prototypes';
import type { EntityPrototypeResolver } from '@comblang/runtime/entity-registry';
import { describe, expect, test } from 'vitest';

import { blueprintJsonForArtifact, blueprintJsonForPlan } from './blueprint-demo.js';
import { compileSource } from './compile-source.js';
import { createSourceCircuitArtifact } from './source-circuit-artifact.js';
import {
  runSourceCircuitDemo,
  runSourcePlanDemo,
  SourceSimulationController,
} from './source-demo.js';

describe('source circuit artifact', () => {
  test('requires a correlated host context for every v3 artifact consumer at compile time', () => {
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
    const artifact = createSourceCircuitArtifact(plan, trustedEntityReplayContext);
    const controller = new SourceSimulationController(artifact);
    const demo = runSourceCircuitDemo(artifact, 0, 0);

    expect(artifact.plan.version).toBe(3);
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

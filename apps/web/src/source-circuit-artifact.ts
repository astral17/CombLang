import {
  generateBlueprintJson,
  generateEntityBlueprintJson,
} from '@comblang/compiler/blueprint-json';
import { resolvedSourceCircuitPlanFingerprint } from '@comblang/compiler/resolved-source-circuit';
import type { DirectElaborationPlan } from '@comblang/compiler/direct-plan-schema';
import type { DirectElaborationPlanV3 } from '@comblang/compiler/entity';
import {
  elaborateDirectPlan,
  hydrateResolvedSourceCircuit,
  type NetworkHandle,
  type SimulationInitialValue,
  type ResolvedSourceCircuitRuntime,
  type ExecutedDirectPlan,
} from '@comblang/runtime';
import type { SimulationKernel } from '@comblang/simulator';
import type { ElaborationGraphV3, NativeCircuitIrV3 } from '@comblang/compiler/entity';
import type { NetworkId } from '@comblang/shared';

export type SourcePlan = DirectElaborationPlan | DirectElaborationPlanV3;
export type SourceExecution = ExecutedDirectPlan | ResolvedSourceCircuitExecution;

/**
 * Main-thread representation of one successfully compiled source circuit.
 *
 * An execution contains runtime handles and therefore cannot cross the compiler
 * Worker boundary. Once the accepted plan reaches the UI, however, every
 * preview can share this single elaboration.
 */
export interface LegacySourceCircuitArtifact {
  readonly plan: DirectElaborationPlan;
  readonly execution: ExecutedDirectPlan;
  readonly blueprint: ReturnType<typeof generateBlueprintJson>;
}

export interface EntitySourceCircuitArtifact {
  readonly plan: DirectElaborationPlanV3;
  readonly resolvedCircuit: ResolvedSourceCircuitRuntime['artifact'];
  readonly execution: ResolvedSourceCircuitExecution;
  readonly blueprint: ReturnType<typeof generateEntityBlueprintJson>;
}

export type SourceCircuitArtifact = LegacySourceCircuitArtifact | EntitySourceCircuitArtifact;

export interface ResolvedSourceCircuitExecution {
  readonly circuit: {
    readonly graph: ElaborationGraphV3;
    readonly ir: NativeCircuitIrV3;
    createSimulation(initial?: readonly SimulationInitialValue[]): SimulationKernel;
  };
  readonly debug: {
    readonly scopes: readonly {
      readonly networks: readonly { readonly planName: string; readonly id: NetworkId }[];
    }[];
  };
  network(nameOrId: string): NetworkHandle;
}

export function createSourceCircuitArtifact(
  plan: DirectElaborationPlan,
): LegacySourceCircuitArtifact;
export function createSourceCircuitArtifact(
  plan: DirectElaborationPlanV3,
  resolvedCircuit: ResolvedSourceCircuitRuntime['artifact'],
): EntitySourceCircuitArtifact;
export function createSourceCircuitArtifact(
  plan: SourcePlan,
  resolvedCircuit?: ResolvedSourceCircuitRuntime['artifact'],
): SourceCircuitArtifact {
  if (plan.version === 3) {
    if (resolvedCircuit === undefined) {
      throw new Error('Entity v3 preview requires the matching resolved circuit.');
    }
    if (resolvedCircuit.planFingerprint !== resolvedSourceCircuitPlanFingerprint(plan)) {
      throw new Error('Resolved circuit fingerprint does not match the compiled Entity plan.');
    }
    const runtime = hydrateResolvedSourceCircuit(resolvedCircuit);
    assertResolvedCircuitMatchesPlan(plan, runtime.ir);
    const execution = resolvedExecution(plan, runtime);
    return Object.freeze({
      plan,
      resolvedCircuit: runtime.artifact,
      execution,
      blueprint: generateEntityBlueprintJson(runtime.ir),
    });
  }
  const execution = elaborateDirectPlan(plan);
  return Object.freeze({
    plan,
    execution,
    blueprint: generateBlueprintJson(execution.circuit.ir),
  });
}

function assertResolvedCircuitMatchesPlan(
  plan: DirectElaborationPlanV3,
  ir: NativeCircuitIrV3,
): void {
  const sameIdentity = (left: unknown, right: unknown): boolean =>
    JSON.stringify(left) === JSON.stringify(right);
  if (!sameIdentity(plan.context, ir.context)) {
    throw new Error('Resolved circuit context does not match the compiled Entity plan.');
  }
  if (plan.producers.length !== ir.producers.length) {
    throw new Error('Resolved circuit producer count does not match the compiled Entity plan.');
  }
  if (plan.entities.length !== ir.entities.length) {
    throw new Error('Resolved circuit Entity count does not match the compiled Entity plan.');
  }
  const physicalById = new Map(ir.entities.map((entity) => [entity.id, entity]));
  for (const planned of plan.entities) {
    const physical = physicalById.get(planned.id);
    if (
      physical === undefined ||
      physical.ordinal !== planned.ordinal ||
      !sameIdentity(physical.profile, planned.profile) ||
      physical.prototypeName !== planned.profile.prototypeKey.slice('entity:'.length)
    ) {
      throw new Error(`Resolved circuit Entity ${planned.id} does not match the compiled plan.`);
    }
  }
}

function resolvedExecution(
  plan: DirectElaborationPlanV3,
  runtime: ResolvedSourceCircuitRuntime,
): ResolvedSourceCircuitExecution {
  const names = new Map<string, NetworkHandle>();
  for (const network of runtime.ir.networks) {
    const handle = runtime.network(network.id);
    names.set(network.id, handle);
    if (network.name !== undefined) names.set(network.name, handle);
  }
  for (const alias of plan.networkAliases ?? []) {
    const handle = names.get(alias.network);
    if (handle !== undefined) names.set(alias.name, handle);
  }
  const network = (nameOrId: string): NetworkHandle => {
    const handle = names.get(nameOrId);
    if (handle === undefined) throw new Error(`Unknown resolved Network: ${nameOrId}.`);
    return handle;
  };
  const graph = Object.freeze({
    format: 'comblang-eg' as const,
    version: 3 as const,
    context: runtime.ir.context,
    networks: Object.freeze(
      runtime.ir.networks.map(({ color: _color, ...network }) => Object.freeze(network)),
    ),
    producers: runtime.ir.producers,
    attachments: Object.freeze(
      runtime.ir.producers.flatMap((producer) =>
        producer.destinations.map((network) =>
          Object.freeze({ producer: producer.id, network, provenance: producer.provenance }),
        ),
      ),
    ),
    entities: runtime.ir.entities,
  });
  return Object.freeze({
    circuit: Object.freeze({
      graph,
      ir: runtime.ir,
      createSimulation(initial: readonly SimulationInitialValue[] = []) {
        return runtime.createSimulation(initial);
      },
    }),
    debug: Object.freeze({
      scopes: Object.freeze([
        Object.freeze({
          networks: Object.freeze(
            runtime.ir.networks.map((candidate) =>
              Object.freeze({ planName: candidate.name ?? candidate.id, id: candidate.id }),
            ),
          ),
        }),
      ]),
    }),
    network,
  });
}

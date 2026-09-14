import {
  generateBlueprintJson,
  generateEntityComputationBlueprintJson,
  generateEntityBlueprintJson,
} from '@comblang/compiler/blueprint-json';
import { resolvedSourceCircuitPlanFingerprint } from '@comblang/compiler/resolved-source-circuit';
import {
  assertResolvedEntityV4CircuitMatchesPlan,
  resolvedEntityV4CircuitPlanFingerprint,
  type ResolvedEntityV4Circuit,
} from '@comblang/compiler/resolved-entity-v4';
import type { DirectElaborationPlan } from '@comblang/compiler/direct-plan-schema';
import type { DirectElaborationPlanV3 } from '@comblang/compiler/entity';
import type {
  DirectElaborationPlanV4,
  ElaborationGraphV4,
  NativeCircuitIrV4,
} from '@comblang/compiler/entity-v4';
import {
  elaborateDirectPlan,
  hydrateResolvedSourceCircuit,
  hydrateResolvedEntityV4Circuit,
  type NetworkHandle,
  type SimulationInitialValue,
  type ResolvedSourceCircuitRuntime,
  type ExecutedDirectPlan,
} from '@comblang/runtime';
import type { SimulationKernel } from '@comblang/simulator';
import type { ElaborationGraphV3, NativeCircuitIrV3 } from '@comblang/compiler/entity';
import type { NetworkId } from '@comblang/shared';

export type SourcePlan = DirectElaborationPlan | DirectElaborationPlanV3 | DirectElaborationPlanV4;
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

export interface EntityComputationSourceCircuitArtifact {
  readonly plan: DirectElaborationPlanV4;
  readonly resolvedCircuit: ResolvedEntityV4Circuit;
  readonly execution: ResolvedSourceCircuitExecution;
  readonly blueprint: ReturnType<typeof generateEntityComputationBlueprintJson>;
}

export type SourceCircuitArtifact =
  | LegacySourceCircuitArtifact
  | EntitySourceCircuitArtifact
  | EntityComputationSourceCircuitArtifact;

export interface ResolvedSourceCircuitExecution {
  readonly circuit: {
    readonly graph: ElaborationGraphV3 | ElaborationGraphV4;
    readonly ir: NativeCircuitIrV3 | NativeCircuitIrV4;
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
  plan: DirectElaborationPlanV4,
  resolvedCircuit: ResolvedEntityV4Circuit,
): EntityComputationSourceCircuitArtifact;
export function createSourceCircuitArtifact(
  plan: SourcePlan,
  resolvedCircuit?: ResolvedSourceCircuitRuntime['artifact'] | ResolvedEntityV4Circuit,
): SourceCircuitArtifact {
  if (plan.version === 4) {
    if (resolvedCircuit === undefined || resolvedCircuit.format !== 'comblang-resolved-entity-v4') {
      throw new Error('Entity v4 preview requires the matching resolved circuit.');
    }
    if (resolvedCircuit.planFingerprint !== resolvedEntityV4CircuitPlanFingerprint(plan)) {
      throw new Error('Resolved Entity v4 circuit fingerprint does not match the compiled plan.');
    }
    assertResolvedEntityV4CircuitMatchesPlan(plan, resolvedCircuit);
    const runtime = hydrateResolvedEntityV4Circuit(resolvedCircuit);
    const execution = resolvedEntityV4Execution(plan, runtime);
    return Object.freeze({
      plan,
      resolvedCircuit: runtime.artifact,
      execution,
      blueprint: generateEntityComputationBlueprintJson(runtime.ir),
    });
  }
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
  const { network, debug } = resolvedNetworkViews(plan, runtime);
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
    debug,
    network,
  });
}

function resolvedNetworkViews(
  plan: Pick<DirectElaborationPlanV3 | DirectElaborationPlanV4, 'networkAliases'>,
  runtime: {
    readonly ir: {
      readonly networks: readonly { readonly id: NetworkId; readonly name?: string }[];
    };
    network(id: NetworkId): NetworkHandle;
  },
): Pick<ResolvedSourceCircuitExecution, 'debug' | 'network'> {
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
  return Object.freeze({
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

function resolvedEntityV4Execution(
  plan: DirectElaborationPlanV4,
  runtime: ReturnType<typeof hydrateResolvedEntityV4Circuit>,
): ResolvedSourceCircuitExecution {
  const { network, debug } = resolvedNetworkViews(plan, runtime);
  const graph: ElaborationGraphV4 = Object.freeze({
    format: 'comblang-eg',
    version: 4,
    context: runtime.ir.context,
    networks: Object.freeze(
      runtime.ir.networks.map(({ color: _color, ...candidate }) => Object.freeze(candidate)),
    ),
    producers: runtime.ir.producers,
    attachments: Object.freeze(
      runtime.ir.producers.flatMap((producer) =>
        producer.destinations.map((destination) =>
          Object.freeze({
            producer: producer.id,
            network: destination,
            provenance: producer.provenance,
          }),
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
        return runtime.createSimulation(
          initial.map((value) => ({
            network: runtime.network(value.network.id),
            values: value.values,
          })),
        );
      },
    }),
    debug,
    network,
  });
}

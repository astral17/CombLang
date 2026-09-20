import {
  generateBlueprintJson,
  generateEntityComputationBlueprintJson,
  generateEntityComputationBlueprintJsonV5,
  generateEntityComputationBlueprintJsonV6,
  generateEntityComputationBlueprintJsonV7,
  generateEntityBlueprintJson,
} from '@comblang/compiler/blueprint-json';
import { resolvedSourceCircuitPlanFingerprint } from '@comblang/compiler/resolved-source-circuit';
import {
  assertResolvedEntityV4CircuitMatchesPlan,
  resolvedEntityV4CircuitPlanFingerprint,
  type ResolvedEntityV4Circuit,
} from '@comblang/compiler/resolved-entity-v4';
import {
  assertResolvedEntityV5CircuitMatchesPlan,
  resolvedEntityV5CircuitPlanFingerprint,
  type ResolvedEntityV5Circuit,
} from '@comblang/compiler/resolved-entity-v5';
import {
  assertResolvedEntityV6CircuitMatchesPlan,
  resolvedEntityV6CircuitPlanFingerprint,
  type ResolvedEntityV6Circuit,
} from '@comblang/compiler/resolved-entity-v6';
import {
  assertResolvedEntityV7CircuitMatchesPlan,
  resolvedEntityV7CircuitPlanFingerprint,
  type ResolvedEntityV7Circuit,
} from '@comblang/compiler/resolved-entity-v7';
import type { DirectElaborationPlan } from '@comblang/compiler/direct-plan-schema';
import type { DirectElaborationPlanV3 } from '@comblang/compiler/entity';
import type {
  DirectElaborationPlanV4,
  ElaborationGraphV4,
  NativeCircuitIrV4,
} from '@comblang/compiler/entity-v4';
import type {
  DirectElaborationPlanV5,
  ElaborationGraphV5,
  NativeCircuitIrV5,
} from '@comblang/compiler/entity-v5';
import type {
  DirectElaborationPlanV6,
  ElaborationGraphV6,
  NativeCircuitIrV6,
} from '@comblang/compiler/entity-v6';
import type {
  DirectElaborationPlanV7,
  ElaborationGraphV7,
  NativeCircuitIrV7,
} from '@comblang/compiler/entity-v7';
import {
  elaborateDirectPlan,
  hydrateResolvedSourceCircuit,
  hydrateResolvedEntityV4Circuit,
  hydrateResolvedEntityV5Circuit,
  hydrateResolvedEntityV6Circuit,
  hydrateResolvedEntityV7Circuit,
  type NetworkHandle,
  type SimulationInitialValue,
  type ResolvedSourceCircuitRuntime,
  type ExecutedDirectPlan,
} from '@comblang/runtime';
import type { SimulationKernel } from '@comblang/simulator';
import type { ElaborationGraphV3, NativeCircuitIrV3 } from '@comblang/compiler/entity';
import type { NetworkId } from '@comblang/shared';

export type SourcePlan =
  | DirectElaborationPlan
  | DirectElaborationPlanV3
  | DirectElaborationPlanV4
  | DirectElaborationPlanV5
  | DirectElaborationPlanV6
  | DirectElaborationPlanV7;
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

export interface EntityCumulativeSourceCircuitArtifact {
  readonly plan: DirectElaborationPlanV5;
  readonly resolvedCircuit: ResolvedEntityV5Circuit;
  readonly execution: ResolvedSourceCircuitExecution;
  readonly blueprint: ReturnType<typeof generateEntityComputationBlueprintJsonV5>;
}

export interface EntityDeciderSourceCircuitArtifact {
  readonly plan: DirectElaborationPlanV6;
  readonly resolvedCircuit: ResolvedEntityV6Circuit;
  readonly execution: ResolvedSourceCircuitExecution;
  readonly blueprint: ReturnType<typeof generateEntityComputationBlueprintJsonV6>;
}

export interface EntitySelectorSourceCircuitArtifact {
  readonly plan: DirectElaborationPlanV7;
  readonly resolvedCircuit: ResolvedEntityV7Circuit;
  readonly execution: ResolvedSourceCircuitExecution;
  readonly blueprint: ReturnType<typeof generateEntityComputationBlueprintJsonV7>;
}

export type SourceCircuitArtifact =
  | LegacySourceCircuitArtifact
  | EntitySourceCircuitArtifact
  | EntityComputationSourceCircuitArtifact
  | EntityCumulativeSourceCircuitArtifact
  | EntityDeciderSourceCircuitArtifact
  | EntitySelectorSourceCircuitArtifact;

export interface ResolvedSourceCircuitExecution {
  readonly circuit: {
    readonly graph:
      | ElaborationGraphV3
      | ElaborationGraphV4
      | ElaborationGraphV5
      | ElaborationGraphV6
      | ElaborationGraphV7;
    readonly ir:
      | NativeCircuitIrV3
      | NativeCircuitIrV4
      | NativeCircuitIrV5
      | NativeCircuitIrV6
      | NativeCircuitIrV7;
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
  plan: DirectElaborationPlanV5,
  resolvedCircuit: ResolvedEntityV5Circuit,
): EntityCumulativeSourceCircuitArtifact;
export function createSourceCircuitArtifact(
  plan: DirectElaborationPlanV6,
  resolvedCircuit: ResolvedEntityV6Circuit,
): EntityDeciderSourceCircuitArtifact;
export function createSourceCircuitArtifact(
  plan: DirectElaborationPlanV7,
  resolvedCircuit: ResolvedEntityV7Circuit,
): EntitySelectorSourceCircuitArtifact;
export function createSourceCircuitArtifact(
  plan: SourcePlan,
  resolvedCircuit?:
    | ResolvedSourceCircuitRuntime['artifact']
    | ResolvedEntityV4Circuit
    | ResolvedEntityV5Circuit
    | ResolvedEntityV6Circuit
    | ResolvedEntityV7Circuit,
): SourceCircuitArtifact {
  if (plan.version === 7) {
    if (resolvedCircuit === undefined || resolvedCircuit.format !== 'comblang-resolved-entity-v7') {
      throw new Error('Entity v7 preview requires the matching resolved circuit.');
    }
    if (resolvedCircuit.planFingerprint !== resolvedEntityV7CircuitPlanFingerprint(plan)) {
      throw new Error('Resolved Entity v7 circuit fingerprint does not match the compiled plan.');
    }
    assertResolvedEntityV7CircuitMatchesPlan(plan, resolvedCircuit);
    const runtime = hydrateResolvedEntityV7Circuit(resolvedCircuit);
    const execution = resolvedEntityV7Execution(plan, runtime);
    return Object.freeze({
      plan,
      resolvedCircuit: runtime.artifact,
      execution,
      blueprint: generateEntityComputationBlueprintJsonV7(runtime.ir),
    });
  }
  if (plan.version === 6) {
    if (resolvedCircuit === undefined || resolvedCircuit.format !== 'comblang-resolved-entity-v6') {
      throw new Error('Entity v6 preview requires the matching resolved circuit.');
    }
    if (resolvedCircuit.planFingerprint !== resolvedEntityV6CircuitPlanFingerprint(plan)) {
      throw new Error('Resolved Entity v6 circuit fingerprint does not match the compiled plan.');
    }
    assertResolvedEntityV6CircuitMatchesPlan(plan, resolvedCircuit);
    const runtime = hydrateResolvedEntityV6Circuit(resolvedCircuit);
    const execution = resolvedEntityV6Execution(plan, runtime);
    return Object.freeze({
      plan,
      resolvedCircuit: runtime.artifact,
      execution,
      blueprint: generateEntityComputationBlueprintJsonV6(runtime.ir),
    });
  }
  if (plan.version === 5) {
    if (resolvedCircuit === undefined || resolvedCircuit.format !== 'comblang-resolved-entity-v5') {
      throw new Error('Entity v5 preview requires the matching resolved circuit.');
    }
    if (resolvedCircuit.planFingerprint !== resolvedEntityV5CircuitPlanFingerprint(plan)) {
      throw new Error('Resolved Entity v5 circuit fingerprint does not match the compiled plan.');
    }
    assertResolvedEntityV5CircuitMatchesPlan(plan, resolvedCircuit);
    const runtime = hydrateResolvedEntityV5Circuit(resolvedCircuit);
    const execution = resolvedEntityV5Execution(plan, runtime);
    return Object.freeze({
      plan,
      resolvedCircuit: runtime.artifact,
      execution,
      blueprint: generateEntityComputationBlueprintJsonV5(runtime.ir),
    });
  }
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
  plan: Pick<
    | DirectElaborationPlanV3
    | DirectElaborationPlanV4
    | DirectElaborationPlanV5
    | DirectElaborationPlanV6
    | DirectElaborationPlanV7,
    'networkAliases'
  >,
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

function resolvedEntityV5Execution(
  plan: DirectElaborationPlanV5,
  runtime: ReturnType<typeof hydrateResolvedEntityV5Circuit>,
): ResolvedSourceCircuitExecution {
  const { network, debug } = resolvedNetworkViews(plan, runtime);
  const graph: ElaborationGraphV5 = Object.freeze({
    format: 'comblang-eg',
    version: 5,
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

function resolvedEntityV6Execution(
  plan: DirectElaborationPlanV6,
  runtime: ReturnType<typeof hydrateResolvedEntityV6Circuit>,
): ResolvedSourceCircuitExecution {
  const { network, debug } = resolvedNetworkViews(plan, runtime);
  const graph: ElaborationGraphV6 = Object.freeze({
    format: 'comblang-eg',
    version: 6,
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

function resolvedEntityV7Execution(
  plan: DirectElaborationPlanV7,
  runtime: ReturnType<typeof hydrateResolvedEntityV7Circuit>,
): ResolvedSourceCircuitExecution {
  const { network, debug } = resolvedNetworkViews(plan, runtime);
  const graph: ElaborationGraphV7 = Object.freeze({
    format: 'comblang-eg',
    version: 7,
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

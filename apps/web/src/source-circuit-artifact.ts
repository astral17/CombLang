import { generateBlueprintJson } from '@comblang/compiler/blueprint-json';
import type { DirectElaborationPlan } from '@comblang/compiler/direct-plan-schema';
import type { ElaborationGraph, NativeCircuitIr } from '@comblang/compiler/ir';
import type { ResolvedCircuit } from '@comblang/compiler/resolved-circuit';
import {
  canonicalDirectPlan,
  canonicalPlanFingerprint,
  canonicalResolvedCircuit,
  elaborateDirectPlan,
  hydrateResolvedCircuit,
  type ExecutedDirectPlan,
  type NetworkHandle,
  type SimulationInitialValue,
} from '@comblang/runtime';
import type { NetworkId } from '@comblang/shared';
import type { SimulationKernel } from '@comblang/simulator';

export interface SourceCircuitExecution {
  readonly circuit: {
    readonly graph: ElaborationGraph;
    readonly ir: NativeCircuitIr;
    createSimulation(initial?: readonly SimulationInitialValue[]): SimulationKernel;
  };
  readonly debug: {
    readonly scopes: readonly {
      readonly networks: readonly { readonly planName: string; readonly id: NetworkId }[];
    }[];
  };
  network(nameOrId: string): NetworkHandle;
}

export type SourceExecution = ExecutedDirectPlan | SourceCircuitExecution;

/** Main-thread artifact for one canonical source compilation. */
export interface SourceCircuitArtifact {
  readonly plan: DirectElaborationPlan;
  readonly resolvedCircuit: ResolvedCircuit;
  readonly execution: SourceExecution;
  readonly blueprint: ReturnType<typeof generateBlueprintJson>;
}

export function createSourceCircuitArtifact(
  plan: DirectElaborationPlan,
  resolvedCircuit?: ResolvedCircuit,
): SourceCircuitArtifact {
  plan = canonicalDirectPlan(plan);
  if (plan.entities.length > 0 && resolvedCircuit === undefined) {
    throw new Error('Entity-bearing canonical preview requires the matching resolved circuit.');
  }

  if (resolvedCircuit !== undefined) {
    if (resolvedCircuit.format !== 'comblang-resolved-circuit') {
      throw new Error('Canonical preview requires a canonical resolved circuit.');
    }
    if (resolvedCircuit.planFingerprint !== canonicalPlanFingerprint(plan)) {
      throw new Error('Canonical resolved circuit fingerprint does not match the compiled plan.');
    }
    assertCanonicalCircuitMatchesPlan(plan, resolvedCircuit.ir);
    const runtime = hydrateResolvedCircuit(resolvedCircuit);
    const execution = canonicalResolvedExecution(plan, runtime);
    return Object.freeze({
      plan,
      resolvedCircuit: runtime.artifact,
      execution,
      blueprint: generateBlueprintJson(runtime.ir),
    });
  }

  const execution = elaborateDirectPlan(plan);
  const canonicalArtifact = canonicalResolvedCircuit(
    undefined,
    plan,
    execution.circuit.ir,
  ) as ResolvedCircuit;
  return Object.freeze({
    plan,
    resolvedCircuit: canonicalArtifact,
    execution,
    blueprint: generateBlueprintJson(execution.circuit.ir),
  });
}

function assertCanonicalCircuitMatchesPlan(plan: DirectElaborationPlan, ir: NativeCircuitIr): void {
  const sameIdentity = (left: unknown, right: unknown): boolean =>
    JSON.stringify(left) === JSON.stringify(right);
  if (!sameIdentity(plan.context, ir.context)) {
    throw new Error('Resolved circuit context does not match the compiled canonical plan.');
  }
  if (plan.producers.length !== ir.producers.length) {
    throw new Error('Resolved circuit producer count does not match the compiled canonical plan.');
  }
  if (plan.entities.length !== ir.entities.length) {
    throw new Error('Resolved circuit Entity count does not match the compiled canonical plan.');
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

function canonicalResolvedExecution(
  plan: DirectElaborationPlan,
  runtime: ReturnType<typeof hydrateResolvedCircuit>,
): SourceCircuitExecution {
  const { network, debug } = resolvedNetworkViews(plan, runtime);
  const graph: ElaborationGraph = Object.freeze({
    format: 'comblang-eg',
    ...(runtime.ir.context === undefined ? {} : { context: runtime.ir.context }),
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

function resolvedNetworkViews(
  plan: Pick<DirectElaborationPlan, 'networkAliases'>,
  runtime: ReturnType<typeof hydrateResolvedCircuit>,
): Pick<SourceCircuitExecution, 'debug' | 'network'> {
  const names = new Map<string, NetworkHandle>();
  for (const candidate of runtime.ir.networks) {
    const handle = runtime.network(candidate.id);
    names.set(candidate.id, handle);
    if (candidate.name !== undefined) names.set(candidate.name, handle);
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

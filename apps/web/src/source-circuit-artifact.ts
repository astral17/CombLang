import { generateBlueprintJson } from '@comblang/compiler/blueprint-json';
import type { DirectElaborationPlan } from '@comblang/compiler/direct-plan-schema';
import type { ElaborationGraph, NativeCircuitIr } from '@comblang/compiler/ir';
import type { ResolvedCircuit } from '@comblang/compiler/resolved-circuit';
import {
  canonicalDirectPlan,
  canonicalResolvedCircuit,
  elaborateDirectPlan,
  executeResolvedDirectPlan,
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
    const validated = executeResolvedDirectPlan(plan, resolvedCircuit);
    // Preview retains physical-ID lookup and survivor/alias views. Runtime replay
    // exposes source-name handles, so build the existing adapter only after validation.
    const runtime = hydrateResolvedCircuit({ ...resolvedCircuit, ir: validated.circuit.ir });
    const execution = canonicalResolvedExecution(plan, runtime, validated.circuit.graph);
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

function canonicalResolvedExecution(
  plan: DirectElaborationPlan,
  runtime: ReturnType<typeof hydrateResolvedCircuit>,
  graph: ElaborationGraph,
): SourceCircuitExecution {
  const { network, debug } = resolvedNetworkViews(plan, runtime);
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

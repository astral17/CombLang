import {
  parseResolvedEntityV4Circuit,
  type ResolvedEntityV4Circuit,
} from '@comblang/compiler/resolved-entity-v4';
import type { NativeCircuitIrV3 } from '@comblang/compiler/entity';
import type { NativeCircuitIrV4 } from '@comblang/compiler/entity-v4';
import type { SparseBus } from '@comblang/factorio';
import type { NetworkId } from '@comblang/shared';
import type { SimulationKernel } from '@comblang/simulator';
import {
  createSimulationFromNativeCircuitIr,
  RuntimeDiagnosticError,
  type NativeCircuitSimulationInitialValue,
} from './elaboration.js';

export interface ResolvedEntityV4CircuitNetworkHandle {
  readonly kind: 'network';
  readonly id: NetworkId;
}

export interface ResolvedEntityV4SimulationInitialValue {
  readonly network: ResolvedEntityV4CircuitNetworkHandle;
  readonly values: SparseBus;
}

export interface ResolvedEntityV4CircuitRuntime {
  readonly artifact: ResolvedEntityV4Circuit;
  readonly ir: NativeCircuitIrV4;
  readonly networks: readonly ResolvedEntityV4CircuitNetworkHandle[];
  network(id: NetworkId): ResolvedEntityV4CircuitNetworkHandle;
  createSimulation(initial?: readonly ResolvedEntityV4SimulationInitialValue[]): SimulationKernel;
}

function unknownNetwork(id: NetworkId): never {
  throw new RuntimeDiagnosticError({
    code: 'RT1005',
    severity: 'error',
    message: `Unknown Network: ${id}.`,
  });
}

function simulationIr(ir: NativeCircuitIrV4): NativeCircuitIrV3 {
  return {
    format: 'comblang-ncir',
    version: 3,
    context: ir.context,
    networks: ir.networks,
    producers: ir.producers.map(({ entityId: _entityId, ...producer }) => producer),
    // Physical Entities remain inert; the linked Constant view is the producer above.
    entities: [],
  } as NativeCircuitIrV3;
}

/** Hydrates a v4 resolved snapshot without profiles, providers, or replay context authority. */
export function hydrateResolvedEntityV4Circuit(input: unknown): ResolvedEntityV4CircuitRuntime {
  const artifact = parseResolvedEntityV4Circuit(input);
  const handles = new Map<NetworkId, ResolvedEntityV4CircuitNetworkHandle>();
  for (const network of artifact.ir.networks)
    handles.set(network.id, Object.freeze({ kind: 'network', id: network.id }));
  const ownedHandles = new Set(handles.values());
  const network = (id: NetworkId): ResolvedEntityV4CircuitNetworkHandle => {
    const handle = handles.get(id);
    if (handle === undefined) unknownNetwork(id);
    return handle;
  };
  const createSimulation = (
    initial: readonly ResolvedEntityV4SimulationInitialValue[] = [],
  ): SimulationKernel => {
    const nativeInitial: NativeCircuitSimulationInitialValue[] = initial.map((value) => {
      if (!ownedHandles.has(value.network)) {
        throw new RuntimeDiagnosticError({
          code: 'RT2001',
          severity: 'error',
          message: 'Foreign or invalid resolved Network handle.',
        });
      }
      return { network: value.network.id, values: value.values };
    });
    return createSimulationFromNativeCircuitIr(simulationIr(artifact.ir), nativeInitial);
  };
  return Object.freeze({
    artifact,
    ir: artifact.ir,
    networks: Object.freeze([...handles.values()]),
    network,
    createSimulation,
  });
}

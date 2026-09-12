import {
  parseResolvedSourceCircuit,
  type ResolvedSourceCircuit,
} from '@comblang/compiler/resolved-source-circuit';
import type { NativeCircuitIrV3 } from '@comblang/compiler/entity';
import type { SparseBus } from '@comblang/factorio';
import type { NetworkId } from '@comblang/shared';
import type { SimulationKernel } from '@comblang/simulator';

import {
  createSimulationFromNativeCircuitIr,
  RuntimeDiagnosticError,
  type NativeCircuitSimulationInitialValue,
} from './elaboration.js';

export interface ResolvedCircuitNetworkHandle {
  readonly kind: 'network';
  readonly id: NetworkId;
}

export interface ResolvedCircuitSimulationInitialValue {
  readonly network: ResolvedCircuitNetworkHandle;
  readonly values: SparseBus;
}

export interface ResolvedSourceCircuitRuntime {
  readonly artifact: ResolvedSourceCircuit;
  readonly ir: NativeCircuitIrV3;
  readonly networks: readonly ResolvedCircuitNetworkHandle[];
  network(id: NetworkId): ResolvedCircuitNetworkHandle;
  createSimulation(initial?: readonly ResolvedCircuitSimulationInitialValue[]): SimulationKernel;
}

function unknownNetwork(id: NetworkId): never {
  throw new RuntimeDiagnosticError({
    code: 'RT1005',
    severity: 'error',
    message: `Unknown Network: ${id}.`,
  });
}

/** Hydrates resolved physical data without consulting profiles or replay authority. */
export function hydrateResolvedSourceCircuit(input: unknown): ResolvedSourceCircuitRuntime {
  const artifact = parseResolvedSourceCircuit(input);
  const handles = new Map<NetworkId, ResolvedCircuitNetworkHandle>();
  for (const network of artifact.ir.networks) {
    handles.set(network.id, Object.freeze({ kind: 'network', id: network.id }));
  }
  const ownedHandles = new Set(handles.values());

  const network = (id: NetworkId): ResolvedCircuitNetworkHandle => {
    const handle = handles.get(id);
    if (handle === undefined) unknownNetwork(id);
    return handle;
  };

  const createSimulation = (
    initial: readonly ResolvedCircuitSimulationInitialValue[] = [],
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
    return createSimulationFromNativeCircuitIr(artifact.ir, nativeInitial);
  };

  return Object.freeze({
    artifact,
    ir: artifact.ir,
    networks: Object.freeze([...handles.values()]),
    network,
    createSimulation,
  });
}

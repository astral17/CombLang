import { parseResolvedCircuit, type ResolvedCircuit } from '@comblang/compiler/resolved-circuit';
import type { NativeCircuitIr } from '@comblang/compiler/ir';
import type { SparseBus } from '@comblang/factorio';
import type { NetworkId } from '@comblang/shared';
import type { SimulationKernel } from '@comblang/simulator';
import {
  createSimulationFromNativeCircuitIr,
  RuntimeDiagnosticError,
  type NativeCircuitSimulationInitialValue,
} from './elaboration.js';

export interface CanonicalResolvedCircuitNetworkHandle {
  readonly kind: 'network';
  readonly id: NetworkId;
}

export interface CanonicalResolvedCircuitSimulationInitialValue {
  readonly network: CanonicalResolvedCircuitNetworkHandle;
  readonly values: SparseBus;
}

export interface CanonicalResolvedCircuitRuntime {
  readonly artifact: ResolvedCircuit;
  readonly ir: NativeCircuitIr;
  readonly networks: readonly CanonicalResolvedCircuitNetworkHandle[];
  network(id: NetworkId): CanonicalResolvedCircuitNetworkHandle;
  createSimulation(
    initial?: readonly CanonicalResolvedCircuitSimulationInitialValue[],
  ): SimulationKernel;
}

export function hydrateResolvedCircuit(input: unknown): CanonicalResolvedCircuitRuntime {
  const artifact = parseResolvedCircuit(input);
  const handles = new Map<NetworkId, CanonicalResolvedCircuitNetworkHandle>();
  for (const network of artifact.ir.networks)
    handles.set(network.id, Object.freeze({ kind: 'network', id: network.id }));
  const ownedHandles = new Set(handles.values());
  const network = (id: NetworkId): CanonicalResolvedCircuitNetworkHandle => {
    const handle = handles.get(id);
    if (handle === undefined)
      throw new RuntimeDiagnosticError({
        code: 'RT1005',
        severity: 'error',
        message: `Unknown Network: ${id}.`,
      });
    return handle;
  };
  const createSimulation = (
    initial: readonly CanonicalResolvedCircuitSimulationInitialValue[] = [],
  ): SimulationKernel => {
    const nativeInitial: NativeCircuitSimulationInitialValue[] = initial.map((value) => {
      if (!ownedHandles.has(value.network))
        throw new RuntimeDiagnosticError({
          code: 'RT2001',
          severity: 'error',
          message: 'Foreign or invalid resolved Network handle.',
        });
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

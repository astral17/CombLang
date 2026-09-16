import {
  parseResolvedEntityV6Circuit,
  type ResolvedEntityV6Circuit,
} from '@comblang/compiler/resolved-entity-v6';
import type { NativeCircuitIrV6 } from '@comblang/compiler/entity-v6';
import { cloneAndDeepFreeze } from '@comblang/compiler/immutable';
import type { SparseBus } from '@comblang/factorio';
import type { NetworkId } from '@comblang/shared';
import type { SimulationKernel } from '@comblang/simulator';
import {
  createSimulationFromNativeCircuitIr,
  RuntimeDiagnosticError,
  type NativeCircuitSimulationInitialValue,
} from './elaboration.js';

export interface ResolvedEntityV6CircuitNetworkHandle {
  readonly kind: 'network';
  readonly id: NetworkId;
}

export interface ResolvedEntityV6CircuitSimulationInitialValue {
  readonly network: ResolvedEntityV6CircuitNetworkHandle;
  readonly values: SparseBus;
}

export interface ResolvedEntityV6CircuitRuntime {
  readonly artifact: ResolvedEntityV6Circuit;
  readonly ir: NativeCircuitIrV6;
  readonly networks: readonly ResolvedEntityV6CircuitNetworkHandle[];
  network(id: NetworkId): ResolvedEntityV6CircuitNetworkHandle;
  createSimulation(
    initial?: readonly ResolvedEntityV6CircuitSimulationInitialValue[],
  ): SimulationKernel;
}

export function hydrateResolvedEntityV6Circuit(input: unknown): ResolvedEntityV6CircuitRuntime {
  const artifact = cloneAndDeepFreeze(parseResolvedEntityV6Circuit(input));
  const handles = new Map<NetworkId, ResolvedEntityV6CircuitNetworkHandle>();
  for (const network of artifact.ir.networks)
    handles.set(network.id, Object.freeze({ kind: 'network', id: network.id }));
  const ownedHandles = new Set(handles.values());
  const network = (id: NetworkId): ResolvedEntityV6CircuitNetworkHandle => {
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
    initial: readonly ResolvedEntityV6CircuitSimulationInitialValue[] = [],
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

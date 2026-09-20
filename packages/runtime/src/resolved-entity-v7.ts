import {
  parseResolvedEntityV7Circuit,
  type ResolvedEntityV7Circuit,
} from '@comblang/compiler/resolved-entity-v7';
import type { NativeCircuitIrV7 } from '@comblang/compiler/entity-v7';
import { cloneAndDeepFreeze } from '@comblang/compiler/immutable';
import type { SparseBus } from '@comblang/factorio';
import type { NetworkId } from '@comblang/shared';
import type { SimulationKernel } from '@comblang/simulator';
import {
  createSimulationFromNativeCircuitIr,
  RuntimeDiagnosticError,
  type NativeCircuitSimulationInitialValue,
} from './elaboration.js';

export interface ResolvedEntityV7CircuitNetworkHandle {
  readonly kind: 'network';
  readonly id: NetworkId;
}

export interface ResolvedEntityV7CircuitSimulationInitialValue {
  readonly network: ResolvedEntityV7CircuitNetworkHandle;
  readonly values: SparseBus;
}

export interface ResolvedEntityV7CircuitRuntime {
  readonly artifact: ResolvedEntityV7Circuit;
  readonly ir: NativeCircuitIrV7;
  readonly networks: readonly ResolvedEntityV7CircuitNetworkHandle[];
  network(id: NetworkId): ResolvedEntityV7CircuitNetworkHandle;
  createSimulation(
    initial?: readonly ResolvedEntityV7CircuitSimulationInitialValue[],
  ): SimulationKernel;
}

export function hydrateResolvedEntityV7Circuit(input: unknown): ResolvedEntityV7CircuitRuntime {
  const artifact = cloneAndDeepFreeze(parseResolvedEntityV7Circuit(input));
  const handles = new Map<NetworkId, ResolvedEntityV7CircuitNetworkHandle>();
  for (const network of artifact.ir.networks)
    handles.set(network.id, Object.freeze({ kind: 'network', id: network.id }));
  const ownedHandles = new Set(handles.values());
  const network = (id: NetworkId): ResolvedEntityV7CircuitNetworkHandle => {
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
    initial: readonly ResolvedEntityV7CircuitSimulationInitialValue[] = [],
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

import {
  parseResolvedEntityV5Circuit,
  type ResolvedEntityV5Circuit,
} from '@comblang/compiler/resolved-entity-v5';
import type { NativeCircuitIrV5 } from '@comblang/compiler/entity-v5';
import { cloneAndDeepFreeze } from '@comblang/compiler/immutable';
import type { SparseBus } from '@comblang/factorio';
import type { NetworkId } from '@comblang/shared';
import type { SimulationKernel } from '@comblang/simulator';
import {
  createSimulationFromNativeCircuitIr,
  RuntimeDiagnosticError,
  type NativeCircuitSimulationInitialValue,
} from './elaboration.js';

export interface ResolvedEntityV5CircuitNetworkHandle {
  readonly kind: 'network';
  readonly id: NetworkId;
}

export interface ResolvedEntityV5CircuitSimulationInitialValue {
  readonly network: ResolvedEntityV5CircuitNetworkHandle;
  readonly values: SparseBus;
}

export interface ResolvedEntityV5CircuitRuntime {
  readonly artifact: ResolvedEntityV5Circuit;
  readonly ir: NativeCircuitIrV5;
  readonly networks: readonly ResolvedEntityV5CircuitNetworkHandle[];
  network(id: NetworkId): ResolvedEntityV5CircuitNetworkHandle;
  createSimulation(
    initial?: readonly ResolvedEntityV5CircuitSimulationInitialValue[],
  ): SimulationKernel;
}

export function hydrateResolvedEntityV5Circuit(input: unknown): ResolvedEntityV5CircuitRuntime {
  const artifact = cloneAndDeepFreeze(parseResolvedEntityV5Circuit(input));
  const handles = new Map<NetworkId, ResolvedEntityV5CircuitNetworkHandle>();
  for (const network of artifact.ir.networks)
    handles.set(network.id, Object.freeze({ kind: 'network', id: network.id }));
  const ownedHandles = new Set(handles.values());
  const network = (id: NetworkId): ResolvedEntityV5CircuitNetworkHandle => {
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
    initial: readonly ResolvedEntityV5CircuitSimulationInitialValue[] = [],
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

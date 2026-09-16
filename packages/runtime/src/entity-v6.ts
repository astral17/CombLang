import type { Diagnostic, NetworkId } from '@comblang/shared';
import type {
  DirectElaborationPlan,
  PlanArithmeticOperand,
} from '@comblang/compiler/direct-plan-schema';
import type { EntityId, EntityPhysicalRecord } from '@comblang/compiler/entity';
import type { CircuitProducerNode } from '@comblang/compiler/ir';
import type {
  DirectElaborationPlanV6,
  EntityPlanRecordV6,
  EntityPhysicalRecordV6,
  EntityV6PhysicalConfiguration,
  ElaborationGraphV6,
  NativeCircuitIrV6,
  CircuitProducerNodeV6,
} from '@comblang/compiler/entity-v6';
import type { LogicalArithmeticOperand, ResolvedCircuitNetworkNode } from '@comblang/compiler/ir';
import type { TrustedEntityReplayContext } from '@comblang/compiler/entity-replay-context';
import { entityReplayContextRef } from '@comblang/compiler/entity-replay-context';
import { cloneAndDeepFreeze } from '@comblang/compiler/immutable';
import {
  entityV6PhysicalDeciderConfiguration,
  snapshotResolvedEntityV6CircuitFromPlan,
  type ResolvedEntityV6Circuit,
} from '@comblang/compiler/resolved-entity-v6';
import { tryElaborateEntityDirectPlan, type ExecutedEntityDirectPlan } from './direct-plan.js';
import { DebugIndex } from './debug-index.js';
import { RuntimeDiagnosticError } from './elaboration.js';
import { validateEntityV6DirectPlan } from './entity-v6-validation.js';

export interface ElaboratedEntityCircuitV6 extends Omit<
  ExecutedEntityDirectPlan['circuit'],
  'graph' | 'ir'
> {
  readonly graph: ElaborationGraphV6;
  readonly ir: NativeCircuitIrV6;
}

export interface ExecutedEntityDirectPlanV6 extends Omit<
  ExecutedEntityDirectPlan,
  'circuit' | 'entity'
> {
  readonly circuit: ElaboratedEntityCircuitV6;
  entity(idOrOrdinal: EntityId | number): EntityPhysicalRecordV6;
}

export interface EntityV6DirectPlanExecutionResult {
  readonly execution?: ExecutedEntityDirectPlanV6;
  readonly resolvedCircuit?: ResolvedEntityV6Circuit;
  readonly diagnostics: readonly Diagnostic[];
}

function projectToV3(plan: DirectElaborationPlanV6): DirectElaborationPlan {
  return {
    format: 'comblang-direct-plan',
    version: 3,
    context: plan.context,
    networks: plan.networks,
    ...(plan.networkAliases === undefined ? {} : { networkAliases: plan.networkAliases }),
    ...(plan.networkTransfers === undefined ? {} : { networkTransfers: plan.networkTransfers }),
    ...(plan.networkPairs === undefined ? {} : { networkPairs: plan.networkPairs }),
    ...(plan.capabilityUses === undefined ? {} : { capabilityUses: plan.capabilityUses }),
    ...(plan.debugInstances === undefined ? {} : { debugInstances: plan.debugInstances }),
    producers: plan.producers.map((producer) => {
      if (producer.kind !== 'decider') {
        const { entityId: _entityId, ...withoutEntity } = producer;
        return withoutEntity;
      }
      const { entityId: _entityId, ...withoutEntity } = producer;
      const {
        outputOrigins: _outputOrigins,
        elseOutputOrigins: _elseOutputOrigins,
        ...withoutOrigins
      } = withoutEntity as Extract<typeof withoutEntity, { kind: 'decider' }>;
      return withoutOrigins;
    }),
    entities: plan.entities.map(({ configuration: _configuration, ...entity }) => entity),
    ...(plan.diagnostics === undefined ? {} : { diagnostics: plan.diagnostics }),
  } as unknown as DirectElaborationPlan;
}

function physicalEntities(
  plan: DirectElaborationPlanV6,
  projected: readonly EntityPhysicalRecord[],
  networks: readonly ResolvedCircuitNetworkNode[],
): readonly EntityPhysicalRecordV6[] {
  const networkIds = new Map(
    networks.flatMap((network) =>
      network.name === undefined ? [] : [[network.name, network.id] as const],
    ),
  );
  const physicalNetworkId = (name: string): NetworkId => {
    const id = networkIds.get(name);
    if (id === undefined) throw new Error(`Unknown physical Network: ${name}.`);
    return id;
  };
  const physicalOperand = (operand: PlanArithmeticOperand): LogicalArithmeticOperand => {
    if (operand.kind === 'constant') return operand;
    if (operand.refKind === 'single')
      return { ...operand, network: physicalNetworkId(operand.network) };
    return {
      ...operand,
      networks: [physicalNetworkId(operand.networks[0]), physicalNetworkId(operand.networks[1])],
    };
  };
  const configuration = (entity: EntityPlanRecordV6): EntityV6PhysicalConfiguration | undefined => {
    const value = entity.configuration;
    if (value === undefined) return undefined;
    if (value.mode === 'constant') return value;
    if (value.mode === 'arithmetic') {
      return {
        mode: 'arithmetic',
        left: physicalOperand(value.left),
        operation: value.operation,
        right: physicalOperand(value.right),
        output: value.output,
      };
    }
    if (value.mode === 'decider') return entityV6PhysicalDeciderConfiguration(value, networkIds);
    return undefined;
  };
  const configurations = new Map(
    plan.entities.map((entity) => [entity.id, configuration(entity)] as const),
  );
  return cloneAndDeepFreeze(
    projected.map((entity) => {
      const value = configurations.get(entity.id);
      return value === undefined ? entity : { ...entity, configuration: value };
    }),
  ) as readonly EntityPhysicalRecordV6[];
}

function producersV6(
  plan: DirectElaborationPlanV6,
  projected: readonly CircuitProducerNode[],
): readonly CircuitProducerNodeV6[] {
  return cloneAndDeepFreeze(
    projected.map((producer, index) => {
      const planned = plan.producers[index];
      if (planned === undefined) return producer as CircuitProducerNodeV6;
      return {
        ...producer,
        ...(planned.entityId === undefined ? {} : { entityId: planned.entityId }),
        ...(planned.kind === 'decider'
          ? {
              outputOrigins: planned.outputOrigins,
              ...(planned.elseOutputOrigins === undefined
                ? {}
                : { elseOutputOrigins: planned.elseOutputOrigins }),
            }
          : {}),
      } as unknown as CircuitProducerNodeV6;
    }),
  ) as unknown as readonly CircuitProducerNodeV6[];
}

export function tryElaborateEntityV6DirectPlan(
  input: unknown,
  context: TrustedEntityReplayContext,
): EntityV6DirectPlanExecutionResult {
  const validation = validateEntityV6DirectPlan(input, context);
  if (!validation.value) return { diagnostics: validation.diagnostics };
  const { plan } = validation.value;
  const projected = tryElaborateEntityDirectPlan(projectToV3(plan), context);
  if (!projected.execution) return { diagnostics: projected.diagnostics };
  const projectedExecution = projected.execution;
  try {
    const entities = physicalEntities(
      plan,
      projectedExecution.circuit.ir.entities,
      projectedExecution.circuit.ir.networks,
    );
    const producers = producersV6(plan, projectedExecution.circuit.ir.producers);
    const contextReference = entityReplayContextRef(context);
    const graph = cloneAndDeepFreeze({
      ...projectedExecution.circuit.graph,
      version: 6,
      context: contextReference,
      producers,
      entities,
    }) as ElaborationGraphV6;
    const ir = cloneAndDeepFreeze({
      ...projectedExecution.circuit.ir,
      version: 6,
      context: contextReference,
      producers,
      entities,
    }) as NativeCircuitIrV6;
    const physicalNetworkIds = new Map(
      projectedExecution.circuit.ir.networks.flatMap((network) =>
        network.name === undefined ? [] : [[network.name, network.id] as const],
      ),
    );
    const parents = new Map(plan.networks.map(({ name }) => [name, name] as const));
    const findRoot = (name: string): string => {
      const parent = parents.get(name);
      if (parent === undefined) throw new Error(`Unknown plan Network: ${name}.`);
      if (parent === name) return name;
      const root = findRoot(parent);
      parents.set(name, root);
      return root;
    };
    for (const transfer of plan.networkTransfers ?? []) {
      parents.set(findRoot(transfer.source), findRoot(transfer.destination));
    }
    const debug = DebugIndex.fromDirectPlan(
      plan,
      projectedExecution.circuit,
      (name) => {
        const id = physicalNetworkIds.get(findRoot(name));
        if (id === undefined) throw new Error(`Unknown physical Network: ${name}.`);
        return id;
      },
      (index) => projectedExecution.circuit.graph.producers[index]!.id,
      entities as unknown as readonly EntityPhysicalRecord[],
    );
    const circuit: ElaboratedEntityCircuitV6 = Object.freeze({
      ...projectedExecution.circuit,
      graph,
      ir,
      createSimulation: projectedExecution.circuit.createSimulation,
    });
    const resolvedCircuit = snapshotResolvedEntityV6CircuitFromPlan(plan, ir);
    return {
      diagnostics: [],
      resolvedCircuit,
      execution: Object.freeze({
        ...projectedExecution,
        circuit,
        debug,
        createTestSession: projectedExecution.createTestSession,
        entity(idOrOrdinal: EntityId | number) {
          const record = entities.find((candidate) =>
            typeof idOrOrdinal === 'number'
              ? candidate.ordinal === idOrOrdinal
              : candidate.id === idOrOrdinal,
          );
          if (record === undefined)
            throw new RuntimeDiagnosticError({
              code: 'RT3010',
              severity: 'error',
              message: `Unknown physical Entity: ${idOrOrdinal}.`,
            });
          return record;
        },
      }),
    };
  } catch (error) {
    return {
      diagnostics: [
        {
          code: 'RT1099',
          severity: 'error',
          message: error instanceof Error ? error.message : 'Entity v6 elaboration failed.',
        },
      ],
    };
  }
}

export function elaborateEntityV6DirectPlan(
  input: unknown,
  context: TrustedEntityReplayContext,
): ExecutedEntityDirectPlanV6 {
  const result = tryElaborateEntityV6DirectPlan(input, context);
  if (result.execution) return result.execution;
  throw new RuntimeDiagnosticError(
    result.diagnostics[0] ?? {
      code: 'RT1099',
      severity: 'error',
      message: 'Entity v6 elaboration failed.',
    },
  );
}

export const tryElaborateEntityV6Plan = tryElaborateEntityV6DirectPlan;
export const elaborateEntityV6Plan = elaborateEntityV6DirectPlan;

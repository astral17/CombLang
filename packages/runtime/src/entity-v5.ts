import type { Diagnostic } from '@comblang/shared';
import type {
  DirectElaborationPlan,
  PlanArithmeticOperand,
} from '@comblang/compiler/direct-plan-schema';
import type { EntityId, EntityPhysicalRecord } from '@comblang/compiler/entity';
import type {
  DirectElaborationPlanV5,
  EntityV5ArithmeticConfiguration,
  EntityV5ArithmeticPhysicalConfiguration,
  EntityPhysicalRecordV5,
  ElaborationGraphV5,
  NativeCircuitIrV5,
  CircuitProducerNodeV5,
} from '@comblang/compiler/entity-v5';
import type { LogicalArithmeticOperand, ResolvedCircuitNetworkNode } from '@comblang/compiler/ir';
import type { NetworkId } from '@comblang/shared';
import type { TrustedEntityReplayContext } from '@comblang/compiler/entity-replay-context';
import { entityReplayContextRef } from '@comblang/compiler/entity-replay-context';
import { cloneAndDeepFreeze } from '@comblang/compiler/immutable';
import {
  snapshotResolvedEntityV5CircuitFromPlan,
  type ResolvedEntityV5Circuit,
} from '@comblang/compiler/resolved-entity-v5';
import { tryElaborateEntityDirectPlan, type ExecutedEntityDirectPlan } from './direct-plan.js';
import { RuntimeDiagnosticError } from './elaboration.js';
import { validateEntityV5DirectPlan } from './entity-v5-validation.js';

export interface ElaboratedEntityCircuitV5 extends Omit<
  ExecutedEntityDirectPlan['circuit'],
  'graph' | 'ir'
> {
  readonly graph: ElaborationGraphV5;
  readonly ir: NativeCircuitIrV5;
}

export interface ExecutedEntityDirectPlanV5 extends Omit<
  ExecutedEntityDirectPlan,
  'circuit' | 'entity'
> {
  readonly circuit: ElaboratedEntityCircuitV5;
  entity(idOrOrdinal: EntityId | number): EntityPhysicalRecordV5;
}

export interface EntityV5DirectPlanExecutionResult {
  readonly execution?: ExecutedEntityDirectPlanV5;
  readonly resolvedCircuit?: ResolvedEntityV5Circuit;
  readonly diagnostics: readonly Diagnostic[];
}

function projectToV3(plan: DirectElaborationPlanV5): DirectElaborationPlan {
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
    producers: plan.producers.map(({ entityId: _entityId, ...producer }) => producer),
    entities: plan.entities.map(({ configuration: _configuration, ...entity }) => entity),
    ...(plan.diagnostics === undefined ? {} : { diagnostics: plan.diagnostics }),
  } as unknown as DirectElaborationPlan;
}

function physicalEntities(
  plan: DirectElaborationPlanV5,
  projected: readonly EntityPhysicalRecord[],
  networks: readonly ResolvedCircuitNetworkNode[],
): readonly EntityPhysicalRecordV5[] {
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
    if (operand.refKind === 'single') {
      return { ...operand, network: physicalNetworkId(operand.network) };
    }
    return {
      ...operand,
      networks: [physicalNetworkId(operand.networks[0]), physicalNetworkId(operand.networks[1])],
    };
  };
  const physicalConfiguration = (
    configuration: EntityV5ArithmeticConfiguration,
  ): EntityV5ArithmeticPhysicalConfiguration => ({
    mode: 'arithmetic',
    left: physicalOperand(configuration.left),
    operation: configuration.operation,
    right: physicalOperand(configuration.right),
    output: configuration.output,
  });
  const configurations = new Map(
    plan.entities.map(
      (entity) =>
        [
          entity.id,
          entity.configuration?.mode === 'arithmetic'
            ? physicalConfiguration(entity.configuration)
            : entity.configuration,
        ] as const,
    ),
  );
  return cloneAndDeepFreeze(
    projected.map((entity) => {
      const configuration = configurations.get(entity.id);
      return configuration === undefined ? entity : { ...entity, configuration };
    }),
  ) as readonly EntityPhysicalRecordV5[];
}

function producersV5(
  plan: DirectElaborationPlanV5,
  projected: readonly CircuitProducerNodeV5[],
): readonly CircuitProducerNodeV5[] {
  return cloneAndDeepFreeze(
    projected.map((producer, index) => {
      const entityId = plan.producers[index]?.entityId;
      return (
        entityId === undefined ? producer : { ...producer, entityId }
      ) as CircuitProducerNodeV5;
    }),
  );
}

export function tryElaborateEntityV5DirectPlan(
  input: unknown,
  context: TrustedEntityReplayContext,
): EntityV5DirectPlanExecutionResult {
  const validation = validateEntityV5DirectPlan(input, context);
  if (!validation.value) return { diagnostics: validation.diagnostics };
  const { plan } = validation.value;
  const projected = tryElaborateEntityDirectPlan(projectToV3(plan), context);
  if (!projected.execution) return { diagnostics: projected.diagnostics };
  try {
    const entities = physicalEntities(
      plan,
      projected.execution.circuit.ir.entities,
      projected.execution.circuit.ir.networks,
    );
    const producers = producersV5(plan, projected.execution.circuit.ir.producers);
    const contextReference = entityReplayContextRef(context);
    const graph = cloneAndDeepFreeze({
      ...projected.execution.circuit.graph,
      version: 5,
      context: contextReference,
      producers,
      entities,
    }) as ElaborationGraphV5;
    const ir = cloneAndDeepFreeze({
      ...projected.execution.circuit.ir,
      version: 5,
      context: contextReference,
      producers,
      entities,
    }) as NativeCircuitIrV5;
    const circuit: ElaboratedEntityCircuitV5 = Object.freeze({
      ...projected.execution.circuit,
      graph,
      ir,
      createSimulation: projected.execution.circuit.createSimulation,
    });
    const resolvedCircuit = snapshotResolvedEntityV5CircuitFromPlan(plan, ir);
    return {
      diagnostics: [],
      resolvedCircuit,
      execution: Object.freeze({
        ...projected.execution,
        circuit,
        createTestSession: projected.execution.createTestSession,
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
          message: error instanceof Error ? error.message : 'Entity v5 elaboration failed.',
        },
      ],
    };
  }
}

export function elaborateEntityV5DirectPlan(
  input: unknown,
  context: TrustedEntityReplayContext,
): ExecutedEntityDirectPlanV5 {
  const result = tryElaborateEntityV5DirectPlan(input, context);
  if (result.execution) return result.execution;
  throw new RuntimeDiagnosticError(
    result.diagnostics[0] ?? {
      code: 'RT1099',
      severity: 'error',
      message: 'Entity v5 elaboration failed.',
    },
  );
}

export const tryElaborateEntityV5Plan = tryElaborateEntityV5DirectPlan;
export const elaborateEntityV5Plan = elaborateEntityV5DirectPlan;

import type { Diagnostic } from '@comblang/shared';
import type { DirectElaborationPlan } from '@comblang/compiler/direct-plan-schema';
import type { EntityId, EntityPhysicalRecord } from '@comblang/compiler/entity';
import type {
  DirectElaborationPlanV4,
  EntityPhysicalRecordV4,
  ElaborationGraphV4,
  NativeCircuitIrV4,
  CircuitProducerNodeV4,
} from '@comblang/compiler/entity-v4';
import type { TrustedEntityReplayContext } from '@comblang/compiler/entity-replay-context';
import {
  snapshotResolvedEntityV4CircuitFromPlan,
  type ResolvedEntityV4Circuit,
} from '@comblang/compiler/resolved-entity-v4';
import { entityReplayContextRef } from '@comblang/compiler/entity-replay-context';
import { tryElaborateEntityDirectPlan, type ExecutedEntityDirectPlan } from './direct-plan.js';
import { RuntimeDiagnosticError } from './elaboration.js';
import { validateEntityV4DirectPlan } from './entity-v4-validation.js';

export interface ElaboratedEntityCircuitV4 extends Omit<
  ExecutedEntityDirectPlan['circuit'],
  'graph' | 'ir'
> {
  readonly graph: ElaborationGraphV4;
  readonly ir: NativeCircuitIrV4;
}

export interface ExecutedEntityDirectPlanV4 extends Omit<
  ExecutedEntityDirectPlan,
  'circuit' | 'entity'
> {
  readonly circuit: ElaboratedEntityCircuitV4;
  entity(idOrOrdinal: EntityId | number): EntityPhysicalRecordV4;
}

export interface EntityV4DirectPlanExecutionResult {
  readonly execution?: ExecutedEntityDirectPlanV4;
  readonly resolvedCircuit?: ResolvedEntityV4Circuit;
  readonly diagnostics: readonly Diagnostic[];
}

function projectToV3(plan: DirectElaborationPlanV4): DirectElaborationPlan {
  const producers = plan.producers.map(({ entityId: _entityId, ...producer }) => producer);
  const entities = plan.entities.map(({ configuration, ...entity }) =>
    configuration?.mode === 'constant'
      ? entity
      : configuration === undefined
        ? entity
        : { ...entity, configuration },
  );
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
    producers,
    entities,
    ...(plan.diagnostics === undefined ? {} : { diagnostics: plan.diagnostics }),
  } as unknown as DirectElaborationPlan;
}

function freeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value as Record<string, unknown>)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

function physicalEntities(
  plan: DirectElaborationPlanV4,
  projected: readonly EntityPhysicalRecord[],
): readonly EntityPhysicalRecordV4[] {
  const constantConfigurations = new Map(
    plan.entities
      .filter((entity) => entity.configuration?.mode === 'constant')
      .map((entity) => [entity.id, entity.configuration] as const),
  );
  return freeze(
    projected.map((entity) => {
      const configuration = constantConfigurations.get(entity.id);
      return freeze(
        structuredClone(configuration === undefined ? entity : { ...entity, configuration }),
      ) as EntityPhysicalRecordV4;
    }),
  );
}

function producersV4(
  plan: DirectElaborationPlanV4,
  projected: readonly CircuitProducerNodeV4[],
): readonly CircuitProducerNodeV4[] {
  return freeze(
    projected.map((producer, index) => {
      const entityId = plan.producers[index]?.entityId;
      return freeze(
        entityId === undefined ? producer : { ...producer, entityId },
      ) as CircuitProducerNodeV4;
    }),
  );
}

/** Executes the v4 envelope through the existing topology engine after strict v4 validation. */
export function tryElaborateEntityV4DirectPlan(
  input: unknown,
  context: TrustedEntityReplayContext,
): EntityV4DirectPlanExecutionResult {
  const validation = validateEntityV4DirectPlan(input, context);
  if (!validation.value) return { diagnostics: validation.diagnostics };
  const { plan } = validation.value;
  const projected = tryElaborateEntityDirectPlan(projectToV3(plan), context);
  if (!projected.execution) return { diagnostics: projected.diagnostics };

  try {
    const { execution } = projected;
    const entities = physicalEntities(plan, execution.circuit.ir.entities);
    const producers = producersV4(plan, execution.circuit.ir.producers);
    const contextReference = entityReplayContextRef(context);
    const graph: ElaborationGraphV4 = freeze({
      ...execution.circuit.graph,
      version: 4,
      context: contextReference,
      producers,
      entities,
    });
    const ir: NativeCircuitIrV4 = freeze({
      ...execution.circuit.ir,
      version: 4,
      context: contextReference,
      producers,
      entities,
    });
    const circuit: ElaboratedEntityCircuitV4 = Object.freeze({
      ...execution.circuit,
      graph,
      ir,
      // The v4 constant view is already represented by the linked producer.
      // Reusing the v3 simulator keeps this first slice at one physical device.
      createSimulation: execution.circuit.createSimulation,
    });
    const resolvedCircuit = snapshotResolvedEntityV4CircuitFromPlan(plan, ir);
    return {
      diagnostics: [],
      resolvedCircuit,
      execution: Object.freeze({
        ...execution,
        circuit,
        createTestSession: execution.createTestSession,
        entity(idOrOrdinal: EntityId | number) {
          const record = entities.find((candidate) =>
            typeof idOrOrdinal === 'number'
              ? candidate.ordinal === idOrOrdinal
              : candidate.id === idOrOrdinal,
          );
          if (record === undefined) {
            throw new RuntimeDiagnosticError({
              code: 'RT3010',
              severity: 'error',
              message: `Unknown physical Entity: ${idOrOrdinal}.`,
            });
          }
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
          message: error instanceof Error ? error.message : 'Entity v4 elaboration failed.',
        },
      ],
    };
  }
}

export function elaborateEntityV4DirectPlan(
  input: unknown,
  context: TrustedEntityReplayContext,
): ExecutedEntityDirectPlanV4 {
  const result = tryElaborateEntityV4DirectPlan(input, context);
  if (result.execution) return result.execution;
  throw new RuntimeDiagnosticError(
    result.diagnostics[0] ?? {
      code: 'RT1099',
      severity: 'error',
      message: 'Entity v4 elaboration failed.',
    },
  );
}

/** Short aliases for callers that name the envelope rather than the direct-plan transport. */
export const tryElaborateEntityV4Plan = tryElaborateEntityV4DirectPlan;
export const elaborateEntityV4Plan = elaborateEntityV4DirectPlan;

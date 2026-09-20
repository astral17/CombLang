import type { Diagnostic, NetworkId } from '@comblang/shared';
import type { DirectElaborationPlanV3 } from '@comblang/compiler/entity';
import type { EntityId, EntityPhysicalRecord } from '@comblang/compiler/entity';
import {
  snapshotResolvedEntityV7CircuitFromPlan,
  type ResolvedEntityV7Circuit,
} from '@comblang/compiler/resolved-entity-v7';
import type {
  DirectElaborationPlanV7,
  EntityPlanRecordV7,
  EntityPhysicalRecordV7,
  EntityV7PhysicalConfiguration,
  EntityV7SelectorConfiguration,
  ElaborationGraphV7,
  NativeCircuitIrV7,
  CircuitProducerNodeV7,
} from '@comblang/compiler/entity-v7';
import type {
  DirectPlanProducer,
  PlanArithmeticOperand,
} from '@comblang/compiler/direct-plan-schema';
import type {
  LogicalArithmeticOperand,
  LogicalNetworkRef,
  CircuitProducerNode,
  ResolvedCircuitNetworkNode,
} from '@comblang/compiler/ir';
import {
  entityReplayContextRef,
  resolveEntityReplayProfile,
  type TrustedEntityReplayContext,
} from '@comblang/compiler/entity-replay-context';
import { cloneAndDeepFreeze } from '@comblang/compiler/immutable';
import { validateEntityDirectPlan } from './entity-plan-validation.js';
import { validateEntityV4DirectPlan } from './entity-v4-validation.js';
import { validateEntityV5DirectPlan } from './entity-v5-validation.js';
import { validateEntityV6DirectPlan } from './entity-v6-validation.js';
import { tryElaborateEntityDirectPlan, type ExecutedEntityDirectPlan } from './direct-plan.js';
import { DebugIndex } from './debug-index.js';
import { RuntimeDiagnosticError } from './elaboration.js';
import { entityV6PhysicalDeciderConfiguration } from '@comblang/compiler/resolved-entity-v6';

export class EntityV7PlanValidationError extends Error {
  readonly code = 'RT7000';

  constructor(
    readonly path: string,
    readonly detail: string,
  ) {
    super(`${path}: ${detail}`);
    this.name = 'EntityV7PlanValidationError';
  }
}

export interface ValidatedEntityPlanV7 {
  readonly plan: DirectElaborationPlanV7;
  readonly context: TrustedEntityReplayContext;
}

export interface EntityV7PlanValidationResult {
  readonly value?: ValidatedEntityPlanV7;
  readonly diagnostics: readonly Diagnostic[];
}

function invalid(path: string, detail: string): never {
  throw new EntityV7PlanValidationError(path, detail);
}

type DataRecord = Record<string, unknown>;

function dataRecord(value: unknown, path: string): DataRecord {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    invalid(path, 'expected a plain data record.');
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null)
    invalid(path, 'expected a plain object or null-prototype record.');
  const output = Object.create(null) as DataRecord;
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string') invalid(`${path}[${String(key)}]`, 'symbol keys are not allowed.');
    const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
    if (!('value' in descriptor)) invalid(`${path}.${key}`, 'accessors are not allowed.');
    output[key] = descriptor.value;
  }
  return output;
}

function exactKeys(record: DataRecord, allowed: readonly string[], path: string): void {
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(record)) {
    if (!allowedSet.has(key)) invalid(`${path}.${key}`, 'unknown Entity v7 field.');
  }
}

function stableJson(value: unknown, seen = new WeakSet<object>()): string {
  if (value === null || value === undefined) return 'null';
  if (typeof value !== 'object') return JSON.stringify(value);
  if (seen.has(value)) throw new TypeError('cyclic Entity v7 plan data.');
  seen.add(value);
  try {
    if (Array.isArray(value)) return `[${value.map((entry) => stableJson(entry, seen)).join(',')}]`;
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(record[key], seen)}`)
      .join(',')}}`;
  } finally {
    seen.delete(value);
  }
}

function withoutEntityAuthority(plan: DirectElaborationPlanV7): DirectElaborationPlanV3 {
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
      const { entityId: _entityId, ...withoutEntityId } = producer;
      return withoutEntityId;
    }) as DirectPlanProducer[],
    entities: plan.entities.map(({ configuration: _configuration, ...entity }) => entity),
    ...(plan.diagnostics === undefined ? {} : { diagnostics: plan.diagnostics }),
  };
}

function inheritedVersion(plan: DirectElaborationPlanV7): 3 | 4 | 5 | 6 {
  let version: 3 | 4 | 5 | 6 = 3;
  for (const producer of plan.producers) {
    if (producer.entityId === undefined) continue;
    if (producer.kind === 'decider') version = 6;
    else if (producer.kind === 'arithmetic' && version < 5) version = 5;
    else if (producer.kind === 'constant' && version < 4) version = 4;
  }
  for (const entity of plan.entities) {
    const mode = entity.configuration?.mode;
    if (mode === 'decider') version = 6;
    else if (mode === 'arithmetic' && version < 5) version = 5;
    else if (mode === 'constant' && version < 4) version = 4;
  }
  return version;
}

function inheritedProjection(
  plan: DirectElaborationPlanV7,
  version: 3 | 4 | 5 | 6,
): Omit<DirectElaborationPlanV7, 'version'> & { readonly version: 3 | 4 | 5 | 6 } {
  return {
    ...plan,
    version,
    producers: plan.producers.map((producer) => {
      if (producer.kind !== 'selector') return producer;
      const { entityId: _entityId, ...withoutSelectorAssociation } = producer;
      return withoutSelectorAssociation;
    }),
    entities: plan.entities.map((entity) => {
      if (entity.configuration?.mode !== 'selector') return entity;
      const { configuration: _configuration, ...withoutSelectorConfiguration } = entity;
      return withoutSelectorConfiguration;
    }),
  };
}

function validateInheritedPlan(
  plan: DirectElaborationPlanV7,
  context: TrustedEntityReplayContext,
): DirectElaborationPlanV7 {
  const version = inheritedVersion(plan);
  const projected = inheritedProjection(plan, version);
  const result =
    version === 6
      ? validateEntityV6DirectPlan(projected, context)
      : version === 5
        ? validateEntityV5DirectPlan(projected, context)
        : version === 4
          ? validateEntityV4DirectPlan(projected, context)
          : validateEntityDirectPlan({ ...projected, version: 3 }, context);
  if (result.value === undefined) {
    const diagnostic = result.diagnostics[0];
    invalid('$', diagnostic?.message ?? `invalid inherited Entity v${version} plan.`);
  }
  return result.value.plan as unknown as DirectElaborationPlanV7;
}

function networkRef(
  value:
    | { readonly refKind: 'single'; readonly network: string }
    | {
        readonly refKind: 'pair';
        readonly networks: readonly [string, string];
      },
  ids: ReadonlyMap<string, NetworkId>,
): LogicalNetworkRef {
  const physicalNetworkId = (name: string): NetworkId => {
    const id = ids.get(name);
    if (id === undefined) throw new Error(`Unknown physical Network: ${name}.`);
    return id;
  };
  return value.refKind === 'single'
    ? { refKind: 'single', network: physicalNetworkId(value.network) }
    : {
        refKind: 'pair',
        networks: [physicalNetworkId(value.networks[0]), physicalNetworkId(value.networks[1])],
      };
}

function physicalArithmeticOperand(
  operand: PlanArithmeticOperand,
  ids: ReadonlyMap<string, NetworkId>,
): LogicalArithmeticOperand {
  if (operand.kind === 'constant') return operand;
  const reference = networkRef(operand, ids);
  if (operand.refKind === 'single' && reference.refKind === 'single')
    return { ...operand, network: reference.network };
  if (operand.refKind === 'pair' && reference.refKind === 'pair')
    return { ...operand, networks: reference.networks };
  throw new Error('Mismatched logical Network reference.');
}

function physicalConfiguration(
  entity: EntityPlanRecordV7,
  ids: ReadonlyMap<string, NetworkId>,
): EntityV7PhysicalConfiguration | undefined {
  const value = entity.configuration;
  if (value === undefined) return undefined;
  if (value.mode === 'constant') return value;
  if (value.mode === 'arithmetic')
    return {
      mode: 'arithmetic',
      left: physicalArithmeticOperand(value.left, ids),
      operation: value.operation,
      right: physicalArithmeticOperand(value.right, ids),
      output: value.output,
    };
  if (value.mode === 'decider') return entityV6PhysicalDeciderConfiguration(value, ids);
  if (value.mode === 'selector') return selectorPhysicalConfiguration(value, ids);
  return undefined;
}

function physicalEntities(
  plan: DirectElaborationPlanV7,
  projected: readonly EntityPhysicalRecordV7[],
  networks: readonly ResolvedCircuitNetworkNode[],
): readonly EntityPhysicalRecordV7[] {
  const ids = new Map<string, NetworkId>();
  for (const network of networks) {
    ids.set(network.id, network.id);
    if (network.name !== undefined) ids.set(network.name, network.id);
  }
  const configurations = new Map(
    plan.entities.map((entity) => [entity.id, physicalConfiguration(entity, ids)] as const),
  );
  return cloneAndDeepFreeze(
    projected.map((entity) => {
      const configuration = configurations.get(entity.id);
      return configuration === undefined ? entity : { ...entity, configuration };
    }),
  ) as readonly EntityPhysicalRecordV7[];
}

function producersV7(
  plan: DirectElaborationPlanV7,
  projected: readonly CircuitProducerNode[],
): readonly CircuitProducerNodeV7[] {
  return cloneAndDeepFreeze(
    projected.map((producer, index) => {
      const planned = plan.producers[index];
      if (planned === undefined) return producer as CircuitProducerNodeV7;
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
      } as unknown as CircuitProducerNodeV7;
    }),
  ) as unknown as readonly CircuitProducerNodeV7[];
}

function selectorPhysicalConfiguration(
  value: EntityV7SelectorConfiguration,
  ids: ReadonlyMap<string, NetworkId>,
): EntityV7PhysicalConfiguration {
  return value.operation === 'select'
    ? {
        mode: 'selector',
        operation: 'select',
        input: networkRef(value.input, ids),
        selectMax: value.selectMax,
        index: value.index,
      }
    : {
        mode: 'selector',
        operation: 'count',
        input: networkRef(value.input, ids),
        output: value.output,
      };
}

function validateValue(input: unknown, context: TrustedEntityReplayContext): ValidatedEntityPlanV7 {
  const record = dataRecord(input, '$');
  exactKeys(
    record,
    [
      'format',
      'version',
      'context',
      'networks',
      'networkAliases',
      'networkTransfers',
      'networkPairs',
      'capabilityUses',
      'debugInstances',
      'producers',
      'entities',
      'diagnostics',
    ],
    '$',
  );
  const plan = record as unknown as DirectElaborationPlanV7;
  if (plan.format !== 'comblang-direct-plan' || plan.version !== 7)
    invalid('$', 'Entity v7 plans require version 7.');
  if (!Array.isArray(plan.producers) || !Array.isArray(plan.entities))
    invalid('$', 'Entity v7 producers and entities must be arrays.');

  const entities = new Map<EntityId, EntityPlanRecordV7>();
  for (const [index, entity] of plan.entities.entries()) {
    if (entity === null || typeof entity !== 'object' || typeof entity.id !== 'string')
      invalid(`$.entities[${index}]`, 'Entity records require a string id.');
    if (entities.has(entity.id as EntityId))
      invalid(`$.entities[${index}].id`, 'Entity IDs must be unique.');
    entities.set(entity.id as EntityId, entity);
  }
  const linked = new Map<EntityId, number>();
  for (const [index, producer] of plan.producers.entries()) {
    if (producer === null || typeof producer !== 'object')
      invalid(`$.producers[${index}]`, 'Producer must be a record.');
    if (producer.entityId !== undefined) {
      if (linked.has(producer.entityId))
        invalid(`$.producers[${index}].entityId`, 'an Entity may have only one linked producer.');
      if (!entities.has(producer.entityId))
        invalid(`$.producers[${index}].entityId`, 'linked Entity does not exist.');
      if (producer.placement !== undefined)
        invalid(`$.producers[${index}].placement`, 'a linked producer must omit placement.');
      linked.set(producer.entityId, index);
    }
  }
  const selectorLinks = [...linked.entries()].filter(
    ([, index]) => plan.producers[index]?.kind === 'selector',
  );
  if (selectorLinks.length === 0)
    invalid('$.producers', 'Entity v7 requires at least one linked Selector producer.');

  const inherited = validateInheritedPlan(plan, context);
  const inheritedProducers = inherited.producers as readonly DirectPlanProducer[];
  const canonicalProducers = inheritedProducers.map((producer, index) => {
    const raw = plan.producers[index];
    if (raw?.kind !== 'selector' || raw.entityId === undefined) return producer;
    return { ...producer, entityId: raw.entityId };
  }) as readonly DirectPlanProducer[];

  for (const [entityId, producerIndex] of selectorLinks) {
    const entity = entities.get(entityId)!;
    const producer = canonicalProducers[producerIndex];
    if (producer?.kind !== 'selector')
      invalid(`$.producers[${producerIndex}]`, 'linked Entity family does not match.');
    const profile = resolveEntityReplayProfile(entity.profile, context);
    if (
      profile.ref.prototypeKey !== 'entity:selector-combinator' ||
      profile.prototypeType !== 'selector-combinator'
    )
      invalid(
        `$.entities[${entityId}].profile`,
        'linked Entity profile must identify the exact selector-combinator family.',
      );
    if (entity.configuration?.mode !== 'selector')
      invalid(
        `$.entities[${entityId}].configuration`,
        'linked Selector Entity must declare selector configuration.',
      );
    const expected =
      producer.operation === 'select'
        ? {
            mode: 'selector' as const,
            operation: 'select' as const,
            input: producer.input,
            selectMax: producer.selectMax,
            index: producer.index,
          }
        : {
            mode: 'selector' as const,
            operation: 'count' as const,
            input: producer.input,
            output: producer.output,
          };
    if (stableJson(entity.configuration) !== stableJson(expected))
      invalid(
        `$.entities[${entityId}].configuration`,
        'Selector producer configuration must equal the linked Entity configuration.',
      );
  }
  const canonicalEntities = inherited.entities.map((entity, index) => {
    const raw = plan.entities[index];
    if (raw?.configuration?.mode !== 'selector') return entity;
    const producerIndex = linked.get(raw.id);
    const producer = producerIndex === undefined ? undefined : canonicalProducers[producerIndex];
    if (producer?.kind !== 'selector') return { ...entity, configuration: raw.configuration };
    return {
      ...entity,
      configuration:
        producer.operation === 'select'
          ? {
              mode: 'selector' as const,
              operation: 'select' as const,
              input: producer.input,
              selectMax: producer.selectMax,
              index: producer.index,
            }
          : {
              mode: 'selector' as const,
              operation: 'count' as const,
              input: producer.input,
              output: producer.output,
            },
    };
  });
  const canonicalPlan = {
    ...inherited,
    version: 7 as const,
    context: entityReplayContextRef(context),
    producers: canonicalProducers,
    entities: canonicalEntities,
  } as DirectElaborationPlanV7;
  return { plan: cloneAndDeepFreeze(canonicalPlan), context };
}

export function validateEntityV7DirectPlan(
  input: unknown,
  context: TrustedEntityReplayContext,
): EntityV7PlanValidationResult {
  try {
    return { value: validateValue(input, context), diagnostics: [] };
  } catch (error) {
    if (error instanceof EntityV7PlanValidationError)
      return {
        diagnostics: [{ code: error.code, severity: 'error', message: error.message }],
      };
    return {
      diagnostics: [
        {
          code: 'RT7099',
          severity: 'error',
          message: error instanceof Error ? error.message : 'Entity v7 validation failed.',
        },
      ],
    };
  }
}

export interface ElaboratedEntityCircuitV7 extends Omit<
  ExecutedEntityDirectPlan['circuit'],
  'graph' | 'ir'
> {
  readonly graph: ElaborationGraphV7;
  readonly ir: NativeCircuitIrV7;
}

export interface ExecutedEntityDirectPlanV7 extends Omit<
  ExecutedEntityDirectPlan,
  'circuit' | 'entity'
> {
  readonly circuit: ElaboratedEntityCircuitV7;
  entity(idOrOrdinal: EntityId | number): EntityPhysicalRecordV7;
}

export interface EntityV7DirectPlanExecutionResult {
  readonly execution?: ExecutedEntityDirectPlanV7;
  readonly resolvedCircuit?: ResolvedEntityV7Circuit;
  readonly diagnostics: readonly Diagnostic[];
}

export function tryElaborateEntityV7DirectPlan(
  input: unknown,
  context: TrustedEntityReplayContext,
): EntityV7DirectPlanExecutionResult {
  const validation = validateEntityV7DirectPlan(input, context);
  if (validation.value === undefined) return { diagnostics: validation.diagnostics };
  const plan = validation.value.plan;
  const projected = tryElaborateEntityDirectPlan(withoutEntityAuthority(plan), context);
  if (projected.execution === undefined) return { diagnostics: projected.diagnostics };
  try {
    const execution = projected.execution;
    const entities = physicalEntities(
      plan,
      execution.circuit.ir.entities as readonly EntityPhysicalRecordV7[],
      execution.circuit.ir.networks,
    );
    const producers = producersV7(plan, execution.circuit.ir.producers);
    const contextReference = entityReplayContextRef(context);
    const graph = cloneAndDeepFreeze({
      ...execution.circuit.graph,
      version: 7,
      context: contextReference,
      producers,
      entities,
    }) as ElaborationGraphV7;
    const ir = cloneAndDeepFreeze({
      ...execution.circuit.ir,
      version: 7,
      context: contextReference,
      producers,
      entities,
    }) as NativeCircuitIrV7;
    const resolvedCircuit = snapshotResolvedEntityV7CircuitFromPlan(plan, ir);
    const physicalNetworkIds = new Map<string, NetworkId>();
    for (const network of execution.circuit.ir.networks) {
      physicalNetworkIds.set(network.id, network.id);
      if (network.name !== undefined) physicalNetworkIds.set(network.name, network.id);
    }
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
      { graph },
      (name) => {
        const id = physicalNetworkIds.get(findRoot(name));
        if (id === undefined) throw new Error(`Unknown physical Network: ${name}.`);
        return id;
      },
      (index) => graph.producers[index]!.id,
      entities as unknown as readonly EntityPhysicalRecord[],
    );
    const circuit = Object.freeze({ ...execution.circuit, graph, ir }) as ElaboratedEntityCircuitV7;
    return {
      diagnostics: [],
      resolvedCircuit,
      execution: Object.freeze({
        ...execution,
        circuit,
        debug,
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
          code: 'RT7199',
          severity: 'error',
          message: error instanceof Error ? error.message : 'Entity v7 elaboration failed.',
        },
      ],
    };
  }
}

export function elaborateEntityV7DirectPlan(
  input: unknown,
  context: TrustedEntityReplayContext,
): ExecutedEntityDirectPlanV7 {
  const result = tryElaborateEntityV7DirectPlan(input, context);
  if (result.execution !== undefined) return result.execution;
  throw new RuntimeDiagnosticError(result.diagnostics[0]!);
}

export const tryElaborateEntityV7Plan = tryElaborateEntityV7DirectPlan;
export const elaborateEntityV7Plan = elaborateEntityV7DirectPlan;

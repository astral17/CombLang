import type {
  DirectElaborationPlan,
  DirectPlanCapabilityUse,
  DirectPlanDebugValue,
  DirectPlanDecider,
  DirectPlanProducer,
  PlanArithmeticOperand,
  PlanDeciderCondition,
  PlanNetworkRef,
} from '@comblang/compiler/direct-plan-schema';
import type { Diagnostic, NetworkId, ProducerId, SourceSpan } from '@comblang/shared';
import type { TestObjectHandle, TestSession } from '@comblang/simulator';
import type {
  EntityId,
  EntityPlanRecord,
  EntityPlanDebugInstance,
  EntityPlanDebugValue,
  EntityPhysicalConfiguration,
  EntityDeciderPhysicalConfiguration,
  EntitySelectorConfiguration,
  EntityPhysicalRecord,
} from '@comblang/compiler/entity';
import type {
  ElaborationGraph,
  NativeCircuitIr,
  CircuitProducerNode,
  LogicalArithmeticOperand,
  LogicalDeciderCondition,
  LogicalDeciderOutput,
  LogicalNetworkRef,
} from '@comblang/compiler/ir';
import type { TrustedEntityReplayContext } from '@comblang/compiler/entity-replay-context';
import type { ResolvedCircuit } from '@comblang/compiler/resolved-circuit';
import { constantConfigurationFromOutputs } from '@comblang/factorio';
import { validateCanonicalEntityPlanData } from './entity-plan-validation.js';
import { lowerPreparedEntityRecords, prepareEntityRecords } from './entity-lowering.js';
import { entityObjectAdapter } from './entity-object-adapter.js';
import {
  canonicalCircuitGraph,
  canonicalNativeCircuitIr,
  canonicalResolvedCircuit,
} from './canonical-circuit.js';

import {
  DebugIndex,
  DebugQueryError,
  type DebugEntityEntry,
  type DebugNetworkEntry,
  type DebugScope,
} from './debug-index.js';
import { validateDirectPlanEnvelope } from './direct-plan-validation.js';
import { DebugStructureExpectation } from './debug-structure.js';
import {
  DslRuntime,
  RuntimeDiagnosticError,
  type ElaboratedCircuit,
  type NetworkHandle,
  type ProducerHandle,
  type RuntimeArithmeticOperand,
  type RuntimeConstantConfig,
  type RuntimeDeciderConfig,
  type RuntimeNetworkRef,
  type RuntimeSelectorConfig,
} from './elaboration.js';

export interface ExecutedDirectPlan {
  readonly circuit: ElaboratedCircuit;
  readonly capabilityUses: readonly DirectPlanCapabilityUse[];
  readonly debug: DebugIndex;
  readonly instances: readonly ExecutedDebugInstance[];
  createTestSession(): TestSession<DirectPlanTestTarget>;
  instance(name: string): ExecutedDebugInstance;
  instance(index: number): ExecutedDebugInstance;
  network(name: string): NetworkHandle;
  structure(scope?: DebugScope): DebugStructureExpectation;
}

export type DirectPlanTestTarget = NetworkHandle | DebugNetworkEntry;
export type ExecutedDebugValue =
  | NetworkHandle
  | ProducerHandle
  | DebugEntityEntry
  | string
  | number
  | boolean
  | null
  | undefined
  | readonly ExecutedDebugValue[]
  | { readonly [key: string]: ExecutedDebugValue };

export interface ExecutedDebugInstance {
  readonly name: string;
  readonly value: ExecutedDebugValue;
  readonly $: DebugScope;
  readonly source: SourceSpan;
}

export interface DirectPlanExecutionResult {
  readonly execution?: ExecutedDirectPlan;
  readonly diagnostics: readonly Diagnostic[];
}

function runtimeFailure(code: string, message: string, span?: SourceSpan): RuntimeDiagnosticError {
  return new RuntimeDiagnosticError({
    code,
    severity: 'error',
    message,
    ...(span === undefined ? {} : { span }),
  });
}

function executeDebugValue(
  value: DirectPlanDebugValue,
  networks: ReadonlyMap<string, NetworkHandle>,
  producers: ReadonlyMap<string, ProducerHandle>,
  source: SourceSpan,
): ExecutedDebugValue {
  if (value.kind === 'network') return requiredNetwork(value.network, networks, source);
  if (value.kind === 'producer') {
    const producer = producers.get(value.captureId);
    if (producer === undefined) {
      throw runtimeFailure('RT1001', 'Unknown captured Producer in direct plan.', source);
    }
    return producer;
  }
  if (value.kind === 'entity') {
    return undefined;
  }
  if (value.kind === 'literal') return value.value;
  if (value.kind === 'undefined') return undefined;
  if (value.kind === 'array') {
    return Object.freeze(
      value.values.map((item) => executeDebugValue(item, networks, producers, source)),
    );
  }
  return Object.freeze(
    Object.fromEntries(
      value.entries.map((entry) => [
        entry.key,
        executeDebugValue(entry.value, networks, producers, source),
      ]),
    ),
  );
}

function materializeEntityDebugValue(
  value: EntityPlanDebugValue,
  producerValue: ExecutedDebugValue,
  entities: ReadonlyMap<EntityId, DebugEntityEntry>,
): ExecutedDebugValue {
  if (value.kind === 'entity') {
    const entry = entities.get(value.entityId);
    if (entry === undefined) {
      throw runtimeFailure('RT3010', `Unknown physical Entity: ${value.entityId}.`);
    }
    return entry;
  }
  if (value.kind === 'array') {
    const fallback = Array.isArray(producerValue) ? producerValue : [];
    return Object.freeze(
      value.values.map((item, index) =>
        materializeEntityDebugValue(item, fallback[index] ?? undefined, entities),
      ),
    );
  }
  if (value.kind === 'object') {
    const fallback =
      producerValue !== null &&
      typeof producerValue === 'object' &&
      !Array.isArray(producerValue) &&
      !('kind' in producerValue)
        ? (producerValue as { readonly [key: string]: ExecutedDebugValue })
        : ({} as { readonly [key: string]: ExecutedDebugValue });
    return Object.freeze(
      Object.fromEntries(
        value.entries.map((entry) => [
          entry.key,
          materializeEntityDebugValue(entry.value, fallback[entry.key] ?? undefined, entities),
        ]),
      ),
    );
  }
  return producerValue;
}

export function materializeEntityDebugInstances(
  planned: readonly EntityPlanDebugInstance[] | undefined,
  producerInstances: readonly ExecutedDebugInstance[],
  entities: ReadonlyMap<EntityId, DebugEntityEntry>,
): readonly ExecutedDebugInstance[] {
  if (planned === undefined) return producerInstances;
  return Object.freeze(
    planned.map((instance, index) => {
      const producerInstance = producerInstances[index];
      if (producerInstance === undefined) {
        throw runtimeFailure('RT1099', 'Missing executed Entity debug instance mapping.');
      }
      return Object.freeze({
        ...producerInstance,
        value: materializeEntityDebugValue(instance.value, producerInstance.value, entities),
      });
    }),
  );
}

function lowerOperand(
  operand: PlanArithmeticOperand,
  networks: ReadonlyMap<string, NetworkHandle>,
  source: SourceSpan,
): RuntimeArithmeticOperand {
  if (operand.kind === 'constant') return operand;
  const reference = lowerNetworkRef(operand, networks, source);
  return operand.kind === 'each'
    ? { kind: 'each', ...reference }
    : { kind: 'signal', signal: operand.signal, ...reference };
}

function requiredNetwork(
  name: string,
  networks: ReadonlyMap<string, NetworkHandle>,
  source: SourceSpan,
  code: 'RT1003' | 'RT1004' = 'RT1003',
): NetworkHandle {
  const network = networks.get(name);
  if (network === undefined) {
    throw runtimeFailure(
      code,
      code === 'RT1004'
        ? `Unknown attachment Network: ${name}.`
        : `Direct plan references unknown Network: ${name}.`,
      source,
    );
  }
  return network;
}

function lowerNetworkRef(
  value: PlanNetworkRef,
  networks: ReadonlyMap<string, NetworkHandle>,
  source: SourceSpan,
): RuntimeNetworkRef {
  if (value.refKind === 'single') {
    return { refKind: 'single', network: requiredNetwork(value.network, networks, source) };
  }
  if (value.networks.length !== 2 || value.networks[0] === value.networks[1]) {
    throw runtimeFailure(
      'RT2020',
      'A pair input descriptor requires two distinct Networks.',
      source,
    );
  }
  const pair = value.networks.map((name) => requiredNetwork(name, networks, source)) as [
    NetworkHandle,
    NetworkHandle,
  ];
  if (pair[0] === pair[1]) {
    throw runtimeFailure(
      'RT2020',
      'A pair input descriptor resolves to one logical Network after transfer.',
      source,
    );
  }
  return { refKind: 'pair', networks: pair };
}

function lowerOutputInputs(
  value: PlanNetworkRef,
  networks: ReadonlyMap<string, NetworkHandle>,
  source: SourceSpan,
): { readonly input: RuntimeNetworkRef } {
  return { input: lowerNetworkRef(value, networks, source) };
}

function lowerCondition(
  condition: PlanDeciderCondition,
  networks: ReadonlyMap<string, NetworkHandle>,
  source: SourceSpan,
): RuntimeDeciderConfig['condition'] {
  if (condition.kind === 'and' || condition.kind === 'or') {
    return {
      kind: condition.kind,
      conditions: condition.conditions.map((child) => lowerCondition(child, networks, source)),
    };
  }
  if (condition.kind === 'compare-signals') {
    return {
      kind: 'compare',
      left: {
        kind: 'signal',
        signal: condition.left.signal,
        ...lowerNetworkRef(condition.left, networks, source),
      },
      comparator: condition.comparator,
      right: {
        kind: 'signal',
        signal: condition.right.signal,
        ...lowerNetworkRef(condition.right, networks, source),
      },
    };
  }
  if (condition.kind === 'compare-wildcard') {
    return {
      kind: 'compare',
      left: {
        kind: 'wildcard',
        value: condition.wildcard,
        ...lowerNetworkRef(condition, networks, source),
      },
      comparator: condition.comparator,
      right: { kind: 'constant', value: condition.constant },
    };
  }
  return condition.kind === 'compare-signal'
    ? {
        kind: 'compare',
        left: {
          kind: 'signal',
          signal: condition.signal,
          ...lowerNetworkRef(condition, networks, source),
        },
        comparator: condition.comparator,
        right: { kind: 'constant', value: condition.constant },
      }
    : {
        kind: 'compare',
        left: {
          kind: 'wildcard',
          value: 'each',
          ...lowerNetworkRef(condition, networks, source),
        },
        comparator: condition.comparator,
        right: { kind: 'constant', value: condition.constant },
      };
}

/** Executes compiler-owned descriptors only; it never evaluates source text. */
function executeDirectPlan(
  inputPlan: DirectElaborationPlan,
  resolvedNetworks?: (
    networks: ReadonlyMap<string, NetworkHandle>,
  ) => readonly EntityPhysicalRecord[] | void,
): ExecutedDirectPlan {
  const validation = validateDirectPlanEnvelope(inputPlan);
  if (validation.value === undefined) {
    throw new RuntimeDiagnosticError(validation.diagnostics[0]!);
  }
  const { plan, declarations, aliases, capabilityUses } = validation.value;
  const runtime = new DslRuntime();

  const parent = new Map(plan.networks.map(({ name }) => [name, name]));
  const consumed = new Map<string, SourceSpan>();
  const fixedDeclarations = new Map(
    plan.networks.map((declaration) => [
      declaration.name,
      declaration.fixedColor === undefined ? [] : [declaration],
    ]),
  );
  const find = (name: string): string => {
    const next = parent.get(name);
    if (next === undefined) throw runtimeFailure('RT2011', `Unknown Network in transfer: ${name}.`);
    if (next === name) return name;
    const root = find(next);
    parent.set(name, root);
    return root;
  };
  for (const transfer of plan.networkTransfers ?? []) {
    const destinationDeclaration = declarations.get(transfer.destination);
    const sourceDeclaration = declarations.get(transfer.source);
    if (destinationDeclaration === undefined || sourceDeclaration === undefined) {
      const missing = destinationDeclaration === undefined ? transfer.destination : transfer.source;
      throw runtimeFailure(
        'RT2011',
        `Unknown Network in transfer: ${missing}.`,
        transfer.provenance,
      );
    }
    const movedDestination = consumed.get(transfer.destination);
    const movedSource = consumed.get(transfer.source);
    const movedAt = movedDestination ?? movedSource;
    if (movedAt !== undefined) {
      throw new RuntimeDiagnosticError({
        code: 'RT2012',
        severity: 'error',
        message: `Cannot transfer moved Network: ${movedDestination === undefined ? transfer.source : transfer.destination}.`,
        span: transfer.provenance,
        related: [{ message: 'Network was moved here.', span: movedAt }],
      });
    }
    const destinationRoot = find(transfer.destination);
    const sourceRoot = find(transfer.source);
    if (destinationRoot === sourceRoot) {
      throw runtimeFailure(
        'RT2013',
        'A Network cannot take itself or an existing alias.',
        transfer.provenance,
      );
    }
    const coloredMembers = [
      ...(fixedDeclarations.get(destinationRoot) ?? []),
      ...(fixedDeclarations.get(sourceRoot) ?? []),
    ];
    const colors = new Set(coloredMembers.map(({ fixedColor }) => fixedColor));
    if (colors.size > 1) {
      const red = coloredMembers.find(({ fixedColor }) => fixedColor === 'red')!;
      const green = coloredMembers.find(({ fixedColor }) => fixedColor === 'green')!;
      throw new RuntimeDiagnosticError({
        code: 'RT2014',
        severity: 'error',
        message: 'Network transfer unifies contradictory fixed red and green requirements.',
        span: transfer.provenance,
        related: [
          { message: 'Red Network declared here.', span: red.source },
          { message: 'Green Network declared here.', span: green.source },
        ],
      });
    }
    parent.set(sourceRoot, destinationRoot);
    fixedDeclarations.set(destinationRoot, coloredMembers);
    fixedDeclarations.delete(sourceRoot);
    consumed.set(transfer.source, transfer.provenance);
  }

  const networks = new Map<string, NetworkHandle>();
  const handlesByRoot = new Map<string, NetworkHandle>();
  for (const declaration of plan.networks) {
    const root = find(declaration.name);
    if (handlesByRoot.has(root)) continue;
    const members = plan.networks.filter((candidate) => find(candidate.name) === root);
    const colors = new Set(members.flatMap(({ fixedColor }) => fixedColor ?? []));
    const survivor = declarations.get(root)!;
    handlesByRoot.set(
      root,
      runtime.network({
        name: survivor.name,
        ...(colors.size === 0 ? {} : { color: [...colors][0]! }),
        source: survivor.source,
        instancePath: survivor.instancePath,
      }),
    );
  }
  for (const declaration of plan.networks)
    networks.set(declaration.name, handlesByRoot.get(find(declaration.name))!);
  const rootAliases = new Set(
    aliases.filter((alias) => alias.instancePath.length === 0).map((alias) => alias.name),
  );
  for (const descriptor of plan.networkPairs ?? []) {
    if (!Array.isArray(descriptor.networks) || descriptor.networks.length !== 2) {
      throw runtimeFailure(
        'RT2020',
        'A pair descriptor requires exactly two Networks.',
        descriptor.provenance,
      );
    }
    runtime.pair(
      requiredNetwork(descriptor.networks[0], networks, descriptor.provenance),
      requiredNetwork(descriptor.networks[1], networks, descriptor.provenance),
      { source: descriptor.provenance, instancePath: descriptor.instancePath },
    );
  }
  const capturedProducers = new Map<string, ProducerHandle>();
  const producerIds: ProducerId[] = [];
  const lowerDeciderOutput = (
    output: Extract<DirectElaborationPlan['producers'][number], { kind: 'decider' }>['output'],
    networks: ReadonlyMap<string, NetworkHandle>,
    source: SourceSpan,
  ): RuntimeDeciderConfig['outputs'][number] =>
    output.kind === 'signal'
      ? {
          mode: 'copy',
          signal: { kind: 'signal', signal: output.signal },
          ...lowerOutputInputs(output, networks, source),
        }
      : output.kind === 'each-constant'
        ? {
            mode: 'constant',
            signal: { kind: 'wildcard', value: 'each' },
            value: output.value,
          }
        : output.kind === 'signal-constant'
          ? {
              mode: 'constant',
              signal: { kind: 'signal', signal: output.signal },
              value: output.value,
            }
          : output.kind === 'wildcard'
            ? {
                mode: 'copy',
                signal: { kind: 'wildcard', value: output.wildcard },
                ...lowerOutputInputs(output, networks, source),
              }
            : {
                mode: 'copy',
                signal: { kind: 'wildcard', value: 'each' },
                ...lowerOutputInputs(output, networks, source),
              };
  for (const descriptor of plan.producers) {
    if (
      descriptor.bindingName !== undefined &&
      (typeof descriptor.bindingName !== 'string' || descriptor.bindingName.length === 0)
    ) {
      throw runtimeFailure(
        'RT1001',
        'Invalid Producer binding name in direct plan.',
        descriptor.source,
      );
    }
    if (
      descriptor.debugCaptureIds !== undefined &&
      (!Array.isArray(descriptor.debugCaptureIds) ||
        descriptor.debugCaptureIds.some(
          (captureId) => typeof captureId !== 'string' || captureId.length === 0,
        ))
    ) {
      throw runtimeFailure(
        'RT1001',
        'Invalid Producer debug capture in direct plan.',
        descriptor.source,
      );
    }
    const provenance = {
      source: descriptor.source,
      instancePath: descriptor.instancePath,
      ...(descriptor.placement === undefined ? {} : { placement: descriptor.placement }),
    };
    const producer =
      descriptor.kind === 'arithmetic'
        ? runtime.arithmetic(
            {
              left: lowerOperand(descriptor.left, networks, descriptor.source),
              operation: descriptor.operation,
              right: lowerOperand(descriptor.right, networks, descriptor.source),
              output: descriptor.output,
            },
            provenance,
          )
        : descriptor.kind === 'constant'
          ? runtime.constant(
              { outputs: descriptor.outputs } satisfies RuntimeConstantConfig,
              provenance,
            )
          : descriptor.kind === 'decider'
            ? runtime.decider(
                {
                  condition: lowerCondition(descriptor.condition, networks, descriptor.source),
                  outputs: (descriptor.outputs ?? [descriptor.output]).map((output) =>
                    lowerDeciderOutput(output, networks, descriptor.source),
                  ),
                  ...(descriptor.elseOutputs === undefined
                    ? {}
                    : {
                        elseOutputs: descriptor.elseOutputs.map((output) =>
                          lowerDeciderOutput(output, networks, descriptor.source),
                        ),
                      }),
                } satisfies RuntimeDeciderConfig,
                provenance,
              )
            : runtime.selector(
                descriptor.operation === 'select'
                  ? {
                      operation: 'select',
                      input: lowerNetworkRef(descriptor.input, networks, descriptor.source),
                      selectMax: descriptor.selectMax,
                      index: descriptor.index,
                    }
                  : ({
                      operation: 'count',
                      input: lowerNetworkRef(descriptor.input, networks, descriptor.source),
                      output: descriptor.output,
                    } satisfies RuntimeSelectorConfig),
                provenance,
              );
    for (const captureId of descriptor.debugCaptureIds ?? []) {
      if (capturedProducers.has(captureId)) {
        throw runtimeFailure(
          'RT1001',
          'Duplicate Producer debug capture in direct plan.',
          descriptor.source,
        );
      }
      capturedProducers.set(captureId, producer);
    }
    producerIds.push(producer.id);
    runtime.attach(
      producer,
      ...descriptor.destinations.map((destination) => {
        const network = requiredNetwork(
          destination.network,
          networks,
          destination.source,
          'RT1004',
        );
        return {
          network,
          source: destination.source,
          instancePath: destination.instancePath,
        };
      }),
    );
  }
  const circuit = runtime.elaborate();
  const debugEntities = resolvedNetworks?.(networks);
  const debug = DebugIndex.fromDirectPlan(
    plan,
    circuit,
    (name) => networks.get(name)!.id,
    (index) => {
      const id = producerIds[index];
      if (id === undefined) throw runtimeFailure('RT1001', 'Missing executed Producer mapping.');
      return id;
    },
    debugEntities ?? [],
  );
  const instances = Object.freeze(
    (plan.debugInstances ?? []).map((instance) =>
      Object.freeze({
        name: instance.name,
        value: executeDebugValue(instance.value, networks, capturedProducers, instance.source),
        $: debug.scope(instance.path),
        source: instance.source,
      }),
    ),
  );
  const debugNetworks = new WeakSet<object>(
    debug.scopes.flatMap((scope) => scope.networks).map((entry) => entry as object),
  );
  return Object.freeze({
    circuit,
    capabilityUses,
    debug,
    instances,
    createTestSession() {
      return circuit.createTestSession<DirectPlanTestTarget>((target) => {
        if (typeof target !== 'object' || target === null || !('planName' in target)) return target;
        if (!debugNetworks.has(target)) {
          throw runtimeFailure('RT2001', 'Foreign or invalid debug Network target.');
        }
        if (target.moved) {
          throw runtimeFailure(
            'RT2012',
            `Cannot use moved debug Network: ${target.planName}.`,
            target.source,
          );
        }
        return networks.get(target.planName)!;
      });
    },
    instance(nameOrIndex: string | number) {
      if (typeof nameOrIndex === 'number') {
        if (!Number.isSafeInteger(nameOrIndex) || nameOrIndex < 1) {
          throw new RangeError('Debug instance index must be a positive safe integer.');
        }
        const instance = instances[nameOrIndex - 1];
        if (instance !== undefined) return instance;
        throw new DebugQueryError(
          'DBG1001',
          `No debug instance exists at index ${nameOrIndex}.`,
          instances.map(({ name }, index) => `${index + 1}: ${name}`),
        );
      }
      const matches = instances.filter(({ name }) => name === nameOrIndex);
      if (matches.length === 1) return matches[0]!;
      if (matches.length === 0) {
        throw new DebugQueryError(
          'DBG1001',
          `No debug instance is named ${JSON.stringify(nameOrIndex)}.`,
          instances.map(({ name }, index) => `${index + 1}: ${name}`),
        );
      }
      throw new DebugQueryError(
        'DBG1002',
        `Debug instance ${JSON.stringify(nameOrIndex)} is ambiguous.`,
        matches.map(({ $ }, index) => `${index + 1}: ${$.path.join(' / ')}`),
      );
    },
    structure(scope = debug.root) {
      return new DebugStructureExpectation(scope, circuit.graph);
    },
    network(name: string) {
      const alias = rootAliases.has(name) ? debug.root.network(name) : undefined;
      if (alias?.moved) {
        throw new RuntimeDiagnosticError({
          code: 'RT2012',
          severity: 'error',
          message: `Cannot use moved Network alias: ${name}.`,
          span: alias.source,
        });
      }
      const movedAt = alias === undefined ? consumed.get(name) : undefined;
      if (movedAt !== undefined) {
        throw new RuntimeDiagnosticError({
          code: 'RT2012',
          severity: 'error',
          message: `Cannot use moved Network: ${name}.`,
          span: movedAt,
          related: [{ message: 'Network declared here.', span: declarations.get(name)!.source }],
        });
      }
      const network = alias === undefined ? networks.get(name) : networks.get(alias.planName);
      if (network === undefined) throw runtimeFailure('RT1005', `Unknown Network: ${name}.`);
      return network;
    },
  });
}

function tryExecuteProducerPlan(plan: DirectElaborationPlan): DirectPlanExecutionResult {
  try {
    const execution = executeDirectPlan(plan);
    return {
      execution: Object.freeze({
        ...execution,
        circuit: Object.freeze({
          ...execution.circuit,
          graph: canonicalCircuitGraph(execution.circuit.graph) as ElaboratedCircuit['graph'],
          ir: canonicalNativeCircuitIr(execution.circuit.ir) as ElaboratedCircuit['ir'],
        }),
      }),
      diagnostics: [],
    };
  } catch (error) {
    const diagnostic: Diagnostic =
      error instanceof RuntimeDiagnosticError
        ? error.diagnostic
        : {
            code: 'RT1099',
            severity: 'error',
            message: error instanceof Error ? error.message : 'Direct plan elaboration failed.',
          };
    return { diagnostics: [diagnostic] };
  }
}

function physicalNetworkRef(
  value:
    | { readonly refKind: 'single'; readonly network: string }
    | { readonly refKind: 'pair'; readonly networks: readonly [string, string] },
  ids: ReadonlyMap<string, NetworkId>,
): LogicalNetworkRef {
  const id = (name: string): NetworkId => {
    const value = ids.get(name);
    if (value === undefined) throw new Error(`Unknown physical Network: ${name}.`);
    return value;
  };
  return value.refKind === 'single'
    ? { refKind: 'single', network: id(value.network) }
    : {
        refKind: 'pair',
        networks: [id(value.networks[0]), id(value.networks[1])],
      };
}

function physicalArithmeticOperand(
  operand: PlanArithmeticOperand,
  ids: ReadonlyMap<string, NetworkId>,
): LogicalArithmeticOperand {
  if (operand.kind === 'constant') return operand;
  const reference = physicalNetworkRef(operand, ids);
  if (operand.refKind === 'single' && reference.refKind === 'single')
    return { ...operand, network: reference.network };
  if (operand.refKind === 'pair' && reference.refKind === 'pair')
    return { ...operand, networks: reference.networks };
  throw new Error('Mismatched logical Network reference.');
}

function physicalDeciderConfiguration(
  producer: Extract<DirectPlanProducer, { readonly kind: 'decider' }>,
  ids: ReadonlyMap<string, NetworkId>,
): EntityDeciderPhysicalConfiguration {
  const condition = (value: PlanDeciderCondition): LogicalDeciderCondition => {
    if (value.kind === 'and' || value.kind === 'or')
      return { kind: value.kind, conditions: value.conditions.map(condition) };
    if (value.kind === 'compare-signals')
      return {
        kind: 'compare',
        left: { kind: 'signal', signal: value.left.signal, ...physicalNetworkRef(value.left, ids) },
        comparator: value.comparator,
        right: {
          kind: 'signal',
          signal: value.right.signal,
          ...physicalNetworkRef(value.right, ids),
        },
      };
    return {
      kind: 'compare',
      left:
        value.kind === 'compare-each'
          ? { kind: 'wildcard', value: 'each', ...physicalNetworkRef(value, ids) }
          : value.kind === 'compare-signal'
            ? { kind: 'signal', signal: value.signal, ...physicalNetworkRef(value, ids) }
            : {
                kind: 'wildcard',
                value: value.wildcard,
                ...physicalNetworkRef(value, ids),
              },
      comparator: value.comparator,
      right: { kind: 'constant', value: value.constant },
    };
  };
  const output = (value: DirectPlanDecider['output']): LogicalDeciderOutput => {
    if (value.kind === 'each-constant')
      return { mode: 'constant', signal: { kind: 'wildcard', value: 'each' }, value: value.value };
    if (value.kind === 'signal-constant')
      return {
        mode: 'constant',
        signal: { kind: 'signal', signal: value.signal },
        value: value.value,
      };
    if (value.kind === 'each')
      return {
        mode: 'copy',
        signal: { kind: 'wildcard', value: 'each' },
        input: physicalNetworkRef(value, ids),
      };
    if (value.kind === 'signal')
      return {
        mode: 'copy',
        signal: { kind: 'signal', signal: value.signal },
        input: physicalNetworkRef(value, ids),
      };
    return {
      mode: 'copy',
      signal: { kind: 'wildcard', value: value.wildcard },
      input: physicalNetworkRef(value, ids),
    };
  };
  return {
    mode: 'decider',
    condition: condition(producer.condition),
    outputs: (producer.outputs ?? [producer.output]).map(output),
    ...(producer.elseOutputs === undefined
      ? {}
      : { elseOutputs: producer.elseOutputs.map(output) }),
  };
}

/** Lowers an already equality-validated linked Producer into physical Network IDs. */
function physicalConfigurationForLinkedProducer(
  producer: DirectPlanProducer,
  ids: ReadonlyMap<string, NetworkId>,
): EntityPhysicalConfiguration {
  if (producer.kind === 'constant') {
    return {
      mode: 'constant',
      value: producer.configuration ?? constantConfigurationFromOutputs(producer.outputs),
    };
  }
  if (producer.kind === 'arithmetic') {
    return {
      mode: 'arithmetic',
      left: physicalArithmeticOperand(producer.left, ids),
      operation: producer.operation,
      right: physicalArithmeticOperand(producer.right, ids),
      output: producer.output,
    };
  }
  if (producer.kind === 'decider') return physicalDeciderConfiguration(producer, ids);
  return producer.operation === 'select'
    ? {
        mode: 'selector',
        operation: 'select',
        input: physicalNetworkRef(producer.input, ids),
        selectMax: producer.selectMax,
        index: producer.index,
      }
    : {
        mode: 'selector',
        operation: 'count',
        input: physicalNetworkRef(producer.input, ids),
        output: producer.output,
      };
}

export interface ElaboratedEntityCircuit extends Omit<ElaboratedCircuit, 'graph' | 'ir'> {
  readonly graph: ElaborationGraph;
  readonly ir: NativeCircuitIr;
}

export interface ExecutedEntityDirectPlan extends Omit<ExecutedDirectPlan, 'circuit'> {
  readonly circuit: ElaboratedEntityCircuit;
  entity(idOrOrdinal: EntityId | number): EntityPhysicalRecord;
  entityObject(
    session: TestSession<DirectPlanTestTarget>,
    idOrOrdinal: EntityId | number,
  ): TestObjectHandle;
}

export interface EntityDirectPlanExecutionResult {
  readonly execution?: ExecutedEntityDirectPlan;
  readonly diagnostics: readonly Diagnostic[];
}

/** Executes a validated canonical Entity plan before returning physical data. */
function executeEntityPlan(
  plan: DirectElaborationPlan,
  context: TrustedEntityReplayContext,
): EntityDirectPlanExecutionResult {
  try {
    const {
      entities: planEntities,
      debugInstances: planDebugInstances,
      networks,
      ...common
    } = plan;
    const preparationEntities = planEntities.map((entity) => {
      const mode = entity.configuration?.mode;
      if (
        mode === 'constant' ||
        mode === 'arithmetic' ||
        mode === 'decider' ||
        mode === 'selector'
      ) {
        const { configuration: _configuration, ...withoutPlanConfiguration } = entity;
        return withoutPlanConfiguration;
      }
      return entity;
    });
    const preparedEntities = prepareEntityRecords(preparationEntities, context);
    if (plan.context === undefined) {
      throw runtimeFailure('RT1001', 'Entity execution requires canonical replay context.');
    }
    const contextReference = plan.context;
    let physicalEntities: readonly EntityPhysicalRecord[] = [];
    const execution = executeDirectPlan(
      {
        ...common,
        entities: [],
        ...(planDebugInstances === undefined ? {} : { debugInstances: planDebugInstances }),
        networks,
      },
      (resolved) => {
        const ids = new Map<string, NetworkId>();
        for (const [name, network] of resolved) {
          ids.set(name, network.id);
          ids.set(network.id, network.id);
        }
        const producers = new Map(
          plan.producers
            .filter((producer) => producer.entityId !== undefined)
            .map((producer) => [producer.entityId!, producer] as const),
        );
        physicalEntities = lowerPreparedEntityRecords(preparedEntities, resolved).map((entity) => {
          const planned = planEntities.find((candidate) => candidate.id === entity.id);
          const producer = producers.get(entity.id);
          if (
            planned?.configuration !== undefined &&
            planned.configuration.mode !== 'raw' &&
            planned.configuration.mode !== 'typed' &&
            producer !== undefined
          ) {
            return Object.freeze({
              ...entity,
              configuration: physicalConfigurationForLinkedProducer(producer, ids),
            });
          }
          return entity;
        });
        return physicalEntities;
      },
    );
    const circuit: ElaboratedEntityCircuit = Object.freeze({
      ...execution.circuit,
      graph: Object.freeze({
        ...execution.circuit.graph,
        context: contextReference,
        producers: preserveEntityProducerMetadata(plan, execution.circuit.graph.producers),
        entities: physicalEntities,
      }),
      ir: Object.freeze({
        ...execution.circuit.ir,
        context: contextReference,
        producers: preserveEntityProducerMetadata(plan, execution.circuit.ir.producers),
        entities: physicalEntities,
      }),
    });
    const entityDebugEntries = new Map<EntityId, DebugEntityEntry>(
      execution.debug.scopes
        .flatMap(({ entities }) => entities)
        .map((entry) => [entry.entityId, entry]),
    );
    const debugInstances = materializeEntityDebugInstances(
      planDebugInstances,
      execution.instances,
      entityDebugEntries,
    );
    const sessionObjects = new WeakMap<
      TestSession<DirectPlanTestTarget>,
      ReadonlyMap<EntityId | number, TestObjectHandle>
    >();
    const createTestSession = (): TestSession<DirectPlanTestTarget> => {
      const session = execution.createTestSession();
      const handles = new Map<EntityId | number, TestObjectHandle>();
      for (const record of physicalEntities) {
        const handle = session.adaptObject(entityObjectAdapter, record);
        handles.set(record.id, handle);
        handles.set(record.ordinal, handle);
      }
      sessionObjects.set(session, handles);
      return session;
    };
    return {
      diagnostics: [],
      execution: Object.freeze({
        ...execution,
        circuit,
        instances: debugInstances,
        createTestSession,
        instance(nameOrIndex: string | number) {
          if (typeof nameOrIndex === 'number') {
            if (!Number.isSafeInteger(nameOrIndex) || nameOrIndex < 1) {
              throw new RangeError('Debug instance index must be a positive safe integer.');
            }
            const instance = debugInstances[nameOrIndex - 1];
            if (instance !== undefined) return instance;
            throw new DebugQueryError(
              'DBG1001',
              `No debug instance exists at index ${nameOrIndex}.`,
              debugInstances.map(({ name }, index) => `${index + 1}: ${name}`),
            );
          }

          const matches = debugInstances.filter(({ name }) => name === nameOrIndex);
          if (matches.length === 1) return matches[0]!;
          if (matches.length === 0) {
            throw new DebugQueryError(
              'DBG1001',
              `No debug instance is named ${JSON.stringify(nameOrIndex)}.`,
              debugInstances.map(({ name }, index) => `${index + 1}: ${name}`),
            );
          }
          throw new DebugQueryError(
            'DBG1002',
            `Debug instance ${JSON.stringify(nameOrIndex)} is ambiguous.`,
            matches.map(({ $ }) => $.path.join(' / ')),
          );
        },
        entity(idOrOrdinal: EntityId | number) {
          const record = physicalEntities.find((entity) =>
            typeof idOrOrdinal === 'number'
              ? entity.ordinal === idOrOrdinal
              : entity.id === idOrOrdinal,
          );
          if (!record) throw runtimeFailure('RT3010', `Unknown physical Entity: ${idOrOrdinal}.`);
          return record;
        },
        entityObject(session: TestSession<DirectPlanTestTarget>, idOrOrdinal: EntityId | number) {
          const handles = sessionObjects.get(session);
          if (handles === undefined) {
            throw runtimeFailure(
              'RT3010',
              'Entity object lookup requires a TestSession created by this execution.',
            );
          }
          const handle = handles.get(idOrOrdinal);
          if (handle === undefined) {
            throw runtimeFailure('RT3010', `Unknown physical Entity: ${idOrOrdinal}.`);
          }
          return handle;
        },
      }),
    };
  } catch (error) {
    return {
      diagnostics: [
        error instanceof RuntimeDiagnosticError
          ? error.diagnostic
          : {
              code: 'RT1099',
              severity: 'error',
              message: error instanceof Error ? error.message : 'Entity elaboration failed.',
            },
      ],
    };
  }
}

function preserveEntityProducerMetadata(
  plan: DirectElaborationPlan,
  producers: readonly CircuitProducerNode[],
): readonly CircuitProducerNode[] {
  return producers.map((producer, index) => {
    const planned = plan.producers[index];
    if (planned === undefined) return producer;
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
      ...(planned.kind === 'constant' &&
      planned.configuration !== undefined &&
      producer.kind === 'constant'
        ? { config: { ...producer.config, configuration: planned.configuration } }
        : {}),
    } as CircuitProducerNode;
  });
}

export interface CanonicalDirectPlanExecutionResult extends DirectPlanExecutionResult {
  readonly resolvedCircuit?: ResolvedCircuit;
}

export interface CanonicalDirectPlanValidationResult {
  readonly value?: DirectElaborationPlan;
  readonly diagnostics: readonly Diagnostic[];
}

/** Validates the complete canonical plan, including Entity/profile associations when present. */
export function validateCanonicalDirectPlan(
  input: unknown,
  context?: TrustedEntityReplayContext,
): CanonicalDirectPlanValidationResult {
  const entityInput =
    typeof input === 'object' && input !== null && !Array.isArray(input)
      ? (input as { readonly entities?: unknown[] }).entities
      : undefined;
  const hasEntities = Array.isArray(entityInput) && entityInput.length > 0;
  const producerValidation = validateDirectPlanEnvelope(
    hasEntities ? { ...(input as object), debugInstances: [] } : input,
  );
  if (producerValidation.value === undefined) {
    return { diagnostics: producerValidation.diagnostics };
  }
  const producerPlan = producerValidation.value.plan;
  if (producerPlan.entities.length === 0) return { value: producerPlan, diagnostics: [] };
  if (context === undefined) {
    return {
      diagnostics: [
        {
          code: 'RT1001',
          severity: 'error',
          message: 'Entity-bearing canonical plans require a trusted replay context.',
        },
      ],
    };
  }
  const entityValidation = validateCanonicalEntityPlanData(input, context);
  return {
    ...(entityValidation.value === undefined ? {} : { value: entityValidation.value.plan }),
    diagnostics: entityValidation.diagnostics,
  };
}

function canonicalizeDirectExecution(
  plan: DirectElaborationPlan,
  execution: ExecutedDirectPlan,
): CanonicalDirectPlanExecutionResult {
  const circuit = execution.circuit;
  const graph = canonicalCircuitGraph(circuit.graph) as ExecutedDirectPlan['circuit']['graph'];
  const canonicalIr = canonicalNativeCircuitIr(circuit.ir) as ExecutedDirectPlan['circuit']['ir'];
  const ir =
    circuit.graph.entities === circuit.ir.entities
      ? ({ ...canonicalIr, entities: graph.entities } as ExecutedDirectPlan['circuit']['ir'])
      : canonicalIr;
  return {
    diagnostics: [],
    execution: Object.freeze({
      ...execution,
      circuit: Object.freeze({ ...circuit, graph, ir }),
    }),
    resolvedCircuit: canonicalResolvedCircuit(undefined, plan, ir) as ResolvedCircuit,
  };
}

/** Validates and executes the canonical direct-plan contract. */
export function tryElaborateDirectPlan(
  input: unknown,
  context?: TrustedEntityReplayContext,
): CanonicalDirectPlanExecutionResult {
  const validation = validateCanonicalDirectPlan(input, context);
  if (validation.value === undefined) return { diagnostics: validation.diagnostics };
  const plan = validation.value;
  if (plan.entities.length === 0) {
    const result = tryExecuteProducerPlan(plan);
    return result.execution === undefined
      ? { diagnostics: result.diagnostics }
      : canonicalizeDirectExecution(plan, result.execution);
  }
  if (context === undefined) throw new Error('unreachable: Entity context was validated above.');
  const result = executeEntityPlan(plan, context);
  return result.execution === undefined
    ? { diagnostics: result.diagnostics }
    : canonicalizeDirectExecution(plan, result.execution);
}

export function elaborateDirectPlan(
  input: unknown,
  context: TrustedEntityReplayContext,
): ExecutedEntityDirectPlan;
export function elaborateDirectPlan(input: unknown, context?: undefined): ExecutedDirectPlan;
export function elaborateDirectPlan(
  input: unknown,
  context?: TrustedEntityReplayContext,
): ExecutedDirectPlan | ExecutedEntityDirectPlan {
  const result = tryElaborateDirectPlan(input, context);
  if (result.execution !== undefined) return result.execution;
  throw new RuntimeDiagnosticError(result.diagnostics[0]!);
}

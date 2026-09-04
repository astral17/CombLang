import type {
  DirectElaborationPlan,
  DirectPlanCapabilityUse,
  DirectPlanDebugValue,
  PlanArithmeticOperand,
  PlanDeciderCondition,
  PlanNetworkRef,
} from '@comblang/compiler/direct-plan-schema';
import type { Diagnostic, ProducerId, SourceSpan } from '@comblang/shared';
import type { TestSession } from '@comblang/simulator';

import {
  DebugIndex,
  DebugQueryError,
  type DebugNetworkEntry,
  type DebugScope,
} from './debug-index.js';
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
function executeDirectPlan(plan: DirectElaborationPlan): ExecutedDirectPlan {
  if (plan.format !== 'comblang-direct-plan' || plan.version !== 2) {
    throw runtimeFailure('RT1001', 'Unsupported direct elaboration plan format.');
  }
  const runtime = new DslRuntime();
  const declarations = new Map(plan.networks.map((declaration) => [declaration.name, declaration]));
  if (declarations.size !== plan.networks.length) {
    const duplicate = plan.networks.find(
      (declaration, index) =>
        plan.networks.findIndex(({ name }) => name === declaration.name) !== index,
    )!;
    throw runtimeFailure(
      'RT1002',
      `Duplicate Network in direct plan: ${duplicate.name}.`,
      duplicate.source,
    );
  }
  const aliases = plan.networkAliases ?? [];
  for (const alias of aliases) {
    if (
      typeof alias.name !== 'string' ||
      alias.name.length === 0 ||
      !declarations.has(alias.network) ||
      !Array.isArray(alias.instancePath) ||
      alias.instancePath.some((segment) => typeof segment !== 'string' || segment.length === 0) ||
      typeof alias.moved !== 'boolean'
    ) {
      throw runtimeFailure(
        'RT1001',
        'Invalid Network alias descriptor in direct plan.',
        alias.source,
      );
    }
  }

  const capabilityUses = Object.freeze([...(plan.capabilityUses ?? [])]);
  for (const use of capabilityUses) {
    if (
      !declarations.has(use.network) ||
      !['readonly', 'ref', 'move'].includes(use.capability) ||
      typeof use.parameter !== 'string' ||
      use.parameter.length === 0 ||
      (use.fixedColor !== undefined && use.fixedColor !== 'red' && use.fixedColor !== 'green')
    ) {
      throw runtimeFailure(
        'RT1001',
        'Invalid capability descriptor in direct plan.',
        use.provenance,
      );
    }
  }

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
          : runtime.decider(
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
  const debug = DebugIndex.fromDirectPlan(
    plan,
    circuit,
    (name) => networks.get(name)!.id,
    (index) => {
      const id = producerIds[index];
      if (id === undefined) throw runtimeFailure('RT1001', 'Missing executed Producer mapping.');
      return id;
    },
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

export function tryElaborateDirectPlan(plan: DirectElaborationPlan): DirectPlanExecutionResult {
  try {
    return { execution: executeDirectPlan(plan), diagnostics: [] };
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

export function elaborateDirectPlan(plan: DirectElaborationPlan): ExecutedDirectPlan {
  const result = tryElaborateDirectPlan(plan);
  if (result.execution !== undefined) return result.execution;
  throw new RuntimeDiagnosticError(result.diagnostics[0]!);
}

import type { DirectElaborationPlan, PlanArithmeticOperand } from '@comblang/compiler/direct-plan';
import type { PlanDeciderCondition } from '@comblang/compiler/direct-plan';
import type { Diagnostic, SourceSpan } from '@comblang/shared';

import {
  DslRuntime,
  RuntimeDiagnosticError,
  type ElaboratedCircuit,
  type NetworkHandle,
  type RuntimeArithmeticOperand,
  type RuntimeConstantConfig,
  type RuntimeDeciderConfig,
} from './elaboration.js';

export interface ExecutedDirectPlan {
  readonly circuit: ElaboratedCircuit;
  network(name: string): NetworkHandle;
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

function lowerOperand(
  operand: PlanArithmeticOperand,
  networks: ReadonlyMap<string, NetworkHandle>,
  source: SourceSpan,
): RuntimeArithmeticOperand {
  if (operand.kind === 'constant') return operand;
  const network = networks.get(operand.network);
  if (network === undefined) {
    throw runtimeFailure(
      'RT1003',
      `Direct plan references unknown Network: ${operand.network}.`,
      source,
    );
  }
  return operand.kind === 'each'
    ? { kind: 'each', network }
    : { kind: 'signal', signal: operand.signal, network };
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
        network: requiredNetwork(condition.left.network, networks, source),
      },
      comparator: condition.comparator,
      right: {
        kind: 'signal',
        signal: condition.right.signal,
        network: requiredNetwork(condition.right.network, networks, source),
      },
    };
  }
  if (condition.kind === 'compare-wildcard') {
    return {
      kind: 'compare',
      left: {
        kind: 'wildcard',
        value: condition.wildcard,
        network: requiredNetwork(condition.network, networks, source),
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
          network: requiredNetwork(condition.network, networks, source),
        },
        comparator: condition.comparator,
        right: { kind: 'constant', value: condition.constant },
      }
    : {
        kind: 'compare',
        left: {
          kind: 'wildcard',
          value: 'each',
          network: requiredNetwork(condition.network, networks, source),
        },
        comparator: condition.comparator,
        right: { kind: 'constant', value: condition.constant },
      };
}

/** Executes compiler-owned descriptors only; it never evaluates source text. */
function executeDirectPlan(plan: DirectElaborationPlan): ExecutedDirectPlan {
  if (plan.format !== 'comblang-direct-plan' || plan.version !== 1) {
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
  for (const descriptor of plan.producers) {
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
                  output.kind === 'signal'
                    ? {
                        signal: { kind: 'signal', signal: output.signal },
                        input: requiredNetwork(output.network, networks, descriptor.source),
                        copyCountFromInput: true,
                      }
                    : output.kind === 'each-constant'
                      ? {
                          signal: { kind: 'wildcard', value: 'each' },
                          copyCountFromInput: false,
                          constant: output.value,
                        }
                      : output.kind === 'signal-constant'
                        ? {
                            signal: { kind: 'signal', signal: output.signal },
                            copyCountFromInput: false,
                            constant: output.value,
                          }
                        : output.kind === 'wildcard'
                          ? {
                              signal: {
                                kind: 'wildcard',
                                value: output.wildcard,
                              },
                              input: requiredNetwork(output.network, networks, descriptor.source),
                              copyCountFromInput: true,
                            }
                          : {
                              signal: { kind: 'wildcard', value: 'each' },
                              input: requiredNetwork(output.network, networks, descriptor.source),
                              copyCountFromInput: true,
                            },
                ),
              } satisfies RuntimeDeciderConfig,
              provenance,
            );
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
  return Object.freeze({
    circuit,
    network(name: string) {
      const movedAt = consumed.get(name);
      if (movedAt !== undefined) {
        throw new RuntimeDiagnosticError({
          code: 'RT2012',
          severity: 'error',
          message: `Cannot use moved Network: ${name}.`,
          span: movedAt,
          related: [{ message: 'Network declared here.', span: declarations.get(name)!.source }],
        });
      }
      const network = networks.get(name);
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

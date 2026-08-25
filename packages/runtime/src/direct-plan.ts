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
  const networks = new Map<string, NetworkHandle>();
  for (const declaration of plan.networks) {
    if (networks.has(declaration.name)) {
      throw runtimeFailure(
        'RT1002',
        `Duplicate Network in direct plan: ${declaration.name}.`,
        declaration.source,
      );
    }
    networks.set(
      declaration.name,
      runtime.network({
        name: declaration.name,
        ...(declaration.fixedColor === undefined ? {} : { color: declaration.fixedColor }),
        source: declaration.source,
        instancePath: declaration.instancePath,
      }),
    );
  }
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

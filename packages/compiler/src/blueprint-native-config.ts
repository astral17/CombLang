import type { SignalId } from '@comblang/factorio';
import type { NetworkId, SourceSpan } from '@comblang/shared';

import type {
  ArithmeticOperation,
  CircuitColor,
  CircuitProducerNode,
  LogicalDeciderCondition,
  LogicalDeciderOutput,
  LogicalNetworkRef,
  LogicalScalarOperand,
  NativeCircuitIr,
  Quantifier,
} from './ir.js';
import { nativeDeciderConditionGroups } from './native-decider-conditions.js';
import { producerInputNetworkIds } from './producer-network-references.js';

export class BlueprintJsonError extends Error {
  readonly code = 'BP1001';
  readonly span: SourceSpan | undefined;

  constructor(message: string, span?: SourceSpan) {
    super(message);
    this.name = 'BlueprintJsonError';
    this.span = span;
  }
}

export interface NativeCombinatorEntityConfig {
  readonly name: 'arithmetic-combinator' | 'constant-combinator' | 'decider-combinator';
  readonly control_behavior: Record<string, unknown>;
}

export interface LoweredNativeCombinator {
  readonly producer: CircuitProducerNode;
  readonly inputNetworks: readonly NetworkId[];
  readonly entity: NativeCombinatorEntityConfig;
}

export interface LoweredNativeBlueprintConfig {
  readonly networkColors: ReadonlyMap<NetworkId, CircuitColor>;
  readonly combinators: readonly LoweredNativeCombinator[];
}

type NetworkSelection = (reference: LogicalNetworkRef) => { red: boolean; green: boolean };

function signalJson(signal: SignalId): Record<string, string> {
  return {
    ...(signal.type === 'item' ? {} : { type: signal.type }),
    name: signal.name,
    ...(signal.quality === undefined ? {} : { quality: signal.quality }),
  };
}

function wildcardSignal(value: Quantifier): Record<string, string> {
  return { type: 'virtual', name: `signal-${value}` };
}

function arithmeticOperationJson(operation: ArithmeticOperation): string {
  const operations: Record<ArithmeticOperation, string> = {
    add: '+',
    subtract: '-',
    multiply: '*',
    divide: '/',
    modulo: '%',
    power: '^',
    'left-shift': '<<',
    'right-shift': '>>',
    'bit-and': 'AND',
    'bit-or': 'OR',
    'bit-xor': 'XOR',
  };
  return operations[operation];
}

function comparatorJson(comparator: '>' | '<' | '=' | '>=' | '<=' | '!='): string {
  return comparator === '>='
    ? '≥'
    : comparator === '<='
      ? '≤'
      : comparator === '!='
        ? '≠'
        : comparator;
}

function scalarFields(
  value: LogicalScalarOperand,
  side: 'first' | 'second',
  selection: NetworkSelection,
) {
  return value.kind === 'constant'
    ? { constant: value.value }
    : {
        [`${side}_signal`]: signalJson(value.signal),
        [`${side}_signal_networks`]: selection(value),
      };
}

function conditionEntries(
  condition: LogicalDeciderCondition,
  selection: NetworkSelection,
  maxRows: number,
): Record<string, unknown>[] {
  return nativeDeciderConditionGroups(condition, maxRows).flatMap((group, groupIndex) =>
    group.map((condition, index) => ({
      first_signal:
        condition.left.kind === 'signal'
          ? signalJson(condition.left.signal)
          : wildcardSignal(condition.left.value),
      first_signal_networks: selection(condition.left),
      comparator: comparatorJson(condition.comparator),
      ...scalarFields(condition.right, 'second', selection),
      compare_type: groupIndex > 0 && index === 0 ? 'or' : 'and',
    })),
  );
}

function outputEntry(
  output: LogicalDeciderOutput,
  selection: NetworkSelection,
): Record<string, unknown> {
  return {
    signal:
      output.signal.kind === 'signal'
        ? signalJson(output.signal.signal)
        : wildcardSignal(output.signal.value),
    copy_count_from_input: output.mode === 'copy',
    ...(output.input === undefined ? {} : { networks: selection(output.input) }),
    ...(output.mode === 'constant' ? { constant: output.value } : {}),
  };
}

function arithmeticEntity(
  producer: Extract<CircuitProducerNode, { kind: 'arithmetic' }>,
  selection: NetworkSelection,
): NativeCombinatorEntityConfig {
  const operandFields = (
    operand: typeof producer.config.left,
    side: 'first' | 'second',
  ): Record<string, unknown> =>
    operand.kind === 'constant'
      ? { [`${side}_constant`]: operand.value }
      : {
          [`${side}_signal`]:
            operand.kind === 'signal' ? signalJson(operand.signal) : wildcardSignal('each'),
          [`${side}_signal_networks`]: selection(operand),
        };
  return {
    name: 'arithmetic-combinator',
    control_behavior: {
      arithmetic_conditions: {
        ...operandFields(producer.config.left, 'first'),
        operation: arithmeticOperationJson(producer.config.operation),
        ...operandFields(producer.config.right, 'second'),
        output_signal:
          producer.config.output.kind === 'signal'
            ? signalJson(producer.config.output.signal)
            : wildcardSignal('each'),
      },
    },
  };
}

function constantEntity(
  producer: Extract<CircuitProducerNode, { kind: 'constant' }>,
): NativeCombinatorEntityConfig {
  return {
    name: 'constant-combinator',
    control_behavior: {
      sections: {
        sections: [
          {
            index: 1,
            filters: producer.config.outputs.map((output, index) => ({
              index: index + 1,
              ...signalJson(output.signal),
              comparator: '=',
              count: output.value,
            })),
          },
        ],
      },
    },
  };
}

function deciderEntity(
  producer: Extract<CircuitProducerNode, { kind: 'decider' }>,
  selection: NetworkSelection,
  maxRows: number,
): NativeCombinatorEntityConfig {
  let conditions: Record<string, unknown>[];
  try {
    conditions = conditionEntries(producer.config.condition, selection, maxRows);
  } catch (error) {
    throw new BlueprintJsonError(
      error instanceof Error ? error.message : 'Invalid Decider conditions.',
      producer.provenance.source,
    );
  }
  return {
    name: 'decider-combinator',
    control_behavior: {
      decider_conditions: {
        conditions,
        outputs: producer.config.outputs.map((output) => outputEntry(output, selection)),
        ...(producer.config.elseOutputs === undefined
          ? {}
          : {
              else_outputs: producer.config.elseOutputs.map((output) =>
                outputEntry(output, selection),
              ),
            }),
      },
    },
  };
}

/** Resolves logical NCIR references into native combinator fields before JSON assembly. */
export function lowerNativeBlueprintConfig(
  ir: NativeCircuitIr,
  maxDeciderConditionRows: number,
): LoweredNativeBlueprintConfig {
  const networkColors = new Map(ir.networks.map((network) => [network.id, network.color]));
  const selection: NetworkSelection = (reference) => {
    const result = { red: false, green: false };
    for (const network of reference.refKind === 'single'
      ? [reference.network]
      : reference.networks) {
      const color = networkColors.get(network);
      if (color === undefined) {
        throw new BlueprintJsonError(`No resolved color for Network ${network}.`);
      }
      result[color] = true;
    }
    return result;
  };

  const combinators = ir.producers.map((producer) => {
    const entity =
      producer.kind === 'arithmetic'
        ? arithmeticEntity(producer, selection)
        : producer.kind === 'constant'
          ? constantEntity(producer)
          : deciderEntity(producer, selection, maxDeciderConditionRows);
    for (const network of producer.destinations) {
      if (!networkColors.has(network)) {
        throw new BlueprintJsonError(
          `No resolved color for destination Network ${network}.`,
          producer.provenance.source,
        );
      }
    }
    return {
      producer,
      inputNetworks: producerInputNetworkIds(producer),
      entity,
    };
  });

  return { networkColors, combinators };
}

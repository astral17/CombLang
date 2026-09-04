import type { SignalId } from '@comblang/factorio';
import type { NetworkId, ProducerId, SourceSpan } from '@comblang/shared';
import { nativeDeciderConditionGroups } from './native-decider-conditions.js';

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

export interface FactorioBlueprintJson {
  readonly blueprint: {
    readonly item: 'blueprint';
    readonly label: string;
    readonly version: number;
    readonly icons: readonly {
      readonly signal: { readonly type: 'item'; readonly name: 'blueprint' };
      readonly index: 1;
    }[];
    readonly entities: readonly Record<string, unknown>[];
    readonly wires: readonly (readonly [number, number, number, number])[];
  };
}

export interface BlueprintJsonOptions {
  readonly label?: string;
  /** Export-time expansion guard, not a language/DSL operation limit. Default: 1024. */
  readonly maxDeciderConditionRows?: number;
}

export class BlueprintJsonError extends Error {
  readonly code = 'BP1001';
  readonly span: SourceSpan | undefined;

  constructor(message: string, span?: SourceSpan) {
    super(message);
    this.name = 'BlueprintJsonError';
    this.span = span;
  }
}

type NetworkSelection = (reference: LogicalNetworkRef) => { red: boolean; green: boolean };

const FACTORIO_2_0_VERSION = 562_949_953_421_312;

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
) {
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

function constantEntity(producer: Extract<CircuitProducerNode, { kind: 'constant' }>) {
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
) {
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

interface WireEndpoint {
  readonly entity: number;
  readonly connector: number;
}

function producerInputs(producer: CircuitProducerNode): NetworkId[] {
  const inputs: NetworkId[] = [];
  const add = (network: NetworkId | undefined) => {
    if (network !== undefined && !inputs.includes(network)) inputs.push(network);
  };
  const addRef = (value: LogicalNetworkRef) => {
    const networks = value.refKind === 'single' ? [value.network] : value.networks;
    for (const network of networks) add(network);
  };
  if (producer.kind === 'arithmetic') {
    if (producer.config.left.kind !== 'constant') addRef(producer.config.left);
    if (producer.config.right.kind !== 'constant') addRef(producer.config.right);
  } else if (producer.kind === 'decider') {
    const walk = (condition: LogicalDeciderCondition) => {
      if (condition.kind === 'and' || condition.kind === 'or') {
        condition.conditions.forEach(walk);
      } else {
        addRef(condition.left);
        if (condition.right.kind === 'signal') addRef(condition.right);
      }
    };
    walk(producer.config.condition);
    producer.config.outputs.forEach((output) => {
      if (output.input !== undefined) addRef(output.input);
    });
    producer.config.elseOutputs?.forEach((output) => {
      if (output.input !== undefined) addRef(output.input);
    });
  }
  return inputs;
}

function connector(
  producer: CircuitProducerNode,
  side: 'input' | 'output',
  color: CircuitColor,
): number {
  const colorOffset = color === 'red' ? 0 : 1;
  return producer.kind === 'constant' || side === 'input' ? 1 + colorOffset : 3 + colorOffset;
}

/** Generates readable, uncompressed Factorio 2.x blueprint JSON from resolved circuit IR. */
export function generateBlueprintJson(
  ir: NativeCircuitIr,
  options: BlueprintJsonOptions = {},
): FactorioBlueprintJson {
  const maxRows = options.maxDeciderConditionRows ?? 1024;
  if (!Number.isSafeInteger(maxRows) || maxRows < 1) {
    throw new RangeError('maxDeciderConditionRows must be a positive safe integer.');
  }
  const numbers = new Map<ProducerId, number>(
    ir.producers.map((producer, index) => [producer.id, index + 1]),
  );
  const colors = new Map(ir.networks.map((network) => [network.id, network.color]));
  const selection: NetworkSelection = (reference) => {
    const result = { red: false, green: false };
    for (const network of reference.refKind === 'single'
      ? [reference.network]
      : reference.networks) {
      const color = colors.get(network);
      if (color === undefined)
        throw new BlueprintJsonError(`No resolved color for Network ${network}.`);
      result[color] = true;
    }
    return result;
  };
  const endpoints = new Map<NetworkId, WireEndpoint[]>();
  const addEndpoint = (network: NetworkId, endpoint: WireEndpoint) => {
    const list = endpoints.get(network) ?? [];
    if (
      !list.some(
        (value) => value.entity === endpoint.entity && value.connector === endpoint.connector,
      )
    ) {
      list.push(endpoint);
      endpoints.set(network, list);
    }
  };

  for (const producer of ir.producers) {
    const entity = numbers.get(producer.id)!;
    for (const network of producerInputs(producer)) {
      addEndpoint(network, {
        entity,
        connector: connector(producer, 'input', colors.get(network) ?? 'red'),
      });
    }
    for (const network of producer.destinations) {
      addEndpoint(network, {
        entity,
        connector: connector(producer, 'output', colors.get(network) ?? 'red'),
      });
    }
  }

  const wires: [number, number, number, number][] = [];
  for (const list of endpoints.values()) {
    for (let index = 1; index < list.length; index += 1) {
      const left = list[index - 1]!;
      const right = list[index]!;
      wires.push([left.entity, left.connector, right.entity, right.connector]);
    }
  }

  const entities = ir.producers.map((producer, index) => ({
    entity_number: numbers.get(producer.id)!,
    ...(producer.kind === 'arithmetic'
      ? arithmeticEntity(producer, selection)
      : producer.kind === 'constant'
        ? constantEntity(producer)
        : deciderEntity(producer, selection, maxRows)),
    position:
      producer.placement === undefined
        ? { x: index * 2 + 0.5, y: 0.5 }
        : { x: producer.placement.x, y: producer.placement.y },
    direction: producer.placement?.direction ?? 4,
  }));

  return {
    blueprint: {
      item: 'blueprint',
      label: options.label ?? 'CombLang generated circuit',
      version: FACTORIO_2_0_VERSION,
      icons: [{ signal: { type: 'item', name: 'blueprint' }, index: 1 }],
      entities,
      wires,
    },
  };
}

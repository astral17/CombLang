import type { SignalId } from '@comblang/factorio';
import type { NetworkId, ProducerId } from '@comblang/shared';

import type {
  ArithmeticOperation,
  CircuitColor,
  CircuitProducerNode,
  LogicalDeciderCondition,
  LogicalDeciderOutput,
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
}

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

function scalarFields(value: LogicalScalarOperand, side: 'first' | 'second') {
  return value.kind === 'constant'
    ? { constant: value.value }
    : { [`${side}_signal`]: signalJson(value.signal) };
}

function conditionEntries(
  condition: LogicalDeciderCondition,
  compareType: 'and' | 'or' = 'and',
): Record<string, unknown>[] {
  if (condition.kind === 'and' || condition.kind === 'or') {
    return condition.conditions.flatMap((child) => conditionEntries(child, condition.kind));
  }
  return [
    {
      first_signal:
        condition.left.kind === 'signal'
          ? signalJson(condition.left.signal)
          : wildcardSignal(condition.left.value),
      comparator: comparatorJson(condition.comparator),
      ...scalarFields(condition.right, 'second'),
      compare_type: compareType,
    },
  ];
}

function outputEntry(output: LogicalDeciderOutput): Record<string, unknown> {
  return {
    signal:
      output.signal.kind === 'signal'
        ? signalJson(output.signal.signal)
        : wildcardSignal(output.signal.value),
    copy_count_from_input: output.copyCountFromInput ?? true,
    ...(output.constant === undefined ? {} : { constant: output.constant }),
  };
}

function arithmeticEntity(producer: Extract<CircuitProducerNode, { kind: 'arithmetic' }>) {
  const operandFields = (
    operand: typeof producer.config.left,
    side: 'first' | 'second',
  ): Record<string, unknown> =>
    operand.kind === 'constant'
      ? { [`${side}_constant`]: operand.value }
      : {
          [`${side}_signal`]:
            operand.kind === 'signal' ? signalJson(operand.signal) : wildcardSignal('each'),
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

function deciderEntity(producer: Extract<CircuitProducerNode, { kind: 'decider' }>) {
  return {
    name: 'decider-combinator',
    control_behavior: {
      decider_conditions: {
        conditions: conditionEntries(producer.config.condition),
        outputs: producer.config.outputs.map(outputEntry),
        ...(producer.config.elseOutputs === undefined
          ? {}
          : { else_outputs: producer.config.elseOutputs.map(outputEntry) }),
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
  const addRef = (value: {
    readonly network: NetworkId;
    readonly networks?: readonly NetworkId[];
  }) => {
    for (const network of value.networks ?? [value.network]) add(network);
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
      for (const network of output.inputs ?? (output.input === undefined ? [] : [output.input]))
        add(network);
    });
    producer.config.elseOutputs?.forEach((output) => {
      for (const network of output.inputs ?? (output.input === undefined ? [] : [output.input]))
        add(network);
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
  const numbers = new Map<ProducerId, number>(
    ir.producers.map((producer, index) => [producer.id, index + 1]),
  );
  const colors = new Map(ir.networks.map((network) => [network.id, network.color]));
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
      ? arithmeticEntity(producer)
      : producer.kind === 'constant'
        ? constantEntity(producer)
        : deciderEntity(producer)),
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

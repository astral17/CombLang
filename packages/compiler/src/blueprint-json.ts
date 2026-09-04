import type { NetworkId, ProducerId } from '@comblang/shared';

import { lowerNativeBlueprintConfig } from './blueprint-native-config.js';

import type { CircuitColor, CircuitProducerNode, NativeCircuitIr } from './ir.js';

export { BlueprintJsonError } from './blueprint-native-config.js';

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

const FACTORIO_2_0_VERSION = 562_949_953_421_312;

interface WireEndpoint {
  readonly entity: number;
  readonly connector: number;
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
  const lowered = lowerNativeBlueprintConfig(ir, maxRows);
  const numbers = new Map<ProducerId, number>(
    ir.producers.map((producer, index) => [producer.id, index + 1]),
  );
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

  for (const { producer, inputNetworks } of lowered.combinators) {
    const entity = numbers.get(producer.id)!;
    for (const network of inputNetworks) {
      addEndpoint(network, {
        entity,
        connector: connector(producer, 'input', lowered.networkColors.get(network)!),
      });
    }
    for (const network of producer.destinations) {
      addEndpoint(network, {
        entity,
        connector: connector(producer, 'output', lowered.networkColors.get(network)!),
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

  const entities = lowered.combinators.map(({ producer, entity }, index) => ({
    entity_number: numbers.get(producer.id)!,
    ...entity,
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

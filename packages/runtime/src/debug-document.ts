import type { CircuitProducerNode, ElaborationGraph, EntityPlacement } from '@comblang/compiler/ir';
import type { NetworkId } from '@comblang/shared';

import type { DebugIndex, DebugNetworkEntry, DebugProducerEntry } from './debug-index.js';
import { producerInputNetworks } from './debug-structure.js';

export interface DebugDocumentProducer extends Omit<DebugProducerEntry, 'descriptor'> {
  readonly inputs: readonly NetworkId[];
  readonly outputs: readonly NetworkId[];
  readonly config: CircuitProducerNode['config'];
  readonly placement?: EntityPlacement;
}

/** Inspection data only: cloned entries are not executable debug handles. */
export interface DebugDocument {
  readonly format: 'comblang-debug';
  readonly version: 1;
  readonly scopes: readonly {
    readonly path: readonly string[];
    readonly networks: readonly DebugNetworkEntry[];
    readonly producers: readonly DebugDocumentProducer[];
  }[];
}

/** Serialize IDs from this execution's EG, never by matching array ordinals. */
export function createDebugDocument(index: DebugIndex, graph: ElaborationGraph): DebugDocument {
  const byId = new Map(graph.producers.map((producer) => [producer.id, producer]));
  const document: DebugDocument = {
    format: 'comblang-debug',
    version: 1,
    scopes: index.scopes.map((scope) => ({
      path: scope.path,
      networks: scope.networks,
      producers: scope.producers.map(({ descriptor: _descriptor, ...entry }) => {
        const producer = byId.get(entry.id);
        if (producer === undefined)
          throw new Error(`Debug Producer ${entry.id} is absent from EG.`);
        return {
          ...entry,
          inputs: [...producerInputNetworks(producer)],
          outputs: producer.destinations,
          config: producer.config,
          ...(producer.placement === undefined ? {} : { placement: producer.placement }),
        };
      }),
    })),
  };
  // No session references, methods, Maps or mutable aliases to the live execution.
  return structuredClone(document);
}

/** All aliases are retained, including moved declarations sharing a physical bus. */
export function inspectDebugNetwork(document: DebugDocument, id: NetworkId) {
  return {
    bindings: document.scopes.flatMap((scope) => scope.networks.filter((entry) => entry.id === id)),
    producers: document.scopes.flatMap((scope) =>
      scope.producers.filter((entry) => entry.inputs.includes(id) || entry.outputs.includes(id)),
    ),
  };
}

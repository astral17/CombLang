import type { EntityPhysicalRecord } from '@comblang/compiler/entity';
import type { CircuitProducerNode, ElaborationGraph, EntityPlacement } from '@comblang/compiler/ir';
import type { ElaborationGraphV3 } from '@comblang/compiler/entity';
import type { ElaborationGraphV4 } from '@comblang/compiler/entity-v4';
import type { ElaborationGraphV5, EntityPhysicalRecordV5 } from '@comblang/compiler/entity-v5';
import type { ElaborationGraphV6, EntityPhysicalRecordV6 } from '@comblang/compiler/entity-v6';
import type { NetworkId } from '@comblang/shared';
import type { DeciderOutputOrigin } from '@comblang/compiler/direct-plan-schema';

import type {
  DebugEntityEntry,
  DebugIndex,
  DebugNetworkEntry,
  DebugProducerEntry,
} from './debug-index.js';
import { producerInputNetworks } from './debug-structure.js';

export interface DebugDocumentProducer extends Omit<DebugProducerEntry, 'descriptor'> {
  readonly inputs: readonly NetworkId[];
  readonly outputs: readonly NetworkId[];
  readonly config: CircuitProducerNode['config'];
  readonly placement?: EntityPlacement;
  readonly outputOrigins?: readonly DeciderOutputOrigin[];
  readonly elseOutputOrigins?: readonly DeciderOutputOrigin[];
}

export interface DebugDocumentEntity extends Omit<DebugEntityEntry, 'record'> {
  readonly record: EntityPhysicalRecord | EntityPhysicalRecordV5 | EntityPhysicalRecordV6;
}

interface DebugDocumentScopeV1 {
  readonly path: readonly string[];
  readonly networks: readonly DebugNetworkEntry[];
  readonly producers: readonly DebugDocumentProducer[];
}

export interface DebugDocumentV1 {
  readonly format: 'comblang-debug';
  readonly version: 1;
  readonly scopes: readonly DebugDocumentScopeV1[];
}

export interface DebugDocumentV2 {
  readonly format: 'comblang-debug';
  readonly version: 2;
  readonly scopes: readonly (DebugDocumentScopeV1 & {
    readonly entities: readonly DebugDocumentEntity[];
  })[];
}

/** Inspection data only: cloned entries are not executable debug handles. */
export type DebugDocument = DebugDocumentV1 | DebugDocumentV2;

/** Serialize IDs from this execution's EG, never by matching array ordinals. */
export function createDebugDocument(
  index: DebugIndex,
  graph:
    | ElaborationGraph
    | ElaborationGraphV3
    | ElaborationGraphV4
    | ElaborationGraphV5
    | ElaborationGraphV6,
): DebugDocument {
  const byId = new Map(graph.producers.map((producer) => [producer.id, producer]));
  const scopes = index.scopes.map((scope) => ({
    path: scope.path,
    networks: scope.networks,
    producers: scope.producers.map(({ descriptor: _descriptor, ...entry }) => {
      const producer = byId.get(entry.id);
      if (producer === undefined) throw new Error(`Debug Producer ${entry.id} is absent from EG.`);
      return {
        ...entry,
        inputs: [...producerInputNetworks(producer)],
        outputs: producer.destinations,
        config: producer.config,
        ...(producer.placement === undefined ? {} : { placement: producer.placement }),
        ...(producer.kind === 'decider' && 'outputOrigins' in producer
          ? {
              outputOrigins: producer.outputOrigins,
              ...(producer.elseOutputOrigins === undefined
                ? {}
                : { elseOutputOrigins: producer.elseOutputOrigins }),
            }
          : {}),
      };
    }),
  }));
  const document: DebugDocument =
    graph.version === 3 || graph.version === 4 || graph.version === 5 || graph.version === 6
      ? {
          format: 'comblang-debug',
          version: 2,
          scopes: scopes.map((scope, scopeIndex) => ({
            ...scope,
            entities: index.scopes[scopeIndex]!.entities.map(({ record, ...entry }) => ({
              ...entry,
              record,
            })),
          })),
        }
      : {
          format: 'comblang-debug',
          version: 1,
          scopes,
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

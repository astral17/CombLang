import { prototypeDatabaseIdentity } from './identity.js';
import type {
  EntityCircuitCapabilities,
  EntityPrototypeKey,
  PrototypeDatabaseV1,
} from './schema.js';
import {
  PrototypeValidationError,
  validateEntityCircuitCapabilities,
  validatePrototypeDatabase,
} from './validation.js';

/** External assertions from a probe or reviewed fixture, not proof of game behavior. */
export interface EntityCircuitSupplement {
  readonly schemaVersion: 1;
  readonly baseIdentity: string;
  readonly entities: readonly {
    readonly key: EntityPrototypeKey;
    readonly type: string;
    readonly circuit: EntityCircuitCapabilities;
  }[];
}

export class CircuitSupplementError extends Error {
  constructor(
    readonly code: 'PC1000' | 'PC1001' | 'PC1002' | 'PC1003',
    readonly path: string,
    message: string,
  ) {
    super(`${path}: ${message}`);
    this.name = 'CircuitSupplementError';
  }
}

function object(value: unknown, path: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new CircuitSupplementError('PC1001', path, 'expected an object.');
  }
  return value as Record<string, unknown>;
}

/** Adds explicit circuit records only; rejects stale inputs and conflicting facts. */
export async function applyEntityCircuitSupplement(
  value: unknown,
  supplement: unknown,
): Promise<PrototypeDatabaseV1> {
  const database = validatePrototypeDatabase(value);
  const input = object(supplement, '<supplement>');
  if (input.schemaVersion !== 1) {
    throw new CircuitSupplementError(
      'PC1000',
      'schemaVersion',
      'expected supplement schema version 1.',
    );
  }
  if (
    typeof input.baseIdentity !== 'string' ||
    !/^comblang-prototypes-v1-sha256:[0-9a-f]{64}$/.test(input.baseIdentity)
  ) {
    throw new CircuitSupplementError(
      'PC1001',
      'baseIdentity',
      'expected a normalized prototype database identity.',
    );
  }
  if (input.baseIdentity !== (await prototypeDatabaseIdentity(database))) {
    throw new CircuitSupplementError(
      'PC1002',
      'baseIdentity',
      'supplement does not match the input database; re-probe or review against the selected environment.',
    );
  }
  if (!database.capabilities.entities) {
    throw new CircuitSupplementError(
      'PC1003',
      'entities',
      'input database must provide entities coverage.',
    );
  }
  if (!Array.isArray(input.entities) || input.entities.length === 0) {
    throw new CircuitSupplementError(
      'PC1001',
      'entities',
      'expected a non-empty array of explicit circuit records.',
    );
  }
  const byKey = new Map(database.entities.map((entity) => [entity.key, entity]));
  const additions = new Map<EntityPrototypeKey, EntityCircuitCapabilities>();
  for (const [index, raw] of input.entities.entries()) {
    const path = `entities[${index}]`;
    const entry = object(raw, path);
    if (typeof entry.key !== 'string' || !entry.key.startsWith('entity:')) {
      throw new CircuitSupplementError(
        'PC1001',
        `${path}.key`,
        'expected an entity: prototype key.',
      );
    }
    const key = entry.key as EntityPrototypeKey;
    if (additions.has(key)) {
      throw new CircuitSupplementError('PC1003', `${path}.key`, `duplicate entity ${key}.`);
    }
    const entity = byKey.get(key);
    if (entity === undefined) {
      throw new CircuitSupplementError('PC1003', `${path}.key`, `unknown entity ${key}.`);
    }
    if (entry.type !== entity.type) {
      throw new CircuitSupplementError(
        'PC1003',
        `${path}.type`,
        `expected entity type ${JSON.stringify(entity.type)}.`,
      );
    }
    object(entry.circuit, `${path}.circuit`);
    // Reuse the authoritative circuit validator with the original supplement path.
    let circuit: EntityCircuitCapabilities;
    try {
      circuit = validateEntityCircuitCapabilities(entry.circuit, `${path}.circuit`);
    } catch (error) {
      if (error instanceof PrototypeValidationError) {
        throw new CircuitSupplementError(
          'PC1001',
          error.path,
          error.message.slice(error.path.length + 2),
        );
      }
      throw error;
    }
    if (
      entity.circuit !== undefined &&
      JSON.stringify(entity.circuit) !== JSON.stringify(circuit)
    ) {
      throw new CircuitSupplementError(
        'PC1003',
        `${path}.circuit`,
        `conflicting circuit facts for ${key}; existing records are not overwritten.`,
      );
    }
    additions.set(key, circuit);
  }
  const entities = database.entities.map((entity) => ({
    ...entity,
    ...(additions.has(entity.key) ? { circuit: additions.get(entity.key) } : {}),
  }));
  return validatePrototypeDatabase({
    ...database,
    entities,
    capabilities: {
      ...database.capabilities,
      entityCircuitCapabilities: entities.every(({ circuit }) => circuit !== undefined),
    },
  });
}

import { compareCanonicalString } from './canonical.js';
import {
  parsePrototypeEvidenceManifest,
  type PrototypeCircuitEvidenceClaim,
  type PrototypeCircuitFactField,
  type PrototypeEvidenceManifestV1,
  type PrototypeEvidenceSource,
} from './evidence.js';
import type { EntityPrototypeKey, PrototypeDatabaseV1 } from './schema.js';

export type PrototypeCircuitEvidenceQuery =
  | {
      readonly status: 'unknown';
      readonly entity: EntityPrototypeKey;
      readonly field: PrototypeCircuitFactField;
    }
  | {
      readonly status: 'unverified';
      readonly entity: EntityPrototypeKey;
      readonly field: PrototypeCircuitFactField;
      readonly value: boolean;
    }
  | {
      readonly status: 'verified';
      readonly entity: EntityPrototypeKey;
      readonly field: PrototypeCircuitFactField;
      readonly value: boolean;
      readonly sources: readonly PrototypeEvidenceSource[];
    };

export interface PrototypeEvidenceIndex {
  readonly structuralSources: readonly PrototypeEvidenceSource[];
  sourceById(id: string): PrototypeEvidenceSource | undefined;
  circuit(
    entity: EntityPrototypeKey,
    field: PrototypeCircuitFactField,
  ): PrototypeCircuitEvidenceQuery;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => compareCanonicalString(left, right))
    .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`)
    .join(',')}}`;
}

function normalizedIdentityPayload(manifest: PrototypeEvidenceManifestV1): unknown {
  const normalized = parsePrototypeEvidenceManifest(manifest);
  return {
    schemaVersion: normalized.schemaVersion,
    kind: normalized.kind,
    databaseIdentity: normalized.databaseIdentity,
    structureEvidence: [...normalized.structureEvidence].sort(compareCanonicalString),
    sources: [...normalized.sources]
      .sort((left, right) => compareCanonicalString(left.id, right.id))
      .map(({ id, kind, artifactSha256 }) => ({ id, kind, artifactSha256 })),
    circuitClaims: [...normalized.circuitClaims]
      .sort((left, right) => {
        const entityOrder = compareCanonicalString(left.fact.entity, right.fact.entity);
        return entityOrder !== 0
          ? entityOrder
          : compareCanonicalString(left.fact.field, right.fact.field);
      })
      .map(({ fact, value, evidence }) => ({
        fact: { entity: fact.entity, field: fact.field },
        value,
        evidence: [...evidence].sort(compareCanonicalString),
      })),
  };
}

/** Computes the order-insensitive identity of a normalized evidence manifest. */
export async function prototypeEvidenceIdentity(
  manifest: PrototypeEvidenceManifestV1,
): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalJson(normalizedIdentityPayload(manifest)));
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  const hex = [...new Uint8Array(digest)]
    .map((value) => value.toString(16).padStart(2, '0'))
    .join('');
  return `comblang-prototype-evidence-v1-sha256:${hex}`;
}

function queryResult<T extends PrototypeCircuitEvidenceQuery>(value: T): T {
  return Object.freeze(value);
}

/** Builds a private-map-backed, immutable query surface for an already-bound manifest. */
export function createPrototypeEvidenceIndex(
  database: PrototypeDatabaseV1,
  manifest: PrototypeEvidenceManifestV1,
): PrototypeEvidenceIndex {
  const sources = new Map(manifest.sources.map((source) => [source.id, source]));
  const structuralSources = Object.freeze(
    manifest.structureEvidence.map((sourceId) => sources.get(sourceId)!),
  );
  const claims = new Map<string, PrototypeCircuitEvidenceClaim>(
    manifest.circuitClaims.map((claim) => [`${claim.fact.entity}\u0000${claim.fact.field}`, claim]),
  );
  const entities = new Map(database.entities.map((entity) => [entity.key, entity]));

  const sourceById = (id: string): PrototypeEvidenceSource | undefined => sources.get(id);
  const circuit = (
    entity: EntityPrototypeKey,
    field: PrototypeCircuitFactField,
  ): PrototypeCircuitEvidenceQuery => {
    const storedEntity = entities.get(entity);
    if (storedEntity?.circuit === undefined || !Object.hasOwn(storedEntity.circuit, field)) {
      return queryResult({ status: 'unknown', entity, field });
    }
    const value = storedEntity.circuit[field];
    const claim = claims.get(`${entity}\u0000${field}`);
    if (claim === undefined) return queryResult({ status: 'unverified', entity, field, value });
    return queryResult({
      status: 'verified',
      entity,
      field,
      value,
      sources: Object.freeze(claim.evidence.map((sourceId) => sources.get(sourceId)!)),
    });
  };

  return Object.freeze({ structuralSources, sourceById, circuit });
}

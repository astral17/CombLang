import { compareCanonicalString } from './canonical.js';
import type { EntityCircuitCapabilities, EntityPrototypeKey } from './schema.js';

export const prototypeEvidenceSchemaVersion = 1 as const;
export const prototypeEvidenceKind = 'comblang-prototype-evidence' as const;

export const prototypeEvidenceSourceKinds = [
  'data-raw-structure',
  'runtime-structure',
  'reviewed-native-behavior',
  'synthetic',
] as const;

export type PrototypeEvidenceSourceKind = (typeof prototypeEvidenceSourceKinds)[number];
export type PrototypeCircuitFactField = keyof EntityCircuitCapabilities;

export const prototypeCircuitFactFields = [
  'read',
  'enableDisable',
  'readContents',
  'setFilters',
  'setRequests',
  'setRecipe',
  'readRecipe',
  'readFinishedCraft',
  'outputSignals',
] as const satisfies readonly PrototypeCircuitFactField[];

export interface PrototypeEvidenceSource {
  readonly id: string;
  readonly kind: PrototypeEvidenceSourceKind;
  readonly artifactSha256: string;
}

export interface PrototypeCircuitFactRef {
  readonly entity: EntityPrototypeKey;
  readonly field: PrototypeCircuitFactField;
}

export interface PrototypeCircuitEvidenceClaim {
  readonly fact: PrototypeCircuitFactRef;
  readonly value: boolean;
  readonly evidence: readonly string[];
}

export interface PrototypeEvidenceManifestV1 {
  readonly schemaVersion: typeof prototypeEvidenceSchemaVersion;
  readonly kind: typeof prototypeEvidenceKind;
  readonly databaseIdentity: string;
  readonly structureEvidence: readonly string[];
  readonly sources: readonly PrototypeEvidenceSource[];
  readonly circuitClaims: readonly PrototypeCircuitEvidenceClaim[];
}

export type PrototypeEvidenceErrorCode =
  'PE1000' | 'PE1001' | 'PE1002' | 'PE1003' | 'PE1004' | 'PE1005' | 'PE1006';

export class PrototypeEvidenceError extends Error {
  constructor(
    readonly code: PrototypeEvidenceErrorCode,
    readonly path: string,
    message: string,
  ) {
    super(`${path}: ${message}`);
    this.name = 'PrototypeEvidenceError';
  }
}

type JsonObject = Record<string, unknown>;

const circuitFactFields = new Set<PrototypeCircuitFactField>(prototypeCircuitFactFields);

const sourceKindSet = new Set<string>(prototypeEvidenceSourceKinds);
const identifierPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const entityKeyPattern = /^entity:[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const databaseIdentityPattern = /^comblang-prototypes-v1-sha256:[0-9a-f]{64}$/;
const artifactSha256Pattern = /^sha256:[0-9a-f]{64}$/;

function invalid(code: PrototypeEvidenceErrorCode, path: string, message: string): never {
  throw new PrototypeEvidenceError(code, path, message);
}

function object(value: unknown, path: string): JsonObject {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    invalid('PE1001', path, 'expected an object.');
  }
  return value as JsonObject;
}

function array(value: unknown, path: string): readonly unknown[] {
  if (!Array.isArray(value)) invalid('PE1001', path, 'expected an array.');
  return value;
}

function string(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    invalid('PE1001', path, 'expected a non-empty string.');
  }
  return value;
}

function identifier(value: unknown, path: string): string {
  const result = string(value, path);
  if (!identifierPattern.test(result)) {
    invalid(
      'PE1001',
      path,
      'expected a stable identifier without whitespace, path separators, or URL syntax.',
    );
  }
  return result;
}

function exactKeys(value: JsonObject, allowed: readonly string[], path: string): void {
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!allowedSet.has(key)) invalid('PE1001', `${path}.${key}`, 'unknown field.');
  }
}

function boolean(value: unknown, path: string): boolean {
  if (typeof value !== 'boolean') invalid('PE1001', path, 'expected a boolean.');
  return value;
}

function arrayEntries(value: unknown, path: string): readonly unknown[] {
  const entries = array(value, path);
  for (let index = 0; index < entries.length; index += 1) {
    if (!(index in entries)) invalid('PE1001', `${path}[${index}]`, 'expected a value.');
  }
  return entries;
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function parseSource(value: unknown, path: string): PrototypeEvidenceSource {
  const input = object(value, path);
  exactKeys(input, ['id', 'kind', 'artifactSha256'], path);
  const id = identifier(input.id, `${path}.id`);
  const kind = string(input.kind, `${path}.kind`);
  if (!sourceKindSet.has(kind)) {
    invalid('PE1000', `${path}.kind`, `unknown evidence source kind ${JSON.stringify(kind)}.`);
  }
  const artifactSha256 = string(input.artifactSha256, `${path}.artifactSha256`);
  if (!artifactSha256Pattern.test(artifactSha256)) {
    invalid(
      'PE1001',
      `${path}.artifactSha256`,
      'expected sha256:<64 lowercase hexadecimal characters>.',
    );
  }
  return { id, kind: kind as PrototypeEvidenceSourceKind, artifactSha256 };
}

function parseFact(value: unknown, path: string): PrototypeCircuitFactRef {
  const input = object(value, path);
  exactKeys(input, ['entity', 'field'], path);
  const entity = string(input.entity, `${path}.entity`);
  if (!entityKeyPattern.test(entity)) {
    invalid('PE1001', `${path}.entity`, 'expected a canonical entity: prototype key.');
  }
  const field = string(input.field, `${path}.field`);
  if (!circuitFactFields.has(field as PrototypeCircuitFactField)) {
    invalid(
      'PE1000',
      `${path}.field`,
      `unknown circuit capability field ${JSON.stringify(field)}.`,
    );
  }
  return { entity: entity as EntityPrototypeKey, field: field as PrototypeCircuitFactField };
}

function parseSourceIds(value: unknown, path: string): string[] {
  return arrayEntries(value, path).map((entry, index) => identifier(entry, `${path}[${index}]`));
}

function parseClaim(value: unknown, path: string): PrototypeCircuitEvidenceClaim {
  const input = object(value, path);
  exactKeys(input, ['fact', 'value', 'evidence'], path);
  const fact = parseFact(input.fact, `${path}.fact`);
  const claimValue = boolean(input.value, `${path}.value`);
  const evidence = parseSourceIds(input.evidence, `${path}.evidence`);
  if (evidence.length === 0) {
    invalid('PE1001', `${path}.evidence`, 'expected a non-empty source ID list.');
  }
  return { fact, value: claimValue, evidence };
}

function compareClaims(
  left: PrototypeCircuitEvidenceClaim,
  right: PrototypeCircuitEvidenceClaim,
): number {
  const entityOrder = compareCanonicalString(left.fact.entity, right.fact.entity);
  return entityOrder !== 0
    ? entityOrder
    : compareCanonicalString(left.fact.field, right.fact.field);
}

/** Parses, copies, canonically orders and deeply freezes an evidence manifest. */
export function parsePrototypeEvidenceManifest(value: unknown): PrototypeEvidenceManifestV1 {
  const input = object(value, '<manifest>');
  exactKeys(
    input,
    ['schemaVersion', 'kind', 'databaseIdentity', 'structureEvidence', 'sources', 'circuitClaims'],
    '<manifest>',
  );
  if (input.schemaVersion !== prototypeEvidenceSchemaVersion) {
    invalid('PE1000', 'schemaVersion', 'expected evidence manifest schema version 1.');
  }
  if (input.kind !== prototypeEvidenceKind) {
    invalid('PE1000', 'kind', `expected ${JSON.stringify(prototypeEvidenceKind)}.`);
  }
  const databaseIdentity = string(input.databaseIdentity, 'databaseIdentity');
  if (!databaseIdentityPattern.test(databaseIdentity)) {
    invalid('PE1001', 'databaseIdentity', 'expected a normalized prototype database identity.');
  }

  const sources = arrayEntries(input.sources, 'sources').map((entry, index) =>
    parseSource(entry, `sources[${index}]`),
  );
  const sourceIds = new Set<string>();
  for (const [index, source] of sources.entries()) {
    if (sourceIds.has(source.id)) {
      invalid(
        'PE1002',
        `sources[${index}].id`,
        `duplicate source ID ${JSON.stringify(source.id)}.`,
      );
    }
    sourceIds.add(source.id);
  }

  const structureEvidence = parseSourceIds(input.structureEvidence, 'structureEvidence');
  const structureSourceIds = new Set<string>();
  for (const [index, sourceId] of structureEvidence.entries()) {
    if (structureSourceIds.has(sourceId)) {
      invalid(
        'PE1002',
        `structureEvidence[${index}]`,
        `duplicate evidence source ID ${JSON.stringify(sourceId)}.`,
      );
    }
    structureSourceIds.add(sourceId);
    if (!sourceIds.has(sourceId)) {
      invalid(
        'PE1003',
        `structureEvidence[${index}]`,
        `unknown source ID ${JSON.stringify(sourceId)}.`,
      );
    }
  }

  const circuitClaims = arrayEntries(input.circuitClaims, 'circuitClaims').map((entry, index) =>
    parseClaim(entry, `circuitClaims[${index}]`),
  );
  const factKeys = new Set<string>();
  for (const [index, claim] of circuitClaims.entries()) {
    const factKey = `${claim.fact.entity}\u0000${claim.fact.field}`;
    if (factKeys.has(factKey)) {
      invalid(
        'PE1002',
        `circuitClaims[${index}].fact`,
        `duplicate circuit fact ${claim.fact.entity}.${claim.fact.field}.`,
      );
    }
    factKeys.add(factKey);
    const evidenceIds = new Set<string>();
    for (const [evidenceIndex, sourceId] of claim.evidence.entries()) {
      if (evidenceIds.has(sourceId)) {
        invalid(
          'PE1002',
          `circuitClaims[${index}].evidence[${evidenceIndex}]`,
          `duplicate evidence source ID ${JSON.stringify(sourceId)}.`,
        );
      }
      evidenceIds.add(sourceId);
      if (!sourceIds.has(sourceId)) {
        invalid(
          'PE1003',
          `circuitClaims[${index}].evidence[${evidenceIndex}]`,
          `unknown source ID ${JSON.stringify(sourceId)}.`,
        );
      }
    }
  }

  const normalized: PrototypeEvidenceManifestV1 = {
    schemaVersion: prototypeEvidenceSchemaVersion,
    kind: prototypeEvidenceKind,
    databaseIdentity,
    structureEvidence: [...structureEvidence].sort(compareCanonicalString),
    sources: [...sources].sort((left, right) => compareCanonicalString(left.id, right.id)),
    circuitClaims: circuitClaims
      .map((claim) => ({
        fact: { ...claim.fact },
        value: claim.value,
        evidence: [...claim.evidence].sort(compareCanonicalString),
      }))
      .sort(compareClaims),
  };
  return deepFreeze(normalized);
}

/** Naming-compatible validation entry point for callers that use validate* APIs. */
export const validatePrototypeEvidenceManifest = parsePrototypeEvidenceManifest;

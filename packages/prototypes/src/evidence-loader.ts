import { prototypeDatabaseIdentity } from './identity.js';
import {
  parsePrototypeEvidenceManifest,
  PrototypeEvidenceError,
  type PrototypeEvidenceManifestV1,
} from './evidence.js';
import {
  createPrototypeEvidenceIndex,
  prototypeEvidenceIdentity,
  type PrototypeEvidenceIndex,
} from './evidence-index.js';
import type { PrototypeDatabaseV1 } from './schema.js';
import { validatePrototypeDatabase } from './validation.js';

export interface LoadedPrototypeEvidenceBinding {
  readonly database: PrototypeDatabaseV1;
  readonly manifest: PrototypeEvidenceManifestV1;
  readonly databaseIdentity: string;
}

export interface LoadedPrototypeEvidence extends LoadedPrototypeEvidenceBinding {
  readonly evidenceIdentity: string;
  readonly index: PrototypeEvidenceIndex;
}

function invalid(code: 'PE1004' | 'PE1005' | 'PE1006', path: string, message: string): never {
  throw new PrototypeEvidenceError(code, path, message);
}

/** Validates a manifest against one immutable database and its allowed authorities. */
export async function loadPrototypeEvidence(
  databaseValue: unknown,
  manifestValue: unknown,
): Promise<LoadedPrototypeEvidence> {
  const database = validatePrototypeDatabase(databaseValue);
  const databaseIdentity = await prototypeDatabaseIdentity(database);
  const manifest = parsePrototypeEvidenceManifest(manifestValue);
  if (manifest.databaseIdentity !== databaseIdentity) {
    invalid(
      'PE1004',
      'databaseIdentity',
      'evidence manifest is stale for the selected prototype database.',
    );
  }

  const sources = new Map(manifest.sources.map((source) => [source.id, source]));
  for (const [index, sourceId] of manifest.structureEvidence.entries()) {
    const source = sources.get(sourceId)!;
    if (source.kind !== 'data-raw-structure' && source.kind !== 'runtime-structure') {
      invalid(
        'PE1005',
        `structureEvidence[${index}]`,
        `source ${JSON.stringify(sourceId)} cannot establish structural evidence because its kind is ${JSON.stringify(source.kind)}.`,
      );
    }
  }

  const entities = new Map(database.entities.map((entity) => [entity.key, entity]));
  for (const [claimIndex, claim] of manifest.circuitClaims.entries()) {
    for (const [evidenceIndex, sourceId] of claim.evidence.entries()) {
      const source = sources.get(sourceId)!;
      if (source.kind !== 'reviewed-native-behavior') {
        invalid(
          'PE1005',
          `circuitClaims[${claimIndex}].evidence[${evidenceIndex}]`,
          `source ${JSON.stringify(sourceId)} cannot verify circuit behavior because its kind is ${JSON.stringify(source.kind)}.`,
        );
      }
    }
    const entity = entities.get(claim.fact.entity);
    if (entity === undefined) {
      invalid(
        'PE1005',
        `circuitClaims[${claimIndex}].fact.entity`,
        `unknown entity ${JSON.stringify(claim.fact.entity)} in the selected prototype database.`,
      );
    }
    if (entity.circuit === undefined) {
      invalid(
        'PE1005',
        `circuitClaims[${claimIndex}].fact.entity`,
        `entity ${JSON.stringify(claim.fact.entity)} has no stored circuit capability record.`,
      );
    }
    if (!Object.prototype.hasOwnProperty.call(entity.circuit, claim.fact.field)) {
      invalid(
        'PE1005',
        `circuitClaims[${claimIndex}].fact.field`,
        `entity ${JSON.stringify(claim.fact.entity)} has no stored circuit field ${JSON.stringify(claim.fact.field)}.`,
      );
    }
    if (entity.circuit[claim.fact.field] !== claim.value) {
      invalid(
        'PE1006',
        `circuitClaims[${claimIndex}].value`,
        `manifest value does not match the stored database value for ${claim.fact.entity}.${claim.fact.field}.`,
      );
    }
  }

  const evidenceIdentity = await prototypeEvidenceIdentity(manifest);
  const index = createPrototypeEvidenceIndex(database, manifest);
  return Object.freeze({ database, manifest, databaseIdentity, evidenceIdentity, index });
}

export const loadPrototypeEvidenceManifest = loadPrototypeEvidence;

import type { EntityProfileRef, EntityProfile } from './entity.js';
import {
  resolveEntityReplayProfile,
  type TrustedEntityReplayContext,
} from './entity-replay-context.js';

export interface BlueprintImportProfileMappingEntry {
  readonly entityNumber: number;
  readonly profile: EntityProfileRef;
}

export interface BlueprintImportProfileMappingOptions {
  readonly maxEndpoints?: number;
  readonly signal?: AbortSignal;
}

export interface BlueprintImportProfileEndpointMapping {
  readonly entityNumber: number;
  readonly connectorId: number;
  readonly color: 'red' | 'green';
}

export type BlueprintImportProfileMappingDiagnosticCategory =
  | 'unknown-connector-structure'
  | 'missing-native-endpoint'
  | 'invalid-native-ordinal'
  | 'duplicate-endpoint';

export interface BlueprintImportProfileMappingDiagnostic {
  readonly category: BlueprintImportProfileMappingDiagnosticCategory;
  readonly message: string;
  readonly path: string;
  readonly entityNumber: number;
  readonly connectorId?: number;
}

export interface BlueprintImportProfileMappingResult {
  readonly state: 'complete' | 'blocked';
  readonly mappings: readonly BlueprintImportProfileEndpointMapping[];
  readonly diagnostics: readonly BlueprintImportProfileMappingDiagnostic[];
}

interface ResolvedOptions {
  readonly maxEndpoints: number;
  readonly signal: AbortSignal | undefined;
}

interface ValidatedEntry {
  readonly entityNumber: number;
  readonly profile: unknown;
}

const defaultMaxEndpoints = 100_000;
const allowedOptionNames = new Set(['maxEndpoints', 'signal']);
const allowedEntryNames = new Set(['entityNumber', 'profile']);
const emptyMappings: readonly BlueprintImportProfileEndpointMapping[] = Object.freeze([]);

function positiveSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function resolveOptions(
  options: BlueprintImportProfileMappingOptions | undefined,
): ResolvedOptions {
  if (options === undefined) return { maxEndpoints: defaultMaxEndpoints, signal: undefined };
  if (
    typeof options !== 'object' ||
    options === null ||
    Array.isArray(options) ||
    (Object.getPrototypeOf(options) !== Object.prototype && Object.getPrototypeOf(options) !== null)
  ) {
    throw new TypeError('Blueprint profile mapping options must be a plain object.');
  }

  let maxEndpoints = defaultMaxEndpoints;
  let signal: AbortSignal | undefined;
  for (const key of Reflect.ownKeys(options)) {
    if (typeof key !== 'string' || !allowedOptionNames.has(key)) {
      throw new TypeError(`Unknown blueprint profile mapping option: ${String(key)}.`);
    }
    const descriptor = Object.getOwnPropertyDescriptor(options, key);
    if (descriptor === undefined || !('value' in descriptor)) {
      throw new TypeError(`Blueprint profile mapping option ${key} must be a data property.`);
    }
    if (key === 'maxEndpoints') {
      if (!positiveSafeInteger(descriptor.value)) {
        throw new RangeError('maxEndpoints must be a positive safe integer.');
      }
      maxEndpoints = descriptor.value;
    } else if (descriptor.value !== undefined) {
      const candidate: unknown = descriptor.value;
      if (
        typeof candidate !== 'object' ||
        candidate === null ||
        typeof (candidate as AbortSignal).aborted !== 'boolean'
      ) {
        throw new TypeError('signal must be an AbortSignal.');
      }
      signal = candidate as AbortSignal;
    }
  }
  return { maxEndpoints, signal };
}

function checkAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  const error = new Error('Blueprint import profile mapping was cancelled.');
  error.name = 'AbortError';
  throw error;
}

function validateEntries(
  entries: readonly BlueprintImportProfileMappingEntry[],
  signal: AbortSignal | undefined,
): ValidatedEntry[] {
  if (!Array.isArray(entries))
    throw new TypeError('Blueprint profile mapping entries must be an array.');
  const validated: ValidatedEntry[] = [];
  const seen = new Set<number>();
  for (let index = 0; index < entries.length; index += 1) {
    checkAborted(signal);
    const candidate: unknown = entries[index];
    if (
      typeof candidate !== 'object' ||
      candidate === null ||
      Array.isArray(candidate) ||
      (Object.getPrototypeOf(candidate) !== Object.prototype &&
        Object.getPrototypeOf(candidate) !== null)
    ) {
      throw new TypeError(`Blueprint profile mapping entry ${index} must be a plain object.`);
    }

    let entityNumber: unknown;
    let profile: unknown;
    let hasEntityNumber = false;
    let hasProfile = false;
    for (const key of Reflect.ownKeys(candidate)) {
      if (typeof key !== 'string' || !allowedEntryNames.has(key)) {
        throw new TypeError(`Blueprint profile mapping entry ${index} has an unknown field.`);
      }
      const descriptor = Object.getOwnPropertyDescriptor(candidate, key);
      if (descriptor === undefined || !('value' in descriptor)) {
        throw new TypeError(
          `Blueprint profile mapping entry ${index}.${key} must be a data property.`,
        );
      }
      if (key === 'entityNumber') {
        entityNumber = descriptor.value;
        hasEntityNumber = true;
      } else {
        profile = descriptor.value;
        hasProfile = true;
      }
    }
    if (!hasEntityNumber || !positiveSafeInteger(entityNumber)) {
      throw new TypeError(
        `Blueprint profile mapping entry ${index}.entityNumber must be a positive safe integer.`,
      );
    }
    if (!hasProfile) {
      throw new TypeError(`Blueprint profile mapping entry ${index}.profile is required.`);
    }
    if (seen.has(entityNumber)) {
      throw new TypeError(`Duplicate blueprint entity_number ${entityNumber} in profile mappings.`);
    }
    seen.add(entityNumber);
    validated.push({ entityNumber, profile });
  }
  return validated;
}

function diagnostic(
  category: BlueprintImportProfileMappingDiagnosticCategory,
  message: string,
  path: string,
  entityNumber: number,
  connectorId?: number,
): BlueprintImportProfileMappingDiagnostic {
  return Object.freeze({
    category,
    message,
    path,
    entityNumber,
    ...(connectorId === undefined ? {} : { connectorId }),
  });
}

function blocked(
  diagnostics: readonly BlueprintImportProfileMappingDiagnostic[],
): BlueprintImportProfileMappingResult {
  return Object.freeze({
    state: 'blocked',
    mappings: emptyMappings,
    diagnostics: Object.freeze(diagnostics.slice()),
  });
}

function compareMappings(
  left: BlueprintImportProfileEndpointMapping,
  right: BlueprintImportProfileEndpointMapping,
): number {
  return left.entityNumber - right.entityNumber || left.connectorId - right.connectorId;
}

function appendEndpointMappings(
  profile: EntityProfile,
  entityNumber: number,
  entryIndex: number,
  output: BlueprintImportProfileEndpointMapping[],
  diagnostics: BlueprintImportProfileMappingDiagnostic[],
  seenEndpoints: Set<string>,
  signal: AbortSignal | undefined,
): void {
  checkAborted(signal);
  if (profile.connectorStructure === 'unknown') {
    diagnostics.push(
      diagnostic(
        'unknown-connector-structure',
        'The selected profile does not describe a complete connector structure.',
        `$.entries[${entryIndex}].profile.connectorStructure`,
        entityNumber,
      ),
    );
    return;
  }

  for (let connectorIndex = 0; connectorIndex < profile.connectors.length; connectorIndex += 1) {
    checkAborted(signal);
    const connector = profile.connectors[connectorIndex]!;
    for (let laneIndex = 0; laneIndex < connector.lanes.length; laneIndex += 1) {
      checkAborted(signal);
      const lane = connector.lanes[laneIndex]!;
      const path = `$.entries[${entryIndex}].profile.connectors[${connectorIndex}].lanes[${laneIndex}].nativeEndpoint`;
      const ordinal = lane.nativeEndpoint?.nativeConnector;
      if (ordinal === undefined) {
        diagnostics.push(
          diagnostic(
            'missing-native-endpoint',
            'A declared physical connector lane has no native endpoint mapping.',
            path,
            entityNumber,
          ),
        );
        continue;
      }

      const doubledOrdinal = ordinal * 2;
      if (!Number.isSafeInteger(ordinal) || ordinal < 1 || !Number.isSafeInteger(doubledOrdinal)) {
        diagnostics.push(
          diagnostic(
            'invalid-native-ordinal',
            'The physical connector ordinal cannot be represented by the exporter convention.',
            path,
            entityNumber,
          ),
        );
        continue;
      }

      const connectorId = doubledOrdinal - (lane.color === 'red' ? 1 : 0);
      if (!Number.isSafeInteger(connectorId)) {
        diagnostics.push(
          diagnostic(
            'invalid-native-ordinal',
            'The encoded wire connector ID is not a safe integer.',
            path,
            entityNumber,
          ),
        );
        continue;
      }
      const endpointKey = `${entityNumber}:${connectorId}`;
      if (seenEndpoints.has(endpointKey)) {
        diagnostics.push(
          diagnostic(
            'duplicate-endpoint',
            `The selected profiles produce duplicate endpoint ${endpointKey}.`,
            path,
            entityNumber,
            connectorId,
          ),
        );
        continue;
      }
      seenEndpoints.add(endpointKey);
      output.push(Object.freeze({ entityNumber, connectorId, color: lane.color }));
    }
  }
}

/** Projects selected trusted profiles into detached raw wire endpoint mappings only. */
export function projectBlueprintImportProfileMappings(
  entries: readonly BlueprintImportProfileMappingEntry[],
  context: TrustedEntityReplayContext,
  options?: BlueprintImportProfileMappingOptions,
): BlueprintImportProfileMappingResult {
  const resolvedOptions = resolveOptions(options);
  if (!Array.isArray(entries))
    throw new TypeError('Blueprint profile mapping entries must be an array.');
  if (entries.length > resolvedOptions.maxEndpoints) {
    throw new RangeError(
      `Blueprint profile mapping entry limit exceeded (${resolvedOptions.maxEndpoints}).`,
    );
  }
  checkAborted(resolvedOptions.signal);
  const validatedEntries = validateEntries(entries, resolvedOptions.signal);
  let declaredLaneCount = 0;
  const mappings: BlueprintImportProfileEndpointMapping[] = [];
  const diagnostics: BlueprintImportProfileMappingDiagnostic[] = [];
  const seenEndpoints = new Set<string>();

  for (let entryIndex = 0; entryIndex < validatedEntries.length; entryIndex += 1) {
    checkAborted(resolvedOptions.signal);
    const selected = validatedEntries[entryIndex]!;
    const profile = resolveEntityReplayProfile(selected.profile, context);
    let profileLaneCount = 0;
    for (const connector of profile.connectors) {
      checkAborted(resolvedOptions.signal);
      profileLaneCount += connector.lanes.length;
      if (
        !Number.isSafeInteger(profileLaneCount) ||
        profileLaneCount > resolvedOptions.maxEndpoints - declaredLaneCount
      ) {
        throw new RangeError(
          `Blueprint profile mapping lane limit exceeded (${resolvedOptions.maxEndpoints}).`,
        );
      }
    }
    declaredLaneCount += profileLaneCount;
    appendEndpointMappings(
      profile,
      selected.entityNumber,
      entryIndex,
      mappings,
      diagnostics,
      seenEndpoints,
      resolvedOptions.signal,
    );
  }

  if (diagnostics.length > 0) return blocked(diagnostics);
  mappings.sort((left, right) => {
    checkAborted(resolvedOptions.signal);
    return compareMappings(left, right);
  });
  checkAborted(resolvedOptions.signal);
  return Object.freeze({
    state: 'complete',
    mappings: Object.freeze(mappings.slice()),
    diagnostics: Object.freeze([]),
  });
}

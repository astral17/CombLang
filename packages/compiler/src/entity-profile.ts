import type {
  EntityConnectorDirection,
  EntityConnectorKey,
  EntityConnectorProfile,
  EntityConfigurationMode,
  EntityConfigurationRule,
  EntityDefaultReadProjection,
  EntityBehaviorKey,
  EntityEvidenceState,
  EntityFeatureKey,
  EntityFeatureProfile,
  EntityLaneEndpoint,
  EntityLaneKey,
  EntityLaneProfile,
  EntityNativeEndpoint,
  EntityProfile,
  EntityProfileId,
} from './entity.js';

type DataRecord = Record<string, unknown>;

export type EntityProfileErrorCode = 'EP1000' | 'EP1001' | 'EP1002' | 'EP1003';

export class EntityProfileError extends Error {
  readonly code: EntityProfileErrorCode;
  readonly path: string;

  constructor(code: EntityProfileErrorCode, path: string, message: string) {
    super(`${path}: ${message}`);
    this.name = 'EntityProfileError';
    this.code = code;
    this.path = path;
  }
}

function invalid(code: EntityProfileErrorCode, path: string, message: string): never {
  throw new EntityProfileError(code, path, message);
}

function stableIdentifier(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    invalid('EP1001', path, 'expected a non-empty identifier.');
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)) {
    invalid('EP1001', path, 'expected an ASCII identifier without whitespace or path separators.');
  }
  return value;
}

function exactKeys(record: DataRecord, allowed: readonly string[], path: string): void {
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(record)) {
    if (!allowedSet.has(key)) invalid('EP1000', `${path}.${key}`, 'unknown profile field.');
  }
}

function dataRecord(value: unknown, path: string): DataRecord {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    invalid('EP1001', path, 'expected a plain data record.');
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    invalid('EP1001', path, 'expected a plain object or null-prototype record.');
  }
  const output = Object.create(null) as DataRecord;
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string') {
      invalid('EP1000', `${path}[${String(key)}]`, 'symbol keys are not allowed.');
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
    if (!('value' in descriptor)) {
      invalid('EP1001', `${path}.${key}`, 'accessors are not allowed in a profile.');
    }
    output[key] = descriptor.value;
  }
  return output;
}

function dataArray(value: unknown, path: string): readonly unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    invalid('EP1001', path, 'expected a plain array.');
  }
  const lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length');
  if (lengthDescriptor === undefined || !('value' in lengthDescriptor)) {
    invalid('EP1001', `${path}.length`, 'array length must be data-only.');
  }
  const length = lengthDescriptor.value;
  if (typeof length !== 'number' || !Number.isSafeInteger(length) || length < 0) {
    invalid('EP1001', `${path}.length`, 'array length must be a non-negative safe integer.');
  }
  const entries: unknown[] = [];
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string') {
      invalid('EP1000', `${path}[${String(key)}]`, 'symbol keys are not allowed.');
    }
    if (key === 'length') continue;
    if (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= length) {
      invalid('EP1000', `${path}.${key}`, 'unknown array field.');
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
    if (!('value' in descriptor)) {
      invalid('EP1001', `${path}[${key}]`, 'accessors are not allowed in a profile.');
    }
  }
  for (let index = 0; index < length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (descriptor === undefined)
      invalid('EP1001', `${path}[${index}]`, 'array holes are not allowed.');
    if (!('value' in descriptor)) {
      invalid('EP1001', `${path}[${index}]`, 'accessors are not allowed in a profile.');
    }
    entries.push(descriptor.value);
  }
  return entries;
}

function stringValue(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    invalid('EP1001', path, 'expected a non-empty string.');
  }
  return value;
}

function booleanValue(value: unknown, path: string): boolean {
  if (typeof value !== 'boolean') invalid('EP1001', path, 'expected a boolean.');
  return value;
}

function positiveSafeInteger(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    invalid('EP1001', path, 'expected a positive safe integer.');
  }
  return value;
}

function color(value: unknown, path: string): 'red' | 'green' {
  if (value !== 'red' && value !== 'green') {
    invalid('EP1001', path, 'expected red or green.');
  }
  return value;
}

function direction(value: unknown, path: string): EntityConnectorDirection {
  if (value !== 'input' && value !== 'output' && value !== 'bidirectional') {
    invalid('EP1001', path, 'expected input, output, or bidirectional.');
  }
  return value;
}

function duplicate(values: readonly string[], path: string, label: string): void {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value))
      invalid('EP1000', path, `${label} contains duplicate ${JSON.stringify(value)}.`);
    seen.add(value);
  }
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function parseNativeEndpoint(value: unknown, path: string): EntityNativeEndpoint {
  const record = dataRecord(value, path);
  exactKeys(record, ['endpoint', 'nativeConnector'], path);
  const endpointRecord = dataRecord(record.endpoint, `${path}.endpoint`);
  exactKeys(endpointRecord, ['connector', 'lane', 'color'], `${path}.endpoint`);
  return {
    endpoint: {
      connector: stableIdentifier(
        endpointRecord.connector,
        `${path}.endpoint.connector`,
      ) as EntityConnectorKey,
      lane: stableIdentifier(endpointRecord.lane, `${path}.endpoint.lane`) as EntityLaneKey,
      color: color(endpointRecord.color, `${path}.endpoint.color`),
    },
    nativeConnector: positiveSafeInteger(record.nativeConnector, `${path}.nativeConnector`),
  };
}

function parseLane(
  value: unknown,
  path: string,
  connectorKey: EntityConnectorKey,
): EntityLaneProfile {
  const record = dataRecord(value, path);
  exactKeys(record, ['key', 'color', 'nativeEndpoint'], path);
  const key = stableIdentifier(record.key, `${path}.key`) as EntityLaneKey;
  const parsed: EntityLaneProfile = {
    key,
    color: color(record.color, `${path}.color`),
  };
  if ('nativeEndpoint' in record) {
    const nativeEndpoint = parseNativeEndpoint(record.nativeEndpoint, `${path}.nativeEndpoint`);
    if (
      nativeEndpoint.endpoint.connector !== connectorKey ||
      nativeEndpoint.endpoint.lane !== key ||
      nativeEndpoint.endpoint.color !== parsed.color
    ) {
      invalid(
        'EP1002',
        `${path}.nativeEndpoint.endpoint`,
        'native endpoint must identify this connector lane and color.',
      );
    }
    return { ...parsed, nativeEndpoint };
  }
  return parsed;
}

function parseConnector(value: unknown, path: string): EntityConnectorProfile {
  const record = dataRecord(value, path);
  exactKeys(record, ['key', 'direction', 'lanes'], path);
  const key = stableIdentifier(record.key, `${path}.key`) as EntityConnectorKey;
  const lanes = dataArray(record.lanes, `${path}.lanes`).map((laneValue, index) =>
    parseLane(laneValue, `${path}.lanes[${index}]`, key),
  );
  if (lanes.length === 0)
    invalid('EP1001', `${path}.lanes`, 'a connector needs at least one lane.');
  duplicate(
    lanes.map(({ key: laneKey }) => laneKey),
    `${path}.lanes`,
    'lane keys',
  );
  const nativeEndpoints = new Set<string>();
  for (const lane of lanes) {
    const nativeConnector = lane.nativeEndpoint?.nativeConnector;
    if (nativeConnector === undefined) continue;
    const endpointKey = `${nativeConnector}:${lane.color}`;
    if (nativeEndpoints.has(endpointKey)) {
      invalid('EP1000', `${path}.lanes`, `duplicate native endpoint ${endpointKey}.`);
    }
    nativeEndpoints.add(endpointKey);
  }
  return {
    key,
    direction: direction(record.direction, `${path}.direction`),
    lanes: Object.freeze([...lanes].sort((left, right) => compare(left.key, right.key))),
  };
}

function parseFeature(
  value: unknown,
  path: string,
  connectors: ReadonlyMap<EntityConnectorKey, EntityConnectorProfile>,
): EntityFeatureProfile {
  const record = dataRecord(value, path);
  exactKeys(record, ['key', 'connector', 'defaultLane', 'allowedLanes'], path);
  const key = stableIdentifier(record.key, `${path}.key`) as EntityFeatureKey;
  const connectorKey = stableIdentifier(
    record.connector,
    `${path}.connector`,
  ) as EntityConnectorKey;
  const connector = connectors.get(connectorKey);
  if (connector === undefined) invalid('EP1002', `${path}.connector`, 'unknown connector key.');
  const allowedLanes = dataArray(record.allowedLanes, `${path}.allowedLanes`).map(
    (laneValue, index) =>
      stableIdentifier(laneValue, `${path}.allowedLanes[${index}]`) as EntityLaneKey,
  );
  if (allowedLanes.length === 0) {
    invalid('EP1001', `${path}.allowedLanes`, 'a feature needs at least one allowed lane.');
  }
  duplicate(allowedLanes, `${path}.allowedLanes`, 'allowed lanes');
  const connectorLanes = new Set(connector.lanes.map(({ key: laneKey }) => laneKey));
  for (const laneKey of allowedLanes) {
    if (!connectorLanes.has(laneKey)) {
      invalid('EP1002', `${path}.allowedLanes`, `unknown lane ${JSON.stringify(laneKey)}.`);
    }
  }
  const defaultLane =
    'defaultLane' in record
      ? (stableIdentifier(record.defaultLane, `${path}.defaultLane`) as EntityLaneKey)
      : undefined;
  if (defaultLane !== undefined && !allowedLanes.includes(defaultLane)) {
    invalid('EP1002', `${path}.defaultLane`, 'default lane must be one of the allowed lanes.');
  }
  return {
    key,
    connector: connectorKey,
    ...(defaultLane === undefined ? {} : { defaultLane }),
    allowedLanes: Object.freeze([...allowedLanes].sort(compare)),
  };
}

function configurationMode(value: unknown, path: string): EntityConfigurationMode {
  if (value !== 'raw' && value !== 'typed') {
    invalid('EP1001', path, 'expected raw or typed configuration mode.');
  }
  return value;
}

function parseConfigurationRule(value: unknown, path: string): EntityConfigurationRule {
  const record = dataRecord(value, path);
  exactKeys(record, ['key', 'kind', 'modes', 'evidence'], path);
  const key = stableIdentifier(record.key, `${path}.key`) as EntityBehaviorKey;
  if (record.kind !== 'native-single-condition') {
    invalid('EP1001', `${path}.kind`, 'unsupported Entity configuration rule kind.');
  }
  const modes = dataArray(record.modes, `${path}.modes`).map((mode, index) =>
    configurationMode(mode, `${path}.modes[${index}]`),
  );
  if (modes.length === 0) invalid('EP1001', `${path}.modes`, 'a rule needs one mode.');
  duplicate(modes, `${path}.modes`, 'configuration modes');
  return {
    key,
    kind: 'native-single-condition',
    modes: Object.freeze([...modes].sort(compare)),
    evidence: parseEvidence(record.evidence, `${path}.evidence`),
  };
}

function parseDefaultReadProjection(
  value: unknown,
  path: string,
  features: ReadonlyMap<EntityFeatureKey, EntityFeatureProfile>,
  connectors: ReadonlyMap<EntityConnectorKey, EntityConnectorProfile>,
): EntityDefaultReadProjection | null {
  if (value === null) return null;
  const record = dataRecord(value, path);
  exactKeys(record, ['feature', 'connector', 'lane'], path);
  const feature = stableIdentifier(record.feature, `${path}.feature`) as EntityFeatureKey;
  const connector = stableIdentifier(record.connector, `${path}.connector`) as EntityConnectorKey;
  const lane = stableIdentifier(record.lane, `${path}.lane`) as EntityLaneKey;
  const featureProfile = features.get(feature);
  if (featureProfile === undefined) invalid('EP1002', `${path}.feature`, 'unknown feature key.');
  if (featureProfile.connector !== connector) {
    invalid('EP1002', `${path}.connector`, 'default feature and connector do not match.');
  }
  if (!featureProfile.allowedLanes.includes(lane)) {
    invalid('EP1002', `${path}.lane`, 'default lane is not allowed by the feature.');
  }
  const connectorProfile = connectors.get(connector);
  if (connectorProfile === undefined)
    invalid('EP1002', `${path}.connector`, 'unknown connector key.');
  if (!connectorProfile.lanes.some((candidate) => candidate.key === lane)) {
    invalid('EP1002', `${path}.lane`, 'default lane is not declared by the connector.');
  }
  return { feature, connector, lane };
}

function parseEvidence(value: unknown, path: string): EntityEvidenceState {
  const record = dataRecord(value, path);
  const status = stringValue(record.status, `${path}.status`);
  if (status === 'unknown') {
    exactKeys(record, ['status'], path);
    return { status: 'unknown' };
  }
  if (status === 'unverified') {
    exactKeys(record, ['status', 'value'], path);
    return { status: 'unverified', value: booleanValue(record.value, `${path}.value`) };
  }
  if (status === 'verified') {
    exactKeys(record, ['status', 'value', 'sourceIds'], path);
    const sourceIds = dataArray(record.sourceIds, `${path}.sourceIds`).map((source, index) =>
      stableIdentifier(source, `${path}.sourceIds[${index}]`),
    );
    if (sourceIds.length === 0)
      invalid('EP1003', `${path}.sourceIds`, 'verified evidence needs a source.');
    duplicate(sourceIds, `${path}.sourceIds`, 'source IDs');
    return {
      status: 'verified',
      value: booleanValue(record.value, `${path}.value`),
      sourceIds: Object.freeze([...sourceIds].sort(compare)),
    };
  }
  invalid('EP1001', `${path}.status`, 'expected unknown, unverified, or verified.');
}

/** Validates and canonically freezes a compiler-owned Entity capability profile. */
export function canonicalizeEntityProfile(value: unknown): EntityProfile {
  const record = dataRecord(value, '$');
  exactKeys(
    record,
    ['ref', 'connectors', 'features', 'configurationRules', 'defaultReadProjection', 'synthetic'],
    '$',
  );

  const ref = dataRecord(record.ref, '$.ref');
  exactKeys(ref, ['prototypeKey', 'database', 'profileId'], '$.ref');
  const database = dataRecord(ref.database, '$.ref.database');
  exactKeys(database, ['schemaVersion', 'identity'], '$.ref.database');
  const parsedRef = {
    prototypeKey: stableIdentifier(ref.prototypeKey, '$.ref.prototypeKey'),
    database: {
      schemaVersion: positiveSafeInteger(database.schemaVersion, '$.ref.database.schemaVersion'),
      identity: stableIdentifier(database.identity, '$.ref.database.identity'),
    },
    profileId: stableIdentifier(ref.profileId, '$.ref.profileId') as EntityProfileId,
  };

  const connectors = dataArray(record.connectors, '$.connectors').map((connectorValue, index) =>
    parseConnector(connectorValue, `$.connectors[${index}]`),
  );
  duplicate(
    connectors.map(({ key }) => key),
    '$.connectors',
    'connector keys',
  );
  const nativeEndpoints = new Set<string>();
  connectors.forEach((connector, connectorIndex) => {
    connector.lanes.forEach((lane, laneIndex) => {
      const nativeConnector = lane.nativeEndpoint?.nativeConnector;
      if (nativeConnector === undefined) return;
      const endpointKey = `${nativeConnector}:${lane.color}`;
      if (nativeEndpoints.has(endpointKey)) {
        invalid(
          'EP1000',
          `$.connectors[${connectorIndex}].lanes[${laneIndex}].nativeEndpoint`,
          `duplicate native endpoint ${endpointKey} across the profile.`,
        );
      }
      nativeEndpoints.add(endpointKey);
    });
  });
  const connectorMap = new Map(connectors.map((connector) => [connector.key, connector]));
  const features = dataArray(record.features, '$.features').map((featureValue, index) =>
    parseFeature(featureValue, `$.features[${index}]`, connectorMap),
  );
  duplicate(
    features.map(({ key }) => key),
    '$.features',
    'feature keys',
  );
  const synthetic = booleanValue(record.synthetic, '$.synthetic');
  const configurationRules = dataArray(record.configurationRules, '$.configurationRules').map(
    (rule, index) => parseConfigurationRule(rule, `$.configurationRules[${index}]`),
  );
  duplicate(
    configurationRules.map(({ key }) => key),
    '$.configurationRules',
    'configuration rule keys',
  );
  if (synthetic) {
    const verifiedIndex = configurationRules.findIndex(
      ({ evidence }) => evidence.status === 'verified',
    );
    if (verifiedIndex >= 0) {
      invalid(
        'EP1003',
        `$.configurationRules[${verifiedIndex}].evidence.status`,
        'synthetic profiles cannot claim verified capability evidence.',
      );
    }
  }
  const featureMap = new Map(features.map((feature) => [feature.key, feature]));
  const defaultReadProjection = parseDefaultReadProjection(
    record.defaultReadProjection,
    '$.defaultReadProjection',
    featureMap,
    connectorMap,
  );

  return deepFreeze({
    ref: parsedRef,
    connectors: Object.freeze([...connectors].sort((left, right) => compare(left.key, right.key))),
    features: Object.freeze([...features].sort((left, right) => compare(left.key, right.key))),
    configurationRules: Object.freeze(
      [...configurationRules].sort((left, right) => compare(left.key, right.key)),
    ),
    defaultReadProjection,
    synthetic,
  });
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    if (!Object.isFrozen(value)) Object.freeze(value);
  }
  return value;
}

/** Returns a stable JSON representation useful for cache keys and regression fixtures. */
export function canonicalEntityProfileJson(value: unknown): string {
  return JSON.stringify(canonicalizeEntityProfile(value));
}

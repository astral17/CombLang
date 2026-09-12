import { Signal, type SignalId, type SignalType } from '@comblang/factorio';
import type { Diagnostic, SourceSpan } from '@comblang/shared';

import {
  canonicalizeEntityNativeSingleCondition,
  EntityConfigurationError,
} from './entity-configuration.js';
import { canonicalizeEntityRawJson, EntityRawJsonError } from './entity-raw.js';
import type {
  EntityPhysicalConfiguration,
  EntityPhysicalRecord,
  EntityPhysicalTypedConfiguration,
  EntityBehaviorKey,
  EntityConnectorKey,
  EntityFeatureKey,
  EntityLaneKey,
  EntityReplayContextRef,
  EntityProfileRef,
  EntityNativeComparator,
  NativeCircuitIrV3,
  DirectElaborationPlanV3,
} from './entity.js';
import type {
  ArithmeticOperation,
  CircuitProducerNode,
  LogicalArithmeticOperand,
  LogicalArithmeticOutput,
  LogicalConditionLeft,
  LogicalDeciderCondition,
  LogicalDeciderOutput,
  LogicalDeciderOutputSignal,
  LogicalNetworkRef,
  LogicalScalarOperand,
  Provenance,
  ResolvedCircuitNetworkNode,
  CircuitColor,
} from './ir.js';

export const resolvedSourceCircuitFormat = 'comblang-resolved-source-circuit' as const;
export const resolvedSourceCircuitVersion = 1 as const;

/** Cloneable physical output of one already-authorized source compilation. */
export interface ResolvedSourceCircuit {
  readonly format: typeof resolvedSourceCircuitFormat;
  readonly version: typeof resolvedSourceCircuitVersion;
  /** Accidental/stale-response correlation only; it grants no replay authority. */
  readonly planFingerprint: string;
  readonly ir: NativeCircuitIrV3;
}

export class ResolvedSourceCircuitError extends Error {
  readonly code = 'RSC1001';

  constructor(
    readonly path: string,
    readonly detail: string,
  ) {
    super(`${path}: ${detail}`);
    this.name = 'ResolvedSourceCircuitError';
  }
}

export interface ResolvedSourceCircuitValidationResult {
  readonly value?: ResolvedSourceCircuit;
  readonly diagnostics: readonly Diagnostic[];
}

type DataRecord = Record<string, unknown>;
type Fail = (path: string, detail: string) => never;

const arithmeticOperations = new Set<ArithmeticOperation>([
  'add',
  'subtract',
  'multiply',
  'divide',
  'modulo',
  'power',
  'left-shift',
  'right-shift',
  'bit-and',
  'bit-or',
  'bit-xor',
]);
const comparators = new Set<EntityNativeComparator>(['>', '<', '=', '>=', '<=', '!=']);
const identifierPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const maximumArrayLength = 100_000;
const maximumConditionDepth = 128;
const planFingerprintPattern = /^v1-[0-9a-f]{16}$/;

function stableJson(value: unknown): string {
  if (value === null) return 'null';
  if (value === undefined) return 'null';
  if (typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number') {
    const encoded = JSON.stringify(value);
    if (encoded === undefined) throw new TypeError('Cannot fingerprint a non-JSON value.');
    return encoded;
  }
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
      .join(',')}}`;
  }
  throw new TypeError('Cannot fingerprint a non-JSON value.');
}

/**
 * Computes a synchronous, deterministic correlation identity for a canonical
 * v3 plan. This is stale-response detection only and grants no authority.
 */
export function resolvedSourceCircuitPlanFingerprint(plan: DirectElaborationPlanV3): string {
  const serialized = stableJson(plan);
  let hash = 0xcbf29ce484222325n;
  const mask = 0xffffffffffffffffn;
  for (let index = 0; index < serialized.length; index += 1) {
    hash ^= BigInt(serialized.charCodeAt(index));
    hash = (hash * 0x100000001b3n) & mask;
  }
  return `v1-${hash.toString(16).padStart(16, '0')}`;
}

function invalid(path: string, detail: string): never {
  throw new ResolvedSourceCircuitError(path, detail);
}

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value;
  for (const key of Reflect.ownKeys(value)) {
    deepFreeze((value as Record<PropertyKey, unknown>)[key]);
  }
  return Object.isFrozen(value) ? value : Object.freeze(value);
}

function dataRecord(value: unknown, path: string): DataRecord {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    invalid(path, 'expected a plain data record.');
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    invalid(path, 'expected a plain object or null-prototype record.');
  }
  const record = Object.create(null) as DataRecord;
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string') invalid(`${path}[${String(key)}]`, 'symbol keys are not allowed.');
    const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
    if (!('value' in descriptor)) invalid(`${path}.${key}`, 'accessors are not allowed.');
    record[key] = descriptor.value;
  }
  return record;
}

function exactKeys(record: DataRecord, allowed: readonly string[], path: string): void {
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(record)) {
    if (!allowedSet.has(key)) invalid(`${path}.${key}`, 'unknown resolved circuit field.');
  }
}

function dataArray(value: unknown, path: string): readonly unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    invalid(path, 'expected a plain array.');
  }
  if (value.length > maximumArrayLength) {
    invalid(path, `array exceeds the ${maximumArrayLength} item limit.`);
  }
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string') invalid(`${path}[${String(key)}]`, 'symbol keys are not allowed.');
    if (key === 'length') continue;
    if (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= value.length) {
      invalid(`${path}.${key}`, 'unknown array field.');
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
    if (!('value' in descriptor)) invalid(`${path}[${key}]`, 'accessors are not allowed.');
  }
  const output: unknown[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (descriptor === undefined) invalid(`${path}[${index}]`, 'array holes are not allowed.');
    if (!('value' in descriptor)) invalid(`${path}[${index}]`, 'accessors are not allowed.');
    output.push(descriptor.value);
  }
  return output;
}

function text(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.length === 0)
    invalid(path, 'expected a non-empty string.');
  return value;
}

function identifier(value: unknown, path: string): string {
  if (typeof value !== 'string' || !identifierPattern.test(value)) {
    invalid(path, 'expected a bounded ASCII identifier.');
  }
  return value;
}

function finite(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value))
    invalid(path, 'expected a finite number.');
  return value;
}

function safeInteger(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    invalid(path, 'expected a safe integer.');
  }
  return value;
}

function int32(value: unknown, path: string): number {
  const number = safeInteger(value, path);
  if (number < -2_147_483_648 || number > 2_147_483_647) {
    invalid(path, 'expected a signed int32 value.');
  }
  return number;
}

function positive(value: unknown, path: string): number {
  const number = safeInteger(value, path);
  if (number < 1) invalid(path, 'expected a positive safe integer.');
  return number;
}

function nonNegative(value: unknown, path: string): number {
  const number = safeInteger(value, path);
  if (number < 0) invalid(path, 'expected a non-negative safe integer.');
  return number;
}

function sourceSpan(value: unknown, path: string): SourceSpan {
  const record = dataRecord(value, path);
  exactKeys(record, ['fileId', 'start', 'end'], path);
  const start = safeInteger(record.start, `${path}.start`);
  const end = safeInteger(record.end, `${path}.end`);
  if (start < 0 || end < start) invalid(path, 'source span must be a valid half-open range.');
  return Object.freeze({
    fileId: text(record.fileId, `${path}.fileId`) as SourceSpan['fileId'],
    start,
    end,
  });
}

function stringArray(value: unknown, path: string): readonly string[] {
  return Object.freeze(
    dataArray(value, path).map((entry, index) => text(entry, `${path}[${index}]`)),
  );
}

function provenance(value: unknown, path: string): Provenance {
  const record = dataRecord(value, path);
  exactKeys(record, ['source', 'instancePath', 'expansionStack'], path);
  return Object.freeze({
    ...(record.source === undefined ? {} : { source: sourceSpan(record.source, `${path}.source`) }),
    instancePath: stringArray(record.instancePath, `${path}.instancePath`),
    expansionStack: stringArray(record.expansionStack, `${path}.expansionStack`),
  });
}

function signal(value: unknown, path: string): SignalId {
  const record = dataRecord(value, path);
  exactKeys(record, ['type', 'name', 'quality'], path);
  const name = text(record.name, `${path}.name`);
  const type = record.type;
  if (typeof type !== 'string') invalid(`${path}.type`, 'expected a valid Signal type.');
  const quality =
    record.quality === undefined ? undefined : text(record.quality, `${path}.quality`);
  try {
    return Signal(type as SignalType, name, quality);
  } catch (error) {
    invalid(path, error instanceof Error ? error.message : 'invalid Signal ID.');
  }
}

function networkRef(
  value: unknown,
  path: string,
  networkIds: ReadonlySet<string>,
  additionalKeys: readonly string[] = [],
): LogicalNetworkRef {
  const record = dataRecord(value, path);
  if (record.refKind === 'single') {
    exactKeys(record, ['refKind', 'network', ...additionalKeys], path);
    const network = text(record.network, `${path}.network`);
    if (!networkIds.has(network)) invalid(`${path}.network`, 'unknown Network ID.');
    return { refKind: 'single', network: network as never };
  }
  if (record.refKind === 'pair') {
    exactKeys(record, ['refKind', 'networks', ...additionalKeys], path);
    const networks = dataArray(record.networks, `${path}.networks`);
    if (networks.length !== 2) invalid(`${path}.networks`, 'a Network pair must contain two IDs.');
    const first = text(networks[0], `${path}.networks[0]`);
    const second = text(networks[1], `${path}.networks[1]`);
    if (first === second) invalid(`${path}.networks`, 'a Network pair needs two distinct IDs.');
    if (!networkIds.has(first)) invalid(`${path}.networks[0]`, 'unknown Network ID.');
    if (!networkIds.has(second)) invalid(`${path}.networks[1]`, 'unknown Network ID.');
    return { refKind: 'pair', networks: [first, second] as never };
  }
  invalid(`${path}.refKind`, 'unknown Network reference tag.');
}

function arithmeticOperand(
  value: unknown,
  path: string,
  networkIds: ReadonlySet<string>,
): LogicalArithmeticOperand {
  const record = dataRecord(value, path);
  if (record.kind === 'constant') {
    exactKeys(record, ['kind', 'value'], path);
    return { kind: 'constant', value: int32(record.value, `${path}.value`) };
  }
  if (record.kind === 'signal') {
    exactKeys(record, ['kind', 'signal', 'refKind', 'network', 'networks'], path);
    return {
      kind: 'signal',
      signal: signal(record.signal, `${path}.signal`),
      ...networkRef(record, path, networkIds, ['kind', 'signal']),
    } as LogicalArithmeticOperand;
  }
  if (record.kind === 'each') {
    exactKeys(record, ['kind', 'refKind', 'network', 'networks'], path);
    return {
      kind: 'each',
      ...networkRef(record, path, networkIds, ['kind']),
    } as LogicalArithmeticOperand;
  }
  invalid(`${path}.kind`, 'unknown arithmetic operand tag.');
}

function arithmeticOutput(value: unknown, path: string): LogicalArithmeticOutput {
  const record = dataRecord(value, path);
  if (record.kind === 'each') {
    exactKeys(record, ['kind'], path);
    return { kind: 'each' };
  }
  if (record.kind === 'signal') {
    exactKeys(record, ['kind', 'signal'], path);
    return { kind: 'signal', signal: signal(record.signal, `${path}.signal`) };
  }
  invalid(`${path}.kind`, 'unknown arithmetic output tag.');
}

function conditionLeft(
  value: unknown,
  path: string,
  networkIds: ReadonlySet<string>,
): LogicalConditionLeft {
  const record = dataRecord(value, path);
  if (record.kind === 'signal') {
    exactKeys(record, ['kind', 'signal', 'refKind', 'network', 'networks'], path);
    return {
      kind: 'signal',
      signal: signal(record.signal, `${path}.signal`),
      ...networkRef(record, path, networkIds, ['kind', 'signal']),
    } as LogicalConditionLeft;
  }
  if (record.kind === 'wildcard') {
    exactKeys(record, ['kind', 'value', 'refKind', 'network', 'networks'], path);
    if (record.value !== 'each' && record.value !== 'anything' && record.value !== 'everything') {
      invalid(`${path}.value`, 'unknown condition wildcard.');
    }
    return {
      kind: 'wildcard',
      value: record.value,
      ...networkRef(record, path, networkIds, ['kind', 'value']),
    } as LogicalConditionLeft;
  }
  invalid(`${path}.kind`, 'unknown condition left operand tag.');
}

function scalarOperand(
  value: unknown,
  path: string,
  networkIds: ReadonlySet<string>,
): LogicalScalarOperand {
  const record = dataRecord(value, path);
  if (record.kind === 'constant') {
    exactKeys(record, ['kind', 'value'], path);
    return { kind: 'constant', value: int32(record.value, `${path}.value`) };
  }
  if (record.kind === 'signal') {
    exactKeys(record, ['kind', 'signal', 'refKind', 'network', 'networks'], path);
    return {
      kind: 'signal',
      signal: signal(record.signal, `${path}.signal`),
      ...networkRef(record, path, networkIds, ['kind', 'signal']),
    } as LogicalScalarOperand;
  }
  invalid(`${path}.kind`, 'unknown scalar operand tag.');
}

function deciderCondition(
  value: unknown,
  path: string,
  networkIds: ReadonlySet<string>,
  depth = 0,
): LogicalDeciderCondition {
  if (depth > maximumConditionDepth) {
    invalid(path, `condition nesting exceeds the ${maximumConditionDepth} level limit.`);
  }
  const record = dataRecord(value, path);
  if (record.kind === 'and' || record.kind === 'or') {
    exactKeys(record, ['kind', 'conditions'], path);
    const conditions = dataArray(record.conditions, `${path}.conditions`).map((entry, index) =>
      deciderCondition(entry, `${path}.conditions[${index}]`, networkIds, depth + 1),
    );
    return Object.freeze({ kind: record.kind, conditions: Object.freeze(conditions) });
  }
  if (record.kind === 'compare') {
    exactKeys(record, ['kind', 'left', 'comparator', 'right'], path);
    if (
      typeof record.comparator !== 'string' ||
      !comparators.has(record.comparator as EntityNativeComparator)
    ) {
      invalid(`${path}.comparator`, 'unknown Decider comparator.');
    }
    return Object.freeze({
      kind: 'compare',
      left: conditionLeft(record.left, `${path}.left`, networkIds),
      comparator: record.comparator as EntityNativeComparator,
      right: scalarOperand(record.right, `${path}.right`, networkIds),
    });
  }
  invalid(`${path}.kind`, 'unknown Decider condition tag.');
}

function outputSignal(value: unknown, path: string): LogicalDeciderOutputSignal {
  const record = dataRecord(value, path);
  if (record.kind === 'signal') {
    exactKeys(record, ['kind', 'signal'], path);
    return { kind: 'signal', signal: signal(record.signal, `${path}.signal`) };
  }
  if (record.kind === 'wildcard') {
    exactKeys(record, ['kind', 'value'], path);
    if (record.value !== 'each' && record.value !== 'anything' && record.value !== 'everything') {
      invalid(`${path}.value`, 'unknown Decider output wildcard.');
    }
    return { kind: 'wildcard', value: record.value };
  }
  invalid(`${path}.kind`, 'unknown Decider output signal tag.');
}

function deciderOutput(
  value: unknown,
  path: string,
  networkIds: ReadonlySet<string>,
): LogicalDeciderOutput {
  const record = dataRecord(value, path);
  if (record.mode !== 'copy' && record.mode !== 'constant') {
    invalid(`${path}.mode`, 'unknown Decider output mode.');
  }
  exactKeys(record, ['mode', 'signal', 'value', 'input'], path);
  if (Object.hasOwn(record, 'input') && record.input === undefined) {
    invalid(`${path}.input`, 'optional Decider output input must be omitted when unused.');
  }
  const input =
    record.input === undefined ? undefined : networkRef(record.input, `${path}.input`, networkIds);
  if (record.mode === 'constant') {
    return {
      mode: 'constant',
      signal: outputSignal(record.signal, `${path}.signal`),
      value: int32(record.value, `${path}.value`),
      ...(input === undefined ? {} : { input }),
    } as LogicalDeciderOutput;
  }
  if (Object.hasOwn(record, 'value'))
    invalid(`${path}.value`, 'copy output must not contain a value.');
  return {
    mode: 'copy',
    signal: outputSignal(record.signal, `${path}.signal`),
    ...(input === undefined ? {} : { input }),
  } as LogicalDeciderOutput;
}

function placement(value: unknown, path: string) {
  const record = dataRecord(value, path);
  exactKeys(record, ['x', 'y', 'direction'], path);
  const direction = record.direction;
  if (
    direction !== undefined &&
    (typeof direction !== 'number' ||
      !Number.isInteger(direction) ||
      direction < 0 ||
      direction > 15)
  ) {
    invalid(`${path}.direction`, 'direction must be an integer from 0 through 15.');
  }
  return Object.freeze({
    x: finite(record.x, `${path}.x`),
    y: finite(record.y, `${path}.y`),
    ...(direction === undefined ? {} : { direction }),
  });
}

function context(value: unknown, path: string): EntityReplayContextRef {
  const record = dataRecord(value, path);
  exactKeys(record, ['database', 'profileSetIdentity', 'evidenceIdentity', 'policyIdentity'], path);
  const database = dataRecord(record.database, `${path}.database`);
  exactKeys(database, ['schemaVersion', 'identity'], `${path}.database`);
  return Object.freeze({
    database: Object.freeze({
      schemaVersion: positive(database.schemaVersion, `${path}.database.schemaVersion`),
      identity: text(database.identity, `${path}.database.identity`),
    }),
    profileSetIdentity: text(
      record.profileSetIdentity,
      `${path}.profileSetIdentity`,
    ) as EntityReplayContextRef['profileSetIdentity'],
    evidenceIdentity: text(record.evidenceIdentity, `${path}.evidenceIdentity`),
    policyIdentity: text(record.policyIdentity, `${path}.policyIdentity`),
  });
}

function profile(
  value: unknown,
  path: string,
  database: { schemaVersion: number; identity: string },
): EntityProfileRef {
  const record = dataRecord(value, path);
  exactKeys(record, ['prototypeKey', 'database', 'profileId'], path);
  const profileDatabase = dataRecord(record.database, `${path}.database`);
  exactKeys(profileDatabase, ['schemaVersion', 'identity'], `${path}.database`);
  const schemaVersion = positive(profileDatabase.schemaVersion, `${path}.database.schemaVersion`);
  const identity = text(profileDatabase.identity, `${path}.database.identity`);
  if (schemaVersion !== database.schemaVersion || identity !== database.identity) {
    invalid(
      `${path}.database`,
      'Entity profile database does not match the resolved circuit context.',
    );
  }
  return Object.freeze({
    prototypeKey: text(record.prototypeKey, `${path}.prototypeKey`),
    database: Object.freeze({ schemaVersion, identity }),
    profileId: text(record.profileId, `${path}.profileId`) as EntityProfileRef['profileId'],
  });
}

function physicalConfiguration(value: unknown, path: string): EntityPhysicalConfiguration {
  const record = dataRecord(value, path);
  if (record.mode === 'raw') {
    exactKeys(record, ['mode', 'payload'], path);
    try {
      return Object.freeze({ mode: 'raw', payload: canonicalizeEntityRawJson(record.payload) });
    } catch (error) {
      if (error instanceof EntityRawJsonError)
        invalid(`${path}${error.path.slice(1)}`, error.message);
      throw error;
    }
  }
  if (record.mode !== 'typed') invalid(`${path}.mode`, 'expected raw or typed configuration.');
  if ('payload' in record) {
    exactKeys(record, ['mode', 'payload'], path);
    try {
      return Object.freeze({ mode: 'typed', payload: canonicalizeEntityRawJson(record.payload) });
    } catch (error) {
      if (error instanceof EntityRawJsonError)
        invalid(`${path}${error.path.slice(1)}`, error.message);
      throw error;
    }
  }
  exactKeys(
    record,
    ['mode', 'rule', 'feature', 'nativeField', 'connector', 'lanes', 'laneMask', 'condition'],
    path,
  );
  if (record.nativeField !== 'control_behavior.circuit_condition') {
    invalid(`${path}.nativeField`, 'unsupported native Entity configuration field.');
  }
  const lanes = dataArray(record.lanes, `${path}.lanes`).map((lane, index) =>
    identifier(lane, `${path}.lanes[${index}]`),
  );
  if (lanes.length === 0) invalid(`${path}.lanes`, 'at least one lane must be selected.');
  if (new Set(lanes).size !== lanes.length) invalid(`${path}.lanes`, 'duplicate lane.');
  const laneMask = dataRecord(record.laneMask, `${path}.laneMask`);
  exactKeys(laneMask, ['red', 'green'], `${path}.laneMask`);
  if (typeof laneMask.red !== 'boolean' || typeof laneMask.green !== 'boolean') {
    invalid(`${path}.laneMask`, 'lane mask values must be boolean.');
  }
  if (!laneMask.red && !laneMask.green)
    invalid(`${path}.laneMask`, 'at least one color is required.');
  let condition;
  try {
    condition = canonicalizeEntityNativeSingleCondition(record.condition, `${path}.condition`);
  } catch (error) {
    if (error instanceof EntityConfigurationError) invalid(error.path, error.detail);
    throw error;
  }
  return Object.freeze({
    mode: 'typed',
    rule: identifier(record.rule, `${path}.rule`) as EntityPhysicalTypedConfiguration['rule'],
    feature: identifier(
      record.feature,
      `${path}.feature`,
    ) as EntityPhysicalTypedConfiguration['feature'],
    nativeField: 'control_behavior.circuit_condition',
    connector: identifier(
      record.connector,
      `${path}.connector`,
    ) as EntityPhysicalTypedConfiguration['connector'],
    lanes: Object.freeze([...lanes] as EntityLaneKey[]),
    laneMask: Object.freeze({ red: laneMask.red, green: laneMask.green }),
    condition,
  });
}

function endpoint(value: unknown, path: string) {
  const record = dataRecord(value, path);
  exactKeys(record, ['connector', 'lane', 'color'], path);
  if (record.color !== 'red' && record.color !== 'green')
    invalid(`${path}.color`, 'expected red or green.');
  return Object.freeze({
    connector: identifier(record.connector, `${path}.connector`) as EntityConnectorKey,
    lane: identifier(record.lane, `${path}.lane`) as EntityLaneKey,
    color: record.color,
  });
}

function binding(value: unknown, path: string, networkIds: ReadonlySet<string>) {
  const record = dataRecord(value, path);
  exactKeys(
    record,
    ['endpoint', 'network', 'nativeConnector', 'generation', 'direction', 'provenance'],
    path,
  );
  const network =
    record.network === undefined ? undefined : text(record.network, `${path}.network`);
  if (network !== undefined && !networkIds.has(network))
    invalid(`${path}.network`, 'unknown Network ID.');
  const nativeConnector = record.nativeConnector;
  if (network === undefined) {
    if (nativeConnector !== undefined)
      invalid(`${path}.nativeConnector`, 'unbound connector cannot have a native connector.');
  } else {
    if (
      typeof nativeConnector !== 'number' ||
      !Number.isSafeInteger(nativeConnector) ||
      nativeConnector < 1
    ) {
      invalid(
        `${path}.nativeConnector`,
        'bound connector needs a positive native connector ordinal.',
      );
    }
    if (!Number.isSafeInteger(nativeConnector * 2)) {
      invalid(
        `${path}.nativeConnector`,
        'native connector ordinal is too large for blueprint color mapping.',
      );
    }
  }
  if (record.direction !== 'input' && record.direction !== 'output')
    invalid(`${path}.direction`, 'expected input or output.');
  const bindingProvenance = dataRecord(record.provenance, `${path}.provenance`);
  exactKeys(
    bindingProvenance,
    ['source', 'instancePath', 'operationOrdinal'],
    `${path}.provenance`,
  );
  return Object.freeze({
    endpoint: endpoint(record.endpoint, `${path}.endpoint`),
    ...(network === undefined ? {} : { network: network as never }),
    ...(nativeConnector === undefined ? {} : { nativeConnector }),
    generation: nonNegative(record.generation, `${path}.generation`),
    direction: record.direction,
    provenance: Object.freeze({
      source: sourceSpan(bindingProvenance.source, `${path}.provenance.source`),
      instancePath: stringArray(bindingProvenance.instancePath, `${path}.provenance.instancePath`),
      operationOrdinal: positive(
        bindingProvenance.operationOrdinal,
        `${path}.provenance.operationOrdinal`,
      ),
    }),
  });
}

function entity(
  value: unknown,
  path: string,
  contextDatabase: { schemaVersion: number; identity: string },
  networkIds: ReadonlySet<string>,
): EntityPhysicalRecord {
  const record = dataRecord(value, path);
  exactKeys(
    record,
    [
      'id',
      'profile',
      'prototypeName',
      'configuration',
      'connectorBindings',
      'placement',
      'provenance',
      'ordinal',
    ],
    path,
  );
  const profileRef = profile(record.profile, `${path}.profile`, contextDatabase);
  const prototypeName = text(record.prototypeName, `${path}.prototypeName`);
  if (profileRef.prototypeKey !== `entity:${prototypeName}`) {
    invalid(`${path}.prototypeName`, 'prototype name does not match the profile key.');
  }
  const bindings = dataArray(record.connectorBindings, `${path}.connectorBindings`).map(
    (entry, index) => binding(entry, `${path}.connectorBindings[${index}]`, networkIds),
  );
  const endpointKeys = bindings.map(
    ({ endpoint: item }) => `${item.connector}/${item.lane}/${item.color}`,
  );
  if (new Set(endpointKeys).size !== endpointKeys.length)
    invalid(`${path}.connectorBindings`, 'connector endpoint is repeated.');
  return Object.freeze({
    id: text(record.id, `${path}.id`) as EntityPhysicalRecord['id'],
    profile: profileRef,
    prototypeName,
    ...(record.configuration === undefined
      ? {}
      : { configuration: physicalConfiguration(record.configuration, `${path}.configuration`) }),
    connectorBindings: Object.freeze(bindings),
    ...(record.placement === undefined
      ? {}
      : { placement: placement(record.placement, `${path}.placement`) }),
    provenance: (() => {
      const parsed = dataRecord(record.provenance, `${path}.provenance`);
      exactKeys(
        parsed,
        ['source', 'instancePath', 'expansionStack', 'creationRevision'],
        `${path}.provenance`,
      );
      return Object.freeze({
        source: sourceSpan(parsed.source, `${path}.provenance.source`),
        instancePath: stringArray(parsed.instancePath, `${path}.provenance.instancePath`),
        expansionStack: stringArray(parsed.expansionStack, `${path}.provenance.expansionStack`),
        creationRevision: positive(parsed.creationRevision, `${path}.provenance.creationRevision`),
      });
    })(),
    ordinal: positive(record.ordinal, `${path}.ordinal`),
  });
}

function producer(
  value: unknown,
  path: string,
  networkIds: ReadonlySet<string>,
): CircuitProducerNode {
  const record = dataRecord(value, path);
  exactKeys(record, ['id', 'kind', 'config', 'destinations', 'provenance', 'placement'], path);
  const destinations = dataArray(record.destinations, `${path}.destinations`).map(
    (destination, index) => {
      const id = text(destination, `${path}.destinations[${index}]`);
      if (!networkIds.has(id)) invalid(`${path}.destinations[${index}]`, 'unknown Network ID.');
      return id as never;
    },
  );
  if (new Set(destinations).size !== destinations.length)
    invalid(`${path}.destinations`, 'producer destination is repeated.');
  const common = {
    id: text(record.id, `${path}.id`) as never,
    destinations: Object.freeze(destinations),
    provenance: provenance(record.provenance, `${path}.provenance`),
    ...(record.placement === undefined
      ? {}
      : { placement: placement(record.placement, `${path}.placement`) }),
  };
  if (record.kind === 'arithmetic') {
    const config = dataRecord(record.config, `${path}.config`);
    exactKeys(config, ['left', 'operation', 'right', 'output'], `${path}.config`);
    if (
      typeof config.operation !== 'string' ||
      !arithmeticOperations.has(config.operation as ArithmeticOperation)
    ) {
      invalid(`${path}.config.operation`, 'unknown arithmetic operation.');
    }
    return {
      ...common,
      kind: 'arithmetic',
      config: {
        left: arithmeticOperand(config.left, `${path}.config.left`, networkIds),
        operation: config.operation as ArithmeticOperation,
        right: arithmeticOperand(config.right, `${path}.config.right`, networkIds),
        output: arithmeticOutput(config.output, `${path}.config.output`),
      },
    };
  }
  if (record.kind === 'constant') {
    const config = dataRecord(record.config, `${path}.config`);
    exactKeys(config, ['outputs'], `${path}.config`);
    const outputs = dataArray(config.outputs, `${path}.config.outputs`).map((entry, index) => {
      const output = dataRecord(entry, `${path}.config.outputs[${index}]`);
      exactKeys(output, ['signal', 'value'], `${path}.config.outputs[${index}]`);
      return Object.freeze({
        signal: signal(output.signal, `${path}.config.outputs[${index}].signal`),
        value: int32(output.value, `${path}.config.outputs[${index}].value`),
      });
    });
    return { ...common, kind: 'constant', config: { outputs: Object.freeze(outputs) } };
  }
  if (record.kind === 'decider') {
    const config = dataRecord(record.config, `${path}.config`);
    exactKeys(config, ['condition', 'outputs', 'elseOutputs'], `${path}.config`);
    const parseOutputs = (value: unknown, outputPath: string) =>
      Object.freeze(
        dataArray(value, outputPath).map((entry, index) =>
          deciderOutput(entry, `${outputPath}[${index}]`, networkIds),
        ),
      );
    if (config.elseOutputs !== undefined && !Array.isArray(config.elseOutputs)) {
      invalid(`${path}.config.elseOutputs`, 'expected a plain output array.');
    }
    return {
      ...common,
      kind: 'decider',
      config: {
        condition: deciderCondition(config.condition, `${path}.config.condition`, networkIds),
        outputs: parseOutputs(config.outputs, `${path}.config.outputs`),
        ...(config.elseOutputs === undefined
          ? {}
          : { elseOutputs: parseOutputs(config.elseOutputs, `${path}.config.elseOutputs`) }),
      },
    };
  }
  invalid(`${path}.kind`, 'unknown Producer kind.');
}

function network(value: unknown, path: string): ResolvedCircuitNetworkNode {
  const record = dataRecord(value, path);
  exactKeys(record, ['id', 'name', 'fixedColor', 'provenance', 'color'], path);
  const fixedColor = record.fixedColor;
  const color = record.color;
  if (fixedColor !== undefined && fixedColor !== 'red' && fixedColor !== 'green')
    invalid(`${path}.fixedColor`, 'expected red or green.');
  if (color !== 'red' && color !== 'green') invalid(`${path}.color`, 'expected red or green.');
  if (fixedColor !== undefined && fixedColor !== color) {
    invalid(`${path}.fixedColor`, 'fixed Network color does not match the resolved color.');
  }
  return Object.freeze({
    id: text(record.id, `${path}.id`) as never,
    ...(record.name === undefined ? {} : { name: text(record.name, `${path}.name`) }),
    ...(fixedColor === undefined ? {} : { fixedColor }),
    provenance: provenance(record.provenance, `${path}.provenance`),
    color,
  });
}

function validateNetworkRefColors(
  reference: LogicalNetworkRef,
  path: string,
  colors: ReadonlyMap<string, CircuitColor>,
): void {
  if (reference.refKind === 'single') {
    if (!colors.has(reference.network)) invalid(`${path}.network`, 'unknown Network ID.');
    return;
  }
  const first = colors.get(reference.networks[0]!);
  const second = colors.get(reference.networks[1]!);
  if (first === undefined || second === undefined) {
    invalid(`${path}.networks`, 'unknown Network ID.');
  }
  if (first === second) {
    invalid(`${path}.networks`, 'a Network pair must resolve to opposite colors.');
  }
}

function validateArithmeticOperandColors(
  operand: LogicalArithmeticOperand,
  path: string,
  colors: ReadonlyMap<string, CircuitColor>,
): void {
  if (operand.kind !== 'constant') validateNetworkRefColors(operand, path, colors);
}

function validateConditionColors(
  condition: LogicalDeciderCondition,
  path: string,
  colors: ReadonlyMap<string, CircuitColor>,
): void {
  if (condition.kind === 'and' || condition.kind === 'or') {
    condition.conditions.forEach((entry, index) =>
      validateConditionColors(entry, `${path}.conditions[${index}]`, colors),
    );
    return;
  }
  validateNetworkRefColors(condition.left, `${path}.left`, colors);
  if (condition.right.kind === 'signal') {
    validateNetworkRefColors(condition.right, `${path}.right`, colors);
  }
}

function validateDeciderOutputColors(
  output: LogicalDeciderOutput,
  path: string,
  colors: ReadonlyMap<string, CircuitColor>,
): void {
  if (output.input !== undefined) validateNetworkRefColors(output.input, `${path}.input`, colors);
}

function validatePhysicalInvariants(ir: NativeCircuitIrV3): void {
  const colors = new Map<string, CircuitColor>(ir.networks.map(({ id, color }) => [id, color]));
  ir.producers.forEach((producer, producerIndex) => {
    const path = `$.ir.producers[${producerIndex}]`;
    if (producer.destinations.length < 1 || producer.destinations.length > 2) {
      invalid(`${path}.destinations`, 'a Producer must have one or two destinations.');
    }
    if (producer.destinations.length === 2) {
      const first = colors.get(producer.destinations[0]!);
      const second = colors.get(producer.destinations[1]!);
      if (first === second) {
        invalid(
          `${path}.destinations`,
          'two Producer destinations must resolve to opposite colors.',
        );
      }
    }
    if (producer.kind === 'arithmetic') {
      validateArithmeticOperandColors(producer.config.left, `${path}.config.left`, colors);
      validateArithmeticOperandColors(producer.config.right, `${path}.config.right`, colors);
    } else if (producer.kind === 'decider') {
      validateConditionColors(producer.config.condition, `${path}.config.condition`, colors);
      producer.config.outputs.forEach((output, index) =>
        validateDeciderOutputColors(output, `${path}.config.outputs[${index}]`, colors),
      );
      producer.config.elseOutputs?.forEach((output, index) =>
        validateDeciderOutputColors(output, `${path}.config.elseOutputs[${index}]`, colors),
      );
    }
  });
  ir.entities.forEach((entity, entityIndex) => {
    entity.connectorBindings.forEach((bindingValue, bindingIndex) => {
      if (bindingValue.network === undefined) return;
      const resolved = colors.get(bindingValue.network);
      if (resolved !== bindingValue.endpoint.color) {
        invalid(
          `$.ir.entities[${entityIndex}].connectorBindings[${bindingIndex}].network`,
          'Entity endpoint requires a matching resolved Network color.',
        );
      }
    });
  });
}

function ir(value: unknown): NativeCircuitIrV3 {
  const record = dataRecord(value, '$.ir');
  exactKeys(record, ['format', 'version', 'context', 'networks', 'producers', 'entities'], '$.ir');
  if (record.format !== 'comblang-ncir')
    invalid('$.ir.format', 'unsupported resolved circuit IR format.');
  if (record.version !== 3) invalid('$.ir.version', 'resolved circuit IR requires version 3.');
  const resolvedContext = context(record.context, '$.ir.context');
  const networks = dataArray(record.networks, '$.ir.networks').map((entry, index) =>
    network(entry, `$.ir.networks[${index}]`),
  );
  const networkIds = new Set(networks.map(({ id }) => id));
  if (networkIds.size !== networks.length) invalid('$.ir.networks', 'Network IDs must be unique.');
  const producers = dataArray(record.producers, '$.ir.producers').map((entry, index) =>
    producer(entry, `$.ir.producers[${index}]`, networkIds),
  );
  const producerIds = producers.map(({ id }) => id);
  if (new Set(producerIds).size !== producerIds.length)
    invalid('$.ir.producers', 'Producer IDs must be unique.');
  const entities = dataArray(record.entities, '$.ir.entities').map((entry, index) =>
    entity(entry, `$.ir.entities[${index}]`, resolvedContext.database, networkIds),
  );
  const entityIds = entities.map(({ id }) => id);
  if (new Set(entityIds).size !== entityIds.length)
    invalid('$.ir.entities', 'Entity IDs must be unique.');
  const ordinals = entities.map(({ ordinal }) => ordinal);
  if (new Set(ordinals).size !== ordinals.length)
    invalid('$.ir.entities', 'Entity ordinals must be unique.');
  const parsed = Object.freeze({
    format: 'comblang-ncir',
    version: 3,
    context: resolvedContext,
    networks: Object.freeze(networks),
    producers: Object.freeze(producers),
    entities: Object.freeze([...entities].sort((left, right) => left.ordinal - right.ordinal)),
  });
  validatePhysicalInvariants(parsed);
  return parsed;
}

/** Parses, clones, validates, and deeply freezes one resolved physical circuit. */
export function parseResolvedSourceCircuit(value: unknown): ResolvedSourceCircuit {
  const record = dataRecord(value, '$');
  exactKeys(record, ['format', 'version', 'planFingerprint', 'ir'], '$');
  if (record.format !== resolvedSourceCircuitFormat)
    invalid('$.format', 'unsupported resolved source circuit format.');
  if (record.version !== resolvedSourceCircuitVersion)
    invalid('$.version', 'unsupported resolved source circuit version.');
  const fingerprint = text(record.planFingerprint, '$.planFingerprint');
  if (!planFingerprintPattern.test(fingerprint)) {
    invalid('$.planFingerprint', 'expected a canonical v1 plan fingerprint.');
  }
  return deepFreeze({
    format: resolvedSourceCircuitFormat,
    version: resolvedSourceCircuitVersion,
    planFingerprint: fingerprint,
    ir: ir(record.ir),
  });
}

/** Result-oriented wrapper for transport boundaries that must retain diagnostics. */
export function validateResolvedSourceCircuit(
  value: unknown,
): ResolvedSourceCircuitValidationResult {
  try {
    return { value: parseResolvedSourceCircuit(value), diagnostics: [] };
  } catch (error) {
    if (error instanceof ResolvedSourceCircuitError) {
      return {
        diagnostics: [{ code: error.code, severity: 'error', message: error.message }],
      };
    }
    return {
      diagnostics: [
        {
          code: 'RSC1099',
          severity: 'error',
          message:
            error instanceof Error ? error.message : 'Resolved source circuit validation failed.',
        },
      ],
    };
  }
}

/** Alias used by callers that emphasize the detached snapshot boundary. */
export const snapshotResolvedSourceCircuit = parseResolvedSourceCircuit;

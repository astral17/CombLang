import type { SourceSpan } from '@comblang/shared';

import { BlueprintJsonError } from './blueprint-native-config.js';

export type NativeBlueprintJsonValue =
  | null
  | boolean
  | number
  | string
  | readonly NativeBlueprintJsonValue[]
  | NativeBlueprintJsonObject;

export interface NativeBlueprintJsonObject {
  readonly [key: string]: NativeBlueprintJsonValue;
}

export interface NativeBlueprintHeader {
  readonly item: 'blueprint';
  readonly label: string;
  readonly version: number;
  readonly icons: readonly {
    readonly signal: { readonly type: 'item'; readonly name: 'blueprint' };
    readonly index: 1;
  }[];
}

/** Native entity fields are exportable JSON; source provenance is diagnostic-only. */
export interface NativeBlueprintEntity {
  readonly entityNumber: number;
  /** Optional raw native fields serialized before the compiler-owned number. */
  readonly nativeBeforeNumber?: NativeBlueprintJsonObject;
  /** Remaining ordered native fields, excluding compiler-owned `entity_number`. */
  readonly native: NativeBlueprintJsonObject;
  readonly source?: SourceSpan;
}

export interface NativeBlueprintWireEndpoint {
  readonly entityNumber: number;
  readonly connector: number;
}

/** Endpoints are explicit; source provenance never appears in emitted wires. */
export interface NativeBlueprintWire {
  readonly from: NativeBlueprintWireEndpoint;
  readonly to: NativeBlueprintWireEndpoint;
  readonly source?: SourceSpan;
}

/** Immutable native export projection. It is not a simulator or import IR. */
export interface NativeBlueprintFcir {
  readonly header: NativeBlueprintHeader;
  readonly entities: readonly NativeBlueprintEntity[];
  readonly wires: readonly NativeBlueprintWire[];
}

type DataRecord = Record<string, unknown>;

const maxNativeJsonDepth = 128;
const maxNativeJsonNodes = 1_000_000;
const maxNativeStringBytes = 4_194_304;

interface NativeJsonBudget {
  nodes: number;
  stringBytes: number;
}

function fail(message: string, span?: SourceSpan): never {
  throw new BlueprintJsonError(message, span);
}

function frozenRecord(value: unknown, path: string, span?: SourceSpan): DataRecord {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    fail(`${path}: expected an immutable data record.`, span);
  }
  if (!Object.isFrozen(value)) fail(`${path}: record must be immutable.`, span);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    fail(`${path}: expected a plain data record.`, span);
  }
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string') fail(`${path}: symbol keys are not supported.`, span);
    const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
    if (!('value' in descriptor)) fail(`${path}.${key}: accessors are not supported.`, span);
    if (!descriptor.enumerable)
      fail(`${path}.${key}: non-enumerable fields are not supported.`, span);
  }
  return value as DataRecord;
}

function frozenArray(value: unknown, path: string, span?: SourceSpan): readonly unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    fail(`${path}: expected an immutable plain array.`, span);
  }
  if (!Object.isFrozen(value)) fail(`${path}: array must be immutable.`, span);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string') fail(`${path}: symbol keys are not supported.`, span);
    if (key === 'length') continue;
    if (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= value.length) {
      fail(`${path}.${key}: unknown array field.`, span);
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
    if (!('value' in descriptor)) fail(`${path}[${key}]: accessors are not supported.`, span);
    if (!descriptor.enumerable)
      fail(`${path}[${key}]: non-enumerable values are not supported.`, span);
  }
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.prototype.hasOwnProperty.call(value, index)) {
      fail(`${path}[${index}]: array holes are not supported.`, span);
    }
  }
  return value;
}

function exactKeys(
  record: DataRecord,
  keys: readonly string[],
  path: string,
  span?: SourceSpan,
): void {
  const allowed = new Set(keys);
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) fail(`${path}.${key}: unsupported FCIR field.`, span);
  }
}

function sourceSpan(value: unknown, path: string, fallback?: SourceSpan): SourceSpan | undefined {
  if (value === undefined) return undefined;
  const record = frozenRecord(value, path, fallback);
  exactKeys(record, ['fileId', 'start', 'end'], path, fallback);
  if (typeof record.fileId !== 'string' || record.fileId.length === 0) {
    fail(`${path}.fileId: expected a non-empty source file identity.`, fallback);
  }
  if (!Number.isSafeInteger(record.start) || (record.start as number) < 0) {
    fail(`${path}.start: expected a non-negative safe integer.`, fallback);
  }
  if (!Number.isSafeInteger(record.end) || (record.end as number) < (record.start as number)) {
    fail(`${path}.end: expected a safe integer not before the start.`, fallback);
  }
  return value as SourceSpan;
}

function chargeString(
  value: string,
  path: string,
  span: SourceSpan | undefined,
  budget: NativeJsonBudget,
): void {
  if (value.length > maxNativeStringBytes - budget.stringBytes) {
    fail(`${path}: native JSON string byte limit exceeded.`, span);
  }
  let bytes = 0;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        fail(`${path}: unpaired high surrogate in native JSON string.`, span);
      }
      index += 1;
      bytes += 4;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      fail(`${path}: unpaired low surrogate in native JSON string.`, span);
    } else bytes += code <= 0x7f ? 1 : code <= 0x7ff ? 2 : 3;
  }
  if (bytes > maxNativeStringBytes - budget.stringBytes) {
    fail(`${path}: native JSON string byte limit exceeded.`, span);
  }
  budget.stringBytes += bytes;
}

function validateJsonValue(
  value: unknown,
  path: string,
  span: SourceSpan | undefined,
  active: WeakSet<object>,
  budget: NativeJsonBudget,
  depth: number,
): void {
  if (depth > maxNativeJsonDepth) fail(`${path}: native JSON depth limit exceeded.`, span);
  budget.nodes += 1;
  if (budget.nodes > maxNativeJsonNodes) fail(`${path}: native JSON node limit exceeded.`, span);
  if (typeof value === 'string') {
    chargeString(value, path, span, budget);
    return;
  }
  if (value === null || typeof value === 'boolean') return;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail(`${path}: expected a finite JSON number.`, span);
    return;
  }
  if (typeof value !== 'object') fail(`${path}: unsupported native JSON value.`, span);
  if (active.has(value)) fail(`${path}: cyclic native payloads are not supported.`, span);
  active.add(value);
  try {
    if (Array.isArray(value)) {
      if (value.length > maxNativeJsonNodes - budget.nodes) {
        fail(`${path}: native JSON node limit exceeded.`, span);
      }
      const values = frozenArray(value, path, span);
      values.forEach((child, index) =>
        validateJsonValue(child, `${path}[${index}]`, span, active, budget, depth + 1),
      );
      return;
    }
    const record = frozenRecord(value, path, span);
    for (const key of Object.keys(record)) {
      chargeString(key, `${path}.${key}`, span, budget);
      validateJsonValue(record[key], `${path}.${key}`, span, active, budget, depth + 1);
    }
  } finally {
    active.delete(value);
  }
}

function validateJsonObject(
  value: unknown,
  path: string,
  budget: NativeJsonBudget,
  span?: SourceSpan,
): NativeBlueprintJsonObject {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    fail(`${path}: expected a native JSON object.`, span);
  }
  validateJsonValue(value, path, span, new WeakSet(), budget, 0);
  return value as NativeBlueprintJsonObject;
}

function positiveSafeInteger(value: unknown, path: string, span?: SourceSpan): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    fail(`${path}: expected a positive safe integer.`, span);
  }
  return value as number;
}

function validateHeader(value: unknown, budget: NativeJsonBudget): NativeBlueprintHeader {
  const header = frozenRecord(value, '$.header');
  exactKeys(header, ['item', 'label', 'version', 'icons'], '$.header');
  if (header.item !== 'blueprint') fail('$.header.item: expected "blueprint".');
  if (typeof header.label !== 'string') fail('$.header.label: expected a string.');
  chargeString(header.label, '$.header.label', undefined, budget);
  if (!Number.isSafeInteger(header.version) || (header.version as number) < 0) {
    fail('$.header.version: expected a non-negative safe integer.');
  }
  const icons = frozenArray(header.icons, '$.header.icons');
  if (icons.length !== 1) fail('$.header.icons: exactly one blueprint icon is required.');
  const icon = frozenRecord(icons[0], '$.header.icons[0]');
  exactKeys(icon, ['signal', 'index'], '$.header.icons[0]');
  if (icon.index !== 1) fail('$.header.icons[0].index: expected 1.');
  const signal = frozenRecord(icon.signal, '$.header.icons[0].signal');
  exactKeys(signal, ['type', 'name'], '$.header.icons[0].signal');
  if (signal.type !== 'item' || signal.name !== 'blueprint') {
    fail('$.header.icons[0].signal: expected the blueprint item signal.');
  }
  return value as NativeBlueprintHeader;
}

function validatePosition(value: unknown, path: string, span: SourceSpan | undefined): void {
  const position = frozenRecord(value, path, span);
  exactKeys(position, ['x', 'y'], path, span);
  if (typeof position.x !== 'number' || !Number.isFinite(position.x)) {
    fail(`${path}.x: expected a finite number.`, span);
  }
  if (typeof position.y !== 'number' || !Number.isFinite(position.y)) {
    fail(`${path}.y: expected a finite number.`, span);
  }
}

function validateEntity(
  value: unknown,
  index: number,
  budget: NativeJsonBudget,
): NativeBlueprintEntity {
  const path = `$.entities[${index}]`;
  const entity = frozenRecord(value, path);
  if (Object.hasOwn(entity, 'source') && entity.source === undefined) {
    fail(`${path}.source: omit absent provenance instead of storing undefined.`);
  }
  if (Object.hasOwn(entity, 'nativeBeforeNumber') && entity.nativeBeforeNumber === undefined) {
    fail(`${path}.nativeBeforeNumber: omit absent fields instead of storing undefined.`);
  }
  const source = sourceSpan(entity.source, `${path}.source`);
  exactKeys(entity, ['entityNumber', 'nativeBeforeNumber', 'native', 'source'], path, source);
  positiveSafeInteger(entity.entityNumber, `${path}.entityNumber`, source);
  const nativeBeforeNumber =
    entity.nativeBeforeNumber === undefined
      ? undefined
      : validateJsonObject(entity.nativeBeforeNumber, `${path}.nativeBeforeNumber`, budget, source);
  const native = validateJsonObject(entity.native, `${path}.native`, budget, source);
  const fields = native as DataRecord;
  if (Object.prototype.hasOwnProperty.call(fields, 'entity_number')) {
    fail(`${path}.native.entity_number: entity number is owned by FCIR.`, source);
  }
  if (typeof fields.name !== 'string' || fields.name.length === 0) {
    fail(`${path}.native.name: expected a non-empty prototype name.`, source);
  }
  validatePosition(fields.position, `${path}.native.position`, source);
  if (!Number.isSafeInteger(fields.direction) || (fields.direction as number) < 0) {
    fail(`${path}.native.direction: expected a non-negative safe integer.`, source);
  }
  if (nativeBeforeNumber !== undefined) {
    const prefixFields = nativeBeforeNumber as DataRecord;
    if (Object.prototype.hasOwnProperty.call(prefixFields, 'entity_number')) {
      fail(`${path}.nativeBeforeNumber.entity_number: entity number is owned by FCIR.`, source);
    }
    for (const key of Object.keys(prefixFields)) {
      if (Object.prototype.hasOwnProperty.call(fields, key)) {
        fail(
          `${path}: native field ${JSON.stringify(key)} is duplicated across the number boundary.`,
          source,
        );
      }
    }
  }
  if (entity.source !== undefined) sourceSpan(entity.source, `${path}.source`, source);
  return value as NativeBlueprintEntity;
}

function validateEndpoint(value: unknown, path: string, span?: SourceSpan): number {
  const endpoint = frozenRecord(value, path, span);
  exactKeys(endpoint, ['entityNumber', 'connector'], path, span);
  positiveSafeInteger(endpoint.entityNumber, `${path}.entityNumber`, span);
  positiveSafeInteger(endpoint.connector, `${path}.connector`, span);
  return endpoint.entityNumber as number;
}

function validateWire(value: unknown, index: number): NativeBlueprintWire {
  const path = `$.wires[${index}]`;
  const wire = frozenRecord(value, path);
  if (Object.hasOwn(wire, 'source') && wire.source === undefined) {
    fail(`${path}.source: omit absent provenance instead of storing undefined.`);
  }
  const source = sourceSpan(wire.source, `${path}.source`);
  exactKeys(wire, ['from', 'to', 'source'], path, source);
  validateEndpoint(wire.from, `${path}.from`, source);
  validateEndpoint(wire.to, `${path}.to`, source);
  return value as NativeBlueprintWire;
}

/** Runtime boundary check for internal callers before FCIR reaches a JSON emitter. */
export function validateNativeBlueprintFcir(value: unknown): asserts value is NativeBlueprintFcir {
  const root = frozenRecord(value, '$');
  exactKeys(root, ['header', 'entities', 'wires'], '$');
  const budget: NativeJsonBudget = { nodes: 0, stringBytes: 0 };
  validateHeader(root.header, budget);
  if (Array.isArray(root.entities) && root.entities.length > maxNativeJsonNodes) {
    fail('$.entities: native JSON node limit exceeded.');
  }
  const entities = frozenArray(root.entities, '$.entities');
  const entityNumbers = new Set<number>();
  entities.forEach((candidate, index) => {
    const entity = validateEntity(candidate, index, budget);
    if (entityNumbers.has(entity.entityNumber)) {
      fail(`Duplicate native blueprint Entity number ${entity.entityNumber}.`, entity.source);
    }
    entityNumbers.add(entity.entityNumber);
  });

  if (Array.isArray(root.wires) && root.wires.length > maxNativeJsonNodes - entities.length) {
    fail('$.wires: native JSON node limit exceeded.');
  }
  const wires = frozenArray(root.wires, '$.wires');
  wires.forEach((candidate, index) => {
    const wire = validateWire(candidate, index);
    for (const [side, endpoint] of [
      ['from', wire.from],
      ['to', wire.to],
    ] as const) {
      const entityNumber = endpoint.entityNumber;
      if (!entityNumbers.has(entityNumber)) {
        fail(`$.wires[${index}].${side}: references unknown Entity ${entityNumber}.`, wire.source);
      }
    }
  });
}

import { entityRawJsonLimits } from './entity.js';
import type {
  EntityRawJson,
  EntityRawJsonLimits,
  EntityRawJsonObject,
  EntityRawPayload,
} from './entity.js';
import type { EntityPlacement } from './ir.js';

export type EntityRawJsonErrorCode = 'ERAW1000' | 'ERAW1001' | 'ERAW1002' | 'ERAW1003';

export class EntityRawJsonError extends Error {
  readonly code: EntityRawJsonErrorCode;
  readonly path: string;
  readonly detail: string;

  constructor(code: EntityRawJsonErrorCode, path: string, message: string) {
    super(`${path}: ${message}`);
    this.name = 'EntityRawJsonError';
    this.code = code;
    this.path = path;
    this.detail = message;
  }
}

/** BlueprintEntity fields whose values belong to the compiler, not raw config. */
export const entityRawCompilerOwnedKeys = Object.freeze([
  'entity_id',
  'entity_number',
  'name',
  'prototype',
  'position',
  'placement',
  'direction',
  'connections',
  'connectors',
  'wires',
] as const);

const entityRawCompilerOwnedKeySet = new Set<string>(entityRawCompilerOwnedKeys);

function invalid(code: EntityRawJsonErrorCode, path: string, message: string): never {
  throw new EntityRawJsonError(code, path, message);
}

function limits(value: EntityRawJsonLimits): EntityRawJsonLimits {
  if (
    !Number.isSafeInteger(value.maxDepth) ||
    value.maxDepth < 0 ||
    !Number.isSafeInteger(value.maxNodes) ||
    value.maxNodes < 1 ||
    !Number.isSafeInteger(value.maxBytes) ||
    value.maxBytes < 1
  ) {
    invalid('ERAW1000', '$.limits', 'raw JSON limits must be non-negative/positive safe integers.');
  }
  return value;
}

function dataRecord(value: unknown, path: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    invalid('ERAW1001', path, 'expected a plain data record.');
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    invalid('ERAW1001', path, 'expected a plain object or null-prototype record.');
  }
  const output = Object.create(null) as Record<string, unknown>;
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string') {
      invalid('ERAW1001', `${path}[${String(key)}]`, 'symbol keys are not allowed.');
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
    if (!('value' in descriptor)) {
      invalid('ERAW1001', `${path}.${key}`, 'accessors are not allowed in raw JSON.');
    }
    output[key] = descriptor.value;
  }
  return output;
}

function dataArray(value: unknown, path: string): readonly unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    invalid('ERAW1001', path, 'expected a plain array.');
  }
  const lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length');
  if (lengthDescriptor === undefined || !('value' in lengthDescriptor)) {
    invalid('ERAW1001', `${path}.length`, 'array length must be data-only.');
  }
  const length = lengthDescriptor.value;
  if (typeof length !== 'number' || !Number.isSafeInteger(length) || length < 0) {
    invalid('ERAW1001', `${path}.length`, 'array length must be a non-negative safe integer.');
  }
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string') {
      invalid('ERAW1001', `${path}[${String(key)}]`, 'symbol keys are not allowed.');
    }
    if (key === 'length') continue;
    if (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= length) {
      invalid('ERAW1001', `${path}.${key}`, 'unknown array field.');
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
    if (!('value' in descriptor)) {
      invalid('ERAW1001', `${path}[${key}]`, 'accessors are not allowed in raw JSON.');
    }
  }
  const output: unknown[] = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (descriptor === undefined)
      invalid('ERAW1001', `${path}[${index}]`, 'array holes are not allowed.');
    if (!('value' in descriptor)) {
      invalid('ERAW1001', `${path}[${index}]`, 'accessors are not allowed in raw JSON.');
    }
    output.push(descriptor.value);
  }
  return output;
}

interface WalkState {
  readonly seen: WeakSet<object>;
  nodes: number;
}

function walk(
  value: unknown,
  path: string,
  depth: number,
  state: WalkState,
  configuration: EntityRawJsonLimits,
): EntityRawJson {
  if (depth > configuration.maxDepth) {
    invalid('ERAW1002', path, `raw JSON exceeds the depth limit of ${configuration.maxDepth}.`);
  }
  state.nodes += 1;
  if (state.nodes > configuration.maxNodes) {
    invalid('ERAW1002', path, `raw JSON exceeds the node limit of ${configuration.maxNodes}.`);
  }
  if (value === null) return null;
  if (typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) invalid('ERAW1001', path, 'numbers must be finite.');
    return value;
  }
  if (typeof value !== 'object') {
    invalid('ERAW1001', path, 'only JSON values are allowed.');
  }
  if (state.seen.has(value)) invalid('ERAW1002', path, 'cycles are not allowed.');
  state.seen.add(value);
  try {
    if (Array.isArray(value)) {
      const result = dataArray(value, path).map((child, index) =>
        walk(child, `${path}[${index}]`, depth + 1, state, configuration),
      );
      return Object.freeze(result);
    }
    const record = dataRecord(value, path);
    const result = Object.create(null) as Record<string, EntityRawJson>;
    for (const key of Reflect.ownKeys(record)) {
      if (typeof key !== 'string') {
        invalid('ERAW1001', `${path}[${String(key)}]`, 'symbol keys are not allowed.');
      }
      Object.defineProperty(result, key, {
        configurable: false,
        enumerable: true,
        value: walk(record[key], `${path}.${key}`, depth + 1, state, configuration),
        writable: false,
      });
    }
    return Object.freeze(result) as EntityRawJsonObject;
  } finally {
    state.seen.delete(value);
  }
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    if (!Object.isFrozen(value)) Object.freeze(value);
  }
  return value;
}

/** Canonicalizes one bounded JSON tree without invoking accessors or retaining caller objects. */
export function canonicalizeEntityRawJson(
  value: unknown,
  configuration: EntityRawJsonLimits = entityRawJsonLimits,
  path = '$',
): EntityRawJson {
  const canonical = walk(value, path, 0, { seen: new WeakSet(), nodes: 0 }, limits(configuration));
  const bytes = new TextEncoder().encode(JSON.stringify(canonical)).byteLength;
  if (bytes > configuration.maxBytes) {
    invalid('ERAW1002', path, `raw JSON exceeds the byte limit of ${configuration.maxBytes}.`);
  }
  return deepFreeze(canonical);
}

/** Canonicalizes one top-level BlueprintEntity field object and rejects compiler-owned keys. */
export function canonicalizeEntityRawObject(
  value: unknown,
  configuration: EntityRawJsonLimits = entityRawJsonLimits,
  path = '$',
): EntityRawJsonObject {
  const canonical = canonicalizeEntityRawJson(value, configuration, path);
  if (canonical === null || typeof canonical !== 'object' || Array.isArray(canonical)) {
    invalid('ERAW1001', path, 'raw Entity configuration must be a JSON object.');
  }
  for (const key of Object.keys(canonical)) {
    if (entityRawCompilerOwnedKeySet.has(key)) {
      invalid(
        'ERAW1003',
        `${path}.${key}`,
        'compiler-owned BlueprintEntity fields must stay separate.',
      );
    }
  }
  return canonical as EntityRawJsonObject;
}

function stableText(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.length === 0)
    invalid('ERAW1001', path, 'expected a non-empty prototype name.');
  return value;
}

function finiteNumber(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    invalid('ERAW1001', path, 'expected a finite number.');
  }
  return value;
}

function positiveNumber(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    invalid('ERAW1001', path, 'expected a positive safe integer.');
  }
  return value;
}

function placement(value: unknown, path: string): EntityPlacement {
  const record = dataRecord(value, path);
  for (const key of Object.keys(record)) {
    if (key !== 'x' && key !== 'y' && key !== 'direction') {
      invalid('ERAW1000', `${path}.${key}`, 'unknown placement field.');
    }
  }
  if (!('x' in record) || !('y' in record)) {
    invalid('ERAW1001', path, 'placement requires x and y.');
  }
  return {
    x: finiteNumber(record.x, `${path}.x`),
    y: finiteNumber(record.y, `${path}.y`),
    ...('direction' in record
      ? { direction: finiteNumber(record.direction, `${path}.direction`) }
      : {}),
  };
}

/** Separates compiler-owned topology fields from an otherwise lossless native JSON payload. */
export function canonicalizeEntityRawPayload(
  value: unknown,
  configuration: EntityRawJsonLimits = entityRawJsonLimits,
): EntityRawPayload {
  const record = dataRecord(value, '$');
  if ('wires' in record) invalid('ERAW1003', '$.wires', 'wire import is not supported yet.');
  for (const key of Object.keys(record)) {
    if (!['prototype', 'native', 'entityNumber', 'placement'].includes(key)) {
      invalid('ERAW1000', `$.${key}`, 'unknown raw Entity field.');
    }
  }
  const native = canonicalizeEntityRawObject(record.native, configuration, '$.native');
  return deepFreeze({
    prototype: stableText(record.prototype, '$.prototype'),
    native: native as EntityRawJsonObject,
    ...('entityNumber' in record
      ? { entityNumber: positiveNumber(record.entityNumber, '$.entityNumber') }
      : {}),
    ...('placement' in record ? { placement: placement(record.placement, '$.placement') } : {}),
  });
}

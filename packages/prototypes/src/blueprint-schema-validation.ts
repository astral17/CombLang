import { blueprintSchemaCatalog } from './blueprint-schema-loader.js';
import type { BlueprintSchemaCatalog, BlueprintSchemaDescriptor } from './blueprint-schema.js';
import {
  resolveBlueprintEntitySchema,
  type ResolvedBlueprintEntitySchema,
} from './blueprint-schema-resolution.js';
import type { EntityPrototype } from './schema.js';

export type BlueprintSchemaValidationCode =
  'BSV1000' | 'BSV1001' | 'BSV1002' | 'BSV1003' | 'BSV1004' | 'BSV1005';

export interface BlueprintSchemaValidationLimits {
  readonly maxDepth: number;
  readonly maxNodes: number;
  readonly maxBytes: number;
}

export const blueprintSchemaValidationLimits: BlueprintSchemaValidationLimits = Object.freeze({
  maxDepth: 32,
  maxNodes: 4096,
  maxBytes: 262_144,
});

interface BlueprintSchemaValidationIssue {
  readonly path: string;
  readonly message: string;
}

export interface BlueprintSchemaValidationSuccess {
  readonly status: 'valid';
  readonly structuralStatus: 'documented';
}

export interface BlueprintSchemaValidationInvalid {
  readonly status: 'invalid';
  readonly structuralStatus: 'documented';
  readonly code: Exclude<BlueprintSchemaValidationCode, 'BSV1004'>;
  readonly path: string;
  readonly message: string;
}

export interface BlueprintSchemaValidationUnassessed {
  readonly status: 'unassessed';
  readonly structuralStatus: 'unassessed';
  readonly code: 'BSV1004';
  readonly path: string;
  readonly message: string;
  readonly rawSuggestion: 'Use Entity(prototype, { raw: ... }) for this value.';
}

export type BlueprintSchemaValidationResult =
  | BlueprintSchemaValidationSuccess
  | BlueprintSchemaValidationInvalid
  | BlueprintSchemaValidationUnassessed;

interface ValidationState {
  readonly limits: BlueprintSchemaValidationLimits;
  readonly ancestors: Set<object>;
  readonly schema: ResolvedBlueprintEntitySchema;
  nodes: number;
  bytes: number;
}

type InternalOutcome =
  | { readonly status: 'valid' }
  | ({ readonly status: 'invalid' } & BlueprintSchemaValidationIssue & {
        readonly code: Exclude<BlueprintSchemaValidationCode, 'BSV1004'>;
      })
  | ({ readonly status: 'unassessed' } & BlueprintSchemaValidationIssue & {
        readonly code: 'BSV1004';
      });

type DataRecord = Record<string, unknown>;

const rawSuggestion = 'Use Entity(prototype, { raw: ... }) for this value.' as const;

function invalid(
  code: Exclude<BlueprintSchemaValidationCode, 'BSV1004'>,
  path: string,
  message: string,
): InternalOutcome {
  return { status: 'invalid', code, path, message };
}

function unassessed(path: string, message: string): InternalOutcome {
  return { status: 'unassessed', code: 'BSV1004', path, message };
}

function valid(): InternalOutcome {
  return { status: 'valid' };
}

function codeUnitCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isObject(value: unknown): value is object {
  return typeof value === 'object' && value !== null;
}

function jsonStringBytes(value: string): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

function charge(state: ValidationState, bytes: number, path: string): InternalOutcome | undefined {
  state.bytes += bytes;
  if (state.bytes > state.limits.maxBytes) {
    return invalid(
      'BSV1005',
      path,
      `input exceeds the JSON byte limit of ${state.limits.maxBytes}.`,
    );
  }
  return undefined;
}

function begin(
  value: unknown,
  path: string,
  depth: number,
  state: ValidationState,
): InternalOutcome | undefined {
  if (depth > state.limits.maxDepth) {
    return invalid('BSV1005', path, `input exceeds the depth limit of ${state.limits.maxDepth}.`);
  }
  state.nodes += 1;
  if (state.nodes > state.limits.maxNodes) {
    return invalid('BSV1005', path, `input exceeds the node limit of ${state.limits.maxNodes}.`);
  }
  if (value === null) return charge(state, 4, path);
  if (typeof value === 'string') return charge(state, jsonStringBytes(value), path);
  if (typeof value === 'boolean') return charge(state, value ? 4 : 5, path);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return invalid('BSV1005', path, 'numbers must be finite.');
    return charge(state, JSON.stringify(value).length, path);
  }
  if (!isObject(value)) return undefined;
  if (state.ancestors.has(value)) return invalid('BSV1005', path, 'cycles are not allowed.');
  state.ancestors.add(value);
  return charge(state, Array.isArray(value) ? 2 : 2, path);
}

function end(value: unknown, state: ValidationState): void {
  if (isObject(value)) state.ancestors.delete(value);
}

function plainRecord(value: unknown): value is DataRecord {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function ownDataEntries(
  value: DataRecord | readonly unknown[],
  path: string,
  state: ValidationState,
):
  | { readonly keys: readonly string[]; readonly values: Readonly<Record<string, unknown>> }
  | InternalOutcome {
  let keys: readonly PropertyKey[];
  try {
    keys = Reflect.ownKeys(value);
  } catch {
    return invalid('BSV1005', path, 'input property enumeration failed.');
  }
  const stringKeys: string[] = [];
  const values: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of keys) {
    if (typeof key !== 'string') {
      return invalid('BSV1005', `${path}[${String(key)}]`, 'symbol keys are not allowed.');
    }
    if (key === 'length' && Array.isArray(value)) continue;
    let descriptor: PropertyDescriptor | undefined;
    try {
      descriptor = Object.getOwnPropertyDescriptor(value, key);
    } catch {
      return invalid('BSV1005', `${path}.${key}`, 'input property inspection failed.');
    }
    if (descriptor === undefined || !('value' in descriptor)) {
      return invalid('BSV1005', `${path}.${key}`, 'accessors are not allowed.');
    }
    stringKeys.push(key);
    values[key] = descriptor.value;
    const bytes = charge(state, jsonStringBytes(key) + 2, `${path}.${key}`);
    if (bytes !== undefined) return bytes;
  }
  return { keys: stringKeys, values };
}

function readRecord(
  value: unknown,
  path: string,
  depth: number,
  state: ValidationState,
  callback: (
    record: DataRecord,
    keys: readonly string[],
    values: Readonly<Record<string, unknown>>,
  ) => InternalOutcome,
): InternalOutcome {
  const started = begin(value, path, depth, state);
  if (started !== undefined) return started;
  try {
    if (!plainRecord(value)) return invalid('BSV1002', path, 'expected a JSON object.');
    const entries = ownDataEntries(value, path, state);
    if ('status' in entries) return entries;
    return callback(value, entries.keys, entries.values);
  } finally {
    end(value, state);
  }
}

function readArray(
  value: unknown,
  path: string,
  depth: number,
  state: ValidationState,
  callback: (values: readonly unknown[]) => InternalOutcome,
): InternalOutcome {
  const started = begin(value, path, depth, state);
  if (started !== undefined) return started;
  try {
    if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
      return invalid('BSV1002', path, 'expected a JSON array.');
    }
    const lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length');
    if (lengthDescriptor === undefined || !('value' in lengthDescriptor)) {
      return invalid('BSV1005', `${path}.length`, 'array length must be data-only.');
    }
    const length = lengthDescriptor.value;
    if (!Number.isSafeInteger(length) || length < 0) {
      return invalid('BSV1005', `${path}.length`, 'array length must be a safe integer.');
    }
    const entries = ownDataEntries(value, path, state);
    if ('status' in entries) return entries;
    for (let index = 0; index < length; index += 1) {
      if (!entries.keys.includes(String(index))) {
        return invalid('BSV1005', `${path}[${index}]`, 'array holes are not allowed.');
      }
      if (index > 0) {
        const comma = charge(state, 1, `${path}[${index}]`);
        if (comma !== undefined) return comma;
      }
    }
    for (const key of entries.keys) {
      if (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= length) {
        return invalid('BSV1001', `${path}.${key}`, 'unknown array field.');
      }
    }
    return callback(entries.keys.map((key) => entries.values[key]));
  } finally {
    end(value, state);
  }
}

function checkpoint(state: ValidationState): { readonly nodes: number; readonly bytes: number } {
  return { nodes: state.nodes, bytes: state.bytes };
}

function restore(
  state: ValidationState,
  value: { readonly nodes: number; readonly bytes: number },
): void {
  state.nodes = value.nodes;
  state.bytes = value.bytes;
}

function scalarRange(name: string): { readonly min: number; readonly max: number } | undefined {
  switch (name) {
    case 'int8':
      return { min: -128, max: 127 };
    case 'int16':
      return { min: -32_768, max: 32_767 };
    case 'int32':
      return { min: -2_147_483_648, max: 2_147_483_647 };
    case 'uint8':
      return { min: 0, max: 255 };
    case 'uint16':
      return { min: 0, max: 65_535 };
    case 'uint32':
      return { min: 0, max: 4_294_967_295 };
    default:
      return undefined;
  }
}

function knownScalar(name: string): boolean {
  return (
    name === 'boolean' ||
    name === 'string' ||
    name === 'number' ||
    name === 'double' ||
    name === 'float' ||
    scalarRange(name) !== undefined ||
    name === 'table'
  );
}

function jsonValue(
  value: unknown,
  path: string,
  depth: number,
  state: ValidationState,
): InternalOutcome {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    const started = begin(value, path, depth, state);
    return started ?? valid();
  }
  if (typeof value === 'number') {
    const started = begin(value, path, depth, state);
    return started ?? valid();
  }
  if (Array.isArray(value)) {
    return readArray(value, path, depth, state, (values) => {
      for (const [index, child] of values.entries()) {
        const result = jsonValue(child, `${path}[${index}]`, depth + 1, state);
        if (result.status !== 'valid') return result;
      }
      return valid();
    });
  }
  if (plainRecord(value)) {
    return readRecord(value, path, depth, state, (_record, keys, values) => {
      for (const key of [...keys].sort(codeUnitCompare)) {
        const result = jsonValue(values[key], `${path}.${key}`, depth + 1, state);
        if (result.status !== 'valid') return result;
      }
      return valid();
    });
  }
  return invalid('BSV1002', path, 'expected a JSON value.');
}

function referenceDescriptor(
  name: string,
  schema: ResolvedBlueprintEntitySchema,
): BlueprintSchemaDescriptor | undefined {
  return schema.references.find((reference) => reference.name === name)?.type;
}

function descriptor(
  value: unknown,
  schema: BlueprintSchemaDescriptor,
  path: string,
  depth: number,
  state: ValidationState,
): InternalOutcome {
  if (schema.kind === 'scalar' && !knownScalar(schema.name)) {
    return unassessed(
      path,
      `Scalar ${JSON.stringify(schema.name)} is not safely interpretable; use the explicit raw form.`,
    );
  }

  if (schema.kind === 'reference') {
    const referenced = referenceDescriptor(schema.name, state.schema);
    if (referenced === undefined) {
      return invalid(
        'BSV1000',
        path,
        `schema reference ${JSON.stringify(schema.name)} is missing.`,
      );
    }
    return descriptor(value, referenced, path, depth, state);
  }

  if (schema.kind === 'scalar' && schema.name === 'table') {
    return jsonValue(value, path, depth, state);
  }

  if (schema.kind === 'scalar') {
    const started = begin(value, path, depth, state);
    if (started !== undefined) return started;
    try {
      if (schema.name === 'boolean' && typeof value !== 'boolean') {
        return invalid('BSV1002', path, 'expected a boolean.');
      }
      if (schema.name === 'boolean') return valid();
      if (schema.name === 'string' && typeof value !== 'string') {
        return invalid('BSV1002', path, 'expected a string.');
      }
      if (schema.name === 'string') return valid();
      if (schema.name === 'number' || schema.name === 'double' || schema.name === 'float') {
        if (typeof value !== 'number' || !Number.isFinite(value)) {
          return invalid('BSV1002', path, 'expected a finite number.');
        }
        return valid();
      }
      const range = scalarRange(schema.name);
      if (range !== undefined) {
        if (
          typeof value !== 'number' ||
          !Number.isSafeInteger(value) ||
          value < range.min ||
          value > range.max
        ) {
          return invalid('BSV1003', path, `expected an integer in [${range.min}, ${range.max}].`);
        }
        return valid();
      }
      return invalid('BSV1000', path, `unsupported scalar ${JSON.stringify(schema.name)}.`);
    } finally {
      end(value, state);
    }
  }

  if (schema.kind === 'literal') {
    const started = begin(value, path, depth, state);
    if (started !== undefined) return started;
    try {
      return value === schema.value
        ? valid()
        : invalid('BSV1002', path, `expected the literal ${JSON.stringify(schema.value)}.`);
    } finally {
      end(value, state);
    }
  }

  if (schema.kind === 'array') {
    return readArray(value, path, depth, state, (values) => {
      for (const [index, child] of values.entries()) {
        const result = descriptor(child, schema.items, `${path}[${index}]`, depth + 1, state);
        if (result.status !== 'valid') return result;
      }
      return valid();
    });
  }

  if (schema.kind === 'tuple') {
    return readArray(value, path, depth, state, (values) => {
      if (values.length !== schema.items.length) {
        return invalid(
          'BSV1002',
          path,
          `expected a tuple with exactly ${schema.items.length} item(s).`,
        );
      }
      for (const [index, child] of values.entries()) {
        const result = descriptor(
          child,
          schema.items[index]!,
          `${path}[${index}]`,
          depth + 1,
          state,
        );
        if (result.status !== 'valid') return result;
      }
      return valid();
    });
  }

  if (schema.kind === 'union') {
    const origin = checkpoint(state);
    let firstInvalid: InternalOutcome | undefined;
    let firstUnassessed: InternalOutcome | undefined;
    for (const option of schema.options) {
      restore(state, origin);
      const result = descriptor(value, option, path, depth, state);
      if (result.status === 'valid') return result;
      if (result.status === 'unassessed' && firstUnassessed === undefined) firstUnassessed = result;
      if (result.status === 'invalid' && firstInvalid === undefined) firstInvalid = result;
      if (result.status === 'invalid' && result.code === 'BSV1005') return result;
    }
    restore(state, origin);
    return (
      firstUnassessed ??
      firstInvalid ??
      invalid('BSV1002', path, 'value did not match any union option.')
    );
  }

  if (schema.kind === 'dictionary') {
    return readRecord(value, path, depth, state, (_record, keys, values) => {
      for (const key of [...keys].sort(codeUnitCompare)) {
        const keyResult = descriptor(key, schema.keys, `${path}.${key}`, depth + 1, state);
        if (keyResult.status !== 'valid') return keyResult;
        const valueResult = descriptor(
          values[key],
          schema.values,
          `${path}.${key}`,
          depth + 1,
          state,
        );
        if (valueResult.status !== 'valid') return valueResult;
      }
      return valid();
    });
  }

  const variant = schema.variant;
  return readRecord(value, path, depth, state, (_record, keys, values) => {
    const selectedGroup =
      variant === undefined
        ? undefined
        : variant.groups.find(
            (group) =>
              group.value ===
              (typeof values[variant.discriminator] === 'string'
                ? values[variant.discriminator]
                : variant.default),
          );
    if (selectedGroup !== undefined) {
      for (const field of selectedGroup.fields) {
        if (!field.optional && !keys.includes(field.name)) {
          return invalid(
            'BSV1002',
            `${path}.${field.name}`,
            'required field is missing for the selected Blueprint schema variant.',
          );
        }
      }
    }
    const fields = new Map([
      ...schema.fields.map((field) => [field.name, field] as const),
      ...(selectedGroup?.fields.map((field) => [field.name, field] as const) ?? []),
    ]);
    for (const key of [...keys].sort(codeUnitCompare)) {
      if (!fields.has(key)) {
        return invalid(
          'BSV1001',
          `${path}.${key}`,
          'field is not documented for this Blueprint schema.',
        );
      }
    }
    for (const field of schema.fields) {
      if (!keys.includes(field.name)) continue;
      if (field.ownership === 'compiler') {
        return invalid(
          'BSV1003',
          `${path}.${field.name}`,
          'compiler-owned BlueprintEntity fields must stay separate.',
        );
      }
      const result = descriptor(
        values[field.name],
        field.type,
        `${path}.${field.name}`,
        depth + 1,
        state,
      );
      if (result.status !== 'valid') return result;
    }
    return valid();
  });
}

function result(outcome: InternalOutcome): BlueprintSchemaValidationResult {
  if (outcome.status === 'valid') {
    return { status: 'valid', structuralStatus: 'documented' };
  }
  if (outcome.status === 'unassessed') {
    return {
      status: 'unassessed',
      structuralStatus: 'unassessed',
      code: outcome.code,
      path: outcome.path,
      message: outcome.message,
      rawSuggestion,
    };
  }
  return {
    status: 'invalid',
    structuralStatus: 'documented',
    code: outcome.code,
    path: outcome.path,
    message: outcome.message,
  };
}

function limits(value: BlueprintSchemaValidationLimits): BlueprintSchemaValidationLimits {
  if (
    !Number.isSafeInteger(value.maxDepth) ||
    value.maxDepth < 0 ||
    !Number.isSafeInteger(value.maxNodes) ||
    value.maxNodes < 1 ||
    !Number.isSafeInteger(value.maxBytes) ||
    value.maxBytes < 1
  ) {
    throw new RangeError(
      'Blueprint schema validation limits must be non-negative/positive integers.',
    );
  }
  return value;
}

function validateAgainstSchema(
  value: unknown,
  schema: ResolvedBlueprintEntitySchema,
  validationLimits: BlueprintSchemaValidationLimits,
): BlueprintSchemaValidationResult {
  const state = {
    limits: limits(validationLimits),
    ancestors: new Set<object>(),
    nodes: 0,
    bytes: 0,
    schema,
  } satisfies ValidationState;
  return result(descriptor(value, { kind: 'object', fields: schema.fields }, '$', 0, state));
}

export function validateBlueprintEntityFragmentAgainstSchema(
  value: unknown,
  schema: ResolvedBlueprintEntitySchema,
  validationLimits: BlueprintSchemaValidationLimits = blueprintSchemaValidationLimits,
): BlueprintSchemaValidationResult {
  return validateAgainstSchema(value, schema, validationLimits);
}

export function validateBlueprintEntityFragment(
  value: unknown,
  prototype: Pick<EntityPrototype, 'type'>,
  options: {
    readonly catalog?: BlueprintSchemaCatalog;
    readonly limits?: BlueprintSchemaValidationLimits;
  } = {},
): BlueprintSchemaValidationResult {
  try {
    return validateAgainstSchema(
      value,
      resolveBlueprintEntitySchema(prototype, options.catalog ?? blueprintSchemaCatalog),
      options.limits ?? blueprintSchemaValidationLimits,
    );
  } catch (error) {
    return result(
      invalid(
        'BSV1000',
        '$.prototype.type',
        error instanceof Error ? error.message : 'Blueprint schema resolution failed.',
      ),
    );
  }
}

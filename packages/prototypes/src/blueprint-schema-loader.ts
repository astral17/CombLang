import generatedCatalog from '../generated/blueprint-schema-catalog-2.1.17.json';

import {
  blueprintSchemaCatalogFormat,
  blueprintSchemaCatalogVersion,
  type BlueprintSchemaCatalog,
  type BlueprintSchemaDescriptor,
  type BlueprintSchemaField,
  type BlueprintSchemaSourceIdentity,
} from './blueprint-schema.js';

export const blueprintSchemaCatalogMaxDepth = 32;
export const blueprintSchemaCatalogMaxNodes = 4096;
export const blueprintSchemaCatalogMaxJsonBytes = 262_144;

/**
 * The only built-in source identity accepted by the pinned catalog loader.
 * Keep this declaration independent from generated catalog data so a modified
 * catalog cannot make its own provenance claim authoritative.
 */
export const blueprintSchemaCatalogReviewedSourceIdentity = Object.freeze({
  snapshot: 'fixtures/2.1.17',
  applicationVersion: '2.1.17',
  apiVersion: 6,
  runtimeSha256: '2e1fd436404b712af6fe7b6c53e21a8f5688092a9e132fd2a5571327a96e5211',
  prototypeSha256: '156f33cb4bc7ee2c538bb93f291f5270f2cdc45be654bbe6f226e402bf8f5368',
} satisfies BlueprintSchemaSourceIdentity);

const sourceIdentityKeys = [
  'snapshot',
  'applicationVersion',
  'apiVersion',
  'runtimeSha256',
  'prototypeSha256',
] as const;

type JsonObject = Record<string, unknown>;
type JsonPrimitive = boolean | number | string | null;

export class BlueprintSchemaCatalogError extends Error {
  readonly code: 'BSC1000' | 'BSC1001' | 'BSC1002' | 'BSC1003' | 'BSC1004';
  readonly path: string;

  constructor(code: BlueprintSchemaCatalogError['code'], path: string, message: string) {
    super(`${path}: ${message}`);
    this.name = 'BlueprintSchemaCatalogError';
    this.code = code;
    this.path = path;
  }
}

function invalid(code: BlueprintSchemaCatalogError['code'], path: string, message: string): never {
  throw new BlueprintSchemaCatalogError(code, path, message);
}

function plainObject(value: unknown, path: string): JsonObject {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    invalid('BSC1001', path, 'expected a plain object.');
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    invalid('BSC1001', path, 'expected a plain object or null-prototype object.');
  }
  return value as JsonObject;
}

function ownKeys(value: JsonObject, path: string): readonly string[] {
  const keys: string[] = [];
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string')
      invalid('BSC1001', `${path}[${String(key)}]`, 'symbol keys are not allowed.');
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !('value' in descriptor)) {
      invalid('BSC1001', `${path}.${key}`, 'accessors are not allowed.');
    }
    keys.push(key);
  }
  return keys;
}

function exactKeys(value: JsonObject, allowed: readonly string[], path: string): void {
  const allowedSet = new Set(allowed);
  for (const key of ownKeys(value, path)) {
    if (!allowedSet.has(key)) invalid('BSC1001', `${path}.${key}`, 'unknown field.');
  }
}

function stringValue(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    invalid('BSC1001', path, 'expected a non-empty string.');
  }
  return value;
}

function booleanValue(value: unknown, path: string): boolean {
  if (typeof value !== 'boolean') invalid('BSC1001', path, 'expected a boolean.');
  return value;
}

function integerValue(value: unknown, path: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    invalid('BSC1001', path, 'expected a non-negative safe integer.');
  }
  return value as number;
}

function digest(value: unknown, path: string): string {
  const result = stringValue(value, path);
  if (!/^[0-9a-f]{64}$/.test(result)) invalid('BSC1001', path, 'expected a SHA-256 hex digest.');
  return result;
}

function primitive(value: unknown, path: string): JsonPrimitive {
  if (
    value !== null &&
    typeof value !== 'boolean' &&
    typeof value !== 'number' &&
    typeof value !== 'string'
  ) {
    invalid('BSC1001', path, 'expected a JSON primitive.');
  }
  if (typeof value === 'number' && !Number.isFinite(value)) {
    invalid('BSC1001', path, 'expected a finite number.');
  }
  return value as JsonPrimitive;
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}

function sortedJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(sortedJson).join(',')}]`;
  if (!value || typeof value !== 'object') return JSON.stringify(value);
  return `{${Object.entries(value as JsonObject)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([key, child]) => `${JSON.stringify(key)}:${sortedJson(child)}`)
    .join(',')}}`;
}

interface ParseContext {
  readonly ancestors: WeakSet<object>;
  nodes: number;
}

function arrayValue(value: unknown, path: string, context: ParseContext): readonly unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    invalid('BSC1001', path, 'expected a plain array.');
  }
  if (context.ancestors.has(value)) invalid('BSC1003', path, 'cyclic data is not allowed.');
  context.nodes += 1;
  if (context.nodes > blueprintSchemaCatalogMaxNodes) {
    invalid('BSC1003', path, `node limit ${blueprintSchemaCatalogMaxNodes} exceeded.`);
  }
  context.ancestors.add(value);
  const lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length');
  if (lengthDescriptor === undefined || !('value' in lengthDescriptor)) {
    invalid('BSC1001', `${path}.length`, 'array length must be data-only.');
  }
  const length = lengthDescriptor.value;
  if (!Number.isSafeInteger(length) || length < 0) {
    invalid('BSC1001', `${path}.length`, 'expected a non-negative safe integer.');
  }
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string')
      invalid('BSC1001', `${path}[${String(key)}]`, 'symbol keys are not allowed.');
    if (key === 'length') continue;
    if (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= length) {
      invalid('BSC1001', `${path}.${key}`, 'unknown array field.');
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !('value' in descriptor)) {
      invalid('BSC1001', `${path}[${key}]`, 'accessors are not allowed.');
    }
  }
  const result: unknown[] = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (descriptor === undefined || !('value' in descriptor)) {
      invalid('BSC1001', `${path}[${index}]`, 'array holes and accessors are not allowed.');
    }
    result.push(descriptor.value);
  }
  context.ancestors.delete(value);
  return result;
}

function objectValue(value: unknown, path: string, context: ParseContext): JsonObject {
  const source = plainObject(value, path);
  context.nodes += 1;
  if (context.nodes > blueprintSchemaCatalogMaxNodes) {
    invalid('BSC1003', path, `node limit ${blueprintSchemaCatalogMaxNodes} exceeded.`);
  }
  ownKeys(source, path);
  return source;
}

function descriptor(
  value: unknown,
  path: string,
  context: ParseContext,
  depth: number,
): BlueprintSchemaDescriptor {
  if (depth > blueprintSchemaCatalogMaxDepth) {
    invalid('BSC1003', path, `depth limit ${blueprintSchemaCatalogMaxDepth} exceeded.`);
  }
  const source = objectValue(value, path, context);
  if (context.ancestors.has(source)) invalid('BSC1003', path, 'cyclic data is not allowed.');
  context.ancestors.add(source);
  try {
    const kind = stringValue(source.kind, `${path}.kind`);
    switch (kind) {
      case 'scalar':
        exactKeys(source, ['kind', 'name'], path);
        return { kind, name: stringValue(source.name, `${path}.name`) };
      case 'literal':
        exactKeys(source, ['kind', 'value'], path);
        return { kind, value: primitive(source.value, `${path}.value`) };
      case 'array': {
        exactKeys(source, ['kind', 'items'], path);
        return { kind, items: descriptor(source.items, `${path}.items`, context, depth + 1) };
      }
      case 'tuple': {
        exactKeys(source, ['kind', 'items'], path);
        const items = arrayValue(source.items, `${path}.items`, context).map((item, index) =>
          descriptor(item, `${path}.items[${index}]`, context, depth + 1),
        );
        return { kind, items };
      }
      case 'union': {
        exactKeys(source, ['kind', 'options'], path);
        const options = arrayValue(source.options, `${path}.options`, context).map((item, index) =>
          descriptor(item, `${path}.options[${index}]`, context, depth + 1),
        );
        if (options.length === 0)
          invalid('BSC1001', `${path}.options`, 'expected at least one option.');
        const serialized = options.map(sortedJson);
        if (new Set(serialized).size !== serialized.length) {
          invalid('BSC1001', `${path}.options`, 'expected unique options.');
        }
        return { kind, options };
      }
      case 'dictionary':
        exactKeys(source, ['kind', 'keys', 'values'], path);
        return {
          kind,
          keys: descriptor(source.keys, `${path}.keys`, context, depth + 1),
          values: descriptor(source.values, `${path}.values`, context, depth + 1),
        };
      case 'object': {
        exactKeys(source, ['kind', 'fields'], path);
        const fields = arrayValue(source.fields, `${path}.fields`, context).map((item, index) =>
          field(item, `${path}.fields[${index}]`, context, depth + 1),
        );
        const names = fields.map(({ name }) => name);
        if (new Set(names).size !== names.length)
          invalid('BSC1001', `${path}.fields`, 'expected unique field names.');
        return { kind, fields };
      }
      case 'reference':
        exactKeys(source, ['kind', 'name'], path);
        return { kind, name: stringValue(source.name, `${path}.name`) };
      default:
        invalid('BSC1000', `${path}.kind`, `unsupported descriptor kind ${JSON.stringify(kind)}.`);
    }
  } finally {
    context.ancestors.delete(source);
  }
}

function field(
  value: unknown,
  path: string,
  context: ParseContext,
  depth: number,
): BlueprintSchemaField {
  const source = objectValue(value, path, context);
  if (context.ancestors.has(source)) invalid('BSC1003', path, 'cyclic data is not allowed.');
  context.ancestors.add(source);
  try {
    exactKeys(source, ['name', 'type', 'optional', 'default', 'ownership'], path);
    const ownership = source.ownership;
    if (ownership !== undefined && ownership !== 'user' && ownership !== 'compiler') {
      invalid('BSC1001', `${path}.ownership`, 'expected user or compiler.');
    }
    return {
      name: stringValue(source.name, `${path}.name`),
      type: descriptor(source.type, `${path}.type`, context, depth),
      optional: booleanValue(source.optional, `${path}.optional`),
      ...(source.default === undefined
        ? {}
        : { default: primitive(source.default, `${path}.default`) }),
      ...(ownership === undefined ? {} : { ownership }),
    };
  } finally {
    context.ancestors.delete(source);
  }
}

function schemaSource(value: unknown, path: string) {
  const source = objectValue(value, path, { ancestors: new WeakSet(), nodes: 0 });
  exactKeys(
    source,
    ['snapshot', 'applicationVersion', 'apiVersion', 'runtimeSha256', 'prototypeSha256'],
    path,
  );
  const apiVersion = integerValue(source.apiVersion, `${path}.apiVersion`);
  return {
    snapshot: stringValue(source.snapshot, `${path}.snapshot`),
    applicationVersion: stringValue(source.applicationVersion, `${path}.applicationVersion`),
    apiVersion,
    runtimeSha256: digest(source.runtimeSha256, `${path}.runtimeSha256`),
    prototypeSha256: digest(source.prototypeSha256, `${path}.prototypeSha256`),
  };
}

function assertReviewedSourceIdentity(
  actual: BlueprintSchemaSourceIdentity,
  expected: BlueprintSchemaSourceIdentity,
): void {
  for (const key of sourceIdentityKeys) {
    if (actual[key] !== expected[key]) {
      invalid('BSC1000', `<catalog>.source.${key}`, 'does not match the expected source identity.');
    }
  }
}

function namedReference(value: unknown, path: string, context: ParseContext) {
  const source = objectValue(value, path, context);
  if (context.ancestors.has(source)) invalid('BSC1003', path, 'cyclic data is not allowed.');
  context.ancestors.add(source);
  try {
    exactKeys(source, ['name', 'type'], path);
    return {
      name: stringValue(source.name, `${path}.name`),
      type: descriptor(source.type, `${path}.type`, context, 0),
    };
  } finally {
    context.ancestors.delete(source);
  }
}

export function loadBlueprintSchemaCatalog(
  value: unknown,
  expectedSourceIdentity: BlueprintSchemaSourceIdentity = blueprintSchemaCatalogReviewedSourceIdentity,
): BlueprintSchemaCatalog {
  const context: ParseContext = { ancestors: new WeakSet(), nodes: 0 };
  const root = objectValue(value, '<catalog>', context);
  exactKeys(
    root,
    [
      'format',
      'version',
      'source',
      'counts',
      'common',
      'variants',
      'controlBehaviors',
      'references',
      'warning',
    ],
    '<catalog>',
  );
  if (root.format !== blueprintSchemaCatalogFormat) {
    invalid(
      'BSC1000',
      '<catalog>.format',
      `expected ${JSON.stringify(blueprintSchemaCatalogFormat)}.`,
    );
  }
  if (root.version !== blueprintSchemaCatalogVersion) {
    invalid(
      'BSC1000',
      '<catalog>.version',
      `unsupported catalog version ${JSON.stringify(root.version)}.`,
    );
  }
  const source = schemaSource(root.source, '<catalog>.source');
  assertReviewedSourceIdentity(source, expectedSourceIdentity);
  const countSource = objectValue(root.counts, '<catalog>.counts', context);
  exactKeys(
    countSource,
    ['entityVariants', 'controlBehaviors', 'referencedSchemas'],
    '<catalog>.counts',
  );
  const counts = {
    entityVariants: integerValue(countSource.entityVariants, '<catalog>.counts.entityVariants'),
    controlBehaviors: integerValue(
      countSource.controlBehaviors,
      '<catalog>.counts.controlBehaviors',
    ),
    referencedSchemas: integerValue(
      countSource.referencedSchemas,
      '<catalog>.counts.referencedSchemas',
    ),
  };
  const common = descriptor(root.common, '<catalog>.common', context, 0);
  if (common.kind !== 'object')
    invalid('BSC1001', '<catalog>.common', 'expected an object descriptor.');

  const variants = arrayValue(root.variants, '<catalog>.variants', context).map((item, index) => {
    const variant = objectValue(item, `<catalog>.variants[${index}]`, context);
    exactKeys(variant, ['name', 'fields', 'structuralStatus'], `<catalog>.variants[${index}]`);
    const fields = arrayValue(variant.fields, `<catalog>.variants[${index}].fields`, context).map(
      (entry, fieldIndex) =>
        field(entry, `<catalog>.variants[${index}].fields[${fieldIndex}]`, context, 0),
    );
    const names = fields.map(({ name }) => name);
    if (new Set(names).size !== names.length)
      invalid('BSC1001', `<catalog>.variants[${index}].fields`, 'expected unique field names.');
    if (variant.structuralStatus !== 'documented')
      invalid('BSC1001', `<catalog>.variants[${index}].structuralStatus`, 'expected documented.');
    return {
      name: stringValue(variant.name, `<catalog>.variants[${index}].name`),
      fields,
      structuralStatus: 'documented' as const,
    };
  });
  if (new Set(variants.map(({ name }) => name)).size !== variants.length)
    invalid('BSC1001', '<catalog>.variants', 'expected unique variant names.');

  const behaviors = arrayValue(root.controlBehaviors, '<catalog>.controlBehaviors', context).map(
    (item, index) => {
      const behavior = objectValue(item, `<catalog>.controlBehaviors[${index}]`, context);
      exactKeys(
        behavior,
        [
          'name',
          'blueprintType',
          'entityVariants',
          'schema',
          'structuralStatus',
          'implementationStatus',
          'nativeEvidenceStatus',
        ],
        `<catalog>.controlBehaviors[${index}]`,
      );
      const entityVariants = arrayValue(
        behavior.entityVariants,
        `<catalog>.controlBehaviors[${index}].entityVariants`,
        context,
      ).map((entry, variantIndex) =>
        stringValue(entry, `<catalog>.controlBehaviors[${index}].entityVariants[${variantIndex}]`),
      );
      if (new Set(entityVariants).size !== entityVariants.length)
        invalid(
          'BSC1001',
          `<catalog>.controlBehaviors[${index}].entityVariants`,
          'expected unique variant names.',
        );
      if (behavior.structuralStatus !== 'documented')
        invalid(
          'BSC1001',
          `<catalog>.controlBehaviors[${index}].structuralStatus`,
          'expected documented.',
        );
      if (behavior.implementationStatus !== 'unassessed-per-field')
        invalid(
          'BSC1001',
          `<catalog>.controlBehaviors[${index}].implementationStatus`,
          'unexpected implementation status.',
        );
      if (behavior.nativeEvidenceStatus !== 'not-captured-by-catalog')
        invalid(
          'BSC1001',
          `<catalog>.controlBehaviors[${index}].nativeEvidenceStatus`,
          'unexpected native evidence status.',
        );
      return {
        name: stringValue(behavior.name, `<catalog>.controlBehaviors[${index}].name`),
        blueprintType: stringValue(
          behavior.blueprintType,
          `<catalog>.controlBehaviors[${index}].blueprintType`,
        ),
        entityVariants,
        schema: descriptor(
          behavior.schema,
          `<catalog>.controlBehaviors[${index}].schema`,
          context,
          0,
        ),
        structuralStatus: 'documented' as const,
        implementationStatus: 'unassessed-per-field' as const,
        nativeEvidenceStatus: 'not-captured-by-catalog' as const,
      };
    },
  );
  if (new Set(behaviors.map(({ name }) => name)).size !== behaviors.length)
    invalid('BSC1001', '<catalog>.controlBehaviors', 'expected unique behavior names.');
  const references = arrayValue(root.references, '<catalog>.references', context).map(
    (item, index) => namedReference(item, `<catalog>.references[${index}]`, context),
  );
  if (new Set(references.map(({ name }) => name)).size !== references.length)
    invalid('BSC1001', '<catalog>.references', 'expected unique reference names.');

  const referencesByName = new Map(references.map((reference) => [reference.name, reference.type]));
  for (const [index, behavior] of behaviors.entries()) {
    const behaviorPath = `<catalog>.controlBehaviors[${index}]`;
    const referencedSchema = referencesByName.get(behavior.blueprintType);
    if (referencedSchema === undefined) {
      invalid(
        'BSC1004',
        `${behaviorPath}.blueprintType`,
        `must resolve to a named schema reference ${JSON.stringify(behavior.blueprintType)}.`,
      );
    }
    if (sortedJson(behavior.schema) !== sortedJson(referencedSchema)) {
      invalid(
        'BSC1002',
        `${behaviorPath}.schema`,
        `does not match references[${JSON.stringify(behavior.blueprintType)}].`,
      );
    }
    const expectedVariants = variants
      .filter((variant) =>
        variant.fields.some(
          (field) =>
            field.name === 'control_behavior' &&
            field.type.kind === 'reference' &&
            field.type.name === behavior.blueprintType,
        ),
      )
      .map((variant) => variant.name)
      .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
    if (JSON.stringify(behavior.entityVariants) !== JSON.stringify(expectedVariants)) {
      invalid(
        'BSC1002',
        `${behaviorPath}.entityVariants`,
        `does not match the catalog variants for ${JSON.stringify(behavior.blueprintType)}.`,
      );
    }
  }

  if (counts.entityVariants !== variants.length)
    invalid('BSC1002', '<catalog>.counts.entityVariants', 'does not match variants length.');
  if (counts.controlBehaviors !== behaviors.length)
    invalid(
      'BSC1002',
      '<catalog>.counts.controlBehaviors',
      'does not match controlBehaviors length.',
    );
  if (counts.referencedSchemas !== references.length)
    invalid('BSC1002', '<catalog>.counts.referencedSchemas', 'does not match references length.');
  const variantNames = new Set(variants.map(({ name }) => name));
  for (const behavior of behaviors) {
    for (const variantName of behavior.entityVariants) {
      if (!variantNames.has(variantName))
        invalid(
          'BSC1002',
          '<catalog>.controlBehaviors',
          `unknown entity variant ${JSON.stringify(variantName)}.`,
        );
    }
  }
  const referenceNames = new Set(references.map(({ name }) => name));
  const usedReferences = new Set<string>();
  function collect(value: BlueprintSchemaDescriptor): void {
    if (value.kind === 'reference') {
      usedReferences.add(value.name);
      return;
    }
    if (value.kind === 'array') collect(value.items);
    if (value.kind === 'tuple') value.items.forEach(collect);
    if (value.kind === 'union') value.options.forEach(collect);
    if (value.kind === 'dictionary') {
      collect(value.keys);
      collect(value.values);
    }
    if (value.kind === 'object') value.fields.forEach((entry) => collect(entry.type));
  }
  collect(common);
  variants.forEach((variant) => variant.fields.forEach((entry) => collect(entry.type)));
  behaviors.forEach((behavior) => collect(behavior.schema));
  references.forEach((reference) => collect(reference.type));
  for (const name of usedReferences) {
    if (!referenceNames.has(name))
      invalid('BSC1004', '<catalog>.references', `dangling reference ${JSON.stringify(name)}.`);
  }
  for (const variant of variants) {
    for (const entry of variant.fields) {
      if (
        entry.name === 'control_behavior' &&
        entry.type.kind === 'reference' &&
        !referenceNames.has(entry.type.name)
      ) {
        invalid(
          'BSC1004',
          '<catalog>.variants',
          `control_behavior references unknown schema ${JSON.stringify(entry.type.name)}.`,
        );
      }
    }
  }
  const result: BlueprintSchemaCatalog = {
    format: blueprintSchemaCatalogFormat,
    version: blueprintSchemaCatalogVersion,
    source,
    counts,
    common,
    variants,
    controlBehaviors: behaviors,
    references,
    warning: stringValue(root.warning, '<catalog>.warning'),
  };
  return deepFreeze(result);
}

export function loadBlueprintSchemaCatalogJson(source: string): BlueprintSchemaCatalog {
  if (new TextEncoder().encode(source).byteLength > blueprintSchemaCatalogMaxJsonBytes) {
    invalid('BSC1003', '<json>', `byte limit ${blueprintSchemaCatalogMaxJsonBytes} exceeded.`);
  }
  let value: unknown;
  try {
    value = JSON.parse(source) as unknown;
  } catch (error) {
    invalid(
      'BSC1001',
      '<json>',
      `invalid JSON${error instanceof Error ? `: ${error.message}` : '.'}`,
    );
  }
  return loadBlueprintSchemaCatalog(value);
}

export const blueprintSchemaCatalog = loadBlueprintSchemaCatalog(generatedCatalog);

import type {
  BlueprintSchemaDescriptor,
  ResolvedBlueprintEntitySchema,
} from '@comblang/prototypes';

export class BlueprintEntitySignalConversionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BlueprintEntitySignalConversionError';
  }
}

interface Conversion {
  readonly value: unknown;
  readonly changed: boolean;
}

interface DataEntries {
  readonly keys: readonly string[];
  readonly descriptors: ReadonlyMap<string, PropertyDescriptor>;
}

const unchanged = (value: unknown): Conversion => ({ value, changed: false });

function isObject(value: unknown): value is object {
  return typeof value === 'object' && value !== null;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!isObject(value) || Array.isArray(value)) return false;
  let prototype: object | null;
  try {
    prototype = Object.getPrototypeOf(value);
  } catch {
    return false;
  }
  return prototype === Object.prototype || prototype === null;
}

function ownDataEntries(value: object, ignoreSymbols = false): DataEntries | undefined {
  let keys: readonly PropertyKey[];
  try {
    keys = Reflect.ownKeys(value);
  } catch {
    return undefined;
  }
  const descriptors = new Map<string, PropertyDescriptor>();
  const stringKeys: string[] = [];
  for (const key of keys) {
    if (typeof key !== 'string') {
      if (ignoreSymbols) continue;
      return undefined;
    }
    if (Array.isArray(value) && key === 'length') continue;
    let descriptor: PropertyDescriptor | undefined;
    try {
      descriptor = Object.getOwnPropertyDescriptor(value, key);
    } catch {
      return undefined;
    }
    if (descriptor === undefined || !('value' in descriptor)) return undefined;
    stringKeys.push(key);
    descriptors.set(key, descriptor);
  }
  return { keys: stringKeys, descriptors };
}

function referenceDescriptor(
  name: string,
  schema: ResolvedBlueprintEntitySchema,
): BlueprintSchemaDescriptor | undefined {
  return schema.references.find((reference) => reference.name === name)?.type;
}

function hasSignalReference(
  descriptor: BlueprintSchemaDescriptor,
  schema: ResolvedBlueprintEntitySchema,
  visited: Set<string> = new Set(),
): boolean {
  if (descriptor.kind === 'reference') {
    if (descriptor.name === 'SignalID') return true;
    if (visited.has(descriptor.name)) return false;
    const referenced = referenceDescriptor(descriptor.name, schema);
    if (referenced === undefined) return false;
    visited.add(descriptor.name);
    const result = hasSignalReference(referenced, schema, visited);
    visited.delete(descriptor.name);
    return result;
  }
  if (descriptor.kind === 'array') return hasSignalReference(descriptor.items, schema, visited);
  if (descriptor.kind === 'tuple') {
    return descriptor.items.some((item) => hasSignalReference(item, schema, visited));
  }
  if (descriptor.kind === 'union') {
    return descriptor.options.some((option) => hasSignalReference(option, schema, visited));
  }
  if (descriptor.kind === 'dictionary') {
    return (
      hasSignalReference(descriptor.keys, schema, visited) ||
      hasSignalReference(descriptor.values, schema, visited)
    );
  }
  if (descriptor.kind === 'object') {
    return (
      descriptor.fields.some((field) => hasSignalReference(field.type, schema, visited)) ||
      descriptor.variant?.groups.some((group) =>
        group.fields.some((field) => hasSignalReference(field.type, schema, visited)),
      ) === true
    );
  }
  return false;
}

function detachedSignal(value: object, path: string): Conversion {
  const entries = ownDataEntries(value, true);
  if (entries === undefined) {
    throw new BlueprintEntitySignalConversionError(
      `${path}: Signal values must expose only data properties.`,
    );
  }
  const descriptors = ['type', 'name', 'quality'].map(
    (key) => [key, entries.descriptors.get(key)] as const,
  );
  if (descriptors[0]![1] === undefined || descriptors[1]![1] === undefined) {
    throw new BlueprintEntitySignalConversionError(
      `${path}: nominal Signal value is missing type or name data.`,
    );
  }
  const output = Object.create(null) as Record<string, unknown>;
  for (const [key, descriptor] of descriptors) {
    if (descriptor === undefined) continue;
    Object.defineProperty(output, key, {
      configurable: true,
      enumerable: true,
      value: descriptor.value,
      writable: true,
    });
  }
  return { value: Object.freeze(output), changed: true };
}

function isForeignSignalHandle(value: unknown): boolean {
  if (!isObject(value)) return false;
  let descriptor: PropertyDescriptor | undefined;
  try {
    descriptor = Object.getOwnPropertyDescriptor(value, Symbol.toPrimitive);
  } catch {
    return false;
  }
  return (
    descriptor !== undefined && 'value' in descriptor && typeof descriptor.value === 'function'
  );
}

function cloneRecord(
  value: Record<string, unknown>,
  entries: DataEntries,
  replacements: ReadonlyMap<string, unknown>,
): Record<string, unknown> {
  const output = Object.getPrototypeOf(value) === null ? Object.create(null) : {};
  for (const key of entries.keys) {
    const descriptor = entries.descriptors.get(key)!;
    Object.defineProperty(output, key, {
      configurable: true,
      enumerable: descriptor.enumerable ?? false,
      value: replacements.has(key) ? replacements.get(key) : descriptor.value,
      writable: true,
    });
  }
  return output as Record<string, unknown>;
}

function cloneArray(
  value: readonly unknown[],
  entries: DataEntries,
  replacements: ReadonlyMap<string, unknown>,
): readonly unknown[] {
  const lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length');
  if (lengthDescriptor === undefined || !('value' in lengthDescriptor)) return value;
  const output = new Array(lengthDescriptor.value as number);
  for (const key of entries.keys) {
    const descriptor = entries.descriptors.get(key)!;
    Object.defineProperty(output, key, {
      configurable: true,
      enumerable: descriptor.enumerable ?? false,
      value: replacements.has(key) ? replacements.get(key) : descriptor.value,
      writable: true,
    });
  }
  return output;
}

function detach(
  value: unknown,
  descriptor: BlueprintSchemaDescriptor,
  schema: ResolvedBlueprintEntitySchema,
  isSignal: (value: unknown) => boolean,
  path: string,
  ancestors: Set<object>,
): Conversion {
  if (descriptor.kind === 'reference') {
    const referenced = referenceDescriptor(descriptor.name, schema);
    if (referenced === undefined) return unchanged(value);
    if (descriptor.name === 'SignalID') {
      if (isSignal(value)) return detachedSignal(value as object, path);
      if (isForeignSignalHandle(value)) {
        throw new BlueprintEntitySignalConversionError(
          `${path}: Signal values must come from Signal(...) in this execution session or be plain Blueprint SignalID data.`,
        );
      }
      return unchanged(value);
    }
    return detach(value, referenced, schema, isSignal, path, ancestors);
  }
  if (descriptor.kind === 'scalar' || descriptor.kind === 'literal') {
    return unchanged(value);
  }
  if (isObject(value)) {
    if (ancestors.has(value)) return unchanged(value);
    ancestors.add(value);
  }
  try {
    if (descriptor.kind === 'array' || descriptor.kind === 'tuple') {
      if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype)
        return unchanged(value);
      const entries = ownDataEntries(value);
      if (entries === undefined) return unchanged(value);
      const replacements = new Map<string, unknown>();
      for (const key of entries.keys) {
        if (!/^(0|[1-9][0-9]*)$/.test(key)) continue;
        const index = Number(key);
        const item = descriptor.kind === 'array' ? descriptor.items : descriptor.items[index];
        if (item === undefined) continue;
        const child = detach(
          entries.descriptors.get(key)!.value,
          item,
          schema,
          isSignal,
          `${path}[${index}]`,
          ancestors,
        );
        if (child.changed) replacements.set(key, child.value);
      }
      return replacements.size === 0
        ? unchanged(value)
        : { value: cloneArray(value, entries, replacements), changed: true };
    }
    if (descriptor.kind === 'union') {
      const wasAncestor = isObject(value) && ancestors.delete(value);
      let current = value;
      let changed = false;
      try {
        for (const option of descriptor.options) {
          if (!hasSignalReference(option, schema)) continue;
          const child = detach(current, option, schema, isSignal, path, ancestors);
          if (!child.changed) continue;
          current = child.value;
          changed = true;
        }
      } finally {
        if (wasAncestor) ancestors.add(value);
      }
      return changed ? { value: current, changed: true } : unchanged(value);
    }
    if (descriptor.kind === 'dictionary') {
      if (!isPlainRecord(value)) return unchanged(value);
      const entries = ownDataEntries(value);
      if (entries === undefined) return unchanged(value);
      const replacements = new Map<string, unknown>();
      for (const key of entries.keys) {
        const child = detach(
          entries.descriptors.get(key)!.value,
          descriptor.values,
          schema,
          isSignal,
          `${path}.${key}`,
          ancestors,
        );
        if (child.changed) replacements.set(key, child.value);
      }
      return replacements.size === 0
        ? unchanged(value)
        : { value: cloneRecord(value, entries, replacements), changed: true };
    }
    if (descriptor.kind === 'object') {
      if (!isPlainRecord(value)) return unchanged(value);
      const entries = ownDataEntries(value);
      if (entries === undefined) return unchanged(value);
      const fields = new Map(descriptor.fields.map((field) => [field.name, field.type]));
      const variant = descriptor.variant;
      if (variant !== undefined) {
        const discriminator = entries.descriptors.get(variant.discriminator)?.value;
        const selected =
          (typeof discriminator === 'string' ? discriminator : variant.default) === undefined
            ? undefined
            : variant.groups.find(
                ({ value }) =>
                  value === (typeof discriminator === 'string' ? discriminator : variant.default),
              );
        selected?.fields.forEach((field) => fields.set(field.name, field.type));
      }
      const replacements = new Map<string, unknown>();
      for (const key of entries.keys) {
        const childDescriptor = fields.get(key);
        if (childDescriptor === undefined) continue;
        const child = detach(
          entries.descriptors.get(key)!.value,
          childDescriptor,
          schema,
          isSignal,
          `${path}.${key}`,
          ancestors,
        );
        if (child.changed) replacements.set(key, child.value);
      }
      return replacements.size === 0
        ? unchanged(value)
        : { value: cloneRecord(value, entries, replacements), changed: true };
    }
  } finally {
    if (isObject(value)) ancestors.delete(value);
  }
  return unchanged(value);
}

/** Copies only nominal source Signal handles into detached Blueprint SignalID data. */
export function detachBlueprintEntitySignalHandles(
  value: unknown,
  descriptor: BlueprintSchemaDescriptor,
  schema: ResolvedBlueprintEntitySchema,
  isSignal: (value: unknown) => boolean,
): unknown {
  return detach(value, descriptor, schema, isSignal, '$', new Set()).value;
}

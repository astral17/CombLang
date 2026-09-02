interface Container {
  readonly prototype: object | null;
  readonly array: boolean;
  readonly extensible: boolean;
  readonly descriptors: Record<PropertyKey, PropertyDescriptor>;
}

export interface ReturnValueGraph {
  /** Atomic handle occurrences, not deduplicated: two member slots may be a double move. */
  readonly handles: readonly object[];
  replace(handles: ReadonlyMap<object, unknown>): unknown;
}

/** Snapshot only own data edges. Accessors and non-plain objects remain opaque. */
export function inspectReturnValueGraph(
  root: unknown,
  isHandle: (value: object) => boolean,
): ReturnValueGraph {
  const containers = new Map<object, Container>();
  const parents = new Map<object, Set<object>>();
  const handles: object[] = [];
  const pending: unknown[] = [root];
  while (pending.length > 0) {
    const value = pending.pop();
    if (typeof value !== 'object' || value === null) continue;
    if (isHandle(value)) {
      handles.push(value);
      continue;
    }
    if (containers.has(value)) continue;
    const prototype: object | null = Object.getPrototypeOf(value);
    const array = Array.isArray(value);
    if (!array && prototype !== Object.prototype && prototype !== null) continue;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    containers.set(value, {
      prototype,
      array,
      descriptors,
      extensible: Object.isExtensible(value),
    });
    const children: unknown[] = [];
    for (const key of Reflect.ownKeys(descriptors)) {
      const descriptor = descriptors[key as keyof typeof descriptors]!;
      if (!('value' in descriptor)) continue;
      const child: unknown = descriptor.value;
      children.push(child);
      if (typeof child === 'object' && child !== null) {
        const owners = parents.get(child) ?? new Set<object>();
        owners.add(value);
        parents.set(child, owners);
      }
    }
    // Keep ordinary property traversal order for deterministic first-error selection.
    for (let index = children.length - 1; index >= 0; index--) pending.push(children[index]);
  }

  return {
    handles,
    replace(replacements) {
      const changed = new Set<object>();
      const pendingChanges: object[] = [];
      for (const [original, replacement] of replacements) {
        if (original !== replacement) pendingChanges.push(original);
      }
      for (let index = 0; index < pendingChanges.length; index++) {
        for (const parent of parents.get(pendingChanges[index]!) ?? []) {
          if (changed.has(parent)) continue;
          changed.add(parent);
          pendingChanges.push(parent);
        }
      }
      const copies = new Map<object, unknown>(replacements);
      for (const original of changed) {
        const container = containers.get(original)!;
        copies.set(
          original,
          container.array
            ? Object.setPrototypeOf([], container.prototype)
            : Object.create(container.prototype),
        );
      }
      const replace = (value: unknown): unknown =>
        typeof value === 'object' && value !== null && copies.has(value)
          ? copies.get(value)
          : value;
      for (const original of changed) {
        const container = containers.get(original)!;
        const descriptors: Record<PropertyKey, PropertyDescriptor> = Object.create(null);
        for (const key of Reflect.ownKeys(container.descriptors)) {
          const descriptor = container.descriptors[key]!;
          descriptors[key] =
            'value' in descriptor
              ? { ...descriptor, value: replace(descriptor.value) }
              : descriptor;
        }
        const copy = copies.get(original)!;
        Object.defineProperties(copy, descriptors);
        if (!container.extensible) Object.preventExtensions(copy);
      }
      return replace(root);
    },
  };
}

/**
 * Makes an independent, recursively immutable copy of a data-shaped value.
 *
 * v5 transport values are plain structured data. The WeakSet keeps the freeze
 * walk safe for cyclic input while structuredClone ensures caller-owned values
 * are never frozen or retained by the canonical result.
 */
export function cloneAndDeepFreeze<T>(value: T): T {
  const clone = structuredClone(value);
  const seen = new WeakSet<object>();

  const freeze = (candidate: unknown): void => {
    if (candidate === null || typeof candidate !== 'object' || seen.has(candidate)) return;
    seen.add(candidate);
    for (const key of Reflect.ownKeys(candidate)) {
      const descriptor = Object.getOwnPropertyDescriptor(candidate, key);
      if (descriptor !== undefined && 'value' in descriptor) freeze(descriptor.value);
    }
    Object.freeze(candidate);
  };

  freeze(clone);
  return clone;
}

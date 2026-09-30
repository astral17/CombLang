import { BlueprintParameterError } from './blueprint-parameters.js';

// Freeze only already validated, newly constructed internal configuration data.
// These helpers preserve nominal references; they do not clone or validate caller input.

/** Preserves the policy that already-frozen objects and their children are left alone. */
export function freezeConfigurationDataSkippingFrozen<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>))
      freezeConfigurationDataSkippingFrozen(child);
    Object.freeze(value);
  }
  return value;
}

/** Preserves the policy that children are traversed even beneath already-frozen objects. */
export function freezeConfigurationData<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value as Record<string, unknown>))
      freezeConfigurationData(child);
    if (!Object.isFrozen(value)) Object.freeze(value);
  }
  return value;
}

/** Relocates an expression error to its configuration slot without losing its diagnostic. */
export function prefixExpressionError(error: unknown, path: string): never {
  if (!(error instanceof BlueprintParameterError)) throw error;
  const suffix =
    error.path === '$' || error.path === '$.value'
      ? ''
      : error.path.startsWith('$')
        ? error.path.slice(1)
        : `.${error.path}`;
  const messagePrefix = `${error.path}: `;
  const message = error.message.startsWith(messagePrefix)
    ? error.message.slice(messagePrefix.length)
    : error.message;
  throw new BlueprintParameterError(error.code, `${path}${suffix}`, message, error.span);
}

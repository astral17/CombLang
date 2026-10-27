import type { SourceSpan } from '@comblang/shared';

import {
  assertBlueprintParameterFromSession,
  assertBlueprintParameterSessionOpen,
  BlueprintParameterError,
  canonicalBlueprintParameterHandle,
  type BlueprintParameterSession,
  type BlueprintSignalParameterHandle,
} from './blueprint-parameters.js';

declare const referenceBrand: unique symbol;

/** Opaque source reference to one local ingredient of an existing Signal parameter. */
export interface BlueprintRecipeIngredientReference {
  readonly [referenceBrand]: true;
}

export type BlueprintRecipeIngredientReferenceSlot = 'signal' | 'amount';

export interface RegisteredBlueprintRecipeIngredientReference {
  readonly reference: BlueprintRecipeIngredientReference;
  readonly session: BlueprintParameterSession;
  readonly parameter: BlueprintSignalParameterHandle;
  readonly index: number;
  readonly callSource: SourceSpan;
  readonly slot?: BlueprintRecipeIngredientReferenceSlot;
  readonly source: SourceSpan;
}

const rootReferences = new WeakMap<object, RegisteredBlueprintRecipeIngredientReference>();
const slotReferences = new WeakMap<object, RegisteredBlueprintRecipeIngredientReference>();

function fail(
  code: 'CP1000' | 'CP1001',
  path: string,
  message: string,
  source?: SourceSpan,
): never {
  throw new BlueprintParameterError(code, path, message, source);
}

function freezeSource(source: SourceSpan, path: string): SourceSpan {
  if (
    source === null ||
    typeof source !== 'object' ||
    typeof source.fileId !== 'string' ||
    source.fileId.length === 0 ||
    !Number.isSafeInteger(source.start) ||
    source.start < 0 ||
    !Number.isSafeInteger(source.end) ||
    source.end < source.start
  ) {
    fail('CP1000', path, 'expected a valid source span.');
  }
  return Object.freeze({ fileId: source.fileId, start: source.start, end: source.end });
}

function opaqueReference(source: SourceSpan, path: string): object {
  const reject = (): never =>
    fail(
      'CP1001',
      path,
      'recipe ingredient references are opaque and cannot be inspected or mutated.',
      source,
    );
  const rejectCoercion = (): never =>
    fail(
      'CP1001',
      path,
      'recipe ingredient references cannot be coerced to JavaScript primitives.',
      source,
    );
  return new Proxy(Object.freeze(Object.create(null) as object), {
    get: (_target, key) => (key === Symbol.toPrimitive ? rejectCoercion() : reject()),
    set: reject,
    has: reject,
    ownKeys: reject,
    getOwnPropertyDescriptor: reject,
    defineProperty: reject,
    deleteProperty: reject,
    getPrototypeOf: reject,
    setPrototypeOf: reject,
    isExtensible: reject,
    preventExtensions: reject,
  });
}

/** Creates two nominal derived leaves without registering additional parameters. */
export function createBlueprintRecipeIngredientReference(
  session: BlueprintParameterSession,
  handle: unknown,
  indexValue: unknown,
  sourceValue: SourceSpan,
): BlueprintRecipeIngredientReference {
  const source = freezeSource(sourceValue, '$.ingredient.source');
  assertBlueprintParameterSessionOpen(session, '$.ingredient.session');
  const registration = assertBlueprintParameterFromSession(
    session,
    handle,
    '$.ingredient.parameter',
  );
  const parameter = canonicalBlueprintParameterHandle(handle);
  if (parameter === undefined || registration.kind !== 'signal' || parameter.kind !== 'signal') {
    fail(
      'CP1001',
      '$.ingredient.parameter',
      'recipe ingredient references require an owning Signal parameter.',
      source,
    );
  }
  if (!Number.isSafeInteger(indexValue) || (indexValue as number) < 0) {
    fail(
      'CP1000',
      '$.ingredient.index',
      'expected a non-negative safe integer local ingredient index.',
      source,
    );
  }

  const reference = opaqueReference(source, '$.ingredient') as BlueprintRecipeIngredientReference;
  const base = {
    reference,
    session,
    parameter,
    index: indexValue as number,
    callSource: source,
  } as const;
  rootReferences.set(reference, Object.freeze({ ...base, source }));
  return reference;
}

/** Projects only the two supported fields and captures the actual source use span. */
export function projectBlueprintRecipeIngredientReference(
  value: unknown,
  key: unknown,
  sourceValue: SourceSpan,
): object | undefined {
  if ((typeof value !== 'object' && typeof value !== 'function') || value === null) {
    return undefined;
  }
  const registration = rootReferences.get(value);
  if (registration === undefined) return undefined;
  const source = freezeSource(sourceValue, '$.ingredient.use');
  if (key !== 'signal' && key !== 'amount') {
    fail(
      'CP1001',
      '$.ingredient.field',
      'recipe ingredient references expose only signal and amount fields.',
      source,
    );
  }
  const slot = key as BlueprintRecipeIngredientReferenceSlot;
  const leaf = opaqueReference(source, `$.ingredient.${slot}`);
  slotReferences.set(
    leaf,
    Object.freeze({
      ...registration,
      reference: leaf as BlueprintRecipeIngredientReference,
      slot,
      source,
    }),
  );
  return leaf;
}

/** Authenticates a root or projected leaf; copied and structurally similar objects are rejected. */
export function inspectBlueprintRecipeIngredientReference(
  value: unknown,
): RegisteredBlueprintRecipeIngredientReference | undefined {
  if ((typeof value !== 'object' && typeof value !== 'function') || value === null) {
    return undefined;
  }
  return slotReferences.get(value) ?? rootReferences.get(value);
}

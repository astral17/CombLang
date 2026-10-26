import { constantConfigurationLimits, type SignalId } from '@comblang/factorio';
import type { SourceSpan } from '@comblang/shared';
import type { PrototypeProvider } from '@comblang/prototypes';

import {
  assertBlueprintParameterFromSession,
  BlueprintParameterError,
  canonicalBlueprintParameterHandle,
  type BlueprintParameterHandle,
  type BlueprintParameterRegistration,
  type BlueprintParameterSession,
  type BlueprintSignalParameterHandle,
} from '../../compiler/src/blueprint-parameters.js';
import {
  assertBlueprintParameterNumberValue,
  canonicalizeBlueprintParameterSignal,
  readBlueprintParameterBindings,
} from '../../compiler/src/blueprint-parameter-validation.js';
import {
  selectRecipeIngredientFromRecipe,
  type RecipeIngredientSelection,
} from '../../prototypes/src/recipe-ingredient-selection.js';
import type { RecipePrototypeKey } from '../../prototypes/src/schema.js';

declare const dependencyBrand: unique symbol;

/** Opaque token that is nominally owned by one dependency context. */
export interface RecipeIngredientDependency {
  readonly [dependencyBrand]: true;
}

export type SuccessfulRecipeIngredientSelection = Extract<
  RecipeIngredientSelection,
  { readonly ok: true }
>;

export interface PresentRecipeIngredientDependency {
  readonly status: 'present';
  readonly dependency: RecipeIngredientDependency;
  readonly source: SourceSpan;
  readonly selection: SuccessfulRecipeIngredientSelection;
}

export interface AbsentRecipeIngredientDependency {
  readonly status: 'absent';
  readonly dependency: RecipeIngredientDependency;
  readonly source: SourceSpan;
  readonly recipe: RecipePrototypeKey;
  readonly index: number;
}

export type ResolvedRecipeIngredientDependency =
  PresentRecipeIngredientDependency | AbsentRecipeIngredientDependency;

export type RecipeIngredientDependencyFailureReason =
  'recipes-unavailable' | 'unknown-recipe' | 'invalid-index';

export class RecipeIngredientDependencyError extends Error {
  readonly reason: RecipeIngredientDependencyFailureReason;
  readonly path: string;
  readonly source: SourceSpan;

  constructor(reason: RecipeIngredientDependencyFailureReason, path: string, source: SourceSpan) {
    const detail =
      reason === 'recipes-unavailable'
        ? 'prototype provider does not provide recipe data.'
        : reason === 'unknown-recipe'
          ? 'no recipe has the exact selected Signal name.'
          : 'the selected local ingredient index is invalid.';
    super(`${path}: ${detail}`);
    this.name = 'RecipeIngredientDependencyError';
    this.reason = reason;
    this.path = path;
    this.source = source;
  }
}

export interface RecipeIngredientDependencyContext {
  readonly dependencies: readonly RecipeIngredientDependency[];
  readonly resolved: readonly ResolvedRecipeIngredientDependency[];
  dependency(
    handle: BlueprintSignalParameterHandle,
    index: number,
    source: SourceSpan,
  ): RecipeIngredientDependency;
  resolve(overrides?: unknown): readonly ResolvedRecipeIngredientDependency[];
  reset(): readonly ResolvedRecipeIngredientDependency[];
  resultFor(dependency: RecipeIngredientDependency): ResolvedRecipeIngredientDependency | undefined;
}

interface DependencyRegistration {
  readonly token: RecipeIngredientDependency;
  readonly handle: BlueprintSignalParameterHandle;
  readonly registration: BlueprintParameterRegistration;
  readonly index: number;
  readonly source: SourceSpan;
}

function fail(
  code: 'CP1000' | 'CP1001' | 'CP1002',
  path: string,
  message: string,
  source?: SourceSpan,
): never {
  throw new BlueprintParameterError(code, path, message, source);
}

function isObject(value: unknown): value is object {
  return (typeof value === 'object' && value !== null) || typeof value === 'function';
}

function canonicalSource(value: unknown, path: string): SourceSpan {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    fail('CP1000', path, 'expected a plain source span record.');
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    fail('CP1000', path, 'expected a plain source span record.');
  }
  const fields = Object.create(null) as Record<string, unknown>;
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string') fail('CP1000', path, 'source spans cannot have symbol fields.');
    if (key !== 'fileId' && key !== 'start' && key !== 'end') {
      fail('CP1000', `${path}.${key}`, 'unknown source span field.');
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
    if (!('value' in descriptor)) {
      fail('CP1000', `${path}.${key}`, 'source span accessors are not supported.');
    }
    if (!descriptor.enumerable) {
      fail('CP1000', `${path}.${key}`, 'source span fields must be enumerable.');
    }
    fields[key] = descriptor.value;
  }
  if (typeof fields.fileId !== 'string' || fields.fileId.length === 0) {
    fail('CP1000', `${path}.fileId`, 'expected a non-empty source file identity.');
  }
  if (!Number.isSafeInteger(fields.start) || (fields.start as number) < 0) {
    fail('CP1000', `${path}.start`, 'expected a non-negative safe integer.');
  }
  if (!Number.isSafeInteger(fields.end) || (fields.end as number) < (fields.start as number)) {
    fail('CP1000', `${path}.end`, 'expected a safe integer not before start.');
  }
  if (new TextEncoder().encode(fields.fileId).byteLength > constantConfigurationLimits.maxBytes) {
    fail(
      'CP1000',
      `${path}.fileId`,
      `source file identity exceeds the byte limit of ${constantConfigurationLimits.maxBytes}.`,
    );
  }
  return Object.freeze({
    fileId: fields.fileId as SourceSpan['fileId'],
    start: fields.start as number,
    end: fields.end as number,
  });
}

function bindingValue(
  value: unknown,
  registration: BlueprintParameterRegistration,
  path: string,
): number | SignalId {
  if (value === undefined) {
    fail('CP1000', path, 'override value cannot be undefined.', registration.source);
  }
  return registration.kind === 'number'
    ? assertBlueprintParameterNumberValue(value, path, 'finite', registration.source)
    : canonicalizeBlueprintParameterSignal(value, path, registration.source);
}

function authenticateParameter(
  session: BlueprintParameterSession,
  handle: unknown,
  path: string,
  source: SourceSpan,
): BlueprintParameterRegistration {
  try {
    return assertBlueprintParameterFromSession(session, handle, path);
  } catch (error) {
    if (!(error instanceof BlueprintParameterError)) throw error;
    const prefix = `${error.path}: `;
    const detail = error.message.startsWith(prefix)
      ? error.message.slice(prefix.length)
      : error.message;
    throw new BlueprintParameterError(error.code, error.path, detail, source);
  }
}

class RecipeIngredientDependencyContextImpl implements RecipeIngredientDependencyContext {
  readonly #session: BlueprintParameterSession;
  readonly #provider: PrototypeProvider;
  readonly #entries: DependencyRegistration[] = [];
  readonly #entriesByToken = new WeakMap<object, DependencyRegistration>();
  #nodes = 0;
  #bytes = 0;
  #resolved: readonly ResolvedRecipeIngredientDependency[] = Object.freeze([]);

  constructor(session: BlueprintParameterSession, provider: PrototypeProvider) {
    if (!Object.isFrozen(provider) || !Object.isFrozen(provider.capabilities)) {
      throw new TypeError('Recipe ingredient dependencies require a fixed immutable provider.');
    }
    this.#session = session;
    this.#provider = provider;
  }

  get dependencies(): readonly RecipeIngredientDependency[] {
    return Object.freeze(this.#entries.map(({ token }) => token));
  }

  get resolved(): readonly ResolvedRecipeIngredientDependency[] {
    return this.#resolved;
  }

  dependency(
    handleValue: BlueprintSignalParameterHandle,
    indexValue: number,
    sourceValue: SourceSpan,
  ): RecipeIngredientDependency {
    const source = canonicalSource(sourceValue, '$.dependency.source');
    if (!Number.isSafeInteger(indexValue) || indexValue < 0) {
      fail(
        'CP1000',
        '$.dependency.index',
        'expected a non-negative safe integer local ingredient index.',
        source,
      );
    }
    const registration = authenticateParameter(
      this.#session,
      handleValue,
      '$.dependency.parameter',
      source,
    );
    const handle = canonicalBlueprintParameterHandle(handleValue);
    if (handle === undefined) {
      fail(
        'CP1001',
        '$.dependency.parameter',
        'value is not a registered parameter handle.',
        source,
      );
    }
    if (registration.kind !== 'signal') {
      fail(
        'CP1001',
        '$.dependency.parameter',
        `expected a signal parameter, received ${registration.kind}.`,
        source,
      );
    }
    const nodes = 2;
    const bytes = new TextEncoder().encode(
      JSON.stringify({ index: indexValue, label: registration.label, source }),
    ).byteLength;
    if (nodes > constantConfigurationLimits.maxNodes - this.#nodes) {
      fail(
        'CP1000',
        '$.dependencies',
        `dependency registrations exceed the node limit of ${constantConfigurationLimits.maxNodes}.`,
        source,
      );
    }
    if (bytes > constantConfigurationLimits.maxBytes - this.#bytes) {
      fail(
        'CP1000',
        '$.dependencies',
        `dependency registrations exceed the byte limit of ${constantConfigurationLimits.maxBytes}.`,
        source,
      );
    }

    const token = Object.freeze(Object.create(null)) as RecipeIngredientDependency;
    const entry: DependencyRegistration = Object.freeze({
      token,
      handle: handle as BlueprintSignalParameterHandle,
      registration,
      index: indexValue,
      source,
    });
    this.#entriesByToken.set(token, entry);
    this.#entries.push(entry);
    this.#nodes += nodes;
    this.#bytes += bytes;
    return token;
  }

  resolve(overridesValue?: unknown): readonly ResolvedRecipeIngredientDependency[] {
    const parsed = readBlueprintParameterBindings(
      this.#session,
      overridesValue === undefined ? [] : overridesValue,
    );
    const overrides = new Map<BlueprintParameterHandle, number | SignalId>();
    for (const [index, binding] of parsed.entries()) {
      overrides.set(
        binding.parameter,
        bindingValue(binding.value, binding.registration, `$.bindings[${index}].value`),
      );
    }

    const next: ResolvedRecipeIngredientDependency[] = [];
    for (const [index, entry] of this.#entries.entries()) {
      const path = `$.dependencies[${index}]`;
      if (!this.#provider.capabilities.recipes) {
        throw new RecipeIngredientDependencyError('recipes-unavailable', path, entry.source);
      }
      const effectiveValue = overrides.get(entry.handle) ?? entry.registration.defaultValue;
      if (effectiveValue === undefined) {
        fail(
          'CP1002',
          `${path}.parameter`,
          `Signal parameter "${entry.registration.label}" has no default or override.`,
          entry.source,
        );
      }
      const signalValue = canonicalizeBlueprintParameterSignal(
        effectiveValue,
        `${path}.parameter`,
        entry.source,
      );
      const recipe = this.#provider.getRecipe(signalValue.name);
      if (recipe === undefined || recipe.name !== signalValue.name) {
        throw new RecipeIngredientDependencyError('unknown-recipe', `${path}.recipe`, entry.source);
      }
      const selection = selectRecipeIngredientFromRecipe(recipe, entry.index);
      if (!selection.ok) {
        if (selection.reason === 'ingredient-out-of-range') {
          next.push(
            Object.freeze({
              status: 'absent',
              dependency: entry.token,
              source: entry.source,
              recipe: recipe.key,
              index: entry.index,
            }),
          );
          continue;
        }
        throw new RecipeIngredientDependencyError(
          selection.reason,
          `${path}.selection`,
          entry.source,
        );
      }
      next.push(
        Object.freeze({
          status: 'present',
          dependency: entry.token,
          source: entry.source,
          selection,
        }),
      );
    }

    const committed = Object.freeze(next);
    this.#resolved = committed;
    return committed;
  }

  reset(): readonly ResolvedRecipeIngredientDependency[] {
    return this.resolve();
  }

  resultFor(
    dependency: RecipeIngredientDependency,
  ): ResolvedRecipeIngredientDependency | undefined {
    const entry = isObject(dependency) ? this.#entriesByToken.get(dependency) : undefined;
    if (entry === undefined) {
      fail('CP1001', '$.dependency', 'dependency token is not owned by this context.');
    }
    return this.#resolved.find(({ dependency: token }) => token === entry.token);
  }
}

/** Creates a host-only dependency registry over existing Signal declarations. */
export function createRecipeIngredientDependencyContext(
  session: BlueprintParameterSession,
  provider: PrototypeProvider,
): RecipeIngredientDependencyContext {
  return new RecipeIngredientDependencyContextImpl(session, provider);
}

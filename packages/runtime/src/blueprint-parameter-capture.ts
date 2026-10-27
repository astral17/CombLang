import { constantConfigurationLimits, type SignalId } from '@comblang/factorio';
import {
  assertBlueprintParameterFromSession,
  BlueprintParameterError,
  canonicalizeBlueprintNumberParameterMetadata,
  createBlueprintParameterSession,
  inspectBlueprintParameterHandle,
  sealBlueprintParameterSession,
  type BlueprintParameterHandle,
  type BlueprintParameterRegistration,
  type BlueprintParameterSession,
} from '../../compiler/src/blueprint-parameters.js';
import type { SourceSpan } from '@comblang/shared';
import { createBlueprintRecipeIngredientReference } from '../../compiler/src/blueprint-recipe-ingredient-reference.js';

export interface CapturedBlueprintParameter {
  readonly handle: BlueprintParameterHandle;
  readonly registration: BlueprintParameterRegistration;
}

/** Execution-local owner for source-declared parameters; never part of a Direct Plan. */
export class BlueprintParameterCapture {
  readonly session: BlueprintParameterSession = createBlueprintParameterSession();
  readonly #entries: CapturedBlueprintParameter[] = [];
  #bytes = 0;
  #nodes = 0;
  #sealed = false;

  number(
    label: unknown,
    defaultValue: unknown,
    metadata: unknown,
    source: SourceSpan,
  ): BlueprintParameterHandle {
    this.#assertOpen(source);
    this.#assertLabel(label, source);
    const canonicalMetadata = canonicalizeBlueprintNumberParameterMetadata(metadata, source);
    if (
      defaultValue !== undefined &&
      (typeof defaultValue !== 'number' || !Number.isFinite(defaultValue))
    ) {
      this.#fail('$.defaultValue', 'number defaults must be finite when supplied.', source);
    }
    return this.#register(
      this.session.number(label, {
        ...(defaultValue === undefined ? {} : { defaultValue }),
        source,
        ...(canonicalMetadata === undefined ? {} : { metadata: canonicalMetadata }),
      }),
      source,
    );
  }

  signal(
    label: unknown,
    defaultValue: SignalId | undefined,
    metadata: unknown,
    source: SourceSpan,
  ): BlueprintParameterHandle {
    this.#assertOpen(source);
    this.#assertLabel(label, source);
    this.#assertMetadata(metadata, source);
    return this.#register(
      this.session.signal(label, {
        ...(defaultValue === undefined ? {} : { defaultValue }),
        source,
      }),
      source,
    );
  }

  ingredientReference(handle: unknown, index: unknown, source: SourceSpan): object {
    this.#assertOpen(source);
    const registration = assertBlueprintParameterFromSession(
      this.session,
      handle,
      '$.ingredient.parameter',
    );
    if (registration.kind !== 'signal') {
      throw new BlueprintParameterError(
        'CP1001',
        '$.ingredient.parameter',
        `recipe ingredient references require a Signal parameter, received ${registration.kind}.`,
        source,
      );
    }
    if (!Number.isSafeInteger(index) || (index as number) < 0) {
      throw new BlueprintParameterError(
        'CP1000',
        '$.ingredient.index',
        'expected a non-negative safe integer local ingredient index.',
        source,
      );
    }
    const nodes = 3;
    const bytes = new TextEncoder().encode(
      JSON.stringify({ index, label: registration.label, source }),
    ).byteLength;
    if (nodes > constantConfigurationLimits.maxNodes - this.#nodes) {
      this.#fail(
        '$.parameters',
        `parameter and ingredient-reference capture exceeds the node limit of ${constantConfigurationLimits.maxNodes}.`,
        source,
      );
    }
    if (bytes > constantConfigurationLimits.maxBytes - this.#bytes) {
      this.#fail(
        '$.parameters',
        `parameter and ingredient-reference capture exceeds the byte limit of ${constantConfigurationLimits.maxBytes}.`,
        source,
      );
    }
    const reference = createBlueprintRecipeIngredientReference(this.session, handle, index, source);
    this.#nodes += nodes;
    this.#bytes += bytes;
    return reference;
  }

  seal(): void {
    this.#sealed = true;
    sealBlueprintParameterSession(this.session, '$.session');
  }

  declarations(): readonly CapturedBlueprintParameter[] {
    return Object.freeze([...this.#entries]);
  }

  #register(handle: BlueprintParameterHandle, source: SourceSpan): BlueprintParameterHandle {
    const registration = inspectBlueprintParameterHandle(handle, '$.parameter');
    const nodes =
      1 + (registration.metadata === undefined ? 0 : 1 + Object.keys(registration.metadata).length);
    if (nodes > constantConfigurationLimits.maxNodes - this.#nodes) {
      this.#fail(
        '$.parameters',
        `declarations exceed the node limit of ${constantConfigurationLimits.maxNodes}.`,
        source,
      );
    }
    const bytes = new TextEncoder().encode(JSON.stringify(registration)).byteLength;
    if (bytes > constantConfigurationLimits.maxBytes - this.#bytes) {
      this.#fail(
        '$.parameters',
        `declarations exceed the byte limit of ${constantConfigurationLimits.maxBytes}.`,
        source,
      );
    }
    this.#bytes += bytes;
    this.#nodes += nodes;
    this.#entries.push(Object.freeze({ handle, registration }));
    return handle;
  }

  #assertOpen(source: SourceSpan): void {
    if (this.#sealed) {
      this.#fail('$.parameters', 'the execution parameter capture is sealed.', source);
    }
  }

  #assertLabel(value: unknown, source: SourceSpan): asserts value is string {
    if (
      typeof value !== 'string' ||
      value.trim().length === 0 ||
      new TextEncoder().encode(value).byteLength > constantConfigurationLimits.maxBytes
    ) {
      this.#fail(
        '$.label',
        `expected a non-empty label within the ${constantConfigurationLimits.maxBytes}-byte limit.`,
        source,
      );
    }
  }

  #assertMetadata(value: unknown, source: SourceSpan): void {
    const metadata = canonicalizeBlueprintNumberParameterMetadata(value, source);
    if (metadata !== undefined) {
      this.#fail('$.metadata', 'Signal declarations do not support metadata fields.', source);
    }
  }

  #fail(path: string, message: string, source: SourceSpan): never {
    throw new BlueprintParameterError('CP1000', path, message, source);
  }
}

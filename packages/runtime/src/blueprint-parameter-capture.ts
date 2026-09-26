import { constantConfigurationLimits, type SignalId } from '@comblang/factorio';
import {
  BlueprintParameterError,
  createBlueprintParameterSession,
  inspectBlueprintParameterHandle,
  sealBlueprintParameterSession,
  type BlueprintParameterHandle,
  type BlueprintParameterRegistration,
  type BlueprintParameterSession,
} from '../../compiler/src/blueprint-parameters.js';
import type { SourceSpan } from '@comblang/shared';

export interface CapturedBlueprintParameter {
  readonly handle: BlueprintParameterHandle;
  readonly registration: BlueprintParameterRegistration;
}

/** Execution-local owner for source-declared parameters; never part of a Direct Plan. */
export class BlueprintParameterCapture {
  readonly session: BlueprintParameterSession = createBlueprintParameterSession();
  readonly #entries: CapturedBlueprintParameter[] = [];
  #bytes = 0;
  #sealed = false;

  number(
    label: unknown,
    defaultValue: unknown,
    metadata: unknown,
    source: SourceSpan,
  ): BlueprintParameterHandle {
    this.#assertOpen(source);
    this.#assertLabel(label, source);
    this.#assertMetadata(metadata, source);
    if (typeof defaultValue !== 'number' || !Number.isFinite(defaultValue)) {
      this.#fail(
        '$.defaultValue',
        'number declarations require a finite positional default.',
        source,
      );
    }
    return this.#register(this.session.number(label, { defaultValue, source }), source);
  }

  signal(
    label: unknown,
    defaultValue: SignalId,
    metadata: unknown,
    source: SourceSpan,
  ): BlueprintParameterHandle {
    this.#assertOpen(source);
    this.#assertLabel(label, source);
    this.#assertMetadata(metadata, source);
    return this.#register(this.session.signal(label, { defaultValue, source }), source);
  }

  seal(): void {
    this.#sealed = true;
    sealBlueprintParameterSession(this.session, '$.session');
  }

  declarations(): readonly CapturedBlueprintParameter[] {
    return Object.freeze([...this.#entries]);
  }

  #register(handle: BlueprintParameterHandle, source: SourceSpan): BlueprintParameterHandle {
    if (this.#entries.length >= constantConfigurationLimits.maxNodes) {
      this.#fail(
        '$.parameters',
        `declarations exceed the node limit of ${constantConfigurationLimits.maxNodes}.`,
        source,
      );
    }
    const registration = inspectBlueprintParameterHandle(handle, '$.parameter');
    const bytes = new TextEncoder().encode(JSON.stringify(registration)).byteLength;
    if (bytes > constantConfigurationLimits.maxBytes - this.#bytes) {
      this.#fail(
        '$.parameters',
        `declarations exceed the byte limit of ${constantConfigurationLimits.maxBytes}.`,
        source,
      );
    }
    this.#bytes += bytes;
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
    if (value === undefined) return;
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      this.#fail('$.metadata', 'expected an optional plain metadata record.', source);
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      this.#fail('$.metadata', 'expected an optional plain metadata record.', source);
    }
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== 'string') {
        this.#fail('$.metadata', 'metadata cannot contain symbol fields.', source);
      }
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined || !('value' in descriptor) || !descriptor.enumerable) {
        this.#fail(
          `$.metadata.${key}`,
          'metadata fields must be enumerable data properties.',
          source,
        );
      }
      this.#fail(`$.metadata.${key}`, 'parameter metadata fields are not supported yet.', source);
    }
  }

  #fail(path: string, message: string, source: SourceSpan): never {
    throw new BlueprintParameterError('CP1000', path, message, source);
  }
}

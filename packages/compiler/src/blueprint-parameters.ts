import {
  canonicalizeConstantConfiguration,
  constantConfigurationLimits,
  type SignalId,
} from '@comblang/factorio';
import type { SourceFileId, SourceSpan } from '@comblang/shared';

const parameterBrand: unique symbol = Symbol('blueprint-parameter');
const sessionBrand: unique symbol = Symbol('blueprint-parameter-session');

export type BlueprintParameterKind = 'number' | 'signal';

interface BlueprintParameterHandleBase<K extends BlueprintParameterKind> {
  readonly [parameterBrand]: K;
  readonly kind: K;
  readonly label: string;
  readonly source?: SourceSpan;
}

export interface BlueprintNumberParameterHandle extends BlueprintParameterHandleBase<'number'> {
  readonly defaultValue?: number;
}

export interface BlueprintSignalParameterHandle extends BlueprintParameterHandleBase<'signal'> {
  readonly defaultValue?: SignalId;
}

export type BlueprintParameterHandle =
  BlueprintNumberParameterHandle | BlueprintSignalParameterHandle;

export interface BlueprintParameterDeclarationOptions<T> {
  readonly defaultValue?: T;
  readonly source?: SourceSpan;
}

/** Native numeric strings are opaque metadata, not local expression nodes. */
export interface BlueprintNumberParameterMetadata {
  readonly variable?: string;
  readonly formula?: string;
  readonly dependent?: boolean;
}

export interface BlueprintNumberParameterDeclarationOptions extends BlueprintParameterDeclarationOptions<number> {
  readonly metadata?: BlueprintNumberParameterMetadata;
}

export interface BlueprintParameterSession {
  readonly [sessionBrand]: true;
  number(
    label: string,
    options?: BlueprintNumberParameterDeclarationOptions,
  ): BlueprintNumberParameterHandle;
  signal(
    label: string,
    options?: BlueprintParameterDeclarationOptions<SignalId>,
  ): BlueprintSignalParameterHandle;
}

export interface BlueprintParameterRegistration {
  readonly kind: BlueprintParameterKind;
  readonly label: string;
  readonly defaultValue?: number | SignalId;
  readonly source?: SourceSpan;
  readonly metadata?: BlueprintNumberParameterMetadata;
}

export type BlueprintParameterErrorCode = 'CP1000' | 'CP1001' | 'CP1002';

export class BlueprintParameterError extends Error {
  readonly code: BlueprintParameterErrorCode;
  readonly path: string;
  readonly span: SourceSpan | undefined;

  constructor(code: BlueprintParameterErrorCode, path: string, message: string, span?: SourceSpan) {
    super(`${path}: ${message}`);
    this.name = 'BlueprintParameterError';
    this.code = code;
    this.path = path;
    this.span = span;
  }
}

interface SessionAuthority {
  readonly identity: object;
  sealed: boolean;
}

interface RegisteredParameter {
  readonly authority: SessionAuthority;
  readonly declaration: BlueprintParameterRegistration;
}

interface RegisteredSourceView {
  readonly handle: BlueprintParameterHandle;
  readonly registration: RegisteredParameter;
}

const sessionAuthorities = new WeakMap<object, SessionAuthority>();
const parameterRegistrations = new WeakMap<object, RegisteredParameter>();
const parameterSourceViews = new WeakMap<object, RegisteredSourceView>();

function fail(
  code: BlueprintParameterErrorCode,
  path: string,
  message: string,
  span?: SourceSpan,
): never {
  throw new BlueprintParameterError(code, path, message, span);
}

function isObject(value: unknown): value is object {
  return (typeof value === 'object' && value !== null) || typeof value === 'function';
}

/** Descriptor-only validation and immutable snapshot under existing data limits. */
export function canonicalizeBlueprintNumberParameterMetadata(
  value: unknown,
  source?: SourceSpan,
): BlueprintNumberParameterMetadata | undefined {
  if (value === undefined) return undefined;
  const path = '$.metadata';
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    fail('CP1000', path, 'expected an optional plain metadata record.', source);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    fail('CP1000', path, 'expected an optional plain metadata record.', source);
  }
  const fields = new Map<string, string | boolean>();
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string')
      fail('CP1000', path, 'metadata cannot contain symbol fields.', source);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !('value' in descriptor) || !descriptor.enumerable) {
      fail(
        'CP1000',
        `${path}.${key}`,
        'metadata fields must be enumerable data properties.',
        source,
      );
    }
    if (key !== 'variable' && key !== 'formula' && key !== 'dependent') {
      fail('CP1000', `${path}.${key}`, 'unknown numeric metadata field.', source);
    }
    if (typeof descriptor.value !== (key === 'dependent' ? 'boolean' : 'string')) {
      fail(
        'CP1000',
        `${path}.${key}`,
        `expected a ${key === 'dependent' ? 'boolean' : 'string'}.`,
        source,
      );
    }
    fields.set(key, descriptor.value as string | boolean);
  }
  if (fields.size === 0) return undefined;
  const metadata = Object.freeze(
    Object.fromEntries(
      ['variable', 'formula', 'dependent']
        .filter((key) => fields.has(key))
        .map((key) => [key, fields.get(key)]),
    ),
  ) as BlueprintNumberParameterMetadata;
  if (
    new TextEncoder().encode(JSON.stringify(metadata)).byteLength >
    constantConfigurationLimits.maxBytes
  ) {
    fail(
      'CP1000',
      path,
      `metadata exceeds the byte limit of ${constantConfigurationLimits.maxBytes}.`,
      source,
    );
  }
  return metadata;
}

function optionMetadata(
  options: object,
  source?: SourceSpan,
): BlueprintNumberParameterMetadata | undefined {
  const descriptor = Object.getOwnPropertyDescriptor(options, 'metadata');
  if (descriptor === undefined) return undefined;
  if (!('value' in descriptor)) fail('CP1000', '$.metadata', 'accessors are not allowed.', source);
  return canonicalizeBlueprintNumberParameterMetadata(descriptor.value, source);
}

function canonicalSourceSpan(value: unknown): SourceSpan | undefined {
  if (value === undefined) return undefined;
  const path = '$.source';
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    fail('CP1000', path, 'expected a source span record.');
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    fail('CP1000', path, 'expected a plain source span record.');
  }
  const record = Object.create(null) as Record<string, unknown>;
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string') fail('CP1000', path, 'source spans cannot have symbol fields.');
    const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
    if (!('value' in descriptor)) fail('CP1000', `${path}.${key}`, 'accessors are not allowed.');
    if (!descriptor.enumerable) fail('CP1000', `${path}.${key}`, 'fields must be enumerable.');
    if (key !== 'fileId' && key !== 'start' && key !== 'end') {
      fail('CP1000', `${path}.${key}`, 'unknown source span field.');
    }
    record[key] = descriptor.value;
  }
  if (typeof record.fileId !== 'string' || record.fileId.length === 0) {
    fail('CP1000', `${path}.fileId`, 'expected a non-empty source file identity.');
  }
  if (!Number.isSafeInteger(record.start) || (record.start as number) < 0) {
    fail('CP1000', `${path}.start`, 'expected a non-negative safe integer.');
  }
  if (!Number.isSafeInteger(record.end) || (record.end as number) < (record.start as number)) {
    fail('CP1000', `${path}.end`, 'expected a safe integer not before start.');
  }
  return Object.freeze({
    fileId: record.fileId as SourceFileId,
    start: record.start as number,
    end: record.end as number,
  });
}

function canonicalSignalDefault(value: unknown, span?: SourceSpan): SignalId {
  try {
    const canonical = canonicalizeConstantConfiguration(
      {
        sections: [{ filters: [{ signal: value, value: 0 }] }],
      },
      undefined,
      '$.defaultValue',
    );
    return canonical.sections[0]!.filters[0]!.signal;
  } catch (error) {
    fail(
      'CP1000',
      '$.defaultValue',
      error instanceof Error ? error.message : 'invalid SignalID default.',
      span,
    );
  }
}

function assertLabel(label: unknown): asserts label is string {
  if (typeof label !== 'string' || label.length === 0) {
    fail('CP1000', '$.label', 'expected a non-empty display label.');
  }
}

function registerParameter<K extends BlueprintParameterKind>(
  authority: SessionAuthority,
  kind: K,
  label: string,
  defaultValue: number | SignalId | undefined,
  source: SourceSpan | undefined,
  metadata?: BlueprintNumberParameterMetadata,
): BlueprintParameterHandleBase<K> & { readonly defaultValue?: number | SignalId } {
  if (authority.sealed) {
    fail('CP1001', '$.session', 'parameter session is sealed and cannot accept declarations.');
  }
  const declaration = Object.freeze({
    kind,
    label,
    ...(defaultValue === undefined ? {} : { defaultValue }),
    ...(source === undefined ? {} : { source }),
    ...(metadata === undefined ? {} : { metadata }),
  }) as BlueprintParameterRegistration;
  const handle = {
    [parameterBrand]: kind,
    kind,
    label,
    ...(defaultValue === undefined ? {} : { defaultValue }),
    ...(source === undefined ? {} : { source }),
  } as BlueprintParameterHandleBase<K> & { readonly defaultValue?: number | SignalId };
  Object.defineProperty(handle, Symbol.toPrimitive, {
    enumerable: false,
    value: () => {
      throw new BlueprintParameterError(
        'CP1001',
        '$.parameter',
        'Blueprint parameter handles are symbolic configuration slots and cannot be coerced to JavaScript primitives.',
        source,
      );
    },
  });
  Object.freeze(handle);
  parameterRegistrations.set(handle, { authority, declaration });
  return handle;
}

/** Creates a nominal parameter scope; labels are descriptive, never identities. */
export function createBlueprintParameterSession(): BlueprintParameterSession {
  const authority: SessionAuthority = { identity: Object.freeze({}), sealed: false };
  const session = Object.freeze({
    [sessionBrand]: true as const,
    number: (label: string, options: BlueprintNumberParameterDeclarationOptions = {}) => {
      assertLabel(label);
      const source = canonicalSourceSpan(options.source);
      if (options.defaultValue !== undefined && !Number.isFinite(options.defaultValue)) {
        fail('CP1000', '$.defaultValue', 'number defaults must be finite.', source);
      }
      return registerParameter(
        authority,
        'number',
        label,
        options.defaultValue,
        source,
        optionMetadata(options, source),
      ) as BlueprintNumberParameterHandle;
    },
    signal: (label: string, options: BlueprintParameterDeclarationOptions<SignalId> = {}) => {
      assertLabel(label);
      const source = canonicalSourceSpan(options.source);
      if (optionMetadata(options, source) !== undefined) {
        fail('CP1000', '$.metadata', 'Signal declarations do not support metadata fields.', source);
      }
      const defaultValue =
        options.defaultValue === undefined
          ? undefined
          : canonicalSignalDefault(options.defaultValue, source);
      return registerParameter(
        authority,
        'signal',
        label,
        defaultValue,
        source,
      ) as BlueprintSignalParameterHandle;
    },
  }) as BlueprintParameterSession;
  sessionAuthorities.set(session, authority);
  return session;
}

/** Closes a host-owned session after its execution capture is complete. */
export function sealBlueprintParameterSession(session: unknown, path: string): void {
  assertBlueprintParameterSession(session, path);
  sessionAuthorities.get(session)!.sealed = true;
}

/** Returns declaration metadata only for the exact frozen handle registered by a session. */
export function inspectBlueprintParameterHandle(
  value: unknown,
  path: string,
): BlueprintParameterRegistration {
  if (!isObject(value)) fail('CP1001', path, 'value is not a registered parameter handle.');
  const registration = parameterRegistrations.get(value);
  if (registration === undefined) {
    fail('CP1001', path, 'value is not a registered parameter handle.');
  }
  return registration.declaration;
}

/** Creates the opaque object returned to source for one captured host declaration. */
export function createBlueprintParameterSourceView(session: unknown, handle: unknown): object {
  assertBlueprintParameterSession(session, '$.session');
  const registration = isObject(handle) ? parameterRegistrations.get(handle) : undefined;
  if (registration === undefined) {
    fail('CP1001', '$.parameter', 'value is not a registered host parameter handle.');
  }
  if (registration.authority !== sessionAuthorities.get(session)) {
    fail(
      'CP1001',
      '$.parameter',
      'parameter belongs to a different parameter session.',
      registration.declaration.source,
    );
  }

  const rejectAccess = (): never =>
    fail(
      'CP1001',
      '$.parameter',
      'source parameter views do not expose declaration properties or reflection.',
      registration.declaration.source,
    );
  const rejectCoercion = (): never =>
    fail(
      'CP1001',
      '$.parameter',
      'Blueprint parameter handles are symbolic configuration slots and cannot be coerced to JavaScript primitives.',
      registration.declaration.source,
    );
  const target = Object.freeze(Object.create(null) as object);
  const view = new Proxy(target, {
    get: (_target, key) => (key === Symbol.toPrimitive ? rejectCoercion() : rejectAccess()),
    set: rejectAccess,
    has: rejectAccess,
    ownKeys: rejectAccess,
    getOwnPropertyDescriptor: rejectAccess,
    defineProperty: rejectAccess,
    deleteProperty: rejectAccess,
    getPrototypeOf: rejectAccess,
    setPrototypeOf: rejectAccess,
    isExtensible: rejectAccess,
    preventExtensions: rejectAccess,
  });
  parameterSourceViews.set(view, { handle: handle as BlueprintParameterHandle, registration });
  return view;
}

/** Returns the original host handle for a registered source view or host handle. */
export function canonicalBlueprintParameterHandle(
  value: unknown,
): BlueprintParameterHandle | undefined {
  if (!isObject(value)) return undefined;
  const sourceView = parameterSourceViews.get(value);
  if (sourceView !== undefined) return sourceView.handle;
  return parameterRegistrations.has(value) ? (value as BlueprintParameterHandle) : undefined;
}

/** Non-throwing registry lookup for template normalization of concrete data vs handles. */
export function findBlueprintParameterHandle(
  value: unknown,
): BlueprintParameterRegistration | undefined {
  if (!isObject(value)) return undefined;
  return (parameterRegistrations.get(value) ?? parameterSourceViews.get(value)?.registration)
    ?.declaration;
}

export function assertBlueprintParameterSession(
  session: unknown,
  path: string,
): asserts session is object {
  if (!isObject(session) || !sessionAuthorities.has(session)) {
    fail('CP1001', path, 'value is not a registered parameter session.');
  }
}

/** Verifies that session-owned configuration nodes may still be constructed. */
export function assertBlueprintParameterSessionOpen(
  session: unknown,
  path: string,
): asserts session is object {
  assertBlueprintParameterSession(session, path);
  if (sessionAuthorities.get(session)!.sealed) {
    fail('CP1001', path, 'parameter session is sealed and cannot accept new expressions.');
  }
}

/** Verifies both declaration authenticity and ownership by the supplied session. */
export function assertBlueprintParameterFromSession(
  session: unknown,
  parameter: unknown,
  path: string,
): BlueprintParameterRegistration {
  assertBlueprintParameterSession(session, '$.session');
  const registration = isObject(parameter)
    ? (parameterRegistrations.get(parameter) ?? parameterSourceViews.get(parameter)?.registration)
    : undefined;
  if (registration === undefined) {
    fail('CP1001', path, 'value is not a registered parameter handle.');
  }
  if (registration.authority !== sessionAuthorities.get(session)) {
    fail(
      'CP1001',
      path,
      'parameter belongs to a different parameter session.',
      registration.declaration.source,
    );
  }
  return registration.declaration;
}

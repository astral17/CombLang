import { canonicalizeConstantConfiguration, type SignalId } from '@comblang/factorio';
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

export interface BlueprintParameterSession {
  readonly [sessionBrand]: true;
  number(
    label: string,
    options?: BlueprintParameterDeclarationOptions<number>,
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
}

interface RegisteredParameter {
  readonly authority: SessionAuthority;
  readonly declaration: BlueprintParameterRegistration;
}

const sessionAuthorities = new WeakMap<object, SessionAuthority>();
const parameterRegistrations = new WeakMap<object, RegisteredParameter>();

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
): BlueprintParameterHandleBase<K> & { readonly defaultValue?: number | SignalId } {
  const declaration = Object.freeze({
    kind,
    label,
    ...(defaultValue === undefined ? {} : { defaultValue }),
    ...(source === undefined ? {} : { source }),
  }) as BlueprintParameterRegistration;
  const handle = Object.freeze({
    [parameterBrand]: kind,
    kind,
    label,
    ...(defaultValue === undefined ? {} : { defaultValue }),
    ...(source === undefined ? {} : { source }),
  }) as BlueprintParameterHandleBase<K> & { readonly defaultValue?: number | SignalId };
  parameterRegistrations.set(handle, { authority, declaration });
  return handle;
}

/** Creates a nominal parameter scope; labels are descriptive, never identities. */
export function createBlueprintParameterSession(): BlueprintParameterSession {
  const authority: SessionAuthority = Object.freeze({ identity: Object.freeze({}) });
  const session = Object.freeze({
    [sessionBrand]: true as const,
    number: (label: string, options: BlueprintParameterDeclarationOptions<number> = {}) => {
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
      ) as BlueprintNumberParameterHandle;
    },
    signal: (label: string, options: BlueprintParameterDeclarationOptions<SignalId> = {}) => {
      assertLabel(label);
      const source = canonicalSourceSpan(options.source);
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

/** Non-throwing registry lookup for template normalization of concrete data vs handles. */
export function findBlueprintParameterHandle(
  value: unknown,
): BlueprintParameterRegistration | undefined {
  if (!isObject(value)) return undefined;
  return parameterRegistrations.get(value)?.declaration;
}

export function assertBlueprintParameterSession(
  session: unknown,
  path: string,
): asserts session is object {
  if (!isObject(session) || !sessionAuthorities.has(session)) {
    fail('CP1001', path, 'value is not a registered parameter session.');
  }
}

/** Verifies both declaration authenticity and ownership by the supplied session. */
export function assertBlueprintParameterFromSession(
  session: unknown,
  parameter: unknown,
  path: string,
): BlueprintParameterRegistration {
  assertBlueprintParameterSession(session, '$.session');
  const registration = isObject(parameter) ? parameterRegistrations.get(parameter) : undefined;
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

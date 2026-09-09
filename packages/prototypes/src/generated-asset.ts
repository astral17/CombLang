import { loadPrototypeInputJson, type LoadedPrototypeInput } from './input.js';
import { loadPrototypeDatabaseJson, type LoadedPrototypeEnvironment } from './provider.js';
import type { PrototypeDatabaseV1 } from './schema.js';

export const prototypeAssetSchemaVersion = 1 as const;
export const prototypeAssetKind = 'comblang-prototype-database-asset' as const;
export const prototypeAssetGeneratorVersion = 'comblang-prototype-asset-v1' as const;

const databaseIdentityPattern = /^comblang-prototypes-v1-sha256:[0-9a-f]{64}$/;
const digestPattern = /^sha256:[0-9a-f]{64}$/;

export interface PrototypeAssetManifestV1 {
  readonly kind: typeof prototypeAssetKind;
  readonly schemaVersion: typeof prototypeAssetSchemaVersion;
  readonly generatorVersion: typeof prototypeAssetGeneratorVersion;
  readonly databaseSchemaVersion: PrototypeDatabaseV1['schemaVersion'];
  readonly normalizedGeneratorVersion: string;
  readonly databaseIdentity: string;
  readonly input: {
    readonly rawDumpSha256: string;
    readonly metadataSha256: string;
  };
  /** SHA-256 of the exact generated database JSON bytes, excluding this manifest. */
  readonly outputSha256: string;
}

export interface GeneratedPrototypeAsset {
  readonly database: PrototypeDatabaseV1;
  readonly databaseJson: string;
  readonly manifest: PrototypeAssetManifestV1;
  readonly manifestJson: string;
  readonly warnings: LoadedPrototypeInput['warnings'];
}

export interface PrototypeAssetInputSources {
  readonly rawDumpSource?: string;
  readonly metadataSource?: string;
}

export interface LoadedPrototypeAsset extends LoadedPrototypeEnvironment {
  readonly manifest: PrototypeAssetManifestV1;
}

export class PrototypeAssetError extends Error {
  readonly code: 'PA1000' | 'PA1001' | 'PA1002' | 'PA1003' | 'PA1004' | 'PA1005' | 'PA1006';
  readonly path: string;

  constructor(code: PrototypeAssetError['code'], path: string, message: string) {
    super(`${path}: ${message}`);
    this.name = 'PrototypeAssetError';
    this.code = code;
    this.path = path;
  }
}

function invalid(code: PrototypeAssetError['code'], path: string, message: string): never {
  throw new PrototypeAssetError(code, path, message);
}

function object(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    invalid('PA1001', path, 'expected an object.');
  }
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[], path: string): void {
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!allowedSet.has(key)) invalid('PA1001', `${path}.${key}`, 'unknown field.');
  }
}

function exactString<T extends string>(value: unknown, expected: T, path: string): T {
  if (value !== expected) invalid('PA1001', path, `expected ${JSON.stringify(expected)}.`);
  return expected;
}

function nonEmptyString(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    invalid('PA1001', path, 'expected a non-empty string.');
  }
  return value;
}

function sha256(value: string): Promise<string> {
  return globalThis.crypto.subtle
    .digest('SHA-256', new TextEncoder().encode(value))
    .then((digest) => {
      const hex = [...new Uint8Array(digest)]
        .map((byte) => byte.toString(16).padStart(2, '0'))
        .join('');
      return `sha256:${hex}`;
    });
}

function digest(value: unknown, path: string): string {
  const result = nonEmptyString(value, path);
  if (!digestPattern.test(result)) invalid('PA1001', path, 'expected a SHA-256 digest.');
  return result;
}

function identity(value: unknown, path: string): string {
  const result = nonEmptyString(value, path);
  if (!databaseIdentityPattern.test(result)) {
    invalid('PA1001', path, 'expected a normalized prototype database identity.');
  }
  return result;
}

function schemaVersion(value: unknown, path: string): 1 {
  if (value !== prototypeAssetSchemaVersion) {
    invalid(
      'PA1000',
      path,
      `unsupported asset schema version ${JSON.stringify(value)}; expected ${prototypeAssetSchemaVersion}.`,
    );
  }
  return prototypeAssetSchemaVersion;
}

function parseManifest(value: unknown): PrototypeAssetManifestV1 {
  const input = object(value, '<manifest>');
  exactKeys(
    input,
    [
      'kind',
      'schemaVersion',
      'generatorVersion',
      'databaseSchemaVersion',
      'normalizedGeneratorVersion',
      'databaseIdentity',
      'input',
      'outputSha256',
    ],
    '<manifest>',
  );
  const nestedInput = object(input.input, 'input');
  exactKeys(nestedInput, ['rawDumpSha256', 'metadataSha256'], 'input');
  const databaseSchemaVersion = input.databaseSchemaVersion;
  if (databaseSchemaVersion !== 1) {
    invalid(
      'PA1000',
      'databaseSchemaVersion',
      `unsupported database schema version ${JSON.stringify(databaseSchemaVersion)}; expected 1.`,
    );
  }
  return Object.freeze({
    kind: exactString(input.kind, prototypeAssetKind, 'kind'),
    schemaVersion: schemaVersion(input.schemaVersion, 'schemaVersion'),
    generatorVersion: exactString(
      input.generatorVersion,
      prototypeAssetGeneratorVersion,
      'generatorVersion',
    ),
    databaseSchemaVersion,
    normalizedGeneratorVersion: nonEmptyString(
      input.normalizedGeneratorVersion,
      'normalizedGeneratorVersion',
    ),
    databaseIdentity: identity(input.databaseIdentity, 'databaseIdentity'),
    input: Object.freeze({
      rawDumpSha256: digest(nestedInput.rawDumpSha256, 'input.rawDumpSha256'),
      metadataSha256: digest(nestedInput.metadataSha256, 'input.metadataSha256'),
    }),
    outputSha256: digest(input.outputSha256, 'outputSha256'),
  });
}

function parseJson(source: string, path: string): unknown {
  try {
    return JSON.parse(source) as unknown;
  } catch (error) {
    invalid('PA1001', path, `invalid JSON${error instanceof Error ? `: ${error.message}` : '.'}`);
  }
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (typeof value !== 'object' || value === null) return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, child]) => [key, sortJson(child)]),
  );
}

function stringifyJson(value: unknown): string {
  return `${JSON.stringify(sortJson(value), null, 2)}\n`;
}

function parseManifestJson(source: string): PrototypeAssetManifestV1 {
  return parseManifest(parseJson(source, '<manifest>'));
}

/** Creates the deterministic database and provenance sidecar from explicit raw inputs. */
export async function generatePrototypeAsset(
  rawDumpSource: string,
  metadataSource: string,
): Promise<GeneratedPrototypeAsset> {
  const loaded = await loadPrototypeInputJson(rawDumpSource, {
    factorioDumpMetadata: metadataSource,
  });
  if (loaded.format !== 'factorio-data-raw') {
    throw new PrototypeAssetError(
      'PA1002',
      '<dump>',
      'prototype asset generation requires a recognized raw Factorio data dump.',
    );
  }
  const databaseJson = stringifyJson(loaded.database);
  const [rawDumpSha256, metadataSha256, outputSha256] = await Promise.all([
    sha256(rawDumpSource),
    sha256(metadataSource),
    sha256(databaseJson),
  ]);
  const manifest: PrototypeAssetManifestV1 = Object.freeze({
    kind: prototypeAssetKind,
    schemaVersion: prototypeAssetSchemaVersion,
    generatorVersion: prototypeAssetGeneratorVersion,
    databaseSchemaVersion: loaded.database.schemaVersion,
    normalizedGeneratorVersion: loaded.database.environment.generatorVersion,
    databaseIdentity: loaded.prototypes.identity,
    input: Object.freeze({ rawDumpSha256, metadataSha256 }),
    outputSha256,
  });
  return Object.freeze({
    database: loaded.database,
    databaseJson,
    manifest,
    manifestJson: stringifyJson(manifest),
    warnings: loaded.warnings,
  });
}

/** Loads a generated asset without requiring the original raw dump at runtime. */
export async function loadPrototypeAsset(
  databaseSource: string,
  manifestSource: string,
  inputSources: PrototypeAssetInputSources = {},
): Promise<LoadedPrototypeAsset> {
  const manifest = parseManifestJson(manifestSource);
  const loaded = await loadPrototypeDatabaseJson(databaseSource);
  if (loaded.database.schemaVersion !== manifest.databaseSchemaVersion) {
    invalid('PA1005', 'databaseSchemaVersion', 'database and manifest schema versions differ.');
  }
  if (loaded.database.environment.generatorVersion !== manifest.normalizedGeneratorVersion) {
    invalid(
      'PA1005',
      'normalizedGeneratorVersion',
      'database and manifest generator versions differ.',
    );
  }
  if (loaded.prototypes.identity !== manifest.databaseIdentity) {
    invalid('PA1005', 'databaseIdentity', 'database and manifest identities differ.');
  }
  if ((await sha256(databaseSource)) !== manifest.outputSha256) {
    invalid('PA1003', 'outputSha256', 'generated database bytes do not match the manifest.');
  }

  const hasRawDump = inputSources.rawDumpSource !== undefined;
  const hasMetadata = inputSources.metadataSource !== undefined;
  if (hasRawDump !== hasMetadata) {
    invalid('PA1004', 'input', 'raw dump and metadata sources must be supplied together.');
  }
  if (hasRawDump && hasMetadata) {
    const [rawDumpSha256, metadataSha256] = await Promise.all([
      sha256(inputSources.rawDumpSource!),
      sha256(inputSources.metadataSource!),
    ]);
    if (rawDumpSha256 !== manifest.input.rawDumpSha256) {
      invalid('PA1004', 'input.rawDumpSha256', 'raw dump bytes do not match the manifest.');
    }
    if (metadataSha256 !== manifest.input.metadataSha256) {
      invalid('PA1004', 'input.metadataSha256', 'metadata bytes do not match the manifest.');
    }
  }
  return Object.freeze({ ...loaded, manifest });
}

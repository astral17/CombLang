import {
  FactorioDumpError,
  normalizeFactorioDataDump,
  type FactorioDumpMetadata,
  type FactorioDumpWarning,
} from './factorio-dump.js';
import { loadPrototypeDatabase, type LoadedPrototypeEnvironment } from './provider.js';
import { factorioEntityPrototypeTypes } from './factorio-prototype-catalog.js';
import type { PrototypeMod } from './schema.js';
import { PrototypeValidationError, validatePrototypeStartupSettings } from './validation.js';

type JsonObject = Record<string, unknown>;

const rawTableNames = new Set([
  'fluid',
  'item',
  'quality',
  'recipe',
  'recipe-category',
  'virtual-signal',
  ...factorioEntityPrototypeTypes,
]);

export type PrototypeInputFormat = 'normalized' | 'factorio-data-raw';

export interface PrototypeInputOptions {
  /** Required when `source` is a recognized raw Factorio data dump. */
  readonly factorioDumpMetadata?: string | FactorioDumpMetadata;
}

export interface LoadedPrototypeInput extends LoadedPrototypeEnvironment {
  readonly format: PrototypeInputFormat;
  readonly warnings: readonly FactorioDumpWarning[];
}

export class PrototypeInputError extends Error {
  readonly code: 'PI1001' | 'PI1002' | 'PI1003';
  readonly path: string;

  constructor(code: 'PI1001' | 'PI1002' | 'PI1003', path: string, message: string) {
    super(`${path}: ${message}`);
    this.name = 'PrototypeInputError';
    this.code = code;
    this.path = path;
  }
}

function object(value: unknown, path: string): JsonObject {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new PrototypeInputError('PI1003', path, 'expected an object.');
  }
  return value as JsonObject;
}

function nonEmptyString(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new PrototypeInputError('PI1003', path, 'expected a non-empty string.');
  }
  return value;
}

function stringArray(value: unknown, path: string): readonly string[] {
  if (!Array.isArray(value)) {
    throw new PrototypeInputError('PI1003', path, 'expected an array.');
  }
  const values = value.map((entry, index) => nonEmptyString(entry, `${path}[${index}]`));
  if (new Set(values).size !== values.length) {
    throw new PrototypeInputError('PI1003', path, 'expected unique entries.');
  }
  return values;
}

function parseMetadata(value: string | FactorioDumpMetadata): FactorioDumpMetadata {
  let input: unknown = value;
  if (typeof value === 'string') {
    try {
      input = JSON.parse(value) as unknown;
    } catch (error) {
      throw new PrototypeInputError(
        'PI1003',
        'factorioDumpMetadata',
        `invalid JSON${error instanceof Error ? `: ${error.message}` : '.'}`,
      );
    }
  }
  const metadata = object(input, 'factorioDumpMetadata');
  const expansions = stringArray(metadata.expansions, 'factorioDumpMetadata.expansions');
  const rawMods = metadata.mods;
  if (!Array.isArray(rawMods)) {
    throw new PrototypeInputError('PI1003', 'factorioDumpMetadata.mods', 'expected an array.');
  }
  const mods: PrototypeMod[] = rawMods.map((raw, index) => {
    const path = `factorioDumpMetadata.mods[${index}]`;
    const mod = object(raw, path);
    return {
      name: nonEmptyString(mod.name, `${path}.name`),
      version: nonEmptyString(mod.version, `${path}.version`),
    };
  });
  if (new Set(mods.map(({ name }) => name)).size !== mods.length) {
    throw new PrototypeInputError(
      'PI1003',
      'factorioDumpMetadata.mods',
      'expected unique mod names.',
    );
  }
  const startupSettingsIdentity =
    metadata.startupSettingsIdentity === undefined
      ? undefined
      : nonEmptyString(
          metadata.startupSettingsIdentity,
          'factorioDumpMetadata.startupSettingsIdentity',
        );
  const startupSettings =
    metadata.startupSettings === undefined
      ? undefined
      : (() => {
          try {
            return validatePrototypeStartupSettings(
              metadata.startupSettings,
              'factorioDumpMetadata.startupSettings',
            );
          } catch (error) {
            const path =
              error instanceof PrototypeValidationError
                ? error.path
                : 'factorioDumpMetadata.startupSettings';
            const prefix = `${path}: `;
            const message =
              error instanceof Error && error.message.startsWith(prefix)
                ? error.message.slice(prefix.length)
                : error instanceof Error
                  ? error.message
                  : 'invalid startup settings.';
            throw new PrototypeInputError('PI1003', path, message);
          }
        })();
  const generatedAt =
    metadata.generatedAt === undefined
      ? undefined
      : nonEmptyString(metadata.generatedAt, 'factorioDumpMetadata.generatedAt');
  return Object.freeze({
    factorioVersion: nonEmptyString(
      metadata.factorioVersion,
      'factorioDumpMetadata.factorioVersion',
    ),
    expansions: Object.freeze([...expansions]),
    mods: Object.freeze(mods.map((mod) => Object.freeze(mod))),
    ...(startupSettingsIdentity === undefined ? {} : { startupSettingsIdentity }),
    ...(startupSettings === undefined ? {} : { startupSettings }),
    ...(generatedAt === undefined ? {} : { generatedAt }),
  });
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNormalizedCandidate(value: unknown): value is JsonObject {
  if (!isObject(value)) return false;
  return [
    'schemaVersion',
    'environment',
    'capabilities',
    'items',
    'fluids',
    'recipes',
    'entities',
    'qualities',
    'recipeCategories',
    'virtualSignals',
    'indexes',
  ].some((key) => Object.prototype.hasOwnProperty.call(value, key));
}

function rawDump(value: JsonObject): JsonObject | undefined {
  if (isObject(value.data) && Object.prototype.hasOwnProperty.call(value.data, 'raw')) {
    if (!isObject(value.data.raw)) {
      throw new FactorioDumpError('data.raw', 'expected an object.');
    }
    return value.data.raw;
  }
  const knownTable = Object.keys(value).some((key) => rawTableNames.has(key));
  return knownTable ? value : undefined;
}

export async function loadPrototypeInputJson(
  source: string,
  options: PrototypeInputOptions = {},
): Promise<LoadedPrototypeInput> {
  let value: unknown;
  try {
    value = JSON.parse(source) as unknown;
  } catch (error) {
    throw new PrototypeValidationError(
      'PT1006',
      '<json>',
      `invalid JSON${error instanceof Error ? `: ${error.message}` : '.'}`,
    );
  }

  if (isNormalizedCandidate(value)) {
    const loaded = await loadPrototypeDatabase(value);
    return Object.freeze({ ...loaded, format: 'normalized', warnings: Object.freeze([]) });
  }

  if (!isObject(value)) {
    throw new PrototypeInputError('PI1001', '<root>', 'unsupported prototype JSON format.');
  }
  const dump = rawDump(value);
  if (dump === undefined) {
    throw new PrototypeInputError('PI1001', '<root>', 'unsupported prototype JSON format.');
  }
  if (options.factorioDumpMetadata === undefined) {
    throw new PrototypeInputError(
      'PI1002',
      'factorioDumpMetadata',
      'raw Factorio data dump requires companion metadata JSON.',
    );
  }
  const metadata = parseMetadata(options.factorioDumpMetadata);
  let normalized;
  try {
    normalized = normalizeFactorioDataDump(dump, metadata);
  } catch (error) {
    if (error instanceof FactorioDumpError) throw error;
    throw error;
  }
  const loaded = await loadPrototypeDatabase(normalized.database);
  return Object.freeze({
    ...loaded,
    format: 'factorio-data-raw',
    warnings: normalized.warnings,
  });
}

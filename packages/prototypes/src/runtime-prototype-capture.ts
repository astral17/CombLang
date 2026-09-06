export type RuntimeCaptureJson =
  | null
  | boolean
  | number
  | string
  | readonly RuntimeCaptureJson[]
  | { readonly [key: string]: RuntimeCaptureJson };

export type RuntimeCaptureOutcome =
  | { readonly status: 'value'; readonly value: RuntimeCaptureJson }
  | { readonly status: 'absent' }
  | { readonly status: 'unknown'; readonly reason: string }
  | { readonly status: 'error'; readonly message: string };

export interface RuntimePrototypeCaptureRecord {
  readonly key: string;
  readonly name: string;
  readonly type: string;
  readonly facts: Readonly<Record<string, RuntimeCaptureOutcome>>;
}

export interface RuntimePrototypeCapture {
  readonly schemaVersion: 1;
  readonly kind: 'comblang-runtime-prototype-snapshot';
  readonly collectorVersion: string;
  readonly apiReference: {
    readonly applicationVersion: string;
    readonly apiVersion: number;
    readonly runtimeSha256: string;
    readonly prototypeSha256: string;
  };
  readonly environment: {
    readonly factorioVersion: string;
    readonly mods: readonly { readonly name: string; readonly version: string }[];
    readonly startupSettings: readonly {
      readonly name: string;
      readonly outcome: RuntimeCaptureOutcome;
    }[];
  };
  readonly collections: {
    readonly items: readonly RuntimePrototypeCaptureRecord[];
    readonly fluids: readonly RuntimePrototypeCaptureRecord[];
    readonly recipes: readonly RuntimePrototypeCaptureRecord[];
    readonly entities: readonly RuntimePrototypeCaptureRecord[];
    readonly qualities: readonly RuntimePrototypeCaptureRecord[];
    readonly recipeCategories: readonly RuntimePrototypeCaptureRecord[];
  };
  readonly limits: Readonly<Record<string, RuntimeCaptureOutcome>>;
}

export class RuntimePrototypeCaptureError extends Error {
  constructor(
    readonly path: string,
    message: string,
  ) {
    super(`${path}: ${message}`);
    this.name = 'RuntimePrototypeCaptureError';
  }
  readonly code = 'PR1001';
}

const MAX_COLLECTION_RECORDS = 1_000_000;
const MAX_JSON_DEPTH = 24;
const MAX_OBJECT_MEMBERS = 10_000;
const SHA256 = /^[0-9a-f]{64}$/;

function invalid(path: string, message: string): never {
  throw new RuntimePrototypeCaptureError(path, message);
}

function object(value: unknown, path: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    invalid(path, 'expected an object.');
  return value as Record<string, unknown>;
}

function string(value: unknown, path: string, allowEmpty = false): string {
  if (typeof value !== 'string' || (!allowEmpty && value.length === 0))
    invalid(path, 'expected a string.');
  return value;
}

function array(value: unknown, path: string): readonly unknown[] {
  if (Array.isArray(value)) return value;
  // Factorio serializes an empty Lua table as an empty object.
  if (value !== null && typeof value === 'object' && Object.keys(value).length === 0) return [];
  return invalid(path, 'expected an array or empty Lua-table sentinel.');
}

function freezeJson(value: unknown, path: string, depth = 0): RuntimeCaptureJson {
  if (depth > MAX_JSON_DEPTH) invalid(path, 'JSON value is too deeply nested.');
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) invalid(path, 'expected a finite JSON number.');
    return value;
  }
  if (Array.isArray(value)) {
    if (value.length > MAX_OBJECT_MEMBERS) invalid(path, 'JSON array is too large.');
    return Object.freeze(
      value.map((entry, index) => freezeJson(entry, `${path}[${index}]`, depth + 1)),
    );
  }
  const input = object(value, path);
  const entries = Object.entries(input);
  if (entries.length > MAX_OBJECT_MEMBERS) invalid(path, 'JSON object is too large.');
  return Object.freeze(
    Object.fromEntries(
      entries.map(([key, entry]) => [key, freezeJson(entry, `${path}.${key}`, depth + 1)]),
    ),
  );
}

function noFields(input: Record<string, unknown>, names: readonly string[], path: string) {
  for (const name of names) {
    if (input[name] !== undefined) invalid(`${path}.${name}`, 'not valid for this status.');
  }
}

function parseOutcome(value: unknown, path: string): RuntimeCaptureOutcome {
  const input = object(value, path);
  switch (input.status) {
    case 'value':
      noFields(input, ['reason', 'message'], path);
      if (!Object.hasOwn(input, 'value')) invalid(`${path}.value`, 'is required.');
      return Object.freeze({
        status: 'value',
        value: freezeJson(input.value, `${path}.value`),
      });
    case 'absent':
      noFields(input, ['value', 'reason', 'message'], path);
      return Object.freeze({ status: 'absent' });
    case 'unknown':
      noFields(input, ['value', 'message'], path);
      return Object.freeze({
        status: 'unknown',
        reason: string(input.reason, `${path}.reason`, true),
      });
    case 'error':
      noFields(input, ['value', 'reason'], path);
      return Object.freeze({
        status: 'error',
        message: string(input.message, `${path}.message`, true),
      });
    default:
      return invalid(`${path}.status`, 'unknown capture outcome status.');
  }
}

function parseNamedEntries<T extends { readonly name: string }>(
  value: unknown,
  path: string,
  parse: (entry: unknown, path: string) => T,
): readonly T[] {
  const values = array(value, path);
  if (values.length > MAX_COLLECTION_RECORDS) invalid(path, 'collection is too large.');
  const parsed = values.map((entry, index) => parse(entry, `${path}[${index}]`));
  if (new Set(parsed.map(({ name }) => name)).size !== parsed.length)
    invalid(path, 'duplicate names.');
  return Object.freeze(parsed);
}

function parseFacts(value: unknown, path: string) {
  const input = object(value, path);
  if (Object.keys(input).length > MAX_OBJECT_MEMBERS) invalid(path, 'too many facts.');
  return Object.freeze(
    Object.fromEntries(
      Object.entries(input).map(([name, outcome]) => [
        name,
        parseOutcome(outcome, `${path}.${name}`),
      ]),
    ),
  );
}

function parseRecords(value: unknown, path: string, keyPrefix: string) {
  const records = parseNamedEntries(value, path, (entry, entryPath) => {
    const input = object(entry, entryPath);
    const name = string(input.name, `${entryPath}.name`);
    const key = string(input.key, `${entryPath}.key`);
    if (key !== `${keyPrefix}:${name}`)
      invalid(`${entryPath}.key`, `expected ${JSON.stringify(`${keyPrefix}:${name}`)}.`);
    return Object.freeze({
      key,
      name,
      type: string(input.type, `${entryPath}.type`),
      facts: parseFacts(input.facts, `${entryPath}.facts`),
    });
  });
  if (new Set(records.map(({ key }) => key)).size !== records.length)
    invalid(path, 'duplicate keys.');
  return records;
}

/** Validates a single complete exporter artifact without normalizing it into Prototype DB facts. */
export function parseRuntimePrototypeCaptureJson(source: string): RuntimePrototypeCapture {
  let value: unknown;
  try {
    value = JSON.parse(source.replace(/^\uFEFF/, '')) as unknown;
  } catch {
    throw new RuntimePrototypeCaptureError('<json>', 'invalid capture JSON.');
  }
  const input = object(value, '<capture>');
  if (input.schemaVersion !== 1 || input.kind !== 'comblang-runtime-prototype-snapshot')
    invalid('<capture>', 'expected runtime prototype snapshot schema version 1.');
  const collectorVersion = string(input.collectorVersion, 'collectorVersion');
  const api = object(input.apiReference, 'apiReference');
  const apiVersion = api.apiVersion;
  if (!Number.isSafeInteger(apiVersion) || (apiVersion as number) < 0)
    invalid('apiReference.apiVersion', 'expected a non-negative safe integer.');
  const runtimeSha256 = string(api.runtimeSha256, 'apiReference.runtimeSha256');
  const prototypeSha256 = string(api.prototypeSha256, 'apiReference.prototypeSha256');
  if (!SHA256.test(runtimeSha256)) invalid('apiReference.runtimeSha256', 'expected SHA-256.');
  if (!SHA256.test(prototypeSha256)) invalid('apiReference.prototypeSha256', 'expected SHA-256.');

  const environment = object(input.environment, 'environment');
  const factorioVersion = string(environment.factorioVersion, 'environment.factorioVersion');
  const mods = parseNamedEntries(environment.mods, 'environment.mods', (entry, path) => {
    const mod = object(entry, path);
    return Object.freeze({
      name: string(mod.name, `${path}.name`),
      version: string(mod.version, `${path}.version`),
    });
  });
  if (mods.find(({ name }) => name === 'base')?.version !== factorioVersion)
    invalid('environment.mods', 'base mod must match factorioVersion.');
  if (
    mods.find(({ name }) => name === 'comblang-runtime-prototype-exporter')?.version !==
    collectorVersion
  )
    invalid('environment.mods', 'collector mod must match collectorVersion.');
  const startupSettings = parseNamedEntries(
    environment.startupSettings,
    'environment.startupSettings',
    (entry, path) => {
      const setting = object(entry, path);
      return Object.freeze({
        name: string(setting.name, `${path}.name`),
        outcome: parseOutcome(setting.outcome, `${path}.outcome`),
      });
    },
  );

  const collections = object(input.collections, 'collections');
  const result = Object.freeze({
    schemaVersion: 1 as const,
    kind: 'comblang-runtime-prototype-snapshot' as const,
    collectorVersion,
    apiReference: Object.freeze({
      applicationVersion: string(api.applicationVersion, 'apiReference.applicationVersion'),
      apiVersion: apiVersion as number,
      runtimeSha256,
      prototypeSha256,
    }),
    environment: Object.freeze({ factorioVersion, mods, startupSettings }),
    collections: Object.freeze({
      items: parseRecords(collections.items, 'collections.items', 'item'),
      fluids: parseRecords(collections.fluids, 'collections.fluids', 'fluid'),
      recipes: parseRecords(collections.recipes, 'collections.recipes', 'recipe'),
      entities: parseRecords(collections.entities, 'collections.entities', 'entity'),
      qualities: parseRecords(collections.qualities, 'collections.qualities', 'quality'),
      recipeCategories: parseRecords(
        collections.recipeCategories,
        'collections.recipeCategories',
        'recipe-category',
      ),
    }),
    limits: parseFacts(input.limits, 'limits'),
  });
  return result;
}

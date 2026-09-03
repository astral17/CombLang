import type { PrototypeStartupSetting } from './schema.js';
import { PrototypeValidationError, validatePrototypeStartupSettings } from './validation.js';

/** Raw instance observations must never be treated as prototype capability assertions. */
export type CircuitFieldObservation =
  | { readonly name: string; readonly status: 'value'; readonly value: boolean | number | string }
  | { readonly name: string; readonly status: 'absent' }
  | {
      readonly name: string;
      readonly status: 'error' | 'unexpected-type';
      readonly message: string;
    };

export interface CircuitObservation {
  readonly schemaVersion: 1;
  readonly kind: 'comblang-circuit-observation';
  readonly probeVersion: string;
  readonly label: string;
  /** Decimal strings retain uint64 ticks/identifiers without JS number rounding. */
  readonly tick: string;
  readonly playerIndex: number;
  readonly environment: {
    readonly factorioVersion: string;
    readonly mods: readonly { readonly name: string; readonly version: string }[];
    readonly startupSettings: readonly PrototypeStartupSetting[];
  };
  readonly entity: {
    readonly key: `entity:${string}`;
    readonly type: string;
    readonly unitNumber?: string;
    readonly surface: string;
    readonly position: { readonly x: number; readonly y: number };
  };
  readonly behavior:
    | { readonly status: 'present'; readonly fields: readonly CircuitFieldObservation[] }
    | { readonly status: 'absent' }
    | { readonly status: 'error'; readonly message: string };
}

export class CircuitObservationError extends Error {
  constructor(
    readonly line: number,
    readonly path: string,
    message: string,
  ) {
    super(`line ${line}, ${path}: ${message}`);
    this.name = 'CircuitObservationError';
  }
  readonly code = 'PO1001';
}

function parseObservation(value: unknown, line: number): CircuitObservation {
  function invalid(path: string, message: string): never {
    throw new CircuitObservationError(line, path, message);
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
  function finite(value: unknown, path: string): number {
    if (typeof value !== 'number' || !Number.isFinite(value))
      invalid(path, 'expected a finite number.');
    return value;
  }
  function uint64(value: unknown, path: string): string {
    const text = string(value, path);
    if (!/^(0|[1-9][0-9]*)$/.test(text) || text.length > 20 || BigInt(text) > 18446744073709551615n)
      invalid(path, 'expected a decimal uint64 string.');
    return text;
  }
  function array(value: unknown, path: string): readonly unknown[] {
    if (Array.isArray(value)) return value;
    // Factorio serializes an empty Lua table as {}.
    if (value !== null && typeof value === 'object' && Object.keys(value).length === 0) return [];
    return invalid(path, 'expected an array or empty Lua-table sentinel.');
  }
  function named<T extends { readonly name: string }>(
    values: readonly T[],
    path: string,
  ): readonly T[] {
    if (new Set(values.map(({ name }) => name)).size !== values.length)
      invalid(path, 'duplicate names.');
    return Object.freeze(values);
  }
  function noFields(input: Record<string, unknown>, names: readonly string[], path: string) {
    for (const name of names)
      if (input[name] !== undefined)
        invalid(`${path}.${name}`, 'not valid for this observation status.');
  }
  const input = object(value, '<observation>');
  if (input.schemaVersion !== 1 || input.kind !== 'comblang-circuit-observation')
    invalid('<observation>', 'expected circuit observation schema version 1 and kind.');
  const environment = object(input.environment, 'environment');
  const mods = named(
    array(environment.mods, 'environment.mods').map((value, index) => {
      const path = `environment.mods[${index}]`;
      const entry = object(value, path);
      return Object.freeze({
        name: string(entry.name, `${path}.name`),
        version: string(entry.version, `${path}.version`),
      });
    }),
    'environment.mods',
  );
  const factorioVersion = string(environment.factorioVersion, 'environment.factorioVersion');
  const probeVersion = string(input.probeVersion, 'probeVersion');
  if (mods.find(({ name }) => name === 'base')?.version !== factorioVersion)
    invalid('environment.mods', 'base mod must match factorioVersion.');
  if (mods.find(({ name }) => name === 'comblang-circuit-probe')?.version !== probeVersion)
    invalid('environment.mods', 'collector mod must match probeVersion.');
  let startupSettings: readonly PrototypeStartupSetting[];
  try {
    startupSettings = validatePrototypeStartupSettings(
      array(environment.startupSettings, 'environment.startupSettings'),
    );
  } catch (error) {
    if (error instanceof PrototypeValidationError)
      invalid(error.path, error.message.slice(error.path.length + 2));
    throw error;
  }
  const entity = object(input.entity, 'entity');
  const key = string(entity.key, 'entity.key');
  if (!key.startsWith('entity:') || key.length === 7)
    invalid('entity.key', 'expected an entity: key.');
  const position = object(entity.position, 'entity.position');
  const rawBehavior = object(input.behavior, 'behavior');
  let behavior: CircuitObservation['behavior'];
  if (rawBehavior.status === 'present') {
    noFields(rawBehavior, ['message'], 'behavior');
    const fields = named(
      array(rawBehavior.fields, 'behavior.fields').map((value, index): CircuitFieldObservation => {
        const path = `behavior.fields[${index}]`;
        const field = object(value, path);
        const name = string(field.name, `${path}.name`);
        if (field.status === 'value') {
          noFields(field, ['message'], path);
          const value = field.value;
          if (
            typeof value !== 'boolean' &&
            typeof value !== 'string' &&
            !(typeof value === 'number' && Number.isFinite(value))
          )
            invalid(`${path}.value`, 'expected a boolean, string, or finite number.');
          return Object.freeze({ name, status: 'value', value });
        }
        noFields(field, ['value'], path);
        if (field.status === 'absent') {
          noFields(field, ['message'], path);
          return Object.freeze({ name, status: 'absent' });
        }
        if (field.status === 'error' || field.status === 'unexpected-type')
          return Object.freeze({
            name,
            status: field.status,
            message: string(field.message, `${path}.message`, true),
          });
        return invalid(`${path}.status`, 'unknown field observation status.');
      }),
      'behavior.fields',
    );
    behavior = Object.freeze({ status: 'present', fields });
  } else {
    noFields(rawBehavior, ['fields'], 'behavior');
    if (rawBehavior.status === 'absent') {
      noFields(rawBehavior, ['message'], 'behavior');
      behavior = Object.freeze({ status: 'absent' });
    } else if (rawBehavior.status === 'error')
      behavior = Object.freeze({
        status: 'error',
        message: string(rawBehavior.message, 'behavior.message', true),
      });
    else return invalid('behavior.status', 'unknown control behavior observation status.');
  }
  const playerIndex = finite(input.playerIndex, 'playerIndex');
  if (!Number.isInteger(playerIndex) || playerIndex < 1 || playerIndex > 4294967295)
    invalid('playerIndex', 'expected a positive uint32 player index.');
  return Object.freeze({
    schemaVersion: 1,
    kind: 'comblang-circuit-observation',
    probeVersion,
    label: string(input.label, 'label', true),
    tick: uint64(input.tick, 'tick'),
    playerIndex,
    environment: Object.freeze({ factorioVersion, mods, startupSettings }),
    entity: Object.freeze({
      key: key as `entity:${string}`,
      type: string(entity.type, 'entity.type'),
      ...(entity.unitNumber === undefined
        ? {}
        : { unitNumber: uint64(entity.unitNumber, 'entity.unitNumber') }),
      surface: string(entity.surface, 'entity.surface'),
      position: Object.freeze({
        x: finite(position.x, 'entity.position.x'),
        y: finite(position.y, 'entity.position.y'),
      }),
    }),
    behavior,
  });
}

/** Validates appended samples independently; never merges mixed environments or infers capabilities. */
export function parseCircuitObservationRecordsJsonl(
  source: string,
): readonly { readonly line: number; readonly observation: CircuitObservation }[] {
  const results: { readonly line: number; readonly observation: CircuitObservation }[] = [];
  for (const [index, line] of source
    .replace(/^\uFEFF/, '')
    .split(/\r?\n/)
    .entries()) {
    if (line.trim().length === 0) continue;
    let value: unknown;
    try {
      value = JSON.parse(line) as unknown;
    } catch {
      throw new CircuitObservationError(index + 1, '<json>', 'invalid observation JSON.');
    }
    results.push(
      Object.freeze({ line: index + 1, observation: parseObservation(value, index + 1) }),
    );
  }
  if (results.length === 0)
    throw new CircuitObservationError(1, '<jsonl>', 'expected at least one observation.');
  return Object.freeze(results);
}

export function parseCircuitObservationsJsonl(source: string): readonly CircuitObservation[] {
  return Object.freeze(
    parseCircuitObservationRecordsJsonl(source).map(({ observation }) => observation),
  );
}

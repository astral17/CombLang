import { parseCircuitObservationRecordsJsonl } from './circuit-observations.js';
import { compareCanonicalString } from './canonical.js';
import { prototypeDatabaseIdentity } from './identity.js';
import { validatePrototypeDatabase } from './validation.js';

type ComparisonStatus = 'match' | 'mismatch' | 'unverified';
export interface ObservationEnvironmentIssue {
  readonly kind: 'mismatch' | 'unverified';
  readonly path: string;
  readonly message: string;
}
export interface ObservationEnvironmentComparison {
  readonly mode: 'environment-comparison-only';
  readonly databaseIdentity: string;
  readonly status: ComparisonStatus;
  readonly samples: readonly {
    readonly line: number;
    readonly label: string;
    readonly entityKey: string;
    readonly status: ComparisonStatus;
    readonly issues: readonly ObservationEnvironmentIssue[];
  }[];
}

function status(issues: readonly ObservationEnvironmentIssue[]): ComparisonStatus {
  return issues.some(({ kind }) => kind === 'mismatch')
    ? 'mismatch'
    : issues.length > 0
      ? 'unverified'
      : 'match';
}

function valueKey(value: unknown): string {
  // Settings are scalars, tuples or flat color objects. Object property order is immaterial.
  return JSON.stringify(
    value !== null && typeof value === 'object' && !Array.isArray(value)
      ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => compareCanonicalString(a, b)))
      : value,
  );
}

/** Compares declared provenance only; never certifies native behavior or fills capability records. */
export async function compareCircuitObservationEnvironment(
  databaseValue: unknown,
  source: string,
): Promise<ObservationEnvironmentComparison> {
  const database = validatePrototypeDatabase(databaseValue);
  const records = parseCircuitObservationRecordsJsonl(source);
  const entities = new Map(database.entities.map((entity) => [entity.key as string, entity]));
  const samples = records.map(({ line, observation }) => {
    const issues: ObservationEnvironmentIssue[] = [];
    function issue(
      path: string,
      message: string,
      kind: ObservationEnvironmentIssue['kind'] = 'mismatch',
    ) {
      issues.push(Object.freeze({ kind, path, message }));
    }
    if (observation.environment.factorioVersion !== database.environment.factorioVersion) {
      issue(
        'environment.factorioVersion',
        `Expected ${JSON.stringify(database.environment.factorioVersion)}, observed ${JSON.stringify(observation.environment.factorioVersion)}.`,
      );
    }
    function compareNamed(
      expected: readonly { name: string; value: unknown }[],
      actual: readonly { name: string; value: unknown }[],
      path: string,
    ) {
      const wanted = new Map(expected.map(({ name, value }) => [name, value]));
      const observed = new Map(actual.map(({ name, value }) => [name, value]));
      for (const name of [...new Set([...wanted.keys(), ...observed.keys()])].sort()) {
        const entryPath = `${path}[${JSON.stringify(name)}]`;
        if (!observed.has(name)) issue(entryPath, 'Expected entry is absent from the observation.');
        else if (!wanted.has(name))
          issue(entryPath, 'Observation contains an entry absent from the database.');
        else if (valueKey(wanted.get(name)) !== valueKey(observed.get(name)))
          issue(
            entryPath,
            `Expected ${valueKey(wanted.get(name))}, observed ${valueKey(observed.get(name))}.`,
          );
      }
    }
    compareNamed(
      database.environment.mods.map(({ name, version }) => ({ name, value: version })),
      observation.environment.mods.map(({ name, version }) => ({ name, value: version })),
      'environment.mods',
    );
    if (database.environment.startupSettings === undefined) {
      issue(
        'environment.startupSettings',
        'Database has no captured startup setting values; an identity label cannot prove a match.',
        'unverified',
      );
    } else
      compareNamed(
        database.environment.startupSettings,
        observation.environment.startupSettings,
        'environment.startupSettings',
      );
    if (!database.capabilities.entities) {
      issue('entity.key', 'Database does not declare entity coverage.', 'unverified');
    } else {
      const entity = entities.get(observation.entity.key);
      if (entity === undefined)
        issue(
          'entity.key',
          `Unknown entity ${JSON.stringify(observation.entity.key)} in the selected database.`,
        );
      else if (entity.type !== observation.entity.type)
        issue(
          'entity.type',
          `Expected ${JSON.stringify(entity.type)}, observed ${JSON.stringify(observation.entity.type)}.`,
        );
    }
    return Object.freeze({
      line,
      label: observation.label,
      entityKey: observation.entity.key,
      status: status(issues),
      issues: Object.freeze(issues),
    });
  });
  return Object.freeze({
    mode: 'environment-comparison-only',
    databaseIdentity: await prototypeDatabaseIdentity(database),
    status: status(samples.flatMap(({ issues }) => issues)),
    samples: Object.freeze(samples),
  });
}

import { describe, expect, test } from 'vitest';
import sample from '../../../fixtures/prototype-observations/synthetic.json';
import { syntheticPrototypeDatabase } from './fixtures.js';
import { loadPrototypeDatabase } from './provider.js';
import { validatePrototypeDatabase } from './validation.js';
import { compareCircuitObservationEnvironment } from './observation-environment.js';

function fixture() {
  const full = validatePrototypeDatabase(syntheticPrototypeDatabase());
  return {
    ...full,
    environment: { ...full.environment, mods: sample.environment.mods, startupSettings: [] },
    entities: [{ ...full.entities[0]!, key: sample.entity.key, name: 'synthetic-assembler' }],
  };
}

describe('captured prototype startup settings', () => {
  test('keeps omission distinct from an empty snapshot and includes values in identity', async () => {
    const full = validatePrototypeDatabase(syntheticPrototypeDatabase());
    const omitted = await loadPrototypeDatabase(full);
    const empty = await loadPrototypeDatabase({
      ...full,
      environment: { ...full.environment, startupSettings: [] },
    });
    expect(omitted.database.environment).not.toHaveProperty('startupSettings');
    expect(empty.prototypes.identity).not.toBe(omitted.prototypes.identity);
    const values = [
      { name: 'z', value: false },
      { name: 'a', value: { r: 0.5, a: 1 } },
      { name: 'empty', value: '' },
      { name: 'zero', value: 0 },
    ];
    const a = await loadPrototypeDatabase({
      ...full,
      environment: { ...full.environment, startupSettings: values },
    });
    const b = await loadPrototypeDatabase({
      ...full,
      environment: { ...full.environment, startupSettings: [...values].reverse() },
    });
    expect(a.prototypes.identity).toBe(b.prototypes.identity);
    expect(a.prototypes.identity).not.toBe(empty.prototypes.identity);
    expect(a.database.environment.startupSettings?.map(({ name }) => name)).toEqual([
      'a',
      'empty',
      'z',
      'zero',
    ]);
    expect(Object.isFrozen(a.database.environment.startupSettings?.[0]?.value)).toBe(true);
    expect(a.database.environment.startupSettingsIdentity).toBe(
      full.environment.startupSettingsIdentity,
    );
    const roundtrip = await loadPrototypeDatabase(JSON.parse(JSON.stringify(a.database)));
    expect(roundtrip.prototypes.identity).toBe(a.prototypes.identity);
  });

  test.each([
    [{}, 'PT1001'],
    [[{ name: 'x', value: null }], 'PT1001'],
    [[{ name: 'x', value: NaN }], 'PT1001'],
    [[{ name: 'x', value: { unknown: 1 } }], 'PT1001'],
    [[{ name: 'x', value: [0, 1] }], 'PT1001'],
    [
      [
        { name: 'x', value: 0 },
        { name: 'x', value: 1 },
      ],
      'PT1003',
    ],
  ])('rejects invalid normalized settings %j', (startupSettings, code) => {
    const full = fixture();
    expect(() =>
      validatePrototypeDatabase({ ...full, environment: { ...full.environment, startupSettings } }),
    ).toThrowError(
      expect.objectContaining({
        code,
        path: expect.stringContaining('environment.startupSettings'),
      }),
    );
  });
});

describe('observation environment comparison', () => {
  test('matches metadata irrespective of mod order and does not infer behavior from a getter failure', async () => {
    const base = fixture();
    const report = await compareCircuitObservationEnvironment(
      base,
      JSON.stringify({
        ...sample,
        environment: { ...sample.environment, mods: [...sample.environment.mods].reverse() },
        behavior: { status: 'error', message: 'getter failed' },
      }),
    );
    expect(report).toMatchObject({
      mode: 'environment-comparison-only',
      status: 'match',
      samples: [{ line: 1, status: 'match', issues: [] }],
    });
    expect(report.databaseIdentity).toBe((await loadPrototypeDatabase(base)).prototypes.identity);
    expect(report).not.toHaveProperty('circuitCoverage');
    expect(Object.isFrozen(report.samples[0]!.issues)).toBe(true);
  });

  test('treats absent settings as unverified despite an arbitrary identity label', async () => {
    const base = fixture();
    const { startupSettings: _settings, ...environment } = base.environment;
    const report = await compareCircuitObservationEnvironment(
      { ...base, environment },
      JSON.stringify(sample),
    );
    expect(report).toMatchObject({
      status: 'unverified',
      samples: [{ issues: [{ kind: 'unverified', path: 'environment.startupSettings' }] }],
    });
  });

  test.each([
    [
      'factorioVersion',
      {
        ...sample,
        environment: {
          ...sample.environment,
          factorioVersion: '2.1.17',
          mods: [{ name: 'base', version: '2.1.17' }, sample.environment.mods[1]],
        },
      },
    ],
    [
      'mods',
      {
        ...sample,
        environment: {
          ...sample.environment,
          mods: [...sample.environment.mods, { name: 'other', version: '1' }],
        },
      },
    ],
    [
      'startupSettings',
      {
        ...sample,
        environment: { ...sample.environment, startupSettings: [{ name: 'extra', value: false }] },
      },
    ],
    ['entity.key', { ...sample, entity: { ...sample.entity, key: 'entity:missing' } }],
    ['entity.type', { ...sample, entity: { ...sample.entity, type: 'lamp' } }],
  ])(
    'reports mismatching %s without dropping the matching sample or blank-line provenance',
    async (field, changed) => {
      const report = await compareCircuitObservationEnvironment(
        fixture(),
        `\uFEFF\n${JSON.stringify(sample)}\n\n${JSON.stringify(changed)}\n`,
      );
      expect(report.status).toBe('mismatch');
      expect(report.samples.map(({ line, status }) => ({ line, status }))).toEqual([
        { line: 2, status: 'match' },
        { line: 4, status: 'mismatch' },
      ]);
      expect(report.samples[1]!.issues).toContainEqual(
        expect.objectContaining({ kind: 'mismatch', path: expect.stringContaining(field) }),
      );
    },
  );

  test('does not ignore the collector mod or missing expected mods', async () => {
    const base = fixture();
    const report = await compareCircuitObservationEnvironment(
      {
        ...base,
        environment: {
          ...base.environment,
          mods: [
            { name: 'base', version: '2.1.16' },
            { name: 'expected', version: '1' },
          ],
        },
      },
      JSON.stringify(sample),
    );
    expect(report.status).toBe('mismatch');
    expect(report.samples[0]!.issues.map(({ path }) => path)).toEqual([
      'environment.mods["comblang-circuit-probe"]',
      'environment.mods["expected"]',
    ]);
  });

  test('compares exact setting values including false/zero and ignores only color property order', async () => {
    const base = fixture();
    const startupSettings = [
      { name: 'color', value: { r: 0.5, a: 1 } },
      { name: 'mode', value: false },
    ];
    const database = { ...base, environment: { ...base.environment, startupSettings } };
    const same = {
      ...sample,
      environment: {
        ...sample.environment,
        startupSettings: [
          { name: 'mode', value: false },
          { name: 'color', value: { a: 1, r: 0.5 } },
        ],
      },
    };
    expect(
      (await compareCircuitObservationEnvironment(database, JSON.stringify(same))).status,
    ).toBe('match');
    for (const actual of [
      [
        { name: 'color', value: { r: 0.5, a: 1 } },
        { name: 'mode', value: 0 },
      ],
      [
        { name: 'color', value: [0.5, 0, 0, 1] },
        { name: 'mode', value: false },
      ],
      [],
    ]) {
      expect(
        (
          await compareCircuitObservationEnvironment(
            database,
            JSON.stringify({
              ...sample,
              environment: { ...sample.environment, startupSettings: actual },
            }),
          )
        ).status,
      ).toBe('mismatch');
    }
  });

  test('does not trust hidden entity data as complete coverage', async () => {
    const base = fixture();
    const report = await compareCircuitObservationEnvironment(
      {
        ...base,
        capabilities: { ...base.capabilities, entities: false, entityCircuitCapabilities: false },
      },
      JSON.stringify(sample),
    );
    expect(report.status).toBe('unverified');
    expect(report.samples[0]!.issues).toEqual([
      expect.objectContaining({ path: 'entity.key', kind: 'unverified' }),
    ]);
  });

  test('rejects malformed later samples with the original JSONL line', async () => {
    await expect(
      compareCircuitObservationEnvironment(fixture(), `${JSON.stringify(sample)}\n\n{`),
    ).rejects.toMatchObject({ code: 'PO1001', line: 3 });
  });
});

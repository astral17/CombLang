import { readFile } from 'node:fs/promises';
import { describe, expect, test } from 'vitest';
import sample from '../../../fixtures/prototype-observations/synthetic.json';
import { parseCircuitObservationsJsonl } from './circuit-observations.js';
import { applyEntityCircuitSupplement } from './circuit-supplement.js';
import { syntheticPrototypeDatabase } from './fixtures.js';

function parse(overrides: Record<string, unknown> = {}) {
  return parseCircuitObservationsJsonl(JSON.stringify({ ...sample, ...overrides }))[0]!;
}

describe('raw circuit observation JSONL', () => {
  test('preserves false, absent, read errors, exact identifiers and immutable nested records', () => {
    const result = parse();
    expect(result.entity.unitNumber).toBe('9007199254740993');
    expect(result.environment.startupSettings).toEqual([]);
    expect(result.behavior).toEqual(sample.behavior);
    expect(result).not.toHaveProperty('circuit');
    expect(result).not.toHaveProperty('baseIdentity');
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.entity.position)).toBe(true);
    expect(Object.isFrozen(result.environment.mods[0])).toBe(true);
    if (result.behavior.status !== 'present') throw new Error('Expected fields');
    expect(Object.isFrozen(result.behavior.fields)).toBe(true);
    expect(Object.isFrozen(result.behavior.fields[0])).toBe(true);
  });

  test('handles BOM, CRLF, blank lines and repeated snapshots without merging environments', () => {
    const second = {
      ...sample,
      label: 'later',
      environment: {
        ...sample.environment,
        factorioVersion: '2.1.17',
        mods: [{ name: 'base', version: '2.1.17' }, sample.environment.mods[1]],
      },
    };
    const values = parseCircuitObservationsJsonl(
      `\uFEFF\r\n${JSON.stringify(sample)}\r\n\r\n${JSON.stringify(second)}\r\n`,
    );
    expect(values).toHaveLength(2);
    expect(values.map(({ environment }) => environment.factorioVersion)).toEqual([
      '2.1.16',
      '2.1.17',
    ]);
    expect(values[0]!.entity).toEqual(values[1]!.entity);
  });

  test('keeps primitive/color settings and their omission semantics', () => {
    const values = [false, 0, '', { r: 0.5, a: 0.5 }, {}, [255, 0, 0], [0, 0.5, 0, 1]];
    const result = parse({
      environment: {
        ...sample.environment,
        startupSettings: values.map((value, index) => ({ name: `setting-${index}`, value })),
      },
    });
    expect(result.environment.startupSettings.map(({ value }) => value)).toEqual(values);
    expect(Object.isFrozen(result.environment.startupSettings[3]!.value)).toBe(true);
    expect(Object.isFrozen(result.environment.startupSettings[5]!.value)).toBe(true);
  });

  test.each([
    { status: 'absent' },
    { status: 'error', message: 'read failed' },
    { status: 'present', fields: {} },
  ])('retains behavior observation %j without negative capabilities', (behavior) => {
    expect(parse({ behavior }).behavior).toEqual(
      behavior.status === 'present' ? { status: 'present', fields: [] } : behavior,
    );
  });

  test('retains unexpected field types and numeric enum values as observations', () => {
    const behavior = {
      status: 'present',
      fields: [
        { name: 'type', status: 'value', value: 3 },
        { name: 'changed-api', status: 'unexpected-type', message: 'table' },
      ],
    };
    expect(parse({ behavior }).behavior).toEqual(behavior);
  });

  test.each([
    [{ schemaVersion: 2 }, '<observation>'],
    [{ kind: 'capability-assertion' }, '<observation>'],
    [{ tick: '18446744073709551616' }, 'tick'],
    [{ tick: '1e3' }, 'tick'],
    [{ tick: 123 }, 'tick'],
    [{ playerIndex: 0 }, 'playerIndex'],
    [{ entity: { ...sample.entity, key: 'entity:' } }, 'entity.key'],
    [{ behavior: { status: 'absent', fields: [] } }, 'behavior.fields'],
    [{ behavior: { status: 'error' } }, 'behavior.message'],
    [{ behavior: { status: 'unknown' } }, 'behavior.status'],
    [
      { behavior: { status: 'present', fields: [{ name: 'flag', status: 'value', value: null }] } },
      'behavior.fields[0].value',
    ],
    [
      {
        behavior: { status: 'present', fields: [{ name: 'flag', status: 'absent', value: false }] },
      },
      'behavior.fields[0].value',
    ],
    [
      {
        behavior: {
          status: 'present',
          fields: [{ name: 'flag', status: 'value', value: false, message: 'contradiction' }],
        },
      },
      'behavior.fields[0].message',
    ],
    [
      {
        behavior: {
          status: 'present',
          fields: [sample.behavior.fields[0], sample.behavior.fields[0]],
        },
      },
      'behavior.fields',
    ],
    [
      { environment: { ...sample.environment, mods: [sample.environment.mods[0]] } },
      'environment.mods',
    ],
    [{ probeVersion: 'wrong' }, 'environment.mods'],
    [
      { environment: { ...sample.environment, startupSettings: [{ name: 'x', value: null }] } },
      'environment.startupSettings[0].value',
    ],
    [
      { environment: { ...sample.environment, startupSettings: [{ name: 'x', value: [1, 2] }] } },
      'environment.startupSettings[0].value',
    ],
  ])('rejects malformed sample %j with its actual line and field', (overrides, path) => {
    const source = `${JSON.stringify(sample)}\n\n${JSON.stringify({ ...sample, ...overrides })}`;
    expect(() => parseCircuitObservationsJsonl(source)).toThrowError(
      expect.objectContaining({ code: 'PO1001', line: 3, path }),
    );
  });

  test('rejects empty/truncated files rather than silently dropping samples', () => {
    expect(() => parseCircuitObservationsJsonl(' \n')).toThrowError(
      expect.objectContaining({ code: 'PO1001', path: '<jsonl>' }),
    );
    expect(() => parseCircuitObservationsJsonl(`${JSON.stringify(sample)}\n{`)).toThrowError(
      expect.objectContaining({ code: 'PO1001', line: 2, path: '<json>' }),
    );
    expect(parse({ tick: '18446744073709551615' }).tick).toBe('18446744073709551615');
  });

  test('cannot be used as an automatic circuit supplement', async () => {
    await expect(
      applyEntityCircuitSupplement(syntheticPrototypeDatabase(), parse()),
    ).rejects.toMatchObject({ code: 'PC1001', path: 'baseIdentity' });
  });
});

test('probe package has an explicit command and no entity/behavior mutation hooks (static guard, not Lua execution)', async () => {
  const root = new URL('../../../tools/factorio-circuit-probe/', import.meta.url);
  const info = JSON.parse(await readFile(new URL('info.json', root), 'utf8'));
  const lua = (await readFile(new URL('control.lua', root), 'utf8')).replace(/--[^\n]*/g, '');
  expect(info).toMatchObject({
    name: 'comblang-circuit-probe',
    version: sample.probeVersion,
    factorio_version: '2.1',
    dependencies: ['base >= 2.1.16'],
  });
  expect(lua).toContain('commands.add_command("comblang-probe"');
  expect(lua).toContain('entity.get_control_behavior()');
  expect(lua).toContain('helpers.table_to_json(sample) .. "\\n", true, command.player_index');
  expect(lua).not.toMatch(
    /get_or_create_control_behavior|create_entity|destroy\s*\(|script\.on_|storage\s*[.\[]|behavior\[name\]\s*=/,
  );
});

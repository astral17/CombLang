import {
  canonicalizeConstantConfiguration,
  ConstantConfigurationError,
  Signal,
} from '@comblang/factorio';
import {
  LosslessJsonArray,
  LosslessJsonNumber,
  LosslessJsonObject,
  parseLosslessJson,
  stringifyLosslessJson,
  type LosslessJsonValue,
} from '@comblang/blueprint/document';
import { describe, expect, test } from 'vitest';

import { constantEntityControlBehavior } from './native-blueprint-fields.js';
import { decodeBlueprintConstantControlBehavior } from './blueprint-import-constant.js';

function decode(
  source: string,
  options?: Parameters<typeof decodeBlueprintConstantControlBehavior>[1],
) {
  return decodeBlueprintConstantControlBehavior(parseLosslessJson(source), options);
}

function section(
  index: number,
  filters: readonly unknown[] = [],
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    index,
    active: true,
    multiplier: 1,
    filters,
    ...overrides,
  };
}

function filter(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    index: 1,
    name: 'iron-plate',
    quality: 'normal',
    comparator: '=',
    count: 1,
    ...overrides,
  };
}

function behavior(sections: readonly unknown[] = [section(1)]): Record<string, unknown> {
  return { is_on: true, sections: { sections } };
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function expectBlocked(source: string, path: string): void {
  const result = decode(source);
  expect(result.state).toBe('blocked');
  expect(result.configuration).toBeUndefined();
  expect(result.diagnostics).toEqual([
    expect.objectContaining({
      category: 'unsupported-constant-configuration',
      path,
    }),
  ]);
  expect(Object.isFrozen(result)).toBe(true);
  expect(Object.isFrozen(result.diagnostics)).toBe(true);
  expect(Object.isFrozen(result.diagnostics[0])).toBe(true);
}

function expectResourceError(action: () => unknown): void {
  let caught: unknown;
  try {
    action();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(ConstantConfigurationError);
  expect(caught).toMatchObject({ code: 'FC1002' });
}

function numberNode(value: number): LosslessJsonNumber {
  return new LosslessJsonNumber(String(value));
}

function filterNode(index: number): LosslessJsonObject {
  return new LosslessJsonObject([
    ['index', numberNode(index)],
    ['name', 'x'],
    ['quality', 'normal'],
    ['comparator', '='],
    ['count', numberNode(0)],
  ]);
}

function sectionNode(index: number, filters: LosslessJsonArray): LosslessJsonObject {
  return new LosslessJsonObject([
    ['index', numberNode(index)],
    ['active', true],
    ['multiplier', numberNode(1)],
    ['filters', filters],
  ]);
}

function behaviorNode(sections: LosslessJsonArray): LosslessJsonObject {
  return new LosslessJsonObject([
    ['is_on', true],
    ['sections', new LosslessJsonObject([['sections', sections]])],
  ]);
}

describe('inverse Constant control_behavior conversion', () => {
  test('round-trips the explicit exporter shape without merging or changing order', () => {
    const configuration = canonicalizeConstantConfiguration({
      isOn: false,
      sections: [
        {
          active: false,
          group: '',
          multiplier: 0.1,
          filters: [
            { signal: Signal('item', 'iron-plate', 'normal'), value: -2_147_483_648 },
            { signal: Signal('fluid', 'water', 'uncommon'), value: 0 },
            { signal: Signal('virtual', 'signal-A', 'legendary'), value: 0 },
            { signal: Signal('item', 'iron-plate', 'normal'), value: 2_147_483_647 },
          ],
        },
        { active: true, multiplier: 1.5, filters: [] },
      ],
    });
    const emitted = constantEntityControlBehavior(configuration);
    const input = parseLosslessJson(JSON.stringify(emitted));
    const sourceBefore = stringifyLosslessJson(input);
    const result = decodeBlueprintConstantControlBehavior(input);

    expect(result.state).toBe('complete');
    expect(result.configuration).toEqual(configuration);
    expect(
      stringifyLosslessJson(
        parseLosslessJson(JSON.stringify(constantEntityControlBehavior(result.configuration!))),
      ),
    ).toBe(sourceBefore);
    expect(stringifyLosslessJson(input)).toBe(sourceBefore);
    expect(result.configuration?.sections[0]?.filters).toHaveLength(4);
  });

  test('decodes a literal native fixture with an independent expected configuration', () => {
    const source =
      '{"is_on":false,"sections":{"sections":[{"index":1,"active":false,' +
      '"multiplier":-0,"group":"","filters":[{"index":1,"name":"iron-plate",' +
      '"quality":"normal","comparator":"=","count":-2147483648}]}]}}';
    const result = decode(source);

    expect(result.state).toBe('complete');
    expect(result.configuration).toEqual({
      isOn: false,
      sections: [
        {
          active: false,
          group: '',
          multiplier: -0,
          filters: [
            {
              signal: { type: 'item', name: 'iron-plate', quality: 'normal' },
              value: -2_147_483_648,
            },
          ],
        },
      ],
    });
    expect(Object.is(result.configuration?.sections[0]?.multiplier, -0)).toBe(true);
    expect(Object.isFrozen(result.configuration)).toBe(true);
    expect(Object.isFrozen(result.configuration?.sections[0]?.filters[0]?.signal)).toBe(true);
  });

  test('preserves empty structures, section state, group strings, and finite double values', () => {
    const source =
      '{"is_on":false,"sections":{"sections":[' +
      '{"index":1,"active":false,"multiplier":0,"filters":[]},' +
      '{"index":2,"active":true,"multiplier":-1.25,"group":"named","filters":[]},' +
      '{"index":3,"active":false,"multiplier":0.1,"group":"","filters":[]}]}}';
    const result = decode(source);

    expect(result.state).toBe('complete');
    expect(result.configuration?.isOn).toBe(false);
    expect(
      result.configuration?.sections.map(({ active, group, multiplier }) => [
        active,
        group,
        multiplier,
      ]),
    ).toEqual([
      [false, undefined, 0],
      [true, 'named', -1.25],
      [false, '', 0.1],
    ]);
    expect(result.configuration?.sections.map(({ filters }) => filters)).toEqual([[], [], []]);
  });

  test('requires explicit quality and accepts omitted item type plus valid explicit types', () => {
    expectBlocked(
      JSON.stringify(behavior([section(1, [filter({ quality: undefined })])])),
      '$.sections.sections[0].filters[0].quality',
    );

    const result = decode(
      JSON.stringify(
        behavior([
          section(1, [filter({ type: undefined })]),
          section(2, [filter({ index: 1, type: 'fluid', name: 'water', quality: 'uncommon' })]),
          section(3, [filter({ index: 1, type: 'virtual', name: 'signal-A', quality: 'normal' })]),
        ]),
      ),
    );
    expect(result.state).toBe('complete');
    expect(result.configuration?.sections.map(({ filters }) => filters[0]?.signal)).toEqual([
      { type: 'item', name: 'iron-plate', quality: 'normal' },
      { type: 'fluid', name: 'water', quality: 'uncommon' },
      { type: 'virtual', name: 'signal-A', quality: 'normal' },
    ]);
  });

  test('blocks non-equals comparators, unknown fields, and legacy filter representations', () => {
    expectBlocked(
      JSON.stringify(behavior([section(1, [filter({ comparator: '≠' })])])),
      '$.sections.sections[0].filters[0].comparator',
    );
    expectBlocked(JSON.stringify({ ...behavior(), future_flag: true }), '$.future_flag');
    expectBlocked(
      JSON.stringify(behavior([section(1, [filter({ max_count: 3 })])])),
      '$.sections.sections[0].filters[0].max_count',
    );
    expectBlocked(JSON.stringify({ is_on: true, sections: { filters: [] } }), '$.sections.filters');
    expectBlocked(
      JSON.stringify(behavior([section(1, [filter({ type: 'unsupported' })])])),
      '$.sections.sections[0].filters[0].type',
    );
  });

  test('quotes unknown field keys so diagnostics identify one native member', () => {
    const rootPath = '$.blueprint.entities[2].control_behavior';
    const cases: readonly [unknown, string][] = [
      [{ ...behavior(), 'future.flag': true }, '["future.flag"]'],
      [{ is_on: true, sections: { sections: [], 'future key': 0 } }, '.sections["future key"]'],
      [behavior([section(1, [], { 'future\n': false })]), '.sections.sections[0]["future\\n"]'],
      [
        behavior([section(1, [filter({ 'future"key': 1 })])]),
        '.sections.sections[0].filters[0]["future\\"key"]',
      ],
    ];
    for (const [value, suffix] of cases) {
      const result = decode(JSON.stringify(value), { path: rootPath });
      expect(result.state).toBe('blocked');
      expect(result.configuration).toBeUndefined();
      expect(result.diagnostics[0]?.path).toBe(rootPath + suffix);
    }
  });

  test('blocks missing required fields and sparse or duplicate indices at native paths', () => {
    const missingIsOn = clone(behavior());
    delete missingIsOn.is_on;
    const missingSectionIndex = clone(behavior([section(1, [], { index: undefined })]));
    const missingActive = clone(behavior([section(1, [], { active: undefined })]));
    const missingMultiplier = clone(behavior([section(1, [], { multiplier: undefined })]));
    const missingFilters = clone(behavior([section(1, [], { filters: undefined })]));
    const missingFilterIndex = clone(behavior([section(1, [filter({ index: undefined })])]));
    const missingFilterName = clone(behavior([section(1, [filter({ name: undefined })])]));
    const missingComparator = clone(behavior([section(1, [filter({ comparator: undefined })])]));
    const missingCount = clone(behavior([section(1, [filter({ count: undefined })])]));
    const cases: readonly [unknown, string][] = [
      [missingIsOn, '$.is_on'],
      [{ is_on: true }, '$.sections'],
      [{ is_on: true, sections: {} }, '$.sections.sections'],
      [missingSectionIndex, '$.sections.sections[0].index'],
      [missingActive, '$.sections.sections[0].active'],
      [missingMultiplier, '$.sections.sections[0].multiplier'],
      [missingFilters, '$.sections.sections[0].filters'],
      [missingFilterIndex, '$.sections.sections[0].filters[0].index'],
      [missingFilterName, '$.sections.sections[0].filters[0].name'],
      [missingComparator, '$.sections.sections[0].filters[0].comparator'],
      [missingCount, '$.sections.sections[0].filters[0].count'],
      [behavior([section(2)]), '$.sections.sections[0].index'],
      [behavior([section(1), section(1)]), '$.sections.sections[1].index'],
      [behavior([section(1, [filter({ index: 2 })])]), '$.sections.sections[0].filters[0].index'],
      [
        behavior([section(1, [filter(), filter({ index: 1 })])]),
        '$.sections.sections[0].filters[1].index',
      ],
    ];

    for (const [value, path] of cases) expectBlocked(JSON.stringify(value), path);
  });

  test('rejects fractional, unsafe, and out-of-int32 filter counts without wrapping', () => {
    for (const value of ['1.5', '9007199254740992', '2147483648', '-2147483649']) {
      const source =
        '{"is_on":true,"sections":{"sections":[{"index":1,"active":true,' +
        '"multiplier":1,"filters":[{"index":1,"name":"iron-plate",' +
        `"quality":"normal","comparator":"=","count":${value}}]}]}}`;
      expectBlocked(source, '$.sections.sections[0].filters[0].count');
    }
  });

  test('accepts ordinary fractional doubles but blocks values that overflow to infinity', () => {
    const fractional = decode(
      '{"is_on":true,"sections":{"sections":[{"index":1,"active":true,' +
        '"multiplier":0.1,"filters":[]}]}}',
    );
    expect(fractional.state).toBe('complete');
    expect(fractional.configuration?.sections[0]?.multiplier).toBe(0.1);
    expectBlocked(
      '{"is_on":true,"sections":{"sections":[{"index":1,"active":true,' +
        '"multiplier":1e400,"filters":[]}]}}',
      '$.sections.sections[0].multiplier',
    );
  });

  test('preserves unsupported source lexemes and returns frozen located coverage only', () => {
    const source =
      '{"is_on":true,"sections":{"sections":[{"index":1,"active":true,' +
      '"multiplier":1e400,"filters":[]}]},"future_native_extension":{"large":9007199254740993}}';
    const input = parseLosslessJson(source);
    const before = stringifyLosslessJson(input);
    const result = decodeBlueprintConstantControlBehavior(input, {
      path: '$.blueprint.entities[4].control_behavior',
    });

    expect(result.state).toBe('blocked');
    expect(result.configuration).toBeUndefined();
    expect(result.diagnostics[0]).toMatchObject({
      category: 'unsupported-constant-configuration',
      path: '$.blueprint.entities[4].control_behavior.future_native_extension',
    });
    expect(stringifyLosslessJson(input)).toBe(before);
    expect(result).not.toHaveProperty('profile');
    expect(result).not.toHaveProperty('context');
  });

  test('uses the existing maxNodes limit for exact and over-bound section/filter trees', () => {
    const maximumSections = Math.floor((4096 - 2) / 2);
    const atSectionBoundary = new LosslessJsonArray(
      Array.from({ length: maximumSections }, (_, index) =>
        sectionNode(index + 1, new LosslessJsonArray([])),
      ),
    );
    const accepted = decodeBlueprintConstantControlBehavior(behaviorNode(atSectionBoundary));
    expect(accepted.state).toBe('complete');
    expect(accepted.configuration?.sections).toHaveLength(maximumSections);

    const overSectionBoundary = new LosslessJsonArray([
      ...Array.from({ length: maximumSections + 1 }, (_, index) =>
        sectionNode(index + 1, new LosslessJsonArray([])),
      ),
    ]);
    expectResourceError(() =>
      decodeBlueprintConstantControlBehavior(behaviorNode(overSectionBoundary)),
    );

    const maximumFilters = Math.floor((4096 - 4) / 2);
    const atFilterBoundary = new LosslessJsonArray(
      Array.from({ length: maximumFilters }, (_, index) => filterNode(index + 1)),
    );
    const acceptedFilters = decodeBlueprintConstantControlBehavior(
      behaviorNode(new LosslessJsonArray([sectionNode(1, atFilterBoundary)])),
    );
    expect(acceptedFilters.state).toBe('complete');
    expect(acceptedFilters.configuration?.sections[0]?.filters).toHaveLength(maximumFilters);

    const overFilterBoundary = new LosslessJsonArray([
      ...Array.from({ length: maximumFilters + 1 }, (_, index) => filterNode(index + 1)),
    ]);
    expectResourceError(() =>
      decodeBlueprintConstantControlBehavior(
        behaviorNode(new LosslessJsonArray([sectionNode(1, overFilterBoundary)])),
      ),
    );
  });

  test('validates options and checks cancellation before work and inside filter iteration', () => {
    const valid = parseLosslessJson(JSON.stringify(behavior()));
    expect(() => decodeBlueprintConstantControlBehavior(valid, { path: 3 } as never)).toThrow(
      TypeError,
    );
    expect(() => decodeBlueprintConstantControlBehavior(valid, { extra: true } as never)).toThrow(
      TypeError,
    );
    const accessor = Object.defineProperty({}, 'path', { get: () => '$.bad' });
    expect(() => decodeBlueprintConstantControlBehavior(valid, accessor as never)).toThrow(
      TypeError,
    );

    const aborted = new AbortController();
    aborted.abort();
    expect(() =>
      decodeBlueprintConstantControlBehavior(valid, { signal: aborted.signal }),
    ).toThrowError(expect.objectContaining({ name: 'AbortError' }));

    let reads = 0;
    const observedSignal = {
      get aborted() {
        reads += 1;
        return reads >= 17;
      },
    } as AbortSignal;
    const manyFilters = parseLosslessJson(
      JSON.stringify(behavior([section(1, [filter(), filter({ index: 2 })])])),
    );
    expect(() =>
      decodeBlueprintConstantControlBehavior(manyFilters, { signal: observedSignal }),
    ).toThrowError(expect.objectContaining({ name: 'AbortError' }));
    expect(reads).toBe(17);

    const absent = decodeBlueprintConstantControlBehavior(undefined, {
      path: '$.native.control_behavior',
    });
    expect(absent.diagnostics[0]?.path).toBe('$.native.control_behavior');
  });

  test('keeps the converter private to its direct compiler module', async () => {
    const { readFile } = await import('node:fs/promises');
    const manifest = JSON.parse(
      await readFile(new URL('../package.json', import.meta.url), 'utf8'),
    ) as { exports: Record<string, string> };
    const barrel = await readFile(new URL('./index.ts', import.meta.url), 'utf8');

    expect(Object.values(manifest.exports)).not.toContain('./src/blueprint-import-constant.ts');
    expect(barrel).not.toContain('blueprint-import-constant');
  });
});

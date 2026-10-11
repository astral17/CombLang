import { readFile } from 'node:fs/promises';

import { constantConfigurationLimits, Signal } from '@comblang/factorio';
import { parseLosslessJson, stringifyLosslessJson } from '@comblang/blueprint/document';
import type { NetworkId, ProducerId } from '@comblang/shared';
import { describe, expect, test } from 'vitest';

import { lowerNativeBlueprintConfig } from './blueprint-native-config.js';
import { decodeBlueprintDeciderControlBehavior } from './blueprint-import-decider.js';
import { nativeDeciderConditionGroups } from './native-decider-conditions.js';
import type { DeciderProducerConfig, LogicalDeciderCondition, NativeCircuitIr } from './ir.js';

const red = 'network:decider-red' as NetworkId;
const green = 'network:decider-green' as NetworkId;
const outputNetwork = 'network:decider-output' as NetworkId;
const networks = { red, green };
const provenance = { instancePath: [], expansionStack: [] };
const basePath = '$.native.control_behavior';

function jsonValue(value: unknown) {
  return parseLosslessJson(JSON.stringify(value));
}

function row(overrides: Record<string, unknown> = {}) {
  return {
    first_signal: { type: 'virtual', name: 'signal-A' },
    first_signal_networks: { red: true, green: false },
    comparator: '>',
    constant: 0,
    compare_type: 'and',
    ...overrides,
  };
}

function copyOutput(overrides: Record<string, unknown> = {}) {
  return {
    signal: { name: 'signal-output' },
    copy_count_from_input: true,
    ...overrides,
  };
}

function behavior(
  conditions: unknown = [row()],
  outputs: unknown = [],
  extra: Record<string, unknown> = {},
) {
  return { decider_conditions: { conditions, outputs, ...extra } };
}

function decode(
  value: unknown,
  inputNetworks: { readonly red?: NetworkId; readonly green?: NetworkId } = networks,
  options?: Parameters<typeof decodeBlueprintDeciderControlBehavior>[2],
) {
  return decodeBlueprintDeciderControlBehavior(jsonValue(value), inputNetworks, options);
}

function decodeSource(
  source: string,
  inputNetworks: { readonly red?: NetworkId; readonly green?: NetworkId } = networks,
  options?: Parameters<typeof decodeBlueprintDeciderControlBehavior>[2],
) {
  return decodeBlueprintDeciderControlBehavior(parseLosslessJson(source), inputNetworks, options);
}

function expectBlocked(
  value: unknown,
  path: string,
  inputNetworks: { readonly red?: NetworkId; readonly green?: NetworkId } = networks,
) {
  const result = decode(value, inputNetworks, { path: basePath });
  expect(result.state).toBe('blocked');
  expect(result.configuration).toBeUndefined();
  expect(result.diagnostics).toEqual([
    expect.objectContaining({
      category: 'unsupported-decider-configuration',
      path: `${basePath}${path}`,
    }),
  ]);
  expect(Object.isFrozen(result)).toBe(true);
  expect(Object.isFrozen(result.diagnostics)).toBe(true);
  expect(Object.isFrozen(result.diagnostics[0])).toBe(true);
  return result;
}

function irForDecider(configuration: DeciderProducerConfig): NativeCircuitIr {
  return {
    format: 'comblang-ncir',
    networks: [
      { id: red, color: 'red', provenance },
      { id: green, color: 'green', provenance },
      { id: outputNetwork, color: 'red', provenance },
    ],
    entities: [],
    producers: [
      {
        id: 'producer:decider-import' as ProducerId,
        kind: 'decider',
        config: configuration,
        destinations: [outputNetwork],
        provenance,
      },
    ],
  };
}

function emittedBehavior(configuration: DeciderProducerConfig) {
  return lowerNativeBlueprintConfig(irForDecider(configuration), 1024).combinators[0]!.entity
    .control_behavior;
}

describe('inverse Decider control_behavior conversion', () => {
  test('decodes the explicit envelope into a detached, deeply frozen all-or-empty result', () => {
    const input = jsonValue(behavior([row()], [copyOutput()]));
    const before = stringifyLosslessJson(input);
    const hostNetworks = { red, green };
    const result = decodeBlueprintDeciderControlBehavior(input, hostNetworks);

    expect(result).toEqual({
      state: 'complete',
      configuration: {
        condition: {
          kind: 'compare',
          left: {
            kind: 'signal',
            signal: Signal('virtual', 'signal-A'),
            refKind: 'single',
            network: red,
          },
          comparator: '>',
          right: { kind: 'constant', value: 0 },
        },
        outputs: [{ mode: 'copy', signal: { kind: 'signal', signal: Signal('signal-output') } }],
      },
      diagnostics: [],
    });
    expect(stringifyLosslessJson(input)).toBe(before);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.diagnostics)).toBe(true);
    expect(Object.isFrozen(result.configuration)).toBe(true);
    expect(Object.isFrozen(result.configuration?.condition)).toBe(true);
    expect(Object.isFrozen(result.configuration?.outputs)).toBe(true);
    if (result.state === 'complete') {
      const condition = result.configuration.condition;
      expect(condition.kind).toBe('compare');
      if (condition.kind === 'compare' && condition.left.kind === 'signal') {
        expect(Object.isFrozen(condition.left)).toBe(true);
        expect(Object.isFrozen(condition.left.signal)).toBe(true);
      }
      expect(result.configuration.outputs[0]).not.toBe(copyOutput());
      hostNetworks.red = 'network:changed' as NetworkId;
      expect(JSON.stringify(result.configuration)).not.toContain('network:changed');
    }
  });

  test('requires an explicit object envelope and required arrays, preserving else presence', () => {
    for (const [value, path] of [
      [null, ''],
      [{}, '.decider_conditions'],
      [{ decider_conditions: null }, '.decider_conditions'],
      [{ decider_conditions: [] }, '.decider_conditions'],
      [{ decider_conditions: { outputs: [] } }, '.decider_conditions.conditions'],
      [{ decider_conditions: { conditions: [row()] } }, '.decider_conditions.outputs'],
      [behavior([], []), '.decider_conditions.conditions'],
      [behavior([row()], [], { else_outputs: {} }), '.decider_conditions.else_outputs'],
    ] as const) {
      expectBlocked(value, path);
    }

    const absent = decode(behavior([row()], []));
    const empty = decode(behavior([row()], [], { else_outputs: [] }));
    expect(absent.state).toBe('complete');
    expect(absent.configuration).not.toHaveProperty('elseOutputs');
    expect(empty.state).toBe('complete');
    expect(empty.configuration).toHaveProperty('elseOutputs', []);
    if (empty.state === 'complete')
      expect(Object.isFrozen(empty.configuration.elseOutputs)).toBe(true);
  });

  test('locates unknown fields at every accepted object depth', () => {
    const cases: readonly [unknown, string][] = [
      [{ ...behavior(), 'future.flag': true }, '["future.flag"]'],
      [
        { decider_conditions: { conditions: [row()], outputs: [], extra: true } },
        '.decider_conditions.extra',
      ],
      [behavior([row({ 'future key': true })]), '.decider_conditions.conditions[0]["future key"]'],
      [
        behavior([row({ first_signal: { name: 'A', 'future"key': true } })]),
        '.decider_conditions.conditions[0].first_signal["future\\\"key"]',
      ],
      [
        behavior([row({ first_signal_networks: { red: true, green: false, future: true } })]),
        '.decider_conditions.conditions[0].first_signal_networks.future',
      ],
      [
        behavior([row()], [copyOutput({ signal: { name: 'A', extra: true } })]),
        '.decider_conditions.outputs[0].signal.extra',
      ],
      [behavior([row()], [copyOutput({ extra: true })]), '.decider_conditions.outputs[0].extra'],
    ];
    for (const [value, path] of cases) expectBlocked(value, path);
  });

  test.each([
    ['>', '>'],
    ['<', '<'],
    ['=', '='],
    ['≥', '>='],
    ['≤', '<='],
    ['≠', '!='],
  ] as const)('maps native comparator %s to %s', (native, expected) => {
    const result = decode(behavior([row({ comparator: native })]));
    expect(result.state).toBe('complete');
    expect(result.configuration?.condition).toMatchObject({
      kind: 'compare',
      comparator: expected,
    });
  });

  test('decodes normal signals, explicit qualities and each left wildcard without conflation', () => {
    const result = decode(
      behavior([
        row({
          first_signal: { name: 'iron-plate', quality: 'normal' },
          first_signal_networks: { red: false, green: true },
          second_signal: { type: 'fluid', name: 'water', quality: 'uncommon' },
          second_signal_networks: { red: true, green: true },
          constant: undefined,
        }),
      ]),
    );
    expect(result.state).toBe('complete');
    expect(result.configuration?.condition).toEqual({
      kind: 'compare',
      left: {
        kind: 'signal',
        signal: Signal('item', 'iron-plate', 'normal'),
        refKind: 'single',
        network: green,
      },
      comparator: '>',
      right: {
        kind: 'signal',
        signal: Signal('fluid', 'water', 'uncommon'),
        refKind: 'pair',
        networks: [red, green],
      },
    });

    for (const [name, value] of [
      ['signal-each', 'each'],
      ['signal-anything', 'anything'],
      ['signal-everything', 'everything'],
    ] as const) {
      const wildcard = decode(behavior([row({ first_signal: { type: 'virtual', name } })]));
      expect(wildcard.state).toBe('complete');
      expect(wildcard.configuration?.condition).toMatchObject({
        left: { kind: 'wildcard', value, refKind: 'single', network: red },
      });
    }

    const sameNameConcrete = decode(
      behavior([row({ first_signal: { type: 'item', name: 'signal-each' } })]),
    );
    expect(sameNameConcrete.state).toBe('complete');
    expect(sameNameConcrete.configuration?.condition).toMatchObject({
      left: { kind: 'signal', signal: { type: 'item', name: 'signal-each' } },
    });
  });

  test('requires exact comparison fields, concrete right signals and explicit masks', () => {
    const cases: readonly [unknown, string][] = [
      [row({ first_signal: undefined }), '.decider_conditions.conditions[0].first_signal'],
      [
        row({ first_signal_networks: undefined }),
        '.decider_conditions.conditions[0].first_signal_networks',
      ],
      [row({ comparator: undefined }), '.decider_conditions.conditions[0].comparator'],
      [row({ constant: undefined }), '.decider_conditions.conditions[0].constant'],
      [
        row({
          second_signal: { name: 'signal-B' },
          second_signal_networks: undefined,
          constant: undefined,
        }),
        '.decider_conditions.conditions[0].second_signal_networks',
      ],
      [
        row({
          second_signal: { type: 'virtual', name: 'signal-each' },
          second_signal_networks: { red: true, green: false },
          constant: undefined,
        }),
        '.decider_conditions.conditions[0].second_signal.name',
      ],
      [
        row({
          second_signal: { type: 'unknown', name: 'x' },
          second_signal_networks: { red: true, green: false },
          constant: undefined,
        }),
        '.decider_conditions.conditions[0].second_signal.type',
      ],
      [
        row({ first_signal: { type: 'virtual', name: 'signal-each', quality: 'normal' } }),
        '.decider_conditions.conditions[0].first_signal.quality',
      ],
      [
        row({ first_signal: { type: 'item', name: 'signal-A', quality: 'bad\u0000quality' } }),
        '.decider_conditions.conditions[0].first_signal.quality',
      ],
      [row({ compare_type: undefined }), '.decider_conditions.conditions[0].compare_type'],
      [row({ compare_type: 'xor' }), '.decider_conditions.conditions[0].compare_type'],
      [row({ comparator: '>= ' }), '.decider_conditions.conditions[0].comparator'],
    ];
    for (const [invalidRow, path] of cases) expectBlocked(behavior([invalidRow]), path);

    expectBlocked(
      behavior([
        row({
          second_signal: { name: 'signal-B' },
          second_signal_networks: { red: true, green: false },
        }),
      ]),
      '.decider_conditions.conditions[0].second_signal',
    );
    expectBlocked(
      behavior([row({ constant: undefined, second_signal: { name: 'signal-B' } })]),
      '.decider_conditions.conditions[0].second_signal_networks',
    );
    expectBlocked(
      behavior([row({ constant: 0, second_signal_networks: { red: true, green: false } })]),
      '.decider_conditions.conditions[0].second_signal_networks',
    );
  });

  test('maps only selected host lanes and rejects missing, empty or conflicting masks', () => {
    for (const [mask, host, path] of [
      [
        { red: true, green: false },
        { green },
        '.decider_conditions.conditions[0].first_signal_networks.red',
      ],
      [
        { red: false, green: true },
        { red },
        '.decider_conditions.conditions[0].first_signal_networks.green',
      ],
      [
        { red: false, green: false },
        networks,
        '.decider_conditions.conditions[0].first_signal_networks',
      ],
      [{ red: true }, networks, '.decider_conditions.conditions[0].first_signal_networks.green'],
      [
        { red: true, green: 0 },
        networks,
        '.decider_conditions.conditions[0].first_signal_networks.green',
      ],
      [
        { red: true, green: false, blue: true },
        networks,
        '.decider_conditions.conditions[0].first_signal_networks.blue',
      ],
    ] as const) {
      expectBlocked(behavior([row({ first_signal_networks: mask })]), path, host);
    }

    const singleRed = decode(behavior([row()]), { red });
    const singleGreen = decode(
      behavior([row({ first_signal_networks: { red: false, green: true } })]),
      { green },
    );
    const pair = decode(behavior([row({ first_signal_networks: { red: true, green: true } })]));
    expect(singleRed.configuration?.condition).toMatchObject({
      left: { refKind: 'single', network: red },
    });
    expect(singleGreen.configuration?.condition).toMatchObject({
      left: { refKind: 'single', network: green },
    });
    expect(pair.configuration?.condition).toMatchObject({
      left: { refKind: 'pair', networks: [red, green] },
    });
    expect(() => decode(behavior(), { red, green: red })).toThrow(TypeError);
  });

  test('reconstructs ordered OR-of-AND groups without expansion or deduplication', () => {
    const result = decode(
      behavior([
        row({ first_signal: { type: 'virtual', name: 'A' } }),
        row({ first_signal: { type: 'virtual', name: 'B' } }),
        row({ first_signal: { type: 'virtual', name: 'B' }, compare_type: 'or' }),
        row({ first_signal: { type: 'virtual', name: 'A' }, compare_type: 'or' }),
      ]),
    );
    expect(result.state).toBe('complete');
    if (result.state !== 'complete') return;
    const groups = nativeDeciderConditionGroups(result.configuration.condition, 1024);
    expect(
      groups.map((group) => group.map(({ left }) => left.kind === 'signal' && left.signal.name)),
    ).toEqual([['A', 'B'], ['B'], ['A']]);
    expect(result.configuration.condition).toMatchObject({
      kind: 'or',
      conditions: [
        { kind: 'and', conditions: [{ kind: 'compare' }, { kind: 'compare' }] },
        { kind: 'compare' },
        { kind: 'compare' },
      ],
    });

    for (const invalid of [
      [row({ compare_type: 'or' })],
      [row({ compare_type: undefined })],
      [row({ compare_type: 'OR' })],
      [],
    ]) {
      const path =
        invalid.length === 0
          ? '.decider_conditions.conditions'
          : '.decider_conditions.conditions[0].compare_type';
      expectBlocked(behavior(invalid), path);
    }
  });

  test('decodes ordered copy and constant outputs, optional masks and else branch presence', () => {
    const result = decode(
      behavior(
        [row()],
        [
          copyOutput({
            signal: { type: 'virtual', name: 'signal-each' },
            networks: { red: true, green: true },
          }),
          {
            signal: { type: 'fluid', name: 'water', quality: 'rare' },
            copy_count_from_input: false,
            constant: -4,
            networks: { red: false, green: true },
          },
          copyOutput({ signal: { name: 'signal-output' } }),
        ],
        {
          else_outputs: [
            {
              signal: { type: 'virtual', name: 'signal-everything' },
              copy_count_from_input: false,
              constant: 0,
            },
          ],
        },
      ),
    );
    expect(result.state).toBe('complete');
    expect(result.configuration).toEqual({
      condition: {
        kind: 'compare',
        left: {
          kind: 'signal',
          signal: Signal('virtual', 'signal-A'),
          refKind: 'single',
          network: red,
        },
        comparator: '>',
        right: { kind: 'constant', value: 0 },
      },
      outputs: [
        {
          mode: 'copy',
          signal: { kind: 'wildcard', value: 'each' },
          input: { refKind: 'pair', networks: [red, green] },
        },
        {
          mode: 'constant',
          signal: { kind: 'signal', signal: Signal('fluid', 'water', 'rare') },
          value: -4,
          input: { refKind: 'single', network: green },
        },
        { mode: 'copy', signal: { kind: 'signal', signal: Signal('signal-output') } },
      ],
      elseOutputs: [
        { mode: 'constant', signal: { kind: 'wildcard', value: 'everything' }, value: 0 },
      ],
    });
    if (result.state === 'complete') {
      expect(Object.isFrozen(result.configuration.outputs)).toBe(true);
      expect(Object.isFrozen(result.configuration.outputs[0])).toBe(true);
      expect(Object.isFrozen(result.configuration.outputs[0]?.input)).toBe(true);
      expect(
        Object.isFrozen(
          result.configuration.outputs[0]?.input?.refKind === 'pair'
            ? result.configuration.outputs[0].input.networks
            : [],
        ),
      ).toBe(true);
      expect(Object.isFrozen(result.configuration.elseOutputs)).toBe(true);
    }

    const emptyThen = decode(behavior([row()], [], { else_outputs: [copyOutput()] }));
    expect(emptyThen.state).toBe('complete');
    expect(emptyThen.configuration).toMatchObject({ outputs: [], elseOutputs: [{ mode: 'copy' }] });
  });

  test('enforces exact copy/constant fields, signal domains and signed-int32 numeric literals', () => {
    const invalidOutputs: readonly [unknown, string][] = [
      [
        copyOutput({ copy_count_from_input: undefined }),
        '.decider_conditions.outputs[0].copy_count_from_input',
      ],
      [
        copyOutput({ copy_count_from_input: 'true' }),
        '.decider_conditions.outputs[0].copy_count_from_input',
      ],
      [copyOutput({ constant: 0 }), '.decider_conditions.outputs[0].constant'],
      [
        { signal: { name: 'A' }, copy_count_from_input: false },
        '.decider_conditions.outputs[0].constant',
      ],
      [
        { signal: { name: 'A' }, copy_count_from_input: true, constant: 0 },
        '.decider_conditions.outputs[0].constant',
      ],
      [
        copyOutput({ signal: { type: 'virtual', name: 'signal-anything', quality: 'normal' } }),
        '.decider_conditions.outputs[0].signal.quality',
      ],
    ];
    for (const [output, path] of invalidOutputs) expectBlocked(behavior([row()], [output]), path);
    expectBlocked(
      behavior([row()], [copyOutput()], {
        else_outputs: [copyOutput({ copy_count_from_input: undefined })],
      }),
      '.decider_conditions.else_outputs[0].copy_count_from_input',
    );

    for (const [lexeme, accepted] of [
      ['-2147483648', true],
      ['2147483647', true],
      ['-0', true],
      ['1.5', false],
      ['2147483648', false],
      ['-2147483649', false],
      ['9007199254740993', false],
      ['1e400', false],
    ] as const) {
      const source =
        `{"decider_conditions":{"conditions":[${JSON.stringify(row())}],` +
        `"outputs":[{"signal":{"name":"A"},"copy_count_from_input":false,"constant":${lexeme}}]}}`;
      const result = decodeSource(source);
      expect(result.state === 'complete', lexeme).toBe(accepted);
      if (accepted && result.state === 'complete' && lexeme === '-0') {
        expect(result.configuration.outputs[0]?.mode).toBe('constant');
        if (result.configuration.outputs[0]?.mode === 'constant') {
          expect(Object.is(result.configuration.outputs[0].value, -0)).toBe(true);
        }
      }
    }
  });

  test('applies pre-traversal condition and combined output row bounds and byte budget', () => {
    expectBlocked(
      behavior(
        [row()],
        Array.from({ length: 1025 }, () => null),
      ),
      '.decider_conditions.outputs',
    );
    expectBlocked(
      behavior(Array.from({ length: 1025 }, () => null)),
      '.decider_conditions.conditions',
    );
    expectBlocked(
      behavior(
        [row()],
        Array.from({ length: 1024 }, () => null),
        { else_outputs: [null] },
      ),
      '.decider_conditions.else_outputs',
    );

    const maxConditions = decode(behavior(Array.from({ length: 1024 }, () => row())));
    expect(maxConditions.state).toBe('complete');
    const maxOutputs = decode(
      behavior(
        [row()],
        Array.from({ length: 1024 }, () => copyOutput()),
      ),
    );
    expect(maxOutputs.state).toBe('complete');
    expect(maxOutputs.configuration?.outputs).toHaveLength(1024);

    const hugeSignal = 'x'.repeat(constantConfigurationLimits.maxBytes);
    expect(() => decode(behavior([row({ first_signal: { name: hugeSignal } })]))).toThrow(
      RangeError,
    );
  });

  test('validates plain host/options inputs, observes abort while traversing and stays internal', async () => {
    const valid = jsonValue(behavior());
    for (const invalid of [
      null,
      [],
      { red: '' },
      { red, green: red },
      { blue: red },
      Object.defineProperty({}, 'red', { get: () => red }),
    ]) {
      expect(() => decodeBlueprintDeciderControlBehavior(valid, invalid as never)).toThrow(
        TypeError,
      );
    }
    for (const options of [
      { extra: true },
      { path: 3 },
      Object.defineProperty({}, 'path', { get: () => '$' }),
      { signal: null },
    ]) {
      expect(() =>
        decodeBlueprintDeciderControlBehavior(valid, networks, options as never),
      ).toThrow(TypeError);
    }

    const aborted = new AbortController();
    aborted.abort();
    expect(() =>
      decodeBlueprintDeciderControlBehavior(valid, networks, { signal: aborted.signal }),
    ).toThrowError(expect.objectContaining({ name: 'AbortError' }));

    let reads = 0;
    const observedSignal = {
      get aborted() {
        reads += 1;
        return reads >= 8;
      },
    } as AbortSignal;
    expect(() =>
      decodeBlueprintDeciderControlBehavior(valid, networks, { signal: observedSignal }),
    ).toThrowError(expect.objectContaining({ name: 'AbortError' }));
    expect(reads).toBeGreaterThanOrEqual(8);

    const manifest = JSON.parse(
      await readFile(new URL('../package.json', import.meta.url), 'utf8'),
    ) as { exports: Record<string, string> };
    const barrel = await readFile(new URL('./index.ts', import.meta.url), 'utf8');
    expect(Object.values(manifest.exports)).not.toContain('./src/blueprint-import-decider.ts');
    expect(barrel).not.toContain('blueprint-import-decider');
  });

  test('round-trips explicit emitter output, logical groups, masks, qualities and branches', () => {
    const original: DeciderProducerConfig = {
      condition: {
        kind: 'or',
        conditions: [
          {
            kind: 'and',
            conditions: [
              {
                kind: 'compare',
                left: {
                  kind: 'signal',
                  signal: Signal('virtual', 'signal-A', 'normal'),
                  refKind: 'single',
                  network: red,
                },
                comparator: '>=',
                right: {
                  kind: 'signal',
                  signal: Signal('fluid', 'water', 'uncommon'),
                  refKind: 'pair',
                  networks: [red, green],
                },
              },
              {
                kind: 'compare',
                left: {
                  kind: 'wildcard',
                  value: 'anything',
                  refKind: 'pair',
                  networks: [red, green],
                },
                comparator: '!=',
                right: { kind: 'constant', value: -2 },
              },
            ],
          },
          {
            kind: 'compare',
            left: {
              kind: 'signal',
              signal: Signal('item', 'iron-plate'),
              refKind: 'single',
              network: green,
            },
            comparator: '<',
            right: { kind: 'constant', value: 0 },
          },
        ],
      },
      outputs: [
        {
          mode: 'copy',
          signal: { kind: 'wildcard', value: 'each' },
          input: { refKind: 'pair', networks: [red, green] },
        },
        {
          mode: 'constant',
          signal: { kind: 'signal', signal: Signal('item', 'signal-each', 'normal') },
          value: -5,
          input: { refKind: 'single', network: red },
        },
      ],
      elseOutputs: [
        {
          mode: 'constant',
          signal: { kind: 'wildcard', value: 'everything' },
          value: 2,
        },
      ],
    };
    const first = emittedBehavior(original);
    const result = decode(first, networks);
    expect(result.state).toBe('complete');
    expect(result.configuration).toEqual(original);
    if (result.state !== 'complete') return;
    const second = emittedBehavior(result.configuration);
    expect(second).toEqual(first);
    expect(result.configuration.condition.kind).toBe('or');
  });
});

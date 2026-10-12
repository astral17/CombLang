import { readFile } from 'node:fs/promises';

import { constantConfigurationLimits, Signal } from '@comblang/factorio';
import { parseLosslessJson } from '@comblang/blueprint/document';
import type { NetworkId, ProducerId } from '@comblang/shared';
import { describe, expect, test } from 'vitest';

import { lowerNativeBlueprintConfig } from './blueprint-native-config.js';
import { decodeBlueprintSelectorControlBehavior } from './blueprint-import-selector.js';
import type { LogicalNetworkRef, NativeCircuitIr, SelectorProducerConfig } from './ir.js';

const red = 'network:selector-red' as NetworkId;
const green = 'network:selector-green' as NetworkId;
const output = 'network:selector-output' as NetworkId;
const provenance = { instancePath: [], expansionStack: [] };

function jsonValue(value: unknown) {
  return parseLosslessJson(JSON.stringify(value));
}

function decode(
  value: unknown,
  input: LogicalNetworkRef = { refKind: 'single', network: red },
  options?: Parameters<typeof decodeBlueprintSelectorControlBehavior>[2],
) {
  return decodeBlueprintSelectorControlBehavior(jsonValue(value), input, options);
}

function decodeText(
  text: string,
  input: LogicalNetworkRef = { refKind: 'single', network: red },
  options?: Parameters<typeof decodeBlueprintSelectorControlBehavior>[2],
) {
  return decodeBlueprintSelectorControlBehavior(parseLosslessJson(text), input, options);
}

function expectBlocked(
  value: unknown,
  path: string,
  input: LogicalNetworkRef = { refKind: 'single', network: red },
) {
  const result = decode(value, input, { path: '$.native.control_behavior' });
  expect(result.state).toBe('blocked');
  expect(result.configuration).toBeUndefined();
  expect(result.diagnostics).toEqual([
    expect.objectContaining({
      category: 'unsupported-selector-configuration',
      path: `$.native.control_behavior${path}`,
    }),
  ]);
  expect(Object.isFrozen(result)).toBe(true);
  expect(Object.isFrozen(result.diagnostics)).toBe(true);
  expect(Object.isFrozen(result.diagnostics[0])).toBe(true);
  return result;
}

function selectorIr(config: SelectorProducerConfig): NativeCircuitIr {
  return {
    format: 'comblang-ncir',
    networks: [
      { id: red, color: 'red', provenance },
      { id: green, color: 'green', provenance },
      { id: output, color: 'red', provenance },
    ],
    entities: [],
    producers: [
      {
        id: 'producer:selector-import' as ProducerId,
        kind: 'selector',
        config,
        destinations: [output],
        provenance,
      },
    ],
  };
}

function emittedBehavior(config: SelectorProducerConfig) {
  return lowerNativeBlueprintConfig(selectorIr(config), 1024).combinators[0]!.entity
    .control_behavior;
}

describe('inverse Selector control_behavior conversion', () => {
  test('decodes explicit Select integer indices, both select_max values and int32 endpoints', () => {
    for (const [literal, expected] of [
      ['0', 0],
      ['-1', -1],
      ['-2147483648', -2_147_483_648],
      ['2147483647', 2_147_483_647],
    ] as const) {
      for (const selectMax of [false, true]) {
        const result = decodeText(
          `{"operation":"select","select_max":${selectMax},"index_constant":${literal}}`,
          { refKind: 'pair', networks: [red, green] },
        );
        expect(result.state).toBe('complete');
        if (result.state !== 'complete') continue;
        expect(result.configuration).toEqual({
          operation: 'select',
          input: { refKind: 'pair', networks: [red, green] },
          selectMax,
          index: expected,
        });
      }
    }

    const negativeZero = decodeText(
      '{"operation":"select","select_max":false,"index_constant":-0}',
    );
    expect(negativeZero.state).toBe('complete');
    if (negativeZero.state === 'complete' && negativeZero.configuration.operation === 'select') {
      expect(Object.is(negativeZero.configuration.index, -0)).toBe(true);
    }
  });

  test('requires exact Select fields and rejects numeric normalization or unsupported variants', () => {
    expectBlocked({ operation: 'select', index_constant: 0 }, '.select_max');
    expectBlocked({ operation: 'select', select_max: 1, index_constant: 0 }, '.select_max');
    expectBlocked({ operation: 'select', select_max: false }, '.index_constant');
    expectBlocked(
      {
        operation: 'select',
        select_max: false,
        index_constant: 0,
        index_signal: { name: 'signal-A' },
      },
      '.index_signal',
    );
    for (const literal of [
      '1.5',
      '-1.5',
      '2147483648',
      '-2147483649',
      '9007199254740993',
      '1e9999',
      '1e-999',
    ]) {
      const result = decodeText(
        `{"operation":"select","select_max":true,"index_constant":${literal}}`,
        { refKind: 'single', network: green },
      );
      expect(result.state, literal).toBe('blocked');
      expect(result.diagnostics[0]?.path, literal).toBe('$.index_constant');
    }
    expectBlocked(
      { operation: 'select', select_max: false, index_constant: 0, index_comparator: '>' },
      '.index_comparator',
    );
    expectBlocked(
      { operation: 'select', select_max: false, index_constant: 0, select_highest_quality: true },
      '.select_highest_quality',
    );
  });

  test('decodes Count and refuses missing operations and cross-operation fields', () => {
    const result = decode(
      { operation: 'count', count_signal: { name: 'iron-plate' } },
      {
        refKind: 'single',
        network: green,
      },
    );
    expect(result).toMatchObject({
      state: 'complete',
      configuration: {
        operation: 'count',
        input: { refKind: 'single', network: green },
        output: Signal('item', 'iron-plate'),
      },
      diagnostics: [],
    });

    expectBlocked({ select_max: false, index_constant: 0 }, '.operation');
    expectBlocked({ operation: 'quality-select', select_max: false }, '.operation');
    expectBlocked({ operation: 'count' }, '.count_signal');
    expectBlocked(
      { operation: 'count', select_max: false, count_signal: { name: 'x' } },
      '.select_max',
    );
    expectBlocked(
      { operation: 'select', select_max: false, count_signal: { name: 'x' }, index_constant: 0 },
      '.count_signal',
    );
    expectBlocked({ operation: null, count_signal: { name: 'x' } }, '.operation');
  });

  test('quotes unknown keys at every accepted object depth and requires a lossless object root', () => {
    expectBlocked(null, '');
    expectBlocked([], '');
    expectBlocked(
      { operation: 'count', count_signal: { name: 'x', 'future"key': true } },
      '.count_signal["future\\\"key"]',
    );
    expectBlocked(
      { operation: 'count', count_signal: { name: 'x', extra: true } },
      '.count_signal.extra',
    );
    expectBlocked(
      { operation: 'count', count_signal: { name: 'x' }, 'future"key': true },
      '["future\\\"key"]',
    );
    const missing = decodeBlueprintSelectorControlBehavior(undefined, {
      refKind: 'single',
      network: red,
    });
    expect(missing).toMatchObject({
      state: 'blocked',
      diagnostics: [expect.objectContaining({ path: '$' })],
    });
  });

  test('preserves concrete Signal defaults, optional quality presence, Unicode and escaping', () => {
    for (const [signal, expected] of [
      [{ name: 'signal-A' }, Signal('item', 'signal-A')],
      [{ name: 'signal-A', quality: 'normal' }, Signal('item', 'signal-A', 'normal')],
      [{ type: 'fluid', name: 'water', quality: 'uncommon' }, Signal('fluid', 'water', 'uncommon')],
      [{ type: 'item', name: 'signal-each' }, Signal('item', 'signal-each')],
      [{ type: 'virtual', name: 'signal-A' }, Signal('virtual', 'signal-A')],
      [
        { type: 'virtual', name: 'signal-A', quality: 'normal' },
        Signal('virtual', 'signal-A', 'normal'),
      ],
    ] as const) {
      const result = decode({ operation: 'select', select_max: true, index_signal: signal });
      expect(result.state).toBe('complete');
      if (result.state === 'complete') {
        expect(Object.isFrozen(result)).toBe(true);
        expect(Object.isFrozen(result.diagnostics)).toBe(true);
        expect(Object.isFrozen(result.configuration)).toBe(true);
        expect(result.configuration.operation).toBe('select');
        if (result.configuration.operation === 'select') {
          expect(result.configuration.index).toEqual(expected);
          expect(Object.isFrozen(result.configuration.index as object)).toBe(true);
          expect(Object.hasOwn(result.configuration.index as object, 'quality')).toBe(
            Object.hasOwn(expected as object, 'quality'),
          );
        }
      }
    }

    const unusual = '水 "quoted" \\ café';
    const decoded = decode({ operation: 'count', count_signal: { type: 'recipe', name: unusual } });
    expect(decoded.state).toBe('complete');
    if (decoded.state === 'complete' && decoded.configuration.operation === 'count') {
      expect(decoded.configuration.output).toEqual(Signal('recipe', unusual));
      expect(Object.isFrozen(decoded.configuration.output)).toBe(true);
    }
  });

  test('rejects malformed and wildcard concrete signal identities at their native paths', () => {
    for (const [signal, path] of [
      [null, '.index_signal'],
      [[], '.index_signal'],
      [{}, '.index_signal.name'],
      [{ name: '' }, '.index_signal.name'],
      [{ name: 'x', type: 'unknown' }, '.index_signal.type'],
      [{ name: 'x', quality: '' }, '.index_signal.quality'],
      [{ name: 'x', quality: null }, '.index_signal.quality'],
      [{ name: 'x', future: true }, '.index_signal.future'],
    ] as const) {
      expectBlocked({ operation: 'select', select_max: false, index_signal: signal }, path);
    }
    for (const wildcard of ['signal-each', 'signal-anything', 'signal-everything']) {
      expectBlocked(
        { operation: 'count', count_signal: { type: 'virtual', name: wildcard } },
        '.count_signal.name',
      );
      expectBlocked(
        {
          operation: 'select',
          select_max: false,
          index_signal: { type: 'virtual', name: wildcard },
        },
        '.index_signal.name',
      );
    }
    expectBlocked(
      { operation: 'count', count_signal: { name: 'bad\u0000name' } },
      '.count_signal.name',
    );
    expectBlocked(
      { operation: 'count', count_signal: { name: 'x', quality: 'bad\u0000quality' } },
      '.count_signal.quality',
    );
  });

  test('enforces the exact serialized byte limit across names, qualities and host references', () => {
    const small = decode({
      operation: 'count',
      count_signal: { name: 'x', quality: 'uncommon' },
    });
    expect(small.state).toBe('complete');
    if (small.state !== 'complete') return;
    const baseBytes = new TextEncoder().encode(JSON.stringify(small.configuration)).byteLength;
    const exactName = 'x'.repeat(1 + constantConfigurationLimits.maxBytes - baseBytes);
    const atLimit = decode({
      operation: 'count',
      count_signal: { name: exactName, quality: 'uncommon' },
    });
    expect(atLimit.state).toBe('complete');
    if (atLimit.state === 'complete') {
      expect(new TextEncoder().encode(JSON.stringify(atLimit.configuration)).byteLength).toBe(
        constantConfigurationLimits.maxBytes,
      );
    }
    expect(() =>
      decode({
        operation: 'count',
        count_signal: { name: `${exactName}x`, quality: 'uncommon' },
      }),
    ).toThrow(RangeError);
    expect(() =>
      decode(
        { operation: 'count', count_signal: { name: 'x' } },
        {
          refKind: 'single',
          network: `network:${'n'.repeat(constantConfigurationLimits.maxBytes)}` as NetworkId,
        },
      ),
    ).toThrow(RangeError);
  });

  test('validates and snapshots exact host references, freezes results, observes abort and stays internal', async () => {
    const tuple = [green, red] as [NetworkId, NetworkId];
    const hostInput: LogicalNetworkRef = { refKind: 'pair', networks: tuple };
    const completed = decode(
      { operation: 'select', select_max: false, index_constant: 4 },
      hostInput,
    );
    expect(completed.state).toBe('complete');
    if (completed.state === 'complete') {
      tuple[0] = red;
      expect(completed.configuration.input).toEqual({ refKind: 'pair', networks: [green, red] });
      expect(Object.isFrozen(completed)).toBe(true);
      expect(Object.isFrozen(completed.diagnostics)).toBe(true);
      expect(Object.isFrozen(completed.configuration)).toBe(true);
      expect(Object.isFrozen(completed.configuration.input)).toBe(true);
      if (completed.configuration.input.refKind === 'pair') {
        expect(Object.isFrozen(completed.configuration.input.networks)).toBe(true);
      }
      expect(Object.isFrozen(tuple)).toBe(false);
      expect(Object.isFrozen(hostInput)).toBe(false);
    }

    const invalidPairs: unknown[] = [
      null,
      [],
      { refKind: 'single', network: '' },
      { refKind: 'single', network: red, extra: true },
      { refKind: 'pair', networks: ['', green] },
      Object.defineProperty({ refKind: 'single' }, 'network', { get: () => red }),
      Object.defineProperty({}, 'refKind', { get: () => 'single' }),
      { refKind: 'pair', networks: [red] },
      { refKind: 'pair', networks: [red, red] },
      { refKind: 'pair', networks: [red, green, output] },
      { refKind: 'pair', networks: Object.assign([red, green], { extra: true }) },
      { refKind: 'pair', networks: Object.assign([red, green], { [Symbol('extra')]: true }) },
      { refKind: 'pair', networks: [red, , green] },
    ];
    const accessorTuple = [red, green];
    Object.defineProperty(accessorTuple, '0', { get: () => red });
    invalidPairs.push({ refKind: 'pair', networks: accessorTuple });
    const symbolInput = { refKind: 'single', network: red, [Symbol('extra')]: true };
    invalidPairs.push(symbolInput, Object.create({ inherited: true }));
    for (const input of invalidPairs) {
      expect(() =>
        decodeBlueprintSelectorControlBehavior(
          jsonValue({ operation: 'count', count_signal: { name: 'x' } }),
          input as never,
        ),
      ).toThrow(TypeError);
    }

    for (const options of [
      { extra: true },
      { path: 3 },
      Object.assign(Object.create({ inherited: true }), { path: '$' }),
      { [Symbol('extra')]: true },
      Object.defineProperty({}, 'path', { get: () => '$' }),
      { signal: null },
    ]) {
      expect(() =>
        decodeBlueprintSelectorControlBehavior(
          jsonValue({ operation: 'count', count_signal: { name: 'x' } }),
          { refKind: 'single', network: red },
          options as never,
        ),
      ).toThrow(TypeError);
    }

    const aborted = new AbortController();
    aborted.abort();
    expect(() =>
      decode(
        { operation: 'count', count_signal: { name: 'x' } },
        { refKind: 'single', network: red },
        { signal: aborted.signal },
      ),
    ).toThrowError(expect.objectContaining({ name: 'AbortError' }));

    let reads = 0;
    const observedSignal = {
      get aborted() {
        reads += 1;
        return reads >= 8;
      },
    } as AbortSignal;
    expect(() =>
      decode(
        { operation: 'count', count_signal: { name: 'x'.repeat(2048) } },
        { refKind: 'pair', networks: [red, green] },
        { signal: observedSignal },
      ),
    ).toThrowError(expect.objectContaining({ name: 'AbortError' }));
    expect(reads).toBeGreaterThanOrEqual(8);

    const manifest = JSON.parse(
      await readFile(new URL('../package.json', import.meta.url), 'utf8'),
    ) as { exports: Record<string, string> };
    const barrel = await readFile(new URL('./index.ts', import.meta.url), 'utf8');
    expect(Object.values(manifest.exports)).not.toContain('./src/blueprint-import-selector.ts');
    expect(barrel).not.toContain('blueprint-import-selector');
  });

  test('round-trips only current-emitter Select and Count shapes with explicit host inputs', () => {
    const configurations: readonly SelectorProducerConfig[] = [
      {
        operation: 'select',
        input: { refKind: 'single', network: green },
        selectMax: false,
        index: 0,
      },
      {
        operation: 'select',
        input: { refKind: 'pair', networks: [green, red] },
        selectMax: true,
        index: Signal('virtual', 'signal-index', 'rare'),
      },
      {
        operation: 'count',
        input: { refKind: 'single', network: red },
        output: Signal('item', 'iron-plate', 'uncommon'),
      },
    ];

    for (const original of configurations) {
      const nativeBehavior = emittedBehavior(original);
      const parsed = parseLosslessJson(JSON.stringify(nativeBehavior));
      const result = decodeBlueprintSelectorControlBehavior(parsed, original.input);
      expect(result.state).toBe('complete');
      if (result.state === 'complete') expect(result.configuration).toEqual(original);
    }
  });
});

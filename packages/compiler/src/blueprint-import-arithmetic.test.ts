import { constantConfigurationLimits, Signal } from '@comblang/factorio';
import { parseLosslessJson, stringifyLosslessJson } from '@comblang/blueprint/document';
import type { NetworkId, ProducerId } from '@comblang/shared';
import { describe, expect, test } from 'vitest';

import { lowerNativeBlueprintConfig } from './blueprint-native-config.js';
import { decodeBlueprintArithmeticControlBehavior } from './blueprint-import-arithmetic.js';
import type { ArithmeticProducerConfig, NativeCircuitIr } from './ir.js';

const red = 'network:arithmetic-red' as NetworkId;
const green = 'network:arithmetic-green' as NetworkId;
const outputNetwork = 'network:arithmetic-output' as NetworkId;
const networks = { red, green };
const provenance = { instancePath: [], expansionStack: [] };
const networkNodes: NativeCircuitIr['networks'] = [
  { id: red, color: 'red', provenance },
  { id: green, color: 'green', provenance },
  { id: outputNetwork, color: 'red', provenance },
];

function decode(
  conditions: Record<string, unknown>,
  inputNetworks: { red?: NetworkId; green?: NetworkId } = {},
  options?: Parameters<typeof decodeBlueprintArithmeticControlBehavior>[2],
) {
  return decodeBlueprintArithmeticControlBehavior(
    parseLosslessJson(JSON.stringify({ arithmetic_conditions: conditions })),
    inputNetworks,
    options,
  );
}

function config(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    first_constant: 3,
    operation: '+',
    second_constant: 4,
    output_signal: { name: 'signal-A' },
    ...overrides,
  };
}

function expectBlocked(
  conditions: Record<string, unknown>,
  path: string,
  inputNetworks: { red?: NetworkId; green?: NetworkId } = networks,
): void {
  const result = decode(conditions, inputNetworks, {
    path: '$.blueprint.entities[3].control_behavior',
  });
  expect(result.state).toBe('blocked');
  expect(result.configuration).toBeUndefined();
  expect(result.diagnostics).toEqual([
    expect.objectContaining({
      category: 'unsupported-arithmetic-configuration',
      path: `$.blueprint.entities[3].control_behavior${path}`,
    }),
  ]);
  expect(Object.isFrozen(result)).toBe(true);
  expect(Object.isFrozen(result.diagnostics)).toBe(true);
  expect(Object.isFrozen(result.diagnostics[0])).toBe(true);
}

function irForArithmetic(configuration: ArithmeticProducerConfig): NativeCircuitIr {
  return {
    format: 'comblang-ncir',
    networks: networkNodes,
    entities: [],
    producers: [
      {
        id: 'producer:arithmetic' as ProducerId,
        kind: 'arithmetic',
        config: configuration,
        destinations: [outputNetwork],
        provenance,
      },
    ],
  };
}

function emittedConditions(ir: NativeCircuitIr): Record<string, unknown> {
  const lowered = lowerNativeBlueprintConfig(ir, 1024);
  return lowered.combinators[0]!.entity.control_behavior as Record<string, unknown>;
}

describe('inverse Arithmetic control_behavior conversion', () => {
  test('decodes an independent literal including operation, selected input and Each output', () => {
    const source =
      '{"arithmetic_conditions":{"first_constant":-2147483648,"operation":"+",' +
      '"second_signal":{"type":"fluid","name":"water","quality":"uncommon"},' +
      '"second_signal_networks":{"red":false,"green":true},' +
      '"output_signal":{"type":"virtual","name":"signal-each"}}}';
    const input = parseLosslessJson(source);
    const before = stringifyLosslessJson(input);
    const result = decodeBlueprintArithmeticControlBehavior(input, networks);

    expect(result.state).toBe('complete');
    expect(result.configuration).toEqual({
      left: { kind: 'constant', value: -2_147_483_648 },
      operation: 'add',
      right: {
        kind: 'signal',
        signal: { type: 'fluid', name: 'water', quality: 'uncommon' },
        refKind: 'single',
        network: green,
      },
      output: { kind: 'each' },
    });
    expect(stringifyLosslessJson(input)).toBe(before);
    expect(Object.isFrozen(result.configuration)).toBe(true);
    expect(Object.isFrozen(result.configuration?.right)).toBe(true);
    expect(
      Object.isFrozen(
        result.configuration?.right.kind === 'signal' ? result.configuration.right.signal : {},
      ),
    ).toBe(true);
  });

  test('round-trips ordinary NCIR through lower, lossless parse, decode and lower again', () => {
    const original: ArithmeticProducerConfig = {
      left: {
        kind: 'signal',
        signal: Signal('virtual', 'signal-A'),
        refKind: 'single',
        network: red,
      },
      operation: 'bit-xor',
      right: { kind: 'each', refKind: 'pair', networks: [red, green] },
      output: { kind: 'signal', signal: Signal('fluid', 'water', 'rare') },
    };
    const firstIr = irForArithmetic(original);
    const first = emittedConditions(firstIr);
    const lossless = parseLosslessJson(JSON.stringify(first));
    const result = decodeBlueprintArithmeticControlBehavior(lossless, networks);

    expect(result.state).toBe('complete');
    expect(result.configuration).toEqual(original);
    expect(
      Object.isFrozen(
        result.configuration?.right.kind === 'each' && result.configuration.right.refKind === 'pair'
          ? result.configuration.right.networks
          : [],
      ),
    ).toBe(true);
    const secondIr: NativeCircuitIr = {
      ...firstIr,
      producers: firstIr.producers.map((producer) =>
        producer.kind === 'arithmetic' && result.state === 'complete'
          ? { ...producer, config: result.configuration }
          : producer,
      ),
    };
    expect(emittedConditions(secondIr)).toEqual(first);
  });

  test.each([
    ['+', 'add'],
    ['-', 'subtract'],
    ['*', 'multiply'],
    ['/', 'divide'],
    ['%', 'modulo'],
    ['^', 'power'],
    ['<<', 'left-shift'],
    ['>>', 'right-shift'],
    ['AND', 'bit-and'],
    ['OR', 'bit-or'],
    ['XOR', 'bit-xor'],
  ] as const)('maps native operation %s to %s without evaluation', (native, operation) => {
    const result = decode(
      config({ operation: native, first_constant: -2_147_483_648, second_constant: 2_147_483_647 }),
      {},
    );
    expect(result.state).toBe('complete');
    expect(result.configuration).toEqual({
      left: { kind: 'constant', value: -2_147_483_648 },
      operation,
      right: { kind: 'constant', value: 2_147_483_647 },
      output: { kind: 'signal', signal: Signal('signal-A') },
    });
  });

  test('uses selected host colors independently and preserves pair order and repeated references', () => {
    const result = decode(
      config({
        first_constant: undefined,
        first_signal: { name: 'signal-A' },
        first_signal_networks: { red: true, green: false },
        second_constant: undefined,
        second_signal: { type: 'virtual', name: 'signal-B' },
        second_signal_networks: { red: true, green: true },
      }),
      networks,
    );
    expect(result.state).toBe('complete');
    expect(result.configuration?.left).toEqual({
      kind: 'signal',
      signal: Signal('signal-A'),
      refKind: 'single',
      network: red,
    });
    expect(result.configuration?.right).toEqual({
      kind: 'signal',
      signal: Signal('virtual', 'signal-B'),
      refKind: 'pair',
      networks: [red, green],
    });
    expect(
      result.configuration?.right.kind === 'signal' &&
        result.configuration.right.refKind === 'pair' &&
        Object.isFrozen(result.configuration.right.networks),
    ).toBe(true);

    const greenOnly = decode(
      config({
        first_constant: undefined,
        first_signal: { name: 'signal-A' },
        first_signal_networks: { red: false, green: true },
      }),
      networks,
    );
    expect(greenOnly.state).toBe('complete');
    expect(greenOnly.configuration?.left).toMatchObject({ refKind: 'single', network: green });
    expect(greenOnly.configuration?.right).toEqual({ kind: 'constant', value: 4 });
  });

  test('keeps an unused host color out of the result and permits both-constant inputs without IDs', () => {
    const constants = decode(config(), {});
    expect(constants.state).toBe('complete');
    expect(constants.configuration).toEqual({
      left: { kind: 'constant', value: 3 },
      operation: 'add',
      right: { kind: 'constant', value: 4 },
      output: { kind: 'signal', signal: Signal('signal-A') },
    });

    const selected = decode(
      config({
        first_constant: undefined,
        first_signal: { name: 'signal-A' },
        first_signal_networks: { red: true, green: false },
      }),
      { red, green: 'unused'.repeat(constantConfigurationLimits.maxBytes) as NetworkId },
    );
    expect(selected.state).toBe('complete');
    expect(selected.configuration?.left).toMatchObject({ refKind: 'single', network: red });
    expect(JSON.stringify(selected.configuration)).not.toContain('unused');
  });

  test('applies Signal defaults and distinguishes concrete same-spelled items from Each', () => {
    const result = decode(
      config({
        output_signal: { type: 'item', name: 'signal-each' },
        first_constant: undefined,
        first_signal: { name: 'iron-plate' },
        first_signal_networks: { red: true, green: false },
        second_constant: undefined,
        second_signal: { type: 'virtual', name: 'signal-each' },
        second_signal_networks: { red: false, green: true },
      }),
      networks,
    );
    expect(result.state).toBe('complete');
    expect(result.configuration?.left).toMatchObject({
      kind: 'signal',
      signal: { type: 'item', name: 'iron-plate' },
    });
    expect(result.configuration?.right).toMatchObject({
      kind: 'each',
      refKind: 'single',
      network: green,
    });
    expect(result.configuration?.output).toEqual({
      kind: 'signal',
      signal: { type: 'item', name: 'signal-each' },
    });

    const explicitNormal = decode(
      config({ output_signal: { name: 'signal-A', quality: 'normal' } }),
      {},
    );
    expect(explicitNormal.state).toBe('complete');
    expect(explicitNormal.configuration?.output).toEqual({
      kind: 'signal',
      signal: { type: 'item', name: 'signal-A', quality: 'normal' },
    });
  });

  test('blocks unsupported wildcard identities and every quality-bearing wildcard position', () => {
    for (const name of ['signal-anything', 'signal-everything']) {
      expectBlocked(
        config({ output_signal: { type: 'virtual', name } }),
        '.arithmetic_conditions.output_signal.name',
      );
      for (const side of ['first', 'second'] as const) {
        expectBlocked(
          config({
            [`${side}_constant`]: undefined,
            [`${side}_signal`]: { type: 'virtual', name },
            [`${side}_signal_networks`]: { red: true, green: false },
          }),
          `.arithmetic_conditions.${side}_signal.name`,
        );
      }
    }
    for (const side of ['first', 'second'] as const) {
      expectBlocked(
        config({
          [`${side}_constant`]: undefined,
          [`${side}_signal`]: { type: 'virtual', name: 'signal-each', quality: 'normal' },
          [`${side}_signal_networks`]: { red: true, green: false },
        }),
        `.arithmetic_conditions.${side}_signal.quality`,
      );
    }
    expectBlocked(
      config({ output_signal: { type: 'virtual', name: 'signal-each', quality: 'normal' } }),
      '.arithmetic_conditions.output_signal.quality',
    );
  });

  test('requires complete masks and the selected host Network IDs', () => {
    expectBlocked(
      config({ first_constant: undefined, first_signal: { name: 'signal-A' } }),
      '.arithmetic_conditions.first_signal_networks',
    );
    expectBlocked(
      config({
        first_constant: undefined,
        first_signal: { name: 'signal-A' },
        first_signal_networks: { red: true },
      }),
      '.arithmetic_conditions.first_signal_networks.green',
    );
    expectBlocked(
      config({
        first_constant: undefined,
        first_signal: { name: 'signal-A' },
        first_signal_networks: { red: false, green: false },
      }),
      '.arithmetic_conditions.first_signal_networks',
    );
    expectBlocked(
      config({
        first_constant: undefined,
        first_signal: { name: 'signal-A' },
        first_signal_networks: { red: true, green: false },
      }),
      '.arithmetic_conditions.first_signal_networks.red',
      {},
    );
  });

  test('blocks ambiguous operands, constant masks, malformed values and unknown operations', () => {
    expectBlocked(
      config({
        first_signal: { name: 'signal-A' },
        first_signal_networks: { red: true, green: false },
      }),
      '.arithmetic_conditions.first_signal',
    );
    expectBlocked(
      config({ first_signal_networks: { red: false, green: false } }),
      '.arithmetic_conditions.first_signal_networks',
    );
    expectBlocked(config({ operation: 'and' }), '.arithmetic_conditions.operation');
    expectBlocked(config({ operation: undefined }), '.arithmetic_conditions.operation');
    expectBlocked(config({ output_signal: undefined }), '.arithmetic_conditions.output_signal');
    expectBlocked(
      config({
        first_constant: undefined,
        first_signal: { type: 'unknown', name: 'x' },
        first_signal_networks: { red: true, green: false },
      }),
      '.arithmetic_conditions.first_signal.type',
    );
    expectBlocked(
      config({ output_signal: { name: 'signal-A', quality: 'bad\u0000quality' } }),
      '.arithmetic_conditions.output_signal.quality',
    );
    for (const value of ['1.5', '9007199254740993', '2147483648', '-2147483649']) {
      const source =
        `{"arithmetic_conditions":{"first_constant":${value},"operation":"+",` +
        '"second_constant":0,"output_signal":{"name":"signal-A"}}}';
      const result = decodeBlueprintArithmeticControlBehavior(parseLosslessJson(source), {});
      expect(result.state).toBe('blocked');
      expect(result.diagnostics[0]?.path).toBe('$.arithmetic_conditions.first_constant');
    }
  });

  test('quotes unknown keys at root, conditions, mask and signal levels', () => {
    const root = decodeBlueprintArithmeticControlBehavior(
      parseLosslessJson('{"arithmetic_conditions":{},"future.flag":true}'),
      {},
    );
    expect(root.diagnostics[0]?.path).toBe('$["future.flag"]');
    expectBlocked(config({ 'future key': 1 }), '.arithmetic_conditions["future key"]');
    expectBlocked(
      config({
        first_constant: undefined,
        first_signal: { name: 'signal-A', 'future"key': true },
        first_signal_networks: { red: true, green: false },
      }),
      '.arithmetic_conditions.first_signal["future\\\"key"]',
    );
    expectBlocked(
      config({
        first_constant: undefined,
        first_signal: { name: 'signal-A' },
        first_signal_networks: { red: true, green: false, 'future\n': true },
      }),
      '.arithmetic_conditions.first_signal_networks["future\\n"]',
    );
  });

  test('preserves unsupported lossless input and freezes all new structures', () => {
    const source =
      '{"arithmetic_conditions":{"first_constant":9007199254740993,"operation":"+",' +
      '"second_constant":0,"output_signal":{"name":"signal-A"}},' +
      '"extension":{"lexeme":1e400}}';
    const input = parseLosslessJson(source);
    const before = stringifyLosslessJson(input);
    const result = decodeBlueprintArithmeticControlBehavior(
      input,
      {},
      { path: '$.native.control_behavior' },
    );
    expect(result.state).toBe('blocked');
    expect(result.configuration).toBeUndefined();
    expect(result.diagnostics[0]?.path).toBe('$.native.control_behavior.extension');
    expect(stringifyLosslessJson(input)).toBe(before);
    expect(result).not.toHaveProperty('context');
    expect(result).not.toHaveProperty('profile');
  });

  test('enforces exact aggregate serialized byte boundary and counts referenced IDs', () => {
    const small = decode(
      config({
        first_constant: undefined,
        first_signal: { name: 'x' },
        first_signal_networks: { red: true, green: false },
      }),
      { red },
    );
    expect(small.state).toBe('complete');
    const baseBytes = new TextEncoder().encode(JSON.stringify(small.configuration)).byteLength;
    const exactName = 'x'.repeat(1 + constantConfigurationLimits.maxBytes - baseBytes);
    const atLimit = decode(
      config({
        first_constant: undefined,
        first_signal: { name: exactName },
        first_signal_networks: { red: true, green: false },
      }),
      { red },
    );
    expect(atLimit.state).toBe('complete');
    expect(new TextEncoder().encode(JSON.stringify(atLimit.configuration)).byteLength).toBe(
      constantConfigurationLimits.maxBytes,
    );

    expect(() =>
      decode(
        config({
          first_constant: undefined,
          first_signal: { name: `${exactName}x` },
          first_signal_networks: { red: true, green: false },
        }),
        { red },
      ),
    ).toThrow(RangeError);
    expect(() =>
      decode(
        config({
          first_constant: undefined,
          first_signal: { name: 'signal-A' },
          first_signal_networks: { red: true, green: false },
        }),
        { red: 'n'.repeat(constantConfigurationLimits.maxBytes) as NetworkId },
      ),
    ).toThrow(RangeError);
  });

  test('validates caller maps/options, observes cancellation, and stays private', async () => {
    for (const invalid of [
      { red: '' },
      { red, green: red },
      { blue: red },
      Object.defineProperty({}, 'red', { get: () => red }),
    ]) {
      expect(() => decode(config(), invalid as never)).toThrow(TypeError);
    }
    expect(() =>
      decodeBlueprintArithmeticControlBehavior(undefined, {}, { extra: true } as never),
    ).toThrow(TypeError);
    expect(() =>
      decodeBlueprintArithmeticControlBehavior(undefined, {}, { path: 3 } as never),
    ).toThrow(TypeError);

    const aborted = new AbortController();
    aborted.abort();
    expect(() =>
      decodeBlueprintArithmeticControlBehavior(undefined, {}, { signal: aborted.signal }),
    ).toThrowError(expect.objectContaining({ name: 'AbortError' }));

    let reads = 0;
    const observedSignal = {
      get aborted() {
        reads += 1;
        return reads >= 8;
      },
    } as AbortSignal;
    expect(() =>
      decodeBlueprintArithmeticControlBehavior(
        parseLosslessJson(JSON.stringify({ arithmetic_conditions: config() })),
        {},
        { signal: observedSignal },
      ),
    ).toThrowError(expect.objectContaining({ name: 'AbortError' }));
    expect(reads).toBe(8);

    const { readFile } = await import('node:fs/promises');
    const manifest = JSON.parse(
      await readFile(new URL('../package.json', import.meta.url), 'utf8'),
    ) as {
      exports: Record<string, string>;
    };
    const barrel = await readFile(new URL('./index.ts', import.meta.url), 'utf8');
    expect(Object.values(manifest.exports)).not.toContain('./src/blueprint-import-arithmetic.ts');
    expect(barrel).not.toContain('blueprint-import-arithmetic');
  });
});

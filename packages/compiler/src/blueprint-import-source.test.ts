import {
  constantConfigurationLimits,
  Signal,
  type ConstantConfiguration,
} from '@comblang/factorio';
import { parseLosslessJson } from '@comblang/blueprint/document';
import type { NetworkId } from '@comblang/shared';
import { describe, expect, test } from 'vitest';

import { decodeBlueprintArithmeticControlBehavior } from './blueprint-import-arithmetic.js';
import { decodeBlueprintConstantControlBehavior } from './blueprint-import-constant.js';
import type { ArithmeticProducerConfig } from './ir.js';
import {
  printBlueprintArithmeticExpression,
  printBlueprintConstantExpression,
} from './blueprint-import-source.js';

const red = 'network:source-red' as NetworkId;
const green = 'network:source-green' as NetworkId;
const unused = 'network:source-unused' as NetworkId;

function decodeConstant(source: string): ConstantConfiguration {
  const result = decodeBlueprintConstantControlBehavior(parseLosslessJson(source));
  if (result.state !== 'complete') throw new Error(result.diagnostics[0]?.message);
  return result.configuration;
}

function decodeArithmetic(
  conditions: Record<string, unknown>,
  inputNetworks: { readonly red?: NetworkId; readonly green?: NetworkId } = {},
): ArithmeticProducerConfig {
  const result = decodeBlueprintArithmeticControlBehavior(
    parseLosslessJson(JSON.stringify({ arithmetic_conditions: conditions })),
    inputNetworks,
  );
  if (result.state !== 'complete') throw new Error(result.diagnostics[0]?.message);
  return result.configuration;
}

function bothConstantConditions(operation: string): Record<string, unknown> {
  return {
    first_constant: -2_147_483_648,
    operation,
    second_constant: 2_147_483_647,
    output_signal: { type: 'virtual', name: 'signal-result', quality: 'legendary' },
  };
}

describe('blueprint import source expressions', () => {
  test('prints decoded Constant data literally without changing order, defaults, or -0', () => {
    const configuration = decodeConstant(
      String.raw`{"is_on":false,"sections":{"sections":[{"index":1,"active":false,"group":"group \"quoted\"\\ path\nnext","multiplier":-0,"filters":[{"index":1,"name":"signal-\"A\\path","type":"virtual","quality":"legendary","comparator":"=","count":0},{"index":2,"name":"iron-plate","quality":"normal","comparator":"=","count":-2147483648},{"index":3,"name":"signal-\"A\\path","type":"virtual","quality":"legendary","comparator":"=","count":0}]},{"index":2,"active":true,"multiplier":0.1,"filters":[]}]}}`,
    );

    expect(Object.is(configuration.sections[0]?.multiplier, -0)).toBe(true);
    expect(printBlueprintConstantExpression(configuration)).toBe(
      String.raw`Constant({isOn:false,sections:[{active:false,group:"group \"quoted\"\\ path\nnext",multiplier:-0,filters:[{signal:Signal("virtual","signal-\"A\\path","legendary"),value:0},{signal:Signal("item","iron-plate","normal"),value:-2147483648},{signal:Signal("virtual","signal-\"A\\path","legendary"),value:0}]},{active:true,multiplier:0.1,filters:[]}]})`,
    );
  });

  test('preserves an explicitly empty group and round-trips finite double extremes', () => {
    const configuration = decodeConstant(
      String.raw`{"is_on":true,"sections":{"sections":[{"index":1,"active":true,"group":"","multiplier":5e-324,"filters":[]},{"index":2,"active":true,"multiplier":1.7976931348623157e+308,"filters":[]}]}}`,
    );
    expect(printBlueprintConstantExpression(configuration)).toBe(
      String.raw`Constant({isOn:true,sections:[{active:true,group:"",multiplier:5e-324,filters:[]},{active:true,multiplier:1.7976931348623157e+308,filters:[]}]})`,
    );
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
  ] as const)('prints native operation %s as a literal Arithmetic device', (native, operation) => {
    const configuration = decodeArithmetic(bothConstantConditions(native));
    expect(printBlueprintArithmeticExpression(configuration, [])).toBe(
      `Arithmetic({left:-2147483648,operation:"${operation}",right:2147483647,output:Signal("virtual","signal-result","legendary")})`,
    );
  });

  test('maps explicit single and pair host references to safe ordered identifiers', () => {
    const singles = decodeArithmetic(
      {
        first_signal: { type: 'virtual', name: 'signal-A', quality: 'legendary' },
        first_signal_networks: { red: true, green: false },
        operation: 'XOR',
        second_signal: { type: 'fluid', name: 'water', quality: 'uncommon' },
        second_signal_networks: { red: false, green: true },
        output_signal: { name: 'signal-result' },
      },
      { red, green },
    );
    const malicious = 'network]); throw new Error("not source"); // ' as NetworkId;
    const singleSource = printBlueprintArithmeticExpression(singles, [
      green,
      malicious,
      red,
      unused,
    ]);
    expect(singleSource).toBe(
      'Arithmetic({left:import_network_3[Signal("virtual","signal-A","legendary")],operation:"bit-xor",right:import_network_1[Signal("fluid","water","uncommon")],output:Signal("item","signal-result")})',
    );
    expect(singleSource).not.toContain(malicious);
    expect(singleSource).not.toContain(unused);

    const pair = decodeArithmetic(
      {
        first_signal: { name: 'signal-A' },
        first_signal_networks: { red: true, green: true },
        operation: '+',
        second_constant: 2,
        output_signal: { type: 'virtual', name: 'signal-each' },
      },
      { red, green },
    );
    expect(printBlueprintArithmeticExpression(pair, [green, red])).toBe(
      'Arithmetic({left:pair(import_network_2,import_network_1)[Signal("item","signal-A")],operation:"add",right:2,output:EACH})',
    );

    const repeated: ArithmeticProducerConfig = {
      left: {
        kind: 'signal',
        signal: Signal('virtual', 'signal-A'),
        refKind: 'pair',
        networks: [red, red],
      },
      operation: 'add',
      right: { kind: 'constant', value: 0 },
      output: { kind: 'each' },
    };
    expect(printBlueprintArithmeticExpression(repeated, [red])).toContain(
      'pair(import_network_1,import_network_1)',
    );
  });

  test('rejects malformed references, identifiers, operations, kinds, and constant domains', () => {
    const valid = decodeArithmetic(bothConstantConditions('+'));
    expect(() => printBlueprintArithmeticExpression(valid, [red, red])).toThrow(TypeError);
    expect(() => printBlueprintArithmeticExpression(valid, ['' as NetworkId])).toThrow(TypeError);
    expect(() =>
      printBlueprintArithmeticExpression(valid, [red, 42 as unknown as NetworkId]),
    ).toThrow(TypeError);
    const sparseNetworkOrder = new Array<NetworkId>(2);
    sparseNetworkOrder[1] = red;
    expect(() => printBlueprintArithmeticExpression(valid, sparseNetworkOrder)).toThrow(TypeError);
    expect(() =>
      printBlueprintArithmeticExpression(
        { ...valid, left: { kind: 'constant', value: 2 } as const },
        Array(constantConfigurationLimits.maxNodes + 1).fill(red),
      ),
    ).toThrow(RangeError);

    const missing: ArithmeticProducerConfig = {
      ...valid,
      left: {
        kind: 'signal',
        signal: Signal('virtual', 'signal-A'),
        refKind: 'single',
        network: 'network:missing' as NetworkId,
      },
    };
    expect(() => printBlueprintArithmeticExpression(missing, [red])).toThrow(TypeError);
    expect(() =>
      printBlueprintArithmeticExpression(
        { ...valid, operation: 'eval' as ArithmeticProducerConfig['operation'] },
        [],
      ),
    ).toThrow(TypeError);
    expect(() =>
      printBlueprintArithmeticExpression(
        { ...valid, left: { kind: 'constant', value: 2_147_483_648 } as never },
        [],
      ),
    ).toThrow(TypeError);
    expect(() =>
      printBlueprintArithmeticExpression(
        { ...valid, right: { kind: 'constant', value: Number.NaN } as never },
        [],
      ),
    ).toThrow(TypeError);
    expect(() =>
      printBlueprintArithmeticExpression(
        {
          ...valid,
          left: {
            kind: 'signal',
            signal: Signal('virtual', 'signal-each'),
            refKind: 'single',
            network: red,
          } as never,
        },
        [red],
      ),
    ).toThrow(TypeError);
    expect(() =>
      printBlueprintArithmeticExpression(
        {
          ...valid,
          left: {
            kind: 'each',
            refKind: 'pair',
            networks: [red],
          } as never,
        },
        [red],
      ),
    ).toThrow(TypeError);
    expect(() =>
      printBlueprintArithmeticExpression({ ...valid, left: { kind: 'unknown' } as never }, []),
    ).toThrow(TypeError);
    expect(() =>
      printBlueprintArithmeticExpression({ ...valid, output: { kind: 'unknown' } as never }, []),
    ).toThrow(TypeError);
    expect(() =>
      printBlueprintConstantExpression({
        isOn: true,
        sections: [{ active: true, multiplier: Number.POSITIVE_INFINITY, filters: [] }],
      }),
    ).toThrow();
  });

  test('counts final UTF-8 source bytes and rejects unsafe Constant input size before canonicalization', () => {
    const base: ArithmeticProducerConfig = {
      left: { kind: 'constant', value: 0 },
      operation: 'add',
      right: { kind: 'constant', value: 0 },
      output: { kind: 'signal', signal: Signal('virtual', 'x') },
    };
    const baseBytes = new TextEncoder().encode(
      printBlueprintArithmeticExpression(base, []),
    ).byteLength;
    const fixedBytes = baseBytes - 3; // One ASCII name character and its JSON quotes.
    const nameBytes = constantConfigurationLimits.maxBytes - fixedBytes - 2;
    const name =
      nameBytes % 2 === 0 ? 'é'.repeat(nameBytes / 2) : `x${'é'.repeat((nameBytes - 1) / 2)}`;
    const exact = {
      ...base,
      output: { kind: 'signal', signal: Signal('virtual', name) } as const,
    };
    const source = printBlueprintArithmeticExpression(exact, []);
    expect(new TextEncoder().encode(source).byteLength).toBe(constantConfigurationLimits.maxBytes);
    expect(() =>
      printBlueprintArithmeticExpression(
        { ...exact, output: { kind: 'signal', signal: Signal('virtual', `${name}x`) } },
        [],
      ),
    ).toThrow(RangeError);

    expect(() =>
      printBlueprintConstantExpression({
        isOn: true,
        sections: [
          {
            active: true,
            multiplier: 1,
            filters: [
              {
                signal: Signal('virtual', 'x'.repeat(constantConfigurationLimits.maxBytes + 1)),
                value: 0,
              },
            ],
          },
        ],
      }),
    ).toThrow(RangeError);
  });

  test('publishes only the dedicated printer subpath, not a compiler barrel export', async () => {
    const { readFile } = await import('node:fs/promises');
    const manifest = JSON.parse(
      await readFile(new URL('../package.json', import.meta.url), 'utf8'),
    ) as { exports: Record<string, string> };
    const barrel = await readFile(new URL('./index.ts', import.meta.url), 'utf8');
    expect(manifest.exports['./blueprint-import-source']).toBe('./src/blueprint-import-source.ts');
    expect(barrel).not.toContain('blueprint-import-source');
    expect(Object.values(manifest.exports)).not.toContain('./src/blueprint-import-constant.ts');
    expect(Object.values(manifest.exports)).not.toContain('./src/blueprint-import-arithmetic.ts');
  });
});

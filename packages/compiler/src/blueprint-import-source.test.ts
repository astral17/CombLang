import {
  constantConfigurationLimits,
  Signal,
  type ConstantConfiguration,
} from '@comblang/factorio';
import { DEFAULT_BLUEPRINT_CODEC_LIMITS } from '@comblang/blueprint';
import { parseLosslessJson } from '@comblang/blueprint/document';
import type { NetworkId } from '@comblang/shared';
import { describe, expect, test } from 'vitest';

import { decodeBlueprintArithmeticControlBehavior } from './blueprint-import-arithmetic.js';
import { decodeBlueprintConstantControlBehavior } from './blueprint-import-constant.js';
import type {
  ArithmeticProducerConfig,
  DeciderProducerConfig,
  SelectorProducerConfig,
} from './ir.js';
import {
  createBlueprintArithmeticExpressionPrinter,
  createBlueprintDeciderExpressionPrinter,
  createBlueprintSelectorExpressionPrinter,
  printBlueprintArithmeticExpression,
  printBlueprintConstantExpression,
  printBlueprintDeciderExpression,
  printBlueprintSelectorExpression,
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

function deciderConfiguration(): DeciderProducerConfig {
  return {
    condition: {
      kind: 'compare',
      left: {
        kind: 'signal',
        signal: Signal('virtual', 'signal-A'),
        refKind: 'single',
        network: red,
      },
      comparator: '>=',
      right: { kind: 'constant', value: 1 },
    },
    outputs: [
      {
        mode: 'copy',
        signal: { kind: 'signal', signal: Signal('virtual', 'signal-output') },
        input: { refKind: 'single', network: red },
      },
    ],
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

  test('prepares an independent positional map once and snapshots the caller network order', () => {
    const single = decodeArithmetic(
      {
        first_signal: { name: 'signal-A' },
        first_signal_networks: { red: true, green: false },
        operation: '+',
        second_constant: 2,
        output_signal: { name: 'signal-result' },
      },
      { red, green },
    );
    const pair = decodeArithmetic(
      {
        first_signal: { name: 'signal-A' },
        first_signal_networks: { red: true, green: true },
        operation: '*',
        second_constant: 3,
        output_signal: { name: 'signal-result' },
      },
      { red, green },
    );
    const mutableOrder: NetworkId[] = [green, red];
    const prepared = createBlueprintArithmeticExpressionPrinter(mutableOrder);
    const expectedSingle = printBlueprintArithmeticExpression(single, [green, red]);

    expect(prepared(single)).toBe(expectedSingle);
    expect(prepared(pair)).toBe(printBlueprintArithmeticExpression(pair, [green, red]));
    mutableOrder[0] = red;
    mutableOrder[1] = red;
    expect(prepared(single)).toBe(expectedSingle);
    expect(() => printBlueprintArithmeticExpression(single, mutableOrder)).toThrow(TypeError);

    const independent = createBlueprintArithmeticExpressionPrinter([red, green]);
    expect(independent(single)).toBe(printBlueprintArithmeticExpression(single, [red, green]));
    expect(independent(single)).not.toBe(prepared(single));
    expect(() => createBlueprintArithmeticExpressionPrinter([])(single)).toThrow(
      /missing from networkOrder/,
    );
    expect(() => createBlueprintArithmeticExpressionPrinter([red, red])).toThrow(TypeError);
    expect(() => createBlueprintArithmeticExpressionPrinter(['' as NetworkId])).toThrow(TypeError);
    expect(() => createBlueprintArithmeticExpressionPrinter([42 as unknown as NetworkId])).toThrow(
      TypeError,
    );
  });

  test('prints a prepared Decider against its positional map snapshot', () => {
    const configuration = deciderConfiguration();
    const mutableOrder: NetworkId[] = [green, red];
    const prepared = createBlueprintDeciderExpressionPrinter(mutableOrder);
    const expected = printBlueprintDeciderExpression(configuration, [green, red]);
    expect(prepared(configuration)).toBe(expected);
    expect(expected).toBe(
      'Decider({condition:(import_network_2[Signal("virtual","signal-A")] >= 1),outputs:[import_network_2[Signal("virtual","signal-output")]]})',
    );
    mutableOrder[0] = red;
    mutableOrder[1] = red;
    expect(prepared(configuration)).toBe(expected);
    expect(() => printBlueprintDeciderExpression(configuration, mutableOrder)).toThrow(TypeError);
    expect(() => printBlueprintDeciderExpression(configuration, [green])).toThrow(
      /missing from networkOrder/,
    );
    expect(() => createBlueprintDeciderExpressionPrinter([red, red])).toThrow(TypeError);
    expect(() => createBlueprintDeciderExpressionPrinter(['' as NetworkId])).toThrow(TypeError);
    expect(() => createBlueprintDeciderExpressionPrinter([42 as unknown as NetworkId])).toThrow(
      TypeError,
    );
    const sparseNetworkOrder = new Array<NetworkId>(1);
    expect(() => createBlueprintDeciderExpressionPrinter(sparseNetworkOrder)).toThrow(TypeError);
    const malicious = 'network]); throw new Error("injected"); //' as NetworkId;
    const hostile = {
      ...configuration,
      condition: {
        ...configuration.condition,
        left: {
          kind: 'signal' as const,
          signal: Signal('virtual', 'quoted "name"\\\n🚀', 'rare "quality"\\\n'),
          refKind: 'single' as const,
          network: malicious,
        },
      },
    };
    const source = printBlueprintDeciderExpression(hostile, [malicious, red]);
    expect(source).toContain('import_network_1');
    expect(source).not.toContain(malicious);
    expect(source).toContain(JSON.stringify('quoted "name"\\\n🚀'));
    expect(source).toContain(JSON.stringify('rare "quality"\\\n'));
  });

  test.each([
    ['>', '>'],
    ['<', '<'],
    ['=', '=='],
    ['>=', '>='],
    ['<=', '<='],
    ['!=', '!='],
  ] as const)('prints Decider comparator %s as source %s', (comparator, sourceComparator) => {
    const configuration = deciderConfiguration();
    const condition = {
      ...configuration.condition,
      comparator,
    };
    expect(printBlueprintDeciderExpression({ ...configuration, condition }, [red])).toBe(
      `Decider({condition:(import_network_1[Signal("virtual","signal-A")] ${sourceComparator} 1),outputs:[import_network_1[Signal("virtual","signal-output")]]})`,
    );
  });

  test('parenthesizes ordered Decider logical groups and preserves concrete, wildcard, and pair operands', () => {
    const configuration: DeciderProducerConfig = {
      condition: {
        kind: 'or',
        conditions: [
          {
            kind: 'and',
            conditions: [
              {
                kind: 'compare',
                left: {
                  kind: 'wildcard',
                  value: 'each',
                  refKind: 'pair',
                  networks: [red, green],
                },
                comparator: '>',
                right: {
                  kind: 'signal',
                  signal: Signal('fluid', 'wa"ter\\line\n🚀', 'legendary'),
                  refKind: 'single',
                  network: green,
                },
              },
              {
                kind: 'compare',
                left: {
                  kind: 'signal',
                  signal: Signal('virtual', 'signal-B', 'uncommon'),
                  refKind: 'single',
                  network: red,
                },
                comparator: '=',
                right: { kind: 'constant', value: -2 },
              },
            ],
          },
          {
            kind: 'compare',
            left: {
              kind: 'wildcard',
              value: 'anything',
              refKind: 'single',
              network: green,
            },
            comparator: '!=',
            right: { kind: 'constant', value: 0 },
          },
        ],
      },
      outputs: [
        {
          mode: 'copy',
          signal: { kind: 'signal', signal: Signal('virtual', 'signal-out', 'rare') },
          input: { refKind: 'pair', networks: [green, red] },
        },
      ],
    };
    expect(printBlueprintDeciderExpression(configuration, [red, green])).toBe(
      'Decider({condition:(((Each(pair(import_network_1,import_network_2)) > import_network_2[Signal("fluid","wa\\"ter\\\\line\\n🚀","legendary")]) && (import_network_1[Signal("virtual","signal-B","uncommon")] == -2)) || (Anything(import_network_2) != 0)),outputs:[pair(import_network_2,import_network_1)[Signal("virtual","signal-out","rare")]]})',
    );
  });

  test('preserves ordered Decider branches and refuses source-losing output shapes', () => {
    const configuration: DeciderProducerConfig = {
      condition: deciderConfiguration().condition,
      outputs: [
        {
          mode: 'copy',
          signal: { kind: 'signal', signal: Signal('fluid', 'water', 'rare') },
          input: { refKind: 'pair', networks: [red, green] },
        },
        {
          mode: 'copy',
          signal: { kind: 'wildcard', value: 'everything' },
          input: { refKind: 'single', network: green },
        },
        {
          mode: 'constant',
          signal: { kind: 'signal', signal: Signal('item', 'iron-plate') },
          value: -4,
        },
        { mode: 'constant', signal: { kind: 'wildcard', value: 'each' }, value: 2 },
      ],
      elseOutputs: [
        {
          mode: 'copy',
          signal: { kind: 'signal', signal: Signal('virtual', 'signal-out', 'legendary') },
          input: { refKind: 'single', network: red },
        },
      ],
    };
    const condition = configuration.condition;
    if (condition.kind !== 'compare') throw new Error('Expected a comparison condition.');
    expect(printBlueprintDeciderExpression(configuration, [red, green])).toBe(
      'Decider({condition:(import_network_1[Signal("virtual","signal-A")] >= 1),outputs:[pair(import_network_1,import_network_2)[Signal("fluid","water","rare")],Everything(import_network_2),(-4 * Signal("item","iron-plate")),(2 * EACH)],elseOutputs:[import_network_1[Signal("virtual","signal-out","legendary")]]})',
    );
    expect(
      printBlueprintDeciderExpression(
        { ...configuration, outputs: [], elseOutputs: configuration.elseOutputs! },
        [red, green],
      ),
    ).toContain('outputs:[],elseOutputs:');
    expect(() =>
      printBlueprintDeciderExpression({ ...configuration, elseOutputs: [] }, [red, green]),
    ).toThrow(TypeError);
    expect(() =>
      printBlueprintDeciderExpression(
        {
          ...configuration,
          outputs: [],
          elseOutputs: undefined,
        } as unknown as DeciderProducerConfig,
        [red],
      ),
    ).toThrow(TypeError);

    const refused: readonly DeciderProducerConfig['outputs'][number][] = [
      { mode: 'copy', signal: { kind: 'signal', signal: Signal('virtual', 'signal-A') } },
      {
        mode: 'constant',
        signal: { kind: 'signal', signal: Signal('virtual', 'signal-A') },
        value: 1,
        input: { refKind: 'single', network: red },
      },
      { mode: 'constant', signal: { kind: 'wildcard', value: 'anything' }, value: 1 },
      { mode: 'constant', signal: { kind: 'wildcard', value: 'everything' }, value: 1 },
      {
        mode: 'constant',
        signal: { kind: 'signal', signal: Signal('item', 'iron-plate') },
        value: -0,
      },
    ];
    for (const output of refused) {
      expect(() =>
        printBlueprintDeciderExpression({ ...configuration, outputs: [output] }, [red, green]),
      ).toThrow(TypeError);
    }
    const int32Bounds = printBlueprintDeciderExpression(
      {
        ...configuration,
        condition: {
          ...condition,
          right: { kind: 'constant', value: 2_147_483_647 },
        },
        outputs: [
          {
            mode: 'constant',
            signal: { kind: 'signal', signal: Signal('item', 'iron-plate') },
            value: -2_147_483_648,
          },
          {
            mode: 'constant',
            signal: { kind: 'signal', signal: Signal('item', 'copper-plate') },
            value: 2_147_483_647,
          },
        ],
      },
      [red],
    );
    expect(int32Bounds).toContain('>= 2147483647');
    expect(int32Bounds).toContain('(-2147483648 * Signal');
    expect(int32Bounds).toContain('(2147483647 * Signal');
    for (const value of [
      -2_147_483_649,
      2_147_483_648,
      1.5,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      -0,
    ]) {
      expect(() =>
        printBlueprintDeciderExpression(
          {
            ...configuration,
            outputs: [
              {
                mode: 'constant',
                signal: { kind: 'signal', signal: Signal('item', 'iron-plate') },
                value,
              },
            ],
          },
          [red],
        ),
      ).toThrow(TypeError);
      expect(() =>
        printBlueprintDeciderExpression(
          {
            ...configuration,
            condition: {
              ...condition,
              right: { kind: 'constant', value },
            },
          },
          [red],
        ),
      ).toThrow(TypeError);
    }
    expect(() =>
      printBlueprintDeciderExpression(
        {
          ...configuration,
          condition: {
            ...condition,
            kind: 'compare',
            right: { kind: 'constant', value: -0 },
          } as never,
        },
        [red, green],
      ),
    ).toThrow(TypeError);
  });

  test('bounds Decider condition traversal and combined ordered outputs', () => {
    const configuration = deciderConfiguration();
    const repeated = configuration.condition;
    expect(
      printBlueprintDeciderExpression(
        {
          ...configuration,
          condition: { kind: 'and', conditions: [repeated, repeated] },
        },
        [red],
      ).match(/signal-A/g),
    ).toHaveLength(2);

    const cyclic: { kind: 'and'; conditions: unknown[] } = { kind: 'and', conditions: [] };
    cyclic.conditions.push(cyclic);
    expect(() =>
      printBlueprintDeciderExpression({ ...configuration, condition: cyclic as never }, [red]),
    ).toThrow(TypeError);
    let deep: unknown = repeated;
    for (let depth = 1; depth < constantConfigurationLimits.maxDepth + 1; depth += 1) {
      deep = { kind: 'and', conditions: [deep] };
    }
    expect(() =>
      printBlueprintDeciderExpression({ ...configuration, condition: deep as never }, [red]),
    ).toThrow(RangeError);
    expect(() =>
      printBlueprintDeciderExpression(
        {
          ...configuration,
          condition: {
            kind: 'and',
            conditions: Array.from(
              { length: constantConfigurationLimits.maxNodes },
              () => repeated,
            ),
          },
        },
        [red],
      ),
    ).toThrow(RangeError);

    const maxRows = {
      ...configuration,
      condition: {
        kind: 'compare' as const,
        left: {
          kind: 'wildcard' as const,
          value: 'each' as const,
          refKind: 'single' as const,
          network: red,
        },
        comparator: '>' as const,
        right: { kind: 'constant' as const, value: 0 },
      },
      outputs: Array.from({ length: 1024 }, () => ({
        mode: 'constant' as const,
        signal: { kind: 'wildcard' as const, value: 'each' as const },
        value: 1,
      })),
    };
    expect(printBlueprintDeciderExpression(maxRows, [red]).match(/\(1 \* EACH\)/g)).toHaveLength(
      1024,
    );
    expect(() =>
      printBlueprintDeciderExpression(
        { ...maxRows, outputs: [...maxRows.outputs, maxRows.outputs[0]!] },
        [red],
      ),
    ).toThrow(RangeError);
    expect(() =>
      printBlueprintDeciderExpression(
        {
          ...configuration,
          outputs: maxRows.outputs,
          elseOutputs: [maxRows.outputs[0]!],
        },
        [red],
      ),
    ).toThrow(RangeError);
  });

  test('enforces the UTF-8 Decider source budget per prepared call without stale state', () => {
    const configuration = deciderConfiguration();
    const ordinary = printBlueprintDeciderExpression(configuration, [red]);
    const shortConfiguration = {
      ...configuration,
      outputs: [
        {
          mode: 'constant' as const,
          signal: { kind: 'signal' as const, signal: Signal('virtual', 'x') },
          value: 1,
        },
      ],
    };
    const base = printBlueprintDeciderExpression(shortConfiguration, [red]);
    const baseBytes = new TextEncoder().encode(base).byteLength;
    const nameByteLength = constantConfigurationLimits.maxBytes - (baseBytes - 3) - 2;
    const exactName =
      nameByteLength % 2 === 0
        ? 'é'.repeat(nameByteLength / 2)
        : `x${'é'.repeat((nameByteLength - 1) / 2)}`;
    const exact = {
      ...configuration,
      outputs: [
        {
          mode: 'constant' as const,
          signal: { kind: 'signal' as const, signal: Signal('virtual', exactName) },
          value: 1,
        },
      ],
    };
    const prepared = createBlueprintDeciderExpressionPrinter([red]);
    const source = prepared(exact);
    expect(new TextEncoder().encode(source).byteLength).toBe(constantConfigurationLimits.maxBytes);
    const tooLarge = {
      ...exact,
      outputs: [
        {
          ...exact.outputs[0]!,
          signal: { kind: 'signal' as const, signal: Signal('virtual', `${exactName}x`) },
        },
      ],
    };
    expect(() => prepared(tooLarge)).toThrow(RangeError);
    expect(prepared(configuration)).toBe(ordinary);
    expect(prepared(exact)).toBe(source);
  });

  test('rejects malformed Decider condition and output records', () => {
    const configuration = deciderConfiguration();
    const invalid = [
      { ...configuration, condition: { kind: 'unknown' } },
      { ...configuration, condition: { kind: 'and', conditions: [] } },
      {
        ...configuration,
        condition: {
          kind: 'compare',
          left: { kind: 'signal' },
          comparator: '===',
          right: { kind: 'constant', value: 0 },
        },
      },
      {
        ...configuration,
        condition: {
          kind: 'compare',
          left: {
            kind: 'signal',
            signal: Signal('virtual', 'signal-A'),
            refKind: 'pair',
            networks: [red],
          },
          comparator: '>',
          right: { kind: 'constant', value: 0 },
        },
      },
      {
        ...configuration,
        outputs: [
          { mode: 'unknown', signal: { kind: 'signal', signal: Signal('virtual', 'signal-A') } },
        ],
      },
      { ...configuration, outputs: [null] },
      { ...configuration, outputs: new Array(1) },
    ];
    for (const candidate of invalid) {
      expect(() => printBlueprintDeciderExpression(candidate as never, [red, green])).toThrow(
        TypeError,
      );
    }
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

  test('keeps expression limits for other families and gives Constant the document byte budget', () => {
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
    const preparedPrinter = createBlueprintArithmeticExpressionPrinter([]);
    expect(preparedPrinter(exact)).toBe(source);
    expect(preparedPrinter(exact)).toBe(source);
    expect(() =>
      printBlueprintArithmeticExpression(
        { ...exact, output: { kind: 'signal', signal: Signal('virtual', `${name}x`) } },
        [],
      ),
    ).toThrow(RangeError);
    expect(() =>
      preparedPrinter({
        ...exact,
        output: { kind: 'signal', signal: Signal('virtual', `${name}x`) },
      }),
    ).toThrow(RangeError);

    const largeConstant: ConstantConfiguration = {
      isOn: true,
      sections: Array.from({ length: 3 }, (_, sectionIndex) => ({
        active: sectionIndex !== 1,
        group: `group-${sectionIndex}`,
        multiplier: 1,
        filters: Array.from({ length: 700 }, (_, filterIndex) => ({
          signal: Signal(
            'virtual',
            `section-${sectionIndex}-row-${filterIndex}-${'x'.repeat(130)}`,
            filterIndex % 2 === 0 ? 'normal' : 'rare',
          ),
          value: filterIndex % 3 === 0 ? 0 : filterIndex % 2 === 0 ? filterIndex : -filterIndex,
        })),
      })),
    };
    const constantSource = printBlueprintConstantExpression(largeConstant);
    const constantSourceBytes = new TextEncoder().encode(constantSource).byteLength;
    expect(constantSourceBytes).toBeGreaterThan(constantConfigurationLimits.maxBytes);
    expect(constantSourceBytes).toBeLessThanOrEqual(DEFAULT_BLUEPRINT_CODEC_LIMITS.maxEmittedBytes);

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
    ).toThrowError(
      expect.objectContaining({
        code: 'FC1002',
        path: '$.sections[0].filters[0].signal.name',
      }),
    );
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

  test('prints bounded Selector Select and Count literals with positional Network references', () => {
    const numericCases = [
      [0, false],
      [-1, true],
      [-2_147_483_648, false],
      [2_147_483_647, true],
    ] as const;
    for (const [index, selectMax] of numericCases) {
      const configuration: SelectorProducerConfig = {
        operation: 'select',
        input: { refKind: 'single', network: red },
        selectMax,
        index,
      };
      expect(printBlueprintSelectorExpression(configuration, [green, red])).toBe(
        `Selector({input:import_network_2,operation:"select",selectMax:${selectMax},index:${index}})`,
      );
    }

    const hostileNetwork = 'network]); throw new Error("not source"); //' as NetworkId;
    const signalSelect: SelectorProducerConfig = {
      operation: 'select',
      input: { refKind: 'pair', networks: [hostileNetwork, red] },
      selectMax: true,
      index: Signal('virtual', 'index "quoted"\\line\n🚀', 'normal'),
    };
    const signalSource = printBlueprintSelectorExpression(signalSelect, [
      green,
      hostileNetwork,
      red,
    ]);
    expect(signalSource).toBe(
      'Selector({input:pair(import_network_2,import_network_3),operation:"select",selectMax:true,index:Signal("virtual","index \\\"quoted\\\"\\\\line\\n🚀","normal")})',
    );
    expect(signalSource).not.toContain(hostileNetwork);

    const count: SelectorProducerConfig = {
      operation: 'count',
      input: { refKind: 'single', network: green },
      output: Signal('item', 'iron-plate', 'uncommon'),
    };
    expect(printBlueprintSelectorExpression(count, [green, red])).toBe(
      'Selector({input:import_network_1,operation:"count",output:Signal("item","iron-plate","uncommon")})',
    );

    const reversedPair: SelectorProducerConfig = {
      operation: 'count',
      input: { refKind: 'pair', networks: [green, red] },
      output: Signal('virtual', 'signal-output'),
    };
    expect(printBlueprintSelectorExpression(reversedPair, [red, green])).toBe(
      'Selector({input:pair(import_network_2,import_network_1),operation:"count",output:Signal("virtual","signal-output")})',
    );
  });

  test('snapshots prepared Selector network order and creates a fresh budget for each call', () => {
    const configuration: SelectorProducerConfig = {
      operation: 'count',
      input: { refKind: 'pair', networks: [green, red] },
      output: Signal('virtual', 'café 🚀 "quoted"\\line\n'),
    };
    const mutableOrder: NetworkId[] = [red, green];
    const prepared = createBlueprintSelectorExpressionPrinter(mutableOrder);
    const expected = printBlueprintSelectorExpression(configuration, [red, green]);
    expect(prepared(configuration)).toBe(expected);
    expect(new TextEncoder().encode(expected).byteLength).toBeGreaterThan(expected.length);
    mutableOrder[0] = green;
    mutableOrder[1] = green;
    expect(prepared(configuration)).toBe(expected);

    const escapedUnicodeName = 'é "quoted"\\line\n🚀';
    const boundedBase: SelectorProducerConfig = {
      operation: 'count',
      input: { refKind: 'single', network: red },
      output: Signal('virtual', escapedUnicodeName),
    };
    const baseBytes = new TextEncoder().encode(
      printBlueprintSelectorExpression(boundedBase, [red]),
    ).byteLength;
    const remaining = constantConfigurationLimits.maxBytes - baseBytes;
    const exactName =
      escapedUnicodeName + 'é'.repeat(Math.floor(remaining / 2)) + 'x'.repeat(remaining % 2);
    const exactLimit: SelectorProducerConfig = {
      ...boundedBase,
      output: Signal('virtual', exactName),
    };
    const exactSource = prepared(exactLimit);
    expect(new TextEncoder().encode(exactSource).byteLength).toBe(
      constantConfigurationLimits.maxBytes,
    );
    expect(() => prepared({ ...exactLimit, output: Signal('virtual', `${exactName}x`) })).toThrow(
      RangeError,
    );
    expect(prepared(configuration)).toBe(expected);
    expect(prepared(configuration)).toBe(expected);
  });

  test('rejects non-literal Selector shapes, unsafe indices, and unknown or accessor fields', () => {
    const validSelect: SelectorProducerConfig = {
      operation: 'select',
      input: { refKind: 'single', network: red },
      selectMax: false,
      index: 0,
    };
    const invalidConfigurations: unknown[] = [
      { ...validSelect, index: -0 },
      { ...validSelect, index: 1.5 },
      { ...validSelect, index: 2_147_483_648 },
      { ...validSelect, index: -2_147_483_649 },
      { ...validSelect, index: Number.NaN },
      { ...validSelect, index: Number.POSITIVE_INFINITY },
      { ...validSelect, selectMax: undefined },
      { ...validSelect, operation: 'quality-select' },
      { ...validSelect, output: Signal('item', 'iron-plate') },
      { ...validSelect, future: true },
      {
        operation: 'count',
        input: { refKind: 'single', network: red },
        selectMax: false,
        output: Signal('item', 'iron-plate'),
      },
      {
        operation: 'count',
        input: { refKind: 'single', network: red },
        output: Signal('item', 'iron-plate'),
        future: true,
      },
      {
        operation: 'count',
        input: { refKind: 'single', network: red },
        output: { type: 'virtual', name: 'signal-anything' },
      },
      { ...validSelect, index: { type: 'virtual', name: 'signal-each' } },
      { ...validSelect, index: { type: 'virtual', name: 'signal-index', future: true } },
    ];
    for (const configuration of invalidConfigurations) {
      expect(() => printBlueprintSelectorExpression(configuration as never, [red])).toThrow(
        TypeError,
      );
    }

    let reads = 0;
    const accessor = Object.defineProperty({ ...validSelect }, 'selectMax', {
      get() {
        reads += 1;
        return false;
      },
    });
    expect(() => printBlueprintSelectorExpression(accessor, [red])).toThrow(TypeError);
    expect(reads).toBe(0);

    const symbolConfig = { ...validSelect, [Symbol('extra')]: true };
    expect(() => printBlueprintSelectorExpression(symbolConfig, [red])).toThrow(TypeError);
  });

  test('requires exact Selector input records and dense distinct Network pairs', () => {
    const base = {
      operation: 'count',
      output: Signal('item', 'iron-plate'),
    } as const;
    const accessorInput = Object.defineProperty({ refKind: 'single' }, 'network', {
      get() {
        throw new Error('must not execute');
      },
    });
    const tupleAccessor = [red, green];
    Object.defineProperty(tupleAccessor, '1', {
      get() {
        throw new Error('must not execute');
      },
    });
    const invalidInputs: unknown[] = [
      null,
      [],
      { refKind: 'single', network: red, networks: [red, green] },
      { refKind: 'single', network: red, extra: true },
      { refKind: 'pair', networks: [red, red] },
      { refKind: 'pair', networks: [red] },
      { refKind: 'pair', networks: [red, , green] },
      { refKind: 'pair', networks: Object.assign([red, green], { extra: true }) },
      { refKind: 'pair', networks: Object.assign([red, green], { [Symbol('extra')]: true }) },
      { refKind: 'pair', networks: tupleAccessor },
      accessorInput,
      { refKind: 'pair', networks: [red, green], [Symbol('extra')]: true },
    ];
    for (const input of invalidInputs) {
      expect(() =>
        printBlueprintSelectorExpression({ ...base, input } as never, [red, green]),
      ).toThrow(TypeError);
    }
  });
});

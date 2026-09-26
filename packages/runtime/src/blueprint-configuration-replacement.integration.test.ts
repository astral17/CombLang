import { canonicalizeConstantConfiguration, signal } from '@comblang/factorio';
import type { NetworkId, ProducerId } from '@comblang/shared';
import { describe, expect, test } from 'vitest';

import { generateBlueprintJson } from '@comblang/compiler/blueprint-json';
import type {
  ArithmeticProducerConfig,
  CircuitProducerNode,
  NativeCircuitIr,
  SelectorProducerConfig,
} from '@comblang/compiler/ir';
import { createBlueprintConfigurationSet } from '../../compiler/src/blueprint-configuration-set.js';
import { replaceBlueprintConfigurationSetInNativeCircuitIr } from '../../compiler/src/blueprint-configuration-binding.js';
import { createBlueprintParameterSession } from '../../compiler/src/blueprint-parameters.js';
import { createArithmeticConfigurationTemplate } from '../../compiler/src/arithmetic-configuration-template.js';
import { createConstantConfigurationTemplate } from '../../compiler/src/constant-configuration-template.js';
import { createSelectorConfigurationTemplate } from '../../compiler/src/selector-configuration-template.js';
import { createSimulationFromNativeCircuitIr } from './elaboration.js';

const A = signal('virtual', 'signal-A');
const B = signal('virtual', 'signal-B');
const provenance = { instancePath: [], expansionStack: [] } as const;

function ticks(ir: NativeCircuitIr, network: NetworkId, outputSignal: typeof A): readonly number[] {
  const simulation = createSimulationFromNativeCircuitIr(ir);
  return Array.from({ length: 4 }, () => simulation.step().read(network).get(outputSignal));
}

describe('configuration-set replacement concrete consumers', () => {
  test('matches Constant+Arithmetic Blueprint JSON and multiple simulator ticks', () => {
    const input = 'network:replacement-input' as NetworkId;
    const output = 'network:replacement-output' as NetworkId;
    const constantId = 'producer:replacement-constant' as ProducerId;
    const arithmeticId = 'producer:replacement-arithmetic' as ProducerId;
    const session = createBlueprintParameterSession();
    const amount = session.number('amount', { defaultValue: 7 });
    const offset = session.number('offset', { defaultValue: 5 });
    const constantTemplate = createConstantConfigurationTemplate(session, {
      sections: [{ filters: [{ signal: A, value: amount }] }],
    });
    const arithmeticTemplate = createArithmeticConfigurationTemplate(session, {
      left: { kind: 'signal', signal: A, refKind: 'single', network: input },
      operation: 'add',
      right: { kind: 'constant', value: offset },
      output: { kind: 'signal', signal: B },
    });
    const set = createBlueprintConfigurationSet(session, [
      { key: 'source', kind: 'constant', template: constantTemplate },
      { key: 'sum', kind: 'arithmetic', template: arithmeticTemplate },
    ]);
    const constant = canonicalizeConstantConfiguration({
      sections: [{ filters: [{ signal: A, value: 1 }] }],
    });
    const arithmetic: ArithmeticProducerConfig = {
      left: { kind: 'signal', signal: A, refKind: 'single', network: input },
      operation: 'add',
      right: { kind: 'constant', value: 1 },
      output: { kind: 'signal', signal: B },
    };
    const constantProducer = {
      id: constantId,
      kind: 'constant',
      config: { configuration: constant },
      destinations: [input],
      provenance,
    } satisfies CircuitProducerNode;
    const arithmeticProducer = {
      id: arithmeticId,
      kind: 'arithmetic',
      config: arithmetic,
      destinations: [output],
      provenance,
    } satisfies CircuitProducerNode;
    const circuit: NativeCircuitIr = {
      format: 'comblang-ncir',
      networks: [
        { id: input, color: 'red', provenance },
        { id: output, color: 'green', provenance },
      ],
      entities: [],
      producers: [constantProducer, arithmeticProducer],
    };
    const replaced = replaceBlueprintConfigurationSetInNativeCircuitIr(
      set,
      circuit,
      [
        { key: 'source', producerId: constantId },
        { key: 'sum', producerId: arithmeticId },
      ],
      [
        { parameter: amount, value: 7 },
        { parameter: offset, value: 5 },
      ],
    );
    const manual: NativeCircuitIr = {
      ...circuit,
      producers: [
        {
          ...constantProducer,
          config: {
            configuration: canonicalizeConstantConfiguration({
              sections: [{ filters: [{ signal: A, value: 7 }] }],
            }),
          },
        },
        {
          ...arithmeticProducer,
          config: { ...arithmetic, right: { kind: 'constant', value: 5 } },
        },
      ],
    };

    expect(generateBlueprintJson(replaced)).toEqual(generateBlueprintJson(manual));
    expect(JSON.stringify(replaced)).not.toContain('amount');
    expect(JSON.stringify(replaced)).not.toContain('offset');
    const replacedTicks = ticks(replaced, output, B);
    const manualTicks = ticks(manual, output, B);
    expect(replacedTicks).toEqual(manualTicks);
    expect(replacedTicks).toContain(12);

    const originalBeforeFailure = JSON.stringify(circuit);
    const beforeFailure = JSON.stringify(replaced);
    expect(() =>
      replaceBlueprintConfigurationSetInNativeCircuitIr(
        set,
        circuit,
        [
          { key: 'source', producerId: constantId },
          { key: 'sum', producerId: arithmeticId },
        ],
        [{ parameter: amount, value: Number.NaN }],
      ),
    ).toThrow();
    expect(JSON.stringify(circuit)).toBe(originalBeforeFailure);
    expect(JSON.stringify(replaced)).toBe(beforeFailure);

    const nextResult = replaceBlueprintConfigurationSetInNativeCircuitIr(
      set,
      circuit,
      [
        { key: 'source', producerId: constantId },
        { key: 'sum', producerId: arithmeticId },
      ],
      [
        { parameter: amount, value: 10 },
        { parameter: offset, value: 1 },
      ],
    );
    expect(replacedTicks).toEqual(ticks(replaced, output, B));
    expect(nextResult.producers[0]).not.toBe(replaced.producers[0]);
    expect(JSON.stringify(replaced)).toBe(beforeFailure);
  });

  test('matches Selector Blueprint JSON and repeated simulator ticks', () => {
    const red = 'network:replacement-red' as NetworkId;
    const green = 'network:replacement-green' as NetworkId;
    const output = 'network:replacement-selector-output' as NetworkId;
    const redSourceId = 'producer:replacement-red-source' as ProducerId;
    const greenSourceId = 'producer:replacement-green-source' as ProducerId;
    const selectorId = 'producer:replacement-selector' as ProducerId;
    const session = createBlueprintParameterSession();
    const index = session.number('selector index', { defaultValue: 1 });
    const input = { refKind: 'pair', networks: [green, red] } as const;
    const template = createSelectorConfigurationTemplate(session, {
      operation: 'select',
      input,
      selectMax: true,
      index,
    });
    const set = createBlueprintConfigurationSet(session, [
      { key: 'selector', kind: 'selector', template },
    ]);
    const selector: SelectorProducerConfig = {
      operation: 'select',
      input,
      selectMax: true,
      index: 0,
    };
    const redProducer = {
      id: redSourceId,
      kind: 'constant',
      config: {
        configuration: canonicalizeConstantConfiguration({
          sections: [{ filters: [{ signal: A, value: 2 }] }],
        }),
      },
      destinations: [red],
      provenance,
    } satisfies CircuitProducerNode;
    const greenProducer = {
      id: greenSourceId,
      kind: 'constant',
      config: {
        configuration: canonicalizeConstantConfiguration({
          sections: [{ filters: [{ signal: B, value: 1 }] }],
        }),
      },
      destinations: [green],
      provenance,
    } satisfies CircuitProducerNode;
    const selectorProducer = {
      id: selectorId,
      kind: 'selector',
      config: selector,
      destinations: [output],
      provenance,
    } satisfies CircuitProducerNode;
    const circuit: NativeCircuitIr = {
      format: 'comblang-ncir',
      networks: [
        { id: red, color: 'red', provenance },
        { id: green, color: 'green', provenance },
        { id: output, color: 'red', provenance },
      ],
      entities: [],
      producers: [redProducer, greenProducer, selectorProducer],
    };
    const replaced = replaceBlueprintConfigurationSetInNativeCircuitIr(
      set,
      circuit,
      [{ key: 'selector', producerId: selectorId }],
      [{ parameter: index, value: 1 }],
    );
    const defaultBound = replaceBlueprintConfigurationSetInNativeCircuitIr(set, circuit, [
      { key: 'selector', producerId: selectorId },
    ]);
    expect(
      defaultBound.producers[2]?.kind === 'selector' &&
        defaultBound.producers[2].config.operation === 'select'
        ? defaultBound.producers[2].config.index
        : null,
    ).toBe(1);
    const manual: NativeCircuitIr = {
      ...circuit,
      producers: [
        redProducer,
        greenProducer,
        { ...selectorProducer, config: { ...selector, index: 1 } },
      ],
    };

    expect(generateBlueprintJson(replaced)).toEqual(generateBlueprintJson(manual));
    expect(ticks(replaced, output, A)).toEqual(ticks(manual, output, A));
  });
});

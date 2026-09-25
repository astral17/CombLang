import {
  canonicalizeConstantConfiguration,
  signal,
  type ConstantConfiguration,
} from '@comblang/factorio';
import type { NetworkId, ProducerId } from '@comblang/shared';
import { describe, expect, expectTypeOf, test } from 'vitest';

import { generateBlueprintJson } from '@comblang/compiler/blueprint-json';
import type { ArithmeticProducerConfig, NativeCircuitIr } from '@comblang/compiler/ir';
import type { ArithmeticConfigurationTemplate } from '../../compiler/src/arithmetic-configuration-template.js';
import { createBlueprintConfigurationSet } from '../../compiler/src/blueprint-configuration-set.js';
import { bindBlueprintConfigurationSet } from '../../compiler/src/blueprint-configuration-binding.js';
import type { BlueprintParameterHandle } from '../../compiler/src/blueprint-parameters.js';
import { createBlueprintParameterSession } from '../../compiler/src/blueprint-parameters.js';
import { createArithmeticConfigurationTemplate } from '../../compiler/src/arithmetic-configuration-template.js';
import { createConstantConfigurationTemplate } from '../../compiler/src/constant-configuration-template.js';
import type { ConstantConfigurationTemplate } from '../../compiler/src/constant-configuration-template.js';
import { createSimulationFromNativeCircuitIr } from './elaboration.js';

const input = 'network:configuration-input' as NetworkId;
const output = 'network:configuration-output' as NetworkId;
const inputSignal = signal('virtual', 'signal-A');
const outputSignal = signal('virtual', 'signal-B');
const provenance = { instancePath: [], expansionStack: [] } as const;

function circuit(
  constant: ConstantConfiguration,
  arithmetic: ArithmeticProducerConfig,
): NativeCircuitIr {
  return {
    format: 'comblang-ncir',
    networks: [
      { id: input, color: 'red', provenance },
      { id: output, color: 'green', provenance },
    ],
    entities: [],
    producers: [
      {
        id: 'producer:configured-constant' as ProducerId,
        kind: 'constant',
        config: { configuration: constant },
        destinations: [input],
        provenance,
      },
      {
        id: 'producer:configured-arithmetic' as ProducerId,
        kind: 'arithmetic',
        config: arithmetic,
        destinations: [output],
        provenance,
      },
    ],
  };
}

function containsHandle(
  value: unknown,
  handles: ReadonlySet<object>,
  seen = new Set<object>(),
): boolean {
  if (value === null || typeof value !== 'object') return false;
  if (handles.has(value)) return true;
  if (seen.has(value)) return false;
  seen.add(value);
  return Reflect.ownKeys(value).some((key) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return (
      descriptor !== undefined &&
      'value' in descriptor &&
      containsHandle(descriptor.value, handles, seen)
    );
  });
}

describe('configuration-set results match concrete NCIR consumers', () => {
  test('matches Blueprint JSON and simulator-visible values without leaking parameter handles', () => {
    const session = createBlueprintParameterSession();
    const amount = session.number('amount', { defaultValue: 7 });
    const templateSignal = session.signal('source', { defaultValue: inputSignal });
    const constantTemplate = createConstantConfigurationTemplate(session, {
      sections: [{ filters: [{ signal: templateSignal, value: amount }] }],
    });
    const arithmeticTemplate = createArithmeticConfigurationTemplate(session, {
      left: {
        kind: 'signal',
        signal: templateSignal,
        refKind: 'single',
        network: input,
      },
      operation: 'add',
      right: { kind: 'constant', value: 5 },
      output: { kind: 'signal', signal: outputSignal },
    });
    const configurationSet = createBlueprintConfigurationSet(session, [
      { key: 'source', kind: 'constant', template: constantTemplate },
      { key: 'sum', kind: 'arithmetic', template: arithmeticTemplate },
    ]);
    const bound = bindBlueprintConfigurationSet(configurationSet);
    expectTypeOf<(typeof bound)[number]['config']>().not.toMatchTypeOf<BlueprintParameterHandle>();
    expectTypeOf<NativeCircuitIr>().not.toMatchTypeOf<BlueprintParameterHandle>();

    const constantEntry = bound[0];
    const arithmeticEntry = bound[1];
    if (constantEntry?.kind !== 'constant' || arithmeticEntry?.kind !== 'arithmetic') {
      throw new Error('configuration-set order or discriminator changed');
    }
    expectTypeOf(constantEntry.config).toMatchTypeOf<ConstantConfiguration>();
    expectTypeOf(constantEntry.config).not.toMatchTypeOf<ConstantConfigurationTemplate>();
    expectTypeOf(arithmeticEntry.config).toMatchTypeOf<ArithmeticProducerConfig>();
    expectTypeOf(arithmeticEntry.config).not.toMatchTypeOf<ArithmeticConfigurationTemplate>();
    const boundCircuit = circuit(constantEntry.config, arithmeticEntry.config);
    const manualConstant = canonicalizeConstantConfiguration({
      sections: [{ filters: [{ signal: inputSignal, value: 7 }] }],
    });
    const manualArithmetic: ArithmeticProducerConfig = {
      left: { kind: 'signal', signal: inputSignal, refKind: 'single', network: input },
      operation: 'add',
      right: { kind: 'constant', value: 5 },
      output: { kind: 'signal', signal: outputSignal },
    };
    const manualCircuit = circuit(manualConstant, manualArithmetic);

    expect(generateBlueprintJson(boundCircuit)).toEqual(generateBlueprintJson(manualCircuit));
    const parameterHandles = new Set<object>([amount, templateSignal]);
    expect(containsHandle(bound, parameterHandles)).toBe(false);
    expect(containsHandle(boundCircuit, parameterHandles)).toBe(false);
    expect(JSON.stringify(boundCircuit)).not.toContain('amount');
    expect(JSON.stringify(boundCircuit)).not.toContain('source');

    const boundSimulation = createSimulationFromNativeCircuitIr(boundCircuit);
    const manualSimulation = createSimulationFromNativeCircuitIr(manualCircuit);
    const boundValues = Array.from({ length: 3 }, () =>
      boundSimulation.step().read(output).get(outputSignal),
    );
    const manualValues = Array.from({ length: 3 }, () =>
      manualSimulation.step().read(output).get(outputSignal),
    );
    expect(boundValues).toEqual(manualValues);
    expect(boundValues).toContain(12);
  });
});

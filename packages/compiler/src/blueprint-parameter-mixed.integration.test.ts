import {
  canonicalizeConstantConfiguration,
  signal,
  type CircuitValue,
  type ConstantConfiguration,
  type SignalId,
} from '@comblang/factorio';
import type { NetworkId, ProducerId, SourceFileId, SourceSpan } from '@comblang/shared';
import { describe, expect, expectTypeOf, test } from 'vitest';

import { generateBlueprintJson } from './blueprint-json.js';
import { bindArithmeticConfigurationTemplate } from './arithmetic-configuration-binding.js';
import { createArithmeticConfigurationTemplate } from './arithmetic-configuration-template.js';
import { createBlueprintParameterSession } from './blueprint-parameters.js';
import { bindConstantConfigurationTemplate } from './constant-configuration-binding.js';
import { createConstantConfigurationTemplate } from './constant-configuration-template.js';
import type { BlueprintParameterBinding } from './blueprint-parameter-validation.js';
import type { ArithmeticProducerConfig, NativeCircuitIr } from './ir.js';

const source: SourceSpan = {
  fileId: 'blueprint-parameter-mixed.integration.test.ts' as SourceFileId,
  start: 12,
  end: 24,
};
const redSource = 'network:constant-red' as NetworkId;
const greenSource = 'network:constant-green' as NetworkId;
const outputNetwork = 'network:arithmetic-output' as NetworkId;
const provenance = { instancePath: [], expansionStack: [] } as const;

function mixedIr(
  parameterizedConstant: ConstantConfiguration,
  arithmetic: ArithmeticProducerConfig,
  concreteConstant: ConstantConfiguration,
): NativeCircuitIr {
  return {
    format: 'comblang-ncir',
    networks: [
      { id: redSource, color: 'red', provenance },
      { id: greenSource, color: 'green', provenance },
      { id: outputNetwork, color: 'green', provenance },
    ],
    entities: [],
    producers: [
      {
        id: 'producer:constant-parameterized' as ProducerId,
        kind: 'constant',
        config: { configuration: parameterizedConstant },
        destinations: [redSource],
        provenance,
      },
      {
        id: 'producer:arithmetic-parameterized' as ProducerId,
        kind: 'arithmetic',
        config: arithmetic,
        destinations: [outputNetwork],
        provenance,
      },
      {
        id: 'producer:constant-concrete' as ProducerId,
        kind: 'constant',
        config: { configuration: concreteConstant },
        destinations: [greenSource],
        provenance,
      },
    ],
  };
}

describe('blueprint-wide parameter reuse across Constant and Arithmetic', () => {
  test('emits the concrete baseline with unchanged entity order and red/green wire mapping', () => {
    const session = createBlueprintParameterSession();
    const count = session.number('amount', { defaultValue: 4, source });
    const iron = session.signal('iron', { defaultValue: signal('item', 'iron-plate'), source });
    expectTypeOf(count).not.toMatchTypeOf<CircuitValue>();
    expectTypeOf(iron).not.toMatchTypeOf<SignalId>();

    const constantTemplate = createConstantConfigurationTemplate(session, {
      sections: [{ filters: [{ signal: iron, value: count }] }],
    });
    const arithmeticTemplate = createArithmeticConfigurationTemplate(session, {
      left: { kind: 'constant', value: count },
      operation: 'add',
      right: {
        kind: 'signal',
        signal: iron,
        refKind: 'pair',
        networks: [redSource, greenSource],
      },
      output: { kind: 'signal', signal: iron },
    });
    const bindings: readonly BlueprintParameterBinding[] = [
      { parameter: count, value: 11 },
      { parameter: iron, value: signal('item', 'iron-plate', 'uncommon') },
    ];
    const boundConstant = bindConstantConfigurationTemplate(constantTemplate, bindings);
    const boundArithmetic = bindArithmeticConfigurationTemplate(arithmeticTemplate, bindings);

    const concreteConstant = canonicalizeConstantConfiguration({
      sections: [
        {
          filters: [{ signal: signal('item', 'copper-plate'), value: 2 }],
        },
      ],
    });
    const concreteArithmetic: ArithmeticProducerConfig = {
      left: { kind: 'constant', value: 11 },
      operation: 'add',
      right: {
        kind: 'signal',
        signal: signal('item', 'iron-plate', 'uncommon'),
        refKind: 'pair',
        networks: [redSource, greenSource],
      },
      output: { kind: 'signal', signal: signal('item', 'iron-plate', 'uncommon') },
    };
    const concreteParameterizedConstant = canonicalizeConstantConfiguration({
      sections: [
        {
          filters: [{ signal: signal('item', 'iron-plate', 'uncommon'), value: 11 }],
        },
      ],
    });
    const generated = generateBlueprintJson(
      mixedIr(boundConstant, boundArithmetic, concreteConstant),
    );
    const baseline = generateBlueprintJson(
      mixedIr(concreteParameterizedConstant, concreteArithmetic, concreteConstant),
    );

    expect(generated).toEqual(baseline);
    expect(generated.blueprint.entities.map((entity) => entity.entity_number)).toEqual([1, 2, 3]);
    expect(generated.blueprint.entities.map((entity) => entity.name)).toEqual([
      'constant-combinator',
      'arithmetic-combinator',
      'constant-combinator',
    ]);
    expect(generated.blueprint.wires).toEqual([
      [1, 1, 2, 1],
      [2, 2, 3, 2],
    ]);
    const arithmeticNative = generated.blueprint.entities[1]!.control_behavior as {
      arithmetic_conditions: {
        second_signal_networks: { red: boolean; green: boolean };
        output_signal: { name: string; quality?: string };
      };
    };
    expect(arithmeticNative.arithmetic_conditions.second_signal_networks).toEqual({
      red: true,
      green: true,
    });
    expect(arithmeticNative.arithmetic_conditions.output_signal).toMatchObject({
      name: 'iron-plate',
      quality: 'uncommon',
    });
    expect(JSON.stringify(generated)).not.toContain('amount');
    expect(JSON.stringify(generated)).not.toContain('"label":"iron"');
  });

  test('both consumers report binding errors with the shared declaration span', () => {
    const session = createBlueprintParameterSession();
    const count = session.number('amount', { defaultValue: 4, source });
    const iron = session.signal('iron', { defaultValue: signal('item', 'iron-plate'), source });
    const constantTemplate = createConstantConfigurationTemplate(session, {
      sections: [{ filters: [{ signal: iron, value: count }] }],
    });
    const arithmeticTemplate = createArithmeticConfigurationTemplate(session, {
      left: { kind: 'constant', value: count },
      operation: 'add',
      right: {
        kind: 'signal',
        signal: iron,
        refKind: 'single',
        network: redSource,
      },
      output: { kind: 'signal', signal: iron },
    });
    const malformedSignal = { type: 'invalid', name: 'not-a-signal' };

    expect(() =>
      bindConstantConfigurationTemplate(constantTemplate, [
        { parameter: iron, value: malformedSignal },
      ]),
    ).toThrowError(
      expect.objectContaining({
        code: 'CP1000',
        path: '$.sections[0].filters[0].signal.type',
        span: source,
      }),
    );
    expect(() =>
      bindArithmeticConfigurationTemplate(arithmeticTemplate, [
        { parameter: iron, value: malformedSignal },
      ]),
    ).toThrowError(
      expect.objectContaining({
        code: 'CP1000',
        path: '$.right.signal.type',
        span: source,
      }),
    );
  });
});

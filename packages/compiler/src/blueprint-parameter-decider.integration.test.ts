import {
  canonicalizeConstantConfiguration,
  signal,
  type CircuitValue,
  type ConstantConfiguration,
  type SignalId,
} from '@comblang/factorio';
import type { NetworkId, ProducerId } from '@comblang/shared';
import { describe, expect, expectTypeOf, test } from 'vitest';

import { bindArithmeticConfigurationTemplate } from './arithmetic-configuration-binding.js';
import { createArithmeticConfigurationTemplate } from './arithmetic-configuration-template.js';
import { generateBlueprintJson } from './blueprint-json.js';
import { bindConstantConfigurationTemplate } from './constant-configuration-binding.js';
import { createConstantConfigurationTemplate } from './constant-configuration-template.js';
import { bindDeciderConfigurationTemplate } from './decider-configuration-binding.js';
import { createDeciderConfigurationTemplate } from './decider-configuration-template.js';
import { createBlueprintParameterSession } from './blueprint-parameters.js';
import type { BlueprintParameterBinding } from './blueprint-parameter-validation.js';
import type {
  ArithmeticProducerConfig,
  DeciderProducerConfig,
  LogicalDeciderCondition,
  NativeCircuitIr,
} from './ir.js';

const redInput = 'network:shared-red' as NetworkId;
const greenInput = 'network:shared-green' as NetworkId;
const arithmeticOutput = 'network:arithmetic-output' as NetworkId;
const deciderOutput = 'network:decider-output' as NetworkId;
const provenance = { instancePath: [], expansionStack: [] } as const;

function blueprintIr(
  constant: ConstantConfiguration,
  arithmetic: ArithmeticProducerConfig,
  decider: DeciderProducerConfig,
): NativeCircuitIr {
  return {
    format: 'comblang-ncir',
    networks: [
      { id: redInput, color: 'red', provenance },
      { id: greenInput, color: 'green', provenance },
      { id: arithmeticOutput, color: 'green', provenance },
      { id: deciderOutput, color: 'red', provenance },
    ],
    entities: [],
    producers: [
      {
        id: 'producer:constant' as ProducerId,
        kind: 'constant',
        config: { configuration: constant },
        destinations: [redInput],
        provenance,
      },
      {
        id: 'producer:arithmetic' as ProducerId,
        kind: 'arithmetic',
        config: arithmetic,
        destinations: [arithmeticOutput],
        provenance,
      },
      {
        id: 'producer:decider' as ProducerId,
        kind: 'decider',
        config: decider,
        destinations: [deciderOutput],
        provenance,
      },
    ],
  };
}

describe('blueprint-wide parameter reuse across Constant, Arithmetic, and Decider', () => {
  test('matches manually concrete NCIR with nested rows, duplicates, quality, order, and wires', () => {
    const session = createBlueprintParameterSession();
    const count = session.number('amount', { defaultValue: 4 });
    const target = session.signal('target', { defaultValue: signal('item', 'iron-plate') });
    expectTypeOf(count).not.toMatchTypeOf<CircuitValue>();
    expectTypeOf(target).not.toMatchTypeOf<SignalId>();

    const constantTemplate = createConstantConfigurationTemplate(session, {
      sections: [{ filters: [{ signal: target, value: count }] }],
    });
    const arithmeticTemplate = createArithmeticConfigurationTemplate(session, {
      left: { kind: 'constant', value: count },
      operation: 'add',
      right: { kind: 'signal', signal: target, refKind: 'pair', networks: [redInput, greenInput] },
      output: { kind: 'signal', signal: target },
    });
    const deciderTemplate = createDeciderConfigurationTemplate(session, {
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
                  signal: target,
                  refKind: 'pair',
                  networks: [redInput, greenInput],
                },
                comparator: '>=',
                right: { kind: 'constant', value: count },
              },
              {
                kind: 'compare',
                left: { kind: 'wildcard', value: 'each', refKind: 'single', network: redInput },
                comparator: '!=',
                right: { kind: 'constant', value: 0 },
              },
            ],
          },
          {
            kind: 'and',
            conditions: [
              {
                kind: 'compare',
                left: {
                  kind: 'signal',
                  signal: target,
                  refKind: 'pair',
                  networks: [redInput, greenInput],
                },
                comparator: '>=',
                right: { kind: 'constant', value: count },
              },
            ],
          },
        ],
      },
      outputs: [
        {
          mode: 'copy',
          signal: { kind: 'signal', signal: target },
          input: { refKind: 'pair', networks: [greenInput, redInput] },
        },
        {
          mode: 'copy',
          signal: { kind: 'signal', signal: target },
          input: { refKind: 'pair', networks: [greenInput, redInput] },
        },
        { mode: 'constant', signal: { kind: 'wildcard', value: 'anything' }, value: count },
      ],
      elseOutputs: [
        {
          mode: 'copy',
          signal: { kind: 'signal', signal: target },
          input: { refKind: 'single', network: greenInput },
        },
      ],
    });
    expectTypeOf(deciderTemplate).not.toMatchTypeOf<DeciderProducerConfig>();
    expectTypeOf(deciderTemplate.condition).not.toMatchTypeOf<LogicalDeciderCondition>();

    const uncommonIron = signal('item', 'iron-plate', 'uncommon');
    const bindings: readonly BlueprintParameterBinding[] = [
      { parameter: count, value: 17 },
      { parameter: target, value: uncommonIron },
    ];
    const boundConstant = bindConstantConfigurationTemplate(constantTemplate, bindings);
    const boundArithmetic = bindArithmeticConfigurationTemplate(arithmeticTemplate, bindings);
    const boundDecider = bindDeciderConfigurationTemplate(deciderTemplate, bindings);
    expectTypeOf(boundDecider).toMatchTypeOf<DeciderProducerConfig>();

    const concreteConstant = canonicalizeConstantConfiguration({
      sections: [{ filters: [{ signal: uncommonIron, value: 17 }] }],
    });
    const concreteArithmetic: ArithmeticProducerConfig = {
      left: { kind: 'constant', value: 17 },
      operation: 'add',
      right: {
        kind: 'signal',
        signal: uncommonIron,
        refKind: 'pair',
        networks: [redInput, greenInput],
      },
      output: { kind: 'signal', signal: uncommonIron },
    };
    const concreteDecider: DeciderProducerConfig = {
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
                  signal: uncommonIron,
                  refKind: 'pair',
                  networks: [redInput, greenInput],
                },
                comparator: '>=',
                right: { kind: 'constant', value: 17 },
              },
              {
                kind: 'compare',
                left: { kind: 'wildcard', value: 'each', refKind: 'single', network: redInput },
                comparator: '!=',
                right: { kind: 'constant', value: 0 },
              },
            ],
          },
          {
            kind: 'and',
            conditions: [
              {
                kind: 'compare',
                left: {
                  kind: 'signal',
                  signal: uncommonIron,
                  refKind: 'pair',
                  networks: [redInput, greenInput],
                },
                comparator: '>=',
                right: { kind: 'constant', value: 17 },
              },
            ],
          },
        ],
      },
      outputs: [
        {
          mode: 'copy',
          signal: { kind: 'signal', signal: uncommonIron },
          input: { refKind: 'pair', networks: [greenInput, redInput] },
        },
        {
          mode: 'copy',
          signal: { kind: 'signal', signal: uncommonIron },
          input: { refKind: 'pair', networks: [greenInput, redInput] },
        },
        { mode: 'constant', signal: { kind: 'wildcard', value: 'anything' }, value: 17 },
      ],
      elseOutputs: [
        {
          mode: 'copy',
          signal: { kind: 'signal', signal: uncommonIron },
          input: { refKind: 'single', network: greenInput },
        },
      ],
    };

    const generated = generateBlueprintJson(
      blueprintIr(boundConstant, boundArithmetic, boundDecider),
    );
    const baseline = generateBlueprintJson(
      blueprintIr(concreteConstant, concreteArithmetic, concreteDecider),
    );

    expect(generated).toEqual(baseline);
    expect(generated.blueprint.entities.map((entity) => entity.entity_number)).toEqual([1, 2, 3]);
    expect(generated.blueprint.entities.map((entity) => entity.name)).toEqual([
      'constant-combinator',
      'arithmetic-combinator',
      'decider-combinator',
    ]);
    expect(generated.blueprint.wires.length).toBeGreaterThan(0);
    const decider = generated.blueprint.entities[2]!.control_behavior as {
      decider_conditions: {
        conditions: Record<string, unknown>[];
        outputs: Record<string, unknown>[];
        else_outputs: Record<string, unknown>[];
      };
    };
    expect(decider.decider_conditions.conditions).toHaveLength(3);
    expect(decider.decider_conditions.conditions.map((row) => row.compare_type)).toEqual([
      'and',
      'and',
      'or',
    ]);
    expect(decider.decider_conditions.conditions[0]).toMatchObject({
      first_signal: { name: 'iron-plate', quality: 'uncommon' },
      first_signal_networks: { red: true, green: true },
      constant: 17,
    });
    expect(decider.decider_conditions.outputs[0]).toEqual(decider.decider_conditions.outputs[1]);
    expect(decider.decider_conditions.else_outputs).toHaveLength(1);
    expect(JSON.stringify(generated)).not.toContain('amount');
    expect(JSON.stringify(generated)).not.toContain('target');
  });
});

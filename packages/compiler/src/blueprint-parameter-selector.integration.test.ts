import { signal } from '@comblang/factorio';
import type { NetworkId, ProducerId } from '@comblang/shared';
import { describe, expect, expectTypeOf, test } from 'vitest';

import { generateBlueprintJson } from './blueprint-json.js';
import { bindSelectorConfigurationTemplate } from './selector-configuration-binding.js';
import { createSelectorConfigurationTemplate } from './selector-configuration-template.js';
import { createBlueprintParameterSession } from './blueprint-parameters.js';
import type { SelectorProducerConfig } from './ir.js';
import type { SelectorConfigurationTemplate } from './selector-configuration-template.js';
import type { NativeCircuitIr } from './ir.js';

const redInput = 'network:selector-red' as NetworkId;
const greenInput = 'network:selector-green' as NetworkId;
const output = 'network:selector-output' as NetworkId;
const provenance = { instancePath: [], expansionStack: [] } as const;

function selectorIr(config: SelectorProducerConfig): NativeCircuitIr {
  return {
    format: 'comblang-ncir',
    networks: [
      { id: redInput, color: 'red', provenance },
      { id: greenInput, color: 'green', provenance },
      { id: output, color: 'red', provenance },
    ],
    entities: [],
    producers: [
      {
        id: 'producer:red-source' as ProducerId,
        kind: 'constant',
        config: { outputs: [{ signal: signal('virtual', 'red-source'), value: 1 }] },
        destinations: [redInput],
        provenance,
      },
      {
        id: 'producer:green-source' as ProducerId,
        kind: 'constant',
        config: { outputs: [{ signal: signal('virtual', 'green-source'), value: 2 }] },
        destinations: [greenInput],
        provenance,
      },
      {
        id: 'producer:selector' as ProducerId,
        kind: 'selector',
        config,
        destinations: [output],
        provenance,
      },
    ],
  };
}

function assertSelectorProjection(
  bound: SelectorProducerConfig,
  concrete: SelectorProducerConfig,
  fields: Record<string, unknown>,
): void {
  const generated = generateBlueprintJson(selectorIr(bound)).blueprint;
  const baseline = generateBlueprintJson(selectorIr(concrete)).blueprint;
  expect(generated).toEqual(baseline);
  expect(generated.entities.map((entity) => entity.entity_number)).toEqual([1, 2, 3]);
  expect(generated.entities.map((entity) => entity.name)).toEqual([
    'constant-combinator',
    'constant-combinator',
    'selector-combinator',
  ]);
  expect(generated.wires).toEqual([
    [1, 1, 3, 1],
    [2, 2, 3, 2],
  ]);
  expect(generated.entities[2]?.control_behavior).toEqual(fields);
}

describe('Selector parameter templates match concrete blueprint projection', () => {
  test('covers numeric and Signal select indices plus count output without widening NCIR', () => {
    const session = createBlueprintParameterSession();
    const number = session.number('index', { defaultValue: 0 });
    const selectedSignal = session.signal('selected', {
      defaultValue: signal('item', 'iron-plate'),
    });
    const countSignal = session.signal('count', {
      defaultValue: signal('virtual', 'signal-count'),
    });
    const input = { refKind: 'pair', networks: [greenInput, redInput] } as const;

    const numericTemplate = createSelectorConfigurationTemplate(session, {
      operation: 'select',
      input,
      selectMax: true,
      index: number,
    });
    const numeric = bindSelectorConfigurationTemplate(numericTemplate, [
      { parameter: number, value: 7 },
    ]);
    expectTypeOf(numericTemplate).not.toMatchTypeOf<SelectorProducerConfig>();
    expectTypeOf<SelectorConfigurationTemplate>().not.toMatchTypeOf<SelectorProducerConfig>();
    expectTypeOf(numeric).toMatchTypeOf<SelectorProducerConfig>();
    assertSelectorProjection(
      numeric,
      {
        operation: 'select',
        input,
        selectMax: true,
        index: 7,
      },
      {
        operation: 'select',
        select_max: true,
        index_constant: 7,
      },
    );

    const uncommonIron = signal('item', 'iron-plate', 'uncommon');
    const signalTemplate = createSelectorConfigurationTemplate(session, {
      operation: 'select',
      input,
      selectMax: false,
      index: selectedSignal,
    });
    const signalSelect = bindSelectorConfigurationTemplate(signalTemplate, [
      { parameter: selectedSignal, value: uncommonIron },
    ]);
    assertSelectorProjection(
      signalSelect,
      {
        operation: 'select',
        input,
        selectMax: false,
        index: uncommonIron,
      },
      {
        operation: 'select',
        select_max: false,
        index_signal: { name: 'iron-plate', quality: 'uncommon' },
      },
    );

    const rareCount = signal('virtual', 'signal-count', 'rare');
    const countTemplate = createSelectorConfigurationTemplate(session, {
      operation: 'count',
      input,
      output: countSignal,
    });
    const counted = bindSelectorConfigurationTemplate(countTemplate, [
      { parameter: countSignal, value: rareCount },
    ]);
    assertSelectorProjection(
      counted,
      { operation: 'count', input, output: rareCount },
      {
        operation: 'count',
        count_signal: { type: 'virtual', name: 'signal-count', quality: 'rare' },
      },
    );
  });
});

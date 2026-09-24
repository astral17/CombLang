import {
  canonicalizeConstantConfiguration,
  constantConfigurationToSparseBus,
  signal,
} from '@comblang/factorio';
import type { NetworkId, ProducerId } from '@comblang/shared';
import { describe, expect, test } from 'vitest';

import { generateBlueprintJson } from './blueprint-json.js';
import { createConstantParameterSession } from './constant-parameters.js';
import { bindConstantConfigurationTemplate } from './constant-configuration-binding.js';
import { createConstantConfigurationTemplate } from './constant-configuration-template.js';
import type { ConstantProducerConfig, NativeCircuitIr } from './ir.js';

describe('bound Constant configuration concrete replay/export integration', () => {
  test('reused handles resolve before NCIR, simulation, and canonical blueprint export', () => {
    const session = createConstantParameterSession();
    const sharedCount = session.number('shared count', { defaultValue: 8 });
    const defaultCount = session.number('default count', { defaultValue: 3 });
    const target = session.signal('target', {
      defaultValue: signal('item', 'iron-plate'),
    });
    const uncommonIron = signal('item', 'iron-plate', 'uncommon');
    const defaultSignal = signal('virtual', 'signal-fallback');
    const template = createConstantConfigurationTemplate(session, {
      sections: [
        {
          filters: [
            { signal: target, value: sharedCount },
            { signal: defaultSignal, value: defaultCount },
          ],
        },
        { filters: [{ signal: target, value: sharedCount }] },
      ],
    });
    const concrete = bindConstantConfigurationTemplate(template, [
      { parameter: sharedCount, value: 0 },
      { parameter: target, value: uncommonIron },
    ]);

    const baselineConfiguration = canonicalizeConstantConfiguration({
      sections: [
        {
          filters: [
            { signal: uncommonIron, value: 0 },
            { signal: defaultSignal, value: 3 },
          ],
        },
        { filters: [{ signal: uncommonIron, value: 0 }] },
      ],
    });
    const provenance = { instancePath: [], expansionStack: [] } as const;
    const createIr = (configuration: ConstantProducerConfig) =>
      ({
        format: 'comblang-ncir',
        networks: [
          {
            id: 'network:1' as NetworkId,
            color: 'red',
            provenance,
          },
        ],
        entities: [],
        producers: [
          {
            id: 'producer:1' as ProducerId,
            kind: 'constant',
            config: configuration,
            destinations: ['network:1' as NetworkId],
            provenance,
          },
        ],
      }) satisfies NativeCircuitIr;

    const generated = generateBlueprintJson(createIr({ configuration: concrete }));
    const expected = generateBlueprintJson(createIr({ configuration: baselineConfiguration }));
    expect(generated).toEqual(expected);

    const simulatorInput = constantConfigurationToSparseBus(concrete);
    expect(simulatorInput.get(uncommonIron)).toBe(0);
    expect(simulatorInput.get(defaultSignal)).toBe(3);
    expect(Object.isFrozen(concrete)).toBe(true);
  });
});

import { signal } from '@comblang/factorio';
import type { SourceFileId, SourceSpan } from '@comblang/shared';
import { describe, expect, test } from 'vitest';

import { bindBlueprintConfigurationSet } from './blueprint-configuration-binding.js';
import { createBlueprintConfigurationSet } from './blueprint-configuration-set.js';
import { createBlueprintParameterSession } from './blueprint-parameters.js';
import { createArithmeticConfigurationTemplate } from './arithmetic-configuration-template.js';
import { createConstantConfigurationTemplate } from './constant-configuration-template.js';
import { bindConstantConfigurationTemplate } from './constant-configuration-binding.js';
import { createDeciderConfigurationTemplate } from './decider-configuration-template.js';
import { createSelectorConfigurationTemplate } from './selector-configuration-template.js';

const source: SourceSpan = {
  fileId: 'configuration-shared-handles.test.ts' as SourceFileId,
  start: 6,
  end: 23,
};

describe('shared handles in atomic configuration sets', () => {
  test('applies defaults, explicit zero and quality-bearing Signal overrides across leaf kinds', () => {
    const session = createBlueprintParameterSession();
    const amount = session.number('amount', { defaultValue: 4, source });
    const target = session.signal('target', {
      defaultValue: signal('item', 'iron-plate', 'uncommon'),
      source,
    });
    const constant = createConstantConfigurationTemplate(session, {
      sections: [{ multiplier: amount, filters: [{ signal: target, value: 0 }] }],
    });
    const arithmetic = createArithmeticConfigurationTemplate(session, {
      left: { kind: 'constant', value: amount },
      operation: 'add',
      right: { kind: 'constant', value: 1 },
      output: { kind: 'each' },
    });
    const decider = createDeciderConfigurationTemplate(session, {
      condition: {
        kind: 'compare',
        left: { kind: 'signal', signal: target, refKind: 'single', network: 'input' },
        comparator: '>',
        right: { kind: 'constant', value: amount },
      },
      outputs: [{ mode: 'copy', signal: { kind: 'signal', signal: target } }],
    });
    const selector = createSelectorConfigurationTemplate(session, {
      operation: 'select',
      input: { refKind: 'single', network: 'input' },
      selectMax: false,
      index: target,
    });
    const configurationSet = createBlueprintConfigurationSet(session, [
      { key: 'constant', kind: 'constant', template: constant },
      { key: 'arithmetic', kind: 'arithmetic', template: arithmetic },
      { key: 'decider', kind: 'decider', template: decider },
      { key: 'selector', kind: 'selector', template: selector },
    ]);

    const fromDefaults = bindBlueprintConfigurationSet(configurationSet);
    expect(fromDefaults[0]).toMatchObject({
      kind: 'constant',
      config: {
        sections: [
          { multiplier: 4, filters: [{ signal: signal('item', 'iron-plate', 'uncommon') }] },
        ],
      },
    });
    expect(fromDefaults[1]).toMatchObject({ kind: 'arithmetic', config: { left: { value: 4 } } });
    expect(fromDefaults[2]).toMatchObject({
      kind: 'decider',
      config: {
        condition: { right: { value: 4 } },
        outputs: [{ signal: { signal: signal('item', 'iron-plate', 'uncommon') } }],
      },
    });
    expect(fromDefaults[3]).toMatchObject({
      kind: 'selector',
      config: { index: signal('item', 'iron-plate', 'uncommon') },
    });

    const rareWater = signal('fluid', 'water', 'rare');
    const overridden = bindBlueprintConfigurationSet(configurationSet, [
      { parameter: amount, value: 0 },
      { parameter: target, value: rareWater },
    ]);
    expect(overridden[0]).toMatchObject({
      kind: 'constant',
      config: { sections: [{ multiplier: 0, filters: [{ signal: rareWater, value: 0 }] }] },
    });
    expect(overridden[1]).toMatchObject({ kind: 'arithmetic', config: { left: { value: 0 } } });
    expect(overridden[2]).toMatchObject({
      kind: 'decider',
      config: {
        condition: { left: { signal: rareWater }, right: { value: 0 } },
        outputs: [{ signal: { signal: rareWater } }],
      },
    });
    expect(overridden[3]).toMatchObject({ kind: 'selector', config: { index: rareWater } });
  });

  test('validates one shared number in every field domain and keeps each normalization', () => {
    const session = createBlueprintParameterSession();
    const amount = session.number('amount', { source });
    const constant = createConstantConfigurationTemplate(session, {
      sections: [{ multiplier: amount, filters: [] }],
    });
    const arithmetic = createArithmeticConfigurationTemplate(session, {
      left: { kind: 'constant', value: amount },
      operation: 'add',
      right: { kind: 'constant', value: 0 },
      output: { kind: 'each' },
    });
    const constantOnly = bindConstantConfigurationTemplate(constant, [
      { parameter: amount, value: 1.5 },
    ]);
    const configurationSet = createBlueprintConfigurationSet(session, [
      { key: 'constant', kind: 'constant', template: constant },
      { key: 'arithmetic', kind: 'arithmetic', template: arithmetic },
    ]);

    expect(() =>
      bindBlueprintConfigurationSet(configurationSet, [{ parameter: amount, value: 1.5 }]),
    ).toThrowError(
      expect.objectContaining({
        code: 'CP1000',
        path: '$.entries[1].left.value',
        span: source,
        message: expect.stringContaining('safe integers'),
      }),
    );
    expect(constantOnly.sections[0]?.multiplier).toBe(1.5);

    const integer = bindBlueprintConfigurationSet(configurationSet, [
      { parameter: amount, value: 2_147_483_649 },
    ]);
    expect(integer[0]).toMatchObject({
      kind: 'constant',
      config: { sections: [{ multiplier: 2_147_483_649 }] },
    });
    expect(integer[1]).toMatchObject({
      kind: 'arithmetic',
      config: { left: { kind: 'constant', value: -2_147_483_647 } },
    });
  });
});

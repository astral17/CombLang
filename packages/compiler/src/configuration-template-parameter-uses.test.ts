import { describe, expect, test } from 'vitest';

import {
  createArithmeticConfigurationTemplate,
  inspectArithmeticConfigurationTemplate,
} from './arithmetic-configuration-template.js';
import { createBlueprintParameterSession } from './blueprint-parameters.js';
import {
  createConstantConfigurationTemplate,
  inspectConstantConfigurationTemplate,
} from './constant-configuration-template.js';
import {
  createDeciderConfigurationTemplate,
  inspectDeciderConfigurationTemplate,
} from './decider-configuration-template.js';
import {
  createSelectorConfigurationTemplate,
  inspectSelectorConfigurationTemplate,
} from './selector-configuration-template.js';

describe('registered configuration-template parameter uses', () => {
  test('records no handles for concrete templates and rejects forged inspection', () => {
    const session = createBlueprintParameterSession();
    const templates = [
      [
        createConstantConfigurationTemplate(session, { sections: [] }),
        inspectConstantConfigurationTemplate,
      ],
      [
        createArithmeticConfigurationTemplate(session, {
          left: { kind: 'constant', value: 1 },
          operation: 'add',
          right: { kind: 'constant', value: 2 },
          output: { kind: 'each' },
        }),
        inspectArithmeticConfigurationTemplate,
      ],
      [
        createDeciderConfigurationTemplate(session, {
          condition: {
            kind: 'compare',
            left: { kind: 'wildcard', value: 'each', refKind: 'single', network: 'input' },
            comparator: '>',
            right: { kind: 'constant', value: 0 },
          },
          outputs: [],
        }),
        inspectDeciderConfigurationTemplate,
      ],
      [
        createSelectorConfigurationTemplate(session, {
          operation: 'select',
          input: { refKind: 'single', network: 'input' },
          selectMax: false,
          index: 0,
        }),
        inspectSelectorConfigurationTemplate,
      ],
    ] as const;

    for (const [template, inspect] of templates) {
      const registration = inspect(template, '$.template');
      expect(registration.usedParameters).toEqual([]);
      expect(Object.isFrozen(registration.usedParameters)).toBe(true);
      expect(() => inspect({ ...template }, '$.template')).toThrowError(
        expect.objectContaining({ code: 'CP1002', path: '$.template' }),
      );
    }
  });

  test('records exact unique handles in stable first-use order for every leaf kind', () => {
    const session = createBlueprintParameterSession();
    const amount = session.number('amount');
    const target = session.signal('target');
    const constant = createConstantConfigurationTemplate(session, {
      sections: [
        {
          multiplier: amount,
          filters: [
            { signal: target, value: amount },
            { signal: target, value: 2 },
          ],
        },
      ],
    });
    const arithmetic = createArithmeticConfigurationTemplate(session, {
      left: { kind: 'constant', value: amount },
      operation: 'add',
      right: { kind: 'signal', signal: target, refKind: 'single', network: 'input' },
      output: { kind: 'signal', signal: target },
    });
    const decider = createDeciderConfigurationTemplate(session, {
      condition: {
        kind: 'compare',
        left: { kind: 'signal', signal: target, refKind: 'single', network: 'input' },
        comparator: '>',
        right: { kind: 'constant', value: amount },
      },
      outputs: [{ mode: 'constant', signal: { kind: 'signal', signal: target }, value: amount }],
    });
    const selector = createSelectorConfigurationTemplate(session, {
      operation: 'select',
      input: { refKind: 'single', network: 'input' },
      selectMax: false,
      index: target,
    });

    const constantUses = inspectConstantConfigurationTemplate(
      constant,
      '$.template',
    ).usedParameters;
    const arithmeticUses = inspectArithmeticConfigurationTemplate(
      arithmetic,
      '$.template',
    ).usedParameters;
    const deciderUses = inspectDeciderConfigurationTemplate(decider, '$.template').usedParameters;
    const selectorUses = inspectSelectorConfigurationTemplate(
      selector,
      '$.template',
    ).usedParameters;

    expect(constantUses).toEqual([amount, target]);
    expect(arithmeticUses).toEqual([amount, target]);
    expect(deciderUses).toEqual([target, amount]);
    expect(selectorUses).toEqual([target]);
    for (const uses of [constantUses, arithmeticUses, deciderUses, selectorUses]) {
      expect(Object.isFrozen(uses)).toBe(true);
    }
  });
});

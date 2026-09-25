import { signal } from '@comblang/factorio';
import type { NetworkId } from '@comblang/shared';
import { describe, expect, test } from 'vitest';

import { bindArithmeticConfigurationTemplate } from './arithmetic-configuration-binding.js';
import { createArithmeticConfigurationTemplate } from './arithmetic-configuration-template.js';
import { createBlueprintParameterSession } from './blueprint-parameters.js';
import { bindSelectorConfigurationTemplate } from './selector-configuration-binding.js';
import { createSelectorConfigurationTemplate } from './selector-configuration-template.js';

const red = 'network:shared-red' as NetworkId;
const green = 'network:shared-green' as NetworkId;

describe('shared blueprint parameters across Arithmetic and Selector templates', () => {
  test('rebinds shared handles independently without mutating earlier results', () => {
    const session = createBlueprintParameterSession();
    const amount = session.number('amount', { defaultValue: 1 });
    const target = session.signal('target', { defaultValue: signal('item', 'iron-plate') });
    const arithmeticTemplate = createArithmeticConfigurationTemplate(session, {
      left: { kind: 'constant', value: amount },
      operation: 'add',
      right: { kind: 'signal', signal: target, refKind: 'pair', networks: [red, green] },
      output: { kind: 'signal', signal: target },
    });
    const selectTemplate = createSelectorConfigurationTemplate(session, {
      operation: 'select',
      input: { refKind: 'pair', networks: [green, red] },
      selectMax: false,
      index: amount,
    });
    const countTemplate = createSelectorConfigurationTemplate(session, {
      operation: 'count',
      input: { refKind: 'single', network: red },
      output: target,
    });

    const uncommon = signal('item', 'iron-plate', 'uncommon');
    const epic = signal('item', 'iron-plate', 'epic');
    const firstArithmetic = bindArithmeticConfigurationTemplate(arithmeticTemplate, [
      { parameter: amount, value: 11 },
      { parameter: target, value: uncommon },
    ]);
    const firstSelect = bindSelectorConfigurationTemplate(selectTemplate, [
      { parameter: amount, value: 7 },
    ]);
    const firstCount = bindSelectorConfigurationTemplate(countTemplate, [
      { parameter: target, value: uncommon },
    ]);

    const secondArithmetic = bindArithmeticConfigurationTemplate(arithmeticTemplate, [
      { parameter: amount, value: 23 },
      { parameter: target, value: epic },
    ]);
    const secondSelect = bindSelectorConfigurationTemplate(selectTemplate, [
      { parameter: amount, value: -2 },
    ]);
    const secondCount = bindSelectorConfigurationTemplate(countTemplate, [
      { parameter: target, value: epic },
    ]);

    expect(firstArithmetic).toMatchObject({
      left: { value: 11 },
      right: { signal: uncommon },
      output: { signal: uncommon },
    });
    expect(firstSelect).toMatchObject({ index: 7 });
    expect(firstCount).toMatchObject({ output: uncommon });
    expect(secondArithmetic).toMatchObject({
      left: { value: 23 },
      right: { signal: epic },
      output: { signal: epic },
    });
    expect(secondSelect).toMatchObject({ index: -2 });
    expect(secondCount).toMatchObject({ output: epic });
    expect(firstArithmetic).toMatchObject({ left: { value: 11 }, right: { signal: uncommon } });
    expect(firstSelect).toMatchObject({ index: 7 });
    expect(firstCount).toMatchObject({ output: uncommon });
    expect(Object.isFrozen(firstArithmetic)).toBe(true);
    expect(Object.isFrozen(firstSelect)).toBe(true);
    expect(Object.isFrozen(firstCount)).toBe(true);
  });
});

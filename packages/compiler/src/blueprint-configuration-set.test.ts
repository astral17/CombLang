import { describe, expect, test } from 'vitest';

import { createBlueprintParameterSession } from './blueprint-parameters.js';
import {
  createBlueprintConfigurationSet,
  inspectBlueprintConfigurationSet,
} from './blueprint-configuration-set.js';
import { createConstantConfigurationTemplate } from './constant-configuration-template.js';
import { createArithmeticConfigurationTemplate } from './arithmetic-configuration-template.js';

describe('internal blueprint configuration sets', () => {
  test('preserves ordered authenticated entries without retaining caller containers', () => {
    const session = createBlueprintParameterSession();
    const constant = createConstantConfigurationTemplate(session, { sections: [] });
    const arithmetic = createArithmeticConfigurationTemplate(session, {
      left: { kind: 'constant', value: 1 },
      operation: 'add',
      right: { kind: 'constant', value: 2 },
      output: { kind: 'each' },
    });
    const entries = [
      { key: 'base', kind: 'constant', template: constant },
      { key: 'sum', kind: 'arithmetic', template: arithmetic },
    ];

    const configurationSet = createBlueprintConfigurationSet(session, entries);
    entries.reverse();
    entries[0]!.key = 'changed';

    const registration = inspectBlueprintConfigurationSet(configurationSet, '$.set');
    expect(registration.entries.map(({ key, kind }) => [key, kind])).toEqual([
      ['base', 'constant'],
      ['sum', 'arithmetic'],
    ]);
    expect(Object.isFrozen(configurationSet)).toBe(true);
    expect(Object.isFrozen(registration.entries)).toBe(true);
    expect(registration.entries.every(Object.isFrozen)).toBe(true);
    expect(() => inspectBlueprintConfigurationSet({ ...configurationSet }, '$.set')).toThrowError(
      expect.objectContaining({ code: 'CP1002', path: '$.set' }),
    );
  });

  test('rejects malformed entries, duplicate or unbounded keys, wrong-kind and foreign templates', () => {
    const session = createBlueprintParameterSession();
    const foreignSession = createBlueprintParameterSession();
    const constant = createConstantConfigurationTemplate(session, { sections: [] });
    const foreign = createConstantConfigurationTemplate(foreignSession, { sections: [] });

    const expectInvalid = (entries: unknown, expected: Record<string, unknown>) => {
      expect(() => createBlueprintConfigurationSet(session, entries)).toThrowError(
        expect.objectContaining(expected),
      );
    };

    expectInvalid([{ key: '', kind: 'constant', template: constant }], {
      code: 'CP1000',
      path: '$.entries[0].key',
    });
    expectInvalid([{ key: 'x'.repeat(129), kind: 'constant', template: constant }], {
      code: 'CP1000',
      path: '$.entries[0].key',
    });
    expectInvalid(
      [
        { key: 'same', kind: 'constant', template: constant },
        { key: 'same', kind: 'constant', template: constant },
      ],
      { code: 'CP1000', path: '$.entries[1].key' },
    );
    expectInvalid([{ key: 'wrong-kind', kind: 'arithmetic', template: constant }], {
      code: 'CP1001',
      path: '$.entries[0].kind',
    });
    expectInvalid([{ key: 'foreign', kind: 'constant', template: foreign }], {
      code: 'CP1001',
      path: '$.entries[0].template',
    });
    expectInvalid([{ key: 'unknown', kind: 'other', template: constant }], {
      code: 'CP1000',
      path: '$.entries[0].kind',
    });
    expectInvalid([{ key: 'extra', kind: 'constant', template: constant, extra: true }], {
      code: 'CP1000',
      path: '$.entries[0].extra',
    });
    expectInvalid(new Array(1), { code: 'CP1000', path: '$.entries[0]' });
    const withAccessor = { key: 'accessor', kind: 'constant' } as Record<string, unknown>;
    Object.defineProperty(withAccessor, 'template', {
      enumerable: true,
      get: () => constant,
    });
    expectInvalid([withAccessor], { code: 'CP1000', path: '$.entries[0].template' });
  });
});

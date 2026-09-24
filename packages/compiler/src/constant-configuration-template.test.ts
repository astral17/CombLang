import { signal, type SignalId } from '@comblang/factorio';
import { describe, expect, test } from 'vitest';

import {
  assertConstantParameterFromSession,
  createConstantParameterSession,
} from './constant-parameters.js';
import {
  createConstantConfigurationTemplate,
  inspectConstantConfigurationTemplate,
} from './constant-configuration-template.js';

describe('symbolic Constant configuration templates', () => {
  test('preserves concrete values and nominal references in ordered slots', () => {
    const session = createConstantParameterSession();
    const count = session.number('count', { defaultValue: 0 });
    const target = session.signal('target', {
      defaultValue: signal('item', 'iron-plate', 'uncommon'),
    });
    const input = {
      isOn: false,
      sections: [
        {
          active: false,
          group: 'backup',
          multiplier: 1.25,
          filters: [
            { signal: signal('virtual', 'signal-A'), value: 0 },
            { signal: target, value: count },
          ],
        },
        {
          filters: [{ signal: target, value: 2 }],
        },
      ],
    };
    const before = JSON.stringify(input);

    const template = createConstantConfigurationTemplate(session, input);

    expect(template.isOn).toBe(false);
    expect(template.sections).toHaveLength(2);
    expect(template.sections[0]).toMatchObject({
      active: false,
      group: 'backup',
      multiplier: 1.25,
    });
    expect(template.sections[0]?.filters).toEqual([
      { signal: signal('virtual', 'signal-A'), value: 0 },
      { signal: target, value: count },
    ]);
    expect(template.sections[1]).toMatchObject({
      active: true,
      multiplier: 1,
      filters: [{ value: 2 }],
    });
    expect(template.sections[1]?.filters[0]?.signal).toBe(target);
    expect(assertConstantParameterFromSession(session, count, '$.count').kind).toBe('number');
    expect(assertConstantParameterFromSession(session, target, '$.target').kind).toBe('signal');
    expect(inspectConstantConfigurationTemplate(template, '$.template').session).toBe(session);
    expect(Object.isFrozen(template)).toBe(true);
    expect(Object.isFrozen(template.sections)).toBe(true);
    expect(Object.isFrozen(template.sections[0]?.filters)).toBe(true);
    expect(JSON.stringify(input)).toBe(before);
  });

  test('rejects wrong-kind, foreign, and non-slot parameter references', () => {
    const session = createConstantParameterSession();
    const other = createConstantParameterSession();
    const count = session.number('count');
    const target = session.signal('target');
    const foreign = other.number('foreign');

    expect(() =>
      createConstantConfigurationTemplate(session, {
        sections: [{ multiplier: target, filters: [] }],
      }),
    ).toThrowError(expect.objectContaining({ code: 'CP1001', path: '$.sections[0].multiplier' }));
    expect(() =>
      createConstantConfigurationTemplate(session, {
        sections: [{ filters: [{ signal: count, value: 1 }] }],
      }),
    ).toThrowError(
      expect.objectContaining({ code: 'CP1001', path: '$.sections[0].filters[0].signal' }),
    );
    expect(() =>
      createConstantConfigurationTemplate(session, {
        sections: [{ filters: [{ signal: target, value: foreign }] }],
      }),
    ).toThrowError(
      expect.objectContaining({ code: 'CP1001', path: '$.sections[0].filters[0].value' }),
    );
    expect(() =>
      createConstantConfigurationTemplate(session, { isOn: count, sections: [] }),
    ).toThrowError(expect.objectContaining({ code: 'CP1001', path: '$.isOn' }));
    expect(() =>
      createConstantConfigurationTemplate(session, {
        sections: [{ filters: [{ signal: { kind: 'signal', label: 'fake' }, value: 1 }] }],
      }),
    ).toThrowError(expect.objectContaining({ code: 'CP1001' }));
  });

  test('rejects accessors without evaluation and enforces the Constant input budget', () => {
    const session = createConstantParameterSession();
    let getterCalls = 0;
    const section = { active: true, multiplier: 1 };
    Object.defineProperty(section, 'filters', {
      enumerable: true,
      get() {
        getterCalls += 1;
        return [];
      },
    });
    expect(() =>
      createConstantConfigurationTemplate(session, { sections: [section] }),
    ).toThrowError(expect.objectContaining({ code: 'CP1000', path: '$.sections[0].filters' }));
    expect(getterCalls).toBe(0);

    expect(() =>
      createConstantConfigurationTemplate(session, {
        sections: [{ group: 'x'.repeat(270_000), filters: [] }],
      }),
    ).toThrowError(
      expect.objectContaining({ code: 'CP1000', message: expect.stringContaining('byte limit') }),
    );
  });

  test('rejects cyclic, sparse, and unknown data while leaving original inputs untouched', () => {
    const session = createConstantParameterSession();
    const cyclic: unknown[] = [];
    cyclic.push(cyclic);
    expect(() => createConstantConfigurationTemplate(session, { sections: cyclic })).toThrowError(
      expect.objectContaining({ code: 'CP1000' }),
    );

    const sparse = new Array(1);
    expect(() => createConstantConfigurationTemplate(session, { sections: sparse })).toThrowError(
      expect.objectContaining({ code: 'CP1000' }),
    );

    expect(() =>
      createConstantConfigurationTemplate(session, { sections: [], formula: 'future' }),
    ).toThrowError(expect.objectContaining({ code: 'CP1000', path: '$.formula' }));

    const raw = { sections: [{ filters: [{ signal: signal('virtual', 'signal-A'), value: 0 }] }] };
    const before = JSON.stringify(raw);
    const template = createConstantConfigurationTemplate(session, raw);
    expect(JSON.stringify(raw)).toBe(before);
    expect(template.sections[0]?.filters[0]?.signal).toEqual(
      signal('virtual', 'signal-A') as SignalId,
    );
  });
});

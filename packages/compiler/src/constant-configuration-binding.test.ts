import { signal } from '@comblang/factorio';
import type { SourceFileId, SourceSpan } from '@comblang/shared';
import { describe, expect, test } from 'vitest';

import { createConstantParameterSession } from './constant-parameters.js';
import {
  bindConstantConfigurationTemplate,
  type ConstantParameterBinding,
} from './constant-configuration-binding.js';
import { createConstantConfigurationTemplate } from './constant-configuration-template.js';

const source: SourceSpan = { fileId: 'binding-test' as SourceFileId, start: 4, end: 11 };

describe('binding symbolic Constant configuration templates', () => {
  test('resolves defaults and overrides by handle into a fresh canonical configuration', () => {
    const session = createConstantParameterSession();
    const count = session.number('count', { defaultValue: 2, source });
    const target = session.signal('target', {
      defaultValue: signal('item', 'iron-plate', 'uncommon'),
    });
    const template = createConstantConfigurationTemplate(session, {
      isOn: false,
      sections: [
        {
          active: false,
          group: 'backup',
          multiplier: 0,
          filters: [
            { signal: target, value: count },
            { signal: target, value: 0 },
          ],
        },
      ],
    });
    const before = JSON.stringify(template, (_key, value: unknown) =>
      typeof value === 'object' && value !== null && 'kind' in value
        ? { parameter: value.kind, label: (value as { readonly label?: unknown }).label }
        : value,
    );

    const resolved = bindConstantConfigurationTemplate(template, [
      { parameter: count, value: 2_147_483_649 },
    ]);

    expect(resolved).toEqual({
      isOn: false,
      sections: [
        {
          active: false,
          group: 'backup',
          multiplier: 0,
          filters: [
            { signal: signal('item', 'iron-plate', 'uncommon'), value: -2_147_483_647 },
            { signal: signal('item', 'iron-plate', 'uncommon'), value: 0 },
          ],
        },
      ],
    });
    expect(Object.isFrozen(resolved)).toBe(true);
    expect(Object.isFrozen(resolved.sections[0]?.filters)).toBe(true);
    expect(
      JSON.stringify(template, (_key, value: unknown) =>
        typeof value === 'object' && value !== null && 'kind' in value
          ? { parameter: value.kind, label: (value as { readonly label?: unknown }).label }
          : value,
      ),
    ).toBe(before);
  });

  test('reports missing and invalid values at the slot with the declaration span', () => {
    const session = createConstantParameterSession();
    const count = session.number('count', { source });
    const template = createConstantConfigurationTemplate(session, {
      sections: [{ filters: [{ signal: signal('virtual', 'signal-A'), value: count }] }],
    });

    expect(() => bindConstantConfigurationTemplate(template)).toThrowError(
      expect.objectContaining({
        code: 'CP1002',
        path: '$.sections[0].filters[0].value',
        span: source,
      }),
    );
    expect(() =>
      bindConstantConfigurationTemplate(template, [{ parameter: count, value: 1.5 }]),
    ).toThrowError(
      expect.objectContaining({
        code: 'CP1000',
        path: '$.sections[0].filters[0].value',
        span: source,
      }),
    );
    expect(() =>
      bindConstantConfigurationTemplate(template, [{ parameter: count, value: 1.25 }]),
    ).toThrowError(
      expect.objectContaining({
        code: 'CP1000',
        message: expect.stringContaining('safe integers'),
        path: '$.sections[0].filters[0].value',
        span: source,
      }),
    );
  });

  test('rejects duplicate, unused, foreign, and wrong-kind bindings', () => {
    const session = createConstantParameterSession();
    const other = createConstantParameterSession();
    const count = session.number('count', { defaultValue: 1 });
    const unused = session.number('unused', { defaultValue: 3 });
    const foreign = other.number('foreign', { defaultValue: 1 });
    const target = session.signal('target', { defaultValue: signal('item', 'iron-plate') });
    const template = createConstantConfigurationTemplate(session, {
      sections: [{ filters: [{ signal: target, value: count }] }],
    });

    expect(() =>
      bindConstantConfigurationTemplate(template, [
        { parameter: count, value: 1 },
        { parameter: count, value: 2 },
      ]),
    ).toThrowError(expect.objectContaining({ code: 'CP1001', path: '$.bindings[1].parameter' }));
    expect(() =>
      bindConstantConfigurationTemplate(template, [{ parameter: unused, value: 3 }]),
    ).toThrowError(expect.objectContaining({ code: 'CP1001', path: '$.bindings' }));
    expect(() =>
      bindConstantConfigurationTemplate(template, [{ parameter: foreign, value: 1 }]),
    ).toThrowError(expect.objectContaining({ code: 'CP1001', path: '$.bindings[0].parameter' }));
    expect(() =>
      bindConstantConfigurationTemplate(template, [{ parameter: count, value: {} }]),
    ).toThrowError(
      expect.objectContaining({ code: 'CP1000', path: '$.sections[0].filters[0].value' }),
    );
  });

  test('validates malformed Signal IDs at their slot and keeps earlier results untouched', () => {
    const session = createConstantParameterSession();
    const count = session.number('count', { defaultValue: 5 });
    const target = session.signal('target', { source });
    const template = createConstantConfigurationTemplate(session, {
      sections: [{ filters: [{ signal: target, value: count }] }],
    });
    const good = bindConstantConfigurationTemplate(template, [
      { parameter: target, value: signal('fluid', 'water', 'rare') },
    ]);

    expect(() =>
      bindConstantConfigurationTemplate(template, [
        { parameter: target, value: { type: 'not-a-signal', name: 'water' } },
      ]),
    ).toThrowError(
      expect.objectContaining({
        code: 'CP1000',
        path: '$.sections[0].filters[0].signal.type',
        span: source,
      }),
    );
    expect(good.sections[0]?.filters[0]?.signal).toEqual(signal('fluid', 'water', 'rare'));
    expect(good.sections[0]?.filters[0]?.value).toBe(5);
  });

  test('binding records are bounded data-only records and accessors are not invoked', () => {
    const session = createConstantParameterSession();
    const count = session.number('count', { defaultValue: 1 });
    const template = createConstantConfigurationTemplate(session, {
      sections: [{ filters: [{ signal: signal('virtual', 'signal-A'), value: count }] }],
    });
    let getterCalls = 0;
    const entry = { parameter: count };
    Object.defineProperty(entry, 'value', {
      enumerable: true,
      get() {
        getterCalls += 1;
        return 4;
      },
    });

    expect(() =>
      bindConstantConfigurationTemplate(template, [entry as unknown as ConstantParameterBinding]),
    ).toThrowError(expect.objectContaining({ code: 'CP1000', path: '$.bindings[0].value' }));
    expect(getterCalls).toBe(0);
    expect(() =>
      bindConstantConfigurationTemplate(
        template,
        new Array(1) as unknown as readonly ConstantParameterBinding[],
      ),
    ).toThrowError(expect.objectContaining({ code: 'CP1000', path: '$.bindings[0]' }));
  });
});

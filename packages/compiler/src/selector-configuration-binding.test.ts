import { signal } from '@comblang/factorio';
import type { SourceFileId, SourceSpan } from '@comblang/shared';
import { describe, expect, test } from 'vitest';

import { createBlueprintParameterSession } from './blueprint-parameters.js';
import { bindSelectorConfigurationTemplate } from './selector-configuration-binding.js';
import { createSelectorConfigurationTemplate } from './selector-configuration-template.js';
import type { BlueprintParameterBinding } from './blueprint-parameter-validation.js';

const source: SourceSpan = {
  fileId: 'selector-binding.test.ts' as SourceFileId,
  start: 9,
  end: 22,
};

describe('binding symbolic Selector configuration templates', () => {
  test('applies numeric defaults and overrides with safe-integer-before-int32 normalization', () => {
    const session = createBlueprintParameterSession();
    const index = session.number('index', { defaultValue: 0, source });
    const template = createSelectorConfigurationTemplate(session, {
      operation: 'select',
      input: { refKind: 'pair', networks: ['network:green', 'network:red'] },
      selectMax: true,
      index,
    });

    const fromDefault = bindSelectorConfigurationTemplate(template);
    expect(fromDefault).toEqual({
      operation: 'select',
      input: { refKind: 'pair', networks: ['network:green', 'network:red'] },
      selectMax: true,
      index: 0,
    });
    const fromOverride = bindSelectorConfigurationTemplate(template, [
      { parameter: index, value: 2_147_483_649 },
    ]);
    expect(fromOverride).toMatchObject({ index: -2_147_483_647 });
    expect(Object.isFrozen(fromOverride)).toBe(true);
    expect(Object.isFrozen(fromOverride.input)).toBe(true);
    if (fromOverride.input.refKind === 'pair') {
      expect(Object.isFrozen(fromOverride.input.networks)).toBe(true);
    }
    expect(() =>
      bindSelectorConfigurationTemplate(template, [{ parameter: index, value: 1.5 }]),
    ).toThrowError(expect.objectContaining({ code: 'CP1000', path: '$.index', span: source }));
    expect(() =>
      bindSelectorConfigurationTemplate(template, [
        { parameter: index, value: Number.MAX_SAFE_INTEGER + 1 },
      ]),
    ).toThrowError(expect.objectContaining({ code: 'CP1000', path: '$.index', span: source }));
  });

  test('preserves the selected Signal variant and quality for select and count', () => {
    const session = createBlueprintParameterSession();
    const target = session.signal('target', { defaultValue: signal('item', 'iron-plate'), source });
    const select = createSelectorConfigurationTemplate(session, {
      operation: 'select',
      input: { refKind: 'single', network: 'network:input' },
      selectMax: false,
      index: target,
    });
    const count = createSelectorConfigurationTemplate(session, {
      operation: 'count',
      input: { refKind: 'pair', networks: ['network:red', 'network:green'] },
      output: target,
    });
    const qualitySignal = signal('item', 'iron-plate', 'rare');

    const selected = bindSelectorConfigurationTemplate(select, [
      { parameter: target, value: qualitySignal },
    ]);
    const counted = bindSelectorConfigurationTemplate(count, [
      { parameter: target, value: qualitySignal },
    ]);
    if (selected.operation !== 'select') throw new Error('expected select config');
    if (counted.operation !== 'count') throw new Error('expected count config');
    expect(selected).toMatchObject({ index: qualitySignal, selectMax: false });
    expect(counted).toMatchObject({ output: qualitySignal });
    expect(Object.isFrozen(selected.index)).toBe(true);
    expect(Object.isFrozen(counted.output)).toBe(true);
  });

  test('reports missing and invalid values at exact slots with declaration spans', () => {
    const session = createBlueprintParameterSession();
    const index = session.number('index', { source });
    const target = session.signal('target', { source });
    const numeric = createSelectorConfigurationTemplate(session, {
      operation: 'select',
      input: { refKind: 'single', network: 'network:input' },
      selectMax: false,
      index,
    });
    const output = createSelectorConfigurationTemplate(session, {
      operation: 'count',
      input: { refKind: 'single', network: 'network:input' },
      output: target,
    });

    expect(() => bindSelectorConfigurationTemplate(numeric)).toThrowError(
      expect.objectContaining({ code: 'CP1002', path: '$.index', span: source }),
    );
    expect(() => bindSelectorConfigurationTemplate(output)).toThrowError(
      expect.objectContaining({ code: 'CP1002', path: '$.output', span: source }),
    );
    expect(() =>
      bindSelectorConfigurationTemplate(numeric, [{ parameter: index, value: Infinity }]),
    ).toThrowError(expect.objectContaining({ code: 'CP1000', path: '$.index', span: source }));
    expect(() =>
      bindSelectorConfigurationTemplate(output, [
        { parameter: target, value: { type: 'invalid', name: 'signal' } },
      ]),
    ).toThrowError(
      expect.objectContaining({ code: 'CP1000', path: '$.output.type', span: source }),
    );
  });

  test('rejects wrong-kind, duplicate, unused, foreign and forged bindings', () => {
    const session = createBlueprintParameterSession();
    const other = createBlueprintParameterSession();
    const index = session.number('index', { defaultValue: 1, source });
    const unused = session.signal('unused', { defaultValue: signal('virtual', 'signal-unused') });
    const foreign = other.number('foreign', { defaultValue: 2, source });
    const template = createSelectorConfigurationTemplate(session, {
      operation: 'select',
      input: { refKind: 'single', network: 'network:input' },
      selectMax: false,
      index,
    });

    expect(() =>
      bindSelectorConfigurationTemplate(template, [
        { parameter: index, value: signal('item', 'iron-plate') as unknown as number },
      ]),
    ).toThrowError(expect.objectContaining({ code: 'CP1000', path: '$.index' }));
    expect(() =>
      bindSelectorConfigurationTemplate(template, [
        { parameter: index, value: 1 },
        { parameter: index, value: 2 },
      ]),
    ).toThrowError(expect.objectContaining({ code: 'CP1001', path: '$.bindings[1].parameter' }));
    expect(() =>
      bindSelectorConfigurationTemplate(template, [
        { parameter: unused, value: signal('virtual', 'signal-unused') },
      ]),
    ).toThrowError(expect.objectContaining({ code: 'CP1001', path: '$.bindings' }));
    expect(() =>
      bindSelectorConfigurationTemplate(template, [{ parameter: foreign, value: 2 }]),
    ).toThrowError(
      expect.objectContaining({ code: 'CP1001', path: '$.bindings[0].parameter', span: source }),
    );
    const forged = { kind: 'number', label: 'forged' } as never;
    expect(() =>
      bindSelectorConfigurationTemplate(template, [
        { parameter: forged, value: 1 } as BlueprintParameterBinding,
      ]),
    ).toThrowError(expect.objectContaining({ code: 'CP1001', path: '$.bindings[0].parameter' }));
  });

  test('leaves earlier concrete results unchanged after a failed rebind', () => {
    const session = createBlueprintParameterSession();
    const index = session.number('index', { defaultValue: 3 });
    const template = createSelectorConfigurationTemplate(session, {
      operation: 'select',
      input: { refKind: 'single', network: 'network:input' },
      selectMax: true,
      index,
    });
    const first = bindSelectorConfigurationTemplate(template);

    expect(() =>
      bindSelectorConfigurationTemplate(template, [{ parameter: index, value: 2.5 }]),
    ).toThrowError(expect.objectContaining({ code: 'CP1000' }));
    expect(first).toMatchObject({ index: 3, selectMax: true });
    expect(Object.isFrozen(first)).toBe(true);
  });
});

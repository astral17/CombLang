import { signal } from '@comblang/factorio';
import type { SourceFileId, SourceSpan } from '@comblang/shared';
import { describe, expect, test } from 'vitest';

import { createBlueprintParameterSession } from './blueprint-parameters.js';
import { createArithmeticConfigurationTemplate } from './arithmetic-configuration-template.js';
import { bindArithmeticConfigurationTemplate } from './arithmetic-configuration-binding.js';

const source: SourceSpan = {
  fileId: 'arithmetic-binding.test.ts' as SourceFileId,
  start: 7,
  end: 18,
};

describe('binding symbolic Arithmetic configuration templates', () => {
  test('applies defaults and Signal overrides to a fresh immutable concrete config', () => {
    const session = createBlueprintParameterSession();
    const count = session.number('count', { defaultValue: 0, source });
    const target = session.signal('target', { defaultValue: signal('item', 'iron-plate') });
    const template = createArithmeticConfigurationTemplate(session, {
      left: { kind: 'constant', value: count },
      operation: 'add',
      right: {
        kind: 'signal',
        signal: target,
        refKind: 'pair',
        networks: ['network:red', 'network:green'],
      },
      output: { kind: 'signal', signal: target },
    });
    const uncommonIron = signal('item', 'iron-plate', 'uncommon');

    const concrete = bindArithmeticConfigurationTemplate(template, [
      { parameter: target, value: uncommonIron },
    ]);

    expect(concrete).toEqual({
      left: { kind: 'constant', value: 0 },
      operation: 'add',
      right: {
        kind: 'signal',
        signal: uncommonIron,
        refKind: 'pair',
        networks: ['network:red', 'network:green'],
      },
      output: { kind: 'signal', signal: uncommonIron },
    });
    expect(concrete).not.toBe(template);
    expect(Object.isFrozen(concrete)).toBe(true);
    expect(Object.isFrozen(concrete.right)).toBe(true);
    if (concrete.right.kind === 'signal' && concrete.right.refKind === 'pair') {
      expect(Object.isFrozen(concrete.right.networks)).toBe(true);
      if (concrete.output.kind === 'signal') {
        expect(concrete.output.signal).toBe(concrete.right.signal);
      }
    } else {
      throw new Error('expected a pair Signal operand');
    }
    expect(concrete.left).toEqual({ kind: 'constant', value: 0 });
  });

  test('normalizes safe integer overrides to int32 and rejects fractional or unsafe values', () => {
    const session = createBlueprintParameterSession();
    const count = session.number('count', { source });
    const template = createArithmeticConfigurationTemplate(session, {
      left: { kind: 'constant', value: count },
      operation: 'subtract',
      right: { kind: 'constant', value: 2 },
      output: { kind: 'each' },
    });

    expect(
      bindArithmeticConfigurationTemplate(template, [{ parameter: count, value: 2_147_483_649 }])
        .left,
    ).toEqual({ kind: 'constant', value: -2_147_483_647 });
    expect(() =>
      bindArithmeticConfigurationTemplate(template, [{ parameter: count, value: 1.5 }]),
    ).toThrowError(
      expect.objectContaining({
        code: 'CP1000',
        path: '$.left.value',
        span: source,
      }),
    );
    expect(() =>
      bindArithmeticConfigurationTemplate(template, [
        { parameter: count, value: Number.MAX_SAFE_INTEGER + 1 },
      ]),
    ).toThrowError(expect.objectContaining({ code: 'CP1000', path: '$.left.value' }));
  });

  test('reports missing bindings at their exact operand or output slots', () => {
    const session = createBlueprintParameterSession();
    const count = session.number('count', { source });
    const target = session.signal('target', { source });
    const template = createArithmeticConfigurationTemplate(session, {
      left: { kind: 'constant', value: count },
      operation: 'add',
      right: { kind: 'constant', value: 1 },
      output: { kind: 'signal', signal: target },
    });

    expect(() => bindArithmeticConfigurationTemplate(template)).toThrowError(
      expect.objectContaining({ code: 'CP1002', path: '$.left.value', span: source }),
    );
    expect(() =>
      bindArithmeticConfigurationTemplate(template, [{ parameter: count, value: 1 }]),
    ).toThrowError(
      expect.objectContaining({ code: 'CP1002', path: '$.output.signal', span: source }),
    );
  });

  test('rejects wrong-kind, malformed, duplicate, unused and foreign bindings', () => {
    const session = createBlueprintParameterSession();
    const other = createBlueprintParameterSession();
    const count = session.number('count', { defaultValue: 1 });
    const target = session.signal('target', { defaultValue: signal('item', 'iron-plate'), source });
    const unused = session.number('unused', { defaultValue: 4 });
    const foreign = other.number('foreign', { defaultValue: 3, source });
    const template = createArithmeticConfigurationTemplate(session, {
      left: { kind: 'constant', value: count },
      operation: 'add',
      right: {
        kind: 'signal',
        signal: target,
        refKind: 'single',
        network: 'network:input',
      },
      output: { kind: 'signal', signal: target },
    });

    expect(() =>
      bindArithmeticConfigurationTemplate(template, [
        { parameter: count, value: signal('item', 'iron') },
      ]),
    ).toThrowError(expect.objectContaining({ code: 'CP1000', path: '$.left.value' }));
    expect(() =>
      bindArithmeticConfigurationTemplate(template, [{ parameter: target, value: 3 }]),
    ).toThrowError(
      expect.objectContaining({ code: 'CP1000', path: '$.right.signal', span: source }),
    );
    expect(() =>
      bindArithmeticConfigurationTemplate(template, [
        { parameter: target, value: { type: 'unknown', name: 'x' } },
      ]),
    ).toThrowError(
      expect.objectContaining({ code: 'CP1000', path: '$.right.signal.type', span: source }),
    );
    expect(() =>
      bindArithmeticConfigurationTemplate(template, [
        { parameter: count, value: 1 },
        { parameter: count, value: 2 },
      ]),
    ).toThrowError(expect.objectContaining({ code: 'CP1001', path: '$.bindings[1].parameter' }));
    expect(() =>
      bindArithmeticConfigurationTemplate(template, [{ parameter: unused, value: 4 }]),
    ).toThrowError(expect.objectContaining({ code: 'CP1001', path: '$.bindings' }));
    expect(() =>
      bindArithmeticConfigurationTemplate(template, [{ parameter: foreign, value: 3 }]),
    ).toThrowError(
      expect.objectContaining({ code: 'CP1001', path: '$.bindings[0].parameter', span: source }),
    );
  });

  test('does not mutate a previous result when a later bind fails', () => {
    const session = createBlueprintParameterSession();
    const count = session.number('count', { defaultValue: 3 });
    const template = createArithmeticConfigurationTemplate(session, {
      left: { kind: 'constant', value: count },
      operation: 'multiply',
      right: { kind: 'constant', value: 4 },
      output: { kind: 'each' },
    });
    const first = bindArithmeticConfigurationTemplate(template);

    expect(() =>
      bindArithmeticConfigurationTemplate(template, [{ parameter: count, value: Infinity }]),
    ).toThrowError(expect.objectContaining({ code: 'CP1000', path: '$.left.value' }));
    expect(first.left).toEqual({ kind: 'constant', value: 3 });
    expect(Object.isFrozen(first)).toBe(true);
  });
});

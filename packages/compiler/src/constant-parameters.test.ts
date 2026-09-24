import { signal, type SignalId } from '@comblang/factorio';
import type { SourceFileId } from '@comblang/shared';
import { describe, expect, test } from 'vitest';

import {
  assertConstantParameterFromSession,
  ConstantParameterError,
  createConstantParameterSession,
  inspectConstantParameterHandle,
} from './constant-parameters.js';

const source = {
  fileId: 'file:constant-parameters.test.ts' as SourceFileId,
  start: 8,
  end: 21,
};

describe('nominal Constant parameter declarations', () => {
  test('uses registration identity rather than display labels', () => {
    const session = createConstantParameterSession();
    const first = session.number('items', { defaultValue: 0 });
    const second = session.number('items', { defaultValue: 3 });

    expect(first).not.toBe(second);
    expect(first.label).toBe(second.label);
    expect(first.defaultValue).toBe(0);
    expect(second.defaultValue).toBe(3);
    expect(assertConstantParameterFromSession(session, first, '$.first')).toMatchObject({
      kind: 'number',
      label: 'items',
      defaultValue: 0,
    });
    expect(assertConstantParameterFromSession(session, second, '$.second')).not.toBe(
      inspectConstantParameterHandle(first, '$.first'),
    );
  });

  test('creates immutable declarations and copies optional source spans', () => {
    const session = createConstantParameterSession();
    const parameter = session.signal('target', {
      defaultValue: signal('item', 'iron-plate', 'uncommon'),
      source,
    });
    const registration = inspectConstantParameterHandle(parameter, '$.parameter');

    expect(Object.isFrozen(session)).toBe(true);
    expect(Object.isFrozen(parameter)).toBe(true);
    expect(Object.isFrozen(parameter.defaultValue)).toBe(true);
    expect(parameter.defaultValue).toEqual(signal('item', 'iron-plate', 'uncommon'));
    expect(registration.source).toEqual(source);
    expect(registration.source).not.toBe(source);
    expect(Object.isFrozen(registration.source)).toBe(true);
  });

  test('validates number and signal defaults with typed paths and source spans', () => {
    const session = createConstantParameterSession();
    expect(() => session.number('bad number', { defaultValue: Number.NaN, source })).toThrowError(
      expect.objectContaining({
        code: 'CP1000',
        path: '$.defaultValue',
        span: source,
      }),
    );
    expect(() =>
      session.signal('bad signal', {
        defaultValue: { type: 'invalid', name: 'signal-A' } as unknown as SignalId,
        source,
      }),
    ).toThrowError(
      expect.objectContaining({
        code: 'CP1000',
        path: '$.defaultValue',
        span: source,
      }),
    );
    expect(() => session.number('', { source })).toThrowError(
      expect.objectContaining({ code: 'CP1000', path: '$.label' }),
    );
  });

  test('rejects cross-session and forged handles despite matching visible fields', () => {
    const owner = createConstantParameterSession();
    const other = createConstantParameterSession();
    const parameter = owner.number('count');
    const forged = Object.freeze({ kind: 'number', label: 'count' });

    expect(() => assertConstantParameterFromSession(other, parameter, '$.parameter')).toThrowError(
      expect.objectContaining({
        code: 'CP1001',
        path: '$.parameter',
        message: expect.stringContaining('different parameter session'),
      }),
    );
    expect(() => inspectConstantParameterHandle(forged, '$.parameter')).toThrowError(
      expect.objectContaining({
        code: 'CP1001',
        path: '$.parameter',
        message: expect.stringContaining('not a registered parameter'),
      }),
    );
    expect(() =>
      assertConstantParameterFromSession({} as never, parameter, '$.session'),
    ).toThrowError(expect.objectContaining({ code: 'CP1001', path: '$.session' }));
  });

  test('keeps default validation errors in the parameter error family', () => {
    const session = createConstantParameterSession();
    try {
      session.number('infinite', { defaultValue: Number.POSITIVE_INFINITY });
      throw new Error('expected declaration failure');
    } catch (error) {
      expect(error).toBeInstanceOf(ConstantParameterError);
    }
  });
});

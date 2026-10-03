import { constantConfigurationLimits, signal, type SignalId } from '@comblang/factorio';
import type { SourceFileId } from '@comblang/shared';
import { describe, expect, test } from 'vitest';

import {
  assertBlueprintParameterFromSession,
  BlueprintParameterError,
  canonicalBlueprintParameterHandle,
  createBlueprintParameterSession,
  createBlueprintParameterSourceView,
  findBlueprintParameterHandle,
  inspectBlueprintParameterHandle,
} from './blueprint-parameters.js';

const source = {
  fileId: 'file:blueprint-parameters.test.ts' as SourceFileId,
  start: 8,
  end: 21,
};

describe('nominal blueprint parameter declarations', () => {
  test('snapshots opaque number metadata without adding it to handle properties', () => {
    const session = createBlueprintParameterSession();
    const metadata = { variable: '', formula: ' неизвестно * ( \n', dependent: false };
    const handle = session.number('N', { defaultValue: 5, source, metadata });
    metadata.formula = 'mutated';
    const registration = inspectBlueprintParameterHandle(handle, '$.parameter');
    expect(registration.metadata).toEqual({
      variable: '',
      formula: ' неизвестно * ( \n',
      dependent: false,
    });
    expect(Object.isFrozen(registration.metadata)).toBe(true);
    expect(handle).not.toHaveProperty('metadata');
    expect(inspectBlueprintParameterHandle(session.number('Plain'), '$')).not.toHaveProperty(
      'metadata',
    );
    expect(
      inspectBlueprintParameterHandle(session.number('Empty', { metadata: {} }), '$'),
    ).not.toHaveProperty('metadata');
  });

  test('uses registration identity rather than display labels', () => {
    const session = createBlueprintParameterSession();
    const first = session.number('items', { defaultValue: 0 });
    const second = session.number('items', { defaultValue: 3 });

    expect(first).not.toBe(second);
    expect(first.label).toBe(second.label);
    expect(first.defaultValue).toBe(0);
    expect(second.defaultValue).toBe(3);
    expect(assertBlueprintParameterFromSession(session, first, '$.first')).toMatchObject({
      kind: 'number',
      label: 'items',
      defaultValue: 0,
    });
    expect(assertBlueprintParameterFromSession(session, second, '$.second')).not.toBe(
      inspectBlueprintParameterHandle(first, '$.first'),
    );
  });

  test.each([
    [null, '$.metadata'],
    [[], '$.metadata'],
    [1, '$.metadata'],
    [Object.create({ variable: 'inherited' }), '$.metadata'],
    [{ variable: 1 }, '$.metadata.variable'],
    [{ formula: null }, '$.metadata.formula'],
    [{ dependent: 'false' }, '$.metadata.dependent'],
    [{ variable: undefined }, '$.metadata.variable'],
    [{ formula: undefined }, '$.metadata.formula'],
    [{ dependent: undefined }, '$.metadata.dependent'],
    [{ future: true }, '$.metadata.future'],
    [{ [Symbol('field')]: 'x' }, '$.metadata'],
    [Object.defineProperty({}, 'formula', { value: 'x' }), '$.metadata.formula'],
  ])('rejects invalid number metadata at its path: %j', (metadata, path) => {
    expect(() =>
      createBlueprintParameterSession().number('N', { source, metadata: metadata as never }),
    ).toThrowError(expect.objectContaining({ code: 'CP1000', path, span: source }));
  });

  test('does not run metadata getters and accepts null-prototype data only', () => {
    const session = createBlueprintParameterSession();
    let reads = 0;
    const accessor = Object.defineProperty({}, 'formula', {
      enumerable: true,
      get() {
        reads += 1;
        return 'x';
      },
    });
    expect(() => session.number('N', { metadata: accessor, source })).toThrowError(
      expect.objectContaining({ code: 'CP1000', path: '$.metadata.formula', span: source }),
    );
    const options = Object.defineProperty({ source }, 'metadata', {
      get() {
        reads += 1;
        return {};
      },
    });
    expect(() => session.number('N', options)).toThrowError(
      expect.objectContaining({ path: '$.metadata' }),
    );
    expect(reads).toBe(0);
    const metadata = Object.assign(Object.create(null), {
      dependent: true,
      formula: 'missing+',
      variable: 'x',
    });
    const registration = inspectBlueprintParameterHandle(session.number('N', { metadata }), '$');
    expect(registration.metadata).toEqual({ variable: 'x', formula: 'missing+', dependent: true });
    expect(Object.keys(registration.metadata!)).toEqual(['variable', 'formula', 'dependent']);
    expect(() =>
      session.signal('S', { metadata: { variable: 'x' }, source } as never),
    ).toThrowError(expect.objectContaining({ code: 'CP1000', path: '$.metadata', span: source }));
    expect(() =>
      session.number('Huge', {
        source,
        metadata: { formula: '界'.repeat(constantConfigurationLimits.maxBytes) },
      }),
    ).toThrowError(expect.objectContaining({ code: 'CP1000', path: '$.metadata', span: source }));
  });

  test('creates immutable declarations and copies optional source spans', () => {
    const session = createBlueprintParameterSession();
    const parameter = session.signal('target', {
      defaultValue: signal('item', 'iron-plate', 'uncommon'),
      source,
    });
    const registration = inspectBlueprintParameterHandle(parameter, '$.parameter');

    expect(Object.isFrozen(session)).toBe(true);
    expect(Object.isFrozen(parameter)).toBe(true);
    expect(Object.isFrozen(parameter.defaultValue)).toBe(true);
    expect(parameter.defaultValue).toEqual(signal('item', 'iron-plate', 'uncommon'));
    expect(registration.source).toEqual(source);
    expect(registration.source).not.toBe(source);
    expect(Object.isFrozen(registration.source)).toBe(true);
  });

  test('validates number and signal defaults with typed paths and source spans', () => {
    const session = createBlueprintParameterSession();
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
    const owner = createBlueprintParameterSession();
    const other = createBlueprintParameterSession();
    const parameter = owner.number('count');
    const forged = Object.freeze({ kind: 'number', label: 'count' });

    expect(() => assertBlueprintParameterFromSession(other, parameter, '$.parameter')).toThrowError(
      expect.objectContaining({
        code: 'CP1001',
        path: '$.parameter',
        message: expect.stringContaining('different parameter session'),
      }),
    );
    expect(() => inspectBlueprintParameterHandle(forged, '$.parameter')).toThrowError(
      expect.objectContaining({
        code: 'CP1001',
        path: '$.parameter',
        message: expect.stringContaining('not a registered parameter'),
      }),
    );
    expect(() =>
      assertBlueprintParameterFromSession({} as never, parameter, '$.session'),
    ).toThrowError(expect.objectContaining({ code: 'CP1001', path: '$.session' }));
  });

  test('keeps opaque source views distinct while resolving them to their owned host handle', () => {
    const session = createBlueprintParameterSession();
    const foreignSession = createBlueprintParameterSession();
    const handle = session.number('items', { defaultValue: 5, source });
    const view = createBlueprintParameterSourceView(session, handle);

    expect(Object.is(view, handle)).toBe(false);
    expect(Object.isFrozen(handle)).toBe(true);
    expect(handle).toMatchObject({ kind: 'number', label: 'items', defaultValue: 5, source });
    expect(findBlueprintParameterHandle(view)).toMatchObject({
      kind: 'number',
      label: 'items',
      defaultValue: 5,
      source,
    });
    expect(canonicalBlueprintParameterHandle(view)).toBe(handle);
    expect(assertBlueprintParameterFromSession(session, view, '$.parameter')).toEqual(
      inspectBlueprintParameterHandle(handle, '$.parameter'),
    );

    const blockedReads: Array<() => unknown> = [
      () => (view as Record<string, unknown>).label,
      () => Object.keys(view),
      () => Reflect.ownKeys(view),
      () => Object.getOwnPropertyDescriptor(view, 'label'),
      () => Object.getPrototypeOf(view),
      () => String(view),
    ];
    for (const read of blockedReads) {
      expect(read).toThrowError(
        expect.objectContaining({ code: 'CP1001', path: '$.parameter', span: source }),
      );
    }

    expect(() =>
      assertBlueprintParameterFromSession(foreignSession, view, '$.parameter'),
    ).toThrowError(
      expect.objectContaining({
        code: 'CP1001',
        path: '$.parameter',
        message: expect.stringContaining('different parameter session'),
      }),
    );
    expect(() => createBlueprintParameterSourceView(session, { ...handle })).toThrowError(
      expect.objectContaining({ code: 'CP1001', path: '$.parameter' }),
    );
    expect(() => createBlueprintParameterSourceView(foreignSession, handle)).toThrowError(
      expect.objectContaining({ code: 'CP1001', path: '$.parameter', span: source }),
    );
  });

  test('keeps default validation errors in the parameter error family', () => {
    const session = createBlueprintParameterSession();
    try {
      session.number('infinite', { defaultValue: Number.POSITIVE_INFINITY });
      throw new Error('expected declaration failure');
    } catch (error) {
      expect(error).toBeInstanceOf(BlueprintParameterError);
    }
  });
});

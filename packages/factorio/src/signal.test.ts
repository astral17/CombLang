import { describe, expect, test } from 'vitest';

import {
  formatSignalRef,
  parseSignalRef,
  Signal,
  sameSignal,
  signal,
  signalKey,
  signalTypes,
} from './signal.js';

describe('SignalID', () => {
  test('creates an immutable explicit Factorio signal structure', () => {
    const A = Signal('virtual', 'signal-A', 'normal');

    expect(A).toEqual({ type: 'virtual', name: 'signal-A', quality: 'normal' });
    expect(Object.isFrozen(A)).toBe(true);
    expect(Object.getOwnPropertySymbols(A)).toEqual([]);
    expect(signal('virtual', 'signal-A', 'normal')).toEqual(A);
  });

  test('creates the same default item signal as a name-only Network selection', () => {
    const chest = Signal('chest');

    expect(chest).toEqual({ type: 'item', name: 'chest' });
    expect(signal('chest')).toEqual(chest);
    expect(Object.isFrozen(chest)).toBe(true);
  });

  test('keeps type and quality in structural identity', () => {
    const normal = Signal('virtual', 'signal-A', 'normal');
    const legendary = Signal('virtual', 'signal-A', 'legendary');
    const item = Signal('item', 'signal-A', 'normal');

    expect(sameSignal(normal, Signal('virtual', 'signal-A', 'normal'))).toBe(true);
    expect(sameSignal(normal, legendary)).toBe(false);
    expect(sameSignal(normal, item)).toBe(false);
    expect(new Set([signalKey(normal), signalKey(legendary), signalKey(item)]).size).toBe(3);
  });

  test('rejects incomplete and invalid structures at runtime', () => {
    expect(() => Signal('unknown' as 'virtual', 'signal-A')).toThrow(/unknown signal type/i);
    expect(() => Signal('virtual', '')).toThrow(/name cannot be empty/i);
    expect(() => Signal('virtual', 'signal-A', '')).toThrow(/quality cannot be empty/i);
    expect(() => Signal('virtual', undefined as unknown as string)).toThrow(
      /name cannot be empty/i,
    );
  });

  test.each(signalTypes)('round-trips the %s signal namespace as a SignalRef', (type) => {
    const value = Signal(type, 'name/with%delimiters 🛰', 'quality/légendaire%');

    expect(parseSignalRef(formatSignalRef(value))).toEqual(value);
  });

  test('formats shorthand, namespaces, and quality canonically', () => {
    const omitted = Signal('item', 'iron-plate');
    const normal = Signal('item', 'iron-plate', 'normal');
    const virtual = Signal('virtual', 'signal-A');
    const itemQuality = Signal('item', 'iron-plate', 'legendary');

    expect(formatSignalRef(omitted)).toBe('iron-plate');
    expect(formatSignalRef(normal)).toBe('iron-plate');
    expect(formatSignalRef(virtual)).toBe('virtual/signal-A');
    expect(formatSignalRef(itemQuality)).toBe('item/iron-plate/legendary');
    expect(signalKey(normal)).toBe(signalKey(omitted));
    expect(sameSignal(normal, omitted)).toBe(true);
    expect(parseSignalRef('item/iron-plate')).toEqual(omitted);
    expect(parseSignalRef('virtual/signal-A')).toEqual(virtual);
    expect(parseSignalRef('item/iron-plate/normal')).toEqual(omitted);
  });

  test.each([
    '',
    '/',
    'virtual/',
    'virtual//signal-A',
    'virtual/signal-A/',
    'virtual/signal-A/extra/more',
    'unknown/signal-A',
    'virtual/%',
    'virtual/%2f',
    'virtual/%69ignal-A',
    'virtual/signal-A/%6eormal',
  ])('rejects malformed or noncanonical SignalRef %s', (ref) => {
    expect(() => parseSignalRef(ref)).toThrow(TypeError);
  });

  test('rejects lone surrogates with a SignalRef TypeError', () => {
    expect(() => formatSignalRef(Signal('item', '\ud800'))).toThrowError(
      /unpaired UTF-16 surrogate/,
    );
    expect(() => formatSignalRef({ type: 'item', name: 'plate', quality: '\udfff' })).toThrowError(
      /unpaired UTF-16 surrogate/,
    );
    expect(() => parseSignalRef('item/\ud800')).toThrowError(/unpaired UTF-16 surrogate/);
  });

  test('keeps a slash-containing one-argument Signal name literal', () => {
    const value = Signal('virtual/signal-A');
    expect(value).toEqual({
      type: 'item',
      name: 'virtual/signal-A',
    });
    expect(formatSignalRef(value)).toBe('virtual%2Fsignal-A');
  });

  test('encodes reserved delimiters and never emits the removed prefix', () => {
    const refs = signalTypes.flatMap((type) => [
      formatSignalRef(Signal(type, 'name/with%delimiters 🛰')),
      formatSignalRef(Signal(type, 'name', 'quality/légendaire%')),
    ]);

    expect(refs.every((ref) => !ref.startsWith('signal:'))).toBe(true);
    expect(refs).toContain('virtual/name%2Fwith%25delimiters%20%F0%9F%9B%B0');
  });
});

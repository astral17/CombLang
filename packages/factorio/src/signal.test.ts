import { describe, expect, test } from 'vitest';

import {
  encodeSignalPropertyKey,
  parseSignalPropertyKey,
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

  test.each(signalTypes)('round-trips the %s signal namespace as a property key', (type) => {
    const value = Signal(type, 'name/with%delimiters 🛰', 'quality/légendaire%');

    expect(parseSignalPropertyKey(encodeSignalPropertyKey(value))).toEqual(value);
  });

  test('canonicalizes omitted and explicit normal quality to the same identity key', () => {
    const omitted = Signal('item', 'iron-plate');
    const normal = Signal('item', 'iron-plate', 'normal');

    expect(encodeSignalPropertyKey(omitted)).toBe('signal:v1/item/iron-plate/');
    expect(encodeSignalPropertyKey(normal)).toBe('signal:v1/item/iron-plate/');
    expect(signalKey(normal)).toBe(signalKey(omitted));
    expect(sameSignal(normal, omitted)).toBe(true);
    expect(parseSignalPropertyKey(encodeSignalPropertyKey(omitted))).toEqual(omitted);
    expect(parseSignalPropertyKey(encodeSignalPropertyKey(normal))).toEqual(omitted);
  });

  test.each([
    'item/iron-plate/',
    'signal:v1/item//',
    'signal:v1/item/iron-plate',
    'signal:v1/item/iron-plate//extra',
    'signal:v1/unknown/iron-plate/',
    'signal:v1/item/%/',
    'signal:v1/item/%2f/',
    'signal:v1/item/%69ron-plate/',
    'signal:v1/item/iron-plate/normal',
  ])('rejects malformed or noncanonical property key %s', (key) => {
    expect(() => parseSignalPropertyKey(key)).toThrow(TypeError);
  });

  test('rejects lone surrogates with a codec-specific TypeError', () => {
    expect(() => encodeSignalPropertyKey(Signal('item', '\ud800'))).toThrowError(
      /unpaired UTF-16 surrogate/,
    );
    expect(() =>
      encodeSignalPropertyKey({ type: 'item', name: 'plate', quality: '\udfff' }),
    ).toThrowError(/unpaired UTF-16 surrogate/);
  });

  test('keeps a prefixed one-argument Signal name literal', () => {
    expect(Signal('signal:v1/virtual/signal-A/')).toEqual({
      type: 'item',
      name: 'signal:v1/virtual/signal-A/',
    });
  });
});

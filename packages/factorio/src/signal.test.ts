import { describe, expect, test } from 'vitest';

import { Signal, sameSignal, signal, signalKey } from './signal.js';

describe('SignalID', () => {
  test('creates an immutable explicit Factorio signal structure', () => {
    const A = Signal('virtual', 'signal-A', 'normal');

    expect(A).toEqual({ type: 'virtual', name: 'signal-A', quality: 'normal' });
    expect(Object.isFrozen(A)).toBe(true);
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
});

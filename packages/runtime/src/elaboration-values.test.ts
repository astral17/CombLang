import { describe, expect, test } from 'vitest';

import { Signal } from '@comblang/factorio';

import { RuntimeValueRegistry } from './elaboration-values.js';

describe('runtime value registry', () => {
  test('brands values nominally within one elaboration session', () => {
    const first = new RuntimeValueRegistry();
    const second = new RuntimeValueRegistry();
    const token = first.brand({ kind: 'wildcard-token', value: 'each' });

    expect(first.hasKind(token, 'wildcard-token')).toBe(true);
    expect(first.hasKind(token, 'condition')).toBe(false);
    expect(second.hasKind(token, 'wildcard-token')).toBe(false);
    expect(first.hasKind({ kind: 'wildcard-token', value: 'each' }, 'wildcard-token')).toBe(false);
  });

  test('brands source Signal handles without changing their structural identity', () => {
    const first = new RuntimeValueRegistry();
    const second = new RuntimeValueRegistry();
    const signal = first.brandSignal(Signal('virtual', 'signal-A'));

    expect(signal).toEqual({ type: 'virtual', name: 'signal-A' });
    expect(first.hasSignal(signal)).toBe(true);
    expect(second.hasSignal(signal)).toBe(false);
    expect(first.hasSignal({ type: 'virtual', name: 'signal-A' })).toBe(false);
  });

  test('keeps mutable Network ownership state outside a frozen source handle', () => {
    const registry = new RuntimeValueRegistry();
    const network = registry.brandNetwork(
      {
        kind: 'network',
        name: 'input',
        declaration: { fileId: 'opaque.factorio.ts' as never, start: 0, end: 5 },
        capability: 'owned',
        generation: 0,
      },
      {
        ownership: {
          generation: 0,
          owner: 'top-level',
          readonlyBorrows: new Set(),
        },
      },
    );

    expect(network).not.toHaveProperty('ownership');
    expect(network).not.toHaveProperty('borrow');
    expect(Object.isFrozen(network)).toBe(true);
    expect(Reflect.set(network, 'generation', 99)).toBe(false);
    expect(registry.networkState(network)?.ownership.generation).toBe(0);
  });
});

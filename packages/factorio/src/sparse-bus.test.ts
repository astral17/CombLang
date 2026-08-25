import { describe, expect, it } from 'vitest';

import {
  addInt32,
  aggregateBuses,
  divideInt32,
  moduloInt32,
  multiplyInt32,
  powerInt32,
  signal,
  SparseBus,
} from './index.js';

describe('Factorio circuit value primitives', () => {
  const normalA = signal('virtual', 'signal-A', 'normal');
  const legendaryA = signal('virtual', 'signal-A', 'legendary');

  it('keeps quality as part of signal identity', () => {
    const bus = new SparseBus([
      [normalA, 2],
      [legendaryA, 3],
    ]);
    expect(bus.get(normalA)).toBe(2);
    expect(bus.get(legendaryA)).toBe(3);
  });

  it('aggregates networks with signed int32 wrapping', () => {
    const result = aggregateBuses([
      new SparseBus([[normalA, 2_147_483_647]]),
      new SparseBus([[normalA, 1]]),
    ]);
    expect(result.get(normalA)).toBe(-2_147_483_648);
    expect(addInt32(2_147_483_647, 1)).toBe(-2_147_483_648);
    expect(multiplyInt32(0x40000000, 4)).toBe(0);
  });

  it('does not store zero-valued signals', () => {
    expect(new SparseBus([[normalA, 0]]).size).toBe(0);
  });

  it('uses Factorio-style truncating division and signed remainder', () => {
    expect(divideInt32(-19, 10)).toBe(-1);
    expect(divideInt32(19, -10)).toBe(-1);
    expect(moduloInt32(-13, -3)).toBe(-1);
    expect(divideInt32(42, 0)).toBe(0);
    expect(moduloInt32(42, 0)).toBe(0);
  });

  it('wraps exponentiation after every int32 multiplication', () => {
    expect(powerInt32(2, 31)).toBe(-2_147_483_648);
    expect(powerInt32(3, 0)).toBe(1);
    expect(powerInt32(-1, -3)).toBe(-1);
    expect(powerInt32(2, -1)).toBe(0);
  });

  it('rejects fractional and unsafe circuit inputs before normalization', () => {
    expect(() => new SparseBus([[normalA, 1.5]])).toThrow(/safe integers/);
    expect(() => new SparseBus([[normalA, Number.MAX_SAFE_INTEGER + 1]])).toThrow(/safe integers/);
  });
});

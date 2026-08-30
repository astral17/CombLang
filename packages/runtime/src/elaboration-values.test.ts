import { describe, expect, test } from 'vitest';

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
});

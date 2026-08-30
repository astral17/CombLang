import { describe, expect, test } from 'vitest';

import { ElaborationProvenanceFormatter } from './elaboration-provenance.js';

describe('elaboration provenance formatter', () => {
  test('formats object identities without invoking user coercion hooks', () => {
    let calls = 0;
    const first = {
      toString(): string {
        calls += 1;
        return 'coerced';
      },
    };
    const second = {};
    const callable = (): void => undefined;
    const formatter = new ElaborationProvenanceFormatter();

    expect(formatter.format(first)).toBe('object#1');
    expect(formatter.format(second)).toBe('object#2');
    expect(formatter.format(first)).toBe('object#1');
    expect(formatter.format(callable)).toBe('function#3');
    expect(calls).toBe(0);
  });

  test('keeps primitive loop labels readable', () => {
    const formatter = new ElaborationProvenanceFormatter();

    expect([
      formatter.format('green'),
      formatter.format(2),
      formatter.format(true),
      formatter.format(3n),
      formatter.format(null),
      formatter.format(undefined),
    ]).toEqual(['green', '2', 'true', '3', 'null', 'undefined']);
  });
});

import { describe, expect, it } from 'vitest';

import type { SourceDraftStorage } from './source-draft.js';
import { loadTestDraft, saveTestDraft, TEST_DRAFT_KEY } from './test-draft.js';

function storage(): SourceDraftStorage {
  const values = new Map<string, string>();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
  };
}

describe('test draft persistence', () => {
  it('uses storage independent from the circuit source', () => {
    const target = storage();
    expect(saveTestDraft(target, 'test("a", () => {});')).toBe(true);
    expect(loadTestDraft(target)).toBe('test("a", () => {});');
    expect(TEST_DRAFT_KEY).not.toBe('comblang.source-draft.v1');
  });
});

import { describe, expect, it } from 'vitest';

import {
  loadSourceDraft,
  saveSourceDraft,
  SOURCE_DRAFT_KEY,
  type SourceDraftStorage,
} from './source-draft.js';

function memoryStorage(): SourceDraftStorage {
  const values = new Map<string, string>();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
  };
}

describe('source draft persistence', () => {
  it('round-trips source, including an intentionally empty editor', () => {
    const storage = memoryStorage();
    expect(loadSourceDraft(storage)).toBeUndefined();
    expect(saveSourceDraft(storage, '')).toBe(true);
    expect(loadSourceDraft(storage)).toBe('');
    expect(saveSourceDraft(storage, 'let output = new Network();')).toBe(true);
    expect(loadSourceDraft(storage)).toBe('let output = new Network();');
  });

  it('uses a versioned, project-specific key', () => {
    expect(SOURCE_DRAFT_KEY).toBe('comblang.source-draft.v1');
  });

  it('keeps independent browser-tab storage areas isolated', () => {
    const firstTab = memoryStorage();
    const secondTab = memoryStorage();

    saveSourceDraft(firstTab, 'const first = new Network();');
    saveSourceDraft(secondTab, 'const second = new Network();');

    expect(loadSourceDraft(firstTab)).toBe('const first = new Network();');
    expect(loadSourceDraft(secondTab)).toBe('const second = new Network();');
  });

  it('does not break the editor when browser storage is unavailable', () => {
    const unavailable: SourceDraftStorage = {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('quota');
      },
    };
    expect(loadSourceDraft(unavailable)).toBeUndefined();
    expect(saveSourceDraft(unavailable, 'source')).toBe(false);
    expect(loadSourceDraft(undefined)).toBeUndefined();
  });
});

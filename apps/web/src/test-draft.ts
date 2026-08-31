import type { SourceDraftStorage } from './source-draft.js';

export const TEST_DRAFT_KEY = 'comblang.test-draft.v1';

export function loadTestDraft(storage: SourceDraftStorage | undefined): string | undefined {
  if (storage === undefined) return undefined;
  try {
    return storage.getItem(TEST_DRAFT_KEY) ?? undefined;
  } catch {
    return undefined;
  }
}

export function saveTestDraft(storage: SourceDraftStorage | undefined, source: string): boolean {
  if (storage === undefined) return false;
  try {
    storage.setItem(TEST_DRAFT_KEY, source);
    return true;
  } catch {
    return false;
  }
}

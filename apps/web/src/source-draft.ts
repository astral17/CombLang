export const SOURCE_DRAFT_KEY = 'comblang.source-draft.v1';

export interface SourceDraftStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export function loadSourceDraft(storage: SourceDraftStorage | undefined): string | undefined {
  if (storage === undefined) return undefined;
  try {
    return storage.getItem(SOURCE_DRAFT_KEY) ?? undefined;
  } catch {
    return undefined;
  }
}

export function saveSourceDraft(storage: SourceDraftStorage | undefined, source: string): boolean {
  if (storage === undefined) return false;
  try {
    storage.setItem(SOURCE_DRAFT_KEY, source);
    return true;
  } catch {
    return false;
  }
}

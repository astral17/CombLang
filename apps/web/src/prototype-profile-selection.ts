import type { StoredPrototypeProfile } from './prototype-profile-store.js';

export const PROFILE_SELECTION_KEY = 'comblang.prototype-selection.v1';

export type PrototypeProfileSelection =
  | { readonly kind: 'builtin'; readonly profile: StoredPrototypeProfile }
  | { readonly kind: 'disabled' }
  | { readonly kind: 'custom'; readonly profile: StoredPrototypeProfile }
  | { readonly kind: 'builtin-unavailable'; readonly message: string }
  | { readonly kind: 'custom-unavailable'; readonly message: string };

/** Resolves the persisted browser choice without making storage or network decisions. */
export function resolvePrototypeProfileSelection(
  selection: string | null,
  savedProfile: StoredPrototypeProfile | undefined,
  builtinProfile: StoredPrototypeProfile | undefined,
): PrototypeProfileSelection {
  if (selection === '') return { kind: 'disabled' };
  if (selection === null) {
    return builtinProfile === undefined
      ? {
          kind: 'builtin-unavailable',
          message: 'Built-in prototype profile unavailable; ordinary circuits remain available.',
        }
      : { kind: 'builtin', profile: builtinProfile };
  }
  if (savedProfile?.identity === selection) return { kind: 'custom', profile: savedProfile };
  return {
    kind: 'custom-unavailable',
    message: 'The selected prototype database is missing from browser storage.',
  };
}

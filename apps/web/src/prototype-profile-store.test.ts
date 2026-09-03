import { describe, expect, test } from 'vitest';
import {
  PrototypeProfileStore,
  type PrototypeProfileBackend,
  type StoredPrototypeProfile,
} from './prototype-profile-store.js';

function memoryBackend(): PrototypeProfileBackend & { value?: unknown } {
  return {
    async get() {
      return this.value as StoredPrototypeProfile | undefined;
    },
    async put(profile) {
      this.value = profile;
    },
    async delete() {
      delete this.value;
    },
  };
}

describe('browser prototype profile persistence', () => {
  test('round-trips a detached profile and clears it explicitly', async () => {
    const backend = memoryBackend();
    const store = new PrototypeProfileStore(backend);
    const profile = { name: 'space age.json', source: '{"schemaVersion":1}', identity: 'hash' };
    expect(await store.save(profile)).toBe(true);
    expect(await store.load()).toEqual(profile);
    expect(backend.value).not.toBe(profile);
    expect(await store.clear()).toBe(true);
    expect(await store.load()).toBeUndefined();
  });

  test('fails closed when browser storage is unavailable', async () => {
    const unavailable: PrototypeProfileBackend = {
      get: async () => {
        throw new Error('denied');
      },
      put: async () => {
        throw new Error('quota');
      },
      delete: async () => {
        throw new Error('denied');
      },
    };
    const store = new PrototypeProfileStore(unavailable);
    await expect(store.load()).rejects.toThrow('denied');
    expect(await store.save({ name: 'x', source: '{}' })).toBe(false);
    expect(await store.clear()).toBe(false);
  });

  test('rejects malformed cached records instead of treating them as no selection', async () => {
    const backend = memoryBackend();
    backend.value = { name: 'broken', source: 5 };
    await expect(new PrototypeProfileStore(backend).load()).rejects.toThrow('malformed');
  });
});

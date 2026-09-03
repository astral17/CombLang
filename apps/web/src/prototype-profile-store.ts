export interface StoredPrototypeProfile {
  readonly name: string;
  readonly source: string;
  readonly identity?: string;
}

export interface PrototypeProfileBackend {
  get(): Promise<StoredPrototypeProfile | undefined>;
  put(profile: StoredPrototypeProfile): Promise<void>;
  delete(): Promise<void>;
}

export class PrototypeProfileStore {
  constructor(private readonly backend: PrototypeProfileBackend) {}

  async load(): Promise<StoredPrototypeProfile | undefined> {
    const value = await this.backend.get();
    if (
      value !== undefined &&
      (typeof value !== 'object' ||
        value === null ||
        typeof value.name !== 'string' ||
        typeof value.source !== 'string' ||
        (value.identity !== undefined && typeof value.identity !== 'string'))
    ) {
      throw new Error('Stored prototype profile is malformed.');
    }
    return value;
  }

  async save(profile: StoredPrototypeProfile): Promise<boolean> {
    try {
      await this.backend.put(structuredClone(profile));
      return true;
    } catch {
      return false;
    }
  }

  async clear(): Promise<boolean> {
    try {
      await this.backend.delete();
      return true;
    } catch {
      return false;
    }
  }
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.addEventListener('success', () => resolve(request.result), { once: true });
    request.addEventListener(
      'error',
      () => reject(request.error ?? new Error('IndexedDB request failed.')),
      { once: true },
    );
  });
}

async function database(indexedDb: IDBFactory): Promise<IDBDatabase> {
  const request = indexedDb.open('comblang.prototype-profiles.v1', 1);
  request.addEventListener('upgradeneeded', () => {
    if (!request.result.objectStoreNames.contains('profiles'))
      request.result.createObjectStore('profiles');
  });
  return requestResult(request);
}

export function browserPrototypeProfileStore(key: string): PrototypeProfileStore {
  const use = async <T>(
    mode: IDBTransactionMode,
    action: (store: IDBObjectStore) => IDBRequest<T>,
  ) => {
    const db = await database(globalThis.indexedDB);
    try {
      const transaction = db.transaction('profiles', mode);
      const done = new Promise<void>((resolve, reject) => {
        transaction.oncomplete = () => resolve();
        transaction.onabort = () =>
          reject(transaction.error ?? new Error('IndexedDB transaction aborted.'));
        transaction.onerror = () =>
          reject(transaction.error ?? new Error('IndexedDB transaction failed.'));
      });
      const [result] = await Promise.all([
        requestResult(action(transaction.objectStore('profiles'))),
        done,
      ]);
      return result;
    } finally {
      db.close();
    }
  };
  return new PrototypeProfileStore({
    get: async () =>
      (await use('readonly', (store) => store.get(key))) as StoredPrototypeProfile | undefined,
    put: async (profile) => {
      await use('readwrite', (store) => store.put(profile, key));
    },
    delete: async () => {
      await use('readwrite', (store) => store.delete(key));
    },
  });
}

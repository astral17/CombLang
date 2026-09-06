import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { describe, expect, test, vi } from 'vitest';

type WorkerListener = (event: Record<string, unknown>) => void;

interface CacheStorageHarness {
  readonly cacheNames: Set<string>;
  readonly responses: Map<string, Map<string, unknown>>;
  readonly deleted: string[];
  readonly opened: string[];
  readonly matched: { readonly cacheName: string; readonly url: string }[];
}

interface WorkerHarness {
  readonly added: string[];
  readonly deleted: string[];
  readonly listeners: Map<string, WorkerListener>;
  readonly opened: string[];
}

function cacheStorageHarness(
  cacheNames: readonly string[],
  responses: ReadonlyMap<string, ReadonlyMap<string, unknown>> = new Map(),
): CacheStorageHarness {
  const names = new Set([...cacheNames, ...responses.keys()]);
  return {
    cacheNames: names,
    responses: new Map([...names].map((name) => [name, new Map(responses.get(name) ?? new Map())])),
    deleted: [],
    opened: [],
    matched: [],
  };
}

function workerHarness(scope: string, storage: CacheStorageHarness): WorkerHarness {
  const source = readFileSync(new URL('../public/sw.js', import.meta.url), 'utf8');
  const listeners = new Map<string, WorkerListener>();
  const added: string[] = [];
  const cacheFor = (name: string) => {
    if (!storage.responses.has(name)) storage.responses.set(name, new Map());
    const responses = storage.responses.get(name)!;
    return {
      add: vi.fn(async (value: string) => {
        added.push(value);
      }),
      match: vi.fn(async (value: string | { url: string }) => {
        const url = typeof value === 'string' ? value : value.url;
        storage.matched.push({ cacheName: name, url });
        return responses.get(url);
      }),
      put: vi.fn(async (value: string, response: unknown) => {
        responses.set(value, response);
      }),
    };
  };
  const scopeUrl = new URL(scope);
  vm.runInContext(
    source,
    vm.createContext({
      URL,
      Response,
      console,
      fetch: vi.fn(async () => {
        throw new Error('Unexpected network fetch in service-worker unit test.');
      }),
      self: {
        registration: { scope },
        location: { origin: scopeUrl.origin },
        addEventListener: (name: string, listener: WorkerListener) => listeners.set(name, listener),
        clients: { claim: vi.fn(async () => undefined) },
        skipWaiting: vi.fn(),
      },
      caches: {
        keys: vi.fn(async () => [...storage.cacheNames]),
        delete: vi.fn(async (name: string) => {
          storage.cacheNames.delete(name);
          storage.responses.delete(name);
          storage.deleted.push(name);
          return true;
        }),
        open: vi.fn(async (name: string) => {
          storage.cacheNames.add(name);
          storage.opened.push(name);
          return cacheFor(name);
        }),
      },
    }),
  );
  return { added, deleted: storage.deleted, listeners, opened: storage.opened };
}

function waitForEvent(
  listener: WorkerListener | undefined,
  event: Record<string, unknown> = {},
): Promise<unknown> {
  let pending: Promise<unknown> | undefined;
  listener?.({
    ...event,
    waitUntil(value: Promise<unknown>) {
      pending = value;
    },
  });
  expect(pending).toBeDefined();
  return pending!;
}

describe('service worker cache isolation', () => {
  test('sequential activation deletes only obsolete caches from each app scope', async () => {
    const storage = cacheStorageHarness([
      'other-app-cache',
      'comblang-shell-v6',
      'comblang-shell:%2Fa%2F:v6',
      'comblang-shell:%2Fa%2F:v7',
      'comblang-shell:%2Fb%2F:v6',
      'comblang-shell:%2Fb%2F:v7',
    ]);
    const a = workerHarness('https://example.test/a/', storage);
    await waitForEvent(a.listeners.get('activate'));
    expect(storage.deleted).toEqual(['comblang-shell:%2Fa%2F:v6']);

    const b = workerHarness('https://example.test/b/', storage);
    await waitForEvent(b.listeners.get('activate'));

    expect(storage.deleted).toEqual(['comblang-shell:%2Fa%2F:v6', 'comblang-shell:%2Fb%2F:v6']);
    expect(storage.cacheNames).toEqual(
      new Set([
        'other-app-cache',
        'comblang-shell-v6',
        'comblang-shell:%2Fa%2F:v7',
        'comblang-shell:%2Fb%2F:v7',
      ]),
    );
  });

  test('warm-up accepts only resources inside the registered scope', async () => {
    const harness = workerHarness('https://example.test/a/', cacheStorageHarness([]));

    await waitForEvent(harness.listeners.get('message'), {
      data: {
        type: 'warm-cache',
        urls: [
          'https://example.test/a/',
          'https://example.test/a/assets/index.js',
          'https://example.test/b/assets/index.js',
          'https://other.test/a/assets/index.js',
          'http://[',
        ],
      },
    });

    expect(harness.opened).toEqual(['comblang-shell:%2Fa%2F:v7']);
    expect(harness.added).toEqual([
      'https://example.test/a/',
      'https://example.test/a/assets/index.js',
    ]);
  });

  test('fetch reads only the current scope cache and ignores outside requests', async () => {
    const cached = { source: 'scope-cache' };
    const resource = 'https://example.test/a/assets/index.js';
    const storage = cacheStorageHarness(
      [],
      new Map([['comblang-shell:%2Fa%2F:v7', new Map([[resource, cached]])]]),
    );
    const harness = workerHarness('https://example.test/a/', storage);
    let response: Promise<unknown> | undefined;

    harness.listeners.get('fetch')?.({
      request: { method: 'GET', mode: 'cors', url: resource },
      respondWith(value: Promise<unknown>) {
        response = value;
      },
    });

    expect(await response).toBe(cached);
    expect(harness.opened).toEqual(['comblang-shell:%2Fa%2F:v7']);

    response = undefined;
    harness.listeners.get('fetch')?.({
      request: { method: 'GET', mode: 'cors', url: 'https://example.test/b/index.js' },
      respondWith(value: Promise<unknown>) {
        response = value;
      },
    });
    expect(response).toBeUndefined();
  });

  test('offline navigation falls back to the shell from its own scope', async () => {
    const shell = 'https://example.test/a/';
    const aCache = 'comblang-shell:%2Fa%2F:v7';
    const bCache = 'comblang-shell:%2Fb%2F:v7';
    const aShell = { scope: 'a' };
    const bShell = { scope: 'b' };
    const storage = cacheStorageHarness(
      [aCache, bCache],
      new Map([
        [aCache, new Map([[shell, aShell]])],
        [bCache, new Map([[shell, bShell]])],
      ]),
    );
    const harness = workerHarness('https://example.test/a/', storage);
    let response: Promise<unknown> | undefined;

    harness.listeners.get('fetch')?.({
      request: { method: 'GET', mode: 'navigate', url: 'https://example.test/a/page' },
      respondWith(value: Promise<unknown>) {
        response = value;
      },
    });

    expect(await response).toBe(aShell);
    expect(storage.opened).toEqual([aCache]);
    expect(storage.matched).toEqual([{ cacheName: aCache, url: shell }]);
  });
});

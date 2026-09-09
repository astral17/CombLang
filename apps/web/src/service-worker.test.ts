import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { describe, expect, test, vi } from 'vitest';

import type { ShellManifest } from './shell-manifest.js';

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
  readonly skipWaiting: ReturnType<typeof vi.fn>;
}

const defaultManifest: ShellManifest = {
  version: 1,
  identity: 'v1',
  resources: [
    './index.html',
    './assets/index.css',
    './assets/index.js',
    './assets/parser.worker-v1.js',
    './assets/test.worker-v1.js',
  ],
};

function cacheName(scope: string, identity: string): string {
  const path = new URL(new URL('./', scope)).pathname;
  return `comblang-shell:${encodeURIComponent(path)}:build:${identity}`;
}

function absoluteResources(scope: string, manifest: ShellManifest): string[] {
  return manifest.resources.map((resource) => new URL(resource, new URL('./', scope)).href);
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

function workerHarness(
  scope: string,
  storage: CacheStorageHarness,
  options: {
    readonly failures?: ReadonlySet<string>;
    readonly manifest?: ShellManifest;
    readonly network?: ReadonlyMap<string, unknown>;
  } = {},
): WorkerHarness {
  const manifest = options.manifest ?? defaultManifest;
  const source = readFileSync(new URL('../public/sw.js', import.meta.url), 'utf8').replace(
    'const SHELL_MANIFEST = null;',
    `const SHELL_MANIFEST = ${JSON.stringify(manifest)};`,
  );
  const listeners = new Map<string, WorkerListener>();
  const added: string[] = [];
  const skipWaiting = vi.fn();
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
      fetch: vi.fn(async (input: string | { url: string }) => {
        const url = typeof input === 'string' ? input : input.url;
        if (options.failures?.has(url)) throw new Error(`Network failure for ${url}`);
        const response = options.network?.get(url);
        if (response === undefined) {
          throw new Error('Unexpected network fetch in service-worker unit test.');
        }
        return { ok: true, clone: () => response };
      }),
      self: {
        registration: { scope },
        location: { origin: scopeUrl.origin },
        addEventListener: (name: string, listener: WorkerListener) => listeners.set(name, listener),
        clients: { claim: vi.fn(async () => undefined) },
        skipWaiting,
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
  return { added, deleted: storage.deleted, listeners, opened: storage.opened, skipWaiting };
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
    const aCurrent = cacheName('https://example.test/a/', 'v1');
    const bCurrent = cacheName('https://example.test/b/', 'v1');
    const storage = cacheStorageHarness([
      'other-app-cache',
      'comblang-shell-v6',
      'comblang-shell:%2Fa%2F:build:v0',
      aCurrent,
      'comblang-shell:%2Fb%2F:build:v0',
      bCurrent,
    ]);
    const a = workerHarness('https://example.test/a/', storage);
    await waitForEvent(a.listeners.get('activate'));
    expect(storage.deleted).toEqual(['comblang-shell:%2Fa%2F:build:v0']);

    const b = workerHarness('https://example.test/b/', storage);
    await waitForEvent(b.listeners.get('activate'));

    expect(storage.deleted).toEqual([
      'comblang-shell:%2Fa%2F:build:v0',
      'comblang-shell:%2Fb%2F:build:v0',
    ]);
    expect(storage.cacheNames).toEqual(
      new Set(['other-app-cache', 'comblang-shell-v6', aCurrent, bCurrent]),
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

    expect(harness.opened).toEqual([cacheName('https://example.test/a/', 'v1')]);
    expect(harness.added).toEqual([
      'https://example.test/a/',
      'https://example.test/a/assets/index.js',
    ]);
  });

  test('fetch reads only the current scope cache and ignores outside requests', async () => {
    const cached = { source: 'scope-cache' };
    const resource = 'https://example.test/a/assets/index.js';
    const current = cacheName('https://example.test/a/', 'v1');
    const storage = cacheStorageHarness([], new Map([[current, new Map([[resource, cached]])]]));
    const harness = workerHarness('https://example.test/a/', storage);
    let response: Promise<unknown> | undefined;

    harness.listeners.get('fetch')?.({
      request: { method: 'GET', mode: 'cors', url: resource },
      respondWith(value: Promise<unknown>) {
        response = value;
      },
    });

    expect(await response).toBe(cached);
    expect(harness.opened).toEqual([current]);

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
    const aCache = cacheName('https://example.test/a/', 'v1');
    const bCache = cacheName('https://example.test/b/', 'v1');
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

  test('installs the exact shell only after every resource succeeds', async () => {
    const scope = 'https://example.test/CombLang/';
    const manifest = { ...defaultManifest, identity: 'release-1' } as const;
    const resources = absoluteResources(scope, manifest);
    const network = new Map(resources.map((url) => [url, { url }]));
    const storage = cacheStorageHarness([]);
    const harness = workerHarness(scope, storage, { manifest, network });

    await waitForEvent(harness.listeners.get('install'));

    const current = cacheName(scope, manifest.identity);
    expect(storage.cacheNames).toEqual(new Set([current]));
    expect(harness.skipWaiting).not.toHaveBeenCalled();
    expect([...storage.responses.get(current)!.keys()].sort()).toEqual(
      [scope, ...resources].sort(),
    );
  });

  test('failed update keeps the previous build and removes the failed candidate', async () => {
    const scope = 'https://example.test/CombLang/';
    const first = { ...defaultManifest, identity: 'release-1' } as const;
    const second = { ...defaultManifest, identity: 'release-2' } as const;
    const firstStorage = cacheStorageHarness([]);
    const firstHarness = workerHarness(scope, firstStorage, {
      manifest: first,
      network: new Map(absoluteResources(scope, first).map((url) => [url, { url }])),
    });
    await waitForEvent(firstHarness.listeners.get('install'));
    const firstCache = cacheName(scope, first.identity);

    const secondResources = absoluteResources(scope, second);
    const failureUrl = secondResources.at(-1)!;
    const secondHarness = workerHarness(scope, firstStorage, {
      manifest: second,
      failures: new Set([failureUrl]),
      network: new Map(secondResources.map((url) => [url, { url }])),
    });
    await expect(waitForEvent(secondHarness.listeners.get('install'))).rejects.toThrow(
      'Network failure',
    );

    expect(firstStorage.cacheNames).toEqual(new Set([firstCache]));
    expect(firstStorage.deleted).toEqual([]);
    expect(firstStorage.opened).toEqual([firstCache]);
  });

  test('failed retry leaves a complete same-identity cache untouched', async () => {
    const scope = 'https://example.test/CombLang/';
    const manifest = { ...defaultManifest, identity: 'release-1' } as const;
    const resources = absoluteResources(scope, manifest);
    const storage = cacheStorageHarness([]);
    const firstHarness = workerHarness(scope, storage, {
      manifest,
      network: new Map(resources.map((url) => [url, { url, version: 1 }])),
    });
    await waitForEvent(firstHarness.listeners.get('install'));
    const current = cacheName(scope, manifest.identity);
    const before = new Map(storage.responses.get(current)!);

    const failureUrl = resources[0]!;
    const retryHarness = workerHarness(scope, storage, {
      manifest,
      failures: new Set([failureUrl]),
      network: new Map(resources.map((url) => [url, { url, version: 2 }])),
    });
    await expect(waitForEvent(retryHarness.listeners.get('install'))).rejects.toThrow(
      'Network failure',
    );

    expect(storage.cacheNames).toEqual(new Set([current]));
    expect(storage.responses.get(current)).toEqual(before);
    expect(storage.opened).toEqual([current]);
  });

  test('successful update activates the new build and cleans only owned old caches', async () => {
    const scope = 'https://example.test/CombLang/';
    const first = { ...defaultManifest, identity: 'release-1' } as const;
    const second = { ...defaultManifest, identity: 'release-2' } as const;
    const storage = cacheStorageHarness(['foreign-cache']);
    const firstHarness = workerHarness(scope, storage, {
      manifest: first,
      network: new Map(absoluteResources(scope, first).map((url) => [url, { url }])),
    });
    await waitForEvent(firstHarness.listeners.get('install'));
    const secondHarness = workerHarness(scope, storage, {
      manifest: second,
      network: new Map(absoluteResources(scope, second).map((url) => [url, { url }])),
    });
    await waitForEvent(secondHarness.listeners.get('install'));
    expect(storage.cacheNames).toEqual(
      new Set([
        'foreign-cache',
        cacheName(scope, first.identity),
        cacheName(scope, second.identity),
      ]),
    );
    expect(secondHarness.skipWaiting).not.toHaveBeenCalled();
    await waitForEvent(secondHarness.listeners.get('activate'));

    expect(storage.cacheNames).toEqual(
      new Set(['foreign-cache', cacheName(scope, second.identity)]),
    );
    expect(storage.deleted).toContain(cacheName(scope, first.identity));
  });

  test('pre-cached shell resources serve offline main, CSS, compiler Worker, and test Worker', async () => {
    const scope = 'https://example.test/a/';
    const manifest = { ...defaultManifest, identity: 'release-1' } as const;
    const resources = absoluteResources(scope, manifest);
    const responses = new Map(resources.map((url) => [url, { url }]));
    const storage = cacheStorageHarness(
      [cacheName(scope, manifest.identity)],
      new Map([[cacheName(scope, manifest.identity), responses]]),
    );
    const harness = workerHarness(scope, storage, { manifest });

    for (const url of resources.filter((value) => !value.endsWith('index.html'))) {
      let response: Promise<unknown> | undefined;
      harness.listeners.get('fetch')?.({
        request: { method: 'GET', mode: 'cors', url },
        respondWith(value: Promise<unknown>) {
          response = value;
        },
      });
      expect(await response).toEqual({ url });
    }
  });
});

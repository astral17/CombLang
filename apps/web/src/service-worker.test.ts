import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { describe, expect, test, vi } from 'vitest';

type WorkerListener = (event: Record<string, unknown>) => void;

interface WorkerHarness {
  readonly added: string[];
  readonly deleted: string[];
  readonly listeners: Map<string, WorkerListener>;
  readonly opened: string[];
}

function workerHarness(
  scope: string,
  cacheNames: readonly string[],
  cachedResponses: ReadonlyMap<string, unknown> = new Map(),
): WorkerHarness {
  const source = readFileSync(new URL('../public/sw.js', import.meta.url), 'utf8');
  const listeners = new Map<string, WorkerListener>();
  const deleted: string[] = [];
  const opened: string[] = [];
  const added: string[] = [];
  const cache = {
    add: vi.fn(async (value: string) => {
      added.push(value);
    }),
    match: vi.fn(async (value: string | { url: string }) =>
      cachedResponses.get(typeof value === 'string' ? value : value.url),
    ),
    put: vi.fn(async () => undefined),
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
        keys: vi.fn(async () => [...cacheNames]),
        delete: vi.fn(async (name: string) => {
          deleted.push(name);
          return true;
        }),
        open: vi.fn(async (name: string) => {
          opened.push(name);
          return cache;
        }),
      },
    }),
  );
  return { added, deleted, listeners, opened };
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
  test('activation deletes only obsolete caches from the current app scope', async () => {
    const harness = workerHarness('https://example.test/a/', [
      'other-app-cache',
      'comblang-shell-v6',
      'comblang-shell:%2Fa%2F:v6',
      'comblang-shell:%2Fa%2F:v7',
      'comblang-shell:%2Fb%2F:v6',
    ]);

    await waitForEvent(harness.listeners.get('activate'));

    expect(harness.deleted).toEqual(['comblang-shell:%2Fa%2F:v6']);
  });

  test('warm-up accepts only resources inside the registered scope', async () => {
    const harness = workerHarness('https://example.test/a/', []);

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
    const harness = workerHarness('https://example.test/a/', [], new Map([[resource, cached]]));
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
});

const APP_SHELL_URL = new URL('./', self.registration.scope).href;
const APP_SCOPE_PATH = new URL(APP_SHELL_URL).pathname;
const CACHE_NAMESPACE = `comblang-shell:${encodeURIComponent(APP_SCOPE_PATH)}:`;
const SHELL_MANIFEST = null;

function cacheName() {
  if (SHELL_MANIFEST === null) throw new Error('Service Worker shell manifest is not injected.');
  return `${CACHE_NAMESPACE}build:${SHELL_MANIFEST.identity}`;
}

function isWithinAppScope(value) {
  const url = new URL(value, APP_SHELL_URL);
  return url.origin === self.location.origin && url.href.startsWith(APP_SHELL_URL);
}

function shellResourceUrls() {
  if (SHELL_MANIFEST === null) throw new Error('Service Worker shell manifest is not injected.');
  return SHELL_MANIFEST.resources.map((resource) => {
    const url = new URL(resource, APP_SHELL_URL);
    if (!isWithinAppScope(url) || url.search || url.hash) {
      throw new Error(`Invalid shell resource ${resource}`);
    }
    return url.href;
  });
}

async function fetchShellResource(url) {
  const response = await fetch(url, { cache: 'no-cache' });
  if (!response.ok) throw new Error(`Cannot cache ${url}: HTTP ${response.status}`);
  return response;
}

async function precacheApplication() {
  const currentCacheName = cacheName();
  const fetched = [];
  for (const url of shellResourceUrls()) {
    fetched.push({ url, response: await fetchShellResource(url) });
  }
  const cache = await caches.open(currentCacheName);
  for (const { url, response } of fetched) {
    await cache.put(url, response.clone());
    if (url.endsWith('/index.html')) await cache.put(APP_SHELL_URL, response.clone());
  }
}

// Keep a new worker waiting so existing pages can continue using old hashed assets.
self.addEventListener('install', (event) => {
  event.waitUntil(precacheApplication());
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    Promise.all([
      caches
        .keys()
        .then((keys) =>
          Promise.all(
            keys
              .filter((key) => key.startsWith(CACHE_NAMESPACE) && key !== cacheName())
              .map((key) => caches.delete(key)),
          ),
        ),
      self.clients.claim(),
    ]),
  );
});

self.addEventListener('message', (event) => {
  if (event.data?.type !== 'warm-cache' || !Array.isArray(event.data.urls)) return;
  const urls = event.data.urls.filter((value) => {
    if (typeof value !== 'string') return false;
    try {
      const url = new URL(value, APP_SHELL_URL);
      return (
        isWithinAppScope(url) &&
        (url.href === APP_SHELL_URL || shellResourceUrls().includes(url.href))
      );
    } catch {
      return false;
    }
  });
  event.waitUntil(
    caches.open(cacheName()).then((cache) =>
      Promise.allSettled(
        urls.map(async (url) => {
          if ((await cache.match(url)) === undefined) await cache.add(url);
        }),
      ),
    ),
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (!isWithinAppScope(url)) return;

  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((response) => {
          if (!response.ok) return response;
          const cachedResponse = response.clone();
          return caches
            .open(cacheName())
            .then((cache) => cache.put(APP_SHELL_URL, cachedResponse))
            .then(() => response);
        })
        .catch(() =>
          caches
            .open(cacheName())
            .then((cache) => cache.match(APP_SHELL_URL))
            .then((response) => response ?? Response.error()),
        ),
    );
    return;
  }

  event.respondWith(
    caches.open(cacheName()).then(async (cache) => {
      const cached = await cache.match(request);
      if (cached !== undefined) return cached;
      const response = await fetch(request);
      if (!response.ok) return response;
      await cache.put(request, response.clone());
      return response;
    }),
  );
});

const CACHE_NAME = 'comblang-shell-v6';
const APP_SHELL_URL = new URL('./', self.registration.scope).href;

async function fetchAndCache(cache, url) {
  const response = await fetch(url, { cache: 'no-cache' });
  if (!response.ok) throw new Error(`Cannot cache ${url}: HTTP ${response.status}`);
  await cache.put(url, response.clone());
  return response;
}

async function precacheApplication() {
  const cache = await caches.open(CACHE_NAME);
  const shellResponse = await fetchAndCache(cache, APP_SHELL_URL);
  const html = await shellResponse.text();
  const assetUrls = [...html.matchAll(/(?:src|href)=["']([^"']+)["']/g)].map(
    (match) => new URL(match[1], APP_SHELL_URL).href,
  );

  const assetResponses = await Promise.all(
    assetUrls.map(async (url) => ({ url, response: await fetchAndCache(cache, url) })),
  );
  const nestedAssets = new Set();
  for (const { url, response } of assetResponses) {
    if (!url.endsWith('.js')) continue;
    const javaScript = await response.text();
    for (const match of javaScript.matchAll(
      /["']([^"']*(?:parser|test)\.worker-[\w-]+\.js)["']/g,
    )) {
      const nestedUrl = new URL(match[1], url);
      if (nestedUrl.origin === self.location.origin) nestedAssets.add(nestedUrl.href);
    }
  }
  await Promise.all([...nestedAssets].map((url) => fetchAndCache(cache, url)));
}

self.addEventListener('install', (event) => {
  event.waitUntil(precacheApplication());
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    Promise.all([
      caches
        .keys()
        .then((keys) =>
          Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))),
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
      return new URL(value).origin === self.location.origin;
    } catch {
      return false;
    }
  });
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) =>
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
  if (url.origin !== self.location.origin) return;

  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((response) => {
          if (!response.ok) return response;
          const cachedResponse = response.clone();
          return caches
            .open(CACHE_NAME)
            .then((cache) => cache.put(APP_SHELL_URL, cachedResponse))
            .then(() => response);
        })
        .catch(() => caches.match(APP_SHELL_URL).then((response) => response ?? Response.error())),
    );
    return;
  }

  event.respondWith(
    caches.match(request).then((cached) => {
      if (cached !== undefined) return cached;
      return fetch(request).then((response) => {
        if (!response.ok) return response;
        const cachedResponse = response.clone();
        return caches
          .open(CACHE_NAME)
          .then((cache) => cache.put(request, cachedResponse))
          .then(() => response);
      });
    }),
  );
});

function browserStorageBase(baseUrl: string, documentUrl: string): URL {
  return new URL(baseUrl, documentUrl);
}

export function serviceWorkerUrl(baseUrl: string, documentUrl: string): string {
  return new URL('sw.js', browserStorageBase(baseUrl, documentUrl)).href;
}

function cacheableResourceUrls(baseUrl: string): string[] {
  const appBase = browserStorageBase(baseUrl, document.baseURI).href;
  const urls = new Set<string>([appBase, window.location.href]);
  for (const entry of performance.getEntriesByType('resource')) {
    try {
      const url = new URL(entry.name);
      if (url.origin === window.location.origin) urls.add(url.href);
    } catch {
      // Resource Timing can contain implementation-specific names.
    }
  }
  return [...urls];
}

export function warmOfflineCache(): void {
  if (!import.meta.env.PROD || !('serviceWorker' in navigator)) return;
  void navigator.serviceWorker.ready
    .then((registration) => {
      registration.active?.postMessage({
        type: 'warm-cache',
        urls: cacheableResourceUrls(import.meta.env.BASE_URL),
      });
    })
    .catch((error) => {
      console.warn('CombLang offline cache warm-up failed.', error);
    });
}

export function registerOfflineSupport(): void {
  if (!import.meta.env.PROD || !('serviceWorker' in navigator)) return;

  window.addEventListener(
    'load',
    () => {
      void navigator.serviceWorker
        .register(serviceWorkerUrl(import.meta.env.BASE_URL, document.baseURI))
        .then(() => warmOfflineCache())
        .catch((error) => {
          console.warn('CombLang offline support could not be registered.', error);
        });
    },
    { once: true },
  );
}

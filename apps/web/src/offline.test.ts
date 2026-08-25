import { describe, expect, it } from 'vitest';

import { serviceWorkerUrl } from './offline.js';

describe('offline deployment paths', () => {
  it('keeps the service worker inside a GitHub Pages project directory', () => {
    expect(serviceWorkerUrl('./', 'https://example.test/CombLang/')).toBe(
      'https://example.test/CombLang/sw.js',
    );
  });

  it('resolves relative to the document directory even with index.html present', () => {
    expect(serviceWorkerUrl('./', 'https://example.test/CombLang/index.html')).toBe(
      'https://example.test/CombLang/sw.js',
    );
  });
});

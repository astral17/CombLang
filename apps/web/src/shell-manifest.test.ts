import { describe, expect, test } from 'vitest';
import type { OutputBundle } from 'rollup';

import {
  assertInjectedShellManifest,
  createShellManifest,
  injectShellManifest,
  shellManifestPlaceholder,
} from './shell-manifest.js';

function bundle(mainSource = 'new URL("parser.worker-a.js", import.meta.url);') {
  return {
    'index.html': {
      type: 'asset',
      fileName: 'index.html',
      name: 'index.html',
      source:
        '<script type="module" src="./assets/main-a.js"></script><link rel="stylesheet" href="./assets/main-a.css">',
    },
    'assets/main-a.js': {
      type: 'chunk',
      fileName: 'assets/main-a.js',
      name: 'main-a',
      isEntry: true,
      isDynamicEntry: false,
      facadeModuleId: 'apps/web/index.html',
      moduleIds: ['apps/web/src/main.ts'],
      exports: [],
      imports: [],
      dynamicImports: [],
      implicitlyLoadedBefore: [],
      code: `${mainSource} new URL("test.worker-a.js", import.meta.url); new URL("./assets/space-age.json", import.meta.url); new URL("./assets/space-age.json.manifest.json", import.meta.url);`,
      map: null,
    },
    'assets/main-a.css': {
      type: 'asset',
      fileName: 'assets/main-a.css',
      name: 'main-a.css',
      source: 'body { color: black; }',
    },
    'assets/space-age.json': {
      type: 'asset',
      fileName: 'assets/space-age.json',
      name: 'space-age.json',
      source: '{"database":"payload-a"}',
    },
    'assets/space-age.json.manifest.json': {
      type: 'asset',
      fileName: 'assets/space-age.json.manifest.json',
      name: 'space-age.json.manifest.json',
      source: '{"outputSha256":"digest-a"}',
    },
    'assets/parser.worker-a.js': {
      type: 'chunk',
      fileName: 'assets/parser.worker-a.js',
      name: 'parser.worker-a',
      isEntry: true,
      isDynamicEntry: false,
      facadeModuleId: 'apps/web/src/parser.worker.ts',
      moduleIds: ['apps/web/src/parser.worker.ts'],
      exports: [],
      imports: [],
      dynamicImports: [],
      implicitlyLoadedBefore: [],
      code: 'self.onmessage = () => undefined;',
      map: null,
    },
    'assets/test.worker-a.js': {
      type: 'chunk',
      fileName: 'assets/test.worker-a.js',
      name: 'test.worker-a',
      isEntry: true,
      isDynamicEntry: false,
      facadeModuleId: 'apps/web/src/test.worker.ts',
      moduleIds: ['apps/web/src/test.worker.ts'],
      exports: [],
      imports: [],
      dynamicImports: [],
      implicitlyLoadedBefore: [],
      code: 'self.onmessage = () => undefined;',
      map: null,
    },
    'assets/unrelated.js': {
      type: 'chunk',
      fileName: 'assets/unrelated.js',
      name: 'unrelated',
      isEntry: false,
      isDynamicEntry: false,
      facadeModuleId: null,
      moduleIds: [],
      exports: [],
      imports: [],
      dynamicImports: [],
      implicitlyLoadedBefore: [],
      code: 'console.log("unrelated");',
      map: null,
    },
    'assets/main-a.js.map': {
      type: 'asset',
      fileName: 'assets/main-a.js.map',
      name: 'main-a.js.map',
      source: '{}',
    },
  } as unknown as OutputBundle;
}

describe('production shell manifest', () => {
  const workerTemplate = 'service-worker-policy-v1';

  test('selects the HTML shell, referenced assets, and reachable compiler/test workers', () => {
    const manifest = createShellManifest(bundle(), workerTemplate);

    expect(manifest.resources).toEqual([
      './assets/main-a.css',
      './assets/main-a.js',
      './assets/parser.worker-a.js',
      './assets/space-age.json',
      './assets/space-age.json.manifest.json',
      './assets/test.worker-a.js',
      './index.html',
    ]);
    expect(manifest.resources).not.toContain('./assets/unrelated.js');
    expect(manifest.resources).not.toContain('./assets/main-a.js.map');
    expect(manifest.identity).toMatch(/^comblang-shell-sha256:[0-9a-f]{64}$/);
    expect(manifest.resources.every((resource) => resource.startsWith('./'))).toBe(true);
  });

  test('identity changes when emitted content changes and remains stable for the same bundle', () => {
    const first = createShellManifest(bundle(), workerTemplate);
    const same = createShellManifest(bundle(), workerTemplate);
    const changed = createShellManifest(
      bundle('new URL("parser.worker-b.js", import.meta.url);'),
      workerTemplate,
    );

    expect(same).toEqual(first);
    expect(changed.identity).not.toBe(first.identity);
  });

  test.each(['assets/space-age.json', 'assets/space-age.json.manifest.json'])(
    'identity changes when referenced emitted asset %s changes',
    (fileName) => {
      const first = createShellManifest(bundle(), workerTemplate);
      const changedBundle = bundle();
      (changedBundle[fileName] as { source: string }).source = '{"changed":true}';
      const changed = createShellManifest(changedBundle, workerTemplate);

      expect(changed.identity).not.toBe(first.identity);
    },
  );

  test('identity changes when only the Service Worker policy changes', () => {
    const first = createShellManifest(bundle(), workerTemplate);
    const changed = createShellManifest(bundle(), 'service-worker-policy-v2');

    expect(changed.identity).not.toBe(first.identity);
  });

  test('injects resolved metadata and rejects an incomplete Service Worker template', () => {
    const manifest = createShellManifest(bundle(), workerTemplate);
    const source = `const SHELL_MANIFEST = null;\n${manifest.resources.join('\n')}`;
    const rendered = injectShellManifest(source, manifest);

    expect(rendered).not.toContain(shellManifestPlaceholder);
    expect(rendered).toContain(manifest.identity);
    expect(() => assertInjectedShellManifest(rendered, manifest)).not.toThrow();
    expect(() => injectShellManifest('const OTHER = null;', manifest)).toThrow('placeholder');
  });
});

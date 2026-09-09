import { readdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { defineConfig } from 'vite';

import {
  assertInjectedShellManifest,
  createShellManifest,
  injectShellManifest,
  type ShellManifest,
} from './src/shell-manifest.js';

async function emittedOutputBundle(
  outputDirectory: string,
): Promise<import('rollup').OutputBundle> {
  const entries: Record<string, unknown> = {};
  async function visit(directory: string, prefix: string): Promise<void> {
    const files = await readdir(directory, { withFileTypes: true });
    for (const file of files) {
      const fileName = `${prefix}${file.name}`.replaceAll('\\', '/');
      const path = resolve(directory, file.name);
      if (file.isDirectory()) {
        await visit(path, `${fileName}/`);
        continue;
      }
      if (!file.isFile() || fileName === 'sw.js' || fileName.endsWith('.map')) continue;
      const source = await readFile(path);
      entries[fileName] = fileName.endsWith('.js')
        ? { type: 'chunk', fileName, code: source.toString('utf8') }
        : { type: 'asset', fileName, source };
    }
  }
  await visit(outputDirectory, '');
  return entries as import('rollup').OutputBundle;
}

function shellManifestPlugin() {
  let outputDirectory: string | undefined;
  let projectRoot: string | undefined;
  return {
    name: 'comblang-build-owned-shell-manifest',
    apply: 'build' as const,
    configResolved(config: { root: string; build: { outDir: string } }): void {
      projectRoot = config.root;
      outputDirectory = resolve(config.root, config.build.outDir);
    },
    async closeBundle(): Promise<void> {
      if (outputDirectory === undefined || projectRoot === undefined) {
        throw new Error('The production shell manifest was not generated.');
      }
      const bundle = await emittedOutputBundle(outputDirectory);
      const workerTemplate = await readFile(resolve(projectRoot, 'public/sw.js'), 'utf8');
      const manifest: ShellManifest = createShellManifest(bundle, workerTemplate);
      const workerPath = resolve(outputDirectory, 'sw.js');
      const source = await readFile(workerPath, 'utf8');
      await writeFile(workerPath, injectShellManifest(source, manifest), 'utf8');
      assertInjectedShellManifest(await readFile(workerPath, 'utf8'), manifest);
    },
  };
}

export default defineConfig({
  base: './',
  plugins: [shellManifestPlugin()],
  server: {
    host: '0.0.0.0',
    port: 5173,
    strictPort: true,
  },
  build: {
    assetsInlineLimit: 0,
    target: 'es2022',
  },
});

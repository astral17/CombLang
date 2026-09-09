import { createHash } from 'node:crypto';
import type { OutputAsset, OutputBundle, OutputChunk } from 'rollup';

export interface ShellManifest {
  readonly version: 1;
  readonly identity: string;
  readonly resources: readonly string[];
}

export const shellManifestPlaceholder = 'const SHELL_MANIFEST = null;';

function assetText(asset: OutputAsset): string {
  return typeof asset.source === 'string' ? asset.source : new TextDecoder().decode(asset.source);
}

function outputFileName(reference: string): string | undefined {
  if (
    reference.startsWith('data:') ||
    reference.startsWith('http:') ||
    reference.startsWith('https:') ||
    reference.startsWith('//')
  ) {
    return undefined;
  }
  try {
    const url = new URL(reference, 'https://comblang.invalid/');
    if (url.origin !== 'https://comblang.invalid' || url.pathname.includes('..')) {
      return undefined;
    }
    const fileName = url.pathname.replace(/^\/+/, '');
    return fileName.length === 0 || fileName.endsWith('.map') ? undefined : fileName;
  } catch {
    return undefined;
  }
}

function isJavaScriptChunk(entry: OutputBundle[string]): entry is OutputChunk {
  return entry.type === 'chunk' && entry.fileName.endsWith('.js');
}

function isCompilerWorkerChunk(entry: OutputChunk): boolean {
  return (
    entry.facadeModuleId?.endsWith('/parser.worker.ts') === true ||
    entry.facadeModuleId?.endsWith('/test.worker.ts') === true
  );
}

function bundleEntry(bundle: OutputBundle, fileName: string): OutputBundle[string] | undefined {
  return Object.values(bundle).find((entry) => entry.fileName === fileName);
}

function referencedJavaScriptChunks(
  bundle: OutputBundle,
  initialFiles: ReadonlySet<string>,
): Set<string> {
  const candidates = Object.values(bundle).filter(isJavaScriptChunk);
  const workerEntrypoints = candidates.filter(isCompilerWorkerChunk).map((entry) => entry.fileName);
  const selected = new Set<string>(
    [...initialFiles, ...workerEntrypoints].filter((fileName) =>
      candidates.some((entry) => entry.fileName === fileName),
    ),
  );
  const pending = [...selected];
  while (pending.length > 0) {
    const current = pending.shift()!;
    const currentEntry = bundleEntry(bundle, current);
    if (currentEntry?.type !== 'chunk') continue;
    for (const candidate of candidates) {
      if (selected.has(candidate.fileName) || candidate.fileName === current) continue;
      const basename = candidate.fileName.slice(candidate.fileName.lastIndexOf('/') + 1);
      if (currentEntry.code.includes(candidate.fileName) || currentEntry.code.includes(basename)) {
        selected.add(candidate.fileName);
        pending.push(candidate.fileName);
      }
    }
  }
  return selected;
}

function referencedOutputAssets(
  bundle: OutputBundle,
  javascriptFiles: ReadonlySet<string>,
): Set<string> {
  const chunks = [...javascriptFiles]
    .map((fileName) => bundleEntry(bundle, fileName))
    .filter((entry): entry is OutputChunk => entry?.type === 'chunk');
  return new Set(
    Object.values(bundle)
      .filter(
        (entry): entry is OutputAsset =>
          entry.type === 'asset' && entry.fileName !== 'sw.js' && !entry.fileName.endsWith('.map'),
      )
      .filter((asset) => {
        const basename = asset.fileName.slice(asset.fileName.lastIndexOf('/') + 1);
        return chunks.some(
          (chunk) => chunk.code.includes(asset.fileName) || chunk.code.includes(basename),
        );
      })
      .map((asset) => asset.fileName),
  );
}

function manifestMaterial(
  bundle: OutputBundle,
  resources: readonly string[],
  workerTemplate: string,
): string {
  return JSON.stringify({
    policy: workerTemplate,
    resources: resources.map((resource) => {
      const fileName = resource.slice(2);
      const entry = bundleEntry(bundle, fileName);
      if (entry === undefined) throw new Error(`Shell resource is not in the bundle: ${resource}`);
      const source = entry.type === 'asset' ? assetText(entry) : entry.code;
      return [resource, source];
    }),
  });
}

export function createShellManifest(bundle: OutputBundle, workerTemplate: string): ShellManifest {
  const index = bundleEntry(bundle, 'index.html');
  if (index?.type !== 'asset') throw new Error('The production bundle must emit index.html.');
  const html = assetText(index);
  const referenced = [...html.matchAll(/(?:src|href)=["']([^"']+)["']/g)]
    .map((match) => outputFileName(match[1]!))
    .filter(
      (fileName): fileName is string =>
        fileName !== undefined && bundleEntry(bundle, fileName) !== undefined,
    );
  const initialFiles = new Set(['index.html', ...referenced]);
  const javaScriptFiles = referencedJavaScriptChunks(bundle, initialFiles);
  const outputAssets = referencedOutputAssets(bundle, javaScriptFiles);
  const resources = [...new Set([...initialFiles, ...javaScriptFiles, ...outputAssets])]
    .filter((fileName) => !fileName.endsWith('.map'))
    .sort()
    .map((fileName) => `./${fileName}`);
  const identity = createHash('sha256')
    .update(manifestMaterial(bundle, resources, workerTemplate))
    .digest('hex');
  return Object.freeze({
    version: 1,
    identity: `comblang-shell-sha256:${identity}`,
    resources: Object.freeze(resources),
  });
}

export function injectShellManifest(source: string, manifest: ShellManifest): string {
  const occurrences = source.split(shellManifestPlaceholder).length - 1;
  if (occurrences !== 1) {
    throw new Error(
      `Expected one Service Worker shell manifest placeholder, found ${occurrences}.`,
    );
  }
  const rendered = source.replace(
    shellManifestPlaceholder,
    `const SHELL_MANIFEST = ${JSON.stringify(manifest)};`,
  );
  assertInjectedShellManifest(rendered, manifest);
  return rendered;
}

export function assertInjectedShellManifest(source: string, manifest: ShellManifest): void {
  if (source.includes(shellManifestPlaceholder)) {
    throw new Error('Emitted Service Worker still contains the shell manifest placeholder.');
  }
  if (source.includes(':v7')) {
    throw new Error('Emitted Service Worker still contains the manual v7 cache revision.');
  }
  if (!source.includes(JSON.stringify(manifest.identity))) {
    throw new Error('Emitted Service Worker does not contain the generated shell identity.');
  }
  for (const resource of manifest.resources) {
    if (!source.includes(JSON.stringify(resource))) {
      throw new Error(`Generated Service Worker does not reference shell resource ${resource}.`);
    }
  }
}

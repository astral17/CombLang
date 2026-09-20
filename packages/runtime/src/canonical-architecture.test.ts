import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';

function productionFiles(root: string): readonly string[] {
  const files: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) files.push(...productionFiles(path));
    else if (entry.isFile() && path.endsWith('.ts') && !path.endsWith('.test.ts')) files.push(path);
  }
  return files;
}

describe('canonical architecture boundary', () => {
  test('production sources contain no removed version-stack symbols or public models', () => {
    const roots = [
      resolve(fileURLToPath(new URL('../../compiler/src', import.meta.url))),
      resolve(fileURLToPath(new URL('.', import.meta.url))),
      resolve(fileURLToPath(new URL('../../../apps/cli/src', import.meta.url))),
      resolve(fileURLToPath(new URL('../../../apps/web/src', import.meta.url))),
    ];
    const forbidden = [
      /private-circuit-types/,
      /\blegacyPlan\b/,
      /\bproducerExecutionPlan\b/,
      /\btryElaborateEntityDirectPlan\b/,
      /\bvalidateEntityDirectPlan\b/,
      /\bPrivateDirect(?:Elaboration)?Plan\b/,
      /\b(?:Entity|Resolved(?:Entity|SourceCircuit))V[2-9]\b/,
    ];
    const violations: string[] = [];
    for (const root of roots) {
      for (const path of productionFiles(root)) {
        const source = readFileSync(path, 'utf8');
        for (const pattern of forbidden) {
          if (pattern.test(source)) violations.push(`${relative(process.cwd(), path)}: ${pattern}`);
        }
        if (/(?:direct-plan|ir|canonical-circuit|resolved-circuit)(?:-[^/\\]+)?\.ts$/i.test(path)) {
          if (/\bversion\s*:\s*[23]\b/.test(source))
            violations.push(`${relative(process.cwd(), path)}: numeric plan version construction`);
        }
        if (/\b(?:entity|resolved)-v[2-9](?:\.|$)/i.test(path))
          violations.push(`${relative(process.cwd(), path)}: removed versioned public file`);
      }
    }
    expect(violations).toEqual([]);
  });

  test('published workspace subpaths resolve to files', () => {
    const manifests = [
      resolve(fileURLToPath(new URL('../../compiler/package.json', import.meta.url))),
      resolve(fileURLToPath(new URL('../package.json', import.meta.url))),
    ];
    const missing: string[] = [];
    for (const manifestPath of manifests) {
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
        readonly exports?: Readonly<Record<string, unknown>>;
      };
      for (const [subpath, target] of Object.entries(manifest.exports ?? {})) {
        if (typeof target !== 'string' || !target.startsWith('./')) continue;
        if (!existsSync(resolve(dirname(manifestPath), target))) {
          missing.push(`${relative(process.cwd(), manifestPath)} ${subpath} -> ${target}`);
        }
      }
    }
    expect(missing).toEqual([]);
  });
});

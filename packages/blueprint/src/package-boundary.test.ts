import { readFile } from 'node:fs/promises';
import { describe, expect, test } from 'vitest';

import * as blueprint from './index.js';

describe('blueprint package boundary', () => {
  test('loads its public module without browser globals or platform initialization', () => {
    expect(blueprint.BLUEPRINT_EXCHANGE_MARKER).toBe('0');
    expect(blueprint.DEFAULT_BLUEPRINT_CODEC_LIMITS.maxJsonDepth).toBe(128);
  });

  test('keeps implementation imports browser-neutral and independent of compiler/runtime', async () => {
    const sourceFiles = [
      'classification.ts',
      'compression.ts',
      'document.ts',
      'errors.ts',
      'exchange.ts',
      'exchange-codec.ts',
      'index.ts',
      'limits.ts',
      'web-compression.ts',
    ];
    const source = (
      await Promise.all(
        sourceFiles.map((file) => readFile(new URL(`./${file}`, import.meta.url), 'utf8')),
      )
    ).join('\n');

    expect(source).not.toMatch(/from\s+['"]node:/);
    expect(source).not.toMatch(/@comblang\/(?:compiler|runtime|web|cli)\b/);
    expect(source).not.toMatch(/\b(?:window|document|navigator)(?!\.js\b)\s*(?:\.|\[|\()/);
    expect(source).not.toMatch(/\bJSON\.parse\s*\(/);

    const packageJson = JSON.parse(
      await readFile(new URL('../package.json', import.meta.url), 'utf8'),
    ) as { dependencies?: Record<string, string> };
    expect(packageJson.dependencies ?? {}).toEqual({});
  });

  test('exports the marker, streaming adapter and codec options', () => {
    const adapter: blueprint.BlueprintCompressionAdapter = {
      capabilities: { deflate: true },
      async *compress(chunks) {
        yield* chunks;
      },
      async *decompress(chunks) {
        yield* chunks;
      },
    };
    const options: blueprint.BlueprintCodecOptions = {
      compression: adapter,
      limits: { maxJsonDepth: 8 },
    };

    expect(options.compression?.capabilities.deflate).toBe(true);
    expect(blueprint.BLUEPRINT_EXCHANGE_MARKER).toBe('0');
  });
});

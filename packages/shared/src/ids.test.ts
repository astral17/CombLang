import { describe, expect, it } from 'vitest';

import { StableIdAllocator, normalizeProjectPath, sourceFileId } from './ids.js';

describe('stable IDs', () => {
  it('normalizes Windows and POSIX paths to the same source identity', () => {
    expect(sourceFileId('.\\src\\main.ts')).toBe(sourceFileId('./src/main.ts'));
    expect(normalizeProjectPath('')).toBe('<anonymous>');
  });

  it('allocates deterministic namespaced IDs', () => {
    const ids = new StableIdAllocator('network');
    expect([ids.allocate(), ids.allocate()]).toEqual(['network:1', 'network:2']);
  });
});

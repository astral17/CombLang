import { describe, expect, test } from 'vitest';

import type { CompilerWorkerRequest, CompilerWorkerResponse } from './worker-protocol.js';

function parsedRevision(response: CompilerWorkerResponse): number | undefined {
  return response.kind === 'parsed' ? response.revision : undefined;
}

describe('compiler Worker protocol', () => {
  test('keeps readiness as a payload-free control response', () => {
    const ready: CompilerWorkerResponse = { kind: 'ready' };

    expect(ready).toEqual({ kind: 'ready' });
    expect(Object.keys(ready)).toEqual(['kind']);
    expect(parsedRevision(ready)).toBeUndefined();
  });

  test('keeps progress cloneable and separate from parsed results', () => {
    const progress: CompilerWorkerResponse = {
      kind: 'progress',
      revision: 7,
      stage: 'transport',
    };

    expect(structuredClone(progress)).toEqual(progress);
    expect(parsedRevision(progress)).toBeUndefined();
  });

  test('keeps local parameter capture out of the source-only Worker request', () => {
    const request: CompilerWorkerRequest = {
      kind: 'parse',
      revision: 8,
      file: { path: 'worker-input.factorio.ts', text: 'const output = new Network();' },
    };

    expect(Object.keys(request)).toEqual(['kind', 'revision', 'file']);
    expect('parameters' in request).toBe(false);
    expect('session' in request).toBe(false);
    expect('arithmeticTemplates' in request).toBe(false);
    expect(structuredClone(request)).toEqual(request);
  });
});

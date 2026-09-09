import { describe, expect, test } from 'vitest';

import type { CompilerWorkerResponse } from './worker-protocol.js';

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
});

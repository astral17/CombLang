import { describe, expect, test } from 'vitest';
import { loadPrototypeDatabase, syntheticPrototypeDatabase } from '@comblang/prototypes';

import { CompilerWorkerRuntime, handleCompilerWorkerRequest } from './compiler-worker-request.js';
import type { CompilerWorkerRequest } from './worker-protocol.js';

const file = {
  path: 'main.factorio.ts',
  text: `if (prototypes.item['iron-plate'].stackSize !== 100) throw new Error('wrong profile');
const output = CC(prototypes.item['iron-plate'].stackSize * Signal('iron-plate'));`,
};

describe('browser compiler Worker prototype profile', () => {
  test('constructs the provider from cloneable JSON inside the request handler', async () => {
    const source = JSON.stringify(syntheticPrototypeDatabase());
    const { prototypes } = await loadPrototypeDatabase(syntheticPrototypeDatabase());
    const request: CompilerWorkerRequest = structuredClone({
      kind: 'parse',
      revision: 7,
      file,
      prototypeProfile: { source, expectedIdentity: prototypes.identity },
    });
    const response = await handleCompilerWorkerRequest(request);
    expect(structuredClone(response)).toMatchObject({
      kind: 'parsed',
      revision: 7,
      prototypeEnvironment: {
        identity: prototypes.identity,
        factorioVersion: '2.1.16',
        capabilities: prototypes.capabilities,
      },
      result: {
        compilerDiagnostics: [],
        plan: { producers: [{ kind: 'constant', outputs: [{ value: 100 }] }] },
      },
    });
    expect(request).not.toHaveProperty('prototypes');
  });

  test.each([
    { profile: { source: '{' }, code: 'PT1006' },
    { profile: { source: JSON.stringify({ schemaVersion: 99 }) }, code: 'PT1000' },
    {
      profile: { source: JSON.stringify(syntheticPrototypeDatabase()), expectedIdentity: 'wrong' },
      code: 'WP1001',
    },
  ])(
    'returns $code and never executes source for an invalid profile',
    async ({ profile, code }) => {
      const response = await handleCompilerWorkerRequest({
        kind: 'parse',
        revision: 1,
        file: { path: 'main.factorio.ts', text: `throw new Error('source executed');` },
        prototypeProfile: profile,
      });
      expect(response.prototypeEnvironment).toBeUndefined();
      expect(response.result.plan).toBeUndefined();
      expect(response.result.compilerDiagnostics).toEqual([
        expect.objectContaining({ code, severity: 'error' }),
      ]);
      expect(response.result.compilerDiagnostics[0]?.message).not.toContain('source executed');
    },
  );

  test('does not reuse a profile in a later unprofiled request', async () => {
    const source = JSON.stringify(syntheticPrototypeDatabase());
    expect(
      (
        await handleCompilerWorkerRequest({
          kind: 'parse',
          revision: 1,
          file,
          prototypeProfile: { source },
        })
      ).result.compilerDiagnostics,
    ).toEqual([]);
    expect(
      (
        await handleCompilerWorkerRequest({
          kind: 'parse',
          revision: 2,
          file,
        })
      ).result.compilerDiagnostics,
    ).toEqual([expect.objectContaining({ code: 'EX1004' })]);
  });

  test('reuses only an explicitly selected identity in one Worker and reports cache misses', async () => {
    const runtime = new CompilerWorkerRuntime();
    const first = await runtime.handle({
      kind: 'parse',
      revision: 1,
      file,
      prototypeProfile: { source: JSON.stringify(syntheticPrototypeDatabase()) },
    });
    const identity = first.prototypeEnvironment!.identity;
    expect(
      (
        await runtime.handle({
          kind: 'parse',
          revision: 2,
          file,
          prototypeProfile: structuredClone({ identity }),
        })
      ).result.compilerDiagnostics,
    ).toEqual([]);
    const missing = await new CompilerWorkerRuntime().handle({
      kind: 'parse',
      revision: 3,
      file,
      prototypeProfile: { identity },
    });
    expect(missing.result.compilerDiagnostics).toEqual([
      expect.objectContaining({
        code: 'WP1002',
        message: expect.stringContaining('send its database JSON again'),
      }),
    ]);
    expect(missing.prototypeEnvironment).toBeUndefined();
  });
});

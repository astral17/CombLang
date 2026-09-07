import { describe, expect, test } from 'vitest';
import { loadPrototypeDatabase, syntheticPrototypeDatabase } from '@comblang/prototypes';
import { syntheticZeroPortEntityProfile } from '@comblang/compiler/entity-fixtures';
import {
  createTrustedEntityReplayContext,
  entityReplayContextTransport,
} from '@comblang/compiler/entity-replay-context';

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
        compilerDiagnostics: [{ code: 'CL2001', severity: 'warning' }],
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
    ).toEqual([expect.objectContaining({ code: 'CL2001', severity: 'warning' })]);
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
    ).toEqual([expect.objectContaining({ code: 'CL2001', severity: 'warning' })]);
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

  test('round-trips the minimum v3 context and invalidates its cache identity', async () => {
    const trusted = createTrustedEntityReplayContext({
      database: syntheticZeroPortEntityProfile.ref.database,
      source: 'synthetic',
      evidenceIdentity: 'comblang-synthetic-evidence-v1',
      policyIdentity: 'comblang-entity-policy-v1',
      profiles: [syntheticZeroPortEntityProfile],
    });
    const entityReplayContext = entityReplayContextTransport(trusted);
    const response = await handleCompilerWorkerRequest(
      structuredClone({
        kind: 'parse',
        revision: 9,
        file: { path: 'main.factorio.ts', text: 'const output = new Network();' },
        entityReplayContext,
      }),
    );

    expect(structuredClone(response)).toMatchObject({
      kind: 'parsed',
      revision: 9,
      result: {
        entityReplayContext,
        entityReplayIdentity: expect.stringContaining('comblang-synthetic-evidence-v1'),
      },
    });
    expect(response.result).not.toHaveProperty('provider');
    expect(response.result).not.toHaveProperty('entityRegistry');
    expect(
      await handleCompilerWorkerRequest({
        kind: 'parse',
        revision: 10,
        file: { path: 'main.factorio.ts', text: 'const output = new Network();' },
        entityReplayContext: { ...entityReplayContext, evidenceIdentity: 'other-evidence' },
      }),
    ).toMatchObject({
      result: {
        entityReplayIdentity: expect.not.stringContaining('comblang-synthetic-evidence-v1'),
      },
    });
  });

  test('rejects an unbound provider replay context before Worker source execution', async () => {
    const loaded = await loadPrototypeDatabase(syntheticPrototypeDatabase());
    const profile = {
      ...structuredClone(syntheticZeroPortEntityProfile),
      ref: {
        ...syntheticZeroPortEntityProfile.ref,
        database: {
          schemaVersion: loaded.database.schemaVersion,
          identity: loaded.prototypes.identity,
        },
      },
    };
    const trusted = createTrustedEntityReplayContext({
      database: profile.ref.database,
      source: 'provider',
      evidenceIdentity: 'provider-evidence-v1',
      policyIdentity: 'provider-policy-v1',
      profiles: [profile],
    });
    const response = await handleCompilerWorkerRequest({
      kind: 'parse',
      revision: 10,
      file: { path: 'main.factorio.ts', text: `throw new Error('source executed');` },
      prototypeProfile: { source: JSON.stringify(syntheticPrototypeDatabase()) },
      entityReplayContext: entityReplayContextTransport(trusted),
    });

    expect(response.result.compilerDiagnostics[0]).toMatchObject({
      code: 'ER1001',
      severity: 'error',
    });
    expect(response.result.compilerDiagnostics[0]?.message).not.toContain('source executed');
  });

  test('rejects a non-cloneable or wrong-version v3 context before source execution', async () => {
    const response = await handleCompilerWorkerRequest({
      kind: 'parse',
      revision: 11,
      file: { path: 'main.factorio.ts', text: `throw new Error('source executed');` },
      entityReplayContext: {
        protocolVersion: 2,
        source: 'synthetic',
        database: { schemaVersion: 1, identity: 'db' },
        profileSetIdentity: 'profile-set' as never,
        evidenceIdentity: 'evidence',
        policyIdentity: 'policy',
      } as never,
    });
    expect(response.result.plan).toBeUndefined();
    expect(response.result.compilerDiagnostics[0]).toMatchObject({
      code: 'ER1000',
      severity: 'error',
      message: expect.stringContaining('protocolVersion'),
    });
    expect(response.result.compilerDiagnostics[0]?.message).not.toContain('source executed');
  });
});

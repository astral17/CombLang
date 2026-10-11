import { afterEach, describe, expect, test, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import { BlueprintImportAnalysisError } from '@comblang/blueprint/import-analysis';
import * as blueprintImportApi from '@comblang/runtime/blueprint-source-import';
import * as prototypeApi from '@comblang/prototypes';
import * as sourceCompilation from '@comblang/runtime/source-compilation';
import {
  createTrustedEntityReplayContext,
  entityReplayContextIdentity,
  entityReplayContextTransport,
  syntheticZeroPortEntityProfile,
} from '@comblang/compiler';
import type { EntityProfile, EntityProfileId } from '@comblang/compiler/entity';
import { loadPrototypeDatabase, syntheticPrototypeDatabase } from '@comblang/prototypes';
import { CompilerWorkerRuntime } from './compiler-worker-request.js';
import type { CompilerWorkerImportRequest } from './worker-protocol.js';

function arithmeticBehavior(signal: string, red: boolean, green: boolean) {
  return {
    arithmetic_conditions: {
      first_signal: { type: 'virtual', name: signal },
      first_signal_networks: { red, green },
      operation: '+',
      second_constant: 2,
      output_signal: { type: 'virtual', name: 'signal-B' },
    },
  };
}

function blueprintDocument(multiplier = '0.5') {
  return JSON.stringify({
    blueprint: {
      entities: [
        {
          entity_number: 12,
          name: 'arithmetic-combinator',
          position: { x: 0, y: 4 },
          direction: 4,
          control_behavior: {
            arithmetic_conditions: {
              first_signal: { type: 'virtual', name: 'signal-each' },
              first_signal_networks: { red: true, green: true },
              operation: '+',
              second_constant: 2,
              output_signal: { type: 'virtual', name: 'signal-each' },
            },
          },
        },
        {
          entity_number: 400,
          name: 'constant-combinator',
          position: { x: 8, y: -1 },
          direction: 15,
          control_behavior: {
            is_on: true,
            sections: {
              sections: [
                {
                  index: 1,
                  active: true,
                  multiplier: Number(multiplier),
                  filters: [
                    {
                      index: 1,
                      name: 'signal-A',
                      type: 'virtual',
                      quality: 'normal',
                      comparator: '=',
                      count: 7,
                    },
                  ],
                },
              ],
            },
          },
        },
        {
          entity_number: 11,
          name: 'arithmetic-combinator',
          position: { x: -2, y: 1 },
          direction: 0,
          control_behavior: { ...arithmeticBehavior('signal-A', true, false) },
        },
        {
          entity_number: 13,
          name: 'constant-combinator',
          position: { x: 7, y: 6 },
          direction: 8,
          control_behavior: {
            is_on: true,
            sections: {
              sections: [
                {
                  index: 1,
                  active: true,
                  multiplier: 0.5,
                  filters: [
                    {
                      index: 1,
                      name: 'signal-A',
                      type: 'virtual',
                      quality: 'normal',
                      comparator: '=',
                      count: 7,
                    },
                  ],
                },
              ],
            },
          },
        },
      ],
      wires: [
        [400, 1, 11, 1],
        [400, 1, 12, 1],
        [12, 3, 12, 1],
        [12, 4, 12, 2],
      ],
    },
  });
}

function builtinBlueprintDocument() {
  return JSON.stringify({
    blueprint: {
      entities: [
        {
          entity_number: 400,
          name: 'constant-combinator',
          position: { x: 8, y: -1 },
          direction: 15,
          control_behavior: {
            is_on: true,
            sections: {
              sections: [
                {
                  index: 1,
                  active: true,
                  multiplier: 1,
                  filters: [
                    {
                      index: 1,
                      name: 'signal-A',
                      type: 'virtual',
                      quality: 'normal',
                      comparator: '=',
                      count: 3,
                    },
                  ],
                },
              ],
            },
          },
        },
        {
          entity_number: 11,
          name: 'arithmetic-combinator',
          position: { x: -2, y: 1 },
          direction: 0,
          control_behavior: arithmeticBehavior('signal-A', true, false),
        },
      ],
      wires: [[400, 1, 11, 1]],
    },
  });
}

async function canonicalHost() {
  const database = structuredClone(syntheticPrototypeDatabase()) as {
    entities: Array<Record<string, unknown>>;
  };
  const families = ['constant-combinator', 'arithmetic-combinator'] as const;
  database.entities.push(
    ...families.map((family) => ({
      key: `entity:${family}`,
      name: family,
      type: family,
      blueprintEligible: true,
      tileWidth: 1,
      tileHeight: 1,
      circuit: {
        read: false,
        enableDisable: false,
        readContents: false,
        setFilters: false,
        setRequests: false,
        setRecipe: false,
        readRecipe: false,
        readFinishedCraft: false,
        outputSignals: false,
      },
    })),
  );
  const { prototypes } = await loadPrototypeDatabase(database);
  const databaseRef = { schemaVersion: prototypes.schemaVersion, identity: prototypes.identity };
  const profiles = families.map((family, index): EntityProfile => ({
    ...structuredClone(syntheticZeroPortEntityProfile),
    ref: {
      ...syntheticZeroPortEntityProfile.ref,
      database: databaseRef,
      prototypeKey: `entity:${family}` as EntityProfile['ref']['prototypeKey'],
      profileId: `profile:web-blueprint-import-${index}` as EntityProfileId,
    },
    prototypeType: family,
  }));
  const trustedEntityReplayContext = createTrustedEntityReplayContext({
    database: databaseRef,
    source: 'synthetic',
    evidenceIdentity: 'web-blueprint-import-test-evidence',
    policyIdentity: 'web-blueprint-import-test-policy',
    profiles,
  });
  return {
    databaseJson: JSON.stringify(database),
    identity: prototypes.identity,
    entityReplayContext: entityReplayContextTransport(trustedEntityReplayContext),
    trustedEntityReplayContext,
  };
}

const host = await canonicalHost();

function runtime() {
  return new CompilerWorkerRuntime({
    resolveEntityReplayContext(transport) {
      return entityReplayContextIdentity(transport) ===
        entityReplayContextIdentity(host.entityReplayContext)
        ? { trustedEntityReplayContext: host.trustedEntityReplayContext }
        : undefined;
    },
  });
}

function request(
  revision: number,
  options: Partial<CompilerWorkerImportRequest> = {},
): CompilerWorkerImportRequest {
  return {
    kind: 'import-blueprint',
    revision,
    document: { text: blueprintDocument() },
    sourcePath: 'virtual/imported.factorio.ts',
    prototypeProfile: { source: host.databaseJson, expectedIdentity: host.identity },
    entityReplayContext: host.entityReplayContext,
    ...options,
  };
}

afterEach(() => vi.restoreAllMocks());

describe('compiler Worker blueprint import endpoint', () => {
  test('uses default provisioning with the builtin asset and reuses its identity reference', async () => {
    const [source, assetManifest] = await Promise.all([
      readFile(
        new URL('../../../packages/prototypes/generated/space-age-2.1.17.json', import.meta.url),
        'utf8',
      ),
      readFile(
        new URL(
          '../../../packages/prototypes/generated/space-age-2.1.17.json.manifest.json',
          import.meta.url,
        ),
        'utf8',
      ),
    ]);
    const load = vi.spyOn(prototypeApi, 'loadPrototypeAsset');
    const worker = new CompilerWorkerRuntime();
    const documentText = builtinBlueprintDocument();
    const first = await worker.handleImport({
      kind: 'import-blueprint',
      revision: 99,
      document: { text: documentText },
      sourcePath: 'main.factorio.ts',
      prototypeProfile: { kind: 'builtin', source, assetManifest },
    });

    expect(first.result.state).toBe('verified');
    expect(first.result).toMatchObject({
      state: 'verified',
      verification: { state: 'verified', entityCount: 2 },
      correspondence: { entities: [{ entityNumber: 400 }, { entityNumber: 11 }] },
    });
    if (first.result.state !== 'verified') throw new Error('Expected default-provisioned import.');
    expect(first.result.source.text).toContain('= Constant(');
    expect(first.result.source.text).toContain('= Arithmetic(');
    expect(first.result.source.path).toBe('main.factorio.ts');
    expect(first.prototypeEnvironment?.identity).toBeDefined();

    const second = await worker.handleImport({
      kind: 'import-blueprint',
      revision: 100,
      document: { text: documentText },
      sourcePath: 'main.factorio.ts',
      prototypeProfile: { kind: 'builtin', identity: first.prototypeEnvironment!.identity },
    });

    expect(second.result.state).toBe('verified');
    expect(second.prototypeEnvironment?.identity).toBe(first.prototypeEnvironment?.identity);
    expect(load).toHaveBeenCalledOnce();
  });

  test('uses one host import and one real source compilation for canonical synthetic data', async () => {
    const importCore = vi.spyOn(blueprintImportApi, 'importCanonicalBlueprintSource');
    const compile = vi.spyOn(sourceCompilation, 'compileSourceProgram');
    const load = vi.spyOn(prototypeApi, 'loadPrototypeInputJson');
    const input = request(100);
    const response = await runtime().handleImport(input);

    expect(importCore).toHaveBeenCalledOnce();
    expect(importCore).toHaveBeenCalledWith(
      input.document.text,
      { path: input.sourcePath },
      expect.objectContaining({
        trustedEntityReplayContext: host.trustedEntityReplayContext,
        prototypes: expect.objectContaining({ identity: host.identity }),
      }),
    );
    expect(compile).toHaveBeenCalledOnce();
    expect(compile.mock.calls[0]?.[0]).toMatchObject({ path: input.sourcePath });
    expect(load).toHaveBeenCalledOnce();
    expect(structuredClone(response)).toEqual(response);
    expect(response).toMatchObject({
      kind: 'blueprint-imported',
      revision: 100,
      prototypeEnvironment: { identity: host.identity },
      result: {
        state: 'verified',
        verification: { state: 'verified', entityCount: 4 },
        correspondence: {
          entities: [
            { entityNumber: 12 },
            { entityNumber: 400 },
            { entityNumber: 11 },
            { entityNumber: 13 },
          ],
        },
      },
    });
    if (response.result.state !== 'verified') throw new Error('Expected verified import.');
    expect(response.result.source.text).toContain('Each(');
    expect(response.result.source.text).toContain('at(8,-1,15)');
    expect(response.result.diagnostics).toContainEqual(
      expect.objectContaining({ code: 'CL2001', severity: 'warning' }),
    );
    expect(response.result).not.toHaveProperty('diagnosticContext');
    expect(JSON.stringify(response)).not.toContain('trustedEntityReplayContext');
  });

  test('uses the same Worker cache for source then explicit identity reference', async () => {
    const load = vi.spyOn(prototypeApi, 'loadPrototypeInputJson');
    const worker = runtime();
    const first = await worker.handleImport(request(101));
    const second = await worker.handleImport(
      request(102, { prototypeProfile: { identity: host.identity } }),
    );

    expect(first.result.state).toBe('verified');
    expect(second.result.state).toBe('verified');
    expect(load).toHaveBeenCalledOnce();
  });

  test('returns one blocked response for a missing profile cache entry', async () => {
    const load = vi.spyOn(prototypeApi, 'loadPrototypeInputJson');
    const response = await runtime().handleImport(
      request(103, { prototypeProfile: { identity: 'not-loaded' } }),
    );

    expect(load).not.toHaveBeenCalled();
    expect(response).toMatchObject({
      kind: 'blueprint-imported',
      revision: 103,
      result: { state: 'blocked', error: { code: 'WP1002' } },
    });
  });

  test('requires trusted authority even for an empty blueprint', async () => {
    const response = await new CompilerWorkerRuntime().handleImport({
      kind: 'import-blueprint',
      revision: 1031,
      document: { text: '{"blueprint":{"entities":[],"wires":[]}}' },
      sourcePath: 'virtual/empty.ts',
    });

    expect(structuredClone(response)).toEqual(response);
    expect(response.result).toMatchObject({
      state: 'blocked',
      diagnostics: [expect.objectContaining({ category: 'missing-trusted-context' })],
    });
    expect(response.result).not.toHaveProperty('source');
    expect(response.result).not.toHaveProperty('correspondence');
    expect(response.result).not.toHaveProperty('diagnosticContext');
  });

  test.each([
    {
      name: 'identity pin mismatch',
      profile: { source: host.databaseJson, expectedIdentity: 'wrong-identity' },
      code: 'WP1001',
    },
    {
      name: 'raw metadata and generated manifest conflict',
      profile: {
        source: host.databaseJson,
        factorioDumpMetadata: '{}',
        assetManifest: '{}',
      },
      code: 'WP1001',
    },
  ])('shares parse profile validation for $name', async ({ profile, code }) => {
    const response = await runtime().handleImport(request(104, { prototypeProfile: profile }));
    expect(response.result).toMatchObject({ state: 'blocked', error: { code } });
    expect(response.result).not.toHaveProperty('source');
    expect(response.result).not.toHaveProperty('correspondence');
  });

  test('rejects a mismatched host context without invoking import or provisioning unrelated authority', async () => {
    const load = vi.spyOn(prototypeApi, 'loadPrototypeInputJson');
    const importCore = vi.spyOn(blueprintImportApi, 'importCanonicalBlueprintSource');
    const entityReplayContext = {
      ...host.entityReplayContext,
      evidenceIdentity: 'different-evidence',
    };
    const response = await runtime().handleImport(request(105, { entityReplayContext }));

    expect(load).toHaveBeenCalledOnce();
    expect(importCore).not.toHaveBeenCalled();
    expect(response.result).toMatchObject({ state: 'blocked', error: { code: 'ER1001' } });
  });

  test.each([
    {
      name: 'unsupported root',
      text: '{"blueprint_book":{}}',
      path: '$.blueprint_book',
    },
    {
      name: 'unsupported outer field',
      text: '{"blueprint":{"entities":[],"wires":[],"extra":true}}',
      path: '$.blueprint.extra',
    },
  ])('projects $name refusals without usable partial output', async ({ text, path }) => {
    const response = await runtime().handleImport(request(106, { document: { text } }));
    expect(structuredClone(response)).toEqual(response);
    expect(response.result).toMatchObject({
      state: 'blocked',
      diagnostics: [expect.objectContaining({ path })],
    });
    expect(response.result).not.toHaveProperty('source');
    expect(response.result).not.toHaveProperty('correspondence');
    expect(response.result).not.toHaveProperty('diagnosticContext');
    expect(JSON.stringify(response)).not.toContain('diagnosticContext');
  });

  test('preserves native mismatch paths and generated locations while withholding failed source', async () => {
    const text = blueprintDocument('0.5').replace('"multiplier":0.5', '"multiplier":-0');
    const response = await runtime().handleImport(
      request(107, { document: { text }, sourcePath: 'virtual/negative-zero.ts' }),
    );
    const diagnostic = response.result.diagnostics.find(
      (entry) => 'category' in entry && entry.category === 'source-verification-mismatch',
    );

    expect(response.result.state).toBe('blocked');
    expect(diagnostic).toMatchObject({
      path: '$.blueprint.entities[1]',
      generatedLocation: {
        path: 'virtual/negative-zero.ts',
        start: { line: expect.any(Number), column: expect.any(Number) },
        end: { line: expect.any(Number), column: expect.any(Number) },
      },
    });
    expect(response.result).not.toHaveProperty('source');
    expect(response.result).not.toHaveProperty('correspondence');
    expect(response.result.diagnostics).not.toContainEqual(
      expect.objectContaining({ text: expect.any(String) }),
    );
  });

  test.each([
    {
      name: 'revision',
      patch: { revision: -1 },
      path: '$.revision',
    },
    {
      name: 'document text',
      patch: { document: { text: 3 } },
      path: '$.document.text',
    },
    {
      name: 'source path',
      patch: { sourcePath: '  ' },
      path: '$.sourcePath',
    },
  ])('validates malformed $name before provider loading', async ({ patch, path }) => {
    const load = vi.spyOn(prototypeApi, 'loadPrototypeInputJson');
    const response = await runtime().handleImport({ ...request(108), ...patch } as never);

    expect(load).not.toHaveBeenCalled();
    expect(response.result).toMatchObject({
      state: 'blocked',
      error: { code: 'WP1009', path },
    });
  });

  test('preserves the analysis resource-limit code and native path', async () => {
    const response = await new CompilerWorkerRuntime().handleImport({
      kind: 'import-blueprint',
      revision: 1092,
      document: {
        text: JSON.stringify({
          blueprint: { entities: Array.from({ length: 10_001 }, () => ({})) },
        }),
      },
      sourcePath: 'virtual/oversized.ts',
    });

    expect(response.result).toMatchObject({
      state: 'blocked',
      error: { code: 'BPI1001', path: '$.blueprint.entities' },
      diagnostics: [expect.objectContaining({ code: 'BPI1001' })],
    });
    expect(response.result).not.toHaveProperty('source');
    expect(response.result).not.toHaveProperty('correspondence');
  });

  test('preserves a typed analysis cancellation failure without a native path', async () => {
    vi.spyOn(blueprintImportApi, 'importCanonicalBlueprintSource').mockImplementationOnce(() => {
      throw new BlueprintImportAnalysisError('BPI1002', 'Blueprint import analysis was cancelled.');
    });

    const response = await new CompilerWorkerRuntime().handleImport({
      kind: 'import-blueprint',
      revision: 1093,
      document: { text: '{"blueprint":{"entities":[],"wires":[]}}' },
      sourcePath: 'virtual/cancelled.ts',
    });

    expect(response.result).toMatchObject({
      state: 'blocked',
      error: { code: 'BPI1002', message: 'Blueprint import analysis was cancelled.' },
      diagnostics: [expect.objectContaining({ code: 'BPI1002' })],
    });
    expect(response.result).not.toHaveProperty('error.path');
    expect(response.result).not.toHaveProperty('source');
    expect(response.result).not.toHaveProperty('correspondence');
  });

  test('turns known provider-load and unexpected importer exceptions into blocked responses', async () => {
    const knownFailure = await new CompilerWorkerRuntime().handleImport({
      kind: 'import-blueprint',
      revision: 109,
      document: { text: '{"blueprint":{"entities":[],"wires":[]}}' },
      sourcePath: 'virtual/empty.ts',
      prototypeProfile: { source: '{' },
    });
    expect(knownFailure.result).toMatchObject({
      state: 'blocked',
      error: { code: 'PT1006' },
    });

    const malformedDocument = await new CompilerWorkerRuntime().handleImport({
      kind: 'import-blueprint',
      revision: 1091,
      document: { text: '{' },
      sourcePath: 'virtual/malformed.ts',
    });
    expect(malformedDocument.result).toMatchObject({
      state: 'blocked',
      error: { code: 'BPD1001', path: '$' },
    });

    vi.spyOn(blueprintImportApi, 'importCanonicalBlueprintSource').mockImplementationOnce(() => {
      throw new Error('synthetic import fault');
    });
    const unexpected = await new CompilerWorkerRuntime().handleImport({
      kind: 'import-blueprint',
      revision: 110,
      document: { text: '{"blueprint":{"entities":[],"wires":[]}}' },
      sourcePath: 'virtual/empty.ts',
    });
    expect(unexpected.result).toMatchObject({
      state: 'blocked',
      error: { code: 'WP1010', message: 'synthetic import fault' },
    });
  });
});

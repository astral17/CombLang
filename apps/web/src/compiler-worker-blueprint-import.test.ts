import { afterEach, describe, expect, test, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import { BlueprintImportAnalysisError } from '@comblang/blueprint/import-analysis';
import { parseLosslessJson } from '@comblang/blueprint/document';
import { BlueprintExchangeError } from '@comblang/blueprint/errors';
import * as blueprintExchangeCodec from '@comblang/blueprint/exchange-codec';
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
import { blueprintImportDocumentFormat } from './blueprint-import.js';

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

function builtinDeciderBlueprintDocument(options: { readonly implicitCopyInput?: boolean } = {}) {
  return JSON.stringify({
    blueprint: {
      entities: [
        {
          entity_number: 42,
          name: 'decider-combinator',
          position: { x: 0, y: 0 },
          direction: 0,
          control_behavior: {
            decider_conditions: {
              conditions: [
                {
                  first_signal: { type: 'virtual', name: 'signal-A' },
                  first_signal_networks: { red: true, green: false },
                  comparator: '>',
                  constant: 0,
                  compare_type: 'and',
                },
              ],
              outputs: [
                {
                  signal: { type: 'virtual', name: 'signal-B' },
                  copy_count_from_input: true,
                  ...(options.implicitCopyInput ? {} : { networks: { red: true, green: false } }),
                },
              ],
            },
          },
        },
      ],
      wires: [[42, 1, 42, 3]],
    },
  });
}

function builtinSelectorBlueprintDocument() {
  return JSON.stringify({
    blueprint: {
      entities: [
        {
          entity_number: 10,
          name: 'selector-combinator',
          position: { x: 0, y: 0 },
          direction: 0,
          control_behavior: {
            operation: 'select',
            select_max: true,
            index_signal: { type: 'virtual', name: 'signal-index', quality: 'rare' },
          },
        },
        {
          entity_number: 11,
          name: 'selector-combinator',
          position: { x: 3, y: 0 },
          direction: 0,
          control_behavior: {
            operation: 'count',
            count_signal: { type: 'item', name: 'iron-plate', quality: 'normal' },
          },
        },
        {
          entity_number: 12,
          name: 'selector-combinator',
          position: { x: 6, y: 0 },
          direction: 0,
          control_behavior: {
            operation: 'count',
            count_signal: { type: 'item', name: 'copper-plate', quality: 'normal' },
          },
        },
      ],
      wires: [[10, 3, 11, 1]],
    },
  });
}

async function canonicalHost() {
  const database = structuredClone(syntheticPrototypeDatabase()) as {
    entities: Array<Record<string, unknown>>;
  };
  const families = ['constant-combinator', 'arithmetic-combinator', 'selector-combinator'] as const;
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

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function formattedRequest(
  revision: number,
  text: string,
  format: 'json' | 'exchange',
): CompilerWorkerImportRequest {
  return {
    ...request(revision),
    document: { text, format },
  } as unknown as CompilerWorkerImportRequest;
}

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

  test('imports canonical Decider JSON and exchange through ordinary builtin provisioning', async () => {
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
    const compile = vi.spyOn(sourceCompilation, 'compileSourceProgram');
    const worker = new CompilerWorkerRuntime();
    const documentText = builtinDeciderBlueprintDocument();
    const exchange = await blueprintExchangeCodec.encodeBlueprintExchange(
      parseLosslessJson(documentText),
    );
    const json = await worker.handleImport({
      kind: 'import-blueprint',
      revision: 1090,
      document: { text: documentText, format: 'json' },
      sourcePath: 'decider.factorio.ts',
      prototypeProfile: { kind: 'builtin', source, assetManifest },
    });

    expect(json.result.state).toBe('verified');
    if (json.result.state !== 'verified') throw new Error('Expected builtin Decider JSON import.');
    expect(structuredClone(json)).toEqual(json);
    expect(json.result).toMatchObject({
      verification: { state: 'verified', entityCount: 1 },
      correspondence: { entities: [{ entityNumber: 42, family: 'decider' }] },
    });
    expect(json.result.source.text).toContain('= Decider(');
    expect(json.result).not.toHaveProperty('diagnosticContext');

    const encoded = await worker.handleImport({
      kind: 'import-blueprint',
      revision: 1091,
      document: { text: exchange, format: 'exchange' },
      sourcePath: 'decider.factorio.ts',
      prototypeProfile: { kind: 'builtin', identity: json.prototypeEnvironment!.identity },
    });
    expect(encoded.result.state).toBe('verified');
    if (encoded.result.state !== 'verified') {
      throw new Error('Expected builtin Decider exchange import.');
    }
    expect(structuredClone(encoded)).toEqual(encoded);
    expect(encoded.result.source).toEqual(json.result.source);
    expect(encoded.result.correspondence).toEqual(json.result.correspondence);
    expect(encoded.prototypeEnvironment?.identity).toBe(json.prototypeEnvironment?.identity);

    const refusal = await worker.handleImport({
      kind: 'import-blueprint',
      revision: 1092,
      document: {
        text: builtinDeciderBlueprintDocument({ implicitCopyInput: true }),
        format: 'json',
      },
      sourcePath: 'decider-refused.factorio.ts',
      prototypeProfile: { kind: 'builtin', identity: json.prototypeEnvironment!.identity },
    });
    expect(structuredClone(refusal)).toEqual(refusal);
    expect(refusal.result).toMatchObject({
      state: 'blocked',
      diagnostics: [
        expect.objectContaining({
          category: 'unsupported-source-configuration',
          path: '$.blueprint.entities[0].control_behavior.decider_conditions.outputs[0]',
        }),
      ],
    });
    expect(refusal.result).not.toHaveProperty('source');
    expect(refusal.result).not.toHaveProperty('correspondence');
    expect(refusal.result).not.toHaveProperty('diagnosticContext');
    expect(JSON.stringify(refusal)).not.toContain('trustedEntityReplayContext');

    expect(load).toHaveBeenCalledOnce();
    expect(compile).toHaveBeenCalledTimes(2);
    expect(compile.mock.calls[0]?.[0]).toEqual(json.result.source);
    expect(compile.mock.calls[1]?.[0]).toEqual(encoded.result.source);
  });

  test('imports Selector JSON and exchange through ordinary builtin provisioning', async () => {
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
    const compile = vi.spyOn(sourceCompilation, 'compileSourceProgram');
    const worker = new CompilerWorkerRuntime();
    const documentText = builtinSelectorBlueprintDocument();
    const exchange = await blueprintExchangeCodec.encodeBlueprintExchange(
      parseLosslessJson(documentText),
    );
    const json = await worker.handleImport({
      kind: 'import-blueprint',
      revision: 1093,
      document: { text: documentText, format: 'json' },
      sourcePath: 'selector.factorio.ts',
      prototypeProfile: { kind: 'builtin', source, assetManifest },
    });

    expect(json.result.state).toBe('verified');
    if (json.result.state !== 'verified') {
      throw new Error(
        `Expected ordinary builtin Selector import; got ${JSON.stringify(json.result)}`,
      );
    }
    const verifiedJson = json.result;
    expect(structuredClone(json)).toEqual(json);
    expect(verifiedJson).toMatchObject({
      verification: { state: 'verified', entityCount: 3 },
      correspondence: {
        entities: [
          { entityNumber: 10, family: 'selector' },
          { entityNumber: 11, family: 'selector', attachmentSpans: [] },
          { entityNumber: 12, family: 'selector', attachmentSpans: [] },
        ],
      },
    });
    expect(verifiedJson.source.text.match(/Selector\(/g)).toHaveLength(3);
    expect(verifiedJson.source.text).toContain('signal-index');
    expect(verifiedJson.source.text).toContain('iron-plate');
    expect(verifiedJson.source.text).toContain('copper-plate');
    const unwiredCount = verifiedJson.correspondence.entities.find(
      ({ entityNumber }) => entityNumber === 12,
    );
    if (unwiredCount === undefined) throw new Error('Expected the fully unwired Count.');
    const countSource = verifiedJson.source.text.slice(
      unwiredCount.constructionSpan.start,
      unwiredCount.constructionSpan.end,
    );
    const inputPair = countSource.match(/input:pair\((import_network_\d+),(import_network_\d+)\)/);
    if (inputPair === null) throw new Error('Expected both reconstructed Count input lanes.');
    const inputLaneColors = inputPair.slice(1).map((networkName) => {
      const row = verifiedJson.correspondence.networks.find(({ name }) => name === networkName);
      if (row === undefined) throw new Error(`Missing source correspondence for ${networkName}.`);
      const declaration = verifiedJson.source.text.slice(
        row.declarationSpan.start,
        row.declarationSpan.end,
      );
      return declaration.match(/Network<([RG])>/)?.[1];
    });
    expect(inputLaneColors).toEqual(['R', 'G']);
    expect(verifiedJson).not.toHaveProperty('diagnosticContext');

    const encoded = await worker.handleImport({
      kind: 'import-blueprint',
      revision: 1094,
      document: { text: exchange, format: 'exchange' },
      sourcePath: 'selector.factorio.ts',
      prototypeProfile: { kind: 'builtin', identity: json.prototypeEnvironment!.identity },
    });
    expect(encoded.result.state).toBe('verified');
    if (encoded.result.state !== 'verified') {
      throw new Error('Expected ordinary builtin Selector exchange import.');
    }
    expect(structuredClone(encoded)).toEqual(encoded);
    expect(encoded.result.source).toEqual(json.result.source);
    expect(encoded.result.correspondence).toEqual(json.result.correspondence);
    expect(encoded.prototypeEnvironment?.identity).toBe(json.prototypeEnvironment?.identity);

    const unsupportedDocument = documentText.replace(
      '"select_max":true',
      '"select_max":true,"select_highest_quality":true',
    );
    const refusal = await worker.handleImport({
      kind: 'import-blueprint',
      revision: 1095,
      document: { text: unsupportedDocument, format: 'json' },
      sourcePath: 'selector-refused.factorio.ts',
      prototypeProfile: { kind: 'builtin', identity: json.prototypeEnvironment!.identity },
    });
    expect(structuredClone(refusal)).toEqual(refusal);
    expect(refusal.result).toMatchObject({
      state: 'blocked',
      diagnostics: [
        expect.objectContaining({
          category: 'unsupported-selector-configuration',
          path: '$.blueprint.entities[0].control_behavior.select_highest_quality',
        }),
      ],
    });
    expect(refusal.result).not.toHaveProperty('source');
    expect(refusal.result).not.toHaveProperty('correspondence');
    expect(refusal.result).not.toHaveProperty('diagnosticContext');
    expect(JSON.stringify(refusal)).not.toContain('trustedEntityReplayContext');
    expect(JSON.stringify(refusal)).not.toContain('entityPrototypeResolver');

    expect(load).toHaveBeenCalledOnce();
    expect(compile).toHaveBeenCalledTimes(2);
    expect(compile.mock.calls[0]?.[0]).toEqual(json.result.source);
    expect(compile.mock.calls[1]?.[0]).toEqual(encoded.result.source);
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

  test.each([
    ['unknown', 'gzip'],
    ['null', null],
    ['number', 1],
    ['undefined', undefined],
  ])(
    'rejects an explicitly supplied %s document format before provider loading',
    async (_name, value) => {
      const load = vi.spyOn(prototypeApi, 'loadPrototypeInputJson');
      const base = request(1081);
      const document: Record<string, unknown> = { text: base.document.text, format: value };
      const response = await runtime().handleImport({ ...base, document } as never);

      expect(load).not.toHaveBeenCalled();
      expect(response.result).toMatchObject({
        state: 'blocked',
        error: { code: 'WP1009', path: '$.document.format' },
      });
    },
  );

  test.each(['accessor', 'non-enumerable'] as const)(
    'rejects a document format %s before provider loading',
    async (descriptorKind) => {
      const load = vi.spyOn(prototypeApi, 'loadPrototypeInputJson');
      const base = request(1082);
      const document: Record<string, unknown> = { text: base.document.text };
      Object.defineProperty(
        document,
        'format',
        descriptorKind === 'accessor'
          ? { enumerable: true, get: () => 'exchange' }
          : { enumerable: false, value: 'exchange' },
      );
      const response = await runtime().handleImport({ ...base, document } as never);

      expect(load).not.toHaveBeenCalled();
      expect(response.result).toMatchObject({
        state: 'blocked',
        error: { code: 'WP1009', path: '$.document.format' },
      });
    },
  );

  test('round-trips exchange input through the lossless codec and imports exactly once per success', async () => {
    const text = blueprintDocument();
    const exchange = await blueprintExchangeCodec.encodeBlueprintExchange(parseLosslessJson(text));
    const importCore = vi.spyOn(blueprintImportApi, 'importCanonicalBlueprintSource');
    const compile = vi.spyOn(sourceCompilation, 'compileSourceProgram');
    const worker = runtime();
    const json = await worker.handleImport(formattedRequest(1083, text, 'json'));
    const encoded = await worker.handleImport(formattedRequest(1084, exchange, 'exchange'));

    expect(json.result.state).toBe('verified');
    expect(encoded.result.state).toBe('verified');
    if (json.result.state !== 'verified' || encoded.result.state !== 'verified') {
      throw new Error('Expected both JSON and exchange imports to verify.');
    }
    expect(encoded.result.source).toEqual(json.result.source);
    expect(encoded.result.correspondence).toEqual(json.result.correspondence);
    expect(encoded.result.verification).toEqual(json.result.verification);
    expect(importCore).toHaveBeenCalledTimes(2);
    expect(importCore.mock.calls.map(([input]) => input)).toEqual([text, text]);
    expect(compile).toHaveBeenCalledTimes(2);
  });

  test.each([
    { name: 'marker', text: 'xAAAA', code: 'BEX1001' },
    { name: 'Base64', text: '0A===', code: 'BEX1002' },
    { name: 'deflate stream', text: '0AAAA', code: 'BEX1005' },
  ] as const)(
    'projects an actual malformed exchange $name as a located refusal',
    async ({ text, code }) => {
      const importCore = vi.spyOn(blueprintImportApi, 'importCanonicalBlueprintSource');
      const compile = vi.spyOn(sourceCompilation, 'compileSourceProgram');
      const response = await runtime().handleImport(formattedRequest(1085, text, 'exchange'));

      expect(response.result).toMatchObject({
        state: 'blocked',
        error: { code, path: '$' },
      });
      expect(response.result).not.toHaveProperty('source');
      expect(response.result).not.toHaveProperty('correspondence');
      expect(importCore).not.toHaveBeenCalled();
      expect(compile).not.toHaveBeenCalled();
    },
  );

  test.each([
    ['compressed/decompressed budget', 'BEX1003'],
    ['UTF-8 validation', 'BEX1006'],
  ] as const)('preserves a typed exchange %s error without compiling', async (_name, code) => {
    vi.spyOn(blueprintExchangeCodec, 'decodeBlueprintExchange').mockRejectedValueOnce(
      new BlueprintExchangeError(code, `Synthetic ${code} failure.`, { path: '$' }),
    );
    const importCore = vi.spyOn(blueprintImportApi, 'importCanonicalBlueprintSource');
    const compile = vi.spyOn(sourceCompilation, 'compileSourceProgram');
    const response = await runtime().handleImport(formattedRequest(1086, '0AAAA', 'exchange'));

    expect(response.result).toMatchObject({
      state: 'blocked',
      error: { code, message: `Synthetic ${code} failure.`, path: '$' },
    });
    expect(response.result).not.toHaveProperty('source');
    expect(response.result).not.toHaveProperty('correspondence');
    expect(importCore).not.toHaveBeenCalled();
    expect(compile).not.toHaveBeenCalled();
  });

  test('reports missing Web stream capability while JSON mode remains available', async () => {
    vi.stubGlobal('CompressionStream', undefined);
    vi.stubGlobal('DecompressionStream', undefined);
    const worker = runtime();
    const exchange = await worker.handleImport(formattedRequest(1087, '0AAAA', 'exchange'));

    expect(exchange.result).toMatchObject({
      state: 'blocked',
      error: { code: 'BEX1004', path: '$' },
    });
    expect(exchange.result).not.toHaveProperty('source');
    expect(exchange.result).not.toHaveProperty('correspondence');

    const json = await worker.handleImport(formattedRequest(1088, blueprintDocument(), 'json'));
    expect(json.result.state).toBe('verified');
  });

  test.each([
    ['empty input', ''],
    ['leading whitespace before the exchange marker', ' 0AAAA'],
  ])('does not normalize or retry %s as exchange input', async (_name, text) => {
    const decode = vi.spyOn(blueprintExchangeCodec, 'decodeBlueprintExchange');
    const importCore = vi.spyOn(blueprintImportApi, 'importCanonicalBlueprintSource');
    const format = blueprintImportDocumentFormat(text);
    const response = await runtime().handleImport(formattedRequest(10881, text, format));

    expect(format).toBe('json');
    expect(response.result).toMatchObject({ state: 'blocked', error: { code: 'BPD1001' } });
    expect(decode).not.toHaveBeenCalled();
    expect(importCore).toHaveBeenCalledOnce();
    expect(importCore.mock.calls[0]?.[0]).toBe(text);
  });

  test('preserves strict negative-zero verification refusal after exchange decode', async () => {
    const text = blueprintDocument('0.5').replace('"multiplier":0.5', '"multiplier":-0');
    const exchange = await blueprintExchangeCodec.encodeBlueprintExchange(parseLosslessJson(text));
    const response = await runtime().handleImport(formattedRequest(1089, exchange, 'exchange'));
    const diagnostic = response.result.diagnostics.find(
      (entry) => 'category' in entry && entry.category === 'source-verification-mismatch',
    );

    expect(response.result.state).toBe('blocked');
    expect(diagnostic).toMatchObject({ path: '$.blueprint.entities[1]' });
    expect(response.result).not.toHaveProperty('source');
    expect(response.result).not.toHaveProperty('correspondence');
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

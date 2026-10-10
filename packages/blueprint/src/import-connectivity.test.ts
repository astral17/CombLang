import { readFile } from 'node:fs/promises';
import { describe, expect, test } from 'vitest';

import { classifyBlueprintDocument } from './classification.js';
import * as publicBlueprint from './index.js';
import { parseLosslessJson, stringifyLosslessJson } from './document.js';
import { analyzeBlueprintImport, BlueprintImportAnalysisError } from './import-analysis.js';
import { analyzeBlueprintConnectivity } from './import-connectivity.js';

function analyze(source: string) {
  return analyzeBlueprintImport(classifyBlueprintDocument(parseLosslessJson(source)));
}

function source(entities: readonly number[], wires: readonly string[] = []): string {
  return JSON.stringify({
    blueprint: {
      entities: entities.map((entityNumber) => ({
        entity_number: entityNumber,
        name: `synthetic-${entityNumber}`,
      })),
      wires: wires.map((wire) => JSON.parse(wire) as number[]),
    },
  });
}

function endpoint(entityNumber: number, connectorId: number, color: 'red' | 'green') {
  return { entityNumber, connectorId, color } as const;
}

describe('blueprint import connectivity', () => {
  test('connects explicitly mapped red endpoints without interpreting connector IDs', () => {
    const analysis = analyze(source([20, 10], ['[10,901,20,407]']));
    const result = analyzeBlueprintConnectivity(analysis, [
      endpoint(20, 407, 'red'),
      endpoint(10, 901, 'red'),
    ]);

    expect(result.state).toBe('complete');
    expect(result.analysis).toBe(analysis);
    expect(result.components).toEqual([
      {
        color: 'red',
        endpoints: [
          { entityNumber: 10, connectorId: 901 },
          { entityNumber: 20, connectorId: 407 },
        ],
      },
    ]);
    expect(result.diagnostics).toEqual([]);
    expect(result).not.toHaveProperty('network');
    expect(result).not.toHaveProperty('ready');
  });

  test('keeps red and green components separate and includes mapped isolated endpoints', () => {
    const analysis = analyze(source([1, 2, 3, 4], ['[1,9,2,8]', '[3,7,4,6]']));
    const result = analyzeBlueprintConnectivity(analysis, [
      endpoint(4, 6, 'green'),
      endpoint(2, 8, 'red'),
      endpoint(3, 7, 'green'),
      endpoint(1, 9, 'red'),
      endpoint(1, 99, 'red'),
    ]);

    expect(result.components).toEqual([
      {
        color: 'red',
        endpoints: [
          { entityNumber: 1, connectorId: 9 },
          { entityNumber: 2, connectorId: 8 },
        ],
      },
      { color: 'red', endpoints: [{ entityNumber: 1, connectorId: 99 }] },
      {
        color: 'green',
        endpoints: [
          { entityNumber: 3, connectorId: 7 },
          { entityNumber: 4, connectorId: 6 },
        ],
      },
    ]);
  });

  test('uses iterative union-find and stable order across chain, cycle and edge permutations', () => {
    const mappings = [
      endpoint(4, 40, 'red'),
      endpoint(2, 20, 'red'),
      endpoint(1, 10, 'red'),
      endpoint(3, 30, 'red'),
    ];
    const forward = analyze(source([1, 2, 3, 4], ['[1,10,2,20]', '[2,20,3,30]', '[3,30,4,40]']));
    const permuted = analyze(
      source([4, 3, 2, 1], ['[4,40,3,30]', '[3,30,2,20]', '[2,20,1,10]', '[1,10,2,20]']),
    );

    const first = analyzeBlueprintConnectivity(forward, mappings);
    const second = analyzeBlueprintConnectivity(permuted, mappings);
    expect(first.components).toEqual(second.components);
    expect(first.components[0]?.endpoints).toEqual([
      { entityNumber: 1, connectorId: 10 },
      { entityNumber: 2, connectorId: 20 },
      { entityNumber: 3, connectorId: 30 },
      { entityNumber: 4, connectorId: 40 },
    ]);

    const cycleAndDuplicates = analyze(
      source(
        [1, 2, 3],
        ['[1,10,2,20]', '[2,20,3,30]', '[3,30,1,10]', '[1,10,1,10]', '[2,20,1,10]'],
      ),
    );
    expect(
      analyzeBlueprintConnectivity(cycleAndDuplicates, [
        endpoint(3, 30, 'red'),
        endpoint(1, 10, 'red'),
        endpoint(2, 20, 'red'),
      ]).components,
    ).toEqual([
      {
        color: 'red',
        endpoints: [
          { entityNumber: 1, connectorId: 10 },
          { entityNumber: 2, connectorId: 20 },
          { entityNumber: 3, connectorId: 30 },
        ],
      },
    ]);
  });

  test('keeps different connectors on one entity distinct unless a wire joins them', () => {
    const mappings = [endpoint(5, 2, 'green'), endpoint(5, 1, 'green')];
    const unwired = analyze(source([5]));
    const wired = analyze(source([5], ['[5,1,5,2]']));

    expect(analyzeBlueprintConnectivity(unwired, mappings).components).toHaveLength(2);
    expect(analyzeBlueprintConnectivity(wired, mappings).components).toEqual([
      {
        color: 'green',
        endpoints: [
          { entityNumber: 5, connectorId: 1 },
          { entityNumber: 5, connectorId: 2 },
        ],
      },
    ]);
  });

  test('blocks all components for missing endpoint mappings and reports raw endpoint paths', () => {
    const analysis = analyze(source([1, 2, 3, 4], ['[1,10,2,20]', '[3,30,4,40]']));
    const result = analyzeBlueprintConnectivity(analysis, [
      endpoint(1, 10, 'red'),
      endpoint(2, 20, 'red'),
      endpoint(3, 30, 'green'),
    ]);

    expect(result.state).toBe('blocked');
    expect(result.components).toEqual([]);
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        category: 'unresolved-endpoint',
        path: '$.blueprint.wires[1][3]',
        entityNumber: 4,
        connectorId: 40,
      }),
    ]);
  });

  test('blocks an explicit cross-color edge without calling it native-invalid', () => {
    const analysis = analyze(source([1, 2, 3], ['[1,10,2,20]', '[2,20,3,30]']));
    const result = analyzeBlueprintConnectivity(analysis, [
      endpoint(1, 10, 'red'),
      endpoint(2, 20, 'green'),
      endpoint(3, 30, 'green'),
    ]);

    expect(result.state).toBe('blocked');
    expect(result.components).toEqual([]);
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        category: 'incompatible-mapping',
        path: '$.blueprint.wires[0]',
      }),
    );
    const issue = result.diagnostics.find(({ category }) => category === 'incompatible-mapping');
    expect(issue?.message).not.toMatch(/Factorio rejects/i);
  });

  test('does not publish known subsets when an unmapped bridge hides their connection', () => {
    const analysis = analyze(source([1, 2, 3, 4], ['[1,10,2,20]', '[2,20,3,30]', '[3,30,4,40]']));
    const result = analyzeBlueprintConnectivity(analysis, [
      endpoint(1, 10, 'red'),
      endpoint(2, 20, 'red'),
      endpoint(4, 40, 'red'),
    ]);

    expect(result.state).toBe('blocked');
    expect(result.components).toEqual([]);
    expect(result.diagnostics.map((diagnostic) => diagnostic.path)).toEqual([
      '$.blueprint.wires[1][3]',
      '$.blueprint.wires[2][1]',
    ]);
  });

  test('retains structural diagnostics by reference and blocks dangling document references', () => {
    const analysis = analyze(source([1], ['[1,10,99,20]']));
    const result = analyzeBlueprintConnectivity(analysis, [endpoint(1, 10, 'red')]);

    expect(result.state).toBe('blocked');
    expect(result.components).toEqual([]);
    expect(result.diagnostics).toContain(analysis.diagnostics[0]);
    expect(result.diagnostics[0]).toBe(analysis.diagnostics[0]);
  });

  test('blocks opaque roots and unsupported coverage without inventing topology', () => {
    const analysis = analyze('{"blueprint_book":{"blueprints":[]}}');
    const result = analyzeBlueprintConnectivity(analysis, []);

    expect(result.state).toBe('blocked');
    expect(result.components).toEqual([]);
    expect(result.diagnostics).toContain(analysis.coverage[0]);
  });

  test('rejects malformed, duplicate and unknown endpoint mappings as input errors', () => {
    const analysis = analyze(source([1]));

    expect(() => analyzeBlueprintConnectivity(analysis, [endpoint(1, -1, 'red')])).toThrow(
      TypeError,
    );
    expect(() =>
      analyzeBlueprintConnectivity(analysis, [endpoint(1, 7, 'red'), endpoint(1, 7, 'green')]),
    ).toThrow(/duplicate/i);
    expect(() => analyzeBlueprintConnectivity(analysis, [endpoint(2, 7, 'red')])).toThrow(
      /entity/i,
    );
    expect(() =>
      analyzeBlueprintConnectivity(analysis, [{ ...endpoint(1, 7, 'red'), extra: true } as never]),
    ).toThrow(/unknown|mapping/i);
    const accessorMapping = Object.defineProperty({}, 'entityNumber', {
      get: () => 1,
    });
    expect(() =>
      analyzeBlueprintConnectivity(analysis, [
        Object.assign(accessorMapping, { connectorId: 7, color: 'red' }) as never,
      ]),
    ).toThrow(/data property/i);
  });

  test('checks the endpoint budget before indexing and accepts the exact boundary', () => {
    const analysis = analyze(source([1, 2]));
    const mappings = [endpoint(1, 1, 'red'), endpoint(2, 2, 'green')];

    expect(() =>
      analyzeBlueprintConnectivity(analysis, mappings, { maxEndpoints: 2 }),
    ).not.toThrow();
    expect(() => analyzeBlueprintConnectivity(analysis, mappings, { maxEndpoints: 1 })).toThrow(
      BlueprintImportAnalysisError,
    );
    expect(() => analyzeBlueprintConnectivity(analysis, [], { maxEndpoints: 0 })).toThrow(
      RangeError,
    );
    expect(() => analyzeBlueprintConnectivity(analysis, [], { unknown: true } as never)).toThrow(
      TypeError,
    );
  });

  test('cancels before work and observes cancellation during synchronous loops', () => {
    const analysis = analyze(source([1, 2]));
    const aborted = new AbortController();
    aborted.abort();
    expect(() => analyzeBlueprintConnectivity(analysis, [], { signal: aborted.signal })).toThrow(
      expect.objectContaining({ code: 'BPI1002' }),
    );

    let reads = 0;
    const observedAbort = {
      get aborted() {
        reads += 1;
        return reads >= 4;
      },
    } as AbortSignal;
    expect(() =>
      analyzeBlueprintConnectivity(analysis, [endpoint(1, 1, 'red'), endpoint(2, 2, 'green')], {
        signal: observedAbort,
      }),
    ).toThrow(expect.objectContaining({ code: 'BPI1002' }));
    expect(reads).toBe(4);
  });

  test('freezes detached results and leaves the accepted lossless analysis unchanged', () => {
    const input =
      '{"blueprint":{"entities":[{"entity_number":1,"name":"a","meta":1.2300},' +
      '{"entity_number":2,"name":"b"}],"wires":[[1,8,2,9]],"future":9007199254740993}}';
    const analysis = analyze(input);
    const before = stringifyLosslessJson(analysis.document);
    const result = analyzeBlueprintConnectivity(analysis, [
      endpoint(2, 9, 'red'),
      endpoint(1, 8, 'red'),
    ]);

    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.components)).toBe(true);
    expect(Object.isFrozen(result.components[0])).toBe(true);
    expect(Object.isFrozen(result.components[0]?.endpoints)).toBe(true);
    expect(Object.isFrozen(result.components[0]?.endpoints[0])).toBe(true);
    expect(Object.isFrozen(result.diagnostics)).toBe(true);
    expect(stringifyLosslessJson(analysis.document)).toBe(before);
    expect(result.analysis).toBe(analysis);
  });

  test('exports a dedicated connectivity subpath without adding it to the main barrel', async () => {
    const manifest = JSON.parse(
      await readFile(new URL('../package.json', import.meta.url), 'utf8'),
    ) as { exports: Record<string, string> };
    const subpath = await import('@comblang/blueprint/import-connectivity');

    expect(subpath.analyzeBlueprintConnectivity).toBe(analyzeBlueprintConnectivity);
    expect(manifest.exports['./import-connectivity']).toBe('./src/import-connectivity.ts');
    expect(publicBlueprint).not.toHaveProperty('analyzeBlueprintConnectivity');
  });
});

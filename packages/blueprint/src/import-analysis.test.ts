import { readFile } from 'node:fs/promises';
import { describe, expect, test } from 'vitest';

import { classifyBlueprintDocument } from './classification.js';
import * as publicBlueprint from './index.js';
import {
  LosslessJsonArray,
  LosslessJsonObject,
  parseLosslessJson,
  stringifyLosslessJson,
} from './document.js';
import { analyzeBlueprintImport, BlueprintImportAnalysisError } from './import-analysis.js';

function classify(source: string) {
  return classifyBlueprintDocument(parseLosslessJson(source));
}

function expectAnalysisError(
  action: () => unknown,
  expected: { readonly code: 'BPI1001' | 'BPI1002'; readonly path?: string },
): void {
  let caught: unknown;
  try {
    action();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(BlueprintImportAnalysisError);
  expect(caught).toMatchObject(expected);
}

describe('blueprint import structural inventory', () => {
  test('treats omitted entities as an empty inventory without granting executable readiness', () => {
    const classification = classify('{"blueprint":{"label":"empty"}}');
    const result = analyzeBlueprintImport(classification);

    expect(result).toMatchObject({
      kind: 'blueprint',
      root: 'blueprint',
      document: classification.document,
      partial: false,
    });
    expect(result.entities).toEqual([]);
    expect(result.wires).toEqual([]);
    expect(result.diagnostics).toEqual([]);
    expect(result.coverage).toEqual([]);
    expect(result.document).toBe(classification.document);
    expect(result).not.toHaveProperty('ready');
  });

  test('reports dangling wire references when the entity list is omitted', () => {
    const result = analyzeBlueprintImport(classify('{"blueprint":{"wires":[[1,0,2,0]]}}'));
    expect(result.entities).toEqual([]);
    expect(result.partial).toBe(true);
    expect(result.diagnostics.map(({ category, path }) => [category, path])).toEqual([
      ['dangling-wire-reference', '$.blueprint.wires[0][0]'],
      ['dangling-wire-reference', '$.blueprint.wires[0][2]'],
    ]);
    expect(result.wires?.[0]?.entityReferences).toBe('unresolved');
  });

  test('accepts an explicit empty blueprint inventory without inventing wires', () => {
    const classification = classify('{"blueprint":{"entities":[]}}');
    const result = analyzeBlueprintImport(classification);

    expect(result).toMatchObject({
      kind: 'blueprint',
      entities: [],
      wires: [],
      partial: false,
      diagnostics: [],
      coverage: [],
    });
    expect(result.document).toBe(classification.document);
  });

  test('indexes explicit entity IDs and retains the reviewed raw wire tuple', () => {
    const source =
      '{"blueprint":{"entities":[' +
      '{"entity_number":17,"name":"constant","position":{"x":1.2300,"y":2},"future":9007199254740993},' +
      '{"entity_number":42,"name":"arithmetic","direction":4}' +
      '],"wires":[[17,911,42,303]]}}';
    const classification = classify(source);
    if (classification.kind !== 'blueprint') throw new Error('Expected blueprint classification.');
    const root = classification.document.get('blueprint');
    if (!(root instanceof LosslessJsonObject)) {
      throw new Error('Expected lossless blueprint root.');
    }
    const sourceEntities = root.get('entities');
    const sourceWires = root.get('wires');
    if (
      !(sourceEntities instanceof LosslessJsonArray) ||
      !(sourceWires instanceof LosslessJsonArray)
    ) {
      throw new Error('Expected lossless entity and wire arrays.');
    }

    const result = analyzeBlueprintImport(classification);

    expect(result.document).toBe(classification.document);
    expect(result.partial).toBe(false);
    expect(result.entities).toHaveLength(2);
    expect(result.entities?.map(({ entityNumber, name }) => [entityNumber, name])).toEqual([
      [17, 'constant'],
      [42, 'arithmetic'],
    ]);
    expect(result.entities?.[0]).toMatchObject({ path: '$.blueprint.entities[0]' });
    expect(result.entities?.[0]?.node).toBe(sourceEntities.items[0]);
    expect(result.entities?.[0]?.position).toBe(
      (sourceEntities.items[0] as LosslessJsonObject).get('position'),
    );
    expect(result.entities?.[1]?.direction).toBe(
      (sourceEntities.items[1] as LosslessJsonObject).get('direction'),
    );
    expect(result.wires).toHaveLength(1);
    expect(result.wires?.[0]).toMatchObject({
      path: '$.blueprint.wires[0]',
      entityReferences: 'resolved',
      endpointA: {
        entityNumber: 17,
        entityPath: '$.blueprint.wires[0][0]',
        connectorId: 911,
        connectorPath: '$.blueprint.wires[0][1]',
        connectorInterpretation: 'unresolved',
      },
      endpointB: {
        entityNumber: 42,
        entityPath: '$.blueprint.wires[0][2]',
        connectorId: 303,
        connectorPath: '$.blueprint.wires[0][3]',
        connectorInterpretation: 'unresolved',
      },
    });
    expect(result.wires?.[0]?.node).toBe(sourceWires.items[0]);
    expect(result.coverage).toEqual([]);
    expect(stringifyLosslessJson(result.document)).toBe(source);
    expect(result).not.toHaveProperty('plan');
    expect(result).not.toHaveProperty('network');
    expect(result).not.toHaveProperty('provider');
    expect(result).not.toHaveProperty('ready');
  });

  test.each(['blueprint_book', 'upgrade_planner', 'deconstruction_planner'] as const)(
    'keeps opaque %s roots document-only with an explicit coverage notice',
    (root) => {
      const classification = classify(`{"${root}":{"entities":[{"entity_number":1}]}}`);
      const result = analyzeBlueprintImport(classification);

      expect(result).toMatchObject({
        kind: 'opaque',
        root,
        document: classification.document,
        entities: undefined,
        wires: undefined,
        partial: false,
      });
      expect(result.diagnostics).toEqual([]);
      expect(result.coverage).toContainEqual(
        expect.objectContaining({
          category: 'unsupported-root',
          path: `$.${root}`,
        }),
      );
    },
  );

  test('distinguishes malformed entity rows, invalid identities, names and duplicates', () => {
    const classification = classify(
      '{"blueprint":{"entities":[' +
        '{"entity_number":7,"name":"first"},' +
        '{"entity_number":7,"name":"duplicate"},' +
        '{"entity_number":0,"name":"zero"},' +
        '{"entity_number":3.5,"name":"fraction"},' +
        '{"entity_number":9007199254740993,"name":"unsafe"},' +
        '{"entity_number":8,"name":""},' +
        'false' +
        '],"wires":[[7,901,7,902]]}}',
    );
    const result = analyzeBlueprintImport(classification);

    expect(result.partial).toBe(true);
    expect(result.entities?.map(({ entityNumber }) => entityNumber)).toEqual([7, 7]);
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          category: 'duplicate-entity-number',
          path: '$.blueprint.entities[1].entity_number',
          relatedPath: '$.blueprint.entities[0].entity_number',
          entityNumber: 7,
        }),
        expect.objectContaining({
          category: 'invalid-entity-number',
          path: '$.blueprint.entities[2].entity_number',
        }),
        expect.objectContaining({
          category: 'invalid-entity-number',
          path: '$.blueprint.entities[3].entity_number',
        }),
        expect.objectContaining({
          category: 'invalid-entity-number',
          path: '$.blueprint.entities[4].entity_number',
        }),
        expect.objectContaining({
          category: 'invalid-entity-name',
          path: '$.blueprint.entities[5].name',
        }),
        expect.objectContaining({ category: 'invalid-entity', path: '$.blueprint.entities[6]' }),
        expect.objectContaining({
          category: 'ambiguous-wire-reference',
          path: '$.blueprint.wires[0][0]',
          entityNumber: 7,
        }),
        expect.objectContaining({
          category: 'ambiguous-wire-reference',
          path: '$.blueprint.wires[0][2]',
          entityNumber: 7,
        }),
      ]),
    );
    expect(result.diagnostics.map(({ path }) => path)).toEqual([
      '$.blueprint.entities[1].entity_number',
      '$.blueprint.entities[2].entity_number',
      '$.blueprint.entities[3].entity_number',
      '$.blueprint.entities[4].entity_number',
      '$.blueprint.entities[5].name',
      '$.blueprint.entities[6]',
      '$.blueprint.wires[0][0]',
      '$.blueprint.wires[0][2]',
    ]);
    expect(result.wires?.[0]).toMatchObject({
      entityReferences: 'unresolved',
      endpointA: { entity: undefined },
      endpointB: { entity: undefined },
    });
  });

  test('reports a present non-array entities field as malformed instead of treating it as empty', () => {
    const result = analyzeBlueprintImport(classify('{"blueprint":{"entities":null}}'));

    expect(result.entities).toEqual([]);
    expect(result.partial).toBe(true);
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        category: 'invalid-entities',
        severity: 'error',
        path: '$.blueprint.entities',
      }),
    );
  });

  test('tracks valid entity IDs even when the same row has an invalid name', () => {
    const result = analyzeBlueprintImport(
      classify(
        '{"blueprint":{"entities":[' +
          '{"entity_number":8,"name":""},' +
          '{"entity_number":8,"name":"duplicate"},' +
          '{"entity_number":9,"name":""}' +
          '],"wires":[[8,101,8,102],[9,103,9,104],[99,105,8,106]]}}',
      ),
    );

    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          category: 'duplicate-entity-number',
          path: '$.blueprint.entities[1].entity_number',
          relatedPath: '$.blueprint.entities[0].entity_number',
        }),
        expect.objectContaining({
          category: 'ambiguous-wire-reference',
          path: '$.blueprint.wires[0][0]',
          entityNumber: 8,
        }),
        expect.objectContaining({
          category: 'unresolved-wire-reference',
          path: '$.blueprint.wires[1][0]',
          relatedPath: '$.blueprint.entities[2]',
          entityNumber: 9,
        }),
        expect.objectContaining({
          category: 'dangling-wire-reference',
          path: '$.blueprint.wires[2][0]',
          entityNumber: 99,
        }),
      ]),
    );
    expect(result.wires?.map(({ entityReferences }) => entityReferences)).toEqual([
      'unresolved',
      'unresolved',
      'unresolved',
    ]);
  });

  test('preserves duplicate, reversed and self wire rows without connector inference', () => {
    const classification = classify(
      '{"blueprint":{"entities":[' +
        '{"entity_number":10,"name":"a"},{"entity_number":20,"name":"b"}' +
        '],"wires":[[10,901,20,407],[20,407,10,901],[10,901,10,901]]}}',
    );
    const result = analyzeBlueprintImport(classification);

    expect(result.partial).toBe(false);
    expect(
      result.wires?.map(({ endpointA, endpointB }) => [
        endpointA.entityNumber,
        endpointA.connectorId,
        endpointB.entityNumber,
        endpointB.connectorId,
      ]),
    ).toEqual([
      [10, 901, 20, 407],
      [20, 407, 10, 901],
      [10, 901, 10, 901],
    ]);
    expect(result.wires?.every((wire) => wire.entityReferences === 'resolved')).toBe(true);
    expect(result.wires?.[0]?.endpointA.connectorInterpretation).toBe('unresolved');
    expect(result.wires?.[0]).not.toHaveProperty('color');
    expect(result.wires?.[0]).not.toHaveProperty('network');
  });

  test('separates malformed known tuples, dangling references and unsupported representations', () => {
    const classification = classify(
      '{"blueprint":{"entities":[{"entity_number":20,"name":"known",' +
        '"connections":{"1":[{"entity_id":99,"circuit_id":700}]}}],' +
        '"wires":[[20,0,20],[20,-1,20,0],[99,4,20,0],[0,0,20,0],' +
        '[20,9007199254740993,20,0],{"legacy_connections":[]} ]}}',
    );
    const result = analyzeBlueprintImport(classification);

    expect(result.partial).toBe(true);
    expect(result.wires).toHaveLength(1);
    expect(result.wires?.[0]).toMatchObject({
      entityReferences: 'unresolved',
      endpointA: { entityNumber: 99, connectorId: 4, entity: undefined },
      endpointB: { entityNumber: 20, connectorId: 0, entity: result.entities?.[0] },
    });
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ category: 'malformed-wire', path: '$.blueprint.wires[0]' }),
        expect.objectContaining({ category: 'malformed-wire', path: '$.blueprint.wires[1][1]' }),
        expect.objectContaining({
          category: 'dangling-wire-reference',
          path: '$.blueprint.wires[2][0]',
          entityNumber: 99,
        }),
        expect.objectContaining({ category: 'malformed-wire', path: '$.blueprint.wires[3][0]' }),
        expect.objectContaining({ category: 'malformed-wire', path: '$.blueprint.wires[4][1]' }),
      ]),
    );
    expect(result.coverage).toContainEqual(
      expect.objectContaining({
        category: 'unsupported-wire-representation',
        path: '$.blueprint.wires[5]',
      }),
    );
    expect(result.coverage).toContainEqual(
      expect.objectContaining({
        category: 'unsupported-wire-representation',
        path: '$.blueprint.entities[0].connections',
      }),
    );
    expect(result.coverage.map(({ path }) => path)).toEqual([
      '$.blueprint.entities[0].connections',
      '$.blueprint.wires[5]',
    ]);
  });

  test('retains top-level unsupported wire payloads without treating them as malformed JSON', () => {
    const classification = classify(
      '{"blueprint":{"entities":[],"wires":{"1":[{"entity_id":2,"circuit_id":99}]}}}',
    );
    const before = stringifyLosslessJson(classification.document);
    const result = analyzeBlueprintImport(classification);

    expect(result.diagnostics).toEqual([]);
    expect(result.coverage).toContainEqual(
      expect.objectContaining({
        category: 'unsupported-wire-representation',
        path: '$.blueprint.wires',
      }),
    );
    expect(Object.isFrozen(result.coverage)).toBe(true);
    expect(Object.isFrozen(result.coverage[0])).toBe(true);
    expect(stringifyLosslessJson(result.document)).toBe(before);
  });

  test('enforces entity and wire budgets before iteration and accepts exact boundaries', () => {
    const classification = classify(
      '{"blueprint":{"entities":[' +
        '{"entity_number":1,"name":"a"},{"entity_number":2,"name":"b"}' +
        '],"wires":[[1,0,2,0]]}}',
    );

    expect(() =>
      analyzeBlueprintImport(classification, { maxEntities: 2, maxWires: 1 }),
    ).not.toThrow();
    expectAnalysisError(() => analyzeBlueprintImport(classification, { maxEntities: 1 }), {
      code: 'BPI1001',
      path: '$.blueprint.entities',
    });
    expect(() => analyzeBlueprintImport(classification, { maxWires: 0 })).toThrow(RangeError);
    expect(() => analyzeBlueprintImport(classification, { maxWires: 0.5 })).toThrow(RangeError);
    expect(() => analyzeBlueprintImport(classification, { unbounded: true } as never)).toThrow(
      TypeError,
    );
    const accessorOptions = Object.defineProperty({}, 'maxWires', {
      get: () => 1,
    }) as never;
    expect(() => analyzeBlueprintImport(classification, accessorOptions)).toThrow(TypeError);

    const twoWireClassification = classify(
      '{"blueprint":{"entities":[],"wires":[[1,0,1,0],[1,0,1,0]]}}',
    );
    expectAnalysisError(() => analyzeBlueprintImport(twoWireClassification, { maxWires: 1 }), {
      code: 'BPI1001',
      path: '$.blueprint.wires',
    });
  });

  test('cancels pre-aborted work and observes cancellation during synchronous iteration', () => {
    const classification = classify('{"blueprint":{"entities":[{"entity_number":1,"name":"a"}]}}');
    const alreadyAborted = new AbortController();
    alreadyAborted.abort();
    expectAnalysisError(
      () => analyzeBlueprintImport(classification, { signal: alreadyAborted.signal }),
      { code: 'BPI1002' },
    );

    let reads = 0;
    const observedAbort = {
      get aborted() {
        reads += 1;
        return reads >= 3;
      },
    } as AbortSignal;
    expectAnalysisError(() => analyzeBlueprintImport(classification, { signal: observedAbort }), {
      code: 'BPI1002',
    });
    expect(reads).toBe(3);
  });

  test('freezes detached rows and diagnostics without changing the lossless source', () => {
    const source =
      '{"blueprint":{"entities":[{"entity_number":1,"name":"a","metadata":9007199254740993}],' +
      '"wires":[[1,800,99,700]],"parameters":{"future":1.2300}}}';
    const classification = classify(source);
    const result = analyzeBlueprintImport(classification);

    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.entities)).toBe(true);
    expect(Object.isFrozen(result.entities?.[0])).toBe(true);
    expect(Object.isFrozen(result.wires)).toBe(true);
    expect(Object.isFrozen(result.wires?.[0]?.endpointA)).toBe(true);
    expect(Object.isFrozen(result.diagnostics)).toBe(true);
    expect(result.diagnostics.every((entry) => Object.isFrozen(entry))).toBe(true);
    expect(result.document).toBe(classification.document);
    expect(stringifyLosslessJson(result.document)).toBe(source);
  });

  test('keeps the analyzer private to its direct module instead of package exports', async () => {
    const manifest = JSON.parse(
      await readFile(new URL('../package.json', import.meta.url), 'utf8'),
    ) as { exports: Record<string, string> };

    expect(publicBlueprint).not.toHaveProperty('analyzeBlueprintImport');
    expect(Object.values(manifest.exports)).not.toContain('./src/import-analysis.ts');
  });
});

import { classifyBlueprintDocument } from '@comblang/blueprint/classification';
import { parseLosslessJson } from '@comblang/blueprint/document';
import { analyzeBlueprintImport } from '@comblang/blueprint/import-analysis';
import { sourceFileId } from '@comblang/shared';
import { createTrustedEntityReplayContext } from './entity-replay-context.js';
import type { EntityProfile, EntityProfileId } from './entity.js';
import { syntheticZeroPortEntityProfile } from './entity-fixtures.js';
import { generateCanonicalBlueprintSource } from './blueprint-import-source-assembly.js';

import { describe, expect, test } from 'vitest';

function canonicalProfile(): EntityProfile {
  return {
    ...syntheticZeroPortEntityProfile,
    ref: {
      ...syntheticZeroPortEntityProfile.ref,
      prototypeKey: 'entity:constant-combinator',
      profileId: 'profile:canonical-constant-assembly-test' as EntityProfileId,
    },
    prototypeType: 'constant-combinator',
  };
}

const profile = canonicalProfile();
const context = createTrustedEntityReplayContext({
  database: profile.ref.database,
  source: 'synthetic',
  evidenceIdentity: 'blueprint-source-assembly-test-evidence',
  policyIdentity: 'blueprint-source-assembly-test-policy',
  profiles: [profile],
});

function constantEntity(
  entity_number: number,
  options: {
    readonly position?: unknown;
    readonly direction?: number;
    readonly omitDirection?: boolean;
    readonly extra?: Record<string, unknown>;
  } = {},
) {
  const entity: Record<string, unknown> = {
    entity_number,
    name: 'constant-combinator',
    position: options.position ?? { x: entity_number, y: 0 },
    control_behavior: {
      is_on: true,
      sections: { sections: [{ index: 1, active: true, multiplier: 1, filters: [] }] },
    },
    ...options.extra,
  };
  if (!options.omitDirection) entity.direction = options.direction ?? 4;
  return entity;
}

function prepare(blueprint: Record<string, unknown>) {
  return prepareSource(JSON.stringify({ blueprint }));
}

function prepareSource(source: string) {
  const analysis = analyzeBlueprintImport(classifyBlueprintDocument(parseLosslessJson(source)));
  const selections = (analysis.entities ?? []).map(({ entityNumber }) => ({
    entityNumber,
    profile: profile.ref,
  }));
  return { analysis, selections };
}

function generate(blueprint: Record<string, unknown>, path = 'assembly-test.factorio.ts') {
  const { analysis, selections } = prepare(blueprint);
  return generateCanonicalBlueprintSource(analysis, selections, context, { path });
}

describe('canonical blueprint full-source assembly', () => {
  test('blocks unrepresented root, entity, and placement fields with exact escaped paths', () => {
    const rootUnknown = generate({
      entities: [constantEntity(8)],
      wires: [],
      schedules: [],
    });
    expect(rootUnknown.state).toBe('blocked');
    expect(rootUnknown.diagnostics).toContainEqual(
      expect.objectContaining({
        category: 'unsupported-source-field',
        path: '$.blueprint.schedules',
      }),
    );

    const entityUnknown = generate({
      entities: [constantEntity(8, { extra: { 'bad"key': 'must not be dropped' } })],
      wires: [],
    });
    expect(entityUnknown.state).toBe('blocked');
    expect(entityUnknown.diagnostics).toContainEqual(
      expect.objectContaining({
        category: 'unsupported-source-field',
        path: '$.blueprint.entities[0]["bad\\\"key"]',
        entityNumber: 8,
      }),
    );

    const placementUnknown = generate({
      entities: [constantEntity(8, { position: { x: 1, y: 2, z: 3 } })],
      wires: [],
    });
    expect(placementUnknown.state).toBe('blocked');
    expect(placementUnknown.diagnostics).toContainEqual(
      expect.objectContaining({
        category: 'unsupported-source-placement',
        path: '$.blueprint.entities[0].position.z',
        entityNumber: 8,
      }),
    );
    expect(rootUnknown.source).toBeUndefined();
    expect(entityUnknown.correspondence).toBeUndefined();
  });

  test('retains headers as notices and requires exact coordinates and explicit direction', () => {
    const raw =
      '{"blueprint":{"item":"blueprint","version":1,"label":"document only","icons":[],"description":"not emitted","entities":[{"entity_number":71,"name":"constant-combinator","position":{"x":-0,"y":2},"direction":0,"control_behavior":{"is_on":true,"sections":{"sections":[{"index":1,"active":true,"multiplier":1,"filters":[]}]}}}],"wires":[]}}';
    const { analysis, selections } = prepareSource(raw);
    const result = generateCanonicalBlueprintSource(analysis, selections, context, {
      path: 'metadata-assembly.factorio.ts',
    });
    expect(result.state).toBe('complete');
    if (result.state !== 'complete') throw new Error('Expected source assembly to complete.');
    expect(result.retainedMetadata.map(({ path }) => path)).toEqual([
      '$.blueprint.item',
      '$.blueprint.version',
      '$.blueprint.label',
      '$.blueprint.icons',
      '$.blueprint.description',
    ]);
    expect(result.source.text).toContain('.at(-0,2,0);');
    expect(result.source.text).not.toContain('document only');

    const missingDirection = generate({
      entities: [constantEntity(9, { omitDirection: true })],
      wires: [],
    });
    expect(missingDirection.state).toBe('blocked');
    expect(missingDirection.diagnostics).toContainEqual(
      expect.objectContaining({
        category: 'unsupported-source-placement',
        path: '$.blueprint.entities[0].direction',
      }),
    );

    const inexact = generate({
      entities: [constantEntity(9, { position: { x: 0.1, y: 0 } })],
      wires: [],
    });
    expect(inexact.state).toBe('blocked');
    expect(inexact.diagnostics).toContainEqual(
      expect.objectContaining({
        category: 'unsupported-source-placement',
        path: '$.blueprint.entities[0].position.x',
      }),
    );

    for (const direction of [-1, 16, 1.5]) {
      const invalid = generate({ entities: [constantEntity(9, { direction })], wires: [] });
      expect(invalid.state).toBe('blocked');
      expect(invalid.diagnostics).toContainEqual(
        expect.objectContaining({
          category: 'unsupported-source-placement',
          path: '$.blueprint.entities[0].direction',
        }),
      );
    }
  });

  test('uses stable declarations, literal constructors, row order, and empty-source behavior', () => {
    const result = generate({
      entities: [
        constantEntity(99, { position: { x: 2, y: 3 }, direction: 15 }),
        constantEntity(3),
      ],
      wires: [],
    });
    expect(result.state).toBe('complete');
    if (result.state !== 'complete') throw new Error('Expected source assembly to complete.');
    expect(result.source.text.match(/= Constant\(/g)).toHaveLength(2);
    expect(result.source.text).toContain('const import_entity_1 = Constant(');
    expect(result.source.text).toContain('const import_entity_2 = Constant(');
    expect(result.source.text).toContain('import_entity_1.at(2,3,15);');
    expect(result.source.text).toContain('import_entity_2.at(3,0,4);');
    expect(
      result.correspondence.entities.map(({ entityNumber, name }) => [entityNumber, name]),
    ).toEqual([
      [99, 'import_entity_1'],
      [3, 'import_entity_2'],
    ]);

    const empty = generate({ entities: [], wires: [] });
    expect(empty).toMatchObject({
      state: 'complete',
      source: { text: '' },
      correspondence: { networks: [], entities: [] },
    });
  });

  test('returns immutable UTF-16 source correspondence and enforces byte limits atomically', () => {
    // The importer configuration printer retains this astral string literally.
    const source = JSON.stringify({
      blueprint: {
        entities: [
          {
            ...constantEntity(1),
            control_behavior: {
              is_on: true,
              sections: {
                sections: [{ index: 1, active: true, multiplier: 1, group: '🧪', filters: [] }],
              },
            },
          },
        ],
        wires: [],
      },
    });
    const { analysis, selections } = prepareSource(source);
    const complete = generateCanonicalBlueprintSource(analysis, selections, context, {
      path: 'astral-assembly.ts',
    });
    expect(complete.state).toBe('complete');
    if (complete.state !== 'complete') throw new Error('Expected source assembly to complete.');
    const { text } = complete.source;
    const spans = [
      ...complete.correspondence.networks.map(({ declarationSpan }) => declarationSpan),
      ...complete.correspondence.entities.flatMap(
        ({ constructionSpan, placementSpan, attachmentSpans }) => [
          constructionSpan,
          placementSpan,
          ...attachmentSpans,
        ],
      ),
    ];
    expect(spans.every(({ fileId }) => fileId === sourceFileId('astral-assembly.ts'))).toBe(true);
    for (const entity of complete.correspondence.entities) {
      expect(text.slice(entity.constructionSpan.start, entity.constructionSpan.end)).toMatch(
        /^Constant\(/,
      );
      expect(text.slice(entity.placementSpan.start, entity.placementSpan.end)).toMatch(
        /^import_entity_1\.at\(/,
      );
    }
    const placementStart = complete.correspondence.entities[0]!.placementSpan.start;
    expect(placementStart).toBe(text.indexOf('import_entity_1.at('));
    expect(new TextEncoder().encode(text.slice(0, placementStart)).byteLength).toBeGreaterThan(
      placementStart,
    );
    const byteLength = new TextEncoder().encode(text).byteLength;
    expect(
      generateCanonicalBlueprintSource(analysis, selections, context, {
        path: 'astral-assembly.ts',
        maxSourceBytes: byteLength,
      }).state,
    ).toBe('complete');
    expect(() =>
      generateCanonicalBlueprintSource(analysis, selections, context, {
        path: 'astral-assembly.ts',
        maxSourceBytes: byteLength - 1,
      }),
    ).toThrow(RangeError);
    expect(
      generateCanonicalBlueprintSource(analysis, selections, context, {
        path: 'astral-assembly.ts',
      }),
    ).toEqual(complete);
    expect(Object.isFrozen(complete)).toBe(true);
    expect(Object.isFrozen(complete.correspondence.entities[0])).toBe(true);
    expect(complete.analysis.document).toBe(analysis.document);
  });

  test('propagates cancellation and validates required host options', () => {
    const { analysis, selections } = prepare({ entities: [], wires: [] });
    const controller = new AbortController();
    controller.abort();
    expect(() =>
      generateCanonicalBlueprintSource(analysis, selections, context, {
        path: 'cancelled.ts',
        signal: controller.signal,
      }),
    ).toThrowError(expect.objectContaining({ code: 'BPI1002' }));
    expect(() =>
      generateCanonicalBlueprintSource(analysis, selections, context, { path: '' }),
    ).toThrow(/path/);
    expect(() =>
      generateCanonicalBlueprintSource(analysis, selections, context, { path: 'bad\0path.ts' }),
    ).toThrow(/path/);
    expect(() =>
      generateCanonicalBlueprintSource(analysis, selections, context, {
        path: 'bad-limit.ts',
        maxSourceBytes: 0,
      }),
    ).toThrow(RangeError);
  });
});

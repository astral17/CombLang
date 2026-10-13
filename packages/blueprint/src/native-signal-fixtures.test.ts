import { readFile } from 'node:fs/promises';
import { describe, expect, test } from 'vitest';

import { decodeBlueprintExchange, stringifyLosslessJson } from './index.js';

interface FilterJson {
  readonly type?: string;
  readonly name: string;
  readonly quality?: string;
  readonly comparator?: string;
  readonly count: number;
}

interface EntityJson {
  readonly name: string;
  readonly position?: { readonly x: number; readonly y: number };
  readonly direction?: number;
  readonly control_behavior?: {
    readonly sections?: {
      readonly sections?: readonly { readonly filters?: readonly FilterJson[] }[];
    };
  };
}

interface BlueprintDocument {
  readonly blueprint?: {
    readonly entities?: readonly EntityJson[];
    readonly parameters?: readonly Record<string, unknown>[];
    readonly wires?: readonly (readonly number[])[];
  };
}

const fixtureRoot = new URL('../../../fixtures/blueprint-exchange/', import.meta.url);

async function readBlueprint(path: string): Promise<BlueprintDocument> {
  const exchange = (await readFile(new URL(path, fixtureRoot), 'utf8')).replace(/\r?\n$/, '');
  const decoded = await decodeBlueprintExchange(exchange);
  return JSON.parse(stringifyLosslessJson(decoded)) as BlueprintDocument;
}

function constantRows(document: BlueprintDocument): readonly (readonly FilterJson[])[] {
  const entities = document.blueprint?.entities;
  if (entities === undefined) throw new Error('Fixture blueprint has no entities.');
  const constants = entities.filter((entity) => entity.name === 'constant-combinator');
  expect(constants).toHaveLength(2);
  return constants.map((entity) => {
    const sections = entity.control_behavior?.sections?.sections;
    if (sections === undefined) throw new Error('Constant fixture has no sections.');
    return sections.flatMap((section) => section.filters ?? []);
  });
}

function signalSummary(filter: FilterJson) {
  return {
    type: filter.type,
    name: filter.name,
    quality: filter.quality,
    count: filter.count,
  };
}

describe('user-supplied Factorio 2.1.21 Constant Signal transition', () => {
  test('pins A/A to parameter-0/parameter-0 to B/B and preserves unrelated rows', async () => {
    const before = await readBlueprint('factorio-2.1.21/signal-before.txt');
    const parameterized = await readBlueprint('factorio-2.1.21/signal-parameterized.txt');
    const placed = await readBlueprint('factorio-2.1.21/signal-placed.txt');
    const beforeRows = constantRows(before);
    const parameterizedRows = constantRows(parameterized);
    const placedRows = constantRows(placed);

    expect(beforeRows.map((rows) => rows.map(signalSummary))).toEqual([
      [
        { type: 'virtual', name: 'signal-A', quality: 'normal', count: 5 },
        { type: undefined, name: 'iron-plate', quality: 'normal', count: 7 },
        { type: 'fluid', name: 'water', quality: 'normal', count: 11 },
      ],
      [{ type: 'virtual', name: 'signal-A', quality: 'normal', count: 13 }],
    ]);

    const parameters = parameterized.blueprint?.parameters;
    expect(parameters).toEqual([
      {
        type: 'id',
        id: 'parameter-0',
        name: 'test',
        'quality-condition': { quality: 'normal', comparator: '=' },
      },
    ]);
    expect(parameterizedRows.map((rows) => rows.map(signalSummary))).toEqual([
      [
        { type: undefined, name: 'parameter-0', quality: 'normal', count: 5 },
        { type: undefined, name: 'iron-plate', quality: 'normal', count: 7 },
        { type: 'fluid', name: 'water', quality: 'normal', count: 11 },
      ],
      [{ type: undefined, name: 'parameter-0', quality: 'normal', count: 13 }],
    ]);
    expect(placedRows.map((rows) => rows.map(signalSummary))).toEqual([
      [
        { type: 'virtual', name: 'signal-B', quality: 'normal', count: 5 },
        { type: undefined, name: 'iron-plate', quality: 'normal', count: 7 },
        { type: 'fluid', name: 'water', quality: 'normal', count: 11 },
      ],
      [{ type: 'virtual', name: 'signal-B', quality: 'normal', count: 13 }],
    ]);
  });

  test('records the separate generated-template placement without inventing a saved checkpoint', async () => {
    const placed = await readBlueprint('factorio-2.1.21/generated-signal-placed.txt');
    const placedRows = constantRows(placed);
    expect(
      placedRows.map((rows) =>
        rows.map((row) => ({ ...signalSummary(row), comparator: row.comparator })),
      ),
    ).toEqual([
      [
        { type: 'virtual', name: 'signal-B', quality: 'normal', count: 5, comparator: '=' },
        { type: undefined, name: 'iron-plate', quality: 'normal', count: 7, comparator: '=' },
        { type: 'fluid', name: 'water', quality: 'normal', count: 11, comparator: '=' },
      ],
      [{ type: 'virtual', name: 'signal-B', quality: 'normal', count: 13, comparator: '=' }],
    ]);
    expect(placed.blueprint).not.toHaveProperty('parameters');
    expect(placed.blueprint?.wires).toEqual([[1, 1, 2, 1]]);
    expect(
      placed.blueprint?.entities?.map(({ position, direction }) => ({ position, direction })),
    ).toEqual([
      { position: { x: 16.5, y: -1.5 }, direction: 4 },
      { position: { x: 16.5, y: -0.5 }, direction: 4 },
    ]);
  });
});

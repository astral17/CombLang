import { readFile } from 'node:fs/promises';
import { describe, expect, test } from 'vitest';

import { decodeBlueprintExchange, stringifyLosslessJson } from './index.js';

interface ParameterDocument {
  readonly blueprint: {
    readonly version: number;
    readonly parameters: readonly Record<string, unknown>[];
    readonly entities: readonly Record<string, unknown>[];
  };
}

async function exportedBlueprint(name: string): Promise<ParameterDocument['blueprint']> {
  const path = new URL(
    `../../../fixtures/blueprint-exchange/factorio-2.1.17/${name}.txt`,
    import.meta.url,
  );
  const exchange = (await readFile(path, 'utf8')).trim();
  const decoded = await decodeBlueprintExchange(exchange);
  // The fixture's integers are safe; lossless lexemes are checked by the provenance suite.
  const document = JSON.parse(stringifyLosslessJson(decoded)) as ParameterDocument;
  expect(document.blueprint.version).toBe(562954249502720);
  return document.blueprint;
}

describe('exported Factorio parameter document fields', () => {
  test('retains recipe dependencies, original numeric strings, variables, and formula text', async () => {
    const blueprint = await exportedBlueprint('recipe-formulas');
    expect(blueprint.parameters.slice(0, 7)).toEqual([
      { type: 'id', name: 'Recipe', id: 'parameter-0' },
      ...Array.from({ length: 6 }, (_, index) => ({
        type: 'id',
        id: `parameter-${index + 1}`,
        'ingredient-of': 'parameter-0',
      })),
    ]);
    expect(blueprint.parameters.slice(7)).toEqual([
      { type: 'number', number: '10', name: 'Limit' },
      { type: 'number', number: '5', name: 'Multiplier', variable: 'x' },
      ...Array.from({ length: 6 }, (_, index) => ({
        type: 'number',
        number: String(111 * (index + 1)),
        formula: `x*p0_i${index + 1}`,
        dependent: true,
      })),
    ]);
    expect(blueprint.entities.find(({ name }) => name === 'assembling-machine-3')).toMatchObject({
      recipe: 'parameter-0',
      recipe_quality: 'normal',
    });
    const requester = blueprint.entities.find(({ name }) => name === 'requester-chest');
    expect(requester).toMatchObject({
      request_filters: {
        sections: [
          {
            filters: Array.from({ length: 6 }, (_, index) => ({
              name: `parameter-${index + 1}`,
              count: 111 * (index + 1),
            })),
          },
        ],
      },
    });
  });

  test('retains quality constraints and placeholders within display rich text', async () => {
    const blueprint = await exportedBlueprint('display-quality');
    expect(blueprint.parameters).toEqual([
      {
        type: 'id',
        id: 'parameter-0',
        'quality-condition': { quality: 'normal', comparator: '=' },
      },
    ]);
    expect(blueprint.entities).toHaveLength(1);
    const control = blueprint.entities[0]?.control_behavior as {
      readonly parameters: readonly {
        readonly condition: {
          readonly first_signal: { readonly name: string };
          readonly constant: number;
        };
        readonly icon: { readonly name: string };
        readonly text: string;
      }[];
    };
    // The original export omits 49; preserve its shape rather than filling the gap.
    const constants = Array.from({ length: 101 }, (_, index) => index).filter(
      (value) => value !== 49,
    );
    expect(control.parameters).toHaveLength(constants.length);
    for (const [index, row] of control.parameters.entries()) {
      expect(row.condition.first_signal).toEqual({ name: 'parameter-0' });
      expect(row.condition.constant).toBe(constants[index]);
      expect(row.icon).toEqual({ name: 'parameter-0' });
      expect(row.text).toContain('[item=parameter-0]');
    }
  });

  test('preserves ordered ingredient/product dependencies and an opaque property formula', async () => {
    const blueprint = await exportedBlueprint('dependency-chain');
    expect(blueprint.parameters).toEqual([
      { type: 'id', id: 'parameter-0' },
      { type: 'id', id: 'parameter-1', 'ingredient-of': 'parameter-0' },
      { type: 'id', id: 'parameter-2', 'item-ingredient-of': 'parameter-1' },
      { type: 'id', id: 'parameter-3', 'fluid-ingredient-of': 'parameter-2' },
      { type: 'id', id: 'parameter-4', 'product-of': 'parameter-3' },
      { type: 'id', id: 'parameter-5', 'item-product-of': 'parameter-4' },
      { type: 'number', number: '1', variable: 'x', formula: 'p1_s', dependent: true },
    ]);
    expect(blueprint.entities).toHaveLength(1);
    expect(blueprint.entities[0]).toMatchObject({
      name: 'constant-combinator',
      control_behavior: {
        sections: {
          sections: [
            {
              filters: Array.from({ length: 6 }, (_, index) => ({
                name: `parameter-${index}`,
                quality: 'normal',
                count: 1,
              })),
            },
          ],
        },
      },
    });
  });
});

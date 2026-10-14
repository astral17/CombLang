import { readFile } from 'node:fs/promises';
import { describe, expect, test } from 'vitest';

import { decodeBlueprintExchange, stringifyLosslessJson } from './index.js';

interface NumberFormulaBlueprint {
  readonly item: string;
  readonly version: number;
  readonly entities: readonly {
    readonly name: string;
    readonly position: { readonly x: number; readonly y: number };
    readonly direction: number;
    readonly control_behavior: {
      readonly sections: {
        readonly sections: readonly {
          readonly filters: readonly {
            readonly index: number;
            readonly type: string;
            readonly name: string;
            readonly quality: string;
            readonly comparator: string;
            readonly count: number;
          }[];
        }[];
      };
    };
  }[];
  readonly parameters?: readonly unknown[];
  readonly wires?: readonly unknown[];
}

describe('user-returned generated Constant numeric formula placement fixture', () => {
  test('retains the one placed normal-quality Constant and its bounded result', async () => {
    const exchange = await readFile(
      new URL(
        '../../../fixtures/blueprint-exchange/factorio-2.1.21/generated-number-formula-placed.txt',
        import.meta.url,
      ),
      'utf8',
    );
    const decoded = await decodeBlueprintExchange(exchange.trim());
    const document = JSON.parse(stringifyLosslessJson(decoded)) as {
      readonly blueprint: NumberFormulaBlueprint;
    };
    const blueprint = document.blueprint;

    expect(blueprint).toMatchObject({
      item: 'blueprint',
      version: 562954249764875,
      entities: [
        {
          name: 'constant-combinator',
          position: { x: 12.5, y: -1.5 },
          direction: 4,
        },
      ],
    });
    expect(blueprint.entities).toHaveLength(1);
    expect(blueprint.parameters).toBeUndefined();
    // The export omits wires; this is not evidence for arbitrary wired layouts.
    expect(blueprint.wires).toBeUndefined();

    const filters = blueprint.entities[0]!.control_behavior.sections.sections.flatMap(
      (section) => section.filters,
    );
    expect(filters).toEqual([
      {
        index: 1,
        type: 'virtual',
        name: 'signal-A',
        quality: 'normal',
        comparator: '=',
        count: 9,
      },
      {
        index: 2,
        type: 'virtual',
        name: 'signal-B',
        quality: 'normal',
        comparator: '=',
        count: 18,
      },
    ]);
  });
});

import type { SourceFileId } from '@comblang/shared';
import { describe, expect, test } from 'vitest';

import { emitNativeBlueprintJson } from './native-blueprint-emitter.js';
import type { NativeBlueprintFcir } from './native-blueprint-ir.js';

const source = Object.freeze({
  fileId: 'file:native-blueprint-emitter.test.ts' as SourceFileId,
  start: 1,
  end: 9,
});

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

describe('native blueprint FCIR JSON emitter', () => {
  test('preserves field order and native JSON while excluding provenance', () => {
    const fcir: NativeBlueprintFcir = deepFreeze({
      header: {
        item: 'blueprint',
        label: 'ordered',
        version: 562_949_953_421_312,
        icons: [{ signal: { type: 'item', name: 'blueprint' }, index: 1 }],
      },
      entities: [
        {
          entityNumber: 1,
          native: {
            name: 'arithmetic-combinator',
            control_behavior: { arithmetic_conditions: { operation: '+' } },
            position: { x: 0.5, y: 0.5 },
            direction: 4,
          },
          source,
        },
        {
          entityNumber: 2,
          nativeBeforeNumber: {
            recipe: 'iron-gear-wheel',
            future_native_extension: { revision: 3, flags: [true, null] },
          },
          native: {
            name: 'synthetic-zero-port',
            position: { x: 2.5, y: 0.5 },
            direction: 8,
          },
          source,
        },
      ],
      wires: [
        {
          from: { entityNumber: 1, connector: 1 },
          to: { entityNumber: 2, connector: 3 },
          source,
        },
      ],
    });

    const output = emitNativeBlueprintJson(fcir);
    expect(JSON.stringify(output)).toBe(
      '{"blueprint":{"item":"blueprint","label":"ordered","version":562949953421312,"icons":[{"signal":{"type":"item","name":"blueprint"},"index":1}],"entities":[{"entity_number":1,"name":"arithmetic-combinator","control_behavior":{"arithmetic_conditions":{"operation":"+"}},"position":{"x":0.5,"y":0.5},"direction":4},{"recipe":"iron-gear-wheel","future_native_extension":{"revision":3,"flags":[true,null]},"entity_number":2,"name":"synthetic-zero-port","position":{"x":2.5,"y":0.5},"direction":8}],"wires":[[1,1,2,3]]}}',
    );
    expect(output.blueprint.entities[0]).not.toHaveProperty('source');
  });
});

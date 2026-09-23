import type { SourceFileId } from '@comblang/shared';
import { describe, expect, test } from 'vitest';

import type { NativeBlueprintFcir } from './native-blueprint-ir.js';
import { validateNativeBlueprintFcir } from './native-blueprint-ir.js';

const entitySource = Object.freeze({
  fileId: 'file:native-blueprint-ir.test.ts' as SourceFileId,
  start: 12,
  end: 34,
});
const wireSource = Object.freeze({
  fileId: 'file:native-blueprint-ir.test.ts' as SourceFileId,
  start: 40,
  end: 55,
});

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function validFcir(): NativeBlueprintFcir {
  return deepFreeze({
    header: {
      item: 'blueprint' as const,
      label: 'test',
      version: 562_949_953_421_312,
      icons: [{ signal: { type: 'item' as const, name: 'blueprint' as const }, index: 1 as const }],
    },
    entities: [
      {
        entityNumber: 1,
        native: {
          name: 'constant-combinator',
          control_behavior: { is_on: true, sections: { sections: [] } },
          position: { x: 0.5, y: 0.5 },
          direction: 4,
        },
        source: entitySource,
      },
      {
        entityNumber: 2,
        native: {
          name: 'arithmetic-combinator',
          position: { x: 2.5, y: 0.5 },
          direction: 4,
        },
        source: entitySource,
      },
    ],
    wires: [
      {
        from: { entityNumber: 1, connector: 1 },
        to: { entityNumber: 2, connector: 3 },
        source: wireSource,
      },
    ],
  });
}

describe('native blueprint FCIR contract', () => {
  test('accepts an immutable document with explicit physical numbers and endpoints', () => {
    const candidate: unknown = validFcir();
    expect(() => validateNativeBlueprintFcir(candidate)).not.toThrow();
    validateNativeBlueprintFcir(candidate);
    const fcir: NativeBlueprintFcir = candidate;
    expect(fcir.entities.map(({ entityNumber }) => entityNumber)).toEqual([1, 2]);
    expect(fcir.wires[0]).toMatchObject({
      from: { entityNumber: 1, connector: 1 },
      to: { entityNumber: 2, connector: 3 },
    });
  });

  test('rejects duplicate physical numbers at the duplicate Entity source', () => {
    const value = validFcir();
    const duplicateSource = Object.freeze({ ...entitySource, start: 80, end: 92 });
    const candidate = deepFreeze({
      ...value,
      entities: [...value.entities, { ...value.entities[0]!, source: duplicateSource }],
    });

    expect(() => validateNativeBlueprintFcir(candidate)).toThrowError(
      expect.objectContaining({
        code: 'BP1001',
        span: duplicateSource,
        message: expect.stringContaining('Duplicate native blueprint Entity number'),
      }),
    );
  });

  test('rejects missing or invalid wire endpoints at the wire source', () => {
    const invalidSource = Object.freeze({ ...wireSource, start: 60, end: 72 });
    const missingEntity = deepFreeze({
      ...validFcir(),
      wires: [
        {
          from: { entityNumber: 1, connector: 1 },
          to: { entityNumber: 3, connector: 2 },
          source: invalidSource,
        },
      ],
    });
    expect(() => validateNativeBlueprintFcir(missingEntity)).toThrowError(
      expect.objectContaining({
        code: 'BP1001',
        span: invalidSource,
        message: expect.stringContaining('unknown Entity 3'),
      }),
    );

    const invalidConnector = deepFreeze({
      ...validFcir(),
      wires: [
        {
          from: { entityNumber: 1, connector: 0 },
          to: { entityNumber: 2, connector: 3 },
          source: invalidSource,
        },
      ],
    });
    expect(() => validateNativeBlueprintFcir(invalidConnector)).toThrowError(
      expect.objectContaining({ code: 'BP1001', span: invalidSource }),
    );
  });

  test('rejects mutable and accessor-backed native payloads without evaluating getters', () => {
    const mutablePayload = { extension: { enabled: true } };
    const base = validFcir();
    const mutableNative = Object.freeze({
      name: 'constant-combinator',
      position: Object.freeze({ x: 0.5, y: 0.5 }),
      direction: 4,
      extension: mutablePayload,
    });
    const mutableAtBoundary = Object.freeze({
      header: base.header,
      entities: Object.freeze([
        Object.freeze({ entityNumber: 1, native: mutableNative, source: entitySource }),
      ]),
      wires: base.wires,
    });
    expect(() => validateNativeBlueprintFcir(mutableAtBoundary)).toThrowError(
      expect.objectContaining({
        code: 'BP1001',
        span: entitySource,
        message: expect.stringContaining('must be immutable'),
      }),
    );

    let getterCalls = 0;
    const accessorNative = {
      name: 'constant-combinator',
      position: Object.freeze({ x: 0.5, y: 0.5 }),
      direction: 4,
    };
    Object.defineProperty(accessorNative, 'extension', {
      enumerable: true,
      get() {
        getterCalls += 1;
        return { enabled: true };
      },
    });
    Object.freeze(accessorNative);
    const accessorAtBoundary = Object.freeze({
      ...validFcir(),
      entities: Object.freeze([
        Object.freeze({ entityNumber: 1, native: accessorNative, source: entitySource }),
      ]),
      wires: Object.freeze([]),
    });
    expect(() => validateNativeBlueprintFcir(accessorAtBoundary)).toThrowError(
      expect.objectContaining({
        code: 'BP1001',
        span: entitySource,
        message: expect.stringContaining('accessors are not supported'),
      }),
    );
    expect(getterCalls).toBe(0);
  });

  test('rejects unsupported native payload values at their Entity source', () => {
    const native = Object.freeze({
      name: 'constant-combinator',
      position: Object.freeze({ x: 0.5, y: 0.5 }),
      direction: 4,
      extension: Object.freeze({ value: Number.NaN }),
    });
    const candidate = Object.freeze({
      ...validFcir(),
      entities: Object.freeze([Object.freeze({ entityNumber: 1, native, source: entitySource })]),
      wires: Object.freeze([]),
    });
    expect(() => validateNativeBlueprintFcir(candidate)).toThrowError(
      expect.objectContaining({
        code: 'BP1001',
        span: entitySource,
        message: expect.stringContaining('finite JSON number'),
      }),
    );
  });

  test('rejects excessively deep native payloads with a source-linked error', () => {
    let nested: unknown = null;
    for (let index = 0; index < 256; index += 1) {
      nested = Object.freeze({ next: nested });
    }
    const native = Object.freeze({
      name: 'constant-combinator',
      position: Object.freeze({ x: 0.5, y: 0.5 }),
      direction: 4,
      extension: nested,
    });
    const candidate = Object.freeze({
      ...validFcir(),
      entities: Object.freeze([Object.freeze({ entityNumber: 1, native, source: entitySource })]),
      wires: Object.freeze([]),
    });
    expect(() => validateNativeBlueprintFcir(candidate)).toThrowError(
      expect.objectContaining({
        code: 'BP1001',
        span: entitySource,
        message: expect.stringContaining('depth limit'),
      }),
    );
  });

  test('rejects invalid Unicode before emitting a native document', () => {
    const native = Object.freeze({
      name: 'constant-combinator',
      position: Object.freeze({ x: 0.5, y: 0.5 }),
      direction: 4,
      extension: '\ud800',
    });
    const candidate = Object.freeze({
      ...validFcir(),
      entities: Object.freeze([Object.freeze({ entityNumber: 1, native, source: entitySource })]),
      wires: Object.freeze([]),
    });
    expect(() => validateNativeBlueprintFcir(candidate)).toThrowError(
      expect.objectContaining({
        code: 'BP1001',
        span: entitySource,
        message: expect.stringContaining('unpaired high surrogate'),
      }),
    );
  });

  test('requires absent optional provenance and raw prefixes to be omitted', () => {
    const base = validFcir();
    const candidate = Object.freeze({
      header: base.header,
      entities: Object.freeze([
        Object.freeze({
          entityNumber: 1,
          nativeBeforeNumber: undefined,
          native: base.entities[0]!.native,
        }),
      ]),
      wires: Object.freeze([]),
    });
    expect(() => validateNativeBlueprintFcir(candidate)).toThrowError(
      expect.objectContaining({
        code: 'BP1001',
        message: expect.stringContaining('omit absent fields'),
      }),
    );
  });
});

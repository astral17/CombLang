import { describe, expect, test } from 'vitest';

import {
  canonicalizeEntityRawJson,
  canonicalizeEntityRawObject,
  canonicalizeEntityRawPayload,
  EntityRawJsonError,
} from './entity-raw.js';
import { entityRawJsonLimits } from './entity.js';

function errorOf(action: () => unknown): EntityRawJsonError {
  try {
    action();
  } catch (error) {
    expect(error).toBeInstanceOf(EntityRawJsonError);
    return error as EntityRawJsonError;
  }
  throw new Error('expected raw JSON validation to fail');
}

describe('strict raw Entity payload', () => {
  test('preserves unknown native keys and compiler-owned fields separately', () => {
    const input = {
      prototype: 'synthetic-entity',
      native: JSON.parse(
        '{"recipe":"iron-gear-wheel","__proto__":{"polluted":true},"enabled":false,"optional":null}',
      ),
      placement: { x: 0, y: 1, direction: 2 },
      entityNumber: 7,
    };
    const payload = canonicalizeEntityRawPayload(input, entityRawJsonLimits);

    expect(Object.keys(payload.native)).toEqual(['recipe', '__proto__', 'enabled', 'optional']);
    expect(payload.native['__proto__']).toEqual({ polluted: true });
    expect(Object.prototype).not.toHaveProperty('polluted');
    expect(payload.native.enabled).toBe(false);
    expect(payload.native.optional).toBeNull();
    expect(payload.placement).toEqual({ x: 0, y: 1, direction: 2 });
    expect(payload.entityNumber).toBe(7);
    expect(payload).not.toHaveProperty('wires');
  });

  test('isolates caller mutation and deeply freezes every snapshot', () => {
    const input = {
      prototype: 'synthetic-entity',
      native: { sections: [{ enabled: false, value: null }] },
    };
    const payload = canonicalizeEntityRawPayload(input, entityRawJsonLimits);
    const sections = payload.native.sections;
    if (!Array.isArray(sections)) throw new Error('expected canonical sections array');
    input.native.sections[0]!.enabled = true;

    expect(sections[0]).toEqual({ enabled: false, value: null });
    expect(Object.isFrozen(payload)).toBe(true);
    expect(Object.isFrozen(payload.native)).toBe(true);
    expect(Object.isFrozen(sections)).toBe(true);
    expect(Object.isFrozen(sections[0])).toBe(true);
  });

  test('rejects getters, symbols, unusual prototypes, and unsupported values without reading them', () => {
    let called = false;
    const getter = {} as Record<string, unknown>;
    Object.defineProperty(getter, 'value', {
      enumerable: true,
      get: () => {
        called = true;
        return 1;
      },
    });
    const getterError = errorOf(() => canonicalizeEntityRawJson(getter, entityRawJsonLimits));
    expect(getterError.path).toBe('$.value');
    expect(called).toBe(false);

    const symbolError = errorOf(() =>
      canonicalizeEntityRawJson(
        Object.assign({}, { value: 1 }, { [Symbol('bad')]: 2 }),
        entityRawJsonLimits,
      ),
    );
    expect(symbolError.path).toContain('Symbol(bad)');

    const unusual = Object.create(Date.prototype) as Record<string, unknown>;
    expect(errorOf(() => canonicalizeEntityRawJson(unusual, entityRawJsonLimits)).path).toBe('$');
    expect(errorOf(() => canonicalizeEntityRawJson(() => 1, entityRawJsonLimits)).code).toBe(
      'ERAW1001',
    );
    expect(errorOf(() => canonicalizeEntityRawJson(Number.NaN, entityRawJsonLimits)).path).toBe(
      '$',
    );
    expect(errorOf(() => canonicalizeEntityRawJson(1n, entityRawJsonLimits)).code).toBe('ERAW1001');
  });

  test('rejects cycles, bounds, reserved native fields, wires, and malformed placement', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(errorOf(() => canonicalizeEntityRawJson(cyclic, entityRawJsonLimits))).toMatchObject({
      code: 'ERAW1002',
      path: '$.self',
    });

    expect(
      errorOf(() => canonicalizeEntityRawJson([1, 2, 3], { ...entityRawJsonLimits, maxNodes: 2 })),
    ).toMatchObject({ code: 'ERAW1002', path: '$[1]' });
    expect(
      errorOf(() =>
        canonicalizeEntityRawJson(
          { nested: { value: 1 } },
          { ...entityRawJsonLimits, maxDepth: 1 },
        ),
      ),
    ).toMatchObject({ code: 'ERAW1002', path: '$.nested.value' });
    expect(
      errorOf(() =>
        canonicalizeEntityRawJson({ long: 'abcdef' }, { ...entityRawJsonLimits, maxBytes: 5 }),
      ),
    ).toMatchObject({ code: 'ERAW1002', path: '$' });

    for (const key of [
      'entity_id',
      'entity_number',
      'name',
      'prototype',
      'position',
      'placement',
      'direction',
      'connections',
      'connectors',
      'wires',
    ]) {
      expect(
        errorOf(() => canonicalizeEntityRawObject({ [key]: 1 }, entityRawJsonLimits)),
      ).toMatchObject({ code: 'ERAW1003', path: `$.${key}` });
      expect(
        errorOf(() =>
          canonicalizeEntityRawPayload(
            { prototype: 'synthetic-entity', native: { [key]: 1 } },
            entityRawJsonLimits,
          ),
        ),
      ).toMatchObject({ code: 'ERAW1003', path: `$.native.${key}` });
    }
    expect(
      errorOf(() =>
        canonicalizeEntityRawPayload(
          { prototype: 'synthetic-entity', native: {}, wires: [] },
          entityRawJsonLimits,
        ),
      ),
    ).toMatchObject({ code: 'ERAW1003', path: '$.wires' });
    expect(
      errorOf(() =>
        canonicalizeEntityRawPayload(
          { prototype: 'synthetic-entity', native: {}, connectors: [] },
          entityRawJsonLimits,
        ),
      ),
    ).toMatchObject({ code: 'ERAW1000', path: '$.connectors' });
    expect(
      errorOf(() =>
        canonicalizeEntityRawPayload(
          { prototype: 'synthetic-entity', native: { connectors: [] } },
          entityRawJsonLimits,
        ),
      ),
    ).toMatchObject({ code: 'ERAW1003', path: '$.native.connectors' });
    expect(
      errorOf(() =>
        canonicalizeEntityRawPayload(
          { prototype: 'synthetic-entity', native: {}, placement: { x: 0 } },
          entityRawJsonLimits,
        ),
      ),
    ).toMatchObject({ code: 'ERAW1001', path: '$.placement' });
  });

  test('keeps omitted entity number/placement distinct from explicit false and null native values', () => {
    const payload = canonicalizeEntityRawPayload(
      { prototype: 'synthetic-entity', native: { enabled: false, filter: null } },
      entityRawJsonLimits,
    );
    expect(Object.prototype.hasOwnProperty.call(payload, 'entityNumber')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(payload, 'placement')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(payload.native, 'enabled')).toBe(true);
    expect(Object.prototype.hasOwnProperty.call(payload.native, 'filter')).toBe(true);
  });
});

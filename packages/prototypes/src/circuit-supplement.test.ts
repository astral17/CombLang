import { describe, expect, test } from 'vitest';

import { applyEntityCircuitSupplement } from './circuit-supplement.js';
import { syntheticPrototypeDatabase } from './fixtures.js';
import { loadPrototypeDatabase } from './provider.js';
import { validatePrototypeDatabase } from './validation.js';

function fixture() {
  const full = validatePrototypeDatabase(syntheticPrototypeDatabase());
  const partial = {
    ...full,
    capabilities: { ...full.capabilities, entityCircuitCapabilities: false },
    entities: full.entities.map(({ circuit: _circuit, ...entity }) => entity),
  };
  const entries = full.entities.map(({ key, type, circuit }) => ({ key, type, circuit }));
  return { full, partial, entries };
}

describe('explicit entity circuit coverage', () => {
  test('does not confuse unknown, unsupported and supported entities in a partial database', async () => {
    const { full, partial } = fixture();
    const supported = full.entities[0]!;
    const unsupported = {
      ...full.entities[1]!,
      circuit: Object.fromEntries(Object.keys(supported.circuit!).map((key) => [key, false])),
    };
    const unknown = { ...partial.entities[0]!, key: 'entity:unprobed', name: 'unprobed' };
    const { prototypes } = await loadPrototypeDatabase({
      ...partial,
      entities: [supported, unsupported, unknown],
    });
    expect(prototypes.capabilities.entityCircuitCapabilities).toBe(false);
    expect(prototypes.entityCircuitCapabilities(supported.name).setRecipe).toBe(true);
    expect(prototypes.entityCircuitCapabilities(unsupported.key).setRecipe).toBe(false);
    expect(Object.isFrozen(prototypes.entityCircuitCapabilities(supported.key))).toBe(true);
    expect(prototypes.entity.unprobed!.circuit).toBeUndefined();
    expect(() => prototypes.entityCircuitCapabilities('unprobed')).toThrow(
      'data for entity:unprobed',
    );
    expect(() => prototypes.entityCircuitCapabilities('missing')).toThrow(
      'Unknown entity prototype: missing.',
    );
  });

  test('requires explicit rows for full coverage and reports the original array position', () => {
    const { full, partial } = fixture();
    expect(() =>
      validatePrototypeDatabase({ ...full, entities: [full.entities[1], partial.entities[0]] }),
    ).toThrowError(expect.objectContaining({ code: 'PT1004', path: 'entities[1].circuit' }));
    expect(() =>
      validatePrototypeDatabase({
        ...full,
        capabilities: { ...full.capabilities, entities: false },
      }),
    ).toThrowError(
      expect.objectContaining({ code: 'PT1004', path: 'capabilities.entityCircuitCapabilities' }),
    );
  });

  test('does not expose stored circuit rows through the helper when entity coverage is unavailable', async () => {
    const { full } = fixture();
    const { prototypes } = await loadPrototypeDatabase({
      ...full,
      capabilities: { ...full.capabilities, entities: false, entityCircuitCapabilities: false },
    });
    expect(() => prototypes.entityCircuitCapabilities(full.entities[0]!.key)).toThrow(
      'does not provide entities data',
    );
  });
});

describe('identity-bound circuit supplements', () => {
  test('accumulates partial records, updates identity, and marks complete coverage only at the end', async () => {
    const { partial, entries } = fixture();
    const base = await loadPrototypeDatabase(partial);
    const supplement = {
      schemaVersion: 1,
      baseIdentity: base.prototypes.identity,
      entities: [entries[0]],
    };
    const first = await loadPrototypeDatabase(
      await applyEntityCircuitSupplement(partial, supplement),
    );
    expect(first.database.capabilities.entityCircuitCapabilities).toBe(false);
    expect(first.prototypes.identity).not.toBe(base.prototypes.identity);
    expect(first.database.entities[0]!.circuit).toEqual(entries[0]!.circuit);
    expect(first.database.entities[1]!.circuit).toBeUndefined();
    expect(base.database.entities.every(({ circuit }) => circuit === undefined)).toBe(true);
    const final = await applyEntityCircuitSupplement(first.database, {
      ...supplement,
      baseIdentity: first.prototypes.identity,
      entities: [entries[1]],
    });
    expect(final.capabilities.entityCircuitCapabilities).toBe(true);
    expect(final.recipes).toEqual(base.database.recipes);
    expect(final.environment).toEqual(base.database.environment);
    const roundTrip = await loadPrototypeDatabase(JSON.parse(JSON.stringify(final)));
    expect(roundTrip.prototypes.entityCircuitCapabilities(entries[1]!.key)).toEqual(
      entries[1]!.circuit,
    );
    const unchanged = await loadPrototypeDatabase(
      await applyEntityCircuitSupplement(final, {
        ...supplement,
        baseIdentity: roundTrip.prototypes.identity,
        entities: entries,
      }),
    );
    expect(unchanged.prototypes.identity).toBe(roundTrip.prototypes.identity);
  });

  test('is independent of supplement row/property order and copies external records', async () => {
    const { partial, entries } = fixture();
    const base = await loadPrototypeDatabase(partial);
    const input = {
      schemaVersion: 1,
      baseIdentity: base.prototypes.identity,
      entities: structuredClone(entries),
    };
    const a = await loadPrototypeDatabase(await applyEntityCircuitSupplement(partial, input));
    const b = await loadPrototypeDatabase(
      await applyEntityCircuitSupplement(partial, {
        ...input,
        entities: [...entries].reverse().map((entry) => ({
          ...entry,
          circuit: Object.fromEntries(Object.entries(entry.circuit!).reverse()),
        })),
      }),
    );
    expect(a.prototypes.identity).toBe(b.prototypes.identity);
    Object.assign(input.entities[0]!.circuit!, { setRecipe: false });
    expect(a.database.entities[0]!.circuit!.setRecipe).toBe(true);
  });

  test('rejects stale identity even when names and types still match', async () => {
    const { partial, entries } = fixture();
    const base = await loadPrototypeDatabase(partial);
    const changed = {
      ...partial,
      environment: { ...partial.environment, startupSettingsIdentity: 'changed' },
    };
    await expect(
      applyEntityCircuitSupplement(changed, {
        schemaVersion: 1,
        baseIdentity: base.prototypes.identity,
        entities: entries,
      }),
    ).rejects.toMatchObject({ code: 'PC1002', path: 'baseIdentity' });
  });

  test('rejects conflicting facts instead of overwriting an existing row', async () => {
    const { full, entries } = fixture();
    const base = await loadPrototypeDatabase(full);
    await expect(
      applyEntityCircuitSupplement(full, {
        schemaVersion: 1,
        baseIdentity: base.prototypes.identity,
        entities: [{ ...entries[0], circuit: { ...entries[0]!.circuit, setRecipe: false } }],
      }),
    ).rejects.toMatchObject({ code: 'PC1003', path: 'entities[0].circuit' });
  });

  test.each([
    [null, 'PC1001', '<supplement>'],
    [{ schemaVersion: 2 }, 'PC1000', 'schemaVersion'],
    [{ baseIdentity: 'unbound' }, 'PC1001', 'baseIdentity'],
    [{ entities: [] }, 'PC1001', 'entities'],
    [{ entities: [null] }, 'PC1001', 'entities[0]'],
    [{ entities: [{ key: 'chemical-plant' }] }, 'PC1001', 'entities[0].key'],
    [{ entities: [{ key: 'entity:missing' }] }, 'PC1003', 'entities[0].key'],
    [{ entities: [{ key: 'entity:chemical-plant', type: 'lamp' }] }, 'PC1003', 'entities[0].type'],
    [
      { entities: [{ key: 'entity:chemical-plant', type: 'assembling-machine', circuit: {} }] },
      'PC1001',
      'entities[0].circuit.read',
    ],
  ])('rejects malformed supplement %j', async (overrides, code, path) => {
    const { partial, entries } = fixture();
    const base = await loadPrototypeDatabase(partial);
    const input =
      overrides === null
        ? null
        : {
            schemaVersion: 1,
            baseIdentity: base.prototypes.identity,
            entities: entries,
            ...overrides,
          };
    await expect(applyEntityCircuitSupplement(partial, input)).rejects.toMatchObject({
      code,
      path,
    });
  });

  test('rejects duplicates, non-boolean flags and missing entity coverage', async () => {
    const { partial, entries } = fixture();
    const base = await loadPrototypeDatabase(partial);
    const input = {
      schemaVersion: 1,
      baseIdentity: base.prototypes.identity,
      entities: [entries[0], entries[0]],
    };
    await expect(applyEntityCircuitSupplement(partial, input)).rejects.toMatchObject({
      code: 'PC1003',
      path: 'entities[1].key',
    });
    await expect(
      applyEntityCircuitSupplement(partial, {
        ...input,
        entities: [{ ...entries[0], circuit: { ...entries[0]!.circuit, setRecipe: 1 } }],
      }),
    ).rejects.toMatchObject({ code: 'PC1001', path: 'entities[0].circuit.setRecipe' });
    const hidden = await loadPrototypeDatabase({
      ...partial,
      capabilities: { ...partial.capabilities, entities: false },
    });
    await expect(
      applyEntityCircuitSupplement(hidden.database, {
        ...input,
        baseIdentity: hidden.prototypes.identity,
      }),
    ).rejects.toMatchObject({ code: 'PC1003', path: 'entities' });
  });
});

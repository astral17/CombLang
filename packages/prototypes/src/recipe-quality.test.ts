import { expect, test } from 'vitest';
import { syntheticPrototypeDatabase } from './fixtures.js';
import { loadPrototypeDatabase } from './provider.js';
import { validatePrototypeDatabase } from './validation.js';

function fixture(
  fields: Record<string, unknown> = {},
  role: 'ingredients' | 'products' = 'products',
  fluid = false,
) {
  const base = validatePrototypeDatabase(syntheticPrototypeDatabase());
  return {
    ...base,
    qualities: [
      { key: 'quality:normal', name: 'normal', level: 0, next: 'quality:rare' },
      { key: 'quality:rare', name: 'rare', level: 2, next: null },
      { key: 'quality:other', name: 'other', level: 1, next: null },
    ],
    recipes: base.recipes.map((recipe) =>
      recipe.name !== (fluid ? 'water-cycle' : 'iron-gear-wheel')
        ? recipe
        : {
            ...recipe,
            [role]: recipe[role].map((component, index) =>
              index !== 0 ? component : { ...component, ...fields },
            ),
          },
    ),
  };
}

test.each([
  [{ qualityChange: -129 }, 'PT1001'],
  [{ qualityChange: 128 }, 'PT1001'],
  [{ qualityChange: 0.5 }, 'PT1001'],
  [{ qualityChange: NaN }, 'PT1001'],
  [{ affectedByQuality: 0 }, 'PT1001'],
  [{ qualityMin: 'normal' }, 'PT1002'],
  [{ qualityMax: 'quality:' }, 'PT1002'],
  [{ qualityMin: 'quality:missing' }, 'PT1004'],
])('rejects invalid quality metadata %j', (fields, code) => {
  expect(() => validatePrototypeDatabase(fixture(fields))).toThrowError(
    expect.objectContaining({ code, path: expect.stringContaining('products[0]') }),
  );
});

test('limits quality roll control to item products and other quality fields to items', () => {
  expect(() =>
    validatePrototypeDatabase(fixture({ affectedByQuality: false }, 'ingredients')),
  ).toThrowError(expect.objectContaining({ code: 'PT1004' }));
  for (const role of ['ingredients', 'products'] as const) {
    for (const fields of [
      { affectedByQuality: false },
      { qualityChange: 0 },
      { qualityMin: 'quality:normal' },
      { qualityMax: 'quality:rare' },
    ]) {
      expect(() => validatePrototypeDatabase(fixture(fields, role, true))).toThrowError(
        expect.objectContaining({ code: 'PT1004' }),
      );
    }
  }
});

test('uses explicit next edges instead of numeric level ordering for quality bounds', () => {
  for (const role of ['ingredients', 'products'] as const) {
    expect(() =>
      validatePrototypeDatabase(
        fixture({ qualityMin: 'quality:normal', qualityMax: 'quality:rare' }, role),
      ),
    ).not.toThrow();
    expect(() =>
      validatePrototypeDatabase(
        fixture({ qualityMin: 'quality:normal', qualityMax: 'quality:other' }, role),
      ),
    ).toThrowError(
      expect.objectContaining({ code: 'PT1004', path: expect.stringContaining('.qualityMax') }),
    );
    expect(() =>
      validatePrototypeDatabase(
        fixture({ qualityMin: 'quality:rare', qualityMax: 'quality:normal' }, role),
      ),
    ).toThrowError(expect.objectContaining({ code: 'PT1004' }));
    const equal = fixture(
      { qualityChange: -128, qualityMin: 'quality:normal', qualityMax: 'quality:normal' },
      role,
    );
    expect(
      validatePrototypeDatabase(equal).recipes.find(({ name }) => name === 'iron-gear-wheel')![
        role
      ][0]!.qualityChange,
    ).toBe(-128);
  }
  const differentLevels = fixture({ qualityMin: 'quality:normal', qualityMax: 'quality:rare' });
  differentLevels.qualities[0]!.level = 10;
  expect(() => validatePrototypeDatabase(differentLevels)).not.toThrow();
});

test('does not invent missing endpoints or interpret legacy omitted next as terminal', () => {
  for (const fields of [
    { qualityMin: 'quality:rare' },
    { qualityMax: 'quality:normal' },
    { qualityChange: 127 },
  ]) {
    expect(() => validatePrototypeDatabase(fixture(fields))).not.toThrow();
  }
  const partial = fixture({ qualityMin: 'quality:normal', qualityMax: 'quality:other' });
  const qualities = partial.qualities.map(({ next: _next, ...quality }) => quality);
  const validated = validatePrototypeDatabase({ ...partial, qualities });
  expect(validated.qualities[0]).not.toHaveProperty('next');
});

test('checks dangling links, malformed keys and cycles including disconnected chains', () => {
  for (const next of ['quality:missing', 'quality:normal']) {
    const raw = fixture();
    raw.qualities[0]!.next = next;
    expect(() => validatePrototypeDatabase(raw)).toThrowError(
      expect.objectContaining({ code: 'PT1004', path: expect.stringContaining('qualities.') }),
    );
  }
  const cycle = fixture();
  cycle.qualities[1]!.next = 'quality:normal';
  expect(() => validatePrototypeDatabase(cycle)).toThrowError(
    expect.objectContaining({ code: 'PT1004' }),
  );
  const malformed = fixture();
  malformed.qualities[1]!.next = 'rare';
  expect(() => validatePrototypeDatabase(malformed)).toThrowError(
    expect.objectContaining({ code: 'PT1002', path: 'qualities[1].next' }),
  );
});

test('includes explicit quality facts and terminal markers in identity without filling defaults', async () => {
  const base = await loadPrototypeDatabase(fixture());
  for (const fields of [
    { affectedByQuality: false },
    { affectedByQuality: true },
    { qualityChange: 0 },
    { qualityMin: 'quality:normal' },
    { qualityMax: 'quality:rare' },
  ]) {
    const loaded = await loadPrototypeDatabase(fixture(fields));
    expect(loaded.prototypes.identity).not.toBe(base.prototypes.identity);
    expect(loaded.prototypes.recipe['iron-gear-wheel']!.products[0]).toMatchObject(fields);
    expect(Object.isFrozen(loaded.prototypes.quality.normal)).toBe(true);
  }
  const raw = fixture();
  const unknown = await loadPrototypeDatabase({
    ...raw,
    qualities: raw.qualities.map(({ next: _next, ...quality }) => quality),
  });
  expect(unknown.prototypes.identity).not.toBe(base.prototypes.identity);
});

import { describe, expect, test } from 'vitest';

import {
  blueprintSchemaCatalog,
  blueprintSchemaCatalogMaxDepth,
  blueprintSchemaCatalogMaxJsonBytes,
  blueprintSchemaCatalogMaxNodes,
  loadBlueprintSchemaCatalog,
  loadBlueprintSchemaCatalogJson,
} from './blueprint-schema-loader.js';

function mutableCatalog(): Record<string, any> {
  return structuredClone(blueprintSchemaCatalog) as Record<string, any>;
}

describe('Blueprint schema catalog loader', () => {
  test('loads the pinned catalog as detached deeply frozen data', () => {
    expect(blueprintSchemaCatalog.counts).toEqual({
      entityVariants: 62,
      controlBehaviors: 37,
      referencedSchemas: 113,
    });
    expect(Object.isFrozen(blueprintSchemaCatalog)).toBe(true);
    expect(Object.isFrozen(blueprintSchemaCatalog.common)).toBe(true);

    const input = mutableCatalog();
    const loaded = loadBlueprintSchemaCatalog(input);
    input.warning = 'changed';
    input.common.fields[0].name = 'changed';

    expect(loaded.warning).not.toBe('changed');
    expect(loaded.common.kind === 'object' && loaded.common.fields[0]?.name).toBe(
      'burner_fuel_inventory',
    );
    expect(Object.isFrozen(loaded.references[0])).toBe(true);
    expect(Object.isFrozen(loaded.references[0]?.type)).toBe(true);
  });

  test.each([
    ['snapshot', 'fixtures/2.1.18'],
    ['applicationVersion', '2.1.18'],
    ['apiVersion', 7],
    ['runtimeSha256', '0'.repeat(64)],
    ['prototypeSha256', 'f'.repeat(64)],
  ])('rejects a catalog with a changed source identity field: %s', (field, replacement) => {
    const value = mutableCatalog();
    value.source[field] = replacement;
    expect(() => loadBlueprintSchemaCatalog(value)).toThrow(
      `<catalog>.source.${field}: does not match the expected source identity.`,
    );
  });

  test.each([
    [
      'unknown blueprint type',
      (value: Record<string, any>) => {
        value.controlBehaviors[0].blueprintType = 'MissingBlueprintControlBehavior';
      },
      '<catalog>.controlBehaviors[0].blueprintType',
    ],
    [
      'divergent embedded schema',
      (value: Record<string, any>) => {
        value.controlBehaviors[0].schema = { kind: 'literal', value: true };
      },
      '<catalog>.controlBehaviors[0].schema',
    ],
    [
      'unrelated known variant',
      (value: Record<string, any>) => {
        value.controlBehaviors[0].entityVariants.push('car');
      },
      '<catalog>.controlBehaviors[0].entityVariants',
    ],
    [
      'missing expected variant',
      (value: Record<string, any>) => {
        value.controlBehaviors[0].entityVariants = [];
      },
      '<catalog>.controlBehaviors[0].entityVariants',
    ],
  ])('rejects %s in behavior cross-links', (_label, mutate, path) => {
    const value = mutableCatalog();
    mutate(value);
    expect(() => loadBlueprintSchemaCatalog(value)).toThrow(path);
  });

  test.each([
    [
      'unknown catalog key',
      () => {
        const value = mutableCatalog();
        value.unexpected = true;
        return value;
      },
    ],
    [
      'unknown descriptor kind',
      () => {
        const value = mutableCatalog();
        value.common.kind = 'function';
        return value;
      },
    ],
    [
      'duplicate variant',
      () => {
        const value = mutableCatalog();
        value.variants.push(structuredClone(value.variants[0]));
        return value;
      },
    ],
    [
      'dangling reference',
      () => {
        const value = mutableCatalog();
        value.references[0].type = { kind: 'reference', name: 'missing' };
        return value;
      },
    ],
  ])('rejects %s', (_label, create) => {
    expect(() => loadBlueprintSchemaCatalog(create())).toThrow();
  });

  test('rejects accessors without executing them', () => {
    const value = mutableCatalog();
    Object.defineProperty(value, 'unexpected', {
      enumerable: true,
      get() {
        throw new Error('getter executed');
      },
    });
    expect(() => loadBlueprintSchemaCatalog(value)).toThrow(/accessors are not allowed/);
  });

  test('rejects cycles, excessive depth, node count and JSON bytes', () => {
    const cyclic = mutableCatalog();
    cyclic.common = { kind: 'array' };
    cyclic.common.items = cyclic.common;
    expect(() => loadBlueprintSchemaCatalog(cyclic)).toThrow(/cyclic data/);

    const deep = mutableCatalog();
    let node: any = { kind: 'literal', value: true };
    for (let index = 0; index <= blueprintSchemaCatalogMaxDepth; index += 1) {
      node = { kind: 'array', items: node };
    }
    deep.common = node;
    expect(() => loadBlueprintSchemaCatalog(deep)).toThrow(/depth limit/);

    const many = mutableCatalog();
    many.references = Array.from({ length: blueprintSchemaCatalogMaxNodes }, (_, index) => ({
      name: `reference-${index}`,
      type: { kind: 'literal', value: true },
    }));
    many.counts.referencedSchemas = many.references.length;
    expect(() => loadBlueprintSchemaCatalog(many)).toThrow(/node limit/);

    expect(() =>
      loadBlueprintSchemaCatalogJson(
        JSON.stringify('x'.repeat(blueprintSchemaCatalogMaxJsonBytes)),
      ),
    ).toThrow(/byte limit/);
  });
});

import builtinPrototypeDatabase from '../generated/space-age-2.1.17.json';
import { describe, expect, test } from 'vitest';
import { loadPrototypeDatabase } from './provider.js';
import { resolveBlueprintEntitySchema } from './blueprint-schema-resolution.js';

describe('Blueprint Entity schema resolution', () => {
  test('combines common fields with the exact documented variant', () => {
    const resolved = resolveBlueprintEntitySchema({ type: 'assembling-machine' });

    expect(resolved).toMatchObject({
      kind: 'resolved',
      lookup: 'blueprint-entity-schema',
      prototypeType: 'assembling-machine',
      structuralStatus: 'documented-variant',
      variant: { name: 'assembling-machine' },
    });
    expect(resolved.commonFields.map(({ name }) => name)).toContain('entity_number');
    expect(resolved.variantFields.map(({ name }) => name)).toEqual([
      'control_behavior',
      'recipe',
      'recipe_quality',
    ]);
    expect(resolved.fields.map(({ name }) => name)).toEqual(
      [...resolved.fields].map(({ name }) => name).sort(),
    );
  });

  test('resolves provider-known common-only types from their actual type field', async () => {
    const { prototypes } = await loadPrototypeDatabase(builtinPrototypeDatabase);
    for (const name of [
      'beacon',
      'big-electric-pole',
      'solar-panel',
      'straight-rail',
      'thruster',
    ]) {
      const prototype = prototypes.getEntity(name);
      expect(prototype, name).toBeDefined();
      const resolved = resolveBlueprintEntitySchema(prototype!);
      expect(resolved).toMatchObject({
        prototypeType: prototype!.type,
        structuralStatus: 'documented-common-only',
      });
      expect(resolved.variant).toBeUndefined();
      expect(resolved.variantFields).toEqual([]);
      expect(resolved.fields).toEqual(resolved.commonFields);
    }
    expect(prototypes.getEntity('definitely-not-a-provider-prototype')).toBeUndefined();
  });

  test('does not turn an unrecognized prototype name into provider evidence', async () => {
    const { prototypes } = await loadPrototypeDatabase(builtinPrototypeDatabase);
    expect(prototypes.getEntity('beacon-that-is-not-present')).toBeUndefined();
    expect(resolveBlueprintEntitySchema({ type: 'modded-entity-type' }).structuralStatus).toBe(
      'documented-common-only',
    );
  });
});

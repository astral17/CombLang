import { describe, expect, test } from 'vitest';

import {
  createBlueprintSchemaLookup,
  lookupBlueprintControlBehavior,
  lookupBlueprintEntityVariant,
} from './blueprint-schema-lookup.js';

describe('Blueprint schema lookup', () => {
  test('returns common and variant-specific fields for a documented variant', () => {
    const result = lookupBlueprintEntityVariant('assembling-machine');
    expect(result).toMatchObject({
      kind: 'known',
      lookup: 'blueprint-entity-variant',
      structuralStatus: 'documented',
      name: 'assembling-machine',
    });
    if (result.kind !== 'known') throw new Error('expected known variant');
    expect(result.commonFields.map(({ name }) => name)).toContain('position');
    expect(result.variantFields.map(({ name }) => name)).toEqual([
      'control_behavior',
      'recipe',
      'recipe_quality',
    ]);
    expect(Object.isFrozen(result)).toBe(true);
  });

  test('recognizes documented entity variants without control behavior fields', () => {
    for (const name of [
      'locomotive',
      'cargo-wagon',
      'car',
      'underground-belt',
      'linked-container',
    ]) {
      expect(lookupBlueprintEntityVariant(name)).toMatchObject({
        kind: 'known',
        name,
        structuralStatus: 'documented',
      });
    }
    expect(lookupBlueprintEntityVariant('modded-machine').kind).toBe('unknown');
  });

  test('classifies a concrete and shared behavior without implementation claims', () => {
    const concrete = lookupBlueprintControlBehavior('AssemblingMachineBlueprintControlBehavior');
    expect(concrete).toMatchObject({
      kind: 'known',
      structuralStatus: 'documented',
      runtimeClass: 'LuaAssemblingMachineControlBehavior',
      entityVariants: ['assembling-machine'],
    });
    const shared = lookupBlueprintControlBehavior('GenericOnOffBlueprintControlBehavior');
    expect(shared).toMatchObject({
      kind: 'known',
      structuralStatus: 'documented-shared',
      entityVariants: ['offshore-pump', 'power-switch'],
    });
  });

  test('returns explicit unknown results for modded or unsupported names', () => {
    expect(lookupBlueprintEntityVariant('modded-machine')).toEqual({
      kind: 'unknown',
      lookup: 'blueprint-entity-variant',
      requestedName: 'modded-machine',
      structuralStatus: 'unknown-or-modded',
      reason: 'not-in-pinned-catalog',
    });
    expect(lookupBlueprintControlBehavior('ModdedBlueprintControlBehavior')).toMatchObject({
      kind: 'unknown',
      structuralStatus: 'unknown-or-modded',
      reason: 'not-in-pinned-catalog',
    });
  });

  test('can build an isolated lookup over a validated catalog', () => {
    const lookup = createBlueprintSchemaLookup();
    expect(lookup.entityVariant('train-stop').kind).toBe('known');
    expect(lookup.controlBehavior('RailSignalBaseBlueprintControlBehavior').kind).toBe('known');
  });
});

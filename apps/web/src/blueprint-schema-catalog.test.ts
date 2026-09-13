import { describe, expect, test } from 'vitest';

import { builtinBlueprintSchemaCatalog } from './blueprint-schema-catalog.js';

describe('web Blueprint schema catalog consumer', () => {
  test('uses the validated built-in catalog through the prototypes package', () => {
    expect(builtinBlueprintSchemaCatalog.counts).toMatchObject({
      entityVariants: 62,
      controlBehaviors: 37,
    });
    expect(Object.isFrozen(builtinBlueprintSchemaCatalog)).toBe(true);
  });
});

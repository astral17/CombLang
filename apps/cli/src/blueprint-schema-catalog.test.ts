import { describe, expect, test } from 'vitest';

import {
  blueprintSchemaCatalog,
  lookupBlueprintControlBehavior,
  lookupBlueprintEntityVariant,
} from '@comblang/prototypes';

describe('Node Blueprint schema catalog consumer', () => {
  test('loads the validated catalog through the prototypes package entry point', () => {
    expect(blueprintSchemaCatalog.source.applicationVersion).toBe('2.1.17');
    expect(blueprintSchemaCatalog.counts.entityVariants).toBe(62);
    expect(lookupBlueprintEntityVariant('container').kind).toBe('known');
    expect(lookupBlueprintEntityVariant('locomotive').kind).toBe('known');
    expect(lookupBlueprintControlBehavior('ModdedBlueprintControlBehavior').kind).toBe('unknown');
  });
});

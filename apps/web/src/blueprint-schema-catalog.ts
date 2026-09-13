import { blueprintSchemaCatalog } from '@comblang/prototypes';

/**
 * The web shell consumes the validated built-in catalog through the package
 * entry point. It is intentionally not sent through compiler Worker messages.
 */
export const builtinBlueprintSchemaCatalog = blueprintSchemaCatalog;

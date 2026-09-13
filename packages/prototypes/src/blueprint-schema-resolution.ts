import { blueprintSchemaCatalog } from './blueprint-schema-loader.js';
import type {
  BlueprintSchemaCatalog,
  BlueprintSchemaDescriptor,
  BlueprintSchemaField,
  BlueprintSchemaNamedReference,
  BlueprintSchemaVariant,
} from './blueprint-schema.js';
import type { EntityPrototype } from './schema.js';

export type BlueprintEntitySchemaStructuralStatus = 'documented-variant' | 'documented-common-only';

/**
 * The schema selected for one actual provider Entity prototype. Provider
 * membership and the prototype's type are the Entity identity evidence;
 * familiar names alone never select this result.
 */
export interface ResolvedBlueprintEntitySchema {
  readonly kind: 'resolved';
  readonly lookup: 'blueprint-entity-schema';
  readonly prototypeType: string;
  readonly structuralStatus: BlueprintEntitySchemaStructuralStatus;
  readonly common: Extract<BlueprintSchemaDescriptor, { kind: 'object' }>;
  readonly commonFields: readonly BlueprintSchemaField[];
  readonly variant?: BlueprintSchemaVariant;
  readonly variantFields: readonly BlueprintSchemaField[];
  readonly fields: readonly BlueprintSchemaField[];
  readonly references: readonly BlueprintSchemaNamedReference[];
}

function codeUnitCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/** Resolves common fields plus the exact API variant for an actual prototype type. */
export function resolveBlueprintEntitySchema(
  prototype: Pick<EntityPrototype, 'type'>,
  catalog: BlueprintSchemaCatalog = blueprintSchemaCatalog,
): ResolvedBlueprintEntitySchema {
  if (
    prototype === null ||
    typeof prototype !== 'object' ||
    typeof prototype.type !== 'string' ||
    prototype.type.length === 0
  ) {
    throw new TypeError('Blueprint Entity schema resolution requires an actual prototype type.');
  }
  const common = catalog.common;
  if (common.kind !== 'object') {
    throw new Error('Blueprint schema catalog common must be an object descriptor.');
  }
  const variant = catalog.variants.find(({ name }) => name === prototype.type);
  const variantFields = Object.freeze(variant?.fields ?? []);
  const commonNames = new Set(common.fields.map(({ name }) => name));
  const collision = variantFields.find(({ name }) => commonNames.has(name));
  if (collision !== undefined) {
    throw new Error(
      `Blueprint schema variant ${JSON.stringify(prototype.type)} collides with common field ${JSON.stringify(collision.name)}.`,
    );
  }
  return Object.freeze({
    kind: 'resolved',
    lookup: 'blueprint-entity-schema',
    prototypeType: prototype.type,
    structuralStatus: variant === undefined ? 'documented-common-only' : 'documented-variant',
    common,
    commonFields: common.fields,
    ...(variant === undefined ? {} : { variant }),
    variantFields,
    fields: Object.freeze(
      [...common.fields, ...variantFields].sort((left, right) =>
        codeUnitCompare(left.name, right.name),
      ),
    ),
    references: catalog.references,
  });
}

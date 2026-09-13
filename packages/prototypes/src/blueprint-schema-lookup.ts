import { blueprintSchemaCatalog } from './blueprint-schema-loader.js';
import type {
  BlueprintSchemaCatalog,
  BlueprintSchemaDescriptor,
  BlueprintSchemaField,
  BlueprintSchemaVariant,
} from './blueprint-schema.js';

export type BlueprintSchemaLookupStatus = 'documented' | 'documented-shared' | 'unknown-or-modded';

interface BlueprintSchemaLookupBase {
  readonly kind: 'known' | 'unknown';
  readonly requestedName: string;
  readonly structuralStatus: BlueprintSchemaLookupStatus;
}

export interface KnownBlueprintEntityVariant extends BlueprintSchemaLookupBase {
  readonly kind: 'known';
  readonly lookup: 'blueprint-entity-variant';
  readonly name: string;
  readonly common: Extract<BlueprintSchemaDescriptor, { kind: 'object' }>;
  readonly commonFields: readonly BlueprintSchemaField[];
  readonly variant: BlueprintSchemaVariant;
  readonly variantFields: readonly BlueprintSchemaField[];
  readonly implementationStatus: 'unassessed-per-field';
  readonly nativeEvidenceStatus: 'not-captured-by-catalog';
}

export interface UnknownBlueprintEntityVariant extends BlueprintSchemaLookupBase {
  readonly kind: 'unknown';
  readonly lookup: 'blueprint-entity-variant';
  readonly structuralStatus: 'unknown-or-modded';
  readonly reason: 'not-in-pinned-catalog';
}

export type BlueprintEntityVariantLookup =
  KnownBlueprintEntityVariant | UnknownBlueprintEntityVariant;

export interface KnownBlueprintControlBehavior extends BlueprintSchemaLookupBase {
  readonly kind: 'known';
  readonly lookup: 'blueprint-control-behavior';
  readonly name: string;
  readonly schema: BlueprintSchemaDescriptor;
  readonly entityVariants: readonly string[];
  readonly runtimeClass?: string;
  readonly implementationStatus: 'unassessed-per-field';
  readonly nativeEvidenceStatus: 'not-captured-by-catalog';
}

export interface UnknownBlueprintControlBehavior extends BlueprintSchemaLookupBase {
  readonly kind: 'unknown';
  readonly lookup: 'blueprint-control-behavior';
  readonly structuralStatus: 'unknown-or-modded';
  readonly reason: 'not-in-pinned-catalog';
}

export type BlueprintControlBehaviorLookup =
  KnownBlueprintControlBehavior | UnknownBlueprintControlBehavior;

function unknownEntity(name: string): UnknownBlueprintEntityVariant {
  return Object.freeze({
    kind: 'unknown',
    lookup: 'blueprint-entity-variant',
    requestedName: name,
    structuralStatus: 'unknown-or-modded',
    reason: 'not-in-pinned-catalog',
  });
}

function unknownBehavior(name: string): UnknownBlueprintControlBehavior {
  return Object.freeze({
    kind: 'unknown',
    lookup: 'blueprint-control-behavior',
    requestedName: name,
    structuralStatus: 'unknown-or-modded',
    reason: 'not-in-pinned-catalog',
  });
}

function referenceMap(
  catalog: BlueprintSchemaCatalog,
): ReadonlyMap<string, BlueprintSchemaDescriptor> {
  return new Map(catalog.references.map((reference) => [reference.name, reference.type]));
}

export interface BlueprintSchemaLookup {
  entityVariant(name: string): BlueprintEntityVariantLookup;
  controlBehavior(name: string): BlueprintControlBehaviorLookup;
}

export function createBlueprintSchemaLookup(
  catalog: BlueprintSchemaCatalog = blueprintSchemaCatalog,
): BlueprintSchemaLookup {
  const variants = new Map(catalog.variants.map((variant) => [variant.name, variant]));
  const behaviors = new Map(
    catalog.controlBehaviors.map((behavior) => [behavior.blueprintType, behavior]),
  );
  const references = referenceMap(catalog);
  const sharedBehaviorNames = new Set(
    catalog.variants.flatMap((variant) =>
      variant.fields.flatMap((field) =>
        field.name === 'control_behavior' && field.type.kind === 'reference'
          ? [field.type.name]
          : [],
      ),
    ),
  );
  return Object.freeze({
    entityVariant(name: string): BlueprintEntityVariantLookup {
      const variant = variants.get(name);
      if (variant === undefined) return unknownEntity(name);
      const common = catalog.common;
      if (common.kind !== 'object')
        throw new Error('Blueprint schema catalog common must be an object.');
      return Object.freeze({
        kind: 'known',
        lookup: 'blueprint-entity-variant',
        requestedName: name,
        name: variant.name,
        structuralStatus: 'documented',
        common,
        commonFields: common.fields,
        variant,
        variantFields: variant.fields,
        implementationStatus: 'unassessed-per-field',
        nativeEvidenceStatus: 'not-captured-by-catalog',
      });
    },
    controlBehavior(name: string): BlueprintControlBehaviorLookup {
      const behavior = behaviors.get(name);
      if (behavior !== undefined) {
        return Object.freeze({
          kind: 'known',
          lookup: 'blueprint-control-behavior',
          requestedName: name,
          name,
          schema: behavior.schema,
          entityVariants: behavior.entityVariants,
          runtimeClass: behavior.name,
          structuralStatus: 'documented',
          implementationStatus: 'unassessed-per-field',
          nativeEvidenceStatus: 'not-captured-by-catalog',
        });
      }
      const schema = references.get(name);
      if (
        schema !== undefined &&
        sharedBehaviorNames.has(name) &&
        name.endsWith('BlueprintControlBehavior')
      ) {
        return Object.freeze({
          kind: 'known',
          lookup: 'blueprint-control-behavior',
          requestedName: name,
          name,
          schema,
          entityVariants: catalog.variants
            .filter((variant) =>
              variant.fields.some(
                (field) =>
                  field.name === 'control_behavior' &&
                  field.type.kind === 'reference' &&
                  field.type.name === name,
              ),
            )
            .map((variant) => variant.name),
          structuralStatus: 'documented-shared',
          implementationStatus: 'unassessed-per-field',
          nativeEvidenceStatus: 'not-captured-by-catalog',
        });
      }
      return unknownBehavior(name);
    },
  });
}

const builtInLookup = createBlueprintSchemaLookup();

export function lookupBlueprintEntityVariant(name: string): BlueprintEntityVariantLookup {
  return builtInLookup.entityVariant(name);
}

export function lookupBlueprintControlBehavior(name: string): BlueprintControlBehaviorLookup {
  return builtInLookup.controlBehavior(name);
}

/**
 * Data-only descriptors for the reviewed Factorio BlueprintEntity schema.
 *
 * This algebra records API shape, not implementation or native-conformance
 * authority. In particular, a reference is a named schema edge, not a
 * permission to construct or simulate a Factorio entity.
 */
export const blueprintSchemaCatalogFormat = 'comblang-blueprint-schema-catalog' as const;
export const blueprintSchemaCatalogVersion = 2 as const;

export type BlueprintSchemaScalarName = 'boolean' | 'string' | 'number' | (string & {});

export type BlueprintSchemaDefault = boolean | number | string | null;

export type BlueprintSchemaDescriptor =
  | {
      readonly kind: 'scalar';
      readonly name: BlueprintSchemaScalarName;
    }
  | {
      readonly kind: 'literal';
      readonly value: boolean | number | string | null;
    }
  | {
      readonly kind: 'array';
      readonly items: BlueprintSchemaDescriptor;
    }
  | {
      readonly kind: 'tuple';
      readonly items: readonly BlueprintSchemaDescriptor[];
    }
  | {
      readonly kind: 'union';
      readonly options: readonly BlueprintSchemaDescriptor[];
    }
  | {
      readonly kind: 'dictionary';
      readonly keys: BlueprintSchemaDescriptor;
      readonly values: BlueprintSchemaDescriptor;
    }
  | {
      readonly kind: 'object';
      readonly fields: readonly BlueprintSchemaField[];
      readonly variant?: BlueprintSchemaVariantMetadata;
    }
  | {
      readonly kind: 'reference';
      readonly name: string;
    };

export interface BlueprintSchemaField {
  readonly name: string;
  readonly type: BlueprintSchemaDescriptor;
  readonly optional: boolean;
  readonly default?: BlueprintSchemaDefault;
  readonly ownership?: 'user' | 'compiler';
}

export interface BlueprintSchemaVariantGroup {
  readonly value: string;
  readonly fields: readonly BlueprintSchemaField[];
}

export interface BlueprintSchemaVariantMetadata {
  readonly discriminator: string;
  readonly default?: string;
  readonly groups: readonly BlueprintSchemaVariantGroup[];
}

export interface BlueprintSchemaNamedReference {
  readonly name: string;
  readonly type: BlueprintSchemaDescriptor;
}

export interface BlueprintSchemaSourceIdentity {
  readonly snapshot: string;
  readonly applicationVersion: string;
  readonly apiVersion: number;
  readonly runtimeSha256: string;
  readonly prototypeSha256: string;
}

export interface BlueprintSchemaCatalogCounts {
  readonly entityVariants: number;
  readonly controlBehaviors: number;
  readonly referencedSchemas: number;
}

export interface BlueprintSchemaControlBehavior {
  readonly name: string;
  readonly blueprintType: string;
  readonly entityVariants: readonly string[];
  readonly schema: BlueprintSchemaDescriptor;
  readonly structuralStatus: 'documented';
  readonly implementationStatus: 'unassessed-per-field';
  readonly nativeEvidenceStatus: 'not-captured-by-catalog';
}

export interface BlueprintSchemaVariant {
  readonly name: string;
  readonly fields: readonly BlueprintSchemaField[];
  readonly structuralStatus: 'documented';
}

export interface BlueprintSchemaCatalog {
  readonly format: typeof blueprintSchemaCatalogFormat;
  readonly version: typeof blueprintSchemaCatalogVersion;
  readonly source: BlueprintSchemaSourceIdentity;
  readonly counts: BlueprintSchemaCatalogCounts;
  readonly common: BlueprintSchemaDescriptor;
  readonly variants: readonly BlueprintSchemaVariant[];
  readonly controlBehaviors: readonly BlueprintSchemaControlBehavior[];
  readonly references: readonly BlueprintSchemaNamedReference[];
  readonly warning: string;
}

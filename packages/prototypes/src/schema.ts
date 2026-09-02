export const prototypeSchemaVersion = 1 as const;

export type ItemPrototypeKey = `item:${string}`;
export type FluidPrototypeKey = `fluid:${string}`;
export type RecipePrototypeKey = `recipe:${string}`;
export type EntityPrototypeKey = `entity:${string}`;
export type QualityPrototypeKey = `quality:${string}`;
export type RecipeCategoryPrototypeKey = `recipe-category:${string}`;
export type VirtualSignalPrototypeKey = `virtual:${string}`;
export type ProductPrototypeKey = ItemPrototypeKey | FluidPrototypeKey;
export type PrototypeKey =
  | ProductPrototypeKey
  | RecipePrototypeKey
  | EntityPrototypeKey
  | QualityPrototypeKey
  | RecipeCategoryPrototypeKey
  | VirtualSignalPrototypeKey;

export interface PrototypeMod {
  readonly name: string;
  readonly version: string;
}

export interface PrototypeEnvironment {
  readonly factorioVersion: string;
  readonly expansions: readonly string[];
  readonly mods: readonly PrototypeMod[];
  readonly startupSettingsIdentity?: string;
  readonly generatorVersion: string;
  /** Informational provenance only; excluded from deterministic content identity. */
  readonly generatedAt?: string;
}

export interface PrototypeDatabaseCapabilities {
  readonly itemStackSizes: boolean;
  readonly fluids: boolean;
  readonly recipes: boolean;
  readonly entities: boolean;
  readonly entityCircuitCapabilities: boolean;
  readonly qualities: boolean;
  readonly recipeCategories: boolean;
  readonly virtualSignals: boolean;
}

export interface ItemPrototype {
  readonly key: ItemPrototypeKey;
  readonly name: string;
  readonly stackSize?: number;
}

export interface FluidPrototype {
  readonly key: FluidPrototypeKey;
  readonly name: string;
}

export interface RecipeComponent {
  readonly prototype: ProductPrototypeKey;
  readonly amount?: number;
  readonly amountMin?: number;
  readonly amountMax?: number;
  readonly extraCountFraction?: number;
  readonly probability?: number;
  readonly temperature?: number;
  readonly temperatureMin?: number;
  readonly temperatureMax?: number;
}

export interface RecipePrototype {
  readonly key: RecipePrototypeKey;
  readonly name: string;
  readonly categories: readonly string[];
  readonly energy: number;
  readonly ingredients: readonly RecipeComponent[];
  readonly products: readonly RecipeComponent[];
  readonly mainProduct?: ProductPrototypeKey;
  readonly enabledByDefault?: boolean;
  readonly allowProductivity?: boolean;
  readonly hidden?: boolean;
}

export interface EntityCircuitCapabilities {
  readonly read: boolean;
  readonly enableDisable: boolean;
  readonly readContents: boolean;
  readonly setFilters: boolean;
  readonly setRequests: boolean;
  readonly setRecipe: boolean;
  readonly readRecipe: boolean;
  readonly readFinishedCraft: boolean;
  readonly outputSignals: boolean;
}

export interface EntityCraftingCapabilities {
  readonly categories: readonly string[];
  readonly supportsFluids: boolean;
}

export interface EntityPrototype {
  readonly key: EntityPrototypeKey;
  readonly name: string;
  readonly type: string;
  readonly tileWidth: number;
  readonly tileHeight: number;
  readonly circuit?: EntityCircuitCapabilities;
  readonly crafting?: EntityCraftingCapabilities;
}

export interface QualityPrototype {
  readonly key: QualityPrototypeKey;
  readonly name: string;
  readonly level: number;
}

export interface RecipeCategoryPrototype {
  readonly key: RecipeCategoryPrototypeKey;
  readonly name: string;
}

export interface VirtualSignalPrototype {
  readonly key: VirtualSignalPrototypeKey;
  readonly name: string;
}

export interface PrototypeIndexes {
  readonly recipesByProduct: Readonly<Record<ProductPrototypeKey, readonly RecipePrototypeKey[]>>;
}

export interface PrototypeDatabaseV1 {
  readonly schemaVersion: typeof prototypeSchemaVersion;
  readonly environment: PrototypeEnvironment;
  readonly capabilities: PrototypeDatabaseCapabilities;
  readonly items: readonly ItemPrototype[];
  readonly fluids: readonly FluidPrototype[];
  readonly recipes: readonly RecipePrototype[];
  readonly entities: readonly EntityPrototype[];
  readonly qualities: readonly QualityPrototype[];
  readonly recipeCategories: readonly RecipeCategoryPrototype[];
  readonly virtualSignals: readonly VirtualSignalPrototype[];
  readonly indexes: PrototypeIndexes;
}

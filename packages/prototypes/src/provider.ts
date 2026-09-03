import { prototypeDatabaseIdentity } from './identity.js';
import type {
  EntityCircuitCapabilities,
  EntityPrototype,
  FluidPrototype,
  ItemPrototype,
  ProductPrototypeKey,
  PrototypeDatabaseCapabilities,
  PrototypeDatabaseV1,
  PrototypeEnvironment,
  PrototypeKey,
  QualityPrototype,
  RecipeCategoryPrototype,
  RecipePrototype,
  VirtualSignalPrototype,
} from './schema.js';
import { parsePrototypeDatabaseJson, validatePrototypeDatabase } from './validation.js';

export type AnyPrototype =
  | ItemPrototype
  | FluidPrototype
  | RecipePrototype
  | RecipeCategoryPrototype
  | EntityPrototype
  | QualityPrototype
  | VirtualSignalPrototype;

/** LuaCustomTable-like readonly lookup. Direct collection access is by prototype name. */
export type PrototypeTable<T> = Readonly<Record<string, T | undefined>>;

export interface PrototypeCollections {
  /** Every known prototype, indexed by its unambiguous canonical key. */
  readonly all: PrototypeTable<AnyPrototype>;
  readonly recipesByProduct: PrototypeTable<readonly RecipePrototype[]>;
  readonly entitiesByType: PrototypeTable<readonly EntityPrototype[]>;
  readonly craftingMachinesByCategory: PrototypeTable<readonly EntityPrototype[]>;
}

/** Immutable compilation environment modelled after Factorio's `prototypes` global. */
export interface PrototypeProvider {
  readonly identity: string;
  readonly environment: PrototypeEnvironment;
  readonly capabilities: PrototypeDatabaseCapabilities;
  readonly item: PrototypeTable<ItemPrototype>;
  readonly fluid: PrototypeTable<FluidPrototype>;
  readonly recipe: PrototypeTable<RecipePrototype>;
  readonly recipe_category: PrototypeTable<RecipeCategoryPrototype>;
  readonly entity: PrototypeTable<EntityPrototype>;
  readonly quality: PrototypeTable<QualityPrototype>;
  readonly virtual_signal: PrototypeTable<VirtualSignalPrototype>;
  readonly collections: PrototypeCollections;
  getItem(nameOrKey: string): ItemPrototype | undefined;
  getFluid(nameOrKey: string): FluidPrototype | undefined;
  getRecipe(nameOrKey: string): RecipePrototype | undefined;
  getRecipeCategory(nameOrKey: string): RecipeCategoryPrototype | undefined;
  getEntity(nameOrKey: string): EntityPrototype | undefined;
  getQuality(nameOrKey: string): QualityPrototype | undefined;
  getVirtualSignal(nameOrKey: string): VirtualSignalPrototype | undefined;
  recipesProducing(product: ProductPrototypeKey): readonly RecipePrototype[];
  canCraft(entity: string, recipe: string): boolean;
  stackSize(item: string): number;
  entityCircuitCapabilities(entity: string): EntityCircuitCapabilities;
}

export interface LoadedPrototypeEnvironment {
  readonly database: PrototypeDatabaseV1;
  readonly prototypes: PrototypeProvider;
}

function lookup<T extends { readonly key: string; readonly name: string }>(
  values: readonly T[],
): ReadonlyMap<string, T> {
  return new Map(
    values.flatMap((value) => [
      [value.name, value],
      [value.key, value],
    ]),
  );
}

function table<T extends { readonly name: string }>(values: readonly T[]): PrototypeTable<T> {
  const result = Object.create(null) as Record<string, T>;
  for (const value of values) result[value.name] = value;
  return Object.freeze(result);
}

function groupedTable<T>(
  entries: Iterable<readonly [string, T]>,
  compare: (left: T, right: T) => number,
): PrototypeTable<readonly T[]> {
  const groups = new Map<string, T[]>();
  for (const [key, value] of entries) {
    const group = groups.get(key) ?? [];
    group.push(value);
    groups.set(key, group);
  }
  const result = Object.create(null) as Record<string, readonly T[]>;
  for (const [key, values] of [...groups].sort(([left], [right]) => left.localeCompare(right))) {
    result[key] = Object.freeze([...values].sort(compare));
  }
  return Object.freeze(result);
}

function unavailable(capability: keyof PrototypeDatabaseCapabilities): never {
  throw new Error(`Prototype database does not provide ${capability} data.`);
}

function createPrototypeProvider(
  database: PrototypeDatabaseV1,
  identity: string,
): PrototypeProvider {
  const availableFluids = database.capabilities.fluids ? database.fluids : [];
  const availableRecipes = database.capabilities.recipes ? database.recipes : [];
  const availableRecipeCategories = database.capabilities.recipeCategories
    ? database.recipeCategories
    : [];
  const availableEntities = database.capabilities.entities ? database.entities : [];
  const availableQualities = database.capabilities.qualities ? database.qualities : [];
  const availableVirtualSignals = database.capabilities.virtualSignals
    ? database.virtualSignals
    : [];
  const item = table(database.items);
  const fluid = table(availableFluids);
  const recipe = table(availableRecipes);
  const recipeCategory = table(availableRecipeCategories);
  const entity = table(availableEntities);
  const quality = table(availableQualities);
  const virtualSignal = table(availableVirtualSignals);
  const items = lookup(database.items);
  const fluids = lookup(database.fluids);
  const recipes = lookup(database.recipes);
  const recipeCategories = lookup(database.recipeCategories);
  const entities = lookup(database.entities);
  const qualities = lookup(database.qualities);
  const virtualSignals = lookup(database.virtualSignals);

  const all = Object.create(null) as Record<PrototypeKey, AnyPrototype>;
  for (const value of [
    ...database.items,
    ...availableFluids,
    ...availableRecipes,
    ...availableRecipeCategories,
    ...availableEntities,
    ...availableQualities,
    ...availableVirtualSignals,
  ]) {
    all[value.key] = value;
  }

  const recipesByProduct = Object.create(null) as Record<string, readonly RecipePrototype[]>;
  for (const [product, recipeKeys] of Object.entries(
    database.capabilities.recipes ? database.indexes.recipesByProduct : {},
  )) {
    recipesByProduct[product] = Object.freeze(
      recipeKeys.map((key) => {
        const value = recipes.get(key);
        if (value === undefined) throw new Error(`Prototype index references ${key}.`);
        return value;
      }),
    );
  }

  const byKey = (left: { readonly key: string }, right: { readonly key: string }) =>
    left.key.localeCompare(right.key);
  const collections: PrototypeCollections = Object.freeze({
    all: Object.freeze(all),
    recipesByProduct: Object.freeze(recipesByProduct),
    entitiesByType: groupedTable(
      availableEntities.map((value) => [value.type, value] as const),
      byKey,
    ),
    craftingMachinesByCategory: groupedTable(
      availableEntities.flatMap((value) =>
        (value.crafting?.categories ?? []).map((category) => [category, value] as const),
      ),
      byKey,
    ),
  });

  return Object.freeze({
    identity,
    environment: database.environment,
    capabilities: database.capabilities,
    item,
    fluid,
    recipe,
    recipe_category: recipeCategory,
    entity,
    quality,
    virtual_signal: virtualSignal,
    collections,
    getItem(nameOrKey: string) {
      return items.get(nameOrKey);
    },
    getFluid(nameOrKey: string) {
      if (!database.capabilities.fluids) unavailable('fluids');
      return fluids.get(nameOrKey);
    },
    getRecipe(nameOrKey: string) {
      if (!database.capabilities.recipes) unavailable('recipes');
      return recipes.get(nameOrKey);
    },
    getRecipeCategory(nameOrKey: string) {
      if (!database.capabilities.recipeCategories) unavailable('recipeCategories');
      return recipeCategories.get(nameOrKey);
    },
    getEntity(nameOrKey: string) {
      if (!database.capabilities.entities) unavailable('entities');
      return entities.get(nameOrKey);
    },
    getQuality(nameOrKey: string) {
      if (!database.capabilities.qualities) unavailable('qualities');
      return qualities.get(nameOrKey);
    },
    getVirtualSignal(nameOrKey: string) {
      if (!database.capabilities.virtualSignals) unavailable('virtualSignals');
      return virtualSignals.get(nameOrKey);
    },
    recipesProducing(product: ProductPrototypeKey) {
      if (!database.capabilities.recipes) unavailable('recipes');
      return collections.recipesByProduct[product] ?? Object.freeze([]);
    },
    canCraft(entityName: string, recipeName: string) {
      if (!database.capabilities.entities) unavailable('entities');
      if (!database.capabilities.recipes) unavailable('recipes');
      const entityValue = entities.get(entityName);
      const recipeValue = recipes.get(recipeName);
      if (
        entityValue === undefined ||
        recipeValue === undefined ||
        entityValue.crafting === undefined
      )
        return false;
      if (
        !recipeValue.categories.some((category) =>
          entityValue.crafting?.categories.includes(category),
        )
      )
        return false;
      const requiresFluid = [...recipeValue.ingredients, ...recipeValue.products].some(
        ({ prototype }) => prototype.startsWith('fluid:'),
      );
      return !requiresFluid || entityValue.crafting.supportsFluids;
    },
    stackSize(itemName: string) {
      if (!database.capabilities.itemStackSizes) unavailable('itemStackSizes');
      const value = items.get(itemName);
      if (value === undefined) throw new Error(`Unknown item prototype: ${itemName}.`);
      if (value.stackSize === undefined) unavailable('itemStackSizes');
      return value.stackSize;
    },
    entityCircuitCapabilities(entityName: string) {
      if (!database.capabilities.entities) unavailable('entities');
      const value = entities.get(entityName);
      if (value === undefined) throw new Error(`Unknown entity prototype: ${entityName}.`);
      if (value.circuit === undefined) {
        throw new Error(
          `Prototype database does not provide entityCircuitCapabilities data for ${value.key}.`,
        );
      }
      return value.circuit;
    },
  });
}

export async function loadPrototypeDatabase(value: unknown): Promise<LoadedPrototypeEnvironment> {
  const database = validatePrototypeDatabase(value);
  const identity = await prototypeDatabaseIdentity(database);
  return Object.freeze({ database, prototypes: createPrototypeProvider(database, identity) });
}

export async function loadPrototypeDatabaseJson(
  source: string,
): Promise<LoadedPrototypeEnvironment> {
  const database = parsePrototypeDatabaseJson(source);
  const identity = await prototypeDatabaseIdentity(database);
  return Object.freeze({ database, prototypes: createPrototypeProvider(database, identity) });
}

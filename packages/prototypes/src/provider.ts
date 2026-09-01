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
  QualityPrototype,
  RecipePrototype,
} from './schema.js';
import { parsePrototypeDatabaseJson, validatePrototypeDatabase } from './validation.js';

export interface PrototypeProvider {
  readonly identity: string;
  readonly environment: PrototypeEnvironment;
  readonly capabilities: PrototypeDatabaseCapabilities;
  getItem(nameOrKey: string): ItemPrototype | undefined;
  getFluid(nameOrKey: string): FluidPrototype | undefined;
  getRecipe(nameOrKey: string): RecipePrototype | undefined;
  getEntity(nameOrKey: string): EntityPrototype | undefined;
  getQuality(nameOrKey: string): QualityPrototype | undefined;
  recipesProducing(product: ProductPrototypeKey): readonly RecipePrototype[];
  canCraft(entity: string, recipe: string): boolean;
  stackSize(item: string): number;
  entityCircuitCapabilities(entity: string): EntityCircuitCapabilities;
}

export interface LoadedPrototypeEnvironment {
  readonly database: PrototypeDatabaseV1;
  readonly provider: PrototypeProvider;
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

function unavailable(capability: keyof PrototypeDatabaseCapabilities): never {
  throw new Error(`Prototype database does not provide ${capability} data.`);
}

const noCircuitCapabilities: EntityCircuitCapabilities = Object.freeze({
  read: false,
  enableDisable: false,
  readContents: false,
  setFilters: false,
  setRequests: false,
  setRecipe: false,
  readRecipe: false,
  readFinishedCraft: false,
  outputSignals: false,
});

function createPrototypeProvider(
  database: PrototypeDatabaseV1,
  identity: string,
): PrototypeProvider {
  const items = lookup(database.items);
  const fluids = lookup(database.fluids);
  const recipes = lookup(database.recipes);
  const entities = lookup(database.entities);
  const qualities = lookup(database.qualities);
  const recipesByProduct = new Map(
    Object.entries(database.indexes.recipesByProduct).map(([product, recipeKeys]) => [
      product,
      Object.freeze(
        recipeKeys.map((key) => {
          const recipe = recipes.get(key);
          if (recipe === undefined) throw new Error(`Prototype index references ${key}.`);
          return recipe;
        }),
      ),
    ]),
  );
  return Object.freeze({
    identity,
    environment: database.environment,
    capabilities: database.capabilities,
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
    getEntity(nameOrKey: string) {
      if (!database.capabilities.entities) unavailable('entities');
      return entities.get(nameOrKey);
    },
    getQuality(nameOrKey: string) {
      if (!database.capabilities.qualities) unavailable('qualities');
      return qualities.get(nameOrKey);
    },
    recipesProducing(product: ProductPrototypeKey) {
      if (!database.capabilities.recipes) unavailable('recipes');
      return recipesByProduct.get(product) ?? Object.freeze([]);
    },
    canCraft(entityName: string, recipeName: string) {
      if (!database.capabilities.entities) unavailable('entities');
      if (!database.capabilities.recipes) unavailable('recipes');
      const entity = entities.get(entityName);
      const recipe = recipes.get(recipeName);
      if (entity === undefined || recipe === undefined || entity.crafting === undefined)
        return false;
      if (!entity.crafting.categories.includes(recipe.category)) return false;
      const requiresFluid = [...recipe.ingredients, ...recipe.products].some(({ prototype }) =>
        prototype.startsWith('fluid:'),
      );
      return !requiresFluid || entity.crafting.supportsFluids;
    },
    stackSize(itemName: string) {
      if (!database.capabilities.itemStackSizes) unavailable('itemStackSizes');
      const item = items.get(itemName);
      if (item === undefined) throw new Error(`Unknown item prototype: ${itemName}.`);
      if (item.stackSize === undefined) unavailable('itemStackSizes');
      return item.stackSize;
    },
    entityCircuitCapabilities(entityName: string) {
      if (!database.capabilities.entityCircuitCapabilities) {
        unavailable('entityCircuitCapabilities');
      }
      const entity = entities.get(entityName);
      if (entity === undefined) throw new Error(`Unknown entity prototype: ${entityName}.`);
      return entity.circuit ?? noCircuitCapabilities;
    },
  });
}

export async function loadPrototypeDatabase(value: unknown): Promise<LoadedPrototypeEnvironment> {
  const database = validatePrototypeDatabase(value);
  const identity = await prototypeDatabaseIdentity(database);
  return Object.freeze({ database, provider: createPrototypeProvider(database, identity) });
}

export async function loadPrototypeDatabaseJson(
  source: string,
): Promise<LoadedPrototypeEnvironment> {
  const database = parsePrototypeDatabaseJson(source);
  const identity = await prototypeDatabaseIdentity(database);
  return Object.freeze({ database, provider: createPrototypeProvider(database, identity) });
}

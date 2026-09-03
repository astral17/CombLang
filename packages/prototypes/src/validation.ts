import {
  prototypeSchemaVersion,
  type EntityCircuitCapabilities,
  type EntityCraftingCapabilities,
  type EntityPrototype,
  type FluidPrototype,
  type ItemPrototype,
  type ProductPrototypeKey,
  type PrototypeDatabaseCapabilities,
  type PrototypeDatabaseV1,
  type PrototypeEnvironment,
  type PrototypeStartupSetting,
  type PrototypeIndexes,
  type PrototypeKey,
  type QualityPrototype,
  type RecipeCategoryPrototype,
  type RecipeComponent,
  type RecipePrototype,
  type RecipePrototypeKey,
  type VirtualSignalPrototype,
} from './schema.js';

export class PrototypeValidationError extends Error {
  readonly code: string;
  readonly path: string;

  constructor(code: string, path: string, message: string) {
    super(`${path}: ${message}`);
    this.name = 'PrototypeValidationError';
    this.code = code;
    this.path = path;
  }
}

type JsonObject = Record<string, unknown>;

function invalid(code: string, path: string, message: string): never {
  throw new PrototypeValidationError(code, path, message);
}

function object(value: unknown, path: string): JsonObject {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    invalid('PT1001', path, 'expected an object.');
  }
  return value as JsonObject;
}

function array(value: unknown, path: string): readonly unknown[] {
  if (!Array.isArray(value)) invalid('PT1001', path, 'expected an array.');
  return value;
}

function string(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    invalid('PT1001', path, 'expected a non-empty string.');
  }
  return value;
}

function boolean(value: unknown, path: string): boolean {
  if (typeof value !== 'boolean') invalid('PT1001', path, 'expected a boolean.');
  return value;
}

function finite(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    invalid('PT1001', path, 'expected a finite number.');
  }
  return value;
}

function positive(value: unknown, path: string): number {
  const result = finite(value, path);
  if (result <= 0) invalid('PT1001', path, 'expected a positive number.');
  return result;
}

function positiveInteger(value: unknown, path: string): number {
  const result = positive(value, path);
  if (!Number.isSafeInteger(result)) {
    invalid('PT1001', path, 'expected a positive safe integer.');
  }
  return result;
}

function optionalPositiveInteger(value: unknown, path: string): number | undefined {
  return value === undefined ? undefined : positiveInteger(value, path);
}

function optionalString(value: unknown, path: string): string | undefined {
  return value === undefined ? undefined : string(value, path);
}

function optionalBoolean(value: unknown, path: string): boolean | undefined {
  return value === undefined ? undefined : boolean(value, path);
}

function optionalFinite(value: unknown, path: string): number | undefined {
  return value === undefined ? undefined : finite(value, path);
}

function canonicalKey(prefix: string, name: string, value: unknown, path: string): PrototypeKey {
  const key = string(value, path);
  if (key !== `${prefix}:${name}`) {
    invalid('PT1002', path, `expected canonical key ${JSON.stringify(`${prefix}:${name}`)}.`);
  }
  return key as PrototypeKey;
}

function unique(values: readonly string[], path: string): void {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) invalid('PT1003', path, `duplicate key ${JSON.stringify(value)}.`);
    seen.add(value);
  }
}

/** Copies captured setting values without filling defaults or equating color representations. */
export function validatePrototypeStartupSettings(
  value: unknown,
  path = 'environment.startupSettings',
): readonly PrototypeStartupSetting[] {
  const settings = array(value, path).map((raw, index): PrototypeStartupSetting => {
    const entryPath = `${path}[${index}]`;
    const entry = object(raw, entryPath);
    const name = string(entry.name, `${entryPath}.name`);
    let setting: PrototypeStartupSetting['value'];
    if (typeof entry.value === 'boolean' || typeof entry.value === 'string') setting = entry.value;
    else if (typeof entry.value === 'number') setting = finite(entry.value, `${entryPath}.value`);
    else if (Array.isArray(entry.value)) {
      if (entry.value.length !== 3 && entry.value.length !== 4)
        invalid('PT1001', `${entryPath}.value`, 'expected 3 or 4 color channels.');
      setting = Object.freeze(
        entry.value.map((channel, i) => finite(channel, `${entryPath}.value[${i}]`)),
      );
    } else {
      const color = object(entry.value, `${entryPath}.value`);
      if (Object.keys(color).some((key) => !['r', 'g', 'b', 'a'].includes(key)))
        invalid('PT1001', `${entryPath}.value`, 'expected a color object.');
      setting = Object.freeze(
        Object.fromEntries(
          Object.entries(color).map(([key, value]) => [
            key,
            finite(value, `${entryPath}.value.${key}`),
          ]),
        ),
      );
    }
    return Object.freeze({ name, value: setting });
  });
  unique(
    settings.map(({ name }) => name),
    path,
  );
  return Object.freeze(settings);
}

function parseEnvironment(value: unknown): PrototypeEnvironment {
  const input = object(value, 'environment');
  const expansions = array(input.expansions, 'environment.expansions').map((entry, index) =>
    string(entry, `environment.expansions[${index}]`),
  );
  unique(expansions, 'environment.expansions');
  const mods = array(input.mods, 'environment.mods').map((entry, index) => {
    const mod = object(entry, `environment.mods[${index}]`);
    return Object.freeze({
      name: string(mod.name, `environment.mods[${index}].name`),
      version: string(mod.version, `environment.mods[${index}].version`),
    });
  });
  unique(
    mods.map(({ name }) => name),
    'environment.mods',
  );
  const startupSettingsIdentity = optionalString(
    input.startupSettingsIdentity,
    'environment.startupSettingsIdentity',
  );
  const generatedAt = optionalString(input.generatedAt, 'environment.generatedAt');
  const startupSettings =
    input.startupSettings === undefined
      ? undefined
      : Object.freeze(
          [...validatePrototypeStartupSettings(input.startupSettings)].sort((a, b) =>
            a.name.localeCompare(b.name),
          ),
        );
  return Object.freeze({
    factorioVersion: string(input.factorioVersion, 'environment.factorioVersion'),
    expansions: Object.freeze([...expansions].sort()),
    mods: Object.freeze(
      [...mods].sort(
        (left, right) =>
          left.name.localeCompare(right.name) || left.version.localeCompare(right.version),
      ),
    ),
    generatorVersion: string(input.generatorVersion, 'environment.generatorVersion'),
    ...(startupSettingsIdentity === undefined ? {} : { startupSettingsIdentity }),
    ...(startupSettings === undefined ? {} : { startupSettings }),
    ...(generatedAt === undefined ? {} : { generatedAt }),
  });
}

function parseCapabilities(value: unknown): PrototypeDatabaseCapabilities {
  const input = object(value, 'capabilities');
  return Object.freeze({
    itemStackSizes: boolean(input.itemStackSizes, 'capabilities.itemStackSizes'),
    fluids: boolean(input.fluids, 'capabilities.fluids'),
    recipes: boolean(input.recipes, 'capabilities.recipes'),
    entities: boolean(input.entities, 'capabilities.entities'),
    entityCircuitCapabilities: boolean(
      input.entityCircuitCapabilities,
      'capabilities.entityCircuitCapabilities',
    ),
    qualities: boolean(input.qualities, 'capabilities.qualities'),
    recipeCategories: boolean(input.recipeCategories, 'capabilities.recipeCategories'),
    virtualSignals: boolean(input.virtualSignals, 'capabilities.virtualSignals'),
  });
}

function parseItems(value: unknown): readonly ItemPrototype[] {
  const items = array(value, 'items').map((entry, index): ItemPrototype => {
    const path = `items[${index}]`;
    const input = object(entry, path);
    const name = string(input.name, `${path}.name`);
    const stackSize = optionalPositiveInteger(input.stackSize, `${path}.stackSize`);
    return Object.freeze({
      key: canonicalKey('item', name, input.key, `${path}.key`) as ItemPrototype['key'],
      name,
      ...(stackSize === undefined ? {} : { stackSize }),
    });
  });
  unique(
    items.map(({ key }) => key),
    'items',
  );
  return Object.freeze([...items].sort((left, right) => left.key.localeCompare(right.key)));
}

function parseFluids(value: unknown): readonly FluidPrototype[] {
  const fluids = array(value, 'fluids').map((entry, index): FluidPrototype => {
    const path = `fluids[${index}]`;
    const input = object(entry, path);
    const name = string(input.name, `${path}.name`);
    return Object.freeze({
      key: canonicalKey('fluid', name, input.key, `${path}.key`) as FluidPrototype['key'],
      name,
    });
  });
  unique(
    fluids.map(({ key }) => key),
    'fluids',
  );
  return Object.freeze([...fluids].sort((left, right) => left.key.localeCompare(right.key)));
}

function parseComponent(
  value: unknown,
  path: string,
  role: 'ingredient' | 'product',
): RecipeComponent {
  const input = object(value, path);
  const prototype = string(input.prototype, `${path}.prototype`);
  if (!prototype.startsWith('item:') && !prototype.startsWith('fluid:')) {
    invalid('PT1002', `${path}.prototype`, 'expected an item: or fluid: prototype key.');
  }
  const amount = optionalFinite(input.amount, `${path}.amount`);
  const amountMin = optionalFinite(input.amountMin, `${path}.amountMin`);
  const amountMax = optionalFinite(input.amountMax, `${path}.amountMax`);
  const extraCountFraction = optionalFinite(input.extraCountFraction, `${path}.extraCountFraction`);
  if ((amount === undefined) === (amountMin === undefined && amountMax === undefined)) {
    invalid('PT1001', path, 'expected either amount or an amountMin/amountMax range.');
  }
  if ((amountMin === undefined) !== (amountMax === undefined)) {
    invalid('PT1001', path, 'amountMin and amountMax must be provided together.');
  }
  if (extraCountFraction !== undefined && (extraCountFraction < 0 || extraCountFraction >= 1)) {
    invalid(
      'PT1001',
      `${path}.extraCountFraction`,
      'expected a value from 0 up to, but not including, 1.',
    );
  }
  if (
    amount !== undefined &&
    (amount < 0 || (amount === 0 && (extraCountFraction === undefined || extraCountFraction === 0)))
  ) {
    invalid('PT1001', `${path}.amount`, 'must be positive unless extraCountFraction is positive.');
  }
  if (amountMin !== undefined && amountMax !== undefined) {
    if (amountMin <= 0 || amountMax <= 0 || amountMin > amountMax) {
      invalid('PT1001', path, 'expected a positive amount range with amountMin <= amountMax.');
    }
  }
  const probability = optionalFinite(input.probability, `${path}.probability`);
  if (probability !== undefined && (probability < 0 || probability > 1)) {
    invalid('PT1001', `${path}.probability`, 'expected a value from 0 through 1.');
  }
  const independentProbability = optionalFinite(
    input.independentProbability,
    `${path}.independentProbability`,
  );
  if (
    independentProbability !== undefined &&
    (independentProbability < 0 || independentProbability > 1)
  ) {
    invalid('PT1001', `${path}.independentProbability`, 'expected a value from 0 through 1.');
  }
  let sharedProbability: RecipeComponent['sharedProbability'];
  if (input.sharedProbability !== undefined) {
    const shared = object(input.sharedProbability, `${path}.sharedProbability`);
    const min = finite(shared.min, `${path}.sharedProbability.min`);
    const max = finite(shared.max, `${path}.sharedProbability.max`);
    if (min < 0 || max > 1 || min > max) {
      invalid('PT1001', `${path}.sharedProbability`, 'expected 0 <= min <= max <= 1.');
    }
    sharedProbability = Object.freeze({ min, max });
  }
  const ignoredByStats = optionalFinite(input.ignoredByStats, `${path}.ignoredByStats`);
  const ignoredByProductivity = optionalFinite(
    input.ignoredByProductivity,
    `${path}.ignoredByProductivity`,
  );
  for (const [field, count] of [
    ['ignoredByStats', ignoredByStats],
    ['ignoredByProductivity', ignoredByProductivity],
  ] as const) {
    if (
      count !== undefined &&
      (count < 0 || (prototype.startsWith('item:') && (!Number.isInteger(count) || count > 65535)))
    ) {
      invalid('PT1001', `${path}.${field}`, 'expected a non-negative amount (uint16 for items).');
    }
  }
  if (
    role === 'ingredient' &&
    (independentProbability !== undefined ||
      sharedProbability !== undefined ||
      ignoredByProductivity !== undefined)
  ) {
    invalid(
      'PT1004',
      path,
      'product probability and productivity fields are not valid on ingredients.',
    );
  }
  if (
    probability !== undefined &&
    (independentProbability !== undefined || sharedProbability !== undefined)
  ) {
    invalid(
      'PT1004',
      path,
      'legacy probability cannot be combined with independentProbability or sharedProbability.',
    );
  }
  const percentSpoiled = optionalFinite(input.percentSpoiled, `${path}.percentSpoiled`);
  const spoilWeight = optionalFinite(input.spoilWeight, `${path}.spoilWeight`);
  const alwaysFresh = optionalBoolean(input.alwaysFresh, `${path}.alwaysFresh`);
  const resetFreshnessOnCraft = optionalBoolean(
    input.resetFreshnessOnCraft,
    `${path}.resetFreshnessOnCraft`,
  );
  if (percentSpoiled !== undefined && (percentSpoiled < 0 || percentSpoiled >= 1)) {
    invalid('PT1001', `${path}.percentSpoiled`, 'expected 0 <= percentSpoiled < 1.');
  }
  if (spoilWeight !== undefined && (spoilWeight < 0 || spoilWeight > 1)) {
    invalid('PT1001', `${path}.spoilWeight`, 'expected 0 <= spoilWeight <= 1.');
  }
  for (const [field, value, requiredRole] of [
    ['percentSpoiled', percentSpoiled, 'product'],
    ['alwaysFresh', alwaysFresh, 'product'],
    ['resetFreshnessOnCraft', resetFreshnessOnCraft, 'product'],
    ['spoilWeight', spoilWeight, 'ingredient'],
  ] as const) {
    if (value !== undefined && (!prototype.startsWith('item:') || role !== requiredRole)) {
      invalid('PT1004', `${path}.${field}`, `valid only on item ${requiredRole}s.`);
    }
  }
  const fluidboxIndex = optionalFinite(input.fluidboxIndex, `${path}.fluidboxIndex`);
  const fluidboxMultiplier = optionalFinite(input.fluidboxMultiplier, `${path}.fluidboxMultiplier`);
  const optionalFluidboxIndexes =
    input.optionalFluidboxIndexes === undefined
      ? undefined
      : Object.freeze(
          array(input.optionalFluidboxIndexes, `${path}.optionalFluidboxIndexes`).map(
            (value, index) =>
              boundedInteger(value, `${path}.optionalFluidboxIndexes[${index}]`, 0, 4294967295),
          ),
        );
  if (fluidboxIndex !== undefined)
    boundedInteger(fluidboxIndex, `${path}.fluidboxIndex`, 0, 4294967295);
  if (fluidboxMultiplier !== undefined)
    boundedInteger(fluidboxMultiplier, `${path}.fluidboxMultiplier`, 1, 255);
  for (const [field, value] of [
    ['fluidboxIndex', fluidboxIndex],
    ['fluidboxMultiplier', fluidboxMultiplier],
    ['optionalFluidboxIndexes', optionalFluidboxIndexes],
  ] as const) {
    if (value !== undefined && !prototype.startsWith('fluid:')) {
      invalid('PT1004', `${path}.${field}`, 'valid only on fluid ingredients/products.');
    }
  }
  const temperature = optionalFinite(input.temperature, `${path}.temperature`);
  const temperatureMin = optionalFinite(input.temperatureMin, `${path}.temperatureMin`);
  const temperatureMax = optionalFinite(input.temperatureMax, `${path}.temperatureMax`);
  if (
    (temperature !== undefined || temperatureMin !== undefined || temperatureMax !== undefined) &&
    !prototype.startsWith('fluid:')
  ) {
    invalid('PT1004', path, 'temperature constraints are valid only for fluids.');
  }
  if (temperature !== undefined && (temperatureMin !== undefined || temperatureMax !== undefined)) {
    invalid('PT1001', path, 'exact temperature cannot be combined with a temperature range.');
  }
  if (
    temperatureMin !== undefined &&
    temperatureMax !== undefined &&
    temperatureMin > temperatureMax
  ) {
    invalid('PT1001', path, 'temperatureMin must not exceed temperatureMax.');
  }
  return Object.freeze({
    prototype: prototype as ProductPrototypeKey,
    ...(amount === undefined ? {} : { amount }),
    ...(amountMin === undefined ? {} : { amountMin }),
    ...(amountMax === undefined ? {} : { amountMax }),
    ...(extraCountFraction === undefined ? {} : { extraCountFraction }),
    ...(probability === undefined ? {} : { probability }),
    ...(independentProbability === undefined ? {} : { independentProbability }),
    ...(sharedProbability === undefined ? {} : { sharedProbability }),
    ...(ignoredByStats === undefined ? {} : { ignoredByStats }),
    ...(ignoredByProductivity === undefined ? {} : { ignoredByProductivity }),
    ...(percentSpoiled === undefined ? {} : { percentSpoiled }),
    ...(spoilWeight === undefined ? {} : { spoilWeight }),
    ...(alwaysFresh === undefined ? {} : { alwaysFresh }),
    ...(resetFreshnessOnCraft === undefined ? {} : { resetFreshnessOnCraft }),
    ...(fluidboxIndex === undefined ? {} : { fluidboxIndex }),
    ...(fluidboxMultiplier === undefined ? {} : { fluidboxMultiplier }),
    ...(optionalFluidboxIndexes === undefined ? {} : { optionalFluidboxIndexes }),
    ...(temperature === undefined ? {} : { temperature }),
    ...(temperatureMin === undefined ? {} : { temperatureMin }),
    ...(temperatureMax === undefined ? {} : { temperatureMax }),
  });
}

function boundedInteger(value: unknown, path: string, min: number, max: number): number {
  const result = finite(value, path);
  if (!Number.isInteger(result) || result < min || result > max) {
    invalid('PT1001', path, `expected an integer from ${min} through ${max}.`);
  }
  return result;
}

function parseRecipes(value: unknown): readonly RecipePrototype[] {
  const recipes = array(value, 'recipes').map((entry, index): RecipePrototype => {
    const path = `recipes[${index}]`;
    const input = object(entry, path);
    const name = string(input.name, `${path}.name`);
    const products = array(input.products, `${path}.products`).map((component, componentIndex) =>
      parseComponent(component, `${path}.products[${componentIndex}]`, 'product'),
    );
    if (products.length === 0) invalid('PT1001', `${path}.products`, 'must not be empty.');
    const mainProduct = optionalString(input.mainProduct, `${path}.mainProduct`);
    const categories = array(input.categories, `${path}.categories`).map(
      (category, categoryIndex) => string(category, `${path}.categories[${categoryIndex}]`),
    );
    if (categories.length === 0) invalid('PT1001', `${path}.categories`, 'must not be empty.');
    unique(categories, `${path}.categories`);
    if (mainProduct !== undefined && !products.some(({ prototype }) => prototype === mainProduct)) {
      invalid('PT1004', `${path}.mainProduct`, 'must reference one of the recipe products.');
    }
    return Object.freeze({
      key: canonicalKey('recipe', name, input.key, `${path}.key`) as RecipePrototype['key'],
      name,
      categories: Object.freeze([...categories].sort()),
      energy: positive(input.energy, `${path}.energy`),
      ingredients: Object.freeze(
        array(input.ingredients, `${path}.ingredients`).map((component, componentIndex) =>
          parseComponent(component, `${path}.ingredients[${componentIndex}]`, 'ingredient'),
        ),
      ),
      products: Object.freeze(products),
      ...(mainProduct === undefined ? {} : { mainProduct: mainProduct as ProductPrototypeKey }),
      ...optionalFlags(input, path, ['enabledByDefault', 'allowProductivity', 'hidden']),
    });
  });
  unique(
    recipes.map(({ key }) => key),
    'recipes',
  );
  return Object.freeze([...recipes].sort((left, right) => left.key.localeCompare(right.key)));
}

function optionalFlags(
  input: JsonObject,
  path: string,
  names: readonly string[],
): Readonly<Record<string, boolean>> {
  return Object.fromEntries(
    names.flatMap((name) => {
      const value = optionalBoolean(input[name], `${path}.${name}`);
      return value === undefined ? [] : [[name, value]];
    }),
  );
}

const circuitCapabilityNames = [
  'read',
  'enableDisable',
  'readContents',
  'setFilters',
  'setRequests',
  'setRecipe',
  'readRecipe',
  'readFinishedCraft',
  'outputSignals',
] as const satisfies readonly (keyof EntityCircuitCapabilities)[];

export function validateEntityCircuitCapabilities(
  value: unknown,
  path = 'circuit',
): EntityCircuitCapabilities {
  const input = object(value, path);
  return Object.freeze(
    Object.fromEntries(
      circuitCapabilityNames.map((name) => [name, boolean(input[name], `${path}.${name}`)]),
    ) as unknown as EntityCircuitCapabilities,
  );
}

function parseCrafting(value: unknown, path: string): EntityCraftingCapabilities | undefined {
  if (value === undefined) return undefined;
  const input = object(value, path);
  const categories = array(input.categories, `${path}.categories`).map((entry, index) =>
    string(entry, `${path}.categories[${index}]`),
  );
  unique(categories, `${path}.categories`);
  return Object.freeze({
    categories: Object.freeze([...categories].sort()),
    supportsFluids: boolean(input.supportsFluids, `${path}.supportsFluids`),
  });
}

function parseEntities(
  value: unknown,
  completeCircuitCoverage: boolean,
): readonly EntityPrototype[] {
  const entities = array(value, 'entities').map((entry, index): EntityPrototype => {
    const path = `entities[${index}]`;
    const input = object(entry, path);
    const name = string(input.name, `${path}.name`);
    if (completeCircuitCoverage && input.circuit === undefined) {
      invalid(
        'PT1004',
        `${path}.circuit`,
        'complete circuit coverage requires an explicit record for every entity (including all-false records).',
      );
    }
    const circuit =
      input.circuit === undefined
        ? undefined
        : validateEntityCircuitCapabilities(input.circuit, `${path}.circuit`);
    const crafting = parseCrafting(input.crafting, `${path}.crafting`);
    return Object.freeze({
      key: canonicalKey('entity', name, input.key, `${path}.key`) as EntityPrototype['key'],
      name,
      type: string(input.type, `${path}.type`),
      tileWidth: positiveInteger(input.tileWidth, `${path}.tileWidth`),
      tileHeight: positiveInteger(input.tileHeight, `${path}.tileHeight`),
      ...(circuit === undefined ? {} : { circuit }),
      ...(crafting === undefined ? {} : { crafting }),
    });
  });
  unique(
    entities.map(({ key }) => key),
    'entities',
  );
  return Object.freeze([...entities].sort((left, right) => left.key.localeCompare(right.key)));
}

function parseQualities(value: unknown): readonly QualityPrototype[] {
  const qualities = array(value, 'qualities').map((entry, index): QualityPrototype => {
    const path = `qualities[${index}]`;
    const input = object(entry, path);
    const name = string(input.name, `${path}.name`);
    const level = finite(input.level, `${path}.level`);
    if (!Number.isSafeInteger(level) || level < 0) {
      invalid('PT1001', `${path}.level`, 'expected a non-negative safe integer.');
    }
    return Object.freeze({
      key: canonicalKey('quality', name, input.key, `${path}.key`) as QualityPrototype['key'],
      name,
      level,
    });
  });
  unique(
    qualities.map(({ key }) => key),
    'qualities',
  );
  return Object.freeze(
    [...qualities].sort(
      (left, right) => left.level - right.level || left.key.localeCompare(right.key),
    ),
  );
}

function parseNamedPrototypes<T extends { readonly key: string; readonly name: string }>(
  value: unknown,
  path: string,
  prefix: string,
): readonly T[] {
  const prototypes = array(value, path).map((entry, index): T => {
    const entryPath = `${path}[${index}]`;
    const input = object(entry, entryPath);
    const name = string(input.name, `${entryPath}.name`);
    return Object.freeze({
      key: canonicalKey(prefix, name, input.key, `${entryPath}.key`),
      name,
    }) as T;
  });
  unique(
    prototypes.map(({ key }) => key),
    path,
  );
  return Object.freeze([...prototypes].sort((left, right) => left.key.localeCompare(right.key)));
}

export function buildPrototypeIndexes(recipes: readonly RecipePrototype[]): PrototypeIndexes {
  const mutable = new Map<ProductPrototypeKey, Set<RecipePrototypeKey>>();
  for (const recipe of recipes) {
    for (const { prototype } of recipe.products) {
      const keys = mutable.get(prototype) ?? new Set<RecipePrototypeKey>();
      keys.add(recipe.key);
      mutable.set(prototype, keys);
    }
  }
  const recipesByProduct = Object.fromEntries(
    [...mutable]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, recipesForProduct]) => [key, Object.freeze([...recipesForProduct].sort())]),
  ) as Record<ProductPrototypeKey, readonly RecipePrototypeKey[]>;
  return Object.freeze({ recipesByProduct: Object.freeze(recipesByProduct) });
}

function parseIndexes(value: unknown, recipes: readonly RecipePrototype[]): PrototypeIndexes {
  const input = object(value, 'indexes');
  const raw = object(input.recipesByProduct, 'indexes.recipesByProduct');
  const actual = Object.fromEntries(
    Object.entries(raw)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([product, recipeKeys]) => [
        product,
        [...array(recipeKeys, `indexes.recipesByProduct.${product}`)]
          .map((entry, index) => string(entry, `indexes.recipesByProduct.${product}[${index}]`))
          .sort(),
      ]),
  );
  const expected = buildPrototypeIndexes(recipes);
  if (JSON.stringify(actual) !== JSON.stringify(expected.recipesByProduct)) {
    invalid('PT1005', 'indexes.recipesByProduct', 'does not match normalized recipe products.');
  }
  return expected;
}

function validateReferences(database: PrototypeDatabaseV1): void {
  const products = new Set<ProductPrototypeKey>([
    ...database.items.map(({ key }) => key),
    ...database.fluids.map(({ key }) => key),
  ]);
  for (const recipe of database.recipes) {
    if (database.capabilities.recipeCategories) {
      const knownCategories = new Set(database.recipeCategories.map(({ name }) => name));
      for (const [index, category] of recipe.categories.entries()) {
        if (!knownCategories.has(category)) {
          invalid(
            'PT1004',
            `recipes.${recipe.name}.categories[${index}]`,
            `unknown recipe category ${JSON.stringify(category)}.`,
          );
        }
      }
    }
    for (const [kind, components] of [
      ['ingredients', recipe.ingredients],
      ['products', recipe.products],
    ] as const) {
      for (const [index, component] of components.entries()) {
        if (!products.has(component.prototype)) {
          invalid(
            'PT1004',
            `recipes.${recipe.name}.${kind}[${index}].prototype`,
            `unknown prototype ${JSON.stringify(component.prototype)}.`,
          );
        }
      }
    }
  }
  if (database.capabilities.recipeCategories) {
    const categories = new Set(database.recipeCategories.map(({ name }) => name));
    for (const entity of database.entities) {
      for (const [index, category] of (entity.crafting?.categories ?? []).entries()) {
        if (!categories.has(category)) {
          invalid(
            'PT1004',
            `entities.${entity.name}.crafting.categories[${index}]`,
            `unknown recipe category ${JSON.stringify(category)}.`,
          );
        }
      }
    }
  }
}

export function validatePrototypeDatabase(value: unknown): PrototypeDatabaseV1 {
  const input = object(value, '<root>');
  if (input.schemaVersion !== prototypeSchemaVersion) {
    invalid(
      'PT1000',
      'schemaVersion',
      `unsupported schema version ${JSON.stringify(input.schemaVersion)}; expected ${prototypeSchemaVersion}.`,
    );
  }
  const recipes = parseRecipes(input.recipes);
  const capabilities = parseCapabilities(input.capabilities);
  const database: PrototypeDatabaseV1 = Object.freeze({
    schemaVersion: prototypeSchemaVersion,
    environment: parseEnvironment(input.environment),
    capabilities,
    items: parseItems(input.items),
    fluids: parseFluids(input.fluids),
    recipes,
    entities: parseEntities(input.entities, capabilities.entityCircuitCapabilities),
    qualities: parseQualities(input.qualities),
    recipeCategories: parseNamedPrototypes<RecipeCategoryPrototype>(
      input.recipeCategories,
      'recipeCategories',
      'recipe-category',
    ),
    virtualSignals: parseNamedPrototypes<VirtualSignalPrototype>(
      input.virtualSignals,
      'virtualSignals',
      'virtual',
    ),
    indexes: parseIndexes(input.indexes, recipes),
  });
  if (
    database.capabilities.itemStackSizes &&
    database.items.some(({ stackSize }) => stackSize === undefined)
  ) {
    invalid('PT1004', 'items', 'itemStackSizes capability requires a stackSize for every item.');
  }
  validateReferences(database);
  if (database.capabilities.entityCircuitCapabilities) {
    if (!database.capabilities.entities) {
      invalid(
        'PT1004',
        'capabilities.entityCircuitCapabilities',
        'complete circuit coverage requires entities coverage.',
      );
    }
  }
  return database;
}

export function parsePrototypeDatabaseJson(source: string): PrototypeDatabaseV1 {
  let value: unknown;
  try {
    value = JSON.parse(source) as unknown;
  } catch (error) {
    throw new PrototypeValidationError(
      'PT1006',
      '<json>',
      `invalid JSON${error instanceof Error ? `: ${error.message}` : '.'}`,
    );
  }
  return validatePrototypeDatabase(value);
}

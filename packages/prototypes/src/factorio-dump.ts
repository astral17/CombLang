import type {
  EntityPrototype,
  PrototypeDatabaseV1,
  PrototypeEnvironment,
  PrototypeMod,
  PrototypeStartupSetting,
  RecipeComponent,
  RecipeIngredient,
  RecipeProduct,
  RecipePrototype,
} from './schema.js';
import {
  isRecipeComponentFieldApplicable,
  type RecipeComponentField,
  type RecipeComponentKind,
  type RecipeComponentRole,
} from './recipe-component-policy.js';
import { evaluateRecipeAmount } from './recipe-amount-policy.js';
import { buildPrototypeIndexes, validatePrototypeDatabase } from './validation.js';
import { isFactorioEntityPrototypeType } from './factorio-prototype-catalog.js';

type JsonObject = Record<string, unknown>;

export interface FactorioDumpMetadata {
  readonly factorioVersion: string;
  readonly expansions: readonly string[];
  readonly mods: readonly PrototypeMod[];
  readonly startupSettingsIdentity?: string;
  readonly startupSettings?: readonly PrototypeStartupSetting[];
  readonly generatedAt?: string;
}

export interface FactorioDumpWarning {
  readonly code: 'PD2001' | 'PD2002' | 'PD2003';
  readonly path: string;
  readonly message: string;
}

export interface FactorioDumpNormalization {
  readonly database: PrototypeDatabaseV1;
  readonly warnings: readonly FactorioDumpWarning[];
}

export class FactorioDumpError extends Error {
  readonly code = 'PD1001';
  readonly path: string;

  constructor(path: string, message: string) {
    super(`${path}: ${message}`);
    this.name = 'FactorioDumpError';
    this.path = path;
  }
}

function object(value: unknown, path: string): JsonObject {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new FactorioDumpError(path, 'expected an object.');
  }
  return value as JsonObject;
}

function records(dump: JsonObject, table: string): readonly JsonObject[] {
  const source = object(dump[table], table);
  return Object.entries(source).map(([key, value]) => {
    const record = object(value, `${table}.${key}`);
    if (record.name !== key || record.type !== table) {
      throw new FactorioDumpError(
        `${table}.${key}`,
        `expected matching name and type ${JSON.stringify(table)}.`,
      );
    }
    return record;
  });
}

function nonEmptyString(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new FactorioDumpError(path, 'expected a non-empty string.');
  }
  return value;
}

function finite(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new FactorioDumpError(path, 'expected a finite number.');
  }
  return value;
}

function optionalFinite(value: unknown, path: string): number | undefined {
  return value === undefined ? undefined : finite(value, path);
}

function componentList(value: unknown, path: string): readonly JsonObject[] {
  if (value === undefined) return [];
  if (Array.isArray(value)) return value.map((entry, index) => object(entry, `${path}[${index}]`));
  if (typeof value === 'object' && value !== null && Object.keys(value).length === 0) return [];
  throw new FactorioDumpError(path, 'expected an array or the empty-object sentinel.');
}

function optionalBoolean(value: unknown, path: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'boolean') throw new FactorioDumpError(path, 'expected a boolean.');
  return value;
}

function optionalNumbers(value: unknown, path: string): readonly number[] | undefined {
  if (value === undefined) return undefined;
  if (Array.isArray(value)) return value.map((entry, index) => finite(entry, `${path}[${index}]`));
  if (typeof value === 'object' && value !== null && Object.keys(value).length === 0) return [];
  throw new FactorioDumpError(path, 'expected an array or the empty-object sentinel.');
}

const rawFieldNames: Readonly<Record<RecipeComponentField, string>> = {
  amount: 'amount',
  amountMin: 'amount_min',
  amountMax: 'amount_max',
  extraCountFraction: 'extra_count_fraction',
  probability: 'probability',
  independentProbability: 'independent_probability',
  sharedProbability: 'shared_probability',
  ignoredByStats: 'ignored_by_stats',
  ignoredByProductivity: 'ignored_by_productivity',
  affectedByQuality: 'affected_by_quality',
  qualityChange: 'quality_change',
  qualityMin: 'quality_min',
  qualityMax: 'quality_max',
  percentSpoiled: 'percent_spoiled',
  alwaysFresh: 'always_fresh',
  resetFreshnessOnCraft: 'reset_freshness_on_craft',
  spoilWeight: 'spoil_weight',
  fluidboxIndex: 'fluidbox_index',
  fluidboxMultiplier: 'fluidbox_multiplier',
  optionalFluidboxIndexes: 'optional_fluidbox_indexes',
  temperature: 'temperature',
  temperatureMin: 'minimum_temperature',
  temperatureMax: 'maximum_temperature',
};

function recipeComponent(
  value: JsonObject,
  path: string,
  role: 'ingredient',
  warnings: FactorioDumpWarning[],
): RecipeIngredient;
function recipeComponent(
  value: JsonObject,
  path: string,
  role: 'product',
  warnings: FactorioDumpWarning[],
): RecipeProduct;
function recipeComponent(
  value: JsonObject,
  path: string,
  role: RecipeComponentRole,
  warnings: FactorioDumpWarning[],
): RecipeComponent {
  const type = nonEmptyString(value.type, `${path}.type`);
  if (type !== 'item' && type !== 'fluid') {
    throw new FactorioDumpError(`${path}.type`, 'expected item or fluid.');
  }
  const kind: RecipeComponentKind = type;
  const project = (field: RecipeComponentField): boolean => {
    const rawField = rawFieldNames[field];
    if (!Object.prototype.hasOwnProperty.call(value, rawField)) return false;
    if (isRecipeComponentFieldApplicable(field, role, kind)) return true;
    warnings.push({
      code: 'PD2003',
      path: `${path}.${rawField}`,
      message: `Raw field ${rawField} was retained by data.raw but was not promoted to a normalized runtime fact for this ${kind} ${role}.`,
    });
    return false;
  };

  const amount = project('amount') ? optionalFinite(value.amount, `${path}.amount`) : undefined;
  const amountMin = project('amountMin')
    ? optionalFinite(value.amount_min, `${path}.amount_min`)
    : undefined;
  const amountMax = project('amountMax')
    ? optionalFinite(value.amount_max, `${path}.amount_max`)
    : undefined;
  const extraCountFraction = project('extraCountFraction')
    ? optionalFinite(value.extra_count_fraction, `${path}.extra_count_fraction`)
    : undefined;
  const probability = project('probability')
    ? optionalFinite(value.probability, `${path}.probability`)
    : undefined;
  const independentProbability = project('independentProbability')
    ? optionalFinite(value.independent_probability, `${path}.independent_probability`)
    : undefined;
  const shared = project('sharedProbability')
    ? object(value.shared_probability, `${path}.shared_probability`)
    : undefined;
  const sharedProbability =
    shared === undefined
      ? undefined
      : {
          min: finite(shared.min, `${path}.shared_probability.min`),
          max: finite(shared.max, `${path}.shared_probability.max`),
        };
  const ignoredByStats = project('ignoredByStats')
    ? optionalFinite(value.ignored_by_stats, `${path}.ignored_by_stats`)
    : undefined;
  const ignoredByProductivity = project('ignoredByProductivity')
    ? optionalFinite(value.ignored_by_productivity, `${path}.ignored_by_productivity`)
    : undefined;
  const percentSpoiled = project('percentSpoiled')
    ? optionalFinite(value.percent_spoiled, `${path}.percent_spoiled`)
    : undefined;
  const spoilWeight = project('spoilWeight')
    ? optionalFinite(value.spoil_weight, `${path}.spoil_weight`)
    : undefined;
  const alwaysFresh = project('alwaysFresh')
    ? optionalBoolean(value.always_fresh, `${path}.always_fresh`)
    : undefined;
  const resetFreshnessOnCraft = project('resetFreshnessOnCraft')
    ? optionalBoolean(value.reset_freshness_on_craft, `${path}.reset_freshness_on_craft`)
    : undefined;
  const fluidboxIndex = project('fluidboxIndex')
    ? optionalFinite(value.fluidbox_index, `${path}.fluidbox_index`)
    : undefined;
  const fluidboxMultiplier = project('fluidboxMultiplier')
    ? optionalFinite(value.fluidbox_multiplier, `${path}.fluidbox_multiplier`)
    : undefined;
  const optionalFluidboxIndexes = project('optionalFluidboxIndexes')
    ? optionalNumbers(value.optional_fluidbox_indexes, `${path}.optional_fluidbox_indexes`)
    : undefined;
  const affectedByQuality = project('affectedByQuality')
    ? optionalBoolean(value.affected_by_quality, `${path}.affected_by_quality`)
    : undefined;
  const qualityChange = project('qualityChange')
    ? optionalFinite(value.quality_change, `${path}.quality_change`)
    : undefined;
  const qualityMin =
    !project('qualityMin') || value.quality_min === undefined
      ? undefined
      : (`quality:${nonEmptyString(value.quality_min, `${path}.quality_min`)}` as const);
  const qualityMax =
    !project('qualityMax') || value.quality_max === undefined
      ? undefined
      : (`quality:${nonEmptyString(value.quality_max, `${path}.quality_max`)}` as const);
  const temperature = project('temperature')
    ? optionalFinite(value.temperature, `${path}.temperature`)
    : undefined;
  const temperatureMin = project('temperatureMin')
    ? optionalFinite(value.minimum_temperature, `${path}.minimum_temperature`)
    : undefined;
  const temperatureMax = project('temperatureMax')
    ? optionalFinite(value.maximum_temperature, `${path}.maximum_temperature`)
    : undefined;
  const amountPolicy = evaluateRecipeAmount(
    {
      ...(amount === undefined ? {} : { amount }),
      ...(amountMin === undefined ? {} : { amountMin }),
      ...(amountMax === undefined ? {} : { amountMax }),
      ...(extraCountFraction === undefined ? {} : { extraCountFraction }),
    },
    role,
    kind,
    { allowDescendingProductRange: true },
  );
  for (const issue of amountPolicy.issues) {
    throw new FactorioDumpError(`${path}.${rawFieldNames[issue.field]}`, issue.message);
  }
  const effectiveAmount = amountPolicy.effective;
  return Object.freeze({
    prototype: `${type}:${nonEmptyString(value.name, `${path}.name`)}`,
    ...(effectiveAmount.amount === undefined ? {} : { amount: effectiveAmount.amount }),
    ...(effectiveAmount.amountMin === undefined ? {} : { amountMin: effectiveAmount.amountMin }),
    ...(effectiveAmount.amountMax === undefined ? {} : { amountMax: effectiveAmount.amountMax }),
    ...(extraCountFraction === undefined ? {} : { extraCountFraction }),
    ...(probability === undefined ? {} : { probability }),
    ...(independentProbability === undefined ? {} : { independentProbability }),
    ...(sharedProbability === undefined ? {} : { sharedProbability }),
    ...(ignoredByStats === undefined ? {} : { ignoredByStats }),
    ...(ignoredByProductivity === undefined ? {} : { ignoredByProductivity }),
    ...(affectedByQuality === undefined ? {} : { affectedByQuality }),
    ...(qualityChange === undefined ? {} : { qualityChange }),
    ...(qualityMin === undefined ? {} : { qualityMin }),
    ...(qualityMax === undefined ? {} : { qualityMax }),
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
  }) as RecipeComponent;
}

function explicitTileDimension(value: unknown, path: string): number | undefined {
  if (value === undefined) return undefined;
  const result = finite(value, path);
  if (!Number.isInteger(result) || result <= 0) {
    throw new FactorioDumpError(path, 'expected a positive integer.');
  }
  return result;
}

function collisionDimensions(
  record: JsonObject,
  path: string,
): readonly [number, number] | undefined {
  const value = record.collision_box;
  if (!Array.isArray(value) || value.length !== 2) return undefined;
  const first = value[0];
  const second = value[1];
  if (!Array.isArray(first) || !Array.isArray(second) || first.length < 2 || second.length < 2) {
    throw new FactorioDumpError(path, 'expected a two-corner bounding box.');
  }
  const width = Math.max(1, Math.ceil(Math.abs(finite(second[0], path) - finite(first[0], path))));
  const height = Math.max(1, Math.ceil(Math.abs(finite(second[1], path) - finite(first[1], path))));
  return [width, height];
}

function dimensions(record: JsonObject, path: string): readonly [number, number] | undefined {
  const tileWidth = explicitTileDimension(record.tile_width, `${path}.tile_width`);
  const tileHeight = explicitTileDimension(record.tile_height, `${path}.tile_height`);
  if (tileWidth !== undefined && tileHeight !== undefined) return [tileWidth, tileHeight];
  const fallback = collisionDimensions(record, `${path}.collision_box`);
  if (fallback === undefined) return undefined;
  return [tileWidth ?? fallback[0], tileHeight ?? fallback[1]];
}

function hasFluidBoxes(value: unknown): boolean {
  if (Array.isArray(value)) return value.length > 0;
  return typeof value === 'object' && value !== null && Object.keys(value).length > 0;
}

/** Converts Factorio's native data-raw-dump JSON shape into the validated v1 subset. */
export function normalizeFactorioDataDump(
  value: unknown,
  metadata: FactorioDumpMetadata,
): FactorioDumpNormalization {
  const dump = object(value, '<dump>');
  const warnings: FactorioDumpWarning[] = [];

  const items = Object.entries(dump).flatMap(([table, rawTable]) => {
    if (typeof rawTable !== 'object' || rawTable === null || Array.isArray(rawTable)) return [];
    return Object.entries(rawTable as JsonObject).flatMap(([name, rawRecord]) => {
      if (typeof rawRecord !== 'object' || rawRecord === null || Array.isArray(rawRecord))
        return [];
      const record = rawRecord as JsonObject;
      if (record.stack_size === undefined) return [];
      if (record.name !== name || record.type !== table) {
        throw new FactorioDumpError(
          `${table}.${name}`,
          `expected matching name and type ${JSON.stringify(table)}.`,
        );
      }
      return [
        {
          key: `item:${name}` as const,
          name,
          stackSize: finite(record.stack_size, `${table}.${name}.stack_size`),
        },
      ];
    });
  });

  const fluids = records(dump, 'fluid').map((record) => {
    const name = record.name as string;
    return { key: `fluid:${name}` as const, name };
  });

  const recipeCategories = records(dump, 'recipe-category').map((record) => {
    const name = record.name as string;
    return { key: `recipe-category:${name}` as const, name };
  });

  const virtualSignals = records(dump, 'virtual-signal').map((record) => {
    const name = record.name as string;
    return { key: `virtual:${name}` as const, name };
  });

  const qualities = records(dump, 'quality').map((record) => {
    const name = record.name as string;
    return {
      key: `quality:${name}` as const,
      name,
      level: finite(record.level, `quality.${name}.level`),
      next:
        record.next === undefined
          ? null
          : (`quality:${nonEmptyString(record.next, `quality.${name}.next`)}` as const),
    };
  });

  const recipes: RecipePrototype[] = [];
  for (const record of records(dump, 'recipe')) {
    const name = record.name as string;
    const products = componentList(record.results, `recipe.${name}.results`).map(
      (component, index) =>
        recipeComponent(component, `recipe.${name}.results[${index}]`, 'product', warnings),
    );
    const rawCategories =
      record.categories === undefined
        ? record.category === undefined
          ? ['crafting']
          : [record.category]
        : Array.isArray(record.categories)
          ? record.categories
          : [record.categories];
    const categories = rawCategories.map((category, index) =>
      nonEmptyString(category, `recipe.${name}.categories[${index}]`),
    );
    const ingredients = componentList(record.ingredients, `recipe.${name}.ingredients`).map(
      (component, index) =>
        recipeComponent(component, `recipe.${name}.ingredients[${index}]`, 'ingredient', warnings),
    );
    if (record.main_product !== undefined && typeof record.main_product !== 'string') {
      throw new FactorioDumpError(`recipe.${name}.main_product`, 'expected a string.');
    }
    const mainProductName = record.main_product === '' ? undefined : record.main_product;
    const candidates =
      mainProductName === undefined
        ? []
        : [
            ...new Set(
              products
                .filter(
                  ({ prototype }) =>
                    prototype.slice(prototype.indexOf(':') + 1) === mainProductName,
                )
                .map(({ prototype }) => prototype),
            ),
          ];
    if (mainProductName !== undefined && candidates.length !== 1) {
      throw new FactorioDumpError(
        `recipe.${name}.main_product`,
        'expected exactly one matching product namespace; use runtime typed main_product for ambiguous raw names.',
      );
    }
    const mainProduct = candidates[0];
    recipes.push({
      key: `recipe:${name}`,
      name,
      categories,
      energy:
        record.energy_required === undefined
          ? 0.5
          : finite(record.energy_required, `recipe.${name}.energy_required`),
      ingredients,
      products,
      ...(mainProduct === undefined ? {} : { mainProduct }),
      enabledByDefault: optionalBoolean(record.enabled, `recipe.${name}.enabled`) ?? true,
      allowProductivity:
        optionalBoolean(record.allow_productivity, `recipe.${name}.allow_productivity`) ?? false,
      hidden: optionalBoolean(record.hidden, `recipe.${name}.hidden`) ?? false,
    });
  }

  const entities: EntityPrototype[] = [];
  for (const [table, rawTable] of Object.entries(dump)) {
    if (!isFactorioEntityPrototypeType(table)) continue;
    if (typeof rawTable !== 'object' || rawTable === null || Array.isArray(rawTable)) continue;
    for (const [name, rawRecord] of Object.entries(rawTable as JsonObject)) {
      if (typeof rawRecord !== 'object' || rawRecord === null || Array.isArray(rawRecord)) continue;
      const record = rawRecord as JsonObject;
      if (record.name !== name || record.type !== table) {
        throw new FactorioDumpError(
          `${table}.${name}`,
          `expected matching name and type ${JSON.stringify(table)}.`,
        );
      }
      const size = dimensions(record, `${table}.${name}`);
      const categories = Array.isArray(record.crafting_categories)
        ? record.crafting_categories.map((category, index) =>
            nonEmptyString(category, `${table}.${name}.crafting_categories[${index}]`),
          )
        : undefined;
      entities.push({
        key: `entity:${name}`,
        name,
        type: table,
        ...(size === undefined ? {} : { tileWidth: size[0], tileHeight: size[1] }),
        ...(categories === undefined
          ? {}
          : { crafting: { categories, supportsFluids: hasFluidBoxes(record.fluid_boxes) } }),
      });
    }
  }

  warnings.push({
    code: 'PD2002',
    path: 'entities.*.circuit',
    message:
      'data-raw-dump does not expose normalized per-entity circuit behavior capabilities; coverage remains false.',
  });

  const environment: PrototypeEnvironment = {
    ...metadata,
    generatorVersion: 'comblang-factorio-data-dump-v1.9',
  };
  const candidate = {
    schemaVersion: 1,
    environment,
    capabilities: {
      itemStackSizes: true,
      fluids: true,
      recipes: true,
      entities: true,
      entityCircuitCapabilities: false,
      qualities: true,
      recipeCategories: true,
      virtualSignals: true,
    },
    items,
    fluids,
    recipes,
    entities,
    qualities,
    recipeCategories,
    virtualSignals,
    indexes: buildPrototypeIndexes(recipes),
  };
  return Object.freeze({
    database: validatePrototypeDatabase(candidate),
    warnings: Object.freeze(warnings.map((warning) => Object.freeze(warning))),
  });
}

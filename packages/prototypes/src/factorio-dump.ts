import type {
  EntityPrototype,
  PrototypeDatabaseV1,
  PrototypeEnvironment,
  PrototypeMod,
  RecipeComponent,
  RecipePrototype,
} from './schema.js';
import { buildPrototypeIndexes, validatePrototypeDatabase } from './validation.js';

type JsonObject = Record<string, unknown>;

export interface FactorioDumpMetadata {
  readonly factorioVersion: string;
  readonly expansions: readonly string[];
  readonly mods: readonly PrototypeMod[];
  readonly startupSettingsIdentity?: string;
  readonly generatedAt?: string;
}

export interface FactorioDumpWarning {
  readonly code: 'PD2001' | 'PD2002';
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

const unsupportedComponentFields = Object.freeze([
  'percent_spoiled',
  'fluidbox_index',
  'fluidbox_multiplier',
  'optional_fluidbox_indexes',
] as const);

function recipeComponent(
  value: JsonObject,
  path: string,
  ignoredFields: Map<string, number>,
): RecipeComponent {
  const type = nonEmptyString(value.type, `${path}.type`);
  if (type !== 'item' && type !== 'fluid') {
    throw new FactorioDumpError(`${path}.type`, 'expected item or fluid.');
  }
  for (const field of unsupportedComponentFields) {
    if (value[field] !== undefined) ignoredFields.set(field, (ignoredFields.get(field) ?? 0) + 1);
  }
  const amount = optionalFinite(value.amount, `${path}.amount`);
  const amountMin = optionalFinite(value.amount_min, `${path}.amount_min`);
  const amountMax = optionalFinite(value.amount_max, `${path}.amount_max`);
  const extraCountFraction = optionalFinite(
    value.extra_count_fraction,
    `${path}.extra_count_fraction`,
  );
  const probability = optionalFinite(value.probability, `${path}.probability`);
  const independentProbability = optionalFinite(
    value.independent_probability,
    `${path}.independent_probability`,
  );
  const shared =
    value.shared_probability === undefined
      ? undefined
      : object(value.shared_probability, `${path}.shared_probability`);
  const sharedProbability =
    shared === undefined
      ? undefined
      : {
          min: finite(shared.min, `${path}.shared_probability.min`),
          max: finite(shared.max, `${path}.shared_probability.max`),
        };
  const ignoredByStats = optionalFinite(value.ignored_by_stats, `${path}.ignored_by_stats`);
  const ignoredByProductivity = optionalFinite(
    value.ignored_by_productivity,
    `${path}.ignored_by_productivity`,
  );
  const temperature = optionalFinite(value.temperature, `${path}.temperature`);
  const temperatureMin = optionalFinite(value.minimum_temperature, `${path}.minimum_temperature`);
  const temperatureMax = optionalFinite(value.maximum_temperature, `${path}.maximum_temperature`);
  return {
    prototype: `${type}:${nonEmptyString(value.name, `${path}.name`)}`,
    ...(amount === undefined ? {} : { amount }),
    ...(amountMin === undefined ? {} : { amountMin }),
    ...(amountMax === undefined ? {} : { amountMax }),
    ...(extraCountFraction === undefined ? {} : { extraCountFraction }),
    ...(probability === undefined ? {} : { probability }),
    ...(independentProbability === undefined ? {} : { independentProbability }),
    ...(sharedProbability === undefined ? {} : { sharedProbability }),
    ...(ignoredByStats === undefined ? {} : { ignoredByStats }),
    ...(ignoredByProductivity === undefined ? {} : { ignoredByProductivity }),
    ...(temperature === undefined ? {} : { temperature }),
    ...(temperatureMin === undefined ? {} : { temperatureMin }),
    ...(temperatureMax === undefined ? {} : { temperatureMax }),
  };
}

function dimensions(record: JsonObject, path: string): readonly [number, number] | undefined {
  const value = record.selection_box ?? record.collision_box;
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
  const ignoredFields = new Map<string, number>();
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
    };
  });

  const recipes: RecipePrototype[] = [];
  for (const record of records(dump, 'recipe')) {
    const name = record.name as string;
    const products = componentList(record.results, `recipe.${name}.results`).map(
      (component, index) =>
        recipeComponent(component, `recipe.${name}.results[${index}]`, ignoredFields),
    );
    if (products.length === 0) {
      warnings.push({
        code: 'PD2001',
        path: `recipe.${name}`,
        message: 'Skipped a recipe with no products (normally an engine sentinel).',
      });
      continue;
    }
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
        recipeComponent(component, `recipe.${name}.ingredients[${index}]`, ignoredFields),
    );
    const mainProductName =
      typeof record.main_product === 'string' && record.main_product.length > 0
        ? record.main_product
        : undefined;
    const mainProduct =
      mainProductName === undefined
        ? undefined
        : products.find(
            ({ prototype }) => prototype.slice(prototype.indexOf(':') + 1) === mainProductName,
          )?.prototype;
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
      enabledByDefault: record.enabled === undefined ? true : record.enabled === true,
      allowProductivity: record.allow_productivity === true,
      hidden: record.hidden === true,
    });
  }

  const entities: EntityPrototype[] = [];
  for (const [table, rawTable] of Object.entries(dump)) {
    if (typeof rawTable !== 'object' || rawTable === null || Array.isArray(rawTable)) continue;
    for (const [name, rawRecord] of Object.entries(rawTable as JsonObject)) {
      if (typeof rawRecord !== 'object' || rawRecord === null || Array.isArray(rawRecord)) continue;
      const record = rawRecord as JsonObject;
      if (record.name !== name || record.type !== table) continue;
      const size = dimensions(record, `${table}.${name}.selection_box`);
      if (size === undefined) continue;
      const categories = Array.isArray(record.crafting_categories)
        ? record.crafting_categories.map((category, index) =>
            nonEmptyString(category, `${table}.${name}.crafting_categories[${index}]`),
          )
        : undefined;
      entities.push({
        key: `entity:${name}`,
        name,
        type: table,
        tileWidth: size[0],
        tileHeight: size[1],
        ...(categories === undefined
          ? {}
          : { crafting: { categories, supportsFluids: hasFluidBoxes(record.fluid_boxes) } }),
      });
    }
  }

  for (const [field, count] of [...ignoredFields].sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    warnings.push({
      code: 'PD2001',
      path: `recipe.*.${field}`,
      message: `The v1 recipe subset does not retain ${field} (${count} occurrence${count === 1 ? '' : 's'}).`,
    });
  }
  warnings.push({
    code: 'PD2002',
    path: 'entities.*.circuit',
    message:
      'data-raw-dump does not expose normalized per-entity circuit behavior capabilities; coverage remains false.',
  });

  const environment: PrototypeEnvironment = {
    ...metadata,
    generatorVersion: 'comblang-factorio-data-dump-v1.1',
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

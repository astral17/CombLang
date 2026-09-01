import type { PrototypeDatabaseV1 } from './schema.js';

const circuit = {
  read: true,
  enableDisable: true,
  readContents: true,
  setFilters: false,
  setRequests: false,
  setRecipe: true,
  readRecipe: true,
  readFinishedCraft: true,
  outputSignals: true,
} as const;

const fixture: PrototypeDatabaseV1 = {
  schemaVersion: 1,
  environment: {
    factorioVersion: '2.1.16',
    expansions: ['space-age'],
    mods: [
      { name: 'base', version: '2.1.16' },
      { name: 'space-age', version: '2.1.16' },
    ],
    startupSettingsIdentity: 'synthetic-defaults-v1',
    generatorVersion: 'fixture-v1',
    generatedAt: '2026-09-01T00:00:00.000Z',
  },
  capabilities: {
    itemStackSizes: true,
    fluids: true,
    recipes: true,
    entities: true,
    entityCircuitCapabilities: true,
    qualities: true,
    recipeCategories: true,
    virtualSignals: true,
  },
  items: [
    { key: 'item:copper-plate', name: 'copper-plate', stackSize: 100 },
    { key: 'item:iron-gear-wheel', name: 'iron-gear-wheel', stackSize: 100 },
    { key: 'item:iron-plate', name: 'iron-plate', stackSize: 100 },
  ],
  fluids: [{ key: 'fluid:water', name: 'water' }],
  recipes: [
    {
      key: 'recipe:iron-gear-wheel',
      name: 'iron-gear-wheel',
      category: 'crafting',
      energy: 0.5,
      ingredients: [{ prototype: 'item:iron-plate', amount: 2 }],
      products: [{ prototype: 'item:iron-gear-wheel', amount: 1 }],
      mainProduct: 'item:iron-gear-wheel',
    },
    {
      key: 'recipe:modded-gear-wheel',
      name: 'modded-gear-wheel',
      category: 'crafting',
      energy: 1,
      ingredients: [{ prototype: 'item:copper-plate', amount: 3 }],
      products: [{ prototype: 'item:iron-gear-wheel', amountMin: 1, amountMax: 2 }],
    },
    {
      key: 'recipe:water-cycle',
      name: 'water-cycle',
      category: 'chemistry',
      energy: 2,
      ingredients: [{ prototype: 'fluid:water', amount: 10, temperatureMin: 15 }],
      products: [{ prototype: 'fluid:water', amount: 10, probability: 0.9 }],
    },
  ],
  entities: [
    {
      key: 'entity:assembling-machine-3',
      name: 'assembling-machine-3',
      type: 'assembling-machine',
      tileWidth: 3,
      tileHeight: 3,
      circuit,
      crafting: { categories: ['crafting'], supportsFluids: false },
    },
    {
      key: 'entity:chemical-plant',
      name: 'chemical-plant',
      type: 'assembling-machine',
      tileWidth: 3,
      tileHeight: 3,
      circuit,
      crafting: { categories: ['chemistry'], supportsFluids: true },
    },
  ],
  qualities: [
    { key: 'quality:normal', name: 'normal', level: 0 },
    { key: 'quality:rare', name: 'rare', level: 2 },
  ],
  recipeCategories: [
    { key: 'recipe-category:chemistry', name: 'chemistry' },
    { key: 'recipe-category:crafting', name: 'crafting' },
  ],
  virtualSignals: [
    { key: 'virtual:signal-A', name: 'signal-A' },
    { key: 'virtual:signal-each', name: 'signal-each' },
  ],
  indexes: {
    recipesByProduct: {
      'fluid:water': ['recipe:water-cycle'],
      'item:iron-gear-wheel': ['recipe:iron-gear-wheel', 'recipe:modded-gear-wheel'],
    },
  },
};

/** Fresh mutable JSON-shaped data for validator/provider tests and examples. */
export function syntheticPrototypeDatabase(): unknown {
  return structuredClone(fixture);
}

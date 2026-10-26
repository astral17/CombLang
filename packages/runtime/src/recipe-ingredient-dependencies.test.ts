import { signal } from '@comblang/factorio';
import { sourceFileId } from '@comblang/shared';
import { describe, expect, test } from 'vitest';

import {
  createBlueprintParameterSession,
  createBlueprintParameterSourceView,
  inspectBlueprintParameterHandle,
} from '../../compiler/src/blueprint-parameters.js';
import { loadPrototypeDatabase } from '../../prototypes/src/provider.js';
import type { RecipeIngredient, RecipePrototype } from '../../prototypes/src/schema.js';
import { buildPrototypeIndexes } from '../../prototypes/src/validation.js';
import { syntheticPrototypeDatabase } from '../../prototypes/src/fixtures.js';
import {
  createRecipeIngredientDependencyContext,
  type ResolvedRecipeIngredientDependency,
} from './recipe-ingredient-dependencies.js';

const source = Object.freeze({
  fileId: sourceFileId('recipe-ingredient-dependencies.test.ts'),
  start: 12,
  end: 28,
});

interface MutableFixture {
  items: { key: string; name: string; stackSize: number }[];
  recipes: RecipePrototype[];
  capabilities: Record<string, boolean>;
  indexes: ReturnType<typeof buildPrototypeIndexes>;
}

function recipe(
  key: string,
  name: string,
  ingredients: readonly RecipeIngredient[],
  products: RecipePrototype['products'],
): RecipePrototype {
  return {
    key: key as RecipePrototype['key'],
    name,
    categories: ['crafting'],
    energy: 1,
    ingredients,
    products,
  };
}

const chestIngredients: readonly RecipeIngredient[] = [
  { prototype: 'item:iron-plate', amount: 2, qualityMin: 'quality:rare' },
  { prototype: 'fluid:water', amount: 0.25, temperatureMin: 15, temperatureMax: 25 },
  { prototype: 'item:iron-plate', amount: 3 },
];

function selectionOf(result: ResolvedRecipeIngredientDependency) {
  if (result.status !== 'present') {
    throw new Error('Expected a present recipe ingredient dependency');
  }
  return result.selection;
}

async function environment(
  options: {
    readonly chestIngredients?: readonly RecipeIngredient[];
    readonly includeChestRecipe?: boolean;
    readonly includeProductOnlyRecipe?: boolean;
    readonly recipesAvailable?: boolean;
  } = {},
) {
  const fixture = syntheticPrototypeDatabase() as MutableFixture;
  fixture.items.push(
    { key: 'item:iron-chest', name: 'iron-chest', stackSize: 48 },
    { key: 'item:steel-chest', name: 'steel-chest', stackSize: 48 },
  );
  if (options.includeChestRecipe !== false) {
    fixture.recipes.push(
      recipe('recipe:iron-chest', 'iron-chest', options.chestIngredients ?? chestIngredients, [
        { prototype: 'item:iron-chest', amount: 1 },
      ]),
      recipe(
        'recipe:steel-chest',
        'steel-chest',
        [{ prototype: 'item:copper-plate', amount: 4 }],
        [{ prototype: 'item:steel-chest', amount: 1 }],
      ),
    );
  }
  if (options.includeProductOnlyRecipe) {
    fixture.recipes.push(
      recipe(
        'recipe:chest-from-scrap',
        'chest-from-scrap',
        [{ prototype: 'item:iron-plate', amount: 1 }],
        [{ prototype: 'item:iron-chest', amount: 1 }],
      ),
    );
  }
  if (options.recipesAvailable === false) fixture.capabilities.recipes = false;
  fixture.indexes = buildPrototypeIndexes(fixture.recipes);
  return loadPrototypeDatabase(fixture);
}

describe('host recipe ingredient dependencies', () => {
  test('resolves an ID without a default only after a concrete local binding', async () => {
    const loaded = await environment();
    const session = createBlueprintParameterSession();
    const parameter = session.signal('Container', { source });
    const context = createRecipeIngredientDependencyContext(session, loaded.prototypes);
    const dependency = context.dependency(parameter, 0, source);

    expect(() => context.resolve()).toThrowError(
      expect.objectContaining({ code: 'CP1002', span: source }),
    );
    expect(context.resolved).toEqual([]);
    expect(context.resultFor(dependency)).toBeUndefined();

    const resolved = context.resolve([{ parameter, value: signal('item', 'iron-chest') }]);
    expect(selectionOf(resolved[0]!).ingredient).toBe(
      loaded.prototypes.getRecipe('iron-chest')!.ingredients[0],
    );
    expect(inspectBlueprintParameterHandle(parameter, '$.test').defaultValue).toBeUndefined();
  });

  test('resolves the exact same-name recipe from defaults, overrides and reset', async () => {
    const loaded = await environment();
    const session = createBlueprintParameterSession();
    const defaultSignal = signal('item', 'iron-chest');
    const parameter = session.signal('Container', { defaultValue: defaultSignal, source });
    const context = createRecipeIngredientDependencyContext(session, loaded.prototypes);
    const dependency = context.dependency(parameter, 0, source);

    const defaults = context.resolve();
    expect(defaults).toHaveLength(1);
    expect(selectionOf(defaults[0]!)).toEqual({
      ok: true,
      recipe: 'recipe:iron-chest',
      index: 0,
      ingredient: chestIngredients[0],
    });
    expect(loaded.prototypes.getRecipe('iron-chest')?.key).not.toBe('item:iron-chest');
    expect(context.resultFor(dependency)).toBe(defaults[0]);

    const overridden = context.resolve([{ parameter, value: signal('item', 'steel-chest') }]);
    expect(selectionOf(overridden[0]!)).toEqual({
      ok: true,
      recipe: 'recipe:steel-chest',
      index: 0,
      ingredient: { prototype: 'item:copper-plate', amount: 4 },
    });
    const reset = context.reset();
    expect(selectionOf(reset[0]!).ingredient).toBe(
      loaded.prototypes.getRecipe('iron-chest')!.ingredients[0],
    );
    expect(context.resultFor(dependency)).toBe(reset[0]);
    expect(inspectBlueprintParameterHandle(parameter, '$.test.parameter').defaultValue).toEqual(
      defaultSignal,
    );
  });

  test('preserves exact component identity, order, duplicates and constraints', async () => {
    const loaded = await environment();
    const session = createBlueprintParameterSession();
    const parameter = session.signal('Container', {
      defaultValue: signal('item', 'iron-chest', 'rare'),
      source,
    });
    const context = createRecipeIngredientDependencyContext(session, loaded.prototypes);
    const dependencies = chestIngredients.map((_, index) =>
      context.dependency(parameter, index, source),
    );
    const resolved = context.resolve();
    const recipeValue = loaded.prototypes.getRecipe('iron-chest')!;

    expect(resolved.map((result) => selectionOf(result).ingredient)).toEqual(chestIngredients);
    expect(resolved.map((result) => selectionOf(result).ingredient)).toEqual(
      recipeValue.ingredients,
    );
    resolved.forEach((result, index) => {
      expect(selectionOf(result).ingredient).toBe(recipeValue.ingredients[index]);
    });
    expect(selectionOf(resolved[0]!).ingredient.prototype).toBe(
      selectionOf(resolved[2]!).ingredient.prototype,
    );
    expect(selectionOf(resolved[0]!).ingredient.amount).not.toBe(
      selectionOf(resolved[2]!).ingredient.amount,
    );
    expect(dependencies.map((dependency) => context.resultFor(dependency))).toEqual(resolved);
  });

  test('does not fall back to a recipe that merely produces the selected item', async () => {
    const loaded = await environment({ includeChestRecipe: false, includeProductOnlyRecipe: true });
    const session = createBlueprintParameterSession();
    const parameter = session.signal('Container', {
      defaultValue: signal('item', 'iron-chest'),
      source,
    });
    const context = createRecipeIngredientDependencyContext(session, loaded.prototypes);
    context.dependency(parameter, 0, source);

    expect(loaded.prototypes.recipesProducing('item:iron-chest')).toHaveLength(1);
    expect(() => context.resolve()).toThrowError(
      expect.objectContaining({ reason: 'unknown-recipe', source }),
    );
  });

  test('keeps distinct handles with equal defaults as distinct dependencies', async () => {
    const loaded = await environment();
    const session = createBlueprintParameterSession();
    const defaultSignal = signal('item', 'iron-chest');
    const firstHandle = session.signal('First', { defaultValue: defaultSignal, source });
    const secondHandle = session.signal('Second', { defaultValue: defaultSignal, source });
    const context = createRecipeIngredientDependencyContext(session, loaded.prototypes);
    const firstDependency = context.dependency(firstHandle, 0, source);
    const secondDependency = context.dependency(secondHandle, 2, source);
    const resolved = context.resolve();

    expect(resolved).toHaveLength(2);
    expect(resolved[0]!.dependency).toBe(firstDependency);
    expect(resolved[1]!.dependency).toBe(secondDependency);
    expect(context.resultFor(firstDependency)).toBe(resolved[0]);
    expect(context.resultFor(secondDependency)).toBe(resolved[1]);
    expect(resolved.map((result) => selectionOf(result).ingredient.amount)).toEqual([2, 3]);
  });

  test('reports missing recipe capability separately and preserves the committed result', async () => {
    const available = await environment();
    const unavailable = await environment({ recipesAvailable: false });
    const session = createBlueprintParameterSession();
    const parameter = session.signal('Container', {
      defaultValue: signal('item', 'iron-chest'),
      source,
    });
    const good = createRecipeIngredientDependencyContext(session, available.prototypes);
    good.dependency(parameter, 0, source);
    const committed = good.resolve();
    const bad = createRecipeIngredientDependencyContext(session, unavailable.prototypes);
    bad.dependency(parameter, 0, source);

    expect(() => bad.resolve()).toThrowError(
      expect.objectContaining({ reason: 'recipes-unavailable', source }),
    );
    expect(good.resolved).toBe(committed);
    expect(selectionOf(committed[0]!).ingredient).toBe(
      available.prototypes.getRecipe('iron-chest')!.ingredients[0],
    );
  });

  test('authenticates host handles and source views and rejects invalid registrations', async () => {
    const loaded = await environment();
    const session = createBlueprintParameterSession();
    const parameter = session.signal('Container', {
      defaultValue: signal('item', 'iron-chest'),
      source,
    });
    const number = session.number('Amount', { defaultValue: 1, source });
    const foreignSession = createBlueprintParameterSession();
    const foreign = foreignSession.signal('Container', {
      defaultValue: signal('item', 'iron-chest'),
    });
    const context = createRecipeIngredientDependencyContext(session, loaded.prototypes);
    const sourceView = createBlueprintParameterSourceView(session, parameter);

    expect(() => context.dependency(number as never, 0, source)).toThrowError(
      expect.objectContaining({ code: 'CP1001', path: '$.dependency.parameter' }),
    );
    expect(() => context.dependency(foreign, 0, source)).toThrowError(
      expect.objectContaining({ code: 'CP1001', path: '$.dependency.parameter', span: source }),
    );
    expect(() => context.dependency({ ...parameter } as never, 0, source)).toThrowError(
      expect.objectContaining({ code: 'CP1001', path: '$.dependency.parameter', span: source }),
    );
    expect(() => context.dependency(parameter, -1, source)).toThrowError(
      expect.objectContaining({ code: 'CP1000', path: '$.dependency.index', span: source }),
    );
    expect(context.dependency(sourceView as never, 0, source)).toBeDefined();
    expect(inspectBlueprintParameterHandle(parameter, '$.test').defaultValue).toEqual(
      signal('item', 'iron-chest'),
    );
  });

  test('uses valid unrelated bindings and rejects malformed or duplicate bindings atomically', async () => {
    const loaded = await environment();
    const session = createBlueprintParameterSession();
    const parameter = session.signal('Container', {
      defaultValue: signal('item', 'iron-chest'),
      source,
    });
    const count = session.number('Count', { defaultValue: 2, source });
    const unrelated = session.signal('Unrelated', {
      defaultValue: signal('virtual', 'signal-A'),
      source,
    });
    const context = createRecipeIngredientDependencyContext(session, loaded.prototypes);
    const dependency = context.dependency(parameter, 0, source);
    const first = context.resolve([
      { parameter: count, value: 5 },
      { parameter: unrelated, value: signal('virtual', 'signal-A') },
    ]);

    expect(selectionOf(first[0]!).ingredient).toEqual(chestIngredients[0]);
    expect(() =>
      context.resolve([
        { parameter, value: signal('item', 'steel-chest') },
        { parameter, value: signal('item', 'iron-chest') },
      ]),
    ).toThrowError(expect.objectContaining({ code: 'CP1001' }));
    expect(() => context.resolve([{ parameter: count, value: Number.NaN }])).toThrowError(
      expect.objectContaining({ code: 'CP1000' }),
    );
    expect(context.resolved).toBe(first);
    expect(context.resultFor(dependency)).toBe(first[0]);
  });

  test('resolves present to absent to present and reset restores defaults', async () => {
    const loaded = await environment();
    const session = createBlueprintParameterSession();
    const parameter = session.signal('Container', {
      defaultValue: signal('item', 'iron-chest'),
      source,
    });
    const context = createRecipeIngredientDependencyContext(session, loaded.prototypes);
    const dependency = context.dependency(parameter, 2, source);
    const defaults = context.resolve();

    const absent = context.resolve([{ parameter, value: signal('item', 'steel-chest') }]);
    expect(absent[0]).toEqual({
      status: 'absent',
      dependency,
      source,
      recipe: 'recipe:steel-chest',
      index: 2,
    });
    expect(context.resultFor(dependency)).toBe(absent[0]);
    expect(Object.keys(absent[0]!)).not.toContain('selection');

    const presentAgain = context.resolve();
    expect(presentAgain[0]!.status).toBe('present');
    expect(selectionOf(presentAgain[0]!).ingredient).toBe(
      loaded.prototypes.getRecipe('iron-chest')!.ingredients[2],
    );
    const reset = context.reset();
    expect(selectionOf(reset[0]!).ingredient).toBe(
      loaded.prototypes.getRecipe('iron-chest')!.ingredients[2],
    );
    expect(Object.isFrozen(defaults)).toBe(true);
    expect(Object.isFrozen(defaults[0])).toBe(true);
    expect(Object.isFrozen(absent)).toBe(true);
    expect(Object.isFrozen(absent[0])).toBe(true);
    expect(defaults[0]!.status).toBe('present');
    expect(context.resolved).toBe(reset);
  });

  test('mixes present and absent dependencies from one root without losing binding identity', async () => {
    const loaded = await environment();
    const session = createBlueprintParameterSession();
    const parameter = session.signal('Container', {
      defaultValue: signal('item', 'iron-chest'),
      source,
    });
    const context = createRecipeIngredientDependencyContext(session, loaded.prototypes);
    const presentDependency = context.dependency(parameter, 1, source);
    const absentDependency = context.dependency(parameter, 9, source);

    const resolved = context.resolve();
    expect(resolved.map(({ status }) => status)).toEqual(['present', 'absent']);
    expect(selectionOf(resolved[0]!).ingredient).toBe(
      loaded.prototypes.getRecipe('iron-chest')!.ingredients[1],
    );
    expect(resolved[1]).toEqual({
      status: 'absent',
      dependency: absentDependency,
      source,
      recipe: 'recipe:iron-chest',
      index: 9,
    });
    expect(context.resultFor(presentDependency)).toBe(resolved[0]);
    expect(context.resultFor(absentDependency)).toBe(resolved[1]);
  });

  test('resolves empty recipes and very large safe indices as absence without indexed allocation', async () => {
    const empty = await environment({ chestIngredients: [] });
    const session = createBlueprintParameterSession();
    const parameter = session.signal('Container', {
      defaultValue: signal('item', 'iron-chest'),
      source,
    });
    const context = createRecipeIngredientDependencyContext(session, empty.prototypes);
    const emptyDependency = context.dependency(parameter, 0, source);
    const hugeDependency = context.dependency(parameter, Number.MAX_SAFE_INTEGER, source);

    const resolved = context.resolve();
    expect(resolved).toEqual([
      {
        status: 'absent',
        dependency: emptyDependency,
        source,
        recipe: 'recipe:iron-chest',
        index: 0,
      },
      {
        status: 'absent',
        dependency: hugeDependency,
        source,
        recipe: 'recipe:iron-chest',
        index: Number.MAX_SAFE_INTEGER,
      },
    ]);
  });

  test('rolls back a computed absence when a later root has no exact recipe', async () => {
    const loaded = await environment();
    const session = createBlueprintParameterSession();
    const firstRoot = session.signal('First', {
      defaultValue: signal('item', 'iron-chest'),
      source,
    });
    const laterRoot = session.signal('Later', {
      defaultValue: signal('item', 'iron-chest'),
      source,
    });
    const context = createRecipeIngredientDependencyContext(session, loaded.prototypes);
    const firstDependency = context.dependency(firstRoot, 2, source);
    const laterDependency = context.dependency(laterRoot, 0, source);
    const committed = context.resolve();

    expect(committed.map(({ status }) => status)).toEqual(['present', 'present']);
    expect(() =>
      context.resolve([
        { parameter: firstRoot, value: signal('item', 'steel-chest') },
        { parameter: laterRoot, value: signal('item', 'iron-plate') },
      ]),
    ).toThrowError(expect.objectContaining({ reason: 'unknown-recipe', source }));

    expect(context.resolved).toBe(committed);
    expect(context.resultFor(firstDependency)).toBe(committed[0]);
    expect(context.resultFor(laterDependency)).toBe(committed[1]);
    expect(committed.map(({ status }) => status)).toEqual(['present', 'present']);
  });

  test('keeps contexts and dependency tokens isolated even for equal labels and IDs', async () => {
    const ironEnvironment = await environment();
    const copperEnvironment = await environment({
      chestIngredients: [{ prototype: 'item:copper-plate', amount: 7 }],
    });
    const firstSession = createBlueprintParameterSession();
    const secondSession = createBlueprintParameterSession();
    const firstHandle = firstSession.signal('Same label', {
      defaultValue: signal('item', 'iron-chest'),
    });
    const secondHandle = secondSession.signal('Same label', {
      defaultValue: signal('item', 'iron-chest'),
    });
    const first = createRecipeIngredientDependencyContext(firstSession, ironEnvironment.prototypes);
    const second = createRecipeIngredientDependencyContext(
      secondSession,
      copperEnvironment.prototypes,
    );
    const firstToken = first.dependency(firstHandle, 0, source);
    second.dependency(secondHandle, 0, source);

    expect(selectionOf(first.resolve()[0]!).ingredient.prototype).toBe('item:iron-plate');
    expect(selectionOf(second.resolve()[0]!).ingredient.prototype).toBe('item:copper-plate');
    expect(() => second.resultFor(firstToken)).toThrowError(
      expect.objectContaining({ code: 'CP1001', path: '$.dependency' }),
    );
  });
});

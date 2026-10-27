import { readFileSync } from 'node:fs';
import { signal } from '@comblang/factorio';
import {
  createTrustedEntityReplayContext,
  syntheticZeroPortEntityProfile,
} from '@comblang/compiler';
import builtinPrototypeDatabase from '../../prototypes/generated/space-age-2.1.17.json';
import type { EntityProfile } from '@comblang/compiler/entity';
import { loadPrototypeDatabase, type PrototypeProvider } from '../../prototypes/src/provider.js';
import { syntheticPrototypeDatabase } from '../../prototypes/src/fixtures.js';
import type {
  EntityPrototype,
  PrototypeDatabaseV1,
  RecipeIngredient,
} from '../../prototypes/src/schema.js';
import { describe, expect, test } from 'vitest';

import {
  bindSourceCompilationCircuit,
  bindSourceCompilationParameters,
  compileSourceProgram,
  exportSourceCompilationNativeBlueprint,
  listSourceCompilationParameters,
  sourceCompilationArtifact,
} from './source-compilation.js';
import type { EntityPrototypeResolver } from './entity-registry.js';

async function recipeProvider(options: { readonly fractionalWater?: boolean } = {}) {
  const base = syntheticPrototypeDatabase() as PrototypeDatabaseV1;
  const recipes = [...base.recipes];
  const moddedIndex = recipes.findIndex(({ name }) => name === 'modded-gear-wheel');
  const modded = recipes[moddedIndex]!;
  recipes[moddedIndex] = {
    ...modded,
    ingredients: [
      ...modded.ingredients,
      { prototype: 'item:iron-plate', amount: 4 } as RecipeIngredient,
    ],
  };
  if (options.fractionalWater) {
    const waterIndex = recipes.findIndex(({ name }) => name === 'water-cycle');
    const water = recipes[waterIndex]!;
    recipes[waterIndex] = {
      ...water,
      ingredients: [{ ...water.ingredients[0]!, amount: 0.25 }],
    };
  }
  return loadPrototypeDatabase({ ...base, recipes });
}

function sourceHost(prototypes: PrototypeProvider) {
  const constantProfile: EntityProfile = {
    ...structuredClone(syntheticZeroPortEntityProfile),
    ref: {
      ...syntheticZeroPortEntityProfile.ref,
      database: {
        schemaVersion: prototypes.schemaVersion,
        identity: prototypes.identity,
      } as EntityProfile['ref']['database'],
      prototypeKey: 'entity:constant-combinator' as EntityProfile['ref']['prototypeKey'],
      profileId: 'profile:recipe-ingredient-constant' as EntityProfile['ref']['profileId'],
    },
    prototypeType: 'constant-combinator',
  };
  const trustedEntityReplayContext = createTrustedEntityReplayContext({
    database: constantProfile.ref.database,
    source: 'synthetic',
    evidenceIdentity: 'recipe-ingredient-source-evidence',
    policyIdentity: 'recipe-ingredient-source-policy',
    profiles: [constantProfile],
  });
  const entity: EntityPrototype = {
    key: 'entity:constant-combinator' as EntityPrototype['key'],
    name: 'constant-combinator',
    type: 'constant-combinator',
    tileWidth: 1,
    tileHeight: 1,
  };
  const entityPrototypeResolver: EntityPrototypeResolver = {
    database: trustedEntityReplayContext.database,
    getEntity(nameOrKey) {
      return nameOrKey === entity.key || nameOrKey === entity.name ? entity : undefined;
    },
  };
  return { prototypes, trustedEntityReplayContext, entityPrototypeResolver };
}

function configurationOf(value: ReturnType<typeof bindSourceCompilationCircuit>) {
  const constant = value.plan.producers.find(({ kind }) => kind === 'constant');
  if (constant?.kind !== 'constant') throw new Error('Expected a Constant producer.');
  if (constant.configuration === undefined) throw new Error('Expected a Constant configuration.');
  return constant.configuration;
}

describe('source recipe ingredient references in Constant filters', () => {
  test('binds slots from the regenerated bundled Factorio-order provider', async () => {
    const { prototypes } = await loadPrototypeDatabase(builtinPrototypeDatabase);
    const compileSlots = (slots: readonly number[]) => {
      const filters = slots
        .map(
          (index) =>
            `{ signal: part.ingredient(${index}).signal, value: part.ingredient(${index}).amount }`,
        )
        .join(',\n');
      const compilation = compileSourceProgram(
        {
          path: 'recipe-ingredient-bundled-order.factorio.ts',
          text: `const part = Param.signal('Recipe');
const output = new Network();
output += Constant({ sections: [{ filters: [${filters}] }] });`,
        },
        sourceHost(prototypes),
      );
      expect(compilation.pipelineDiagnostics).toEqual([]);
      const declaration = listSourceCompilationParameters(compilation).find(
        ({ label }) => label === 'Recipe',
      );
      if (declaration === undefined) throw new Error('Missing Recipe parameter.');
      return (recipeName: string) =>
        configurationOf(
          bindSourceCompilationCircuit(compilation, [
            { parameter: declaration.parameter, value: signal('item', recipeName) },
          ]),
        ).sections[0]!.filters;
    };

    expect(compileSlots([0, 1, 2])('concrete')).toEqual([
      { signal: signal('item', 'iron-ore'), value: 1 },
      { signal: signal('item', 'stone-brick'), value: 5 },
      { signal: signal('fluid', 'water'), value: 100 },
    ]);
    expect(compileSlots([0, 1])('plastic-bar')).toEqual([
      { signal: signal('item', 'coal'), value: 1 },
      { signal: signal('fluid', 'petroleum-gas'), value: 20 },
    ]);
  });

  test('accepts a bound count parameter when its ingredient filter is absent', async () => {
    const { prototypes } = await recipeProvider();
    const compilation = compileSourceProgram(
      {
        path: 'recipe-ingredient-omitted-count.factorio.ts',
        text: `const recipe = Param.signal('Recipe');
const count = Param.number('Count', 7);
const output = new Network();
output += Constant({ sections: [{ filters: [
  { signal: recipe.ingredient(1).signal, value: count }
] }] });`,
      },
      sourceHost(prototypes),
    );
    expect(compilation.pipelineDiagnostics).toEqual([]);
    const parameters = listSourceCompilationParameters(compilation);
    const recipe = parameters.find(({ label }) => label === 'Recipe')!.parameter;
    const count = parameters.find(({ label }) => label === 'Count')!.parameter;
    const absent = bindSourceCompilationCircuit(compilation, [
      { parameter: recipe, value: signal('item', 'iron-gear-wheel') },
      { parameter: count, value: 9 },
    ]);
    expect(configurationOf(absent).sections[0]!.filters).toEqual([]);
    const present = bindSourceCompilationCircuit(compilation, [
      { parameter: recipe, value: signal('item', 'modded-gear-wheel') },
      { parameter: count, value: 9 },
    ]);
    expect(configurationOf(present).sections[0]!.filters).toEqual([
      { signal: signal('item', 'iron-plate'), value: 9 },
    ]);
  });

  test('executes the documented source example and local binding', async () => {
    const page = readFileSync(new URL('../../../docs/api/parameters.md', import.meta.url), 'utf8');
    const source = page.match(
      /^## Recipe ingredient references in Constant filters\r?\n[\s\S]*?```typescript\r?\n([\s\S]*?)```/m,
    )?.[1];
    if (source === undefined) throw new Error('Missing recipe ingredient source example.');

    const { prototypes } = await recipeProvider();
    const compilation = compileSourceProgram(
      { path: 'documented-recipe-ingredient.factorio.ts', text: source },
      sourceHost(prototypes),
    );
    expect(compilation.pipelineDiagnostics).toEqual([]);
    const defaults = bindSourceCompilationCircuit(compilation);
    expect(configurationOf(defaults).sections[0]!.filters).toEqual([
      { signal: signal('item', 'iron-plate'), value: 2 },
      { signal: signal('virtual', 'signal-A'), value: 5 },
    ]);

    const recipe = listSourceCompilationParameters(compilation).find(
      ({ label }) => label === 'Recipe',
    );
    if (recipe === undefined) throw new Error('Missing documented Recipe parameter.');
    const bound = bindSourceCompilationCircuit(compilation, [
      { parameter: recipe.parameter, value: signal('item', 'modded-gear-wheel') },
    ]);
    expect(configurationOf(bound).sections[0]!.filters).toEqual([
      { signal: signal('item', 'copper-plate'), value: 3 },
      { signal: signal('virtual', 'signal-A'), value: 5 },
      { signal: signal('item', 'iron-plate'), value: 4 },
    ]);
  });

  test('re-resolves the exact recipe per binding, omits absent rows and preserves topology', async () => {
    const { prototypes } = await recipeProvider();
    const host = sourceHost(prototypes);
    const text = `const part = Param.signal('Recipe', Signal('item', 'iron-gear-wheel'));
const output = new Network();
output += Constant({ sections: [{ filters: [
  { signal: part.ingredient(1).signal, value: part.ingredient(1).amount },
  { signal: part.ingredient(0).signal, value: 5 },
  { signal: Signal('virtual', 'signal-A'), value: part.ingredient(0).amount }
] }] });`;
    let executions = 0;
    const compilation = compileSourceProgram(
      { path: 'recipe-ingredient-source.factorio.ts', text },
      host,
      [],
      (stage) => {
        if (stage === 'execute') executions += 1;
      },
    );
    expect(compilation.pipelineDiagnostics).toEqual([]);
    expect(executions).toBe(1);
    expect(listSourceCompilationParameters(compilation)).toMatchObject([
      { label: 'Recipe', kind: 'signal' },
    ]);

    const originalArtifact = structuredClone(sourceCompilationArtifact(compilation));
    const defaults = bindSourceCompilationCircuit(compilation);
    expect(configurationOf(defaults).sections[0]!.filters).toEqual([
      { signal: signal('item', 'iron-plate'), value: 5 },
      { signal: signal('virtual', 'signal-A'), value: 2 },
    ]);
    const declarations = listSourceCompilationParameters(compilation);
    const recipe = declarations[0]!.parameter;
    const present = bindSourceCompilationCircuit(compilation, [
      { parameter: recipe, value: signal('item', 'modded-gear-wheel') },
    ]);
    expect(configurationOf(present).sections[0]!.filters).toEqual([
      { signal: signal('item', 'iron-plate'), value: 4 },
      { signal: signal('item', 'copper-plate'), value: 5 },
      { signal: signal('virtual', 'signal-A'), value: 3 },
    ]);
    const direct = bindSourceCompilationParameters(compilation, [
      { parameter: recipe, value: signal('item', 'modded-gear-wheel') },
    ]);
    expect(direct.producers.find(({ kind }) => kind === 'constant')?.config).toMatchObject({
      configuration: { sections: [{ filters: configurationOf(present).sections[0]!.filters }] },
    });
    expect(present.plan.networks).toEqual(defaults.plan.networks);
    expect(
      present.plan.producers.map(({ kind, debugCaptureIds }) => ({ kind, debugCaptureIds })),
    ).toEqual(
      defaults.plan.producers.map(({ kind, debugCaptureIds }) => ({ kind, debugCaptureIds })),
    );
    expect(present.resolvedCircuit.ir.producers.map(({ id }) => id)).toEqual(
      defaults.resolvedCircuit.ir.producers.map(({ id }) => id),
    );
    expect(bindSourceCompilationCircuit(compilation).plan).toEqual(defaults.plan);
    expect(
      bindSourceCompilationCircuit(compilation, [
        { parameter: recipe, value: signal('item', 'iron-gear-wheel') },
      ]).plan,
    ).toEqual(defaults.plan);
    expect(sourceCompilationArtifact(compilation)).toEqual(originalArtifact);
    expect(executions).toBe(1);
  });

  test('keeps a default-free root required once and hides all private ingredient placeholders', async () => {
    const { prototypes } = await recipeProvider();
    const host = sourceHost(prototypes);
    const text = `const part = Param.signal('Recipe');
const output = new Network();
output += Constant({ sections: [{ filters: [{
  signal: part.ingredient(0).signal,
  value: part.ingredient(0).amount
}] }] });`;
    const compilation = compileSourceProgram(
      { path: 'recipe-ingredient-required.factorio.ts', text },
      host,
    );
    expect(compilation.pipelineDiagnostics).toEqual([]);
    expect(compilation.requiredParameterIds).toEqual([0]);
    const artifact = sourceCompilationArtifact(compilation);
    expect(artifact).not.toHaveProperty('plan');
    expect(artifact).not.toHaveProperty('resolvedCircuit');
    expect(JSON.stringify(artifact)).not.toMatch(/parameter-ingredient|ingredient-template-/);
    const [declaration] = listSourceCompilationParameters(compilation);
    expect(declaration).toMatchObject({ label: 'Recipe', kind: 'signal' });
    expect(
      configurationOf(
        bindSourceCompilationCircuit(compilation, [
          { parameter: declaration!.parameter, value: signal('item', 'iron-gear-wheel') },
        ]),
      ).sections[0]!.filters,
    ).toEqual([{ signal: signal('item', 'iron-plate'), value: 2 }]);
    const exportReference = text.indexOf('part.ingredient(0)');
    expect(() =>
      exportSourceCompilationNativeBlueprint(compilation, {
        label: 'Recipe ingredient local binding',
        maxDeciderConditionRows: 1024,
      }),
    ).toThrowError(
      expect.objectContaining({
        code: 'CP1002',
        span: {
          fileId: compilation.fileId,
          start: exportReference,
          end: exportReference + 'part.ingredient(0)'.length,
        },
      }),
    );
  });

  test('reports an absent surviving amount, unknown recipe and fractional fluid amount at source use', async () => {
    const { prototypes } = await recipeProvider({ fractionalWater: true });
    const host = sourceHost(prototypes);
    const missingAmount = `const part = Param.signal('Recipe');
const output = new Network();
output += Constant({ sections: [{ filters: [{
  signal: Signal('item', 'iron-plate'),
  value: part.ingredient(1).amount
}] }] });`;
    const absentCompilation = compileSourceProgram(
      { path: 'recipe-ingredient-absent-amount.factorio.ts', text: missingAmount },
      host,
    );
    expect(absentCompilation.pipelineDiagnostics).toEqual([]);
    const amountParameter = listSourceCompilationParameters(absentCompilation)[0]!.parameter;
    expect(() =>
      bindSourceCompilationCircuit(absentCompilation, [
        { parameter: amountParameter, value: signal('item', 'iron-gear-wheel') },
      ]),
    ).toThrowError(
      expect.objectContaining({
        code: 'CP1002',
        span: {
          fileId: absentCompilation.fileId,
          start: missingAmount.indexOf('part.ingredient(1).amount'),
          end:
            missingAmount.indexOf('part.ingredient(1).amount') + 'part.ingredient(1).amount'.length,
        },
      }),
    );
    expect(
      configurationOf(
        bindSourceCompilationCircuit(absentCompilation, [
          { parameter: amountParameter, value: signal('item', 'modded-gear-wheel') },
        ]),
      ).sections[0]!.filters,
    ).toEqual([{ signal: signal('item', 'iron-plate'), value: 4 }]);

    const fractional = `const part = Param.signal('Recipe');
const output = new Network();
output += Constant({ sections: [{ filters: [{
  signal: Signal('virtual', 'signal-A'),
  value: part.ingredient(0).amount
}] }] });`;
    const fractionalCompilation = compileSourceProgram(
      { path: 'recipe-ingredient-fractional.factorio.ts', text: fractional },
      host,
    );
    expect(fractionalCompilation.pipelineDiagnostics).toEqual([]);
    const fractionalParameter =
      listSourceCompilationParameters(fractionalCompilation)[0]!.parameter;
    expect(() =>
      bindSourceCompilationCircuit(fractionalCompilation, [
        { parameter: fractionalParameter, value: signal('item', 'water-cycle') },
      ]),
    ).toThrowError(
      expect.objectContaining({
        code: 'CP1000',
        span: {
          fileId: fractionalCompilation.fileId,
          start: fractional.indexOf('part.ingredient(0).amount'),
          end: fractional.indexOf('part.ingredient(0).amount') + 'part.ingredient(0).amount'.length,
        },
      }),
    );

    const unknown = `const part = Param.signal('Recipe', Signal('item', 'missing-recipe'));
const output = new Network();
output += Constant({ sections: [{ filters: [{
  signal: part.ingredient(0).signal,
  value: 3
}] }] });`;
    const unknownCompilation = compileSourceProgram(
      { path: 'recipe-ingredient-unknown.factorio.ts', text: unknown },
      host,
    );
    expect(unknownCompilation.pipelineDiagnostics[0]).toMatchObject({
      code: 'CP1002',
      span: {
        fileId: unknownCompilation.fileId,
        start: unknown.indexOf('part.ingredient(0)'),
        end: unknown.indexOf('part.ingredient(0)') + 'part.ingredient(0)'.length,
      },
    });
  });
});

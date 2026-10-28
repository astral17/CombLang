import { readFileSync } from 'node:fs';
import {
  decodeBlueprintExchange,
  encodeBlueprintExchange,
  parseLosslessJson,
  stringifyLosslessJson,
} from '@comblang/blueprint';
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
import { emitNativeBlueprintJson } from '../../compiler/src/native-blueprint-emitter.js';
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
import {
  EntityProvisioningService,
  conservativeEntityProvisioningPolicy,
} from './entity-provisioning.js';

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

  test('executes the documented native ingredient Signal export example', async () => {
    const page = readFileSync(new URL('../../../docs/api/parameters.md', import.meta.url), 'utf8');
    const source = page.match(
      /^## Native ingredient Signal export\r?\n[\s\S]*?```typescript\r?\n([\s\S]*?)```/m,
    )?.[1];
    if (source === undefined) throw new Error('Missing native ingredient Signal example.');
    const { prototypes } = await recipeProvider();
    const compilation = compileSourceProgram(
      { path: 'documented-native-ingredient.factorio.ts', text: source },
      sourceHost(prototypes),
    );
    expect(compilation.pipelineDiagnostics).toEqual([]);
    const native = exportSourceCompilationNativeBlueprint(compilation, {
      label: 'Documented native ingredient export',
      maxDeciderConditionRows: 1024,
    });
    expect(native.parameters).toEqual([
      {
        type: 'id',
        id: 'parameter-0',
        name: 'Recipe',
        'quality-condition': { quality: 'normal', comparator: '=' },
      },
      {
        type: 'id',
        id: 'parameter-1',
        'ingredient-of': 'parameter-0',
        'quality-condition': { quality: 'normal', comparator: '=' },
      },
    ]);
    const behavior = native.entities[0]!.native.control_behavior as {
      sections: { sections: readonly { filters: readonly Record<string, unknown>[] }[] };
    };
    expect(behavior.sections.sections[0]!.filters).toMatchObject([
      { name: 'parameter-1', count: 2 },
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

  test('exports a default-free parent root and its derived ingredient Signal', async () => {
    const { prototypes } = await recipeProvider();
    const host = sourceHost(prototypes);
    const text = `const part = Param.signal('Recipe');
const output = new Network();
output += Constant({ sections: [{ filters: [{
  signal: part.ingredient(0).signal,
  value: 3
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
    ).toEqual([{ signal: signal('item', 'iron-plate'), value: 3 }]);
    const beforeExport = sourceCompilationArtifact(compilation);
    const native = exportSourceCompilationNativeBlueprint(compilation, {
      label: 'Recipe ingredient native export',
      maxDeciderConditionRows: 1024,
    });
    expect(native.parameters).toEqual([
      {
        type: 'id',
        id: 'parameter-0',
        name: 'Recipe',
        'quality-condition': { quality: 'normal', comparator: '=' },
      },
      {
        type: 'id',
        id: 'parameter-1',
        'ingredient-of': 'parameter-0',
        'quality-condition': { quality: 'normal', comparator: '=' },
      },
    ]);
    const behavior = native.entities[0]!.native.control_behavior as {
      sections: { sections: readonly { filters: readonly unknown[] }[] };
    };
    expect(behavior.sections.sections[0]!.filters).toEqual([
      { index: 1, name: 'parameter-1', quality: 'normal', comparator: '=', count: 3 },
    ]);
    expect(sourceCompilationArtifact(compilation)).toEqual(beforeExport);
    expect(JSON.stringify(native)).not.toMatch(/parameter-ingredient|ingredient-template-/);
  });

  test('retains sparse derived rows when a defaulted parent has no local ingredient at that index', async () => {
    const { prototypes } = await recipeProvider();
    const compilation = compileSourceProgram(
      {
        path: 'recipe-ingredient-native-sparse.factorio.ts',
        text: `const part = Param.signal('Recipe', Signal('item', 'iron-gear-wheel'));
const output = new Network();
output += Constant({ sections: [{ filters: [{
  signal: part.ingredient(2).signal,
  value: 7
}] }] });`,
      },
      sourceHost(prototypes),
    );
    expect(compilation.pipelineDiagnostics).toEqual([]);
    expect(configurationOf(bindSourceCompilationCircuit(compilation)).sections[0]!.filters).toEqual(
      [],
    );

    const native = exportSourceCompilationNativeBlueprint(compilation, {
      label: 'Sparse recipe ingredient native export',
      maxDeciderConditionRows: 1024,
    });
    expect(native.parameters).toEqual([
      {
        type: 'id',
        id: 'parameter-0',
        name: 'Recipe',
        'quality-condition': { quality: 'normal', comparator: '=' },
      },
      ...[1, 2, 3].map((id) => ({
        type: 'id' as const,
        id: `parameter-${id}`,
        'ingredient-of': 'parameter-0',
        'quality-condition': { quality: 'normal', comparator: '=' },
      })),
    ]);
    const behavior = native.entities[0]!.native.control_behavior as {
      sections: { sections: readonly { filters: readonly unknown[] }[] };
    };
    expect(behavior.sections.sections[0]!.filters).toEqual([
      { index: 1, name: 'parameter-3', quality: 'normal', comparator: '=', count: 7 },
    ]);
    const nativeJson = emitNativeBlueprintJson(native);
    const expectedDocument = parseLosslessJson(JSON.stringify(nativeJson));
    const exchange = await encodeBlueprintExchange(expectedDocument);
    const decoded = await decodeBlueprintExchange(exchange);
    expect(stringifyLosslessJson(decoded)).toBe(stringifyLosslessJson(expectedDocument));
  });

  test('deduplicates repeated derived uses while keeping independent parent chains', async () => {
    const { prototypes } = await recipeProvider();
    const compilation = compileSourceProgram(
      {
        path: 'recipe-ingredient-native-parents.factorio.ts',
        text: `const first = Param.signal('First');
const second = Param.signal('Second');
const output = new Network();
output += Constant({ sections: [{ filters: [{ signal: first.ingredient(0).signal, value: 1 }] }] });
output += Constant({ sections: [{ filters: [{ signal: first.ingredient(0).signal, value: 2 }] }] });
output += Constant({ sections: [{ filters: [{ signal: second.ingredient(0).signal, value: 3 }] }] });`,
      },
      sourceHost(prototypes),
    );
    expect(compilation.pipelineDiagnostics).toEqual([]);

    const artifactBefore = sourceCompilationArtifact(compilation);
    const native = exportSourceCompilationNativeBlueprint(compilation, {
      label: 'Multiple recipe ingredient native export',
      maxDeciderConditionRows: 1024,
    });
    expect(native.parameters).toEqual([
      {
        type: 'id',
        id: 'parameter-0',
        name: 'First',
        'quality-condition': { quality: 'normal', comparator: '=' },
      },
      {
        type: 'id',
        id: 'parameter-1',
        name: 'Second',
        'quality-condition': { quality: 'normal', comparator: '=' },
      },
      {
        type: 'id',
        id: 'parameter-2',
        'ingredient-of': 'parameter-0',
        'quality-condition': { quality: 'normal', comparator: '=' },
      },
      {
        type: 'id',
        id: 'parameter-3',
        'ingredient-of': 'parameter-1',
        'quality-condition': { quality: 'normal', comparator: '=' },
      },
    ]);
    const filters = native.entities.map((entity) => {
      const behavior = entity.native.control_behavior as {
        sections: { sections: readonly { filters: readonly unknown[] }[] };
      };
      return behavior.sections.sections[0]!.filters;
    });
    expect(filters).toEqual([
      [{ index: 1, name: 'parameter-2', quality: 'normal', comparator: '=', count: 1 }],
      [{ index: 1, name: 'parameter-2', quality: 'normal', comparator: '=', count: 2 }],
      [{ index: 1, name: 'parameter-3', quality: 'normal', comparator: '=', count: 3 }],
    ]);
    const [first, second] = listSourceCompilationParameters(compilation);
    const sameRecipeBinding = bindSourceCompilationCircuit(compilation, [
      { parameter: first!.parameter, value: signal('item', 'iron-gear-wheel') },
      { parameter: second!.parameter, value: signal('item', 'iron-gear-wheel') },
    ]);
    expect(
      sameRecipeBinding.plan.producers
        .filter(({ kind }) => kind === 'constant')
        .map((producer) =>
          producer.kind === 'constant' ? producer.configuration?.sections[0]?.filters : undefined,
        ),
    ).toEqual([
      [{ signal: signal('item', 'iron-plate'), value: 1 }],
      [{ signal: signal('item', 'iron-plate'), value: 2 }],
      [{ signal: signal('item', 'iron-plate'), value: 3 }],
    ]);
    expect(
      exportSourceCompilationNativeBlueprint(compilation, {
        label: 'Multiple recipe ingredient native export',
        maxDeciderConditionRows: 1024,
      }),
    ).toEqual(native);
    expect(sourceCompilationArtifact(compilation)).toEqual(artifactBefore);
  });

  test('keeps direct and derived slots distinct from a matching concrete Signal', async () => {
    const { prototypes } = await recipeProvider();
    const compilation = compileSourceProgram(
      {
        path: 'recipe-ingredient-native-direct-and-derived.factorio.ts',
        text: `const part = Param.signal('Recipe', Signal('item', 'iron-gear-wheel'));
const output = new Network();
output += Constant({ sections: [{ filters: [
  { signal: part, value: 1 },
  { signal: part.ingredient(0).signal, value: 2 },
  { signal: Signal('item', 'iron-gear-wheel'), value: 3 }
] }] });`,
      },
      sourceHost(prototypes),
    );
    expect(compilation.pipelineDiagnostics).toEqual([]);
    const native = exportSourceCompilationNativeBlueprint(compilation, {
      label: 'Direct and derived recipe ingredient native export',
      maxDeciderConditionRows: 1024,
    });
    expect(native.parameters).toMatchObject([
      { type: 'id', id: 'parameter-0', name: 'Recipe' },
      { type: 'id', id: 'parameter-1', 'ingredient-of': 'parameter-0' },
    ]);
    const behavior = native.entities[0]!.native.control_behavior as {
      sections: { sections: readonly { filters: readonly Record<string, unknown>[] }[] };
    };
    expect(behavior.sections.sections[0]!.filters.map(({ name }) => name)).toEqual([
      'parameter-0',
      'parameter-1',
      'iron-gear-wheel',
    ]);
  });

  test('keeps unrelated concrete Decider Signals when a recipe root is used only by an ingredient', async () => {
    const { prototypes } = await loadPrototypeDatabase(builtinPrototypeDatabase);
    const environment = new EntityProvisioningService().provision(
      prototypes,
      conservativeEntityProvisioningPolicy,
    );
    const compilation = compileSourceProgram(
      {
        path: 'ingredient-concrete-decider.factorio.ts',
        text: `const recipe = Param.signal('Recipe', Signal('item', 'iron-gear-wheel'));
const input = new Network();
const output = new Network();
output += Constant({ sections: [{ filters: [
  { signal: recipe.ingredient(0).signal, value: 2 }
] }] });
const gear = Signal('item', 'iron-gear-wheel');
output += IF(input[gear] > input[gear], [input[gear]], { fallback: input[gear] });
const arithmeticOutput = new Network();
arithmeticOutput += Arithmetic({ left: input[gear], operation: 'add', right: input[gear], output: gear });
const selected = new Network();
selected += Selector({ input, operation: 'select', index: gear });
const counted = new Network();
counted += Selector({ input, operation: 'count', output: gear });`,
      },
      {
        prototypes,
        trustedEntityReplayContext: environment.trustedEntityReplayContext,
        entityPrototypeResolver: environment.entityPrototypeResolver,
      },
    );
    expect(compilation.pipelineDiagnostics).toEqual([]);
    const native = exportSourceCompilationNativeBlueprint(compilation, {
      label: 'Ingredient with concrete Decider',
      maxDeciderConditionRows: 1024,
    });
    const decider = native.entities.find(
      ({ native: value }) => value.name === 'decider-combinator',
    );
    const behavior = decider?.native.control_behavior as {
      decider_conditions: {
        conditions: readonly {
          first_signal: { name: string };
          second_signal: { name: string };
        }[];
        outputs: readonly { signal: { name: string } }[];
        else_outputs: readonly { signal: { name: string } }[];
      };
    };
    expect(behavior.decider_conditions.conditions[0]?.first_signal.name).toBe('iron-gear-wheel');
    expect(behavior.decider_conditions.conditions[0]?.second_signal.name).toBe('iron-gear-wheel');
    expect(behavior.decider_conditions.outputs[0]?.signal.name).toBe('iron-gear-wheel');
    expect(behavior.decider_conditions.else_outputs[0]?.signal.name).toBe('iron-gear-wheel');

    const arithmetic = native.entities.find(
      ({ native: value }) => value.name === 'arithmetic-combinator',
    );
    const arithmeticBehavior = arithmetic?.native.control_behavior as {
      arithmetic_conditions: {
        first_signal: { name: string };
        second_signal: { name: string };
        output_signal: { name: string };
      };
    };
    expect(arithmeticBehavior.arithmetic_conditions).toMatchObject({
      first_signal: { name: 'iron-gear-wheel' },
      second_signal: { name: 'iron-gear-wheel' },
      output_signal: { name: 'iron-gear-wheel' },
    });

    const selectors = native.entities.filter(
      ({ native: value }) => value.name === 'selector-combinator',
    );
    expect(selectors.map(({ native: value }) => value.control_behavior)).toMatchObject([
      { index_signal: { name: 'iron-gear-wheel' } },
      { count_signal: { name: 'iron-gear-wheel' } },
    ]);
  });

  test('rebinds mixed direct and derived slots by parameter identity', async () => {
    const { prototypes } = await loadPrototypeDatabase(builtinPrototypeDatabase);
    const provisioned = new EntityProvisioningService().provision(
      prototypes,
      conservativeEntityProvisioningPolicy,
    );
    const compilation = compileSourceProgram(
      {
        path: 'ingredient-mixed-direct-identities.factorio.ts',
        text: `const first = Param.signal('First recipe', Signal('item', 'iron-gear-wheel'));
const second = Param.signal('Second recipe', Signal('item', 'iron-plate'));
const input = new Network();
const constants = new Network();
constants += Constant({ sections: [{ filters: [
  { signal: first.ingredient(0).signal, value: 2 },
  { signal: second.ingredient(0).signal, value: 3 },
  { signal: Signal('item', 'iron-gear-wheel'), value: 4 }
] }] });
const arithmeticOutput = new Network();
arithmeticOutput += Arithmetic({ left: 1, operation: 'add', right: 2, output: first });
const selected = new Network();
selected += Selector({ input, operation: 'select', index: second });
const counted = new Network();
counted += Selector({ input, operation: 'count', output: first });`,
      },
      {
        prototypes,
        trustedEntityReplayContext: provisioned.trustedEntityReplayContext,
        entityPrototypeResolver: provisioned.entityPrototypeResolver,
      },
    );
    expect(compilation.pipelineDiagnostics).toEqual([]);

    const native = exportSourceCompilationNativeBlueprint(compilation, {
      label: 'Mixed direct and derived ingredient Signal export',
      maxDeciderConditionRows: 1024,
    });
    expect(native.parameters).toMatchObject([
      { type: 'id', id: 'parameter-0', name: 'First recipe' },
      { type: 'id', id: 'parameter-1', name: 'Second recipe' },
      { type: 'id', id: 'parameter-2', 'ingredient-of': 'parameter-0' },
      { type: 'id', id: 'parameter-3', 'ingredient-of': 'parameter-1' },
    ]);
    const constant = native.entities.find(
      ({ native: value }) => value.name === 'constant-combinator',
    );
    const constantBehavior = constant?.native.control_behavior as {
      sections: { sections: readonly { filters: readonly { name: string }[] }[] };
    };
    expect(constantBehavior.sections.sections[0]?.filters.map(({ name }) => name)).toEqual([
      'parameter-2',
      'parameter-3',
      'iron-gear-wheel',
    ]);
    const arithmetic = native.entities.find(
      ({ native: value }) => value.name === 'arithmetic-combinator',
    );
    const arithmeticBehavior = arithmetic?.native.control_behavior as {
      arithmetic_conditions: { output_signal: { name: string } };
    };
    expect(arithmeticBehavior.arithmetic_conditions.output_signal.name).toBe('parameter-0');
    const selectors = native.entities.filter(
      ({ native: value }) => value.name === 'selector-combinator',
    );
    expect(selectors.map(({ native: value }) => value.control_behavior)).toMatchObject([
      { index_signal: { name: 'parameter-1' } },
      { count_signal: { name: 'parameter-0' } },
    ]);
  });

  test('uses only the remaining reserved placeholder pool and bounds sparse and huge indices', async () => {
    const { prototypes } = await recipeProvider();
    const provisionedHost = sourceHost(prototypes);
    const structuralHost = {
      trustedEntityReplayContext: provisionedHost.trustedEntityReplayContext,
      entityPrototypeResolver: provisionedHost.entityPrototypeResolver,
    };
    const fillers = Array.from({ length: 6 }, (_, index) => {
      const name = `parameter-${index + 4}`;
      return `{ signal: Signal('item', '${name}'), value: ${index + 1} }`;
    }).join(',\n');
    const exactBudgetSource = `const part = Param.signal('Recipe');
const output = new Network();
output += Constant({ sections: [{ filters: [
  { signal: part.ingredient(2).signal, value: 5 },
  ${fillers}
] }] });`;
    const exactBudget = compileSourceProgram(
      { path: 'recipe-ingredient-native-budget.factorio.ts', text: exactBudgetSource },
      structuralHost,
    );
    expect(exactBudget.pipelineDiagnostics).toEqual([]);
    const full = exportSourceCompilationNativeBlueprint(exactBudget, {
      label: 'Bounded recipe ingredient native export',
      maxDeciderConditionRows: 1024,
    });
    expect(full.parameters?.map((parameter) => parameter.type === 'id' && parameter.id)).toEqual([
      'parameter-0',
      'parameter-1',
      'parameter-2',
      'parameter-3',
    ]);
    const fullBehavior = full.entities[0]!.native.control_behavior as {
      sections: { sections: readonly { filters: readonly Record<string, unknown>[] }[] };
    };
    expect(fullBehavior.sections.sections[0]!.filters.slice(0, 1)).toMatchObject([
      { name: 'parameter-3', count: 5 },
    ]);
    expect(fullBehavior.sections.sections[0]!.filters.slice(1).map(({ name }) => name)).toEqual(
      Array.from({ length: 6 }, (_, index) => `parameter-${index + 4}`),
    );

    const overflowSource = exactBudgetSource.replace(
      '  { signal: part.ingredient(2).signal, value: 5 },',
      "  { signal: part.ingredient(2).signal, value: 5 },\n  { signal: Signal('item', 'parameter-3'), value: 0 },",
    );
    const overflow = compileSourceProgram(
      { path: 'recipe-ingredient-native-overflow.factorio.ts', text: overflowSource },
      structuralHost,
    );
    const overflowReference = overflowSource.indexOf('part.ingredient(2)');
    expect(() =>
      exportSourceCompilationNativeBlueprint(overflow, {
        label: 'Overflow recipe ingredient native export',
        maxDeciderConditionRows: 1024,
      }),
    ).toThrowError(
      expect.objectContaining({
        code: 'CP1002',
        span: {
          fileId: overflow.fileId,
          start: overflowReference,
          end: overflowReference + 'part.ingredient(2).signal'.length,
        },
      }),
    );

    const fullPool = compileSourceProgram(
      {
        path: 'recipe-ingredient-native-full-pool.factorio.ts',
        text: `const part = Param.signal('Recipe');
const output = new Network();
output += Constant({ sections: [{ filters: [{ signal: part.ingredient(8).signal, value: 9 }] }] });`,
      },
      structuralHost,
    );
    expect(
      exportSourceCompilationNativeBlueprint(fullPool, {
        label: 'Full recipe ingredient native pool',
        maxDeciderConditionRows: 1024,
      }).parameters,
    ).toHaveLength(10);

    const hugeSource = `const part = Param.signal('Recipe');
const output = new Network();
output += Constant({ sections: [{ filters: [{ signal: part.ingredient(9007199254740991).signal, value: 1 }] }] });`;
    const huge = compileSourceProgram(
      { path: 'recipe-ingredient-native-huge-index.factorio.ts', text: hugeSource },
      structuralHost,
    );
    const artifactBefore = sourceCompilationArtifact(huge);
    const hugeReference = hugeSource.indexOf('part.ingredient(9007199254740991)');
    expect(() =>
      exportSourceCompilationNativeBlueprint(huge, {
        label: 'Huge recipe ingredient native index',
        maxDeciderConditionRows: 1024,
      }),
    ).toThrowError(
      expect.objectContaining({
        code: 'CP1002',
        span: {
          fileId: huge.fileId,
          start: hugeReference,
          end: hugeReference + 'part.ingredient(9007199254740991).signal'.length,
        },
      }),
    );
    expect(sourceCompilationArtifact(huge)).toEqual(artifactBefore);
  });

  test('rejects an ingredient Signal outside an exact Constant filter Signal slot', () => {
    const text = `const recipe = Param.signal('Recipe');
const input = new Network();
const output = new Network();
output += Selector({ input, operation: 'count', output: recipe.ingredient(0).signal });`;
    const compilation = compileSourceProgram({
      path: 'recipe-ingredient-native-unsupported-role.factorio.ts',
      text,
    });
    expect(compilation.pipelineDiagnostics[0]).toMatchObject({
      code: 'RT2027',
      span: {
        fileId: compilation.fileId,
        start: text.indexOf('recipe.ingredient(0).signal'),
        end: text.indexOf('recipe.ingredient(0).signal') + 'recipe.ingredient(0).signal'.length,
      },
    });
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
    expect(() =>
      exportSourceCompilationNativeBlueprint(absentCompilation, {
        label: 'Unsupported ingredient amount native export',
        maxDeciderConditionRows: 1024,
      }),
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

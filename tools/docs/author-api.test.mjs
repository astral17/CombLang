import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import {
  createTrustedEntityReplayContext,
  generateBlueprintJson,
  syntheticSharedTwoColorEntityProfile,
} from '@comblang/compiler';
import { loadPrototypeDatabase } from '@comblang/prototypes';
import builtinDatabase from '../../packages/prototypes/generated/space-age-2.1.17.json';
import {
  conservativeEntityProvisioningPolicy,
  EntityProvisioningService,
} from '../../packages/runtime/src/entity-provisioning.js';
import {
  compileSourceProgram,
  exportSourceCompilationNativeBlueprint,
} from '../../packages/runtime/src/source-compilation.js';
import { createSourceParameterBindingSession } from '@comblang/runtime/source-parameter-binding';
import {
  runExecutedDirectPlanTests,
  runResolvedDirectPlanTests,
} from '../../packages/runtime/src/test-runner.js';

const pages = ['functions', 'prototypes', 'entity', 'parameters'];
const pageUrl = (name) => new URL(`../../docs/api/${name}.md`, import.meta.url);
const read = (name) => readFileSync(pageUrl(name), 'utf8');
const blocks = (name) =>
  [...read(name).matchAll(/```ts\r?\n([\s\S]*?)```/g)].map((match) => match[1]);
const bundled = loadPrototypeDatabase(builtinDatabase).then(({ prototypes }) => {
  const provisioned = new EntityProvisioningService().provision(
    prototypes,
    conservativeEntityProvisioningPolicy,
  );
  return {
    prototypes,
    trustedEntityReplayContext: provisioned.trustedEntityReplayContext,
    entityPrototypeResolver: provisioned.entityPrototypeResolver,
  };
});
const profile = syntheticSharedTwoColorEntityProfile;
const syntheticHost = {
  trustedEntityReplayContext: createTrustedEntityReplayContext({
    database: profile.ref.database,
    source: 'synthetic',
    profiles: [profile],
    evidenceIdentity: 'docs-author-synthetic-evidence',
    policyIdentity: 'docs-author-synthetic-policy',
  }),
  entityPrototypeResolver: {
    database: profile.ref.database,
    getEntity: (name) =>
      ['synthetic-shared-two-color', profile.ref.prototypeKey].includes(name)
        ? {
            key: profile.ref.prototypeKey,
            name: 'synthetic-shared-two-color',
            type: 'container',
            tileWidth: 1,
            tileHeight: 1,
          }
        : undefined,
  },
};
const result = (text, environment = {}) =>
  compileSourceProgram({ path: 'author-api.factorio.ts', text }, environment);
function compile(text, environment = {}, warnings = []) {
  const compilation = result(text, environment);
  expect(compilation.pipelineDiagnostics.map(({ code, severity }) => ({ code, severity }))).toEqual(
    warnings.map((code) => ({ code, severity: 'warning' })),
  );
  expect(compilation.resolvedCircuit).toBeDefined();
  expect(compilation.execution).toBeDefined();
  return compilation;
}
function run(compilation, body) {
  expect(
    runExecutedDirectPlanTests(
      compilation.execution,
      `test('documented result', ({ network, tick, expectSignal }) => { ${body} });`,
    ),
  ).toMatchObject({ passed: 1, failed: 0 });
}

describe('author API documentation', () => {
  test.each(pages)('provides the standalone %s reference contract', (name) => {
    expect(existsSync(pageUrl(name))).toBe(true);
    const page = read(name);
    expect(page).toContain('[Documentation](../README.md)');
    expect(page).toContain('## Signatures');
    expect(page).toContain('## Restrictions');
    expect(blocks(name).length).toBeGreaterThan(0);
  });

  test.each([
    [0, 2],
    [1, 1],
    [2, 2],
    [3, 1],
  ])('compiles literal parameter example %i with %i physical devices', async (index, count) => {
    expect(blocks('parameters')).toHaveLength(4);
    const text = blocks('parameters')[index];
    expect(text).not.toMatch(/\b(import|await)\s/);
    expect(compile(text, await bundled).resolvedCircuit.ir.producers).toHaveLength(count);
  });

  test('matches the parameter example defaults and pipeline timing', async () => {
    const compilation = compile(blocks('parameters')[0], await bundled);
    run(
      compilation,
      `const B = Signal('virtual', 'signal-B');
const output = network('output');
expectSignal(output, B).toBe(0);
tick(); expectSignal(output, B).toBe(5);
tick(); expectSignal(output, B).toBe(7);`,
    );
  });

  test('matches local expression defaults, bound timing and concrete JSON', async () => {
    const compilation = compile(blocks('parameters')[2], await bundled);
    expect(compilation.resolvedCircuit.ir.producers).toHaveLength(2);
    run(
      compilation,
      `const A = Signal('virtual', 'signal-A');
const output = network('output');
expectSignal(output, A).toBe(0);
tick(); expectSignal(output, A).toBe(12);
tick(); expectSignal(output, A).toBe(15);`,
    );
    const session = createSourceParameterBindingSession(compilation);
    expect(session.parameters).toMatchObject([
      { id: 0, kind: 'number', label: 'Amount', defaultValue: 5 },
    ]);
    const original = generateBlueprintJson(compilation.resolvedCircuit.ir);
    const bound = session.bind([{ id: 0, value: 9 }]);
    expect(
      runResolvedDirectPlanTests(
        bound.plan,
        bound.resolvedCircuit,
        `test('bound local expression', ({ network, tick, expectSignal }) => {
  const A = Signal('virtual', 'signal-A');
  const output = network('output');
  expectSignal(output, A).toBe(0);
  tick(); expectSignal(output, A).toBe(20);
  tick(); expectSignal(output, A).toBe(23);
});`,
      ),
    ).toMatchObject({ passed: 1, failed: 0 });
    const chosen = generateBlueprintJson(bound.resolvedCircuit.ir);
    expect(chosen.blueprint.entities).toHaveLength(2);
    expect(chosen.blueprint.wires).toEqual(original.blueprint.wires);
    expect(
      chosen.blueprint.entities.find(({ name }) => name === 'arithmetic-combinator')
        .control_behavior.arithmetic_conditions,
    ).toMatchObject({ second_constant: 20 });
    expect(generateBlueprintJson(session.bind([]).resolvedCircuit.ir)).toEqual(original);
  });

  test('executes, binds and exports the direct Constant expression example', async () => {
    const compilation = compile(blocks('parameters')[3], await bundled);
    run(
      compilation,
      `tick();
expectSignal(network('output'), Signal('virtual', 'signal-A')).toBe(12);
tick(); expectSignal(network('output'), Signal('virtual', 'signal-A')).toBe(12);`,
    );
    const session = createSourceParameterBindingSession(compilation);
    expect(session.parameters).toMatchObject([
      { id: 0, kind: 'number', label: 'Amount', defaultValue: 5 },
      { id: 1, kind: 'number', label: 'Factor', defaultValue: 2 },
      { id: 2, kind: 'number', label: 'Scale', defaultValue: 2 },
    ]);
    const original = generateBlueprintJson(compilation.resolvedCircuit.ir);
    const bound = session.bind([
      { id: 0, value: 9 },
      { id: 1, value: 3 },
      { id: 2, value: 3 },
    ]);
    expect(bound.resolvedCircuit.ir.entities).toHaveLength(1);
    expect(generateBlueprintJson(bound.resolvedCircuit.ir).blueprint.entities[0]).toMatchObject({
      control_behavior: {
        sections: { sections: [{ multiplier: 1.5, filters: [{ count: 30 }] }] },
      },
    });
    expect(generateBlueprintJson(session.bind([]).resolvedCircuit.ir)).toEqual(original);
    expect(() =>
      exportSourceCompilationNativeBlueprint(compilation, {
        label: 'Derived Constant parameters',
        maxDeciderConditionRows: 1024,
      }),
    ).toThrow(expect.objectContaining({ code: 'CP1002' }));
  });

  test('binds the literal documented ID values and resets against original defaults', async () => {
    const compilation = compile(blocks('parameters')[0], await bundled);
    const session = createSourceParameterBindingSession(compilation);
    expect(session.parameters).toMatchObject([
      { id: 0, kind: 'number', label: 'Amount', defaultValue: 5 },
      { id: 1, kind: 'signal', label: 'Result', defaultValue: { name: 'signal-B' } },
    ]);
    const jsonBlocks = [...read('parameters').matchAll(/```json\r?\n([\s\S]*?)```/g)];
    expect(jsonBlocks).toHaveLength(1);
    const original = generateBlueprintJson(compilation.resolvedCircuit.ir);
    const bound = session.bind(JSON.parse(jsonBlocks[0][1]));
    expect(
      runResolvedDirectPlanTests(
        bound.plan,
        bound.resolvedCircuit,
        `test('chosen result', ({ network, tick, expectSignal }) => {
  const C = Signal('virtual', 'signal-C', 'rare');
  const output = network('output');
  expectSignal(output, C).toBe(0);
  tick(); expectSignal(output, C).toBe(11);
  tick(); expectSignal(output, C).toBe(13);
});`,
      ),
    ).toMatchObject({ passed: 1, failed: 0 });
    const chosen = generateBlueprintJson(bound.resolvedCircuit.ir);
    expect(chosen.blueprint.entities).toHaveLength(2);
    expect(chosen.blueprint).not.toHaveProperty('parameters');
    expect(chosen.blueprint.wires).toEqual(original.blueprint.wires);
    expect(
      chosen.blueprint.entities.find(({ name }) => name === 'arithmetic-combinator')
        .control_behavior.arithmetic_conditions,
    ).toMatchObject({
      second_constant: 11,
      output_signal: { type: 'virtual', name: 'signal-C', quality: 'rare' },
    });
    const reset = session.bind([]);
    expect(generateBlueprintJson(reset.resolvedCircuit.ir)).toEqual(original);
    expect(generateBlueprintJson(compilation.resolvedCircuit.ir)).toEqual(original);
  });

  test('keeps literal formula metadata opaque while defaults drive the documented counts', async () => {
    const compilation = compile(blocks('parameters')[1], await bundled);
    run(
      compilation,
      `tick();
expectSignal(network('output'), Signal('virtual', 'signal-A')).toBe(5);
expectSignal(network('output'), Signal('virtual', 'signal-B')).toBe(111);`,
    );
    expect(createSourceParameterBindingSession(compilation).parameters).toMatchObject([
      { defaultValue: 5, metadata: { variable: 'x' } },
      { defaultValue: 111, metadata: { formula: 'x * 2', dependent: true } },
    ]);
    const native = exportSourceCompilationNativeBlueprint(compilation, {
      label: 'Documented metadata',
      maxDeciderConditionRows: 1024,
    });
    expect(native.parameters).toMatchObject([
      { type: 'number', number: '5', variable: 'x' },
      { type: 'number', number: '111', formula: 'x * 2', dependent: true },
    ]);
    expect(generateBlueprintJson(compilation.resolvedCircuit.ir).blueprint).not.toHaveProperty(
      'parameters',
    );
  });

  test.each(['amount / 1;', '5 * result;', 'input + amount;', 'amount.defaultValue;'])(
    'does not give opaque source parameters unsupported ordinary-value APIs: %s',
    async (suffix) => {
      const compilation = result(`${blocks('parameters')[0]}\n${suffix}`, await bundled);
      expect(compilation.pipelineDiagnostics).toEqual([
        expect.objectContaining({ severity: 'error', span: expect.any(Object) }),
      ]);
      expect(compilation.resolvedCircuit).toBeUndefined();
    },
  );

  test.each([
    [0, 2],
    [1, 0],
    [2, 2],
    [3, 1],
    [4, 0],
    [5, 2],
  ])('compiles literal function example %i with %i physical producers', (index, count) => {
    expect(blocks('functions')).toHaveLength(6);
    const source = blocks('functions')[index];
    expect(source).not.toMatch(/\b(import|await)\s/);
    expect(
      compile(source, {}, index === 0 || index === 4 ? ['CL2002'] : []).resolvedCircuit.ir
        .producers,
    ).toHaveLength(count);
  });
  test.each([
    [0, 10],
    [2, 6],
    [5, 10],
  ])('pins function example %i timing', (index, value) => {
    run(
      compile(blocks('functions')[index], {}, index === 0 ? ['CL2002'] : []),
      `const A = Signal('virtual', 'signal-A'); tick(1); expectSignal(network('output'), A).toBe(0); tick(1); expectSignal(network('output'), A).toBe(${value});`,
    );
  });
  test.each([1, 4])('keeps reference identity in alias example %i', (index) => {
    const compilation = compile(blocks('functions')[index], {}, index === 4 ? ['CL2002'] : []);
    expect(compilation.plan.networks).toHaveLength(1);
    expect(compilation.plan.networkTransfers).toEqual([]);
    expect(compilation.execution.network('input').id).toBe(
      compilation.execution.network('output').id,
    );
  });
  test('preserves the untyped physical return and its placement', () => {
    const compilation = compile(blocks('functions')[0], {}, ['CL2002']);
    expect(compilation.plan.producers.find(({ kind }) => kind === 'arithmetic').placement).toEqual({
      x: 4,
      y: 2,
    });
    expect(
      generateBlueprintJson(compilation.resolvedCircuit.ir).blueprint.entities.filter(
        ({ name }) => name === 'arithmetic-combinator',
      ),
    ).toHaveLength(1);
  });
  test('preserves any and explicitly physical returns but narrows a typed Network return', () => {
    const source = blocks('functions')[0];
    const any = compile(source.replace('input, factor)', 'input: any, factor)'), {}, ['CL2002']);
    expect(any.resolvedCircuit.ir.producers).toHaveLength(2);
    const physicalSource = source
      .replace(/if \(Scale\(4, 2\).*\r?\n/, '')
      .replace('Scale(input, factor)', 'Scale(input, factor): ArithmeticCombinator');
    expect(compile(physicalSource, {}, ['CL2002']).resolvedCircuit.ir.producers).toHaveLength(2);
    const narrowed = result(physicalSource.replace(': ArithmeticCombinator', ': Network'));
    expect(narrowed.pipelineDiagnostics).toEqual([
      expect.objectContaining({
        code: 'EX1001',
        severity: 'error',
        message: expect.stringContaining('combinator'),
      }),
    ]);
    expect(narrowed.resolvedCircuit).toBeUndefined();
  });
  test('uses Ref for owner attachment while the returned alias remains readonly', () => {
    const compilation = compile(`${blocks('functions')[1]}
function Attach(destination: Ref<Network>): void { destination += CC(); }
Attach(input);`);
    expect(compilation.resolvedCircuit.ir.producers).toHaveLength(1);
    expect(compilation.execution.network('output').id).toBe(
      compilation.execution.network('input').id,
    );
  });
  test('returns the moved owner, invalidates old aliases and adds no hardware or delay', () => {
    const source = blocks('functions')[3];
    const compilation = compile(source);
    run(
      compilation,
      `const A = Signal('virtual', 'signal-A'); tick(1); expectSignal(network('advanced'), A).toBe(5);`,
    );
    expect(compilation.execution.debug.root.network('oldAlias')).toMatchObject({
      moved: true,
      planName: 'input',
    });
    expect(result(`${source}\nconst stale = oldAlias + 0;`).pipelineDiagnostics).toEqual([
      expect.objectContaining({ code: 'RT2012' }),
    ]);
  });
  test.each([
    [1, 'output += CC();', 'CL1038'],
    [1, 'input.take(output);', 'CL1039'],
    [
      2,
      'const values = [output]; function Write(value: Ref<Network>): void {} Write(values[0]);',
      'RT2015',
    ],
    [5, 'Double({});', 'RT2015'],
  ])('keeps capability failures in function example %i: %s', (index, suffix, code) => {
    expect(result(`${blocks('functions')[index]}\n${suffix}`).pipelineDiagnostics).toEqual([
      expect.objectContaining({ code, severity: 'error' }),
    ]);
  });
  test.each([
    ['Readonly<Network>', 'Network'],
    ['Ref<Network>', 'Readonly<Network>'],
  ])('does not grant %s -> %s borrow escapes', (parameter, output) => {
    const source = blocks('functions')[1]
      .replace('input: Readonly<Network>', `input: ${parameter}`)
      .replace('): Readonly<Network>', `): ${output}`);
    expect(result(source).pipelineDiagnostics).toEqual([
      expect.objectContaining({ code: 'CL1040' }),
    ]);
  });

  test('compiles the literal prototype stack example against one bundled provider', async () => {
    expect(blocks('prototypes')).toHaveLength(1);
    const environment = await bundled;
    const compilation = compile(blocks('prototypes')[0], environment);
    expect(compilation.resolvedCircuit.ir.producers).toHaveLength(1);
    expect(environment.prototypes.stackSize('iron-plate')).toBe(100);
    run(
      compilation,
      `const PLATE = Signal('item', 'iron-plate'); tick(1); expectSignal(network('output'), PLATE).toBe(100);`,
    );
  });
  test('reports EX1004 when a literal prototype program has no provider', () => {
    expect(result(blocks('prototypes')[0]).pipelineDiagnostics).toEqual([
      expect.objectContaining({ code: 'EX1004' }),
    ]);
  });
  test('uses singular name tables, immutable records, canonical collections and actual query limits', async () => {
    const { prototypes: provider } = await bundled;
    const plate = provider.item['iron-plate'];
    expect(provider.getItem('item:iron-plate')).toBe(plate);
    expect(provider.item['item:iron-plate']).toBeUndefined();
    expect(provider.getItem('not-an-item')).toBeUndefined();
    expect(provider.collections.all['item:iron-plate']).toBe(plate);
    for (const value of [provider, provider.item, plate]) expect(Object.isFrozen(value)).toBe(true);
    expect(provider.recipesProducing('item:iron-gear-wheel')).toEqual(
      provider.collections.recipesByProduct['item:iron-gear-wheel'],
    );
    expect(provider.recipesProducing('item:not-a-product')).toEqual([]);
    expect(provider.isBasicCraftingCompatible('assembling-machine-3', 'iron-gear-wheel')).toBe(
      true,
    );
    expect(() => provider.stackSize('not-an-item')).toThrow('Unknown item prototype');
    expect(() => provider.isBasicCraftingCompatible('lab', 'iron-gear-wheel')).toThrow(
      'crafting data',
    );
    const lab = provider.entity.lab;
    if (lab.circuit === undefined)
      expect(() => provider.entityCircuitCapabilities('lab')).toThrow('entityCircuitCapabilities');
    else expect(provider.entityCircuitCapabilities('entity:lab')).toBe(lab.circuit);
  });

  test.each([0, 1, 2])(
    'compiles literal Entity example %i without pretending it is a simulator device',
    async (index) => {
      expect(blocks('entity')).toHaveLength(3);
      const compilation = compile(
        blocks('entity')[index],
        index === 2 ? syntheticHost : await bundled,
      );
      expect(compilation.plan.entities).toHaveLength(1);
      expect(compilation.plan.producers).toEqual([]);
      expect(compilation.resolvedCircuit.ir.producers).toEqual([]);
    },
  );
  test('exports checked Lab SignalID, placement and raw explicit false', async () => {
    const environment = await bundled;
    const checked = compile(blocks('entity')[0], environment);
    const entity = generateBlueprintJson(checked.resolvedCircuit.ir).blueprint.entities[0];
    expect(entity).toMatchObject({
      name: 'lab',
      position: { x: 10, y: -2 },
      direction: 8,
      control_behavior: {
        read_contents: true,
        technology_level_signal: { type: 'virtual', name: 'signal-A' },
      },
    });
    expect(checked.plan.entities[0].connectorBindings).toEqual([]);
    const fallback = environment.trustedEntityReplayContext.profiles.find(
      ({ ref }) => ref.prototypeKey === 'entity:lab',
    );
    expect(fallback).toMatchObject({
      connectors: [],
      features: [],
      defaultReadProjection: null,
      connectorStructure: 'unknown',
    });
    expect(fallback).not.toHaveProperty('callProjection');
    const raw = compile(blocks('entity')[1], environment);
    expect(generateBlueprintJson(raw.resolvedCircuit.ir).blueprint.entities[0]).toMatchObject({
      name: 'lab',
      position: { x: 2, y: 3 },
      control_behavior: { read_contents: false },
    });
  });
  test('requires exact provider record identity, not a same-shape copied prototype', async () => {
    const compilation = result(
      blocks('entity')[0].replace('Entity(prototype,', 'Entity({ ...prototype },'),
      await bundled,
    );
    expect(compilation.pipelineDiagnostics).toEqual([expect.objectContaining({ code: 'RT2027' })]);
    expect(compilation.resolvedCircuit).toBeUndefined();
  });
  test.each([
    [0, 'lab(new Network());', 'RT2027'],
    [0, "lab.port('shared', 'shared-red');", 'RT2031'],
    [0, 'const read = lab + 0;', 'RT2032'],
    [1, "Entity('lab', { raw: { name: 'another-entity' } });", 'RT2027'],
    [1, "Entity('lab', { control_behavior: { read_contents: 'yes' } });", 'RT2027'],
  ])(
    'does not infer capabilities or semantic escape for Entity example %i: %s',
    async (index, suffix, code) => {
      const compilation = result(`${blocks('entity')[index]}\n${suffix}`, await bundled);
      expect(compilation.pipelineDiagnostics).toEqual([
        expect.objectContaining({ code, severity: 'error' }),
      ]);
      expect(compilation.resolvedCircuit).toBeUndefined();
    },
  );
  test('pins the actual synthetic callable endpoints, one construction/call and legal output reuse', () => {
    const source = blocks('entity')[2];
    expect(source.match(/\bEntity\(/g)).toHaveLength(1);
    expect(source.match(/machine\(input\)/g)).toHaveLength(1);
    const compilation = compile(source, syntheticHost);
    expect(compilation.plan.networks).toHaveLength(2);
    expect(compilation.plan.entities[0]).toMatchObject({
      placement: { x: 4, y: 2 },
      connectorBindings: [
        {
          endpoint: { connector: 'shared', lane: 'shared-red', color: 'red' },
          direction: 'input',
          network: 'input',
        },
        {
          endpoint: { connector: 'shared', lane: 'shared-green', color: 'green' },
          direction: 'output',
          network: 'output',
        },
      ],
    });
    for (const alias of ['inputPort', 'observed'])
      expect(compilation.execution.network(alias).id).toBe(
        compilation.execution.network('input').id,
      );
    const session = compilation.execution.createTestSession();
    session.tick();
    expect(session.readValue(compilation.execution.network('output')).kind).toBe('unknown');
    expect(
      generateBlueprintJson(compilation.resolvedCircuit.ir).blueprint.entities[0].control_behavior
        .circuit_condition,
    ).toEqual({
      first_signal: { type: 'virtual', name: 'signal-A' },
      comparator: '>',
      constant: 0,
      first_signal_networks: { red: true, green: true },
    });
  });
  test.each([
    'machine();',
    'machine(input, output);',
    'machine(new Network());',
    'const other = new Network(); other += machine;',
  ])('keeps callable restrictions: %s', (suffix) => {
    const code = 'RT2030';
    expect(result(`${blocks('entity')[2]}\n${suffix}`, syntheticHost).pipelineDiagnostics).toEqual([
      expect.objectContaining({ code, severity: 'error' }),
    ]);
  });
  test('rejects the documented repeated call with an identical input at the second invocation', () => {
    const text = `${blocks('entity')[2]}\nmachine(input);`;
    const first = text.indexOf('machine(input)');
    const second = text.lastIndexOf('machine(input)');
    expect(result(text, syntheticHost).pipelineDiagnostics).toEqual([
      expect.objectContaining({
        code: 'RT2030',
        severity: 'error',
        span: {
          fileId: 'file:author-api.factorio.ts',
          start: second,
          end: second + 'machine(input)'.length,
        },
        related: [
          {
            message: 'The first Entity invocation originates here.',
            span: {
              fileId: 'file:author-api.factorio.ts',
              start: first,
              end: first + 'machine(input)'.length,
            },
          },
        ],
      }),
    ]);
  });
  test('validates local links, anchors and index navigation without another docs framework', () => {
    for (const name of pages) {
      expect(readFileSync(new URL('../../docs/README.md', import.meta.url), 'utf8')).toContain(
        `api/${name}.md`,
      );
      for (const [, href] of read(name).matchAll(/\]\(([^)]+)\)/g)) {
        const [path, anchor] = href.split('#');
        const target = new URL(path, pageUrl(name));
        expect(existsSync(fileURLToPath(target)), href).toBe(true);
        if (!anchor) continue;
        const headings = [...readFileSync(target, 'utf8').matchAll(/^#{1,6} (.+)$/gm)].map(
          ([, title]) =>
            title
              .trim()
              .toLowerCase()
              .replace(/[^\p{L}\p{N}_\- ]/gu, '')
              .replace(/ /g, '-'),
        );
        expect(headings, href).toContain(anchor);
      }
    }
  });
});

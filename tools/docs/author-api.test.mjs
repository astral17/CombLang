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
import { compileSourceProgram } from '../../packages/runtime/src/source-compilation.js';
import { runExecutedDirectPlanTests } from '../../packages/runtime/src/test-runner.js';

const pages = ['functions', 'prototypes', 'entity'];
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
    const code = suffix.includes('new Network') ? 'RT2030' : 'RT2027';
    expect(result(`${blocks('entity')[2]}\n${suffix}`, syntheticHost).pipelineDiagnostics).toEqual([
      expect.objectContaining({ code, severity: 'error' }),
    ]);
  });
  test('pins the documented unchecked repeated call with an identical input', () => {
    const compilation = compile(`${blocks('entity')[2]}\nmachine(input);`, syntheticHost);
    expect(compilation.plan.entities).toHaveLength(1);
    expect(compilation.plan.networks).toHaveLength(2);
    expect(compilation.plan.entities[0].connectorBindings).toHaveLength(2);
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

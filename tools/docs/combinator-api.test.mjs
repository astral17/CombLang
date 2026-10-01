import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import {
  createTrustedEntityReplayContext,
  generateBlueprintJson,
  syntheticZeroPortEntityProfile,
} from '@comblang/compiler';
import { compileSourceProgram } from '../../packages/runtime/src/source-compilation.js';
import { runExecutedDirectPlanTests } from '../../packages/runtime/src/test-runner.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const pages = ['arithmetic', 'decider', 'constant', 'selector'];
const read = (name) => readFileSync(resolve(root, 'docs', name), 'utf8');
const blocks = (name) =>
  [...read(name).matchAll(/```ts\r?\n([\s\S]*?)```/g)].map((match) => match[1]);

// Tiny synthetic canonical-family authority for documentation compilation only.
function host(
  families = [
    'constant-combinator',
    'arithmetic-combinator',
    'decider-combinator',
    'selector-combinator',
  ],
) {
  const profiles = families.map((family, index) => ({
    ...structuredClone(syntheticZeroPortEntityProfile),
    ref: {
      ...syntheticZeroPortEntityProfile.ref,
      prototypeKey: `entity:${family}`,
      profileId: `profile:docs-combinator-${index}`,
    },
    prototypeType: family,
  }));
  const trustedEntityReplayContext = createTrustedEntityReplayContext({
    database: profiles[0].ref.database,
    source: 'synthetic',
    evidenceIdentity: 'docs-combinator-evidence',
    policyIdentity: 'docs-combinator-policy',
    profiles,
  });
  const prototypes = families.map((family) => ({
    key: `entity:${family}`,
    name: family,
    type: family,
    tileWidth: 1,
    tileHeight: 1,
  }));
  return {
    trustedEntityReplayContext,
    entityPrototypeResolver: {
      database: trustedEntityReplayContext.database,
      getEntity: (name) =>
        prototypes.find((prototype) => prototype.name === name || prototype.key === name),
    },
  };
}

function compile(text, trusted = false, warnings = []) {
  const compilation = compileSourceProgram(
    { path: 'combinator-api.factorio.ts', text },
    trusted ? host() : {},
  );
  expect(compilation.pipelineDiagnostics.map(({ code, severity }) => ({ code, severity }))).toEqual(
    warnings.map((code) => ({ code, severity: 'warning' })),
  );
  expect(compilation.execution).toBeDefined();
  expect(compilation.resolvedCircuit).toBeDefined();
  return compilation;
}

function run(compilation, body) {
  const result = runExecutedDirectPlanTests(
    compilation.execution,
    `test('documented circuit', ({ network, tick, expectSignal }) => { ${body} });`,
  );
  expect(result.failed, result.results.map(({ message }) => message).join('\n')).toBe(0);
  expect(result.passed).toBe(1);
}

describe('combinator API documentation', () => {
  test.each(pages)('provides %s reference with complete source examples', (name) => {
    const page = read(`api/${name}.md`);
    expect(page).toContain('[Documentation](../README.md)');
    expect(page).toContain('## Signatures');
    expect(page).toContain('## Restrictions');
    expect(blocks(`api/${name}.md`).length).toBeGreaterThan(0);
  });

  test.each([
    ['arithmetic', [3, 2, 2], [false, true, true]],
    ['decider', [2, 2, 2, 2], [false, false, true, false]],
    ['constant', [1, 1, 1, 1, 1], [false, false, true, true, true]],
    ['selector', [4, 3], [true, true]],
  ])(
    'compiles every %s ts block as a standalone program with the stated prerequisites',
    (name, counts, trusted) => {
      const examples = blocks(`api/${name}.md`);
      expect(examples).toHaveLength(counts.length);
      for (const [index, count] of counts.entries()) {
        expect(examples[index]).not.toMatch(/\bimport\s/);
        const compilation = compile(examples[index], trusted[index]);
        expect(compilation.resolvedCircuit.ir.producers).toHaveLength(count);
      }
    },
  );

  test('pins operator-stage inference, explicit Signal binding and pipeline warmup', () => {
    const compilation = compile(blocks('api/arithmetic.md')[0]);
    run(
      compilation,
      `
      const A = Signal('virtual', 'signal-A');
      const B = Signal('virtual', 'signal-B');
      expectSignal(network('output'), B).toBe(0);
      tick(1);
      expectSignal(network('doubled'), A).toBe(0);
      expectSignal(network('output'), B).toBe(3);
      tick(1);
      expectSignal(network('doubled'), A).toBe(10);
      expectSignal(network('output'), B).toBe(3);
      tick(1);
      expectSignal(network('output'), B).toBe(13);
      expectSignal(network('output'), A).toBe(0);
    `,
    );
  });

  test.each([1, 2])('checks exact Arithmetic example %i against the model', (index) => {
    const compilation = compile(blocks('api/arithmetic.md')[index], true);
    run(
      compilation,
      `
      const A = Signal('virtual', 'signal-A');
      const B = Signal('virtual', 'signal-B');
      tick(1);
      expectSignal(network('output'), B).toBe(0);
      tick(1);
      expectSignal(network('output'), B).toBe(${index === 1 ? 10 : 4});
      expectSignal(network('output'), A).toBe(${index === 1 ? 0 : 10});
    `,
    );
  });

  test('checks compact compound condition then/else tick behavior on one Decider', () => {
    const compilation = compile(blocks('api/decider.md')[0]);
    run(
      compilation,
      `
      const A = Signal('virtual', 'signal-A');
      const C = Signal('virtual', 'signal-C');
      expectSignal(network('output'), C).toBe(0);
      tick(1);
      expectSignal(network('output'), A).toBe(0);
      expectSignal(network('output'), C).toBe(7);
      tick(1);
      expectSignal(network('output'), A).toBe(6);
      expectSignal(network('output'), C).toBe(1);
    `,
    );
    expect(compilation.plan.producers.filter(({ kind }) => kind === 'decider')).toHaveLength(1);
  });

  test('checks fluent same-handle mutation, append returns and both branches', () => {
    const compilation = compile(blocks('api/decider.md')[1]);
    const aliases = new Map(
      compilation.plan.networkAliases.map(({ name, network }) => [name, network]),
    );
    expect(aliases.get('gate')).toBeDefined();
    expect(aliases.get('alias')).toBe(aliases.get('gate'));
    expect(aliases.get('appended')).toBe(aliases.get('gate'));
    const decider = compilation.plan.producers.find(({ kind }) => kind === 'decider');
    expect(decider.outputs).toHaveLength(2);
    expect(decider.elseOutputs).toHaveLength(1);
    run(
      compilation,
      `
      const A = Signal('virtual', 'signal-A');
      const B = Signal('virtual', 'signal-B');
      tick(1);
      expectSignal(network('output'), B).toBe(9);
      tick(1);
      expectSignal(network('output'), A).toBe(6);
      expectSignal(network('output'), B).toBe(1);
    `,
    );
  });

  test('checks exact false output rows without adapter devices', () => {
    const compilation = compile(blocks('api/decider.md')[2], true);
    run(
      compilation,
      `
      const A = Signal('virtual', 'signal-A');
      const B = Signal('virtual', 'signal-B');
      const C = Signal('virtual', 'signal-C');
      tick(2);
      expectSignal(network('output'), A).toBe(0);
      expectSignal(network('output'), B).toBe(-2);
      expectSignal(network('output'), C).toBe(3);
    `,
    );
    expect(
      generateBlueprintJson(compilation.resolvedCircuit.ir).blueprint.entities[1],
    ).toMatchObject({
      control_behavior: {
        decider_conditions: {
          outputs: [{ copy_count_from_input: true }, { constant: 2 }],
          else_outputs: [{ copy_count_from_input: true }, { constant: 3 }],
        },
      },
    });
  });

  test('checks Each concrete redirection and one constant row per candidate', () => {
    run(
      compile(blocks('api/decider.md')[3]),
      `
      const A = Signal('virtual', 'signal-A');
      tick(2);
      expectSignal(network('output'), A).toBe(28);
    `,
    );
  });

  test.each([
    [0, false, 8, 5],
    [1, false, 0, 0],
    [2, true, 1, 0],
    [3, true, 2, 0],
  ])(
    'checks Constant example %i count normalization, timing and active sections',
    (index, trusted, a, b) => {
      const compilation = compile(blocks('api/constant.md')[index], trusted);
      run(
        compilation,
        `
      const A = Signal('virtual', 'signal-A');
      const B = Signal('virtual', 'signal-B');
      expectSignal(network('output'), A).toBe(0);
      tick(1);
      expectSignal(network('output'), A).toBe(${a});
      expectSignal(network('output'), B).toBe(${b});
      ${index === 0 ? "expectSignal(network('output'), Signal('iron-plate')).toBe(4); expectSignal(network('output'), Signal('copper-plate')).toBe(2);" : ''}
    `,
      );
      const json = generateBlueprintJson(compilation.resolvedCircuit.ir);
      expect(json.blueprint.entities).toHaveLength(1);
      if (index === 0) {
        expect(json.blueprint.entities[0]).toMatchObject({
          control_behavior: {
            sections: {
              sections: [
                {
                  filters: [
                    { count: 5 },
                    { count: 0 },
                    { count: -2 },
                    { count: 3 },
                    { count: 4 },
                    { count: 7 },
                    { count: 2 },
                  ],
                },
              ],
            },
          },
        });
      }
      if (index === 2 || index === 3) {
        expect(json.blueprint.entities[0]).toMatchObject({
          control_behavior: {
            is_on: true,
            sections: {
              sections: [
                {
                  active: true,
                  multiplier: 1,
                  filters: [
                    { quality: 'normal', count: a },
                    { quality: 'normal', count: 0 },
                  ],
                },
                { active: false, multiplier: 1 },
              ],
            },
          },
        });
      }
    },
  );

  test('preserves rich Section native configuration and explicitly rejects sparse evaluation', () => {
    const compilation = compile(blocks('api/constant.md')[4], true);
    expect(
      generateBlueprintJson(compilation.resolvedCircuit.ir).blueprint.entities[0],
    ).toMatchObject({
      control_behavior: {
        sections: {
          sections: [
            { index: 1, active: true, multiplier: 0.5, filters: [{ count: 1 }, { count: 2 }] },
            { index: 2, active: false, multiplier: 3, group: 'backup', filters: [{ count: 4 }] },
          ],
        },
      },
    });
    expect(() => compilation.execution.circuit.createSimulation().step()).toThrowError(
      expect.objectContaining({ code: 'FC1003', reasons: ['non-unit-multiplier', 'group'] }),
    );
  });

  test('checks default select, ascending select and count after the input tick', () => {
    const compilation = compile(blocks('api/selector.md')[0], true);
    run(
      compilation,
      `
      const B = Signal('virtual', 'signal-B');
      const C = Signal('virtual', 'signal-C');
      const TOTAL = Signal('virtual', 'signal-T');
      expectSignal(network('count'), TOTAL).toBe(0);
      tick(1);
      expectSignal(network('maximum'), C).toBe(0);
      expectSignal(network('minimum'), B).toBe(0);
      expectSignal(network('count'), TOTAL).toBe(0);
      tick(1);
      expectSignal(network('maximum'), C).toBe(7);
      expectSignal(network('minimum'), B).toBe(2);
      expectSignal(network('count'), TOTAL).toBe(3);
    `,
    );
    expect(
      generateBlueprintJson(compilation.resolvedCircuit.ir).blueprint.entities[1],
    ).toMatchObject({
      control_behavior: { operation: 'select', select_max: true, index_constant: 0 },
    });
  });

  test('reads the dynamic Signal index from both colors without excluding its candidate', () => {
    run(
      compile(blocks('api/selector.md')[1], true),
      `
      const B = Signal('virtual', 'signal-B');
      const INDEX = Signal('virtual', 'signal-I');
      tick(2);
      expectSignal(network('output'), B).toBe(3);
      expectSignal(network('output'), INDEX).toBe(0);
    `,
    );
  });

  test.each([-1, 99])(
    'checks empty output for numeric index %i in the documented pair',
    (index) => {
      const source = blocks('api/selector.md')[1].replace('index: INDEX', `index: ${index}`);
      run(
        compile(source, true),
        `
      tick(2);
      for (const name of ['signal-A', 'signal-B', 'signal-C', 'signal-I']) {
        expectSignal(network('output'), Signal('virtual', name)).toBe(0);
      }
    `,
      );
    },
  );

  test.each([
    'random',
    'stack-size',
    'rocket-capacity',
    'quality-filter',
    'quality-transfer',
    'time',
  ])('rejects unsupported exact Selector operation %s', (operation) => {
    const source = blocks('api/selector.md')[1].replace(
      "operation: 'select'",
      `operation: '${operation}'`,
    );
    const compilation = compileSourceProgram(
      { path: 'unsupported-selector.factorio.ts', text: source },
      host(),
    );
    expect(compilation.pipelineDiagnostics).toEqual([
      expect.objectContaining({
        code: 'RT2027',
        message: 'Selector configuration operation must be "select" or "count".',
      }),
    ]);
    expect(compilation.resolvedCircuit).toBeUndefined();
  });

  test.each([
    ['arithmetic', 1],
    ['decider', 2],
    ['constant', 2],
    ['constant', 3],
  ])('requires trusted base authority for %s exact example %i', (name, index) => {
    const compilation = compileSourceProgram({
      path: 'missing-canonical-profile.factorio.ts',
      text: blocks(`api/${name}.md`)[index],
    });
    expect(compilation.pipelineDiagnostics).toEqual([
      expect.objectContaining({
        code: 'RT2027',
        message: expect.stringContaining('requires a trusted base'),
      }),
    ]);
    expect(compilation.resolvedCircuit).toBeUndefined();
  });

  test('distinguishes profile-free Selector modeling from missing authority in a provider context', () => {
    const text = blocks('api/selector.md')[0];
    const profileFree = compile(text);
    expect(profileFree.resolvedCircuit.ir.producers).toHaveLength(4);
    expect(profileFree.resolvedCircuit.ir.entities).toHaveLength(0);
    run(
      profileFree,
      `tick(2); expectSignal(network('count'), Signal('virtual', 'signal-T')).toBe(3);`,
    );
    const missing = compileSourceProgram(
      { path: 'missing-selector-base.factorio.ts', text },
      host(['constant-combinator']),
    );
    expect(missing.pipelineDiagnostics).toEqual([
      expect.objectContaining({
        code: 'RT2027',
        message:
          'Exact Selector configuration requires a trusted base entity:selector-combinator Entity profile.',
      }),
    ]);
    expect(missing.resolvedCircuit).toBeUndefined();
  });

  test('retains the documented unused-output warning for an unattached empty CC', () => {
    const source = blocks('api/constant.md')[1].replace('output += empty;', '');
    expect(compile(source, false, ['CL2001']).resolvedCircuit.ir.producers).toHaveLength(1);
  });

  test.each([
    ['Boolean exact condition', 'Decider({ condition: true, outputs: [input[A]] })', 'RT2027'],
    [
      'no exact branch',
      'Decider({ condition: input[A] > 0, outputs: [], elseOutputs: [] })',
      'RT2027',
    ],
    ['no fluent branch', 'when(input[A] > 0)', 'RT2022'],
    ['empty then', 'when(input[A] > 0).then()', 'CL1014'],
    ['Any constant output', 'IF(input[A] > 0, 1 * ANY)', 'EX1001'],
    ['mixed Section and row', 'CC(Section(1 * A), 2 * A)', 'RT2027'],
    ['right Section multiplier', 'CC(Section(1 * A) * 0.5)', 'EX1001'],
    ['repeated Section multiplier', 'CC(3 * (0.5 * Section(1 * A)))', 'EX1001'],
    [
      'invalid Arithmetic quantifier',
      "Arithmetic({ left: Any(input), operation: 'add', right: 1, output: A })",
      'RT2027',
    ],
  ])('rejects documented invalid mode: %s', (_name, device, code) => {
    const text = `const A = Signal('virtual', 'signal-A');\nconst input = new Network();\nconst output = new Network();\noutput += ${device};`;
    const compilation = compileSourceProgram(
      { path: 'invalid-combinator-mode.factorio.ts', text },
      host(),
    );
    expect(compilation.pipelineDiagnostics).toEqual([
      expect.objectContaining({
        code,
        severity: 'error',
        span: { fileId: compilation.fileId, start: expect.any(Number), end: expect.any(Number) },
      }),
    ]);
    expect(compilation.resolvedCircuit).toBeUndefined();
  });

  test.each(['README.md', ...pages.map((name) => `api/${name}.md`)])(
    'checks %s relative links and section anchors',
    (name) => {
      for (const [, href] of read(name).matchAll(/\]\(([^)]+)\)/g)) {
        if (/^[a-z]+:|^\//i.test(href)) continue;
        const [path, anchor] = href.split('#');
        const target = path
          ? resolve(root, 'docs', dirname(name), path)
          : resolve(root, 'docs', name);
        expect(existsSync(target), `${name}: ${href}`).toBe(true);
        if (!anchor) continue;
        const headings = [...readFileSync(target, 'utf8').matchAll(/^#{1,6} (.+)$/gm)].map(
          ([, title]) =>
            title
              .trim()
              .toLowerCase()
              .replace(/[^\p{L}\p{N}_\- ]/gu, '')
              .replace(/ /g, '-'),
        );
        expect(headings, `${name}: ${href}`).toContain(anchor);
      }
    },
  );
});

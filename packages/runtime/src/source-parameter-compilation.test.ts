import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';

import {
  createTrustedEntityReplayContext,
  generateBlueprintJson,
  syntheticZeroPortEntityProfile,
} from '@comblang/compiler';
import { signal, SparseBus } from '@comblang/factorio';
import type { EntityProfile } from '@comblang/compiler/entity';
import type { EntityPrototype } from '@comblang/prototypes';
import { parseFile, reservedDslValueNames, validateDslSemantics } from '@comblang/language';

import {
  bindSourceCompilationCircuit,
  bindSourceCompilationParameters,
  compileSourceProgram,
  listSourceCompilationParameters,
  sourceCompilationArtifact,
} from './source-compilation.js';
import type { LocalSourceCompilation } from './source-compilation.js';
import type { EntityPrototypeResolver } from './entity-registry.js';
import { transformElaborationModule } from '@comblang/compiler';
import { executeElaborationProgram } from './elaboration-program.js';
import { executeElaborationProgramWithParameters } from './elaboration-program.js';
import { bindCapturedSourceConfigurationTemplates } from './executed-blueprint-configuration-binding.js';
import { bindCapturedSourceConfigurationTemplatesWithRelations } from './executed-blueprint-configuration-binding.js';
import { canonicalDirectPlan, canonicalResolvedCircuit } from './canonical-circuit.js';
import { executeResolvedDirectPlan, tryElaborateDirectPlan } from './direct-plan.js';
import { materializeCapturedPlan } from './source-configuration-materialization.js';
import { bindExecutedPlanConfigurationSet } from './executed-blueprint-configuration-binding.js';
import { createExecutedProducerCaptureReference } from './executed-blueprint-configuration-binding.js';
import { createBlueprintConfigurationSet } from '../../compiler/src/blueprint-configuration-set.js';
import { createSelectorConfigurationTemplate } from '../../compiler/src/selector-configuration-template.js';
import { createBlueprintParameterSession } from '../../compiler/src/blueprint-parameters.js';
import {
  canonicalBlueprintParameterHandle,
  findBlueprintParameterHandle,
} from '../../compiler/src/blueprint-parameters.js';

function parameterHost() {
  const families = [
    'arithmetic-combinator',
    'constant-combinator',
    'decider-combinator',
    'selector-combinator',
  ] as const;
  const profiles = families.map((family, index) => ({
    ...structuredClone(syntheticZeroPortEntityProfile),
    ref: {
      ...syntheticZeroPortEntityProfile.ref,
      prototypeKey: `entity:${family}` as EntityProfile['ref']['prototypeKey'],
      profileId: `profile:source-parameter-${index}` as EntityProfile['ref']['profileId'],
    },
    prototypeType: family,
  }));
  const trustedEntityReplayContext = createTrustedEntityReplayContext({
    database: profiles[0]!.ref.database,
    source: 'synthetic',
    evidenceIdentity: 'source-parameter-test-evidence',
    policyIdentity: 'source-parameter-test-policy',
    profiles,
  });
  const prototypes = families.map((family) => ({
    key: `entity:${family}` as EntityPrototype['key'],
    name: family,
    type: family,
    tileWidth: 1,
    tileHeight: 1,
  })) as EntityPrototype[];
  const entityPrototypeResolver: EntityPrototypeResolver = {
    database: trustedEntityReplayContext.database,
    getEntity(nameOrKey) {
      return prototypes.find(({ key, name }) => key === nameOrKey || name === nameOrKey);
    },
  };
  return { trustedEntityReplayContext, entityPrototypeResolver };
}

const source = `const A = Signal('virtual', 'signal-A');
const B = Signal('virtual', 'signal-B');
const amount = Param.number('Amount', 5);
const channel = Param.signal('Channel', Signal('virtual', 'signal-C'));
const input = new Network();
const output = new Network();
const arithmetic = Arithmetic({ left: input[A], operation: 'add', right: amount, output: B });
const constant = Constant({ sections: [{ filters: [{ signal: channel, value: amount }] }] });
const decider = Decider({ condition: input[A] > amount, outputs: [input[A]] });
output += arithmetic;
output += constant;
output += decider;`;

function expectConcreteDataTree(value: unknown, active = new WeakSet<object>()): void {
  if (typeof value === 'string') {
    expect(value).not.toMatch(
      /Amount|Channel|BlueprintParameter|configurationTemplate|numericExpression/i,
    );
    return;
  }
  if (value === null || typeof value !== 'object') {
    expect(typeof value).not.toBe('symbol');
    expect(typeof value).not.toBe('function');
    return;
  }
  expect(active.has(value)).toBe(false);
  if (active.has(value)) return;
  active.add(value);
  if (!Array.isArray(value)) {
    const prototype = Object.getPrototypeOf(value);
    expect(prototype === Object.prototype || prototype === null).toBe(true);
  }
  for (const key of Reflect.ownKeys(value)) {
    expect(typeof key).toBe('string');
    if (typeof key !== 'string') continue;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    expect(descriptor).toBeDefined();
    if (descriptor === undefined) continue;
    expect(Object.hasOwn(descriptor, 'value')).toBe(true);
    if (Array.isArray(value) && key === 'length') continue;
    expect(descriptor.enumerable).toBe(true);
    expect(key).not.toMatch(
      /Amount|Channel|BlueprintParameter|configurationTemplate|numericExpression/i,
    );
    expectConcreteDataTree(descriptor.value, active);
  }
  active.delete(value);
}

describe('ordinary source parameter declarations', () => {
  test.each([false, true])(
    'captures exact Arithmetic Signal output with numeric operand: %s',
    (numeric) => {
      const text = `const channel = Param.signal('Result', Signal('virtual', 'signal-B'));
${numeric ? "const amount = Param.number('Amount', 5);" : ''}
const output = new Network();
output += Arithmetic({ left: 2, operation: 'add', right: ${numeric ? 'amount' : '5'}, output: channel });`;
      const parsed = parseFile({ path: 'arithmetic-signal-output.factorio.ts', text });
      expect(validateDslSemantics(parsed)).toEqual([]);
      const compilation = compileSourceProgram(
        { path: 'arithmetic-signal-output.factorio.ts', text },
        parameterHost(),
      );
      expect(compilation.pipelineDiagnostics).toEqual([]);
      expect(compilation.plan!.producers).toHaveLength(1);
      expect(compilation.plan!.entities).toHaveLength(1);
      expect(compilation.plan!.producers[0]).toMatchObject({
        kind: 'arithmetic',
        output: { kind: 'signal', signal: signal('virtual', 'signal-B') },
        right: { kind: 'constant', value: 5 },
      });
      const captured = executeElaborationProgramWithParameters(
        transformElaborationModule(parsed),
        parameterHost(),
      );
      expect(captured.arithmeticTemplates).toHaveLength(1);
      expect(captured.arithmeticTemplates[0]!.template.output).toMatchObject({
        kind: 'signal',
        signal: captured.parameters[0]!.handle,
      });
      const pair = bindSourceCompilationCircuit(compilation);
      const replay = executeResolvedDirectPlan(pair.plan, pair.resolvedCircuit);
      expect(
        replay.circuit
          .createSimulation()
          .step()
          .read(replay.network('output').id)
          .get(signal('virtual', 'signal-B')),
      ).toBe(7);
    },
  );

  test.each(['concrete', 'each', 'parameter'] as const)(
    'retains exact Arithmetic wildcard input rules for %s output',
    (mode) => {
      const text = `const A = Signal('virtual', 'signal-A');
const B = Signal('virtual', 'signal-B');
const channel = Param.signal('Result', Signal('virtual', 'signal-C'));
const input = CC(2 * A, 4 * B);
const output = new Network();
output += Arithmetic({ left: Each(input), operation: 'add', right: 5,
  output: ${mode === 'parameter' ? 'channel' : mode === 'each' ? 'Each' : "Signal('virtual', 'signal-C')"} });`;
      const compilation = compileSourceProgram(
        { path: 'each-arithmetic-output.factorio.ts', text },
        parameterHost(),
      );
      expect(compilation.pipelineDiagnostics).toEqual([]);
      const pair = bindSourceCompilationCircuit(compilation);
      const replay = executeResolvedDirectPlan(pair.plan, pair.resolvedCircuit);
      const simulation = replay.circuit.createSimulation();
      simulation.step();
      const result = simulation.step().read(replay.network('output').id);
      if (mode === 'each') {
        expect(result.get(signal('virtual', 'signal-A'))).toBe(7);
        expect(result.get(signal('virtual', 'signal-B'))).toBe(9);
      } else {
        expect(result.get(signal('virtual', 'signal-C'))).toBe(16);
      }
      expect(pair.plan.producers).toHaveLength(2);
      if (mode === 'parameter') {
        const bound = bindSourceCompilationCircuit(compilation, [
          {
            parameter: listSourceCompilationParameters(compilation)[0]!.parameter,
            value: signal('item', 'iron-plate', 'uncommon'),
          },
        ]);
        const rebound = executeResolvedDirectPlan(bound.plan, bound.resolvedCircuit);
        const next = rebound.circuit.createSimulation();
        next.step();
        expect(
          next
            .step()
            .read(rebound.network('output').id)
            .get(signal('item', 'iron-plate', 'uncommon')),
        ).toBe(16);
      }
    },
  );

  test('executes the literal documented Arithmetic output program and host binding example', () => {
    const page = readFileSync(
      new URL('../../../docs/native-objects-deciders-and-parameters.md', import.meta.url),
      'utf8',
    );
    const section = page.match(
      /### Arithmetic output Signal parameters([\s\S]*?)### Numeric metadata/,
    )?.[1];
    const examples = [...section!.matchAll(/```ts\r?\n([\s\S]*?)```/g)].map((match) => match[1]!);
    expect(examples).toHaveLength(2);
    const compilation = compileSourceProgram(
      { path: 'documented-output.factorio.ts', text: examples[0]! },
      parameterHost(),
    );
    expect(compilation.pipelineDiagnostics).toEqual([]);
    const bound = Function(
      'compilation',
      'listSourceCompilationParameters',
      'bindSourceCompilationCircuit',
      `${examples[1]}\nreturn bound;`,
    )(compilation, listSourceCompilationParameters, bindSourceCompilationCircuit) as ReturnType<
      typeof bindSourceCompilationCircuit
    >;
    const replay = executeResolvedDirectPlan(bound.plan, bound.resolvedCircuit);
    expect(
      replay.circuit
        .createSimulation()
        .step()
        .read(replay.network('output').id)
        .get(signal('item', 'iron-plate', 'uncommon')),
    ).toBe(13);
  });

  test.each([
    ["Param.number('Wrong', 5)", 'left: 2, right: 5, output: slot'],
    [
      "Param.signal('Result', Signal('virtual', 'signal-B'))",
      "left: slot, right: 5, output: Signal('virtual', 'signal-A')",
    ],
    [
      "Param.signal('Result', Signal('virtual', 'signal-B'))",
      "left: 2, right: slot, output: Signal('virtual', 'signal-A')",
    ],
  ])('rejects wrong-kind output or bare Signal operand: %s / %s', (declaration, fields) => {
    const text = `const slot = ${declaration};\nArithmetic({ ${fields}, operation: 'add' });`;
    const compilation = compileSourceProgram(
      { path: 'arithmetic-wrong-slot.factorio.ts', text },
      parameterHost(),
    );
    expect(compilation.pipelineDiagnostics).toEqual([
      expect.objectContaining({
        code: 'RT2027',
        span: {
          fileId: compilation.fileId,
          start: text.indexOf('Arithmetic'),
          end: text.length - 1,
        },
      }),
    ]);
    expect(compilation.plan).toBeUndefined();
  });

  test('binds Arithmetic output and numeric override atomically without rerun or physical/provenance changes', () => {
    const key = '__comblang_arithmetic_output_runs';
    const globals = globalThis as Record<string, unknown>;
    const had = Object.hasOwn(globals, key);
    const before = globals[key];
    globals[key] = 0;
    const text = `globalThis.${key} += 1;
const channel = Param.signal('Result', Signal('virtual', 'signal-B'));
const amount = Param.number('Amount', 5);
function Make() { return Arithmetic({ left: 2, operation: 'add', right: amount, output: channel }).at(2, 3, 4); }
const device = Make();
const output = new Network<R>();
const mirror = new Network<G>();
device.to(output, mirror);`;
    try {
      const compilation = compileSourceProgram(
        { path: 'paired-arithmetic-output.factorio.ts', text },
        parameterHost(),
      );
      expect(compilation.pipelineDiagnostics).toEqual([]);
      const original = structuredClone(sourceCompilationArtifact(compilation));
      const [channel, amount] = listSourceCompilationParameters(compilation);
      const replacement = signal('item', 'iron-plate', 'uncommon');
      const bindings = [
        { parameter: channel!.parameter, value: replacement },
        { parameter: amount!.parameter, value: 11 },
      ];
      const defaults = bindSourceCompilationCircuit(compilation);
      const bound = bindSourceCompilationCircuit(compilation, bindings);
      const foreignCompilation = compileSourceProgram(
        { path: 'foreign-binding.factorio.ts', text: text.replace(`globalThis.${key} += 1;`, '') },
        parameterHost(),
      );
      const foreignParameter = listSourceCompilationParameters(foreignCompilation)[0]!.parameter;
      expect(() =>
        bindSourceCompilationCircuit(compilation, [
          { parameter: foreignParameter, value: replacement },
        ]),
      ).toThrow('different parameter session');
      expect(() =>
        bindSourceCompilationCircuit(compilation, [
          { parameter: { ...channel!.parameter } as never, value: replacement },
        ]),
      ).toThrow('registered parameter handle');
      expect(() => bindSourceCompilationCircuit({ ...compilation }, bindings)).toThrow(
        'no host-local source parameter declarations',
      );
      expect(bindSourceCompilationCircuit(compilation, bindings)).toEqual(bound);
      expect(bindSourceCompilationCircuit(compilation)).toEqual(defaults);
      expect(Object.isFrozen(bound.plan)).toBe(true);
      expect(Object.isFrozen(bound.resolvedCircuit)).toBe(true);
      expect(bound.plan.producers).toHaveLength(1);
      expect(bound.plan.entities).toHaveLength(1);
      expect(bound.plan.producers[0]).toEqual({
        ...defaults.plan.producers[0],
        right: { kind: 'constant', value: 11 },
        output: { kind: 'signal', signal: replacement },
      });
      expect(bound.plan.entities[0]).toEqual({
        ...defaults.plan.entities[0],
        configuration: {
          ...defaults.plan.entities[0]!.configuration,
          right: { kind: 'constant', value: 11 },
          output: { kind: 'signal', signal: replacement },
        },
      });
      const { producers: _dp, entities: _de, ...defaultPlanData } = defaults.plan;
      const { producers: _bp, entities: _be, ...boundPlanData } = bound.plan;
      expect(boundPlanData).toEqual(defaultPlanData);
      const { producers: _dirp, entities: _dire, ...defaultIrData } = defaults.resolvedCircuit.ir;
      const { producers: _birp, entities: _bire, ...boundIrData } = bound.resolvedCircuit.ir;
      expect(boundIrData).toEqual(defaultIrData);
      expect(bound.resolvedCircuit.ir.producers[0]).toEqual({
        ...defaults.resolvedCircuit.ir.producers[0],
        config: {
          ...defaults.resolvedCircuit.ir.producers[0]!.config,
          right: { kind: 'constant', value: 11 },
          output: { kind: 'signal', signal: replacement },
        },
      });
      expect(bound.resolvedCircuit.ir.entities[0]).toEqual({
        ...defaults.resolvedCircuit.ir.entities[0],
        configuration: {
          ...defaults.resolvedCircuit.ir.entities[0]!.configuration,
          right: { kind: 'constant', value: 11 },
          output: { kind: 'signal', signal: replacement },
        },
      });
      const defaultJson = generateBlueprintJson(defaults.resolvedCircuit.ir);
      const boundJson = generateBlueprintJson(bound.resolvedCircuit.ir);
      expect(boundJson.blueprint.wires).toEqual(defaultJson.blueprint.wires);
      expect(boundJson.blueprint.entities[0]).toEqual({
        ...defaultJson.blueprint.entities[0],
        control_behavior: {
          arithmetic_conditions: {
            first_constant: 2,
            operation: '+',
            second_constant: 11,
            output_signal: { name: 'iron-plate', quality: 'uncommon' },
          },
        },
      });
      for (const [pair, outputSignal, expected] of [
        [defaults, signal('virtual', 'signal-B'), 7],
        [bound, replacement, 13],
      ] as const) {
        const replay = executeResolvedDirectPlan(pair.plan, pair.resolvedCircuit);
        const snapshot = replay.circuit.createSimulation().step();
        for (const network of ['output', 'mirror'])
          expect(snapshot.read(replay.network(network).id).get(outputSignal)).toBe(expected);
      }
      expect(() => executeResolvedDirectPlan(defaults.plan, bound.resolvedCircuit)).toThrow();
      for (const invalid of [
        11,
        null,
        { type: 'invalid', name: 'x' },
        { type: 'item', name: '' },
        { type: 'item', name: 'iron-plate', quality: 3 },
      ]) {
        let failure: unknown;
        try {
          bindSourceCompilationCircuit(compilation, [
            { parameter: amount!.parameter, value: 12 },
            { parameter: channel!.parameter, value: invalid },
          ]);
        } catch (error) {
          failure = error;
        }
        expect(failure).toMatchObject({ code: 'CP1000', span: channel!.source });
        expect(sourceCompilationArtifact(compilation)).toEqual(original);
        expect(bindSourceCompilationCircuit(compilation, bindings)).toEqual(bound);
      }
      const cloned = structuredClone(sourceCompilationArtifact(compilation));
      expectConcreteDataTree([cloned.plan, cloned.resolvedCircuit]);
      expect(cloned.plan).toEqual(original.plan);
      expect(cloned.resolvedCircuit).toEqual(original.resolvedCircuit);
      expect(globals[key]).toBe(1);
    } finally {
      if (had) globals[key] = before;
      else delete globals[key];
    }
  });

  test('rejects foreign, copied and structural Signal output handles at the exact Arithmetic use', () => {
    const key = '__comblang_arithmetic_output_handle';
    const globals = globalThis as Record<string, unknown>;
    const had = Object.hasOwn(globals, key);
    const before = globals[key];
    const foreign = createBlueprintParameterSession().signal('foreign', {
      defaultValue: signal('virtual', 'signal-B'),
    });
    try {
      for (const candidate of [
        foreign,
        { ...foreign },
        { kind: 'signal', label: 'lookalike', defaultValue: signal('virtual', 'signal-B') },
      ]) {
        globals[key] = candidate;
        const text = `const local = Param.signal('Local', Signal('virtual', 'signal-A'));
Arithmetic({ left: 2, operation: 'add', right: 5, output: globalThis.${key} });`;
        const compilation = compileSourceProgram(
          { path: 'foreign-output.factorio.ts', text },
          parameterHost(),
        );
        expect(compilation.pipelineDiagnostics).toEqual([
          expect.objectContaining({
            code: 'RT2027',
            message: expect.stringContaining(
              candidate === foreign
                ? 'different parameter session'
                : 'unregistered parameter-like object',
            ),
            span: {
              fileId: compilation.fileId,
              start: text.indexOf('Arithmetic'),
              end: text.length - 1,
            },
          }),
        ]);
        expect(compilation.plan).toBeUndefined();
      }
    } finally {
      if (had) globals[key] = before;
      else delete globals[key];
    }
  });

  test('rolls back Signal-output templates and hardware after caught construction and failed instance', () => {
    const text = `const channel = Param.signal('Result', Signal('virtual', 'signal-B'));
const wrong = Param.number('Wrong', 5);
function Broken() {
  const device = Arithmetic({ left: 2, operation: 'add', right: 5, output: channel });
  const sink = new Network(); sink += device;
  Arithmetic({ left: 2, operation: 'add', right: 5, output: wrong });
}
try { t.instantiate(Broken); } catch {}
try { Arithmetic({ left: 2, operation: 'add', right: 5, output: wrong }); } catch {}
const device = Arithmetic({ left: 2, operation: 'add', right: 5, output: channel });
const output = new Network(); output += device;`;
    const environment = parameterHost();
    const captured = executeElaborationProgramWithParameters(
      transformElaborationModule(
        parseFile({ path: 'arithmetic-output-rollback.factorio.ts', text }),
        { testContextName: 't' },
      ),
      environment,
    );
    expect(captured.plan.producers).toHaveLength(1);
    expect(captured.plan.entities).toHaveLength(1);
    expect(captured.plan.entities[0]!.ordinal).toBe(1);
    expect(captured.plan.debugInstances).toEqual([]);
    expect(captured.arithmeticTemplates).toHaveLength(1);
    const execution = tryElaborateDirectPlan(
      captured.plan,
      environment.trustedEntityReplayContext,
    ).execution!;
    const bound = bindCapturedSourceConfigurationTemplates(captured, execution, [
      { parameter: captured.parameters[0]!.handle, value: signal('item', 'iron-plate') },
    ]);
    expect(bound.producers[0]!.config).toMatchObject({
      output: { kind: 'signal', signal: signal('item', 'iron-plate') },
    });
  });

  test.each([
    "Param.signal('Bad', { type: 'virtual', name: '' })",
    "Param.signal('Bad', { type: 'bad', name: 'x' })",
  ])('invalid Signal default retains declaration context: %s', (declaration) => {
    const text = `const channel = ${declaration};\nArithmetic({ left: 2, operation: 'add', right: 5, output: channel });`;
    const compilation = compileSourceProgram(
      { path: 'invalid-output-default.factorio.ts', text },
      parameterHost(),
    );
    expect(compilation.pipelineDiagnostics).toEqual([
      expect.objectContaining({
        code: 'EX1001',
        span: {
          fileId: compilation.fileId,
          start: text.indexOf('Param.signal'),
          end: text.indexOf(';'),
        },
      }),
    ]);
    expect(compilation.plan).toBeUndefined();
  });

  test.each([
    'const input = new Network(); input[channel] += CC(1 * A);',
    'const input = new Network(); input + channel;',
    'const input = new Network(); IF(input[A] > 0, channel);',
    'const input = new Network(); when(input[A] > 0).then(channel);',
  ])('does not widen unrelated source Signal parameter use: %s', (use) => {
    const text = `const A = Signal('virtual', 'signal-A');
const channel = Param.signal('Result', Signal('virtual', 'signal-B'));
${use}`;
    const compilation = compileSourceProgram(
      { path: 'unsupported-output-context.factorio.ts', text },
      parameterHost(),
    );
    const errors = compilation.pipelineDiagnostics.filter(({ severity }) => severity === 'error');
    expect(errors).toHaveLength(1);
    expect(errors[0]!.span).toMatchObject({ fileId: compilation.fileId });
    expect(compilation.plan).toBeUndefined();
  });

  test('evaluates metadata once after label/default and keeps formulas independent of concrete binding', () => {
    const text = `const order = [];
function label() { order.push('label'); return 'Amount'; }
function value() { order.push('default'); return 5; }
const options = { formula: ' unknown(x) + ( ', variable: 'x', dependent: true };
function metadata() { order.push('metadata'); return options; }
const amount = Param.number(label(), value(), metadata());
if (order.join(',') !== 'label,default,metadata') throw new Error('wrong evaluation order');
options.formula = 'mutated';
const output = new Network();
output += Arithmetic({ left: 2, operation: 'add', right: amount, output: Signal('virtual', 'signal-A') });`;
    const compilation = compileSourceProgram(
      { path: 'numeric-metadata.factorio.ts', text },
      parameterHost(),
    );
    expect(compilation.pipelineDiagnostics).toEqual([]);
    const declarations = listSourceCompilationParameters(compilation);
    expect(declarations[0]).toMatchObject({
      defaultValue: 5,
      metadata: { variable: 'x', formula: ' unknown(x) + ( ', dependent: true },
    });
    expect(Object.isFrozen(declarations[0]!.metadata)).toBe(true);
    const start = text.indexOf('Param.number');
    expect(declarations[0]!.source).toEqual({
      fileId: compilation.fileId,
      start,
      end: start + 'Param.number(label(), value(), metadata())'.length,
    });
    const defaults = bindSourceCompilationCircuit(compilation);
    const override = bindSourceCompilationCircuit(compilation, [
      { parameter: declarations[0]!.parameter, value: 12 },
    ]);
    for (const [pair, expected] of [
      [defaults, 7],
      [override, 14],
    ] as const) {
      const replay = executeResolvedDirectPlan(pair.plan, pair.resolvedCircuit);
      expect(
        replay.circuit
          .createSimulation()
          .step()
          .read(replay.network('output').id)
          .get(signal('virtual', 'signal-A')),
      ).toBe(expected);
      expect(pair.plan.networks).toEqual(defaults.plan.networks);
      expect(pair.plan.entities.map(({ id }) => id)).toEqual(
        defaults.plan.entities.map(({ id }) => id),
      );
    }
    const artifact = sourceCompilationArtifact(compilation);
    expect(artifact).not.toHaveProperty('parameters');
    expect(JSON.stringify([artifact.plan, artifact.resolvedCircuit])).not.toContain('unknown(x)');
  });

  test.each([
    ['{ variable: undefined }', '$.metadata.variable'],
    ['{ formula: 7 }', '$.metadata.formula'],
    ['{ dependent: null }', '$.metadata.dependent'],
    ['{ future: true }', '$.metadata.future'],
    ['null', '$.metadata'],
    ['[]', '$.metadata'],
  ])('reports invalid numeric metadata at the declaration: %s', (metadata, path) => {
    const text = `const amount = Param.number('Amount', 5, ${metadata});`;
    const compilation = compileSourceProgram({ path: 'invalid-numeric-metadata.ts', text });
    expect(compilation.pipelineDiagnostics).toEqual([
      expect.objectContaining({
        code: 'CP1000',
        message: expect.stringContaining(path),
        span: {
          fileId: compilation.fileId,
          start: text.indexOf('Param.number'),
          end: text.length - 1,
        },
      }),
    ]);
  });

  test('rejects metadata accessors without executing them and retains opaque parameter views', () => {
    const text = `let reads = 0;
const metadata = Object.defineProperty({}, 'formula', { enumerable: true, get() { reads += 1; return 'x'; } });
try { Param.number('N', 5, metadata); } catch {}
if (reads !== 0) throw new Error('getter executed');`;
    const compilation = compileSourceProgram({ path: 'metadata-getter.ts', text });
    expect(compilation.pipelineDiagnostics[0]).toMatchObject({
      code: 'CP1000',
      message: expect.stringContaining('$.metadata.formula'),
    });
    for (const read of [
      'amount.metadata;',
      "amount['formula'];",
      "Object.getOwnPropertyDescriptor(amount, 'metadata');",
      'Reflect.ownKeys(amount);',
      '({ ...amount });',
    ]) {
      const escaped = compileSourceProgram({
        path: 'metadata-escape.ts',
        text: `const amount = Param.number('N', 5, { formula: 'x' }); ${read}`,
      });
      expect(escaped.pipelineDiagnostics[0]?.code, read).toMatch(/^(CP1001|RT2029)$/);
    }
    const bypass = transformElaborationModule(
      parseFile({
        path: 'signal-metadata-bypass.ts',
        text: "Param.signal('S', Signal('signal-A'), { formula: 'x' });",
      }),
    );
    expect(() => executeElaborationProgramWithParameters(bypass)).toThrowError(
      expect.objectContaining({ code: 'CP1000' }),
    );
  });

  test('keeps a bound circuit paired with a replayable concrete plan', () => {
    const compilation = compileSourceProgram(
      {
        path: 'paired-source-parameter.factorio.ts',
        text: `const amount = Param.number('Amount', 5);
const output = new Network();
const arithmetic = Arithmetic({
  left: 2,
  operation: 'add',
  right: amount,
  output: Signal('virtual', 'signal-A'),
});
output += arithmetic;`,
      },
      parameterHost(),
    );
    const parameter = listSourceCompilationParameters(compilation)[0]!.parameter;
    const boundIr = bindSourceCompilationParameters(compilation, [{ parameter, value: 12 }]);

    expect(compilation.pipelineDiagnostics).toEqual([]);
    expect(() =>
      executeResolvedDirectPlan(
        compilation.plan!,
        canonicalResolvedCircuit(compilation.resolvedCircuit, compilation.plan, boundIr),
      ),
    ).toThrow(/Producer/);

    const pair = bindSourceCompilationCircuit(compilation, [{ parameter, value: 12 }]);
    const replay = executeResolvedDirectPlan(pair.plan, pair.resolvedCircuit);

    expect(pair.plan.producers[0]).toMatchObject({
      kind: 'arithmetic',
      right: { kind: 'constant', value: 12 },
    });
    expect(
      replay.circuit
        .createSimulation()
        .step()
        .read(replay.network('output').id)
        .get(signal('virtual', 'signal-A')),
    ).toBe(14);
  });

  test('keeps repeated and failed pair binds atomic to one host compilation', () => {
    let sourceExecutions = 0;
    const file = {
      path: 'paired-binding-ownership.factorio.ts',
      text: `const amount = Param.number('Amount', 5);
const output = new Network();
output += Arithmetic({
  left: 2,
  operation: 'add',
  right: amount,
  output: Signal('virtual', 'signal-A'),
});`,
    };
    const compilation = compileSourceProgram(file, parameterHost(), [], (stage) => {
      if (stage === 'execute') sourceExecutions += 1;
    });
    const parameter = listSourceCompilationParameters(compilation)[0]!.parameter;
    const originalPlan = compilation.plan;
    const originalResolvedCircuit = compilation.resolvedCircuit;
    const first = bindSourceCompilationCircuit(compilation, [{ parameter, value: 8 }]);
    const second = bindSourceCompilationCircuit(compilation, [{ parameter, value: 13 }]);

    expect(first.plan.producers[0]).toMatchObject({ right: { kind: 'constant', value: 8 } });
    expect(second.plan.producers[0]).toMatchObject({ right: { kind: 'constant', value: 13 } });
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.plan)).toBe(true);
    expect(Object.isFrozen(first.resolvedCircuit)).toBe(true);
    expect(Object.isFrozen(first.resolvedCircuit.ir.producers[0])).toBe(true);
    expect(sourceExecutions).toBe(1);

    expect(() =>
      bindSourceCompilationCircuit(compilation, [
        { parameter, value: Number.MAX_SAFE_INTEGER + 1 },
      ]),
    ).toThrow();
    expect(first.plan.producers[0]).toMatchObject({ right: { kind: 'constant', value: 8 } });
    expect(compilation.plan).toBe(originalPlan);
    expect(compilation.resolvedCircuit).toBe(originalResolvedCircuit);
    expect(bindSourceCompilationCircuit(compilation).plan).toEqual(originalPlan);

    const foreign = compileSourceProgram(file, parameterHost());
    const foreignParameter = listSourceCompilationParameters(foreign)[0]!.parameter;
    expect(() =>
      bindSourceCompilationCircuit(compilation, [{ parameter: foreignParameter, value: 2 }]),
    ).toThrow('parameter belongs to a different parameter session');
    const copiedCompilation = { ...compilation } as LocalSourceCompilation;
    expect(() => bindSourceCompilationCircuit(copiedCompilation)).toThrow(
      'Compilation has no host-local source parameter declarations',
    );
    expect(compilation.plan?.context).toEqual(compilation.resolvedCircuit?.ir.context);
    expect(sourceExecutions).toBe(1);
  });

  test('materializes exact Arithmetic and Constant configs without changing physical identity', () => {
    const compilation = compileSourceProgram(
      {
        path: 'paired-arithmetic-constant.factorio.ts',
        text: `const A = Signal('virtual', 'signal-A');
const B = Signal('virtual', 'signal-B');
const amount = Param.number('Amount', 5);
const channel = Param.signal('Channel', Signal('virtual', 'signal-C'));
const input = new Network();
const output = new Network();
const arithmetic = Arithmetic({ left: input[A], operation: 'add', right: amount, output: B });
const constant = Constant({
  isOn: true,
  sections: [
    { active: true, multiplier: 0.5, filters: [{ signal: channel, value: amount }] },
    { active: false, group: 'backup', multiplier: 3, filters: [{ signal: A, value: 4 }] },
  ],
});
output += arithmetic;
output += constant;
output += CC(2 * A);`,
      },
      parameterHost(),
    );
    const declarations = listSourceCompilationParameters(compilation);
    const defaults = bindSourceCompilationCircuit(compilation);
    const overridden = bindSourceCompilationCircuit(compilation, [
      { parameter: declarations[0]!.parameter, value: 11 },
      {
        parameter: declarations[1]!.parameter,
        value: { type: 'virtual', name: 'signal-D' },
      },
    ]);
    const reset = bindSourceCompilationCircuit(compilation);

    expect(overridden.plan.producers.find(({ kind }) => kind === 'arithmetic')).toMatchObject({
      kind: 'arithmetic',
      right: { kind: 'constant', value: 11 },
    });
    expect(
      overridden.plan.producers.find(
        (producer) => producer.kind === 'constant' && 'configuration' in producer,
      ),
    ).toMatchObject({
      kind: 'constant',
      configuration: {
        isOn: true,
        sections: [
          {
            active: true,
            multiplier: 0.5,
            filters: [{ signal: { type: 'virtual', name: 'signal-D' }, value: 11 }],
          },
          {
            active: false,
            group: 'backup',
            multiplier: 3,
            filters: [{ signal: { type: 'virtual', name: 'signal-A' }, value: 4 }],
          },
        ],
      },
    });
    expect(overridden.plan.producers[2]).toEqual(defaults.plan.producers[2]);
    expect(reset.plan).toEqual(defaults.plan);
    expect(reset.resolvedCircuit).toEqual(defaults.resolvedCircuit);
    expect(overridden.plan.networks.map(({ name }) => name)).toEqual(
      defaults.plan.networks.map(({ name }) => name),
    );
    expect(overridden.resolvedCircuit.ir.networks.map(({ id }) => id)).toEqual(
      defaults.resolvedCircuit.ir.networks.map(({ id }) => id),
    );
    expect(overridden.resolvedCircuit.ir.producers.map(({ id }) => id)).toEqual(
      defaults.resolvedCircuit.ir.producers.map(({ id }) => id),
    );
    expect(overridden.resolvedCircuit.ir.entities.map(({ id }) => id)).toEqual(
      defaults.resolvedCircuit.ir.entities.map(({ id }) => id),
    );
    for (const producer of overridden.plan.producers) {
      if (producer.entityId === undefined) continue;
      const linkedEntity = overridden.resolvedCircuit.ir.entities.find(
        ({ id }) => id === producer.entityId,
      );
      expect(linkedEntity?.configuration?.mode).toBe(producer.kind);
    }
    expect(JSON.stringify(overridden)).not.toMatch(
      /Amount|Channel|declareBlueprint|BlueprintParameter|configurationTemplate/i,
    );
  });

  test('reserves Param and compiles exact supported defaults into a concrete plan', () => {
    const parsed = parseFile({ path: 'source-parameters.factorio.ts', text: source });
    expect(reservedDslValueNames.has('Param')).toBe(true);
    expect(validateDslSemantics(parsed)).toEqual([]);

    const compilation = compileSourceProgram(
      { path: 'source-parameters.factorio.ts', text: source },
      parameterHost(),
    );

    expect(compilation.pipelineDiagnostics).toEqual([]);
    expect(compilation.plan?.producers.map(({ kind }) => kind)).toEqual([
      'arithmetic',
      'constant',
      'decider',
    ]);
    expect(compilation.plan?.entities).toHaveLength(3);
    expect(compilation.plan?.producers.every(({ entityId }) => entityId !== undefined)).toBe(true);
    expect(compilation.resolvedCircuit?.ir.entities).toHaveLength(3);
    expect(JSON.stringify(compilation.plan)).not.toContain('Amount');
    expect(JSON.stringify(compilation.plan)).not.toContain('Channel');
    expect(compilation.plan?.producers.find(({ kind }) => kind === 'constant')).toMatchObject({
      configuration: {
        sections: [{ filters: [{ signal: { type: 'virtual', name: 'signal-C' }, value: 5 }] }],
      },
    });
  });

  test('preserves source-view identity through aliases and ordinary containers', () => {
    const compilation = compileSourceProgram(
      {
        path: 'parameter-view-aliases.factorio.ts',
        text: `const amount = Param.number('Amount', 5);
const alias = amount;
const box = { values: [alias] };
const input = new Network();
const output = new Network();
const arithmetic = Arithmetic({
  left: input[Signal('virtual', 'signal-A')],
  operation: 'add',
  right: box.values[0],
  output: Signal('virtual', 'signal-B'),
});
output += arithmetic;`,
      },
      parameterHost(),
    );

    expect(compilation.pipelineDiagnostics).toEqual([]);
    expect(compilation.plan?.producers).toMatchObject([
      { kind: 'arithmetic', right: { kind: 'constant', value: 5 } },
    ]);
    expect(listSourceCompilationParameters(compilation)).toMatchObject([
      { kind: 'number', label: 'Amount', defaultValue: 5 },
    ]);
  });

  test('keeps the escaped source view distinct from the host-listed handle', () => {
    const key = Symbol.for('comblang.test.source-parameter-view');
    const globalRecord = globalThis as Record<PropertyKey, unknown>;
    const hadPriorValue = Object.hasOwn(globalRecord, key);
    const priorValue = globalRecord[key];
    try {
      const compilation = compileSourceProgram(
        {
          path: 'parameter-view-host-boundary.factorio.ts',
          text: `const amount = Param.number('Amount', 5);
globalThis[Symbol.for('comblang.test.source-parameter-view')] = amount;
const input = new Network();
const output = new Network();
const arithmetic = Arithmetic({
  left: input[Signal('virtual', 'signal-A')],
  operation: 'add',
  right: amount,
  output: Signal('virtual', 'signal-B'),
});
output += arithmetic;`,
        },
        parameterHost(),
      );
      const sourceView = globalRecord[key] as object;
      const hostHandle = listSourceCompilationParameters(compilation)[0]!.parameter;

      expect(compilation.pipelineDiagnostics).toEqual([]);
      expect(Object.is(sourceView, hostHandle)).toBe(false);
      expect(canonicalBlueprintParameterHandle(sourceView)).toBe(hostHandle);
      expect(findBlueprintParameterHandle(sourceView)).toMatchObject({
        kind: 'number',
        label: 'Amount',
        defaultValue: 5,
      });
      expect(() => Reflect.ownKeys(sourceView)).toThrowError(
        expect.objectContaining({ code: 'CP1001' }),
      );
      expect(
        bindSourceCompilationParameters(compilation, [
          { parameter: sourceView as never, value: 9 },
        ]).producers.find(({ kind }) => kind === 'arithmetic'),
      ).toMatchObject({ kind: 'arithmetic', config: { right: { kind: 'constant', value: 9 } } });
      const artifact = sourceCompilationArtifact(compilation);
      expect(artifact).not.toHaveProperty('parameters');
      expect(JSON.stringify(artifact.plan)).not.toContain('Amount');
      expect(JSON.stringify(artifact.resolvedCircuit)).not.toContain('Amount');
    } finally {
      if (!hadPriorValue) delete globalRecord[key];
      else globalRecord[key] = priorValue;
    }
  });

  test('lists host-local declarations and atomically binds them into a fresh concrete NCIR', () => {
    const compilation = compileSourceProgram(
      { path: 'source-parameters.factorio.ts', text: source },
      parameterHost(),
    );
    const declarations = listSourceCompilationParameters(compilation);

    expect(
      declarations.map(({ kind, label, defaultValue }) => ({ kind, label, defaultValue })),
    ).toEqual([
      { kind: 'number', label: 'Amount', defaultValue: 5 },
      { kind: 'signal', label: 'Channel', defaultValue: { type: 'virtual', name: 'signal-C' } },
    ]);

    const bound = bindSourceCompilationParameters(compilation, [
      { parameter: declarations[0]!.parameter, value: 12 },
      {
        parameter: declarations[1]!.parameter,
        value: { type: 'virtual', name: 'signal-D' },
      },
    ]);

    expect(bound).not.toBe(compilation.execution?.circuit.ir);
    expect(bound.producers.find(({ kind }) => kind === 'arithmetic')).toMatchObject({
      config: { right: { kind: 'constant', value: 12 } },
    });
    expect(bound.producers.find(({ kind }) => kind === 'constant')).toMatchObject({
      config: {
        configuration: {
          sections: [{ filters: [{ signal: { type: 'virtual', name: 'signal-D' }, value: 12 }] }],
        },
      },
    });
    expect(bound.producers.find(({ kind }) => kind === 'decider')).toMatchObject({
      config: {
        condition: {
          kind: 'compare',
          right: { kind: 'constant', value: 12 },
        },
      },
    });
    expect(compilation.execution?.circuit.ir.producers).not.toEqual(bound.producers);
  });

  test('keeps nominal handles, templates and host binding state out of the artifact', () => {
    const compilation = compileSourceProgram(
      { path: 'source-parameters.factorio.ts', text: source },
      parameterHost(),
    );
    const artifact = sourceCompilationArtifact(compilation);

    expect(structuredClone(artifact)).toEqual(artifact);
    expect(artifact).not.toHaveProperty('parameters');
    expect(artifact).not.toHaveProperty('parameterTemplates');
    expect(artifact).not.toHaveProperty('session');
    expect(artifact).not.toHaveProperty('elaborationJavaScript');
    expect(JSON.stringify(artifact)).not.toContain('declareBlueprint');
    expect(artifact.plan?.producers.some(({ kind }) => kind === 'constant')).toBe(true);
    expect('execution' in artifact).toBe(false);
  });

  test('retains parameter-free output and rejects invalid declarations with source spans', () => {
    const parameterFreeSource = {
      path: 'parameter-free.factorio.ts',
      text: "const A = Signal('virtual', 'signal-A'); const output = new Network(); output += CC(2 * A);",
    };
    const parameterFree = compileSourceProgram(parameterFreeSource);
    const ordinarySource = parameterFree.elaborationJavaScript;
    expect(listSourceCompilationParameters(parameterFree)).toEqual([]);
    expect(JSON.stringify(sourceCompilationArtifact(parameterFree))).not.toContain('parameters');
    expect(ordinarySource).not.toContain('declareBlueprint');
    const directPlan = canonicalDirectPlan(
      executeElaborationProgram(transformElaborationModule(parseFile(parameterFreeSource))),
    );
    expect(parameterFree.plan).toEqual(directPlan);
    expect(parameterFree.plan?.producers).toMatchObject([
      {
        kind: 'constant',
        outputs: [{ signal: { type: 'virtual', name: 'signal-A' }, value: 2 }],
      },
    ]);
    expect(parameterFree.resolvedCircuit).toEqual(
      tryElaborateDirectPlan(directPlan).resolvedCircuit,
    );
    const incidentalRuntimeName = compileSourceProgram({
      path: 'incidental-runtime-name.factorio.ts',
      text: 'const declareBlueprintNumberParameter = 5; const output = new Network();',
    });
    expect(listSourceCompilationParameters(incidentalRuntimeName)).toEqual([]);
    expect(sourceCompilationArtifact(incidentalRuntimeName)).toHaveProperty(
      'elaborationJavaScript',
    );

    for (const invalid of [
      `Param.number('missing default');`,
      `Param.number('too many', 1, 2);`,
      `Param.unknown('not supported', 1);`,
      `Param.number('invalid default', NaN);`,
      `Param.number('wrong default kind', '5');`,
      `Param.signal('forged default', { type: 'virtual', name: 'signal-A' });`,
    ]) {
      const compilation = compileSourceProgram({
        path: 'invalid-parameter.factorio.ts',
        text: invalid,
      });
      expect(compilation.pipelineDiagnostics).toEqual([
        expect.objectContaining({
          code: expect.stringMatching(/^(CL1050|CP1000|EX1001)$/),
          severity: 'error',
          span: expect.any(Object),
        }),
      ]);
    }
  });

  test('rejects handles escaping through control flow, coercion, arbitrary calls and wrong slots', () => {
    const unsupported = [
      `const amount = Param.number('Amount', 5); if (amount) {}`,
      `const amount = Param.number('Amount', 5); const gate = !amount; if (gate) {}`,
      `const amount = Param.number('Amount', 5); amount + 1;`,
      `const amount = Param.number('Amount', 5); const record = { [amount]: 1 };`,
      `const amount = Param.number('Amount', 5); for (let index = 0; index < amount; index++) {}`,
      `const amount = Param.number('Amount', 5); Number(amount);`,
      `const amount = Param.number('Amount', 5); Boolean(amount);`,
      `const A = Signal('virtual', 'signal-A'); const input = new Network(); const amount = Param.number('Amount', 5); IF(input[A] > amount, input[A]);`,
      `const A = Signal('virtual', 'signal-A'); const input = new Network(); const amount = Param.number('Amount', 5); when(input[A] > amount).then(input[A]);`,
    ];
    for (const text of unsupported) {
      const compilation = compileSourceProgram({ path: 'parameter-misuse.factorio.ts', text });
      expect(compilation.pipelineDiagnostics).toHaveLength(1);
      if (compilation.pipelineDiagnostics[0]?.span === undefined) {
        throw new Error(`Missing source location for misuse: ${text}`);
      }
      expect(compilation.pipelineDiagnostics[0]).toMatchObject({
        severity: 'error',
        span: expect.any(Object),
      });
    }

    const wrongSlot = `const A = Signal('virtual', 'signal-A');
const channel = Param.signal('Channel', Signal('virtual', 'signal-B'));
const input = new Network();
const sum = Arithmetic({ left: input[A], operation: 'add', right: channel, output: A });`;
    const wrongSlotCompilation = compileSourceProgram(
      { path: 'parameter-wrong-slot.factorio.ts', text: wrongSlot },
      parameterHost(),
    );
    expect(wrongSlotCompilation.pipelineDiagnostics).toEqual([
      expect.objectContaining({ severity: 'error', span: expect.any(Object) }),
    ]);
  });

  test('seals delayed declarations and keeps nominal ownership isolated between compilations', () => {
    const globalKey = '__comblang_source_parameter_delayed_call__';
    const globalRecord = globalThis as Record<string, unknown>;
    const hadPriorValue = Object.hasOwn(globalRecord, globalKey);
    const priorValue = globalRecord[globalKey];
    const text = `const amount = Param.number('Amount', 5);
globalThis.${globalKey} = () => Param.number('Late', 6);`;
    try {
      const first = compileSourceProgram({ path: 'parameter-isolation.factorio.ts', text });
      const second = compileSourceProgram({ path: 'parameter-isolation.factorio.ts', text });
      const firstParameter = listSourceCompilationParameters(first)[0]!.parameter;
      const secondParameter = listSourceCompilationParameters(second)[0]!.parameter;
      expect(firstParameter).not.toBe(secondParameter);
      expect(() =>
        bindSourceCompilationParameters(first, [{ parameter: secondParameter, value: 7 }]),
      ).toThrow('parameter belongs to a different parameter session');
      expect(() => bindSourceCompilationParameters({ ...first }, [])).toThrow(
        'Compilation has no host-local source parameter declarations',
      );

      const delayed = globalRecord[globalKey] as () => unknown;
      expect(() => delayed()).toThrow('elaboration runtime is sealed');
    } finally {
      if (!hadPriorValue) delete globalRecord[globalKey];
      else globalRecord[globalKey] = priorValue;
    }
  });

  test('preserves default binding, topology and physical identities', () => {
    const compilation = compileSourceProgram(
      { path: 'source-parameters.factorio.ts', text: source },
      parameterHost(),
    );
    if (compilation.execution === undefined) throw new Error('Expected a canonical execution.');

    const defaults = bindSourceCompilationParameters(compilation);
    expect(defaults).toEqual(compilation.execution.circuit.ir);
    const overridden = bindSourceCompilationParameters(compilation, [
      { parameter: listSourceCompilationParameters(compilation)[0]!.parameter, value: 12 },
    ]);
    expect(overridden.networks).toEqual(compilation.execution.circuit.ir.networks);
    expect(overridden.entities.map(({ id }) => id)).toEqual(
      compilation.execution.circuit.ir.entities.map(({ id }) => id),
    );
    expect(overridden.producers.map(({ id }) => id)).toEqual(
      compilation.execution.circuit.ir.producers.map(({ id }) => id),
    );
  });

  test('validates malformed, duplicate, foreign and kind-mismatched bindings atomically', () => {
    const first = compileSourceProgram(
      { path: 'source-parameters.factorio.ts', text: source },
      parameterHost(),
    );
    const second = compileSourceProgram(
      { path: 'source-parameters.factorio.ts', text: source },
      parameterHost(),
    );
    const firstParameters = listSourceCompilationParameters(first);
    const secondParameters = listSourceCompilationParameters(second);

    expect(() =>
      bindSourceCompilationParameters(first, [
        { parameter: firstParameters[0]!.parameter, value: 2 },
        { parameter: firstParameters[0]!.parameter, value: 3 },
      ]),
    ).toThrow('duplicate binding');
    expect(() =>
      bindSourceCompilationParameters(first, [
        { parameter: secondParameters[0]!.parameter, value: 2 },
      ]),
    ).toThrow('parameter belongs to a different parameter session');
    expect(() =>
      bindSourceCompilationParameters(first, [
        { parameter: firstParameters[0]!.parameter } as never,
      ]),
    ).toThrow('value is required');

    const before = structuredClone(first.execution?.circuit.ir);
    expect(() =>
      bindSourceCompilationParameters(first, [
        { parameter: firstParameters[0]!.parameter, value: 11 },
        { parameter: firstParameters[1]!.parameter, value: 11 },
      ]),
    ).toThrow();
    expect(first.execution?.circuit.ir).toEqual(before);
  });

  test('captures the three exact Selector parameter slots and binds paired NCIR atomically', () => {
    const text = `const numberIndex = Param.number('Index', 2);
const signalIndex = Param.signal('Selected signal', Signal('virtual', 'signal-B'));
const countOutput = Param.signal('Count output', Signal('virtual', 'signal-C'));
const input = new Network();
const secondary = new Network();
const output = new Network();
const byNumber = Selector({ input, operation: 'select', index: numberIndex }).at(2, 3);
const bySignal = Selector({ input: pair(input, secondary), operation: 'select', selectMax: false, index: signalIndex });
const counted = Selector({ input, operation: 'count', output: countOutput });
output += byNumber;
output += bySignal;
output += counted;`;
    const compilation = compileSourceProgram(
      { path: 'source-selector-parameters.factorio.ts', text },
      parameterHost(),
    );

    expect(compilation.pipelineDiagnostics).toEqual([]);
    expect(JSON.stringify(compilation.plan)).not.toMatch(/Index|Selected signal|Count output/);
    expect(compilation.plan?.producers.filter(({ kind }) => kind === 'selector')).toMatchObject([
      { operation: 'select', selectMax: true, index: 2 },
      {
        operation: 'select',
        selectMax: false,
        index: { type: 'virtual', name: 'signal-B' },
      },
      { operation: 'count', output: { type: 'virtual', name: 'signal-C' } },
    ]);
    expect(compilation.resolvedCircuit?.ir.entities).toHaveLength(3);
    expect(
      listSourceCompilationParameters(compilation).map(({ kind, label, defaultValue }) => ({
        kind,
        label,
        defaultValue,
      })),
    ).toEqual([
      { kind: 'number', label: 'Index', defaultValue: 2 },
      {
        kind: 'signal',
        label: 'Selected signal',
        defaultValue: { type: 'virtual', name: 'signal-B' },
      },
      {
        kind: 'signal',
        label: 'Count output',
        defaultValue: { type: 'virtual', name: 'signal-C' },
      },
    ]);

    const declarations = listSourceCompilationParameters(compilation);
    const before = compilation.execution?.circuit.ir;
    const bound = bindSourceCompilationParameters(compilation, [
      { parameter: declarations[0]!.parameter, value: 7 },
      {
        parameter: declarations[1]!.parameter,
        value: { type: 'virtual', name: 'signal-D' },
      },
      {
        parameter: declarations[2]!.parameter,
        value: { type: 'virtual', name: 'signal-E' },
      },
    ]);

    const boundSelectors = bound.producers.filter(({ kind }) => kind === 'selector');
    expect(boundSelectors.map(({ config }) => config)).toMatchObject([
      { operation: 'select', selectMax: true, index: 7 },
      {
        operation: 'select',
        selectMax: false,
        index: { type: 'virtual', name: 'signal-D' },
      },
      { operation: 'count', output: { type: 'virtual', name: 'signal-E' } },
    ]);
    for (const producer of boundSelectors) {
      expect(
        bound.entities.find(({ id }) => id === producer.entityId)?.configuration,
      ).toMatchObject({ mode: 'selector' });
    }
    expect(bound.networks).toEqual(before?.networks);
    expect(bound.entities.map(({ id }) => id)).toEqual(before?.entities.map(({ id }) => id));
    expect(bound.entities.map(({ placement }) => placement)).toEqual(
      before?.entities.map(({ placement }) => placement),
    );
    expect(bound.producers.map(({ id }) => id)).toEqual(before?.producers.map(({ id }) => id));
    expect(compilation.execution?.circuit.ir).toEqual(before);
    const artifact = sourceCompilationArtifact(compilation);
    expect(artifact).not.toHaveProperty('selectorTemplates');
    expect(artifact).not.toHaveProperty('execution');
    expect(artifact).not.toHaveProperty('elaborationJavaScript');
    expect(structuredClone(artifact)).toEqual(artifact);
    expect(JSON.stringify(generateBlueprintJson(bound))).not.toMatch(
      /Index|Selected signal|Count output|BlueprintParameter/,
    );
    expect(() =>
      bindSourceCompilationParameters(compilation, [
        { parameter: declarations[0]!.parameter, value: 1.5 },
      ]),
    ).toThrow();
    expect(() =>
      bindSourceCompilationParameters(compilation, [
        { parameter: declarations[1]!.parameter, value: 7 },
      ]),
    ).toThrow();
    expect(compilation.execution?.circuit.ir).toEqual(before);
  });

  test('materializes nested Decider branches and Selector modes through strict replay', () => {
    const compilation = compileSourceProgram(
      {
        path: 'paired-decider-selector.factorio.ts',
        text: `const A = Signal('virtual', 'signal-A');
const B = Signal('virtual', 'signal-B');
const C = Signal('virtual', 'signal-C');
const amount = Param.number('Threshold', 5);
const numberIndex = Param.number('Index', 2);
const signalIndex = Param.signal('Selected signal', B);
const countOutput = Param.signal('Count output', C);
const input = new Network();
const secondary = new Network();
const deciderOutput = new Network();
const selectorOutput = new Network();
const gate = Decider({
  condition: (input[A] > amount) && (input[B] <= 2 || input[A] != 0),
  outputs: [input[A], input[A], 4 * C],
  elseOutputs: [input[B], input[B]],
});
const byNumber = Selector({ input, operation: 'select', index: numberIndex }).at(2, 3);
const bySignal = Selector({
  input: pair(input, secondary),
  operation: 'select',
  selectMax: false,
  index: signalIndex,
});
const counted = Selector({ input, operation: 'count', output: countOutput });
deciderOutput += gate;
selectorOutput += byNumber;
selectorOutput += bySignal;
selectorOutput += counted;`,
      },
      parameterHost(),
    );
    expect(compilation.pipelineDiagnostics).toEqual([]);
    const declarations = listSourceCompilationParameters(compilation);
    const defaults = bindSourceCompilationCircuit(compilation);
    const overridden = bindSourceCompilationCircuit(compilation, [
      { parameter: declarations[0]!.parameter, value: 9 },
      { parameter: declarations[1]!.parameter, value: 7 },
      {
        parameter: declarations[2]!.parameter,
        value: { type: 'virtual', name: 'signal-D' },
      },
      {
        parameter: declarations[3]!.parameter,
        value: { type: 'virtual', name: 'signal-E' },
      },
    ]);
    const replay = executeResolvedDirectPlan(overridden.plan, overridden.resolvedCircuit);
    const decider = overridden.plan.producers.find(({ kind }) => kind === 'decider');
    const defaultDecider = defaults.plan.producers.find(({ kind }) => kind === 'decider');
    const selectors = overridden.plan.producers.filter(({ kind }) => kind === 'selector');

    expect(decider).toMatchObject({
      kind: 'decider',
      condition: {
        kind: 'and',
        conditions: [
          { kind: 'compare-signal', constant: 9 },
          {
            kind: 'or',
            conditions: [
              { kind: 'compare-signal', constant: 2 },
              { kind: 'compare-signal', constant: 0 },
            ],
          },
        ],
      },
      outputs: [
        { kind: 'signal', signal: { type: 'virtual', name: 'signal-A' } },
        { kind: 'signal', signal: { type: 'virtual', name: 'signal-A' } },
        { kind: 'signal-constant', signal: { type: 'virtual', name: 'signal-C' }, value: 4 },
      ],
      elseOutputs: [
        { kind: 'signal', signal: { type: 'virtual', name: 'signal-B' } },
        { kind: 'signal', signal: { type: 'virtual', name: 'signal-B' } },
      ],
    });
    if (decider?.kind !== 'decider') throw new Error('Expected a replayed Decider.');
    if (defaultDecider?.kind !== 'decider') throw new Error('Expected a default Decider.');
    expect(decider.output).toEqual(decider.outputs?.[0]);
    expect(decider.outputs?.[0]).toEqual(decider.outputs?.[1]);
    expect(decider.elseOutputs?.[0]).toEqual(decider.elseOutputs?.[1]);
    expect(decider.outputOrigins).toEqual(defaultDecider.outputOrigins);
    expect(decider.elseOutputOrigins).toEqual(defaultDecider.elseOutputOrigins);
    expect(selectors).toMatchObject([
      { operation: 'select', selectMax: true, index: 7 },
      {
        operation: 'select',
        selectMax: false,
        index: { type: 'virtual', name: 'signal-D' },
      },
      { operation: 'count', output: { type: 'virtual', name: 'signal-E' } },
    ]);

    for (const producer of overridden.plan.producers) {
      const matchingDebugEntries = replay.debug.scopes.flatMap(({ producers: entries }) =>
        entries.filter(({ descriptor }) =>
          producer.debugCaptureIds?.some((captureId) =>
            descriptor.debugCaptureIds?.includes(captureId),
          ),
        ),
      );
      expect(matchingDebugEntries).toHaveLength(1);
      expect(matchingDebugEntries[0]?.descriptor).toEqual(producer);
    }
    expect(overridden.resolvedCircuit.ir.producers.map(({ id }) => id)).toEqual(
      defaults.resolvedCircuit.ir.producers.map(({ id }) => id),
    );
    expect(overridden.resolvedCircuit.ir.entities.map(({ id }) => id)).toEqual(
      defaults.resolvedCircuit.ir.entities.map(({ id }) => id),
    );
    expect(generateBlueprintJson(overridden.resolvedCircuit.ir)).not.toEqual(
      generateBlueprintJson(defaults.resolvedCircuit.ir),
    );

    const simulateDecider = (pair: ReturnType<typeof bindSourceCompilationCircuit>) => {
      const execution = executeResolvedDirectPlan(pair.plan, pair.resolvedCircuit);
      return execution.circuit
        .createSimulation([
          {
            network: execution.network('input'),
            values: new SparseBus([
              [signal('virtual', 'signal-A'), 7],
              [signal('virtual', 'signal-B'), 3],
            ]),
          },
        ])
        .step()
        .read(execution.network('deciderOutput').id);
    };
    expect(simulateDecider(defaults).get(signal('virtual', 'signal-A'))).toBeGreaterThan(0);
    expect(simulateDecider(overridden).get(signal('virtual', 'signal-A'))).toBe(0);
    expect(simulateDecider(overridden).get(signal('virtual', 'signal-B'))).toBeGreaterThan(0);
  });

  test('keeps aggregate parameter pairs aligned across compilation, simulation, tests, and JSON', () => {
    let sourceExecutions = 0;
    const compilation = compileSourceProgram(
      {
        path: 'paired-aggregate-parameters.factorio.ts',
        text: `${source}
const secondary = new Network();
const selectorOutput = new Network();
const byNumber = Selector({ input, operation: 'select', index: amount });
const bySignal = Selector({
  input: pair(input, secondary),
  operation: 'select',
  selectMax: false,
  index: channel,
});
const counted = Selector({ input, operation: 'count', output: channel });
selectorOutput += byNumber;
selectorOutput += bySignal;
selectorOutput += counted;`,
      },
      parameterHost(),
      [],
      (stage) => {
        if (stage === 'execute') sourceExecutions += 1;
      },
    );
    expect(compilation.pipelineDiagnostics).toEqual([]);
    const declarations = listSourceCompilationParameters(compilation);
    const defaults = bindSourceCompilationCircuit(compilation);
    const overridden = bindSourceCompilationCircuit(compilation, [
      { parameter: declarations[0]!.parameter, value: 10 },
      {
        parameter: declarations[1]!.parameter,
        value: { type: 'virtual', name: 'signal-D' },
      },
    ]);
    const alternate = bindSourceCompilationCircuit(compilation, [
      { parameter: declarations[0]!.parameter, value: 7 },
      {
        parameter: declarations[1]!.parameter,
        value: { type: 'virtual', name: 'signal-E' },
      },
    ]);

    expect(overridden.plan.producers).toMatchObject([
      { kind: 'arithmetic', right: { kind: 'constant', value: 10 } },
      {
        kind: 'constant',
        configuration: {
          sections: [{ filters: [{ signal: { type: 'virtual', name: 'signal-D' }, value: 10 }] }],
        },
      },
      {
        kind: 'decider',
        condition: { kind: 'compare-signal', constant: 10 },
      },
      { kind: 'selector', operation: 'select', index: 10 },
      {
        kind: 'selector',
        operation: 'select',
        index: { type: 'virtual', name: 'signal-D' },
      },
      { kind: 'selector', operation: 'count', output: { type: 'virtual', name: 'signal-D' } },
    ]);
    expect(alternate.plan.producers.find(({ kind }) => kind === 'arithmetic')).toMatchObject({
      right: { kind: 'constant', value: 7 },
    });
    expect(alternate.plan.producers[0]).not.toEqual(overridden.plan.producers[0]);
    expect(overridden.resolvedCircuit.ir.producers.map(({ id }) => id)).toEqual(
      defaults.resolvedCircuit.ir.producers.map(({ id }) => id),
    );

    const runModel = (pair: ReturnType<typeof bindSourceCompilationCircuit>) => {
      const replay = executeResolvedDirectPlan(pair.plan, pair.resolvedCircuit);
      const simulationRun = replay.circuit.createSimulation();
      simulationRun.step();
      simulationRun.step();
      const simulation = simulationRun.step();
      const session = replay.createTestSession();
      session.tick(3);
      return {
        simulation: simulation.read(replay.network('output').id),
        testSession: session.read(replay.network('output')),
        replay,
      };
    };
    const defaultModel = runModel(defaults);
    const overriddenModel = runModel(overridden);
    expect(defaultModel.simulation.toJSON()).toEqual(defaultModel.testSession.toJSON());
    expect(overriddenModel.simulation.toJSON()).toEqual(overriddenModel.testSession.toJSON());
    expect(defaultModel.simulation.get(signal('virtual', 'signal-B'))).toBe(5);
    expect(overriddenModel.simulation.get(signal('virtual', 'signal-B'))).toBe(10);
    expect(overriddenModel.simulation.get(signal('virtual', 'signal-D'))).toBe(10);

    const blueprintEntities = (pair: ReturnType<typeof bindSourceCompilationCircuit>) =>
      generateBlueprintJson(pair.resolvedCircuit.ir).blueprint.entities;
    const arithmeticConditions = (
      entities: ReturnType<typeof blueprintEntities>,
    ): Record<string, unknown> => {
      const matches = entities.filter(({ name }) => name === 'arithmetic-combinator');
      expect(matches).toHaveLength(1);
      return (matches[0]!.control_behavior as { arithmetic_conditions: Record<string, unknown> })
        .arithmetic_conditions;
    };
    const constantFilters = (
      entities: ReturnType<typeof blueprintEntities>,
    ): Record<string, unknown>[] => {
      const matches = entities.filter(({ name }) => name === 'constant-combinator');
      expect(matches).toHaveLength(1);
      return (
        matches[0]!.control_behavior as {
          sections: { sections: { filters: Record<string, unknown>[] }[] };
        }
      ).sections.sections[0]!.filters;
    };
    expect(arithmeticConditions(blueprintEntities(defaults))).toMatchObject({
      first_signal: { type: 'virtual', name: 'signal-A' },
      operation: '+',
      second_constant: 5,
      output_signal: { type: 'virtual', name: 'signal-B' },
    });
    expect(arithmeticConditions(blueprintEntities(overridden))).toMatchObject({
      first_signal: { type: 'virtual', name: 'signal-A' },
      operation: '+',
      second_constant: 10,
      output_signal: { type: 'virtual', name: 'signal-B' },
    });
    expect(constantFilters(blueprintEntities(defaults))).toEqual([
      {
        index: 1,
        name: 'signal-C',
        type: 'virtual',
        quality: 'normal',
        comparator: '=',
        count: 5,
      },
    ]);
    expect(constantFilters(blueprintEntities(overridden))).toEqual([
      {
        index: 1,
        name: 'signal-D',
        type: 'virtual',
        quality: 'normal',
        comparator: '=',
        count: 10,
      },
    ]);
    expect(generateBlueprintJson(overridden.resolvedCircuit.ir)).toEqual(
      generateBlueprintJson(overriddenModel.replay.circuit.ir),
    );
    expectConcreteDataTree(defaults);
    expectConcreteDataTree(overridden);
    expect(structuredClone(overridden)).toEqual(overridden);
    expect(() =>
      bindSourceCompilationCircuit(compilation, [
        { parameter: declarations[0]!.parameter, value: 1.5 },
      ]),
    ).toThrow();
    expect(compilation.execution?.circuit.ir).toEqual(compilation.resolvedCircuit?.ir);
    expect(sourceExecutions).toBe(1);
  });

  test('rejects missing and duplicate physical Selector capture assignments', () => {
    const compilation = compileSourceProgram(
      {
        path: 'selector-capture-assignment.factorio.ts',
        text: `const index = Param.number('Index', 1);
const input = new Network();
const output = new Network();
const selector = Selector({ input, operation: 'select', index });
output += selector;`,
      },
      parameterHost(),
    );
    const execution = compilation.execution;
    const producer = execution?.circuit.ir.producers.find(({ kind }) => kind === 'selector');
    const planSelector = compilation.plan?.producers.find(({ kind }) => kind === 'selector');
    const captureId = planSelector?.debugCaptureIds?.[0];
    if (execution === undefined || producer?.kind !== 'selector' || captureId === undefined) {
      throw new Error('Expected a captured exact Selector Producer.');
    }
    const session = createBlueprintParameterSession();
    const parameter = session.number('Index', { defaultValue: 0 });
    const template = createSelectorConfigurationTemplate(session, {
      operation: 'select',
      input: producer.config.input,
      selectMax: true,
      index: parameter,
    });
    const capture = createExecutedProducerCaptureReference(execution, captureId);
    const missingSet = createBlueprintConfigurationSet(session, [
      { key: 'selector', kind: 'selector', template },
    ]);
    expect(() => bindExecutedPlanConfigurationSet(execution, missingSet, [])).toThrow(
      'missing Producer capture assignment',
    );

    const duplicateSet = createBlueprintConfigurationSet(session, [
      { key: 'selector-a', kind: 'selector', template },
      { key: 'selector-b', kind: 'selector', template },
    ]);
    expect(() =>
      bindExecutedPlanConfigurationSet(execution, duplicateSet, [
        { key: 'selector-a', captureId: capture },
        { key: 'selector-b', captureId: capture },
      ]),
    ).toThrow('Producer capture');
  });

  test('preserves parameter-free Selector defaults and reports wrong slot kinds at the value span', () => {
    const parameterFreeSource = {
      path: 'parameter-free-selector.factorio.ts',
      text: `const input = new Network();
const output = new Network();
const selected = Selector({ input, operation: 'select' });
output += selected;`,
    };
    const parameterFree = compileSourceProgram(parameterFreeSource, parameterHost());
    const directPlan = canonicalDirectPlan(
      executeElaborationProgram(transformElaborationModule(parseFile(parameterFreeSource)), {
        trustedEntityReplayContext: parameterHost().trustedEntityReplayContext,
        entityPrototypeResolver: parameterHost().entityPrototypeResolver,
      }),
    );
    expect(parameterFree.pipelineDiagnostics).toEqual([]);
    expect(listSourceCompilationParameters(parameterFree)).toEqual([]);
    expect(parameterFree.plan).toEqual(directPlan);
    expect(parameterFree.plan?.producers).toMatchObject([
      { kind: 'selector', operation: 'select', selectMax: true, index: 0 },
    ]);

    const wrongSlotSource = `const numberParameter = Param.number('Not a signal', 4);
const input = new Network();
Selector({ input, operation: 'count', output: numberParameter });`;
    const wrongSlot = compileSourceProgram(
      { path: 'selector-wrong-parameter-kind.factorio.ts', text: wrongSlotSource },
      parameterHost(),
    );
    expect(wrongSlot.pipelineDiagnostics).toEqual([
      expect.objectContaining({
        severity: 'error',
        span: expect.objectContaining({ start: wrongSlotSource.lastIndexOf('numberParameter') }),
      }),
    ]);

    const symbolicMaxSource = `const max = Param.signal('Max', Signal('virtual', 'signal-max'));
const input = new Network();
Selector({ input, operation: 'select', selectMax: max, index: 0 });`;
    const symbolicMax = compileSourceProgram(
      { path: 'selector-symbolic-max.factorio.ts', text: symbolicMaxSource },
      parameterHost(),
    );
    expect(symbolicMax.pipelineDiagnostics).toEqual([
      expect.objectContaining({
        severity: 'error',
        span: expect.objectContaining({ start: symbolicMaxSource.lastIndexOf('max') }),
      }),
    ]);
  });

  test('rejects foreign and forged handles in exact Selector parameter slots', () => {
    const foreignKey = Symbol.for('comblang.test.foreign-selector-parameter');
    const forgedKey = Symbol.for('comblang.test.forged-selector-parameter');
    const globalRecord = globalThis as Record<PropertyKey, unknown>;
    const previous = new Map<PropertyKey, { readonly had: boolean; readonly value: unknown }>([
      [
        foreignKey,
        { had: Object.hasOwn(globalRecord, foreignKey), value: globalRecord[foreignKey] },
      ],
      [forgedKey, { had: Object.hasOwn(globalRecord, forgedKey), value: globalRecord[forgedKey] }],
    ]);
    globalRecord[foreignKey] = createBlueprintParameterSession().number('foreign', {
      defaultValue: 5,
    });
    globalRecord[forgedKey] = { kind: 'number', label: 'forged', defaultValue: 5 };
    try {
      for (const [key, message] of [
        ['comblang.test.foreign-selector-parameter', 'different parameter session'],
        ['comblang.test.forged-selector-parameter', 'unregistered parameter-like object'],
      ] as const) {
        const text = `const local = Param.number('Local', 1);
const input = new Network();
Selector({ input, operation: 'select', index: globalThis[Symbol.for('${key}')] });`;
        const compilation = compileSourceProgram(
          { path: 'selector-foreign-parameter.factorio.ts', text },
          parameterHost(),
        );
        expect(compilation.pipelineDiagnostics).toEqual([
          expect.objectContaining({
            code: 'RT2027',
            message: expect.stringContaining(message),
            span: expect.objectContaining({ start: text.lastIndexOf('globalThis') }),
          }),
        ]);
      }
    } finally {
      for (const [key, value] of previous) {
        if (value.had) globalRecord[key] = value.value;
        else delete globalRecord[key];
      }
    }
  });

  test('maps captured Selector templates by stable IDs after Plan producer reordering', () => {
    const environment = parameterHost();
    const program = transformElaborationModule(
      parseFile({
        path: 'selector-reordered-plan-captures.factorio.ts',
        text: `const firstIndex = Param.number('First index', 1);
const secondIndex = Param.number('Second index', 2);
const inputA = new Network();
const inputB = new Network();
const outputA = new Network();
const outputB = new Network();
outputA += Selector({ input: inputA, operation: 'select', index: firstIndex });
outputB += Selector({ input: inputB, operation: 'select', index: secondIndex });`,
      }),
      { testContextName: 't' },
    );
    const dynamic = executeElaborationProgramWithParameters(program, environment);
    expect(dynamic.selectorTemplates).toHaveLength(2);
    const captureValues = new Map([
      [dynamic.selectorTemplates[0]!.captureId, 8],
      [dynamic.selectorTemplates[1]!.captureId, 13],
    ]);
    const reorderedPlan = {
      ...dynamic.plan,
      producers: [...dynamic.plan.producers].reverse(),
    };
    const reordered = { ...dynamic, plan: reorderedPlan };
    const lowered = tryElaborateDirectPlan(reorderedPlan, environment.trustedEntityReplayContext);
    expect(lowered.diagnostics).toEqual([]);

    const bound = bindCapturedSourceConfigurationTemplates(reordered, lowered.execution!, [
      { parameter: dynamic.parameters[0]!.handle, value: 8 },
      { parameter: dynamic.parameters[1]!.handle, value: 13 },
    ]);
    const physicalCaptures = lowered.execution!.debug.scopes.flatMap((scope) => scope.producers);
    for (const physical of physicalCaptures) {
      const captureId = physical.descriptor.debugCaptureIds?.find((id) => captureValues.has(id));
      if (captureId === undefined) throw new Error('Expected a captured Selector producer.');
      expect(bound.producers.find(({ id }) => id === physical.id)).toMatchObject({
        kind: 'selector',
        config: { index: captureValues.get(captureId) },
      });
    }
  });

  test('rejects a capture ID shared by distinct Plan producers during lowering', () => {
    const environment = parameterHost();
    const program = transformElaborationModule(
      parseFile({
        path: 'selector-duplicate-plan-capture.factorio.ts',
        text: `const firstIndex = Param.number('First index', 1);
const secondIndex = Param.number('Second index', 2);
const inputA = new Network();
const inputB = new Network();
const outputA = new Network();
const outputB = new Network();
outputA += Selector({ input: inputA, operation: 'select', index: firstIndex });
outputB += Selector({ input: inputB, operation: 'select', index: secondIndex });`,
      }),
      { testContextName: 't' },
    );
    const dynamic = executeElaborationProgramWithParameters(program, environment);
    const duplicateId = dynamic.plan.producers[0]!.debugCaptureIds![0]!;
    const duplicatePlan = {
      ...dynamic.plan,
      producers: dynamic.plan.producers.map((producer, index) =>
        index === 1 ? { ...producer, debugCaptureIds: [duplicateId] } : producer,
      ),
    };
    const lowered = tryElaborateDirectPlan(duplicatePlan, environment.trustedEntityReplayContext);
    expect(lowered.diagnostics).toEqual([
      expect.objectContaining({
        code: 'RT1001',
        message: expect.stringContaining('$.producers[1].debugCaptureIds[0]'),
      }),
    ]);
  });

  test('rejects duplicate Plan and linked Entity materialization targets atomically', () => {
    const environment = parameterHost();
    const program = transformElaborationModule(
      parseFile({
        path: 'selector-duplicate-materialization-targets.factorio.ts',
        text: `const firstIndex = Param.number('First index', 1);
const secondIndex = Param.number('Second index', 2);
const inputA = new Network();
const inputB = new Network();
const outputA = new Network();
const outputB = new Network();
outputA += Selector({ input: inputA, operation: 'select', index: firstIndex });
outputB += Selector({ input: inputB, operation: 'select', index: secondIndex });`,
      }),
      { testContextName: 't' },
    );
    const dynamic = executeElaborationProgramWithParameters(program, environment);
    const lowered = tryElaborateDirectPlan(dynamic.plan, environment.trustedEntityReplayContext);
    expect(lowered.diagnostics).toEqual([]);
    const bound = bindCapturedSourceConfigurationTemplatesWithRelations(
      dynamic,
      lowered.execution!,
    );
    expect(bound.captureRelations).toHaveLength(2);
    const [first, second] = bound.captureRelations;
    if (first === undefined || second === undefined) {
      throw new Error('Expected two validated Selector capture relations.');
    }
    const originalPlan = structuredClone(dynamic.plan);
    const originalCircuit = structuredClone(bound.circuit);

    expect(() => materializeCapturedPlan(dynamic.plan, [first, first], bound.circuit)).toThrow(
      'Captured configuration no longer matches its Direct Plan producer.',
    );

    const firstEntityId = dynamic.plan.producers[first.planIndex]?.entityId;
    const secondEntityId = dynamic.plan.producers[second.planIndex]?.entityId;
    if (firstEntityId === undefined || secondEntityId === undefined) {
      throw new Error('Expected linked physical Entities for both Selector producers.');
    }
    expect(firstEntityId).not.toBe(secondEntityId);
    const duplicateEntityPlan = {
      ...dynamic.plan,
      producers: dynamic.plan.producers.map((producer, index) =>
        index === second.planIndex ? { ...producer, entityId: firstEntityId } : producer,
      ),
    };
    expect(() =>
      materializeCapturedPlan(duplicateEntityPlan, [first, second], bound.circuit),
    ).toThrow('Captured configuration no longer matches its Direct Plan producer.');
    expect(dynamic.plan).toEqual(originalPlan);
    expect(bound.circuit).toEqual(originalCircuit);
  });

  test('captures repeated physical Selectors and rolls back templates with failed instances', () => {
    const environment = parameterHost();
    const source = `const index = Param.number('Index', 1);
const inputA = new Network();
const inputB = new Network();
function Gate(input: Network) {
  const selector = Selector({ input, operation: 'select', index });
  const sink = new Network();
  sink += selector;
  return selector;
}
const first = t.instantiate(Gate, inputA);
const second = t.instantiate(Gate, inputB);
const outputA = new Network();
const outputB = new Network();
outputA += first.value;
outputB += second.value;`;
    const parsed = parseFile({ path: 'selector-capture-rollback.factorio.ts', text: source });
    const program = transformElaborationModule(parsed, { testContextName: 't' });
    const dynamic = executeElaborationProgramWithParameters(program, environment);

    expect(dynamic.plan.producers.filter(({ kind }) => kind === 'selector')).toHaveLength(2);
    expect(dynamic.plan.entities).toHaveLength(2);
    expect(dynamic.selectorTemplates).toHaveLength(2);
    expect(new Set(dynamic.selectorTemplates.map(({ captureId }) => captureId)).size).toBe(2);
    const lowered = tryElaborateDirectPlan(dynamic.plan, environment.trustedEntityReplayContext);
    expect(lowered.diagnostics).toEqual([]);
    const bound = bindCapturedSourceConfigurationTemplates(dynamic, lowered.execution!, [
      { parameter: dynamic.parameters[0]!.handle, value: 8 },
    ]);
    expect(
      bound.producers.filter(({ kind }) => kind === 'selector').map(({ config }) => config),
    ).toMatchObject([
      { operation: 'select', index: 8 },
      { operation: 'select', index: 8 },
    ]);
    const missingCapture = {
      ...dynamic,
      selectorTemplates: dynamic.selectorTemplates.map((entry) => ({
        ...entry,
        captureId: 'missing-selector-capture',
      })),
    };
    expect(() =>
      bindCapturedSourceConfigurationTemplates(missingCapture, lowered.execution!),
    ).toThrow('capture must identify exactly one source Selector Producer');
    const duplicateCapture = {
      ...dynamic,
      selectorTemplates: [...dynamic.selectorTemplates, dynamic.selectorTemplates[0]!],
    };
    expect(() =>
      bindCapturedSourceConfigurationTemplates(duplicateCapture, lowered.execution!),
    ).toThrow('Selector capture IDs must be unique');

    const rollbackSource = `const index = Param.number('Index', 1);
function Broken(input: Network) {
  const selector = Selector({ input, operation: 'select', index });
  const sink = new Network();
  sink += selector;
  const invalid: unknown = 1;
  Selector(invalid);
}
const input = new Network();
try { t.instantiate(Broken, input); } catch {}
const selector = Selector({ input, operation: 'select', index });
const output = new Network();
output += selector;`;
    const rollbackProgram = transformElaborationModule(
      parseFile({ path: 'selector-failed-instance.factorio.ts', text: rollbackSource }),
      { testContextName: 't' },
    );
    const rolledBack = executeElaborationProgramWithParameters(rollbackProgram, environment);
    expect(rolledBack.plan.producers.filter(({ kind }) => kind === 'selector')).toHaveLength(1);
    expect(rolledBack.plan.entities).toHaveLength(1);
    expect(rolledBack.plan.debugInstances).toEqual([]);
    expect(rolledBack.selectorTemplates).toHaveLength(1);
    expect(rolledBack.selectorTemplates[0]?.captureId).toBe(
      rolledBack.plan.producers[0]?.debugCaptureIds?.[0],
    );
  });

  test('binds Selector parameters alongside Arithmetic, Constant, and Decider captures', () => {
    const text = `${source}\nconst selector = Selector({ input, operation: 'select', index: amount });\noutput += selector;`;
    const compilation = compileSourceProgram(
      { path: 'mixed-source-configuration-parameters.factorio.ts', text },
      parameterHost(),
    );
    expect(compilation.pipelineDiagnostics).toEqual([]);
    expect(compilation.plan?.producers.map(({ kind }) => kind)).toEqual([
      'arithmetic',
      'constant',
      'decider',
      'selector',
    ]);

    const declarations = listSourceCompilationParameters(compilation);
    const original = compilation.execution?.circuit.ir;
    const bound = bindSourceCompilationParameters(compilation, [
      { parameter: declarations[0]!.parameter, value: 9 },
      {
        parameter: declarations[1]!.parameter,
        value: { type: 'virtual', name: 'signal-D' },
      },
    ]);
    expect(bound.producers.find(({ kind }) => kind === 'selector')).toMatchObject({
      kind: 'selector',
      config: { operation: 'select', index: 9 },
    });
    expect(bound.networks).toEqual(original?.networks);
    expect(bound.entities.map(({ id }) => id)).toEqual(original?.entities.map(({ id }) => id));
    expect(bound.producers.map(({ id }) => id)).toEqual(original?.producers.map(({ id }) => id));
    expect(compilation.execution?.circuit.ir).toEqual(original);
    const artifact = sourceCompilationArtifact(compilation);
    expect(artifact).not.toHaveProperty('selectorTemplates');
    expect(JSON.stringify(bound)).not.toContain('Amount');
    expect(JSON.stringify(bound)).not.toContain('Selected signal');
  });

  test('rejects source parameter property and reflection escapes while retaining host metadata', () => {
    const reads = [
      'amount.defaultValue;',
      'const alias = amount; alias.label;',
      'amount?.kind;',
      "amount['source'];",
      'const { defaultValue } = amount;',
      "const key = 'label'; amount[key];",
      'Object.keys(amount);',
      'Reflect.ownKeys(amount);',
      "Object.getOwnPropertyDescriptor(amount, 'label');",
      '({ ...amount });',
      'JSON.stringify(amount);',
      'if (amount.defaultValue) {}',
    ];

    for (const read of reads) {
      const text = `const amount = Param.number('Amount', 5);\n${read}`;
      const declarationStart = text.indexOf('Param.number');
      const declarationEnd = text.indexOf(');') + 1;
      const compilation = compileSourceProgram({
        path: 'parameter-property-escape.factorio.ts',
        text,
      });

      expect(compilation.pipelineDiagnostics, read).toHaveLength(1);
      const [diagnostic] = compilation.pipelineDiagnostics;
      expect(diagnostic?.severity).toBe('error');
      expect(['CP1001', 'RT2029']).toContain(diagnostic?.code);
      expect(diagnostic?.span).toBeDefined();
      expect([declarationStart, text.indexOf(read)]).toContain(diagnostic?.span?.start);
    }

    const hostCompilation = compileSourceProgram({
      path: 'parameter-host-metadata.factorio.ts',
      text: `const amount = Param.number('Amount', 5);
const ordinary = { label: 'ordinary' };
ordinary.label;`,
    });
    expect(hostCompilation.pipelineDiagnostics).toEqual([]);
    expect(listSourceCompilationParameters(hostCompilation)).toMatchObject([
      { kind: 'number', label: 'Amount', defaultValue: 5 },
    ]);
  });
});

import { describe, expect, test } from 'vitest';
import { transformElaborationModule } from '@comblang/compiler';
import { generateBlueprintJson } from '@comblang/compiler/blueprint-json';
import type { EntityProfile } from '@comblang/compiler/entity';
import { syntheticZeroPortEntityProfile } from '@comblang/compiler/entity-fixtures';
import { createTrustedEntityReplayContext } from '@comblang/compiler/entity-replay-context';
import type { DirectElaborationPlan } from '@comblang/compiler/direct-plan-schema';
import {
  resolvedCircuitPlanFingerprint,
  validateResolvedCircuit,
  type ResolvedCircuit,
} from '@comblang/compiler/resolved-circuit';
import { parseFile } from '@comblang/language';
import { executeResolvedDirectPlan, tryElaborateDirectPlan } from '@comblang/runtime';
import {
  bindSourceCompilationCircuit,
  compileSourceProgram,
  listSourceCompilationParameters,
} from '@comblang/runtime/source-compilation';
import { signal } from '@comblang/factorio';
import type { EntityPrototype } from '@comblang/prototypes';
import { executeElaborationProgramWithParameters } from '../../../packages/runtime/src/elaboration-program.js';

import { createSourceCircuitArtifact } from './source-circuit-artifact.js';
import { blueprintJsonForArtifact } from './blueprint-demo.js';
import { SourceSimulationController } from './source-demo.js';
import { runWebTests } from './web-test-runner.js';

function exactArithmeticEnvironment() {
  const profile: EntityProfile = {
    ...structuredClone(syntheticZeroPortEntityProfile),
    ref: {
      ...syntheticZeroPortEntityProfile.ref,
      prototypeKey: 'entity:arithmetic-combinator',
      profileId: 'profile:source-artifact-arithmetic' as EntityProfile['ref']['profileId'],
    },
    prototypeType: 'arithmetic-combinator',
  };
  const context = createTrustedEntityReplayContext({
    database: profile.ref.database,
    source: 'synthetic',
    evidenceIdentity: 'source-artifact-arithmetic-evidence',
    policyIdentity: 'source-artifact-arithmetic-policy',
    profiles: [profile],
  });
  const prototype: EntityPrototype = {
    key: 'entity:arithmetic-combinator' as EntityPrototype['key'],
    name: 'arithmetic-combinator',
    type: 'arithmetic-combinator',
    tileWidth: 1,
    tileHeight: 1,
  };
  return {
    context,
    entityPrototypeResolver: {
      database: context.database,
      getEntity(nameOrKey: string): EntityPrototype | undefined {
        return nameOrKey === prototype.key || nameOrKey === prototype.name ? prototype : undefined;
      },
    },
  };
}

describe('canonical source circuit artifact', () => {
  test.each(['arithmetic', 'decider', 'constant'] as const)(
    'rejects a correctly fingerprinted pair with a mismatched %s Producer',
    (kind) => {
      const compilation = compileSourceProgram({
        path: 'canonical-mismatched-producer.factorio.ts',
        text: `const A = Signal('virtual', 'signal-A');
const input = new Network();
const output = new Network();
output += input + 1;
output += when(input[A] > 0).then(input[A]);
output += CC(2 * A);`,
      });
      expect(compilation.pipelineDiagnostics).toEqual([]);
      if (compilation.plan === undefined || compilation.resolvedCircuit === undefined)
        throw new Error('Expected a canonical pair.');
      const { plan, resolvedCircuit } = compilation;
      const producers = resolvedCircuit.ir.producers.map((producer) => {
        if (producer.kind !== kind) return producer;
        switch (producer.kind) {
          case 'arithmetic':
            return {
              ...producer,
              config: { ...producer.config, right: { kind: 'constant' as const, value: 99 } },
            };
          case 'decider':
            if (producer.config.condition.kind !== 'compare')
              throw new Error('Expected a comparison.');
            return {
              ...producer,
              config: {
                ...producer.config,
                condition: {
                  ...producer.config.condition,
                  right: { kind: 'constant' as const, value: 99 },
                },
              },
            };
          case 'constant':
            if (producer.config.outputs === undefined)
              throw new Error('Expected legacy Constant rows.');
            return {
              ...producer,
              config: { outputs: producer.config.outputs.map((row) => ({ ...row, value: 99 })) },
            };
        }
      });
      const mismatched: ResolvedCircuit = {
        ...resolvedCircuit,
        planFingerprint: resolvedCircuitPlanFingerprint(plan),
        ir: { ...resolvedCircuit.ir, producers },
      };
      expect(validateResolvedCircuit(mismatched).diagnostics).toEqual([]);
      expect(() => executeResolvedDirectPlan(plan, mismatched)).toThrow(/Producer .* differs/i);
      expect(() => createSourceCircuitArtifact(plan, mismatched)).toThrowError(
        expect.objectContaining({
          diagnostic: expect.objectContaining({
            code: 'RT1001',
            message: expect.stringMatching(/Producer .* differs/i),
          }),
        }),
      );
      expect(runWebTests(plan, "test('unreachable', () => {});", mismatched)).toMatchObject({
        passed: 0,
        failed: 1,
        results: [
          { failureKind: 'runtime', message: expect.stringMatching(/Producer .* differs/i) },
        ],
      });
    },
  );

  test('rejects a correctly fingerprinted mismatch linked to an Arithmetic Entity', () => {
    const environment = exactArithmeticEnvironment();
    const compilation = compileSourceProgram(
      {
        path: 'canonical-mismatched-entity.factorio.ts',
        text: `const A = Signal('virtual', 'signal-A');
const output = new Network();
output += Arithmetic({ left: 2, operation: 'add', right: 4, output: A });`,
      },
      {
        trustedEntityReplayContext: environment.context,
        entityPrototypeResolver: environment.entityPrototypeResolver,
      },
    );
    expect(compilation.pipelineDiagnostics).toEqual([]);
    if (compilation.plan === undefined || compilation.resolvedCircuit === undefined)
      throw new Error('Expected a linked Arithmetic pair.');
    const plan: DirectElaborationPlan = {
      ...compilation.plan,
      producers: compilation.plan.producers.map((producer) =>
        producer.kind === 'arithmetic'
          ? { ...producer, right: { kind: 'constant', value: 9 } }
          : producer,
      ),
      entities: compilation.plan.entities.map((entity) =>
        entity.configuration?.mode === 'arithmetic'
          ? {
              ...entity,
              configuration: { ...entity.configuration, right: { kind: 'constant', value: 9 } },
            }
          : entity,
      ),
    };
    const mismatched: ResolvedCircuit = {
      ...compilation.resolvedCircuit,
      planFingerprint: resolvedCircuitPlanFingerprint(plan),
    };
    expect(validateResolvedCircuit(mismatched).diagnostics).toEqual([]);
    expect(() => executeResolvedDirectPlan(plan, mismatched)).toThrow(/Producer .* differs/i);
    expect(() => createSourceCircuitArtifact(plan, mismatched)).toThrowError(
      expect.objectContaining({
        diagnostic: expect.objectContaining({
          code: 'RT1001',
          message: expect.stringMatching(/Producer .* differs/i),
        }),
      }),
    );
    expect(runWebTests(plan, "test('unreachable', () => {});", mismatched)).toMatchObject({
      passed: 0,
      failed: 1,
      results: [{ failureKind: 'runtime', message: expect.stringMatching(/Producer .* differs/i) }],
    });
  });

  test('hydrates a canonical entity-free compilation for preview and simulation', () => {
    const compilation = compileSourceProgram({
      path: 'canonical-artifact.factorio.ts',
      text: `const A = Signal('virtual', 'signal-A');
const input = new Network();
const output = new Network();
const constant: ConstantCombinator = CC(2 * A);
output += constant;`,
    });
    expect(compilation.pipelineDiagnostics).toEqual([]);
    expect(compilation.plan).toBeDefined();
    expect(compilation.resolvedCircuit).toBeDefined();

    const pair = { plan: compilation.plan!, resolvedCircuit: compilation.resolvedCircuit! };
    const artifact = createSourceCircuitArtifact(pair.plan, pair.resolvedCircuit);
    expect(artifact.resolvedCircuit.format).toBe('comblang-resolved-circuit');
    expect(Object.hasOwn(artifact.resolvedCircuit.ir, 'version')).toBe(false);
    expect(artifact.blueprint.blueprint.entities).toHaveLength(1);
    expect(() => artifact.execution.circuit.createSimulation().step()).not.toThrow();
    expect(createSourceCircuitArtifact(pair.plan).blueprint).toEqual(artifact.blueprint);
    expect(blueprintJsonForArtifact(artifact)).toEqual(
      generateBlueprintJson(pair.resolvedCircuit.ir),
    );
    expect(
      runWebTests(
        pair.plan,
        `const A = Signal('virtual', 'signal-A');
test('entity-free pair', ({ network, expectSignal, tick }) => {
  tick();
  expectSignal(network('output'), A).toBe(2);
});`,
        pair.resolvedCircuit,
      ),
    ).toMatchObject({ passed: 1, failed: 0 });
  });

  test('shares default, override, and reset pairs across preview, tests, and blueprint consumers', () => {
    const environment = exactArithmeticEnvironment();
    let sourceExecutions = 0;
    const compilation = compileSourceProgram(
      {
        path: 'canonical-bound-consumers.factorio.ts',
        text: `const A = Signal('virtual', 'signal-A');
const amount = Param.number('Amount', 4);
const output = new Network();
const outputAlias = output;
output += Arithmetic({ left: 2, operation: 'add', right: amount, output: A });`,
      },
      {
        trustedEntityReplayContext: environment.context,
        entityPrototypeResolver: environment.entityPrototypeResolver,
      },
      [],
      (stage) => {
        if (stage === 'execute') sourceExecutions += 1;
      },
    );
    expect(compilation.pipelineDiagnostics).toEqual([]);
    const before = structuredClone({
      plan: compilation.plan,
      resolvedCircuit: compilation.resolvedCircuit,
    });
    const parameter = listSourceCompilationParameters(compilation)[0]!.parameter;
    const defaults = bindSourceCompilationCircuit(compilation);
    const overridden = bindSourceCompilationCircuit(compilation, [{ parameter, value: 9 }]);
    const reset = bindSourceCompilationCircuit(compilation, []);
    expect(reset).toEqual(defaults);

    for (const [pair, amount] of [
      [defaults, 4],
      [overridden, 9],
      [reset, 4],
    ] as const) {
      const artifact = createSourceCircuitArtifact(pair.plan, pair.resolvedCircuit);
      expect(artifact.plan.entities).toHaveLength(1);
      const output = artifact.execution.network('output');
      expect(artifact.execution.network('outputAlias')).toBe(output);
      expect(artifact.execution.network(output.id)).toBe(output);
      expect(artifact.execution.debug.scopes.flatMap((scope) => scope.networks)).toContainEqual(
        expect.objectContaining({ planName: 'output', id: output.id }),
      );
      const preview = new SourceSimulationController(artifact);
      preview.stepFrom(0, 1);
      expect(preview.signalValueAt(1, 'output', signal('virtual', 'signal-A'))).toBe(2 + amount);
      const blueprint = blueprintJsonForArtifact(artifact);
      expect(blueprint).toEqual(generateBlueprintJson(pair.resolvedCircuit.ir));
      expect(blueprint.blueprint.entities[0]!.control_behavior).toMatchObject({
        arithmetic_conditions: {
          first_constant: 2,
          second_constant: amount,
          output_signal: { type: 'virtual', name: 'signal-A' },
        },
      });
      expect(
        runWebTests(
          pair.plan,
          `const A = Signal('virtual', 'signal-A');
test('concrete bound value', ({ network, expectSignal, tick }) => {
  tick();
  expectSignal(network('outputAlias'), A).toBe(${2 + amount});
});`,
          pair.resolvedCircuit,
        ),
      ).toMatchObject({ passed: 1, failed: 0 });
    }
    const replay = executeResolvedDirectPlan(defaults.plan, defaults.resolvedCircuit);
    expect(() => replay.network(defaults.resolvedCircuit.ir.networks[0]!.id)).toThrow(
      /Unknown Network/i,
    );
    expect({ plan: compilation.plan, resolvedCircuit: compilation.resolvedCircuit }).toEqual(
      before,
    );
    expect(sourceExecutions).toBe(1);
  });

  test('keeps host-local Arithmetic templates out of the serialized source artifact', () => {
    const environment = exactArithmeticEnvironment();
    const parsed = parseFile({
      path: 'canonical-template-artifact.factorio.ts',
      text: `
const A = Signal('virtual', 'signal-A');
function Add() {
  const exact = Arithmetic({ left: 2, operation: 'add', right: amount, output: A });
  const sink = new Network();
  sink += exact;
  return exact;
}
const dut = t.instantiate(Add);`,
    });
    const transformed = transformElaborationModule(parsed, { testContextName: 't' });
    const prepared = executeElaborationProgramWithParameters(
      {
        ...transformed,
        code: `const amount = ${transformed.runtimeParameter}.declareBlueprintNumberParameter(
  'amount', 4, undefined, { start: 0, end: 1 }
);\n${transformed.code}`,
      },
      {
        trustedEntityReplayContext: environment.context,
        entityPrototypeResolver: environment.entityPrototypeResolver,
      },
    );
    const lowered = tryElaborateDirectPlan(prepared.plan, environment.context);
    if (lowered.resolvedCircuit === undefined) {
      throw new Error('Expected a canonical resolved circuit for source artifact creation.');
    }
    const artifact = createSourceCircuitArtifact(prepared.plan, lowered.resolvedCircuit);

    expect(prepared.arithmeticTemplates).toHaveLength(1);
    expect(artifact.plan.producers[0]).toMatchObject({
      right: { kind: 'constant', value: 4 },
    });
    expect(artifact.plan).not.toHaveProperty('arithmeticTemplates');
    expect(JSON.stringify(artifact)).not.toContain('amount');
    expect(JSON.stringify(artifact)).not.toContain('arithmeticTemplates');
  });

  test('rejects stale canonical resolved data before preview hydration', () => {
    const compilation = compileSourceProgram({
      path: 'canonical-stale-artifact.factorio.ts',
      text: `const A = Signal('virtual', 'signal-A');
const output = new Network();
output += CC(2 * A);`,
    });
    if (compilation.plan === undefined || compilation.resolvedCircuit === undefined)
      throw new Error('Expected a canonical compilation artifact.');

    const stale = {
      ...compilation.resolvedCircuit,
      planFingerprint: 'plan-fnv1a64:0000000000000000',
    } as ResolvedCircuit;
    expect(() =>
      createSourceCircuitArtifact(compilation.plan as DirectElaborationPlan, stale),
    ).toThrowError(
      expect.objectContaining({
        diagnostic: expect.objectContaining({
          code: 'RT1001',
          message: expect.stringMatching(/fingerprint.*stale/i),
        }),
      }),
    );
  });

  test('requires resolved physical data for an Entity-bearing plan', () => {
    const plan = {
      format: 'comblang-direct-plan',
      networks: [],
      producers: [],
      entities: [{}],
    } as unknown as DirectElaborationPlan;

    expect(() => createSourceCircuitArtifact(plan)).toThrow(/matching resolved circuit/i);
  });

  test('rejects malformed canonical resolved arrays before hydration', () => {
    const compilation = compileSourceProgram({
      path: 'canonical-malformed-artifact.factorio.ts',
      text: `const A = Signal('virtual', 'signal-A');
const output = new Network();
output += CC(2 * A);`,
    });
    if (compilation.plan === undefined || compilation.resolvedCircuit === undefined)
      throw new Error('Expected a canonical compilation artifact.');

    const networks = [] as unknown[];
    networks.length = compilation.resolvedCircuit.ir.networks.length;
    const malformed = {
      ...compilation.resolvedCircuit,
      ir: { ...compilation.resolvedCircuit.ir, networks },
    } as unknown as ResolvedCircuit;
    expect(() =>
      createSourceCircuitArtifact(compilation.plan as DirectElaborationPlan, malformed),
    ).toThrowError(
      expect.objectContaining({ code: 'RSC1001', detail: expect.stringMatching(/holes/i) }),
    );
  });
});

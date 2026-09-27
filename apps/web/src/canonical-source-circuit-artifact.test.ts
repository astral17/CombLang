import { describe, expect, test } from 'vitest';
import { transformElaborationModule } from '@comblang/compiler';
import type { EntityProfile } from '@comblang/compiler/entity';
import { syntheticZeroPortEntityProfile } from '@comblang/compiler/entity-fixtures';
import { createTrustedEntityReplayContext } from '@comblang/compiler/entity-replay-context';
import type { DirectElaborationPlan } from '@comblang/compiler/direct-plan-schema';
import type { ResolvedCircuit } from '@comblang/compiler/resolved-circuit';
import { parseFile } from '@comblang/language';
import { tryElaborateDirectPlan } from '@comblang/runtime';
import { compileSourceProgram } from '@comblang/runtime/source-compilation';
import type { EntityPrototype } from '@comblang/prototypes';
import { executeElaborationProgramWithParameters } from '../../../packages/runtime/src/elaboration-program.js';

import { createSourceCircuitArtifact } from './source-circuit-artifact.js';

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

    const artifact = createSourceCircuitArtifact(
      compilation.plan as DirectElaborationPlan,
      compilation.resolvedCircuit as unknown as ResolvedCircuit,
    );
    expect(artifact.resolvedCircuit.format).toBe('comblang-resolved-circuit');
    expect(Object.hasOwn(artifact.resolvedCircuit.ir, 'version')).toBe(false);
    expect(artifact.blueprint.blueprint.entities).toHaveLength(1);
    expect(() => artifact.execution.circuit.createSimulation().step()).not.toThrow();
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
    ).toThrow(/fingerprint does not match/i);
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
    ).toThrow(/holes/i);
  });
});

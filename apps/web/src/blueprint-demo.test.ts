import { compileDirectPlan } from '@comblang/compiler/direct-plan';
import type { EntityProfile } from '@comblang/compiler/entity';
import { syntheticZeroPortEntityProfile } from '@comblang/compiler/entity-fixtures';
import { createTrustedEntityReplayContext } from '@comblang/compiler/entity-replay-context';
import { parseFile } from '@comblang/language';
import type { EntityPrototype } from '@comblang/prototypes';
import type { EntityPrototypeResolver } from '@comblang/runtime/entity-registry';
import { describe, expect, test } from 'vitest';

import { blueprintJsonForArtifact, blueprintJsonForPlan } from './blueprint-demo.js';
import { compileSource } from './compile-source.js';
import { createSourceCircuitArtifact } from './source-circuit-artifact.js';

function exactDeciderEnvironment() {
  const profile: EntityProfile = {
    ...structuredClone(syntheticZeroPortEntityProfile),
    ref: {
      ...syntheticZeroPortEntityProfile.ref,
      prototypeKey: 'entity:decider-combinator',
      profileId: 'profile:blueprint-demo-decider-v6' as EntityProfile['ref']['profileId'],
    },
    prototypeType: 'decider-combinator',
  };
  const trustedEntityReplayContext = createTrustedEntityReplayContext({
    database: profile.ref.database,
    source: 'synthetic',
    evidenceIdentity: 'blueprint-demo-decider-v6-evidence',
    policyIdentity: 'blueprint-demo-decider-v6-policy',
    profiles: [profile],
  });
  const prototype: EntityPrototype = {
    key: 'entity:decider-combinator',
    name: 'decider-combinator',
    type: 'decider-combinator',
    tileWidth: 1,
    tileHeight: 2,
  };
  return {
    trustedEntityReplayContext,
    entityPrototypeResolver: {
      database: profile.ref.database,
      getEntity(nameOrKey: string) {
        return nameOrKey === prototype.key || nameOrKey === prototype.name ? prototype : undefined;
      },
    } as EntityPrototypeResolver,
  };
}

describe('source blueprint JSON preview', () => {
  test('retains executed operand colors, output selection, and nested condition groups', () => {
    const result = compileSource({
      path: 'blueprint-colors.factorio.ts',
      text: `
const A = Signal('virtual', 'signal-A');
const B = Signal('virtual', 'signal-B');
const red: Network<R> = CC(5 * A, 1 * B);
const green: Network<G> = CC(2 * A, 2 * B);
const difference = red[A] - green[A];
const result = when((red[A] > 0 && green[A] > 0) || (red[B] > 0 && green[B] > 0)).then(green[A]).else(red[A]);`,
    });
    expect(result.compilerDiagnostics).toEqual(
      Array.from({ length: 2 }, () =>
        expect.objectContaining({ code: 'CL2001', severity: 'warning' }),
      ),
    );
    const entities = blueprintJsonForPlan(result.plan!).blueprint.entities;
    const arithmetic = entities.find(({ name }) => name === 'arithmetic-combinator')!;
    expect(arithmetic).toMatchObject({
      control_behavior: {
        arithmetic_conditions: {
          first_signal_networks: { red: true, green: false },
          second_signal_networks: { red: false, green: true },
        },
      },
    });
    const decider = entities.find(({ name }) => name === 'decider-combinator')!;
    expect(decider).toMatchObject({
      control_behavior: {
        decider_conditions: {
          conditions: [
            { compare_type: 'and' },
            { compare_type: 'and' },
            { compare_type: 'or' },
            { compare_type: 'and' },
          ],
          outputs: [{ networks: { red: false, green: true } }],
          else_outputs: [{ networks: { red: true, green: false } }],
        },
      },
    });
  });

  test('converts source through lowering, color solving, and JSON generation', () => {
    const parsed = parseFile({
      path: 'blueprint.factorio.ts',
      text: `const A = Signal("virtual", "signal-A");
const constants: Network = CC(5 * A);
const output: Network = constants * 2;`,
    });
    const compiled = compileDirectPlan(parsed);
    const generated = blueprintJsonForPlan(compiled.plan!);

    expect(compiled.diagnostics).toEqual([]);
    expect(generated.blueprint.entities.map((entity) => entity.name)).toEqual([
      'constant-combinator',
      'arithmetic-combinator',
    ]);
    expect(generated.blueprint.wires).toHaveLength(1);
  });

  test('previews a hydrated exact Decider v6 as one native object', () => {
    const compiled = compileSource(
      {
        path: 'blueprint-exact-decider.factorio.ts',
        text: `const A = Signal('virtual', 'signal-A');
const input = new Network();
const gate: DeciderCombinator = Decider({ condition: input[A] > 0, outputs: [input[A]], elseOutputs: [1 * A] }).at(4, 5, 8);
const output = new Network();
output += gate;`,
      },
      exactDeciderEnvironment(),
    );
    if (
      compiled.plan === undefined ||
      compiled.plan.version !== 6 ||
      compiled.resolvedCircuit?.format !== 'comblang-resolved-entity-v6'
    ) {
      throw new Error('Expected a resolved v6 Decider source compilation.');
    }
    const generated = blueprintJsonForArtifact(
      createSourceCircuitArtifact(compiled.plan, compiled.resolvedCircuit),
    );
    expect(generated.blueprint.entities).toHaveLength(1);
    expect(generated.blueprint.entities[0]).toMatchObject({
      name: 'decider-combinator',
      position: { x: 4, y: 5 },
      direction: 8,
      control_behavior: {
        decider_conditions: {
          outputs: [expect.objectContaining({})],
          else_outputs: [expect.objectContaining({})],
        },
      },
    });
  });
});

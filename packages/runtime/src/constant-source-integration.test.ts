import { describe, expect, test } from 'vitest';
import { signal } from '@comblang/factorio';
import { loadPrototypeDatabase, type EntityPrototype } from '@comblang/prototypes';
import { validateBlueprintEntityFragment } from '@comblang/prototypes';
import { generateBlueprintJson } from '@comblang/compiler/blueprint-json';
import type { EntityProfile } from '@comblang/compiler/entity';
import { createTrustedEntityReplayContext } from '@comblang/compiler/entity-replay-context';
import { syntheticZeroPortEntityProfile } from '@comblang/compiler/entity-fixtures';
import builtinPrototypeDatabase from '../../prototypes/generated/space-age-2.1.17.json';

import {
  conservativeEntityProvisioningPolicy,
  EntityProvisioningService,
} from './entity-provisioning.js';
import { compileSourceProgram } from './source-compilation.js';
import type { EntityPrototypeResolver } from './entity-registry.js';
import { hydrateResolvedCircuit } from './resolved-circuit.js';

function constantProfile(prototypeKey: string, profileId: string): EntityProfile {
  return {
    ...syntheticZeroPortEntityProfile,
    ref: {
      ...syntheticZeroPortEntityProfile.ref,
      prototypeKey,
      profileId: profileId as EntityProfile['ref']['profileId'],
    },
    prototypeType: 'constant-combinator',
  };
}

function syntheticConstantHost(
  profiles: readonly EntityProfile[],
  prototypes: readonly EntityPrototype[],
) {
  const trustedEntityReplayContext = createTrustedEntityReplayContext({
    database: syntheticZeroPortEntityProfile.ref.database,
    source: 'synthetic',
    evidenceIdentity: 'constant-source-integration-evidence',
    policyIdentity: 'constant-source-integration-policy',
    profiles,
  });
  const entityPrototypeResolver: EntityPrototypeResolver = {
    database: trustedEntityReplayContext.database,
    getEntity(nameOrKey) {
      return prototypes.find(
        (prototype) => prototype.key === nameOrKey || prototype.name === nameOrKey,
      );
    },
  };
  return { trustedEntityReplayContext, entityPrototypeResolver };
}

function constantPrototype(key: string, name: string): EntityPrototype {
  return {
    key: key as EntityPrototype['key'],
    name,
    type: 'constant-combinator',
    tileWidth: 1,
    tileHeight: 1,
  };
}

describe('public Constant and CC physical unification', () => {
  test('selects only the base profile when a provider also exposes a modded constant-combinator', () => {
    const base = constantProfile('entity:constant-combinator', 'profile:base-constant');
    const modded = constantProfile('entity:modded-constant', 'profile:modded-constant');
    const compilation = compileSourceProgram(
      {
        path: 'base-constant-selection.factorio.ts',
        text: `const A = Signal('virtual', 'signal-A');
const exact = Constant({ sections: [{ filters: [[A, 1]] }] });
const legacy = CC(1 * A);
const first = new Network();
const second = new Network();
first += exact;
second += legacy;`,
      },
      syntheticConstantHost(
        [base, modded],
        [
          constantPrototype('entity:constant-combinator', 'constant-combinator'),
          constantPrototype('entity:modded-constant', 'modded-constant'),
        ],
      ),
    );

    expect(compilation.pipelineDiagnostics).toEqual([]);
    if (compilation.plan === undefined) throw new Error('Expected a canonical Constant plan.');
    expect(compilation.plan.entities.map(({ profile }) => profile.prototypeKey)).toEqual([
      'entity:constant-combinator',
      'entity:constant-combinator',
    ]);
  });

  test('keeps CC unlinked without the base profile and rejects corrupt base provider data', () => {
    const modded = constantProfile('entity:modded-constant', 'profile:modded-constant');
    const withoutBase = syntheticConstantHost(
      [modded],
      [constantPrototype('entity:modded-constant', 'modded-constant')],
    );
    const legacy = compileSourceProgram(
      {
        path: 'missing-base-cc.factorio.ts',
        text: `const A = Signal('virtual', 'signal-A');
const output = new Network();
output += CC(1 * A);`,
      },
      withoutBase,
    );
    const exact = compileSourceProgram(
      { path: 'missing-base-exact.factorio.ts', text: `Constant({ sections: [] });` },
      withoutBase,
    );
    expect(legacy.pipelineDiagnostics).toEqual([]);
    expect(legacy.plan?.entities).toEqual([]);
    expect(exact.pipelineDiagnostics).toEqual([
      expect.objectContaining({
        code: 'RT2027',
        message: expect.stringContaining('requires a trusted base'),
      }),
    ]);

    const base = constantProfile('entity:constant-combinator', 'profile:base-constant');
    const corrupt = compileSourceProgram(
      { path: 'corrupt-base-exact.factorio.ts', text: `Constant({ sections: [] });` },
      syntheticConstantHost(
        [base],
        [constantPrototype('entity:constant-combinator', 'wrong-constant-name')],
      ),
    );
    expect(corrupt.pipelineDiagnostics).toEqual([
      expect.objectContaining({
        code: 'RT2027',
        message: expect.stringContaining('does not match base provider prototype data'),
      }),
    ]);

    const { prototypeType: _prototypeType, ...untypedBase } = base;
    const untyped = compileSourceProgram(
      { path: 'untyped-base-exact.factorio.ts', text: `Constant({ sections: [] });` },
      syntheticConstantHost(
        [untypedBase],
        [constantPrototype('entity:constant-combinator', 'constant-combinator')],
      ),
    );
    expect(untyped.pipelineDiagnostics).toEqual([
      expect.objectContaining({
        code: 'RT2027',
        message: expect.stringContaining('does not assert prototypeType'),
      }),
    ]);
  });

  test('lowers exact Constant and CC to one producer plus one physical Entity each', async () => {
    const { prototypes } = await loadPrototypeDatabase(builtinPrototypeDatabase);
    const provisioned = new EntityProvisioningService().provision(
      prototypes,
      conservativeEntityProvisioningPolicy,
    );
    const compilation = compileSourceProgram(
      {
        path: 'exact-constant.factorio.ts',
        text: `const A = Signal('virtual', 'signal-A');
const exact = Constant({ isOn: true, sections: [{ active: true, multiplier: 1.5, filters: [[A, 2], [A, 0]] }] }).at(4, 5, 8);
const output = new Network();
output += exact;
const legacy = CC(3 * A).at(8, 9);
const second = new Network();
second += legacy;`,
      },
      {
        prototypes,
        trustedEntityReplayContext: provisioned.trustedEntityReplayContext,
        entityPrototypeResolver: provisioned.entityPrototypeResolver,
      },
    );

    expect(compilation.pipelineDiagnostics).toEqual([]);
    if (compilation.plan === undefined || compilation.resolvedCircuit === undefined) {
      throw new Error('Expected a canonical resolved Constant source compilation.');
    }
    expect(compilation.plan.entities).toHaveLength(2);
    expect(compilation.plan.producers).toHaveLength(2);
    expect(compilation.resolvedCircuit.format).toBe('comblang-resolved-circuit');
    expect(compilation.plan.producers.map((producer) => producer.entityId)).toEqual([
      'entity:1',
      'entity:2',
    ]);
    expect(compilation.plan.producers[0]).toMatchObject({
      kind: 'constant',
      configuration: { sections: [{ multiplier: 1.5 }] },
    });
    expect(compilation.plan.producers[0]).not.toHaveProperty('outputs');
    expect(compilation.plan.producers[1]).toMatchObject({
      kind: 'constant',
      outputs: [{ value: 3 }],
    });
    expect(compilation.plan.entities.map((entity) => entity.configuration)).toEqual([
      {
        mode: 'constant',
        value: {
          isOn: true,
          sections: [
            {
              active: true,
              multiplier: 1.5,
              filters: [
                { signal: signal('virtual', 'signal-A'), value: 2 },
                { signal: signal('virtual', 'signal-A'), value: 0 },
              ],
            },
          ],
        },
      },
      {
        mode: 'constant',
        value: {
          isOn: true,
          sections: [
            {
              active: true,
              multiplier: 1,
              filters: [{ signal: signal('virtual', 'signal-A'), value: 3 }],
            },
          ],
        },
      },
    ]);
    expect(compilation.resolvedCircuit.ir.entities).toHaveLength(2);
    expect(compilation.resolvedCircuit.ir.producers[0]).toMatchObject({
      entityId: 'entity:1',
      config: {
        configuration: {
          isOn: true,
          sections: [
            {
              active: true,
              multiplier: 1.5,
              filters: [
                { signal: signal('virtual', 'signal-A'), value: 2 },
                { signal: signal('virtual', 'signal-A'), value: 0 },
              ],
            },
          ],
        },
      },
    });
    expect(compilation.resolvedCircuit.ir.entities[0]?.placement).toEqual({
      x: 4,
      y: 5,
      direction: 8,
    });
  });

  test('assembles nominal Sections into one exact Constant without an output cache', async () => {
    const { prototypes } = await loadPrototypeDatabase(builtinPrototypeDatabase);
    const provisioned = new EntityProvisioningService().provision(
      prototypes,
      conservativeEntityProvisioningPolicy,
    );
    const compilation = compileSourceProgram(
      {
        path: 'section-constant.factorio.ts',
        text: `const A = Signal('virtual', 'signal-A');
const B = Signal('virtual', 'signal-B');
const first = 0.5 * Section(1 * A, 2 * B);
const second = 3 * Section({ active: false, group: 'backup' }, 4 * A);
const sections = [first, second];
const output = new Network();
output += CC(...sections);`,
      },
      {
        prototypes,
        trustedEntityReplayContext: provisioned.trustedEntityReplayContext,
        entityPrototypeResolver: provisioned.entityPrototypeResolver,
      },
    );

    expect(compilation.pipelineDiagnostics).toEqual([]);
    if (compilation.plan === undefined || compilation.resolvedCircuit === undefined) {
      throw new Error('Expected an exact Section Constant compilation.');
    }
    expect(compilation.plan.producers).toHaveLength(1);
    expect(compilation.plan.producers[0]).toMatchObject({
      kind: 'constant',
      configuration: {
        isOn: true,
        sections: [
          {
            active: true,
            multiplier: 0.5,
            filters: [
              { signal: signal('virtual', 'signal-A'), value: 1 },
              { signal: signal('virtual', 'signal-B'), value: 2 },
            ],
          },
          {
            active: false,
            group: 'backup',
            multiplier: 3,
            filters: [{ signal: signal('virtual', 'signal-A'), value: 4 }],
          },
        ],
      },
    });
    expect(compilation.plan.producers[0]).not.toHaveProperty('outputs');
    expect(compilation.plan.entities).toHaveLength(1);
    expect(compilation.resolvedCircuit.ir.producers[0]).toMatchObject({
      config: { configuration: { sections: [{ multiplier: 0.5 }, { multiplier: 3 }] } },
    });
    const hydrated = hydrateResolvedCircuit(compilation.resolvedCircuit);
    expect(hydrated.ir.producers[0]).toMatchObject({
      config: {
        configuration: { sections: [{ multiplier: 0.5 }, { group: 'backup', multiplier: 3 }] },
      },
    });
    const execution = compilation.execution;
    if (execution === undefined) throw new Error('Expected executable Constant IR.');
    expect(() => execution.circuit.createSimulation().step()).toThrowError(
      expect.objectContaining({ code: 'FC1003', reasons: ['non-unit-multiplier', 'group'] }),
    );
    const session = execution.createTestSession();
    session.tick();
    expect(session.readValue(execution.network('output'))).toEqual({
      kind: 'unknown',
      origins: [
        {
          id: 'unmodeled:producer:1:constant-configuration',
          description:
            'Unmodeled Constant configuration for producer:1: non-unit-multiplier, group.',
          path: [],
        },
      ],
    });
    const blueprintEntity = generateBlueprintJson(compilation.resolvedCircuit.ir).blueprint
      .entities[0];
    expect(
      validateBlueprintEntityFragment(
        { control_behavior: blueprintEntity?.control_behavior },
        { type: 'constant-combinator' },
      ),
    ).toEqual({ status: 'valid', structuralStatus: 'documented' });
  });

  test('keeps legacy CC profile-free and rolls back failed exact allocation', async () => {
    const withoutAuthority = compileSourceProgram({
      path: 'legacy-constant.factorio.ts',
      text: `const A = Signal('virtual', 'signal-A');
const output = new Network();
output += CC(2 * A);`,
    });
    expect(withoutAuthority.pipelineDiagnostics).toEqual([]);
    expect(withoutAuthority.plan?.entities).toEqual([]);
    expect(withoutAuthority.resolvedCircuit?.format).toBe('comblang-resolved-circuit');

    const { prototypes } = await loadPrototypeDatabase(builtinPrototypeDatabase);
    const provisioned = new EntityProvisioningService().provision(
      prototypes,
      conservativeEntityProvisioningPolicy,
    );
    const recovered = compileSourceProgram(
      {
        path: 'exact-constant-rollback.factorio.ts',
        text: `let caught = 0;
try { Constant({ sections: [{ multiplier: Infinity }] }); } catch { caught += 1; }
if (caught !== 1) throw new Error('invalid exact Constant was accepted');
const A = Signal('virtual', 'signal-A');
const output = new Network();
output += Constant({ sections: [{ filters: [[A, 0]] }] });`,
      },
      {
        prototypes,
        trustedEntityReplayContext: provisioned.trustedEntityReplayContext,
        entityPrototypeResolver: provisioned.entityPrototypeResolver,
      },
    );
    expect(recovered.pipelineDiagnostics).toEqual([]);
    if (recovered.plan === undefined) throw new Error('Expected a recovered canonical plan.');
    expect(recovered.plan.entities).toHaveLength(1);
    expect(recovered.plan.entities[0]?.id).toBe('entity:1');
  });
});

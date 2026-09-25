import { generateBlueprintJson } from '@comblang/compiler/blueprint-json';
import { loadPrototypeDatabase, validateBlueprintEntityFragment } from '@comblang/prototypes';
import { describe, expect, test } from 'vitest';

import builtinPrototypeDatabase from '../../prototypes/generated/space-age-2.1.17.json';
import {
  conservativeEntityProvisioningPolicy,
  EntityProvisioningService,
} from './entity-provisioning.js';
import { compileSourceProgram } from './source-compilation.js';

describe('Lab Entity support boundary', () => {
  test('provisions only a structural fallback and accepts a documented checked Blueprint fragment', async () => {
    const { prototypes } = await loadPrototypeDatabase(builtinPrototypeDatabase);
    const lab = prototypes.getEntity('lab');
    expect(lab).toMatchObject({
      key: 'entity:lab',
      name: 'lab',
      type: 'lab',
      blueprintEligible: true,
    });
    if (lab === undefined) throw new Error('Expected the pinned provider to include Lab.');

    const provisioned = new EntityProvisioningService().provision(
      prototypes,
      conservativeEntityProvisioningPolicy,
    );
    const profile = provisioned.profiles.find(({ ref }) => ref.prototypeKey === 'entity:lab');
    expect(profile).toMatchObject({
      connectorStructure: 'unknown',
      connectors: [],
      features: [],
      configurationRules: [],
      defaultReadProjection: null,
      synthetic: false,
    });
    expect(profile).not.toHaveProperty('callProjection');
    if (profile === undefined) throw new Error('Expected an eligible Lab fallback profile.');

    const compilation = compileSourceProgram(
      {
        path: 'lab-checked-blueprint.factorio.ts',
        text: `Entity('entity:lab', {
  control_behavior: {
    read_contents: true,
    technology_level_signal: Signal('virtual', 'signal-A'),
  },
});`,
      },
      {
        prototypes,
        trustedEntityReplayContext: provisioned.trustedEntityReplayContext,
        entityPrototypeResolver: provisioned.entityPrototypeResolver,
      },
    );

    expect(compilation.pipelineDiagnostics).toEqual([]);
    expect(compilation.plan?.entities).toHaveLength(1);
    expect(compilation.plan?.entities[0]?.profile).toEqual(profile.ref);
    expect(compilation.plan?.entities[0]?.connectorBindings).toEqual([]);
    if (compilation.resolvedCircuit === undefined) {
      throw new Error('Expected checked Lab configuration to reach concrete Blueprint IR.');
    }

    const labEntity = generateBlueprintJson(compilation.resolvedCircuit.ir).blueprint.entities[0];
    expect(labEntity?.name).toBe('lab');
    expect(labEntity?.control_behavior).toEqual({
      read_contents: true,
      technology_level_signal: { type: 'virtual', name: 'signal-A' },
    });
    expect(
      validateBlueprintEntityFragment({ control_behavior: labEntity?.control_behavior }, lab),
    ).toEqual({ status: 'valid', structuralStatus: 'documented' });
  });

  test('does not make the fallback Lab callable or grant computation features', async () => {
    const { prototypes } = await loadPrototypeDatabase(builtinPrototypeDatabase);
    const provisioned = new EntityProvisioningService().provision(
      prototypes,
      conservativeEntityProvisioningPolicy,
    );
    const compilation = compileSourceProgram(
      {
        path: 'lab-fallback-capability.factorio.ts',
        text: `const input = new Network();
const lab = Entity('entity:lab');
lab(input);`,
      },
      {
        prototypes,
        trustedEntityReplayContext: provisioned.trustedEntityReplayContext,
        entityPrototypeResolver: provisioned.entityPrototypeResolver,
      },
    );

    expect(compilation.pipelineDiagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'RT2027',
          message: expect.stringContaining('has no callable projection'),
        }),
      ]),
    );
    expect(compilation.resolvedCircuit).toBeUndefined();
  });
});

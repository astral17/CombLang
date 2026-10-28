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
  test('provisions the bundled shared connector and accepts a checked Blueprint fragment', async () => {
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
      connectorStructure: 'complete',
      connectors: [
        {
          key: 'circuit',
          direction: 'bidirectional',
        },
      ],
      sharedCallConnector: 'circuit',
      features: [],
      configurationRules: [],
      defaultReadProjection: null,
      synthetic: false,
    });
    expect(
      profile?.connectors[0]?.lanes.map(({ color, nativeEndpoint }) => ({
        color,
        nativeConnector: nativeEndpoint?.nativeConnector,
      })),
    ).toEqual([
      { color: 'green', nativeConnector: 1 },
      { color: 'red', nativeConnector: 1 },
    ]);
    expect(profile).not.toHaveProperty('callProjection');
    if (profile === undefined) throw new Error('Expected the provisioned Lab profile.');

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

  test('allows the provider call without adding a read projection or research simulation', async () => {
    const { prototypes } = await loadPrototypeDatabase(builtinPrototypeDatabase);
    const provisioned = new EntityProvisioningService().provision(
      prototypes,
      conservativeEntityProvisioningPolicy,
    );
    const compilation = compileSourceProgram(
      {
        path: 'lab-shared-call.factorio.ts',
        text: `const input = new Network();
const output = new Network();
const lab = Entity('entity:lab');
output += lab(input);`,
      },
      {
        prototypes,
        trustedEntityReplayContext: provisioned.trustedEntityReplayContext,
        entityPrototypeResolver: provisioned.entityPrototypeResolver,
      },
    );

    expect(compilation.pipelineDiagnostics).toEqual([]);
    expect(compilation.resolvedCircuit?.ir.entities).toHaveLength(1);
    expect(compilation.resolvedCircuit?.ir.entities[0]?.prototypeName).toBe('lab');
    expect(compilation.resolvedCircuit?.ir.entities[0]?.connectorBindings).toHaveLength(2);

    const read = compileSourceProgram(
      {
        path: 'lab-read-without-projection.factorio.ts',
        text: `const lab = Entity('entity:lab');
const input = lab + 0;`,
      },
      {
        prototypes,
        trustedEntityReplayContext: provisioned.trustedEntityReplayContext,
        entityPrototypeResolver: provisioned.entityPrototypeResolver,
      },
    );
    expect(read.pipelineDiagnostics).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'RT2032' })]),
    );
    expect(read.resolvedCircuit).toBeUndefined();
  });
});

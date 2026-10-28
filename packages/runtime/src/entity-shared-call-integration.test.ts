import { loadPrototypeDatabase } from '@comblang/prototypes';
import { describe, expect, test } from 'vitest';
import { generateBlueprintJson } from '@comblang/compiler/blueprint-json';

import builtinPrototypeDatabase from '../../prototypes/generated/space-age-2.1.17.json';
import {
  conservativeEntityProvisioningPolicy,
  EntityProvisioningService,
} from './entity-provisioning.js';
import { projectEntityObjectConnectors } from './entity-object-adapter.js';
import { lowerEntityRecords } from './entity-lowering.js';
import { compileSourceProgram } from './source-compilation.js';

describe('provider-backed shared Entity calls', () => {
  test('returns one locally owned Network shared by input and output without moving it twice', async () => {
    const { prototypes } = await loadPrototypeDatabase(builtinPrototypeDatabase);
    const provisioned = new EntityProvisioningService().provision(
      prototypes,
      conservativeEntityProvisioningPolicy,
    );
    const compilation = compileSourceProgram(
      {
        path: 'entity-return-shared-local.factorio.ts',
        text: `function Build() {
  const local = new Network();
  const machine = Entity('iron-chest');
  local += machine(local);
  return machine;
}
const machine = Build();`,
      },
      {
        prototypes,
        trustedEntityReplayContext: provisioned.trustedEntityReplayContext,
        entityPrototypeResolver: provisioned.entityPrototypeResolver,
      },
    );
    expect(compilation.pipelineDiagnostics).toEqual([]);
    expect(compilation.resolvedCircuit?.ir.entities).toHaveLength(1);
    const bindings = compilation.resolvedCircuit!.ir.entities[0]!.connectorBindings;
    expect(bindings.map(({ direction }) => direction).sort()).toEqual(['input', 'output']);
    expect(new Set(bindings.map(({ network }) => network)).size).toBe(1);
    expect(new Set(bindings.map(({ generation }) => generation)).size).toBe(1);
  });

  test('accepts the bundled assembler-3 call and output attachment repro', async () => {
    const { prototypes } = await loadPrototypeDatabase(builtinPrototypeDatabase);
    const provisioned = new EntityProvisioningService().provision(
      prototypes,
      conservativeEntityProvisioningPolicy,
    );
    const compilation = compileSourceProgram(
      {
        path: 'entity-call-gap-repro.factorio.ts',
        text: `const input = new Network();
const output = new Network();
const machine = Entity('assembling-machine-3');
output += machine(input);`,
      },
      {
        prototypes,
        trustedEntityReplayContext: provisioned.trustedEntityReplayContext,
        entityPrototypeResolver: provisioned.entityPrototypeResolver,
      },
    );

    expect(compilation.pipelineDiagnostics).toEqual([]);
    expect(compilation.plan?.entities).toHaveLength(1);
    expect(compilation.plan?.entities[0]?.connectorBindings).toEqual([]);
    expect(compilation.plan?.entities[0]?.sharedConnectorAttachments).toMatchObject([
      { connector: 'circuit', network: 'input', direction: 'input' },
      { connector: 'circuit', network: 'output', direction: 'output' },
    ]);
    const ir = compilation.resolvedCircuit?.ir;
    expect(ir).toBeDefined();
    expect(ir?.entities).toHaveLength(1);
    const machine = ir!.entities[0]!;
    expect(machine.prototypeName).toBe('assembling-machine-3');
    expect(machine.connectorBindings).toHaveLength(2);
    expect(new Set(machine.connectorBindings.map(({ endpoint }) => endpoint.color))).toEqual(
      new Set(['red', 'green']),
    );
    const networkColors = new Map(ir!.networks.map(({ id, color }) => [id, color]));
    for (const binding of machine.connectorBindings) {
      expect(binding.endpoint.connector).toBe('circuit');
      expect(binding.nativeConnector).toBe(1);
      expect(networkColors.get(binding.network!)).toBe(binding.endpoint.color);
    }
    expect(new Set(machine.connectorBindings.map(({ network }) => network))).toEqual(
      new Set(ir!.networks.map(({ id }) => id)),
    );
    expect(machine.connectorBindings.map(({ direction }) => direction).sort()).toEqual([
      'input',
      'output',
    ]);
    const blueprint = generateBlueprintJson(ir!).blueprint;
    expect(blueprint.entities).toHaveLength(1);
    expect(blueprint.entities[0]).toMatchObject({ name: 'assembling-machine-3' });
    if (compilation.plan?.entities === undefined || compilation.execution === undefined) {
      throw new Error('Expected the checked Entity plan and execution.');
    }
    const lowered = lowerEntityRecords(
      compilation.plan.entities,
      provisioned.trustedEntityReplayContext,
      (name) => compilation.execution!.network(name),
      networkColors,
    );
    expect(lowered[0]?.connectorBindings).toEqual(machine.connectorBindings);
  });

  test('projects both solved shared lanes to their native Blueprint wire connector IDs', async () => {
    const { prototypes } = await loadPrototypeDatabase(builtinPrototypeDatabase);
    const provisioned = new EntityProvisioningService().provision(
      prototypes,
      conservativeEntityProvisioningPolicy,
    );
    const compilation = compileSourceProgram(
      {
        path: 'entity-call-native-wire-ids.factorio.ts',
        text: `const A = Signal('virtual', 'signal-A');
const input = CC(1 * A);
const output = new Network();
output += CC(2 * A);
const machine = Entity('assembling-machine-3');
output += machine(input);`,
      },
      {
        prototypes,
        trustedEntityReplayContext: provisioned.trustedEntityReplayContext,
        entityPrototypeResolver: provisioned.entityPrototypeResolver,
      },
    );

    expect(compilation.pipelineDiagnostics).toEqual([]);
    const ir = compilation.resolvedCircuit?.ir;
    expect(ir?.entities).toHaveLength(3);
    const machine = ir!.entities.find(
      ({ prototypeName }) => prototypeName === 'assembling-machine-3',
    );
    expect(machine).toBeDefined();
    const bindings = machine!.connectorBindings;
    expect(bindings).toHaveLength(2);
    const blueprint = generateBlueprintJson(ir!).blueprint;
    const entityNumber = blueprint.entities.find(
      ({ name }) => name === 'assembling-machine-3',
    )?.entity_number;
    expect(entityNumber).toBeDefined();
    expect(blueprint.wires).toHaveLength(2);
    for (const binding of bindings) {
      const connectorId = binding.nativeConnector! * 2 - (binding.endpoint.color === 'red' ? 1 : 0);
      const entityWire = blueprint.wires.filter(
        ([fromEntity, fromConnector, toEntity, toConnector]) =>
          (fromEntity === entityNumber && fromConnector === connectorId) ||
          (toEntity === entityNumber && toConnector === connectorId),
      );
      expect(entityWire).toHaveLength(1);
    }
  });

  test('coalesces same-Network roles in Blueprint wires and preserves both adapter directions', async () => {
    const { prototypes } = await loadPrototypeDatabase(builtinPrototypeDatabase);
    const provisioned = new EntityProvisioningService().provision(
      prototypes,
      conservativeEntityProvisioningPolicy,
    );
    const compilation = compileSourceProgram(
      {
        path: 'entity-call-shared-loopback.factorio.ts',
        text: `const loop = new Network();
const machine = Entity('assembling-machine-3');
loop += machine(loop);`,
      },
      {
        prototypes,
        trustedEntityReplayContext: provisioned.trustedEntityReplayContext,
        entityPrototypeResolver: provisioned.entityPrototypeResolver,
      },
    );

    expect(compilation.pipelineDiagnostics).toEqual([]);
    const ir = compilation.resolvedCircuit?.ir;
    expect(ir?.entities).toHaveLength(1);
    const physical = ir!.entities[0]!;
    expect(physical.connectorBindings).toHaveLength(2);
    expect(physical.connectorBindings[0]?.network).toBe(physical.connectorBindings[1]?.network);
    expect(physical.connectorBindings[0]?.endpoint).toEqual(
      physical.connectorBindings[1]?.endpoint,
    );
    const network = physical.connectorBindings[0]!.network!;
    expect(projectEntityObjectConnectors(physical)).toEqual([
      { name: 'circuit', inputNetworks: [network], outputNetworks: [network] },
    ]);
    const blueprint = generateBlueprintJson(ir!).blueprint;
    expect(blueprint.entities).toHaveLength(1);
    expect(blueprint.wires).toEqual([]);
  });
});

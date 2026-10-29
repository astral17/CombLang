import { loadPrototypeDatabase } from '@comblang/prototypes';
import { describe, expect, test } from 'vitest';
import { generateBlueprintJson } from '@comblang/compiler/blueprint-json';
import { resolvedCircuitPlanFingerprint } from '@comblang/compiler/resolved-circuit';

import builtinPrototypeDatabase from '../../prototypes/generated/space-age-2.1.17.json';
import {
  conservativeEntityProvisioningPolicy,
  EntityProvisioningService,
} from './entity-provisioning.js';
import { projectEntityObjectConnectors } from './entity-object-adapter.js';
import { lowerEntityRecords } from './entity-lowering.js';
import { executeResolvedDirectPlan } from './direct-plan.js';
import { compileSourceProgram } from './source-compilation.js';

describe('provider-backed shared Entity calls', () => {
  test.each([
    {
      callOrder: 'a,b',
      destination: 'a',
      captureOutput: 'before',
      expectedInputGeneration: 1,
    },
    {
      callOrder: 'a,b',
      destination: 'a',
      captureOutput: 'after',
      expectedInputGeneration: 1,
    },
    {
      callOrder: 'a,b',
      destination: 'b',
      captureOutput: 'before',
      expectedInputGeneration: 1,
    },
    {
      callOrder: 'a,b',
      destination: 'b',
      captureOutput: 'after',
      expectedInputGeneration: 1,
    },
    {
      callOrder: 'b,a',
      destination: 'a',
      captureOutput: 'before',
      expectedInputGeneration: 0,
    },
    {
      callOrder: 'b,a',
      destination: 'a',
      captureOutput: 'after',
      expectedInputGeneration: 0,
    },
    {
      callOrder: 'b,a',
      destination: 'b',
      captureOutput: 'before',
      expectedInputGeneration: 0,
    },
    {
      callOrder: 'b,a',
      destination: 'b',
      captureOutput: 'after',
      expectedInputGeneration: 0,
    },
  ] as const)(
    'coalesces transferred inputs across epochs ($callOrder, destination $destination, output $captureOutput)',
    async ({ callOrder, destination, captureOutput, expectedInputGeneration }) => {
      const { prototypes } = await loadPrototypeDatabase(builtinPrototypeDatabase);
      const provisioned = new EntityProvisioningService().provision(
        prototypes,
        conservativeEntityProvisioningPolicy,
      );
      const source = destination === 'a' ? 'b' : 'a';
      const attachOutput = `${destination} += machine;`;
      const compilation = compileSourceProgram(
        {
          path: 'entity-input-generation-collapse.factorio.ts',
          text: `function Make(): Network { return new Network(); }
const a = Make();
const b = new Network();
const machine = Entity('iron-chest');
machine(${callOrder});
${captureOutput === 'before' ? attachOutput : ''}
${destination}.take(${source});
${captureOutput === 'after' ? attachOutput : ''}`,
        },
        {
          prototypes,
          trustedEntityReplayContext: provisioned.trustedEntityReplayContext,
          entityPrototypeResolver: provisioned.entityPrototypeResolver,
        },
      );
      expect(compilation.pipelineDiagnostics).toEqual([]);
      expect(compilation.plan?.entities).toHaveLength(1);
      const ir = compilation.resolvedCircuit!.ir;
      expect(ir.entities).toHaveLength(1);
      expect(ir.networks).toHaveLength(1);
      const bindings = ir.entities[0]!.connectorBindings;
      expect(bindings).toHaveLength(2);
      expect(bindings.map(({ direction }) => direction).sort()).toEqual(['input', 'output']);
      expect(new Set(bindings.map(({ network }) => network)).size).toBe(1);
      expect(bindings.find(({ direction }) => direction === 'input')?.generation).toBe(
        expectedInputGeneration,
      );
      expect(bindings.find(({ direction }) => direction === 'output')?.generation).toBe(
        destination === 'a' ? 1 : 0,
      );
      expect(() =>
        executeResolvedDirectPlan(compilation.plan!, compilation.resolvedCircuit!),
      ).not.toThrow();

      const networkColors = new Map(ir.networks.map(({ id, color }) => [id, color]));
      const lowered = lowerEntityRecords(
        compilation.plan!.entities!,
        provisioned.trustedEntityReplayContext,
        () => compilation.execution!.network(destination),
        networkColors,
      );
      expect(lowered[0]?.connectorBindings).toEqual(bindings);
    },
  );

  test('coalesces same-epoch input attachments after transfer', async () => {
    const { prototypes } = await loadPrototypeDatabase(builtinPrototypeDatabase);
    const provisioned = new EntityProvisioningService().provision(
      prototypes,
      conservativeEntityProvisioningPolicy,
    );
    const compilation = compileSourceProgram(
      {
        path: 'entity-input-same-generation-collapse.factorio.ts',
        text: `const a = new Network();
const b = new Network();
const machine = Entity('iron-chest');
machine(a, b);
a.take(b);
a += machine;`,
      },
      {
        prototypes,
        trustedEntityReplayContext: provisioned.trustedEntityReplayContext,
        entityPrototypeResolver: provisioned.entityPrototypeResolver,
      },
    );
    expect(compilation.pipelineDiagnostics).toEqual([]);
    expect(compilation.resolvedCircuit?.ir.entities).toHaveLength(1);
    expect(compilation.resolvedCircuit?.ir.networks).toHaveLength(1);
    const bindings = compilation.resolvedCircuit!.ir.entities[0]!.connectorBindings;
    expect(bindings.map(({ direction }) => direction).sort()).toEqual(['input', 'output']);
    expect(new Set(bindings.map(({ network }) => network)).size).toBe(1);
  });

  test.each([
    { transfer: 'a.take(b);', returned: 'Build()' },
    { transfer: 'b.take(a);', returned: 'Build()' },
    { transfer: 'a.take(b); c.take(a);', returned: 'Wrap()' },
  ])(
    'returns a transferred Entity through $returned after $transfer',
    async ({ transfer, returned }) => {
      const { prototypes } = await loadPrototypeDatabase(builtinPrototypeDatabase);
      const provisioned = new EntityProvisioningService().provision(
        prototypes,
        conservativeEntityProvisioningPolicy,
      );
      const compilation = compileSourceProgram(
        {
          path: 'entity-return-transferred-shared-local.factorio.ts',
          text: `function Build() {
  const a = new Network();
  const b = new Network();
  ${transfer.includes('c.take') ? 'const c = new Network();' : ''}
  const machine = Entity('iron-chest');
  machine(a, b);
  a += machine;
  ${transfer}
  return machine;
}
function Wrap() { return Build(); }
const machine = ${returned};`,
        },
        {
          prototypes,
          trustedEntityReplayContext: provisioned.trustedEntityReplayContext,
          entityPrototypeResolver: provisioned.entityPrototypeResolver,
        },
      );
      expect(compilation.pipelineDiagnostics).toEqual([]);
      expect(compilation.resolvedCircuit?.ir.entities).toHaveLength(1);
      expect(compilation.resolvedCircuit?.ir.networks).toHaveLength(1);
      const bindings = compilation.resolvedCircuit!.ir.entities[0]!.connectorBindings;
      expect(bindings.map(({ direction }) => direction).sort()).toEqual(['input', 'output']);
      expect(new Set(bindings.map(({ network }) => network)).size).toBe(1);
      expect(() =>
        executeResolvedDirectPlan(compilation.plan!, compilation.resolvedCircuit!),
      ).not.toThrow();
    },
  );

  test('paired replay rejects stale source and tampered physical shared-role records', async () => {
    const { prototypes } = await loadPrototypeDatabase(builtinPrototypeDatabase);
    const provisioned = new EntityProvisioningService().provision(
      prototypes,
      conservativeEntityProvisioningPolicy,
    );
    const compilation = compileSourceProgram(
      {
        path: 'entity-transfer-replay-tampering.factorio.ts',
        text: `function Make(): Network { return new Network(); }
const a = Make();
const b = new Network();
const machine = Entity('iron-chest');
machine(a, b);
a.take(b);
a += machine;`,
      },
      {
        prototypes,
        trustedEntityReplayContext: provisioned.trustedEntityReplayContext,
        entityPrototypeResolver: provisioned.entityPrototypeResolver,
      },
    );
    expect(compilation.pipelineDiagnostics).toEqual([]);
    const plan = compilation.plan!;
    const resolved = compilation.resolvedCircuit!;
    expect(() => executeResolvedDirectPlan(plan, resolved)).not.toThrow();

    const staleSourcePlan = structuredClone(plan) as any;
    const transferredSource = staleSourcePlan.entities[0].sharedConnectorAttachments.find(
      ({ network }: { network: string }) => network === 'b',
    );
    transferredSource.generation += 1;
    const staleSourceCircuit = structuredClone(resolved) as any;
    staleSourceCircuit.planFingerprint = resolvedCircuitPlanFingerprint(staleSourcePlan);
    expect(() => executeResolvedDirectPlan(staleSourcePlan, staleSourceCircuit)).toThrow();

    const tamperedGeneration = structuredClone(resolved) as any;
    const generationRepresentative = tamperedGeneration.ir.entities[0].connectorBindings.find(
      ({ direction }: { direction: string }) => direction === 'input',
    );
    generationRepresentative.generation += 2;
    expect(() => executeResolvedDirectPlan(plan, tamperedGeneration)).toThrow();

    const tamperedProvenance = structuredClone(resolved) as any;
    const provenanceRepresentative = tamperedProvenance.ir.entities[0].connectorBindings.find(
      ({ direction }: { direction: string }) => direction === 'input',
    );
    provenanceRepresentative.provenance.operationOrdinal += 1;
    expect(() => executeResolvedDirectPlan(plan, tamperedProvenance)).toThrow();

    const tamperedColor = structuredClone(resolved) as any;
    const physicalMachine = tamperedColor.ir.entities[0];
    const otherColor =
      physicalMachine.connectorBindings[0].endpoint.color === 'red' ? 'green' : 'red';
    const profile = provisioned.trustedEntityReplayContext.profiles.find(
      ({ ref }) => ref.prototypeKey === 'entity:iron-chest',
    )!;
    const sharedConnector = profile.connectors.find(
      ({ key }) => key === profile.sharedCallConnector,
    )!;
    const otherLane = sharedConnector.lanes.find(({ color }) => color === otherColor)!;
    tamperedColor.ir.networks[0].color = otherColor;
    for (const binding of physicalMachine.connectorBindings) {
      binding.endpoint.lane = otherLane.key;
      binding.endpoint.color = otherColor;
      binding.nativeConnector = otherLane.nativeEndpoint!.nativeConnector;
    }
    expect(() => executeResolvedDirectPlan(plan, tamperedColor)).toThrow();

    const missingRole = structuredClone(resolved) as any;
    missingRole.ir.entities[0].connectorBindings.pop();
    expect(() => executeResolvedDirectPlan(plan, missingRole)).toThrow();

    const addedRole = structuredClone(resolved) as any;
    const extraInput = structuredClone(
      addedRole.ir.entities[0].connectorBindings.find(
        ({ direction }: { direction: string }) => direction === 'input',
      ),
    );
    extraInput.provenance.operationOrdinal += 1;
    addedRole.ir.entities[0].connectorBindings.push(extraInput);
    expect(() => executeResolvedDirectPlan(plan, addedRole)).toThrow();
  });

  test('does not allow direct use of the consumed source alias after transfer', async () => {
    const { prototypes } = await loadPrototypeDatabase(builtinPrototypeDatabase);
    const provisioned = new EntityProvisioningService().provision(
      prototypes,
      conservativeEntityProvisioningPolicy,
    );
    const compilation = compileSourceProgram(
      {
        path: 'entity-consumed-shared-source-alias.factorio.ts',
        text: `const a = new Network();
const b = new Network();
const machine = Entity('iron-chest');
machine(a, b);
a.take(b);
b += machine;`,
      },
      {
        prototypes,
        trustedEntityReplayContext: provisioned.trustedEntityReplayContext,
        entityPrototypeResolver: provisioned.entityPrototypeResolver,
      },
    );
    expect(compilation.pipelineDiagnostics).toMatchObject([
      { code: 'RT2012', message: expect.stringContaining('moved Network b') },
    ]);
  });

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

  test.each([
    { a: 'R', b: 'G', aColor: 'red', bColor: 'green' },
    { a: 'G', b: 'R', aColor: 'green', bColor: 'red' },
  ] as const)(
    'attaches two readable Networks on one provider-backed Entity call ($a/$b)',
    async ({ a, b, aColor, bColor }) => {
      const { prototypes } = await loadPrototypeDatabase(builtinPrototypeDatabase);
      const provisioned = new EntityProvisioningService().provision(
        prototypes,
        conservativeEntityProvisioningPolicy,
      );
      const compilation = compileSourceProgram(
        {
          path: 'entity-call-multiple-inputs.factorio.ts',
          text: `const A = Signal('virtual', 'signal-A');
const a = new Network<${a}>();
const b = new Network<${b}>();
a += CC(1 * A);
b += CC(2 * A);
const machine = Entity('assembling-machine-3');
const x = machine(a, b);
a += x;
b += x;`,
        },
        {
          prototypes,
          trustedEntityReplayContext: provisioned.trustedEntityReplayContext,
          entityPrototypeResolver: provisioned.entityPrototypeResolver,
        },
      );

      expect(compilation.pipelineDiagnostics).toEqual([]);
      expect(compilation.plan?.entities).toHaveLength(3);
      const plannedMachine = compilation.plan!.entities.find(
        ({ profile }) => profile.prototypeKey === 'entity:assembling-machine-3',
      );
      expect(plannedMachine?.sharedConnectorAttachments).toMatchObject([
        { connector: 'circuit', network: 'a', direction: 'input' },
        { connector: 'circuit', network: 'b', direction: 'input' },
        { connector: 'circuit', network: 'a', direction: 'output' },
        { connector: 'circuit', network: 'b', direction: 'output' },
      ]);

      const ir = compilation.resolvedCircuit?.ir;
      expect(ir?.entities).toHaveLength(3);
      const machine = ir!.entities.find(
        ({ prototypeName }) => prototypeName === 'assembling-machine-3',
      )!;
      expect(machine.connectorBindings).toHaveLength(4);
      expect(new Set(machine.connectorBindings.map(({ network }) => network)).size).toBe(2);
      expect(machine.connectorBindings.map(({ direction }) => direction).sort()).toEqual([
        'input',
        'input',
        'output',
        'output',
      ]);
      const networkColors = new Map(ir!.networks.map(({ id, color }) => [id, color]));
      const networkA = compilation.execution!.network('a').id;
      const networkB = compilation.execution!.network('b').id;
      for (const binding of machine.connectorBindings) {
        expect(networkColors.get(binding.network!)).toBe(binding.endpoint.color);
        if (binding.network === networkA) expect(binding.endpoint.color).toBe(aColor);
        if (binding.network === networkB) expect(binding.endpoint.color).toBe(bColor);
      }
      const [projected] = projectEntityObjectConnectors(machine);
      expect(projected?.inputNetworks).toEqual(expect.arrayContaining([networkA, networkB]));
      expect(projected?.inputNetworks).toHaveLength(2);
      expect(projected?.outputNetworks).toEqual(expect.arrayContaining([networkA, networkB]));
      expect(projected?.outputNetworks).toHaveLength(2);

      const blueprint = generateBlueprintJson(ir!).blueprint;
      expect(blueprint.entities).toHaveLength(3);
      expect(blueprint.wires).toHaveLength(2);
      const entityNumber = blueprint.entities.find(
        ({ name }) => name === 'assembling-machine-3',
      )?.entity_number;
      expect(entityNumber).toBeDefined();
      for (const binding of machine.connectorBindings) {
        const connectorId =
          binding.nativeConnector! * 2 - (binding.endpoint.color === 'red' ? 1 : 0);
        expect(
          blueprint.wires.filter(
            ([fromEntity, fromConnector, toEntity, toConnector]) =>
              (fromEntity === entityNumber && fromConnector === connectorId) ||
              (toEntity === entityNumber && toConnector === connectorId),
          ),
        ).toHaveLength(1);
      }
    },
  );

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

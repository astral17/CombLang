import {
  loadPrototypeDatabase,
  loadPrototypeInputJson,
  syntheticPrototypeDatabase,
  type EntityPrototype,
} from '@comblang/prototypes';
import { sourceFileId, sourceSpan, type Diagnostic } from '@comblang/shared';
import { SparseBus } from '@comblang/factorio';
import { generateEntityBlueprintJson } from '@comblang/compiler/blueprint-json';
import type { EntityProfile } from '@comblang/compiler/entity';
import {
  syntheticSharedTwoColorEntityProfile,
  syntheticZeroPortEntityProfile,
} from '@comblang/compiler/entity-fixtures';
import {
  createTrustedEntityReplayContext,
  entityReplayContextTransport,
} from '@comblang/compiler/entity-replay-context';
import builtinPrototypeDatabase from '../../prototypes/generated/space-age-2.1.17.json';
import { describe, expect, test } from 'vitest';

import type { EntityPrototypeResolver } from './entity-registry.js';

import {
  compileSourceProgram,
  sourceCompilationArtifact,
  type SourceCompilationStage,
} from './source-compilation.js';
import { elaborateEntityDirectPlan } from './direct-plan.js';
import {
  conservativeEntityProvisioningPolicy,
  EntityProvisioningService,
} from './entity-provisioning.js';
import { createDebugDocument } from './debug-document.js';
import { hydrateResolvedSourceCircuit } from './resolved-source-circuit.js';

const importedEntitySource = JSON.stringify({
  item: { 'iron-plate': { type: 'item', name: 'iron-plate', stack_size: 100 } },
  fluid: { water: { type: 'fluid', name: 'water' } },
  recipe: {
    'iron-plate': {
      type: 'recipe',
      name: 'iron-plate',
      ingredients: {},
      results: [{ type: 'item', name: 'iron-plate', amount: 1 }],
    },
  },
  'recipe-category': { crafting: { type: 'recipe-category', name: 'crafting' } },
  quality: { normal: { type: 'quality', name: 'normal', level: 0 } },
  'virtual-signal': { 'signal-A': { type: 'virtual-signal', name: 'signal-A' } },
  'assembling-machine': {
    'footprint-less': {
      type: 'assembling-machine',
      name: 'footprint-less',
      flags: ['placeable-player', 'player-creation'],
    },
  },
});
const importedEntityMetadata = JSON.stringify({
  factorioVersion: '2.1.17',
  expansions: [],
  mods: [{ name: 'base', version: '2.1.17' }],
});

function syntheticEntityHost(
  profile: EntityProfile,
  source: 'synthetic' | 'provider' = 'synthetic',
) {
  const prototype = {
    key: profile.ref.prototypeKey as EntityPrototype['key'],
    name: profile.ref.prototypeKey.slice('entity:'.length),
    type: 'container',
  } satisfies EntityPrototype;
  const trustedEntityReplayContext = createTrustedEntityReplayContext({
    database: profile.ref.database,
    source,
    evidenceIdentity:
      source === 'synthetic' ? 'comblang-synthetic-evidence-v1' : 'comblang-provider-evidence-v1',
    policyIdentity: 'comblang-entity-policy-v1',
    profiles: [profile],
  });
  const entityPrototypeResolver: EntityPrototypeResolver = {
    database: profile.ref.database,
    getEntity(nameOrKey) {
      return nameOrKey === prototype.key || nameOrKey === prototype.name ? prototype : undefined;
    },
  };
  return { trustedEntityReplayContext, entityPrototypeResolver };
}

describe('shared source compilation service', () => {
  test('snapshots and hydrates canonical Decider copy input output data', () => {
    const host = syntheticEntityHost(syntheticZeroPortEntityProfile);
    const compilation = compileSourceProgram(
      {
        path: 'copy-output-transport.factorio.ts',
        text: `const entity = Entity('synthetic-zero-port');
const A = Signal('virtual', 'signal-A');
const input = new Network();
const output = new Network();
output += IF(input[A] > 0, input[A]);`,
      },
      host,
    );

    expect(compilation.pipelineDiagnostics).toEqual([]);
    const resolvedCircuit = compilation.resolvedCircuit;
    if (resolvedCircuit === undefined) throw new Error('Expected a resolved source circuit.');
    const decider = resolvedCircuit.ir.producers.find((producer) => producer.kind === 'decider');
    if (decider === undefined || decider.kind !== 'decider') {
      throw new Error('Expected a Decider producer.');
    }
    expect(decider.config.outputs[0]).toMatchObject({
      mode: 'copy',
      input: { refKind: 'single' },
    });

    const hydrated = hydrateResolvedSourceCircuit(resolvedCircuit);
    const input = hydrated.ir.networks.find(({ name }) => name === 'input');
    const output = hydrated.ir.networks.find(({ name }) => name === 'output');
    if (input === undefined || output === undefined)
      throw new Error('Expected input/output Networks.');
    const value = hydrated
      .createSimulation([
        {
          network: hydrated.network(input.id),
          values: new SparseBus([[{ type: 'virtual', name: 'signal-A' }, 4]]),
        },
      ])
      .step()
      .read(output.id);
    expect(value.get({ type: 'virtual', name: 'signal-A' })).toBe(4);
  });

  test('resolves short and canonical Entity prototype spellings to one host prototype', () => {
    const host = syntheticEntityHost(syntheticZeroPortEntityProfile);
    const compilation = compileSourceProgram(
      {
        path: 'entity-prototype-spellings.factorio.ts',
        text: `const shortName = Entity('synthetic-zero-port');
const canonicalName = Entity('entity:synthetic-zero-port');`,
      },
      host,
    );

    expect(compilation.pipelineDiagnostics).toEqual([]);
    const plan = compilation.plan;
    if (plan === undefined || plan.version !== 3) throw new Error('Expected a v3 source plan.');
    expect(plan.entities.map(({ profile }) => profile)).toEqual([
      syntheticZeroPortEntityProfile.ref,
      syntheticZeroPortEntityProfile.ref,
    ]);
  });

  test('compiles the public host-bound Entity constructor and explicit port/bind methods as v3', () => {
    const host = syntheticEntityHost(syntheticSharedTwoColorEntityProfile);
    const compilation = compileSourceProgram(
      {
        path: 'entity-source.factorio.ts',
        text: `function makeEntity() {
  return Entity('entity:synthetic-shared-two-color');
}
const entities = [makeEntity()];
const entity = entities[0];
const input = new Network<R>();
entity.bind('shared', 'shared-red', input, 'input');
const facet = entity.port('shared', 'shared-red');
const output = new Network();
output += facet + 1;`,
      },
      host,
    );

    expect(compilation.pipelineDiagnostics).toEqual([]);
    const plan = compilation.plan;
    if (plan === undefined || plan.version !== 3)
      throw new Error('Expected a host-bound Entity v3 plan.');
    const execution = compilation.execution;
    if (execution === undefined || execution.circuit.ir.version !== 3)
      throw new Error('Expected a host-bound Entity v3 execution.');
    if (!('entityObject' in execution)) throw new Error('Expected Entity test adapters.');
    expect(plan.version).toBe(3);
    expect(execution.circuit.ir.version).toBe(3);
    expect(compilation.resolvedCircuit).toMatchObject({
      format: 'comblang-resolved-source-circuit',
      version: 1,
      ir: execution.circuit.ir,
    });
    expect(structuredClone(compilation.resolvedCircuit)).toEqual(compilation.resolvedCircuit);
    expect(execution.circuit.ir.entities).toHaveLength(1);
    expect(plan.entities[0]?.connectorBindings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          endpoint: {
            connector: 'shared',
            lane: 'shared-red',
            color: 'red',
          },
          network: 'input',
          direction: 'input',
        }),
      ]),
    );
    expect(execution.debug.scopes.flatMap(({ entities }) => entities)).toHaveLength(1);
    const session = execution.createTestSession();
    expect(execution.entityObject(session, 1)).toMatchObject({
      adapterId: 'entity-physical-v3',
      instanceId: 'ordinal-1',
    });
  });

  test('compiles callable Entity input/output through transport, blueprint, debug, and inert simulation', () => {
    const host = syntheticEntityHost(syntheticSharedTwoColorEntityProfile);
    const compilation = compileSourceProgram(
      {
        path: 'callable-entity-source.factorio.ts',
        text: `const input = new Network();
const output = new Network();
output += Entity('synthetic-shared-two-color')(input);`,
      },
      host,
    );

    expect(compilation.pipelineDiagnostics).toEqual([]);
    const plan = compilation.plan;
    const execution = compilation.execution;
    const resolvedCircuit = compilation.resolvedCircuit;
    if (
      plan === undefined ||
      plan.version !== 3 ||
      execution === undefined ||
      execution.circuit.ir.version !== 3 ||
      !('entityObject' in execution) ||
      resolvedCircuit === undefined
    ) {
      throw new Error('Expected a resolved callable Entity v3 compilation.');
    }
    expect(plan.entities).toHaveLength(1);
    expect(plan.networks).toHaveLength(2);
    expect(plan.entities[0]?.connectorBindings).toHaveLength(2);
    expect(execution.circuit.ir.entities).toHaveLength(1);
    expect(resolvedCircuit.ir.entities).toEqual(execution.circuit.ir.entities);
    expect(structuredClone(resolvedCircuit)).toEqual(resolvedCircuit);

    const blueprint = generateEntityBlueprintJson(execution.circuit.ir);
    expect(blueprint.blueprint.entities).toHaveLength(1);
    expect(blueprint.blueprint.entities[0]).toMatchObject({
      name: 'synthetic-shared-two-color',
      entity_number: 1,
    });

    const debugEntity = execution.debug.root.entity(1);
    expect(debugEntity.entityId).toBe(execution.circuit.ir.entities[0]?.id);
    expect(debugEntity.record.connectorBindings).toHaveLength(2);
    const session = execution.createTestSession();
    expect(execution.entityObject(session, 1)).toMatchObject({
      adapterId: 'entity-physical-v3',
      instanceId: 'ordinal-1',
    });

    const hydrated = hydrateResolvedSourceCircuit(resolvedCircuit);
    const inputRecord = hydrated.ir.networks.find(({ name }) => name === 'input');
    const outputRecord = hydrated.ir.networks.find(({ name }) => name === 'output');
    if (inputRecord === undefined || outputRecord === undefined) {
      throw new Error('Expected hydrated callable Entity input/output Networks.');
    }
    const input = hydrated.network(inputRecord.id);
    const output = hydrated.network(outputRecord.id);
    const tick = hydrated.createSimulation().step();
    expect(tick.tick).toBe(1);
    expect(tick.read(input.id)).toEqual(tick.read(output.id));
    expect(hydrated.ir.entities).toHaveLength(1);
  });

  test.each([
    {
      label: 'the checked-in built-in provider',
      prototypeName: 'assembling-machine-3',
      load: async () => loadPrototypeDatabase(builtinPrototypeDatabase),
    },
    {
      label: 'an imported raw provider',
      prototypeName: 'footprint-less',
      load: async () =>
        loadPrototypeInputJson(importedEntitySource, {
          factorioDumpMetadata: importedEntityMetadata,
        }),
    },
  ])(
    'accepts a zero-port Entity from $label through the public preview path',
    async ({ label, prototypeName, load }) => {
      const { prototypes } = await load();
      const provisioned = new EntityProvisioningService().provision(
        prototypes,
        conservativeEntityProvisioningPolicy,
      );
      const compilation = compileSourceProgram(
        {
          path: `${prototypeName}-construction.factorio.ts`,
          text: `const output = new Network();
const entity = Entity('${prototypeName}').at(5, 6, 8);`,
        },
        {
          prototypes,
          trustedEntityReplayContext: provisioned.trustedEntityReplayContext,
          entityPrototypeResolver: provisioned.entityPrototypeResolver,
        },
      );

      expect(compilation.pipelineDiagnostics).toEqual([]);
      const plan = compilation.plan;
      const execution = compilation.execution;
      const resolvedCircuit = compilation.resolvedCircuit;
      if (
        plan === undefined ||
        plan.version !== 3 ||
        execution === undefined ||
        !('entityObject' in execution) ||
        resolvedCircuit === undefined
      ) {
        throw new Error(`Expected a resolved zero-port Entity v3 compilation for ${label}.`);
      }
      expect(plan.entities).toHaveLength(1);
      expect(plan.entities[0]).toMatchObject({
        profile: { prototypeKey: `entity:${prototypeName}` },
        placement: { x: 5, y: 6, direction: 8 },
        connectorBindings: [],
      });
      expect(execution.circuit.ir.entities).toHaveLength(1);
      expect(execution.circuit.graph.producers).toHaveLength(0);
      expect(resolvedCircuit.ir.entities).toEqual(execution.circuit.ir.entities);
      expect(structuredClone(resolvedCircuit)).toEqual(resolvedCircuit);

      const blueprint = generateEntityBlueprintJson(execution.circuit.ir).blueprint;
      expect(blueprint.entities).toEqual([
        expect.objectContaining({
          entity_number: 1,
          name: prototypeName,
          position: { x: 5, y: 6 },
          direction: 8,
        }),
      ]);
      expect(blueprint.entities[0]).not.toHaveProperty('control_behavior');

      const debug = createDebugDocument(execution.debug, execution.circuit.graph);
      expect(debug).toMatchObject({
        format: 'comblang-debug',
        version: 2,
        scopes: [{ entities: [{ record: { placement: { x: 5, y: 6, direction: 8 } } }] }],
      });

      const hydrated = hydrateResolvedSourceCircuit(resolvedCircuit);
      const output = hydrated.ir.networks.find(({ name }) => name === 'output');
      if (output === undefined) throw new Error('Expected the output Network.');
      const tick = hydrated.createSimulation().step();
      expect(tick.tick).toBe(1);
      expect(tick.read(output.id).size).toBe(0);
    },
  );

  test('evaluates the Entity prototype expression exactly once', () => {
    const host = syntheticEntityHost(syntheticZeroPortEntityProfile);
    const compilation = compileSourceProgram(
      {
        path: 'entity-prototype-expression.factorio.ts',
        text: `let evaluations = 0;
function prototypeName() {
  evaluations += 1;
  return 'entity:synthetic-zero-port';
}
const entity = Entity(prototypeName());
if (evaluations !== 1) throw new Error('Entity prototype expression was evaluated more than once');`,
      },
      host,
    );

    expect(compilation.pipelineDiagnostics).toEqual([]);
    const plan = compilation.plan;
    if (plan === undefined || plan.version !== 3) throw new Error('Expected an Entity v3 plan.');
    expect(plan.entities).toHaveLength(1);
  });

  test('places one Entity through direct, spread, enum, function, and loop forms', () => {
    const host = syntheticEntityHost(syntheticSharedTwoColorEntityProfile);
    const compilation = compileSourceProgram(
      {
        path: 'entity-placement-source.factorio.ts',
        text: `enum Direction { East = 4, South = 8 }
const entity = Entity('entity:synthetic-shared-two-color');
const input = new Network<R>();
entity.bind('shared', 'shared-red', input, 'input');
const before = entity.port('shared', 'shared-red');
entity.at(1, 2);
function move(value) { return value.at(...[3, 4], Direction.South); }
const moved = move(entity);
for (const position of [[5, 6], [7, 8]]) entity.at(...position);
const after = moved.port('shared', 'shared-red');`,
      },
      host,
    );

    expect(compilation.pipelineDiagnostics).toEqual([]);
    const plan = compilation.plan;
    const execution = compilation.execution;
    if (
      plan === undefined ||
      plan.version !== 3 ||
      execution === undefined ||
      !('entityObject' in execution)
    ) {
      throw new Error('Expected a host-bound Entity v3 execution.');
    }
    expect(plan.producers).toHaveLength(0);
    expect(plan.networks).toHaveLength(1);
    expect(plan.entities).toHaveLength(1);
    expect(plan.entities[0]).toMatchObject({
      placement: { x: 7, y: 8 },
      connectorBindings: [
        expect.objectContaining({
          endpoint: { connector: 'shared', lane: 'shared-red', color: 'red' },
          network: 'input',
          direction: 'input',
        }),
      ],
    });
    expect(execution.circuit.graph.producers).toHaveLength(0);
    expect(execution.circuit.ir.networks).toHaveLength(1);
    expect(execution.circuit.ir.entities).toHaveLength(1);
  });

  test('constructs a nominal NativeCondition with all comparators and int32 constants', () => {
    const compilation = compileSourceProgram({
      path: 'native-condition-source.factorio.ts',
      text: `const signal = Signal('virtual', 'signal-A');
const greater = NativeCondition(signal, '>', 0);
const less = NativeCondition(signal, '<', 1);
const equal = NativeCondition(signal, '=', 2);
const greaterEqual = NativeCondition(signal, '>=', 2147483649);
const lessEqual = NativeCondition(signal, '<=', -2147483649);
const notEqual = NativeCondition(signal, '!=', 5);
const values = [greater, less, equal, greaterEqual, lessEqual, notEqual];
if (values.map(({ kind }) => kind).join(',') !== 'native-condition,native-condition,native-condition,native-condition,native-condition,native-condition' ||
    values.map(({ condition }) => condition.comparator).join(',') !== '>,<,=,>=,<=,!=' ||
    greater.condition.signal.type !== 'virtual' || greater.condition.signal.name !== 'signal-A' ||
    greaterEqual.condition.constant !== -2147483647 || lessEqual.condition.constant !== 2147483647 ||
    !Object.isFrozen(greater) || !Object.isFrozen(greater.condition)) {
  throw new Error('NativeCondition was not canonicalized or frozen');
}`,
    });

    expect(compilation.pipelineDiagnostics).toEqual([]);
    expect(compilation.plan?.version).toBe(2);
  });

  test('evaluates NativeCondition arguments once and preserves ordinary object methods', () => {
    const compilation = compileSourceProgram({
      path: 'native-condition-evaluation.factorio.ts',
      text: `let order = '';
function sourceSignal() { order += 's'; return Signal('virtual', 'signal-A'); }
function sourceComparator() { order += 'c'; return '>'; }
function sourceConstant() { order += 'n'; return 7; }
const condition = NativeCondition(sourceSignal(), sourceComparator(), sourceConstant());
const ordinary = { NativeCondition(...values) { return values.length; } };
if (order !== 'scn' || condition.condition.constant !== 7 || ordinary.NativeCondition(1, 2, 3) !== 3) {
  throw new Error('NativeCondition evaluation order changed');
}`,
    });

    expect(compilation.pipelineDiagnostics).toEqual([]);
  });

  test('translates literal, dynamic, aliased, and spread Entity configuration forms', () => {
    const host = syntheticEntityHost(syntheticSharedTwoColorEntityProfile);
    const compilation = compileSourceProgram(
      {
        path: 'entity-configuration-source.factorio.ts',
        text: `const prototype = 'entity:synthetic-shared-two-color';
const rule = 'shared-circuit-condition';
const lanes = ['shared-red', 'shared-green'];
const signal = Signal('virtual', 'signal-A');
const condition = NativeCondition(signal, '>', 0);
const literal = Entity(prototype, { rule, lanes, condition });
const config = { rule, lanes: [...lanes], condition };
const aliased = Entity(prototype, config);
const spreadArgs = [prototype, config];
const spread = Entity(...spreadArgs);`,
      },
      host,
    );

    expect(compilation.pipelineDiagnostics).toEqual([]);
    const plan = compilation.plan;
    if (plan === undefined || plan.version !== 3) throw new Error('Expected an Entity v3 plan.');
    expect(plan.entities).toHaveLength(3);
    expect(plan.entities.map(({ configuration }) => configuration)).toEqual([
      {
        mode: 'typed',
        rule: 'shared-circuit-condition',
        lanes: ['shared-green', 'shared-red'],
        condition: {
          kind: 'compare-signal-constant',
          signal: { type: 'virtual', name: 'signal-A' },
          comparator: '>',
          constant: 0,
        },
      },
      {
        mode: 'typed',
        rule: 'shared-circuit-condition',
        lanes: ['shared-green', 'shared-red'],
        condition: {
          kind: 'compare-signal-constant',
          signal: { type: 'virtual', name: 'signal-A' },
          comparator: '>',
          constant: 0,
        },
      },
      {
        mode: 'typed',
        rule: 'shared-circuit-condition',
        lanes: ['shared-green', 'shared-red'],
        condition: {
          kind: 'compare-signal-constant',
          signal: { type: 'virtual', name: 'signal-A' },
          comparator: '>',
          constant: 0,
        },
      },
    ]);
  });

  test('carries configured placement through physical Entity replay and adapters', () => {
    const host = syntheticEntityHost(syntheticSharedTwoColorEntityProfile);
    const compilation = compileSourceProgram(
      {
        path: 'entity-physical-acceptance.factorio.ts',
        text: `const config = {
  rule: 'shared-circuit-condition',
  lanes: ['shared-red', 'shared-green'],
  condition: NativeCondition(Signal('virtual', 'signal-A'), '>=', 2),
};
function place(entity) { return entity.at(10.5, -2, 8); }
const machines = [Entity('entity:synthetic-shared-two-color', config)];
const selected = place(machines[0]);
for (const alias of [selected]) alias.at(10.5, -2, 8);
const input = new Network<R>();
selected.bind('shared', 'shared-red', input, 'input');`,
      },
      host,
    );

    expect(compilation.pipelineDiagnostics).toEqual([]);
    const plan = compilation.plan;
    const execution = compilation.execution;
    if (
      plan === undefined ||
      plan.version !== 3 ||
      execution === undefined ||
      !('entityObject' in execution)
    ) {
      throw new Error('Expected a host-bound Entity v3 execution.');
    }
    expect(structuredClone(plan)).toEqual(plan);
    expect(plan.producers).toHaveLength(0);
    expect(plan.networks).toHaveLength(1);
    expect(plan.entities).toHaveLength(1);
    expect(plan.entities[0]).toMatchObject({
      placement: { x: 10.5, y: -2, direction: 8 },
      configuration: {
        mode: 'typed',
        rule: 'shared-circuit-condition',
        lanes: ['shared-green', 'shared-red'],
        condition: {
          kind: 'compare-signal-constant',
          signal: { type: 'virtual', name: 'signal-A' },
          comparator: '>=',
          constant: 2,
        },
      },
      connectorBindings: [
        expect.objectContaining({
          endpoint: { connector: 'shared', lane: 'shared-red', color: 'red' },
          network: 'input',
          direction: 'input',
        }),
      ],
    });

    expect(execution.circuit.graph.producers).toHaveLength(0);
    expect(execution.circuit.ir.networks).toHaveLength(1);
    expect(execution.circuit.ir.entities).toHaveLength(1);
    const physical = execution.circuit.ir.entities[0]!;
    expect(physical.placement).toEqual({ x: 10.5, y: -2, direction: 8 });
    expect(physical.connectorBindings).toHaveLength(1);
    if (physical.configuration?.mode !== 'typed' || 'payload' in physical.configuration) {
      throw new Error('Expected resolved typed physical configuration.');
    }
    expect(physical.configuration).toMatchObject({
      rule: 'shared-circuit-condition',
      nativeField: 'control_behavior.circuit_condition',
      connector: 'shared',
      lanes: ['shared-green', 'shared-red'],
      laneMask: { red: true, green: true },
      condition: {
        signal: { type: 'virtual', name: 'signal-A' },
        comparator: '>=',
        constant: 2,
      },
    });
    expect(execution.entityObject(execution.createTestSession(), 1)).toMatchObject({
      adapterId: 'entity-physical-v3',
      instanceId: 'ordinal-1',
      connectors: ['shared'],
    });

    const blueprint = generateEntityBlueprintJson(execution.circuit.ir).blueprint;
    expect(blueprint.entities).toHaveLength(1);
    expect(blueprint.entities[0]).toMatchObject({
      entity_number: 1,
      name: 'synthetic-shared-two-color',
      position: { x: 10.5, y: -2 },
      direction: 8,
      control_behavior: {
        circuit_condition: {
          first_signal: { type: 'virtual', name: 'signal-A' },
          first_signal_networks: { red: true, green: true },
          comparator: '≥',
          constant: 2,
        },
      },
    });
    const replay = elaborateEntityDirectPlan(
      structuredClone(plan),
      host.trustedEntityReplayContext,
    );
    expect(replay.circuit.ir.entities).toEqual(execution.circuit.ir.entities);
    expect(replay.circuit.ir.networks).toEqual(execution.circuit.ir.networks);
  });

  test.each([
    {
      name: 'extra field',
      source: `const entity = Entity('entity:synthetic-shared-two-color', { rule: 'shared-circuit-condition', lanes: ['shared-red'], condition: NativeCondition(Signal('virtual', 'signal-A'), '>', 0), extra: true });`,
      message: 'Entity configuration has unknown field "extra".',
    },
    {
      name: 'accessor field',
      source: `const condition = NativeCondition(Signal('virtual', 'signal-A'), '>', 0);
const config = { rule: 'shared-circuit-condition', lanes: ['shared-red'], condition };
Object.defineProperty(config, 'condition', { get() { throw new Error('accessor evaluated'); } });
Entity('entity:synthetic-shared-two-color', config);`,
      message: 'Entity configuration field "condition" must be data-only.',
    },
    {
      name: 'symbol field',
      source: `const config = { rule: 'shared-circuit-condition', lanes: ['shared-red'], condition: NativeCondition(Signal('virtual', 'signal-A'), '>', 0) };
config[Symbol('extra')] = true;
Entity('entity:synthetic-shared-two-color', config);`,
      message: 'Entity configuration cannot contain symbol fields.',
    },
    {
      name: 'lane hole',
      source: `const lanes = [];
lanes.length = 1;
Entity('entity:synthetic-shared-two-color', { rule: 'shared-circuit-condition', lanes, condition: NativeCondition(Signal('virtual', 'signal-A'), '>', 0) });`,
      message: '$.configuration.lanes[0]: array holes are not allowed.',
    },
    {
      name: 'duplicate lane',
      source: `Entity('entity:synthetic-shared-two-color', { rule: 'shared-circuit-condition', lanes: ['shared-red', 'shared-red'], condition: NativeCondition(Signal('virtual', 'signal-A'), '>', 0) });`,
      message: 'duplicate input lane',
    },
    {
      name: 'unknown lane',
      source: `Entity('entity:synthetic-shared-two-color', { rule: 'shared-circuit-condition', lanes: ['shared-blue'], condition: NativeCondition(Signal('virtual', 'signal-A'), '>', 0) });`,
      message: 'not allowed by the rule feature',
    },
    {
      name: 'unknown rule',
      source: `Entity('entity:synthetic-shared-two-color', { rule: 'missing-rule', lanes: ['shared-red'], condition: NativeCondition(Signal('virtual', 'signal-A'), '>', 0) });`,
      message: 'unknown Entity configuration rule',
    },
    {
      name: 'structural condition',
      source: `Entity('entity:synthetic-shared-two-color', { rule: 'shared-circuit-condition', lanes: ['shared-red'], condition: { kind: 'native-condition', condition: {} } });`,
      message: 'condition must be a NativeCondition from this execution session.',
    },
  ])('rejects malformed public Entity configuration: $name', ({ source, message }) => {
    const host = syntheticEntityHost(syntheticSharedTwoColorEntityProfile);
    const compilation = compileSourceProgram(
      { path: 'entity-configuration-invalid.factorio.ts', text: source },
      host,
    );

    expect(compilation.plan).toBeUndefined();
    expect(compilation.pipelineDiagnostics).toEqual([
      expect.objectContaining({
        code: expect.stringMatching(/^(RT2027|EN1000)$/),
        message: expect.stringContaining(message),
      }),
    ]);
  });

  test('does not allocate an Entity before a caught configuration failure', () => {
    const host = syntheticEntityHost(syntheticSharedTwoColorEntityProfile);
    const compilation = compileSourceProgram(
      {
        path: 'entity-configuration-caught.factorio.ts',
        text: `let caught = false;
try {
  Entity('entity:synthetic-shared-two-color', { rule: 'shared-circuit-condition', lanes: ['shared-red'], condition: { kind: 'native-condition', condition: {} } });
} catch { caught = true; }
if (!caught) throw new Error('invalid Entity configuration was accepted');
const entity = Entity('entity:synthetic-shared-two-color', { rule: 'shared-circuit-condition', lanes: ['shared-red'], condition: NativeCondition(Signal('virtual', 'signal-A'), '>', 0) });`,
      },
      host,
    );

    expect(compilation.pipelineDiagnostics).toEqual([]);
    const plan = compilation.plan;
    if (plan === undefined || plan.version !== 3) throw new Error('Expected an Entity v3 plan.');
    expect(plan.entities).toHaveLength(1);
    expect(plan.entities[0]?.ordinal).toBe(1);
  });

  test('does not advance Entity provenance before a caught profile validation failure', () => {
    const host = syntheticEntityHost(syntheticSharedTwoColorEntityProfile);
    const compilation = compileSourceProgram(
      {
        path: 'entity-profile-validation-caught.factorio.ts',
        text: `try {
  Entity('entity:synthetic-shared-two-color', {
    rule: 'shared-circuit-condition',
    lanes: ['shared-blue'],
    condition: NativeCondition(Signal('virtual', 'signal-A'), '>', 0),
  });
} catch {}
const entity = Entity('entity:synthetic-shared-two-color');`,
      },
      host,
    );

    expect(compilation.pipelineDiagnostics).toEqual([]);
    const plan = compilation.plan;
    if (plan === undefined || plan.version !== 3) throw new Error('Expected an Entity v3 plan.');
    expect(plan.entities).toHaveLength(1);
    expect(plan.entities[0]).toMatchObject({
      ordinal: 1,
      provenance: { creationRevision: 1 },
    });
  });

  test('rejects typed public configuration without verified positive evidence', () => {
    const profile: EntityProfile = {
      ...syntheticSharedTwoColorEntityProfile,
      synthetic: false,
      configurationRules: syntheticSharedTwoColorEntityProfile.configurationRules.map((rule) => ({
        ...rule,
        evidence: { status: 'unknown' },
      })),
    };
    const host = syntheticEntityHost(profile, 'provider');
    const compilation = compileSourceProgram(
      {
        path: 'entity-configuration-evidence.factorio.ts',
        text: `Entity('entity:synthetic-shared-two-color', {
  rule: 'shared-circuit-condition',
  lanes: ['shared-red'],
  condition: NativeCondition(Signal('virtual', 'signal-A'), '>', 0),
});`,
      },
      host,
    );

    expect(compilation.plan).toBeUndefined();
    expect(compilation.pipelineDiagnostics).toEqual([
      expect.objectContaining({
        code: 'EN1000',
        message: expect.stringContaining('verified positive evidence'),
        span: expect.any(Object),
      }),
    ]);
  });

  test.each([
    {
      source: `NativeCondition();`,
      message: 'NativeCondition(signal, comparator, constant) requires exactly three arguments.',
    },
    {
      source: `NativeCondition(1, '>', 0);`,
      message: 'NativeCondition requires a concrete Signal from this execution session.',
    },
    {
      source: `NativeCondition(ANY, '>', 0);`,
      message: 'NativeCondition requires a concrete Signal from this execution session.',
    },
    {
      source: `NativeCondition(new Network(), '>', 0);`,
      message: 'NativeCondition requires a concrete Signal from this execution session.',
    },
    {
      source: `const signal = Signal('virtual', 'signal-A');
const foreign = structuredClone(signal);
NativeCondition(foreign, '>', 0);`,
      message: 'NativeCondition requires a concrete Signal from this execution session.',
    },
    {
      source: `NativeCondition(Signal('virtual', 'signal-A'), '==', 0);`,
      message: 'NativeCondition comparator must be one of >, <, =, >=, <=, !=.',
    },
    {
      source: `NativeCondition(Signal('virtual', 'signal-A'), '>', 1.5);`,
      message: 'NativeCondition constant must be a finite safe integer.',
    },
    {
      source: `NativeCondition(Signal('virtual', 'signal-A'), '>', Infinity);`,
      message: 'NativeCondition constant must be a finite safe integer.',
    },
  ])('rejects an invalid NativeCondition argument at its source span', ({ source, message }) => {
    const compilation = compileSourceProgram({
      path: 'native-condition-invalid.factorio.ts',
      text: source,
    });

    expect(compilation.pipelineDiagnostics).toEqual([
      expect.objectContaining({ code: 'RT2027', message, span: expect.any(Object) }),
    ]);
  });

  test.each([
    {
      source: `const entity = Entity('entity:synthetic-zero-port');
entity.at(1);`,
      message: 'Entity.at(x, y, direction?) requires two or three arguments.',
    },
    {
      source: `const entity = Entity('entity:synthetic-zero-port');
entity.at(1, Number.NaN);`,
      message: 'Entity.at(x, y, direction?) requires finite numeric coordinates.',
    },
    {
      source: `const entity = Entity('entity:synthetic-zero-port');
entity.at(1, 2, 1.5);`,
      message: 'Entity.at(...) direction must be an integer from 0 through 15.',
    },
    {
      source: `const entity = Entity('entity:synthetic-zero-port');
entity.at(1, 2, 16);`,
      message: 'Entity.at(...) direction must be an integer from 0 through 15.',
    },
  ])('reports invalid Entity placement at the call span', ({ source, message }) => {
    const host = syntheticEntityHost(syntheticZeroPortEntityProfile);
    const compilation = compileSourceProgram(
      { path: 'entity-placement-invalid.factorio.ts', text: source },
      host,
    );

    expect(compilation.pipelineDiagnostics).toEqual([
      expect.objectContaining({ code: 'RT2027', message, span: expect.any(Object) }),
    ]);
  });

  test('keeps ordinary object .at calls native', () => {
    const compilation = compileSourceProgram({
      path: 'ordinary-at-method.factorio.ts',
      text: `const ordinary = { at(...values) { return values; } };
const values = ordinary.at(1, 2, 3);
const tagged = { kind: 'entity', at(...items) { return items; } };
const taggedValues = tagged.at(4, 5);
if (values.length !== 3 || values[2] !== 3 || taggedValues[1] !== 5) throw new Error('ordinary .at was intercepted');`,
    });

    expect(compilation.pipelineDiagnostics).toEqual([]);
    expect(compilation.plan?.version).toBe(2);
  });

  test('keeps Entity authority out of the transport-only source path', () => {
    const compilation = compileSourceProgram({
      path: 'entity-without-host.factorio.ts',
      text: `const entity = Entity('entity:synthetic-zero-port');`,
    });

    expect(compilation.plan).toBeUndefined();
    expect(compilation.pipelineDiagnostics).toEqual([
      expect.objectContaining({ code: 'RT2027', severity: 'error' }),
    ]);
  });

  test.each([
    {
      method: 'constructor',
      source: `Entity();`,
      message: 'Entity(prototype, configuration?) requires one or two arguments.',
    },
    {
      method: 'constructor',
      source: `Entity('entity:synthetic-shared-two-color', {}, {});`,
      message: 'Entity(prototype, configuration?) requires one or two arguments.',
    },
    {
      method: 'port',
      source: `const entity = Entity('entity:synthetic-shared-two-color');
entity.port('shared');`,
      message: 'Entity.port(connector, lane) requires exactly two arguments.',
    },
    {
      method: 'bind',
      source: `const entity = Entity('entity:synthetic-shared-two-color');
entity.bind('shared', 'shared-red', new Network<R>());`,
      message: 'Entity.bind(connector, lane, network, direction) requires exactly four arguments.',
    },
  ])('validates public Entity.$method arity at the source span', ({ method, source, message }) => {
    const host = syntheticEntityHost(syntheticSharedTwoColorEntityProfile);
    const compilation = compileSourceProgram(
      {
        path: `entity-${method}-arity.factorio.ts`,
        text: source,
      },
      host,
    );

    expect(compilation.pipelineDiagnostics).toEqual([
      expect.objectContaining({ code: 'RT2027', message, span: expect.any(Object) }),
    ]);
  });

  test('leaves ordinary object methods named port and bind outside Entity dispatch', () => {
    const compilation = compileSourceProgram({
      path: 'ordinary-port-method.factorio.ts',
      text: `const ordinary = {
  port(value: number): number { return value + 1; },
  bind(value: number): number { return value + 2; },
};
if (ordinary.port(2) !== 3 || ordinary.bind(2) !== 4) throw new Error('wrong method');`,
    });

    expect(compilation.pipelineDiagnostics).toEqual([]);
    expect(compilation.plan?.version).toBe(2);
  });

  test('accepts a provider-owned prototype name and exact provider record identity', async () => {
    const loaded = await loadPrototypeDatabase(syntheticPrototypeDatabase());
    const profile: EntityProfile = {
      ...syntheticZeroPortEntityProfile,
      ref: {
        ...syntheticZeroPortEntityProfile.ref,
        prototypeKey: 'entity:assembling-machine-3',
        database: {
          schemaVersion: loaded.database.schemaVersion,
          identity: loaded.prototypes.identity,
        },
      },
    };
    const trustedEntityReplayContext = createTrustedEntityReplayContext({
      database: profile.ref.database,
      source: 'provider',
      evidenceIdentity: 'provider-evidence-v1',
      policyIdentity: 'provider-policy-v1',
      profiles: [profile],
    });
    const compilation = compileSourceProgram(
      {
        path: 'provider-entity-source.factorio.ts',
        text: `const byName = Entity('assembling-machine-3');
const byRecord = Entity(prototypes.entity['assembling-machine-3']);`,
      },
      { prototypes: loaded.prototypes, trustedEntityReplayContext },
    );

    expect(compilation.pipelineDiagnostics).toEqual([]);
    const plan = compilation.plan;
    if (plan === undefined || plan.version !== 3)
      throw new Error('Expected a provider Entity v3 plan.');
    expect(plan.version).toBe(3);
    expect(plan.entities).toHaveLength(2);
    expect(plan.entities.map(({ profile: entityProfile }) => entityProfile)).toEqual([
      profile.ref,
      profile.ref,
    ]);
  });

  test('rejects ambiguous trusted profiles and foreign provider records', async () => {
    const host = syntheticEntityHost(syntheticZeroPortEntityProfile);
    const secondProfile: EntityProfile = {
      ...syntheticZeroPortEntityProfile,
      ref: {
        ...syntheticZeroPortEntityProfile.ref,
        profileId: 'profile:synthetic-zero-port-v2' as EntityProfile['ref']['profileId'],
      },
    };
    const ambiguous = createTrustedEntityReplayContext({
      ...host.trustedEntityReplayContext,
      profiles: [syntheticZeroPortEntityProfile, secondProfile],
    });
    const ambiguousCompilation = compileSourceProgram(
      {
        path: 'ambiguous-entity.factorio.ts',
        text: `const entity = Entity('synthetic-zero-port');`,
      },
      { ...host, trustedEntityReplayContext: ambiguous },
    );
    expect(ambiguousCompilation.pipelineDiagnostics).toEqual([
      expect.objectContaining({ code: 'RT2027', message: expect.stringContaining('ambiguous') }),
    ]);

    const loaded = await loadPrototypeDatabase(syntheticPrototypeDatabase());
    const profile: EntityProfile = {
      ...syntheticZeroPortEntityProfile,
      ref: {
        ...syntheticZeroPortEntityProfile.ref,
        prototypeKey: 'entity:assembling-machine-3',
        database: {
          schemaVersion: loaded.database.schemaVersion,
          identity: loaded.prototypes.identity,
        },
      },
    };
    const trustedEntityReplayContext = createTrustedEntityReplayContext({
      database: profile.ref.database,
      source: 'provider',
      evidenceIdentity: 'provider-evidence-v1',
      policyIdentity: 'provider-policy-v1',
      profiles: [profile],
    });
    const foreign = compileSourceProgram(
      {
        path: 'foreign-entity-record.factorio.ts',
        text: `const clone = {
  key: 'entity:assembling-machine-3',
  name: 'assembling-machine-3',
  type: 'assembling-machine',
};
const entity = Entity(clone);`,
      },
      { prototypes: loaded.prototypes, trustedEntityReplayContext },
    );
    expect(foreign.pipelineDiagnostics).toEqual([
      expect.objectContaining({ code: 'RT2027', message: expect.stringContaining('foreign') }),
    ]);
  });

  test('runs every compilation stage and core lowering exactly once', () => {
    const stages: SourceCompilationStage[] = [];
    const compilation = compileSourceProgram(
      {
        path: 'shared.factorio.ts',
        text: `const input = new Network();
const output = new Network();
output += input + 1;`,
      },
      {},
      [],
      (stage) => stages.push(stage),
    );

    expect(compilation.pipelineDiagnostics).toEqual([]);
    expect(compilation.execution?.circuit.graph.producers).toHaveLength(1);
    expect(stages).toEqual(['parse', 'semantic', 'transform', 'execute', 'lower']);
    expect(stages.filter((stage) => stage === 'lower')).toHaveLength(1);
  });

  test('compiles every supported CC source form through the shared host service', () => {
    const compilation = compileSourceProgram({
      path: 'ordered-constant.factorio.ts',
      text: `const A = Signal('virtual', 'signal-A');
const sameA = Signal('virtual', 'signal-A');
const B = Signal('virtual', 'signal-B', 'legendary');
const output = new Network();
output += CC(
  1 * A,
  [sameA, 2],
  [[B, 3]],
  new Map([[A, 4], [sameA, 5], ['iron-plate', 6]]),
  { [B]: 7, 'copper-plate': 0 },
);`,
    });

    expect(compilation.pipelineDiagnostics.filter(({ severity }) => severity === 'error')).toEqual(
      [],
    );
    expect(compilation.execution).toBeDefined();
    const producers = compilation.execution!.circuit.graph.producers;
    expect(producers).toHaveLength(1);
    expect(producers[0]).toMatchObject({ kind: 'constant' });

    const producer = producers[0]!;
    if (producer.kind !== 'constant') throw new Error('Expected one constant producer.');
    expect(
      producer.config.outputs.map(({ signal, value }) => [
        signal.type,
        signal.name,
        signal.quality,
        value,
      ]),
    ).toEqual([
      ['virtual', 'signal-A', undefined, 1],
      ['virtual', 'signal-A', undefined, 2],
      ['virtual', 'signal-B', 'legendary', 3],
      ['virtual', 'signal-A', undefined, 4],
      ['virtual', 'signal-A', undefined, 5],
      ['item', 'iron-plate', undefined, 6],
      ['virtual', 'signal-B', 'legendary', 7],
      ['item', 'copper-plate', undefined, 0],
    ]);

    const [first, second, , fourth, fifth] = producer.config.outputs;
    expect(first!.signal).not.toBe(second!.signal);
    expect(first!.signal).not.toBe(fifth!.signal);
    expect(first!.signal).toEqual(second!.signal);
    expect(first!.signal).toEqual(fifth!.signal);
  });

  test('separates host-local execution from a structured-clone-safe artifact', () => {
    const compilation = compileSourceProgram({
      path: 'transport.factorio.ts',
      text: 'const output = new Network();',
    });
    const artifact = sourceCompilationArtifact(compilation);

    expect(compilation.execution).toBeDefined();
    expect(artifact).not.toHaveProperty('execution');
    expect(artifact).not.toHaveProperty('resolvedCircuit');
    expect(structuredClone(artifact)).toEqual(artifact);
  });

  test('threads only the cloneable v3 replay context through the source artifact', () => {
    const trusted = createTrustedEntityReplayContext({
      database: syntheticZeroPortEntityProfile.ref.database,
      source: 'synthetic',
      evidenceIdentity: 'comblang-synthetic-evidence-v1',
      policyIdentity: 'comblang-entity-policy-v1',
      profiles: [syntheticZeroPortEntityProfile],
    });
    const entityReplayContext = entityReplayContextTransport(trusted);
    const compilation = compileSourceProgram(
      { path: 'transport-v3.factorio.ts', text: 'const output = new Network();' },
      { entityReplayContext },
    );
    const artifact = sourceCompilationArtifact(compilation);

    expect(artifact.entityReplayContext).toEqual(entityReplayContext);
    expect(artifact.entityReplayIdentity).toContain('comblang-synthetic-evidence-v1');
    expect(artifact.resolvedCircuit).toBeUndefined();
    expect(structuredClone(artifact)).toEqual(artifact);
    expect(compilation).not.toHaveProperty('entityRegistry');
  });

  test('does not emit resolved physical data for an identity-only Entity request', () => {
    const trusted = createTrustedEntityReplayContext({
      database: syntheticZeroPortEntityProfile.ref.database,
      source: 'synthetic',
      evidenceIdentity: 'comblang-synthetic-evidence-v1',
      policyIdentity: 'comblang-entity-policy-v1',
      profiles: [syntheticZeroPortEntityProfile],
    });
    const compilation = compileSourceProgram(
      {
        path: 'identity-only-v3.factorio.ts',
        text: "const entity = Entity('entity:synthetic-zero-port');",
      },
      { entityReplayContext: entityReplayContextTransport(trusted) },
    );

    expect(compilation.resolvedCircuit).toBeUndefined();
    expect(compilation.plan).toBeUndefined();
    expect(compilation.pipelineDiagnostics).toEqual([expect.objectContaining({ code: 'RT2027' })]);
  });

  test('requires trusted profile-set binding for provider contexts and verifies provider identity/schema', async () => {
    const loaded = await loadPrototypeDatabase(syntheticPrototypeDatabase());
    const profile = JSON.parse(JSON.stringify(syntheticZeroPortEntityProfile)) as any;
    profile.ref.database = {
      schemaVersion: loaded.database.schemaVersion,
      identity: loaded.prototypes.identity,
    };
    const trusted = createTrustedEntityReplayContext({
      database: profile.ref.database,
      source: 'provider',
      evidenceIdentity: 'provider-evidence-v1',
      policyIdentity: 'provider-policy-v1',
      profiles: [profile],
    });
    const source = { path: 'provider-context.factorio.ts', text: 'const output = new Network();' };

    expect(
      compileSourceProgram(source, {
        prototypes: loaded.prototypes,
        trustedEntityReplayContext: trusted,
      }).entityReplayContext,
    ).toEqual(entityReplayContextTransport(trusted));
    expect(() =>
      compileSourceProgram(source, {
        prototypes: loaded.prototypes,
        entityReplayContext: entityReplayContextTransport(trusted),
      }),
    ).toThrowError(expect.objectContaining({ code: 'ER1001' }));

    const wrongProviderContext = createTrustedEntityReplayContext({
      database: { schemaVersion: loaded.database.schemaVersion, identity: 'database-other' },
      source: 'provider',
      evidenceIdentity: 'provider-evidence-v1',
      policyIdentity: 'provider-policy-v1',
      profiles: [
        {
          ...profile,
          ref: {
            ...profile.ref,
            database: { schemaVersion: loaded.database.schemaVersion, identity: 'database-other' },
          },
        },
      ],
    });
    expect(() =>
      compileSourceProgram(source, {
        prototypes: loaded.prototypes,
        trustedEntityReplayContext: wrongProviderContext,
      }),
    ).toThrowError(expect.objectContaining({ code: 'ER1001' }));
  });

  test('retains prototype identity and earlier warnings when execution fails', async () => {
    const { prototypes } = await loadPrototypeDatabase(syntheticPrototypeDatabase());
    const fileId = sourceFileId('failure.factorio.ts');
    const preflight: Diagnostic = {
      code: 'ENV_WARNING',
      severity: 'warning',
      message: 'Selected test environment.',
      span: sourceSpan(fileId, 0, 8),
    };
    const stages: SourceCompilationStage[] = [];
    const compilation = compileSourceProgram(
      {
        path: 'failure.factorio.ts',
        text: `throw new Error('stop');`,
      },
      { prototypes },
      [preflight],
      (stage) => stages.push(stage),
    );

    expect(compilation.prototypeIdentity).toBe(prototypes.identity);
    expect(compilation.plan).toBeUndefined();
    expect(compilation.resolvedCircuit).toBeUndefined();
    expect(compilation.pipelineDiagnostics.map(({ code }) => code)).toEqual([
      'ENV_WARNING',
      'EX1001',
    ]);
    expect(stages).toEqual(['parse', 'semantic', 'transform', 'execute']);
  });

  test('still emits transformed JavaScript but skips execution after a preflight error', () => {
    const stages: SourceCompilationStage[] = [];
    const compilation = compileSourceProgram(
      { path: 'blocked.factorio.ts', text: 'throw new Error("must not run");' },
      {},
      [{ code: 'ENV_ERROR', severity: 'error', message: 'Invalid environment.' }],
      (stage) => stages.push(stage),
    );

    expect(compilation.elaborationJavaScript).toContain('must not run');
    expect(compilation.pipelineDiagnostics.map(({ code }) => code)).toEqual(['ENV_ERROR']);
    expect(stages).toEqual(['parse', 'semantic', 'transform']);
  });
});

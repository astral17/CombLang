import {
  loadPrototypeDatabase,
  loadPrototypeInputJson,
  syntheticPrototypeDatabase,
  type EntityPrototype,
} from '@comblang/prototypes';
import { sourceFileId, sourceSpan, type Diagnostic } from '@comblang/shared';
import { SparseBus } from '@comblang/factorio';
import {
  generateEntityBlueprintJson,
  generateEntityComputationBlueprintJson,
} from '@comblang/compiler/blueprint-json';
import type { EntityProfile, NativeCircuitIrV3 } from '@comblang/compiler/entity';
import type { NativeCircuitIrV4 } from '@comblang/compiler/entity-v4';
import { resolvedSourceCircuitPlanFingerprint } from '@comblang/compiler/resolved-source-circuit';
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

function syntheticTypedLampHost() {
  const prototypeKey = 'entity:synthetic-lamp' as EntityPrototype['key'];
  const profile: EntityProfile = {
    ...syntheticSharedTwoColorEntityProfile,
    ref: { ...syntheticSharedTwoColorEntityProfile.ref, prototypeKey },
  };
  const prototype = {
    key: prototypeKey,
    name: 'synthetic-lamp',
    type: 'lamp',
  } satisfies EntityPrototype;
  const trustedEntityReplayContext = createTrustedEntityReplayContext({
    database: profile.ref.database,
    source: 'synthetic',
    evidenceIdentity: 'comblang-synthetic-evidence-v1',
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
  test('reports final v2 Decider mode failures at the offending row', () => {
    const path = 'v2-decider-mode-row.factorio.ts';
    const text = `const A = Signal('virtual', 'signal-A');
const input = new Network();
const output: Network = IF(input[A] > 0, Each(input));`;
    const result = compileSourceProgram({ path, text });
    const start = text.indexOf('Each(input)');

    expect(result.plan).toBeUndefined();
    expect(result.pipelineDiagnostics).toEqual([
      expect.objectContaining({
        code: 'RT2027',
        message: expect.stringContaining('Decider Each output'),
        span: {
          fileId: sourceFileId(path),
          start,
          end: start + 'Each(input)'.length,
        },
        related: [
          expect.objectContaining({
            message: 'Physical combinator was created here.',
            span: expect.any(Object),
          }),
        ],
      }),
    ]);
  });

  test('resolves Lamp from short, canonical, and exact provider-owned prototype forms', async () => {
    const { prototypes } = await loadPrototypeDatabase(builtinPrototypeDatabase);
    const provisioned = new EntityProvisioningService().provision(
      prototypes,
      conservativeEntityProvisioningPolicy,
    );
    const compilation = compileSourceProgram(
      {
        path: 'lamp-prototype-forms.factorio.ts',
        text: `const short = Lamp('small-lamp');
const canonical = Lamp('entity:small-lamp');
const record = Lamp(prototypes.entity['small-lamp']);`,
      },
      {
        prototypes,
        trustedEntityReplayContext: provisioned.trustedEntityReplayContext,
        entityPrototypeResolver: provisioned.entityPrototypeResolver,
      },
    );

    expect(compilation.pipelineDiagnostics).toEqual([]);
    const plan = compilation.plan;
    if (plan === undefined || plan.version !== 3) throw new Error('Expected a Lamp Entity plan.');
    expect(plan.entities).toHaveLength(3);
    expect(plan.entities.map(({ profile }) => profile.prototypeKey)).toEqual([
      'entity:small-lamp',
      'entity:small-lamp',
      'entity:small-lamp',
    ]);
  });

  test('evaluates Lamp arguments once in JavaScript order and allocates one Entity', async () => {
    const { prototypes } = await loadPrototypeDatabase(builtinPrototypeDatabase);
    const provisioned = new EntityProvisioningService().provision(
      prototypes,
      conservativeEntityProvisioningPolicy,
    );
    const compilation = compileSourceProgram(
      {
        path: 'lamp-argument-order.factorio.ts',
        text: `let order = '';
function selectPrototype() { order += 'p'; return 'small-lamp'; }
function selectConfiguration() { order += 'c'; return { always_on: false }; }
const lamp = Lamp(selectPrototype(), selectConfiguration());
if (order !== 'pc') throw new Error('Lamp arguments changed order');`,
      },
      {
        prototypes,
        trustedEntityReplayContext: provisioned.trustedEntityReplayContext,
        entityPrototypeResolver: provisioned.entityPrototypeResolver,
      },
    );

    expect(compilation.pipelineDiagnostics).toEqual([]);
    const plan = compilation.plan;
    if (plan === undefined || plan.version !== 3) throw new Error('Expected a Lamp Entity plan.');
    expect(plan.entities).toHaveLength(1);
    expect(plan.entities[0]?.configuration).toEqual({
      mode: 'raw',
      payload: { always_on: false },
    });
  });

  test.each([
    {
      name: 'missing prototype',
      source: `Lamp('missing-lamp');`,
      message: 'Entity prototype is malformed or unavailable',
    },
    {
      name: 'foreign prototype record',
      source: `Lamp({ key: 'entity:small-lamp', name: 'small-lamp', type: 'lamp' });`,
      message: 'foreign or not owned by the selected host provider',
    },
  ])('rejects Lamp with a $name', async ({ source, message }) => {
    const { prototypes } = await loadPrototypeDatabase(builtinPrototypeDatabase);
    const provisioned = new EntityProvisioningService().provision(
      prototypes,
      conservativeEntityProvisioningPolicy,
    );
    const compilation = compileSourceProgram(
      { path: 'lamp-invalid-prototype.factorio.ts', text: source },
      {
        prototypes,
        trustedEntityReplayContext: provisioned.trustedEntityReplayContext,
        entityPrototypeResolver: provisioned.entityPrototypeResolver,
      },
    );

    expect(compilation.plan).toBeUndefined();
    expect(compilation.pipelineDiagnostics).toEqual([
      expect.objectContaining({ code: 'RT2027', message: expect.stringContaining(message) }),
    ]);
  });

  test('rejects a non-lamp prototype at the prototype argument span', async () => {
    const { prototypes } = await loadPrototypeDatabase(builtinPrototypeDatabase);
    const provisioned = new EntityProvisioningService().provision(
      prototypes,
      conservativeEntityProvisioningPolicy,
    );
    const text = `Lamp('assembling-machine-3');`;
    const compilation = compileSourceProgram(
      { path: 'lamp-wrong-family.factorio.ts', text },
      {
        prototypes,
        trustedEntityReplayContext: provisioned.trustedEntityReplayContext,
        entityPrototypeResolver: provisioned.entityPrototypeResolver,
      },
    );

    const start = text.indexOf("'assembling-machine-3'");
    expect(compilation.pipelineDiagnostics).toEqual([
      expect.objectContaining({
        code: 'RT2027',
        message: expect.stringMatching(/expected|requires provider Entity type "lamp"/),
        span: {
          fileId: 'file:lamp-wrong-family.factorio.ts',
          start,
          end: start + "'assembling-machine-3'".length,
        },
      }),
    ]);
    expect(compilation.pipelineDiagnostics[0]?.message).toContain(
      'actual type "assembling-machine"',
    );
  });

  test.each([`Lamp();`, `Lamp('small-lamp', {}, 'extra');`])(
    'validates public Lamp constructor arity at the call span: %s',
    async (text) => {
      const { prototypes } = await loadPrototypeDatabase(builtinPrototypeDatabase);
      const provisioned = new EntityProvisioningService().provision(
        prototypes,
        conservativeEntityProvisioningPolicy,
      );
      const compilation = compileSourceProgram(
        { path: 'lamp-arity.factorio.ts', text },
        {
          prototypes,
          trustedEntityReplayContext: provisioned.trustedEntityReplayContext,
          entityPrototypeResolver: provisioned.entityPrototypeResolver,
        },
      );

      expect(compilation.pipelineDiagnostics).toEqual([
        expect.objectContaining({
          code: 'RT2027',
          message: 'Lamp(prototype, configuration?) requires one or two arguments.',
          span: { fileId: 'file:lamp-arity.factorio.ts', start: 0, end: text.length - 1 },
        }),
      ]);
    },
  );

  test('keeps Lamp and Entity physically identical through replay, IR, debug, and blueprint preview', async () => {
    const { prototypes } = await loadPrototypeDatabase(builtinPrototypeDatabase);
    const provisioned = new EntityProvisioningService().provision(
      prototypes,
      conservativeEntityProvisioningPolicy,
    );
    const compilation = compileSourceProgram(
      {
        path: 'lamp-physical-parity.factorio.ts',
        text: `const signal = Signal('virtual', 'signal-A');
const configuration = {
  always_on: false,
  color: { r: 0, g: 0.25, b: 1, a: 0 },
  control_behavior: { circuit_enabled: false, use_colors: false, red_signal: signal },
};
const facade = Lamp('small-lamp', configuration).at(4, 5, 8);
const aliases = [facade];
if (!Object.is(aliases[0], facade)) throw new Error('Lamp alias changed identity');
const generic = Entity('small-lamp', configuration).at(4, 5, 8);`,
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
    if (
      plan === undefined ||
      plan.version !== 3 ||
      execution === undefined ||
      !('entityObject' in execution)
    ) {
      throw new Error('Expected a resolved Lamp Entity execution.');
    }
    expect(plan.entities).toHaveLength(2);
    expect(plan.producers).toEqual([]);
    expect(plan.networks).toEqual([]);
    expect(plan.entities[0]?.profile).toEqual(plan.entities[1]?.profile);
    expect(plan.entities[0]?.configuration).toEqual(plan.entities[1]?.configuration);
    expect(plan.entities[0]?.placement).toEqual(plan.entities[1]?.placement);
    expect(plan.entities.every(({ connectorBindings }) => connectorBindings.length === 0)).toBe(
      true,
    );

    const resolved = compilation.resolvedCircuit;
    if (resolved === undefined) throw new Error('Expected a resolved Lamp circuit.');
    expect(resolved.ir.entities).toHaveLength(2);
    expect(resolved.ir.producers).toEqual([]);
    expect(resolved.ir.entities[0]?.profile).toEqual(resolved.ir.entities[1]?.profile);
    expect(resolved.ir.entities[0]?.configuration).toEqual(resolved.ir.entities[1]?.configuration);
    expect(resolved.ir.entities[0]?.placement).toEqual(resolved.ir.entities[1]?.placement);

    const document = createDebugDocument(execution.debug, execution.circuit.graph);
    expect(
      document.scopes.flatMap((scope) => ('entities' in scope ? scope.entities : [])),
    ).toHaveLength(2);
    const blueprint = generateEntityBlueprintJson(
      execution.circuit.ir as NativeCircuitIrV3,
    ).blueprint;
    expect(blueprint.entities).toHaveLength(2);
    expect({ ...blueprint.entities[0], entity_number: 0 }).toEqual({
      ...blueprint.entities[1],
      entity_number: 0,
    });
  });

  test('preserves checked and raw Lamp configuration while rejecting mixed envelopes', async () => {
    const { prototypes } = await loadPrototypeDatabase(builtinPrototypeDatabase);
    const provisioned = new EntityProvisioningService().provision(
      prototypes,
      conservativeEntityProvisioningPolicy,
    );
    const compilation = compileSourceProgram(
      {
        path: 'lamp-configuration-forms.factorio.ts',
        text: `const signal = Signal('virtual', 'signal-A');
const checked = Lamp('small-lamp', {
  always_on: false,
  color: [0, 0.5, 1, 0],
  control_behavior: { circuit_enabled: false, red_signal: signal },
});
const raw = Lamp('small-lamp', { raw: { always_on: false } });`,
      },
      {
        prototypes,
        trustedEntityReplayContext: provisioned.trustedEntityReplayContext,
        entityPrototypeResolver: provisioned.entityPrototypeResolver,
      },
    );

    expect(compilation.pipelineDiagnostics).toEqual([]);
    const plan = compilation.plan;
    if (plan === undefined || plan.version !== 3) throw new Error('Expected Lamp configurations.');
    expect(plan.entities.map(({ configuration }) => configuration)).toEqual([
      {
        mode: 'raw',
        payload: {
          always_on: false,
          color: [0, 0.5, 1, 0],
          control_behavior: {
            circuit_enabled: false,
            red_signal: { type: 'virtual', name: 'signal-A' },
          },
        },
      },
      { mode: 'raw', payload: { always_on: false } },
    ]);

    const mixedText = `Lamp('small-lamp', { raw: {}, always_on: false });`;
    const mixed = compileSourceProgram(
      { path: 'lamp-mixed-configuration.factorio.ts', text: mixedText },
      {
        prototypes,
        trustedEntityReplayContext: provisioned.trustedEntityReplayContext,
        entityPrototypeResolver: provisioned.entityPrototypeResolver,
      },
    );
    const configurationStart = mixedText.indexOf('{');
    const configurationEnd = mixedText.lastIndexOf('}') + 1;
    expect(mixed.pipelineDiagnostics).toEqual([
      expect.objectContaining({
        code: 'RT2027',
        message: expect.stringContaining('must use one exact legacy form'),
        span: {
          fileId: 'file:lamp-mixed-configuration.factorio.ts',
          start: configurationStart,
          end: configurationEnd,
        },
      }),
    ]);
  });

  test('routes reviewed-profile typed Lamp configuration through the shared Entity path', () => {
    const host = syntheticTypedLampHost();
    const compilation = compileSourceProgram(
      {
        path: 'lamp-typed-configuration.factorio.ts',
        text: `const lamp = Lamp('synthetic-lamp', {
  rule: 'shared-circuit-condition',
  lanes: ['shared-red'],
  condition: NativeCondition(Signal('virtual', 'signal-A'), '>', 0),
});`,
      },
      host,
    );

    expect(compilation.pipelineDiagnostics).toEqual([]);
    const plan = compilation.plan;
    if (plan === undefined || plan.version !== 3) throw new Error('Expected typed Lamp Entity.');
    expect(plan.entities[0]?.configuration).toMatchObject({
      mode: 'typed',
      rule: 'shared-circuit-condition',
      lanes: ['shared-red'],
    });
  });

  test.each([
    {
      name: 'unknown nested field',
      configuration: `{ control_behavior: { invented: true } }`,
      message: '$.control_behavior.invented',
    },
    {
      name: 'wrong field type',
      configuration: `{ always_on: 0 }`,
      message: '$.always_on: expected a boolean',
    },
  ])('rejects Lamp checked configuration with an $name', async ({ configuration, message }) => {
    const { prototypes } = await loadPrototypeDatabase(builtinPrototypeDatabase);
    const provisioned = new EntityProvisioningService().provision(
      prototypes,
      conservativeEntityProvisioningPolicy,
    );
    const text = `Lamp('small-lamp', ${configuration});`;
    const compilation = compileSourceProgram(
      { path: 'lamp-invalid-checked-configuration.factorio.ts', text },
      {
        prototypes,
        trustedEntityReplayContext: provisioned.trustedEntityReplayContext,
        entityPrototypeResolver: provisioned.entityPrototypeResolver,
      },
    );

    const configurationStart = text.indexOf(configuration);
    expect(compilation.plan).toBeUndefined();
    expect(compilation.pipelineDiagnostics).toEqual([
      expect.objectContaining({
        code: 'RT2027',
        message: expect.stringContaining(message),
        span: {
          fileId: 'file:lamp-invalid-checked-configuration.factorio.ts',
          start: configurationStart,
          end: configurationStart + configuration.length,
        },
      }),
    ]);
  });

  test('rolls back a caught Lamp configuration failure before allocating a valid Entity', async () => {
    const { prototypes } = await loadPrototypeDatabase(builtinPrototypeDatabase);
    const provisioned = new EntityProvisioningService().provision(
      prototypes,
      conservativeEntityProvisioningPolicy,
    );
    const compilation = compileSourceProgram(
      {
        path: 'lamp-configuration-rollback.factorio.ts',
        text: `let caught = false;
try { Lamp('assembling-machine-3'); } catch { caught = true; }
try { Lamp('small-lamp', { always_on: 0 }); } catch { caught = true; }
if (!caught) throw new Error('invalid Lamp configuration was accepted');
Lamp('small-lamp', { always_on: false });`,
      },
      {
        prototypes,
        trustedEntityReplayContext: provisioned.trustedEntityReplayContext,
        entityPrototypeResolver: provisioned.entityPrototypeResolver,
      },
    );

    expect(compilation.pipelineDiagnostics).toEqual([]);
    const plan = compilation.plan;
    if (plan === undefined || plan.version !== 3) throw new Error('Expected recovered Lamp plan.');
    expect(plan.entities).toHaveLength(1);
    expect(plan.entities[0]?.id).toBe('entity:1');
    expect(plan.networks).toEqual([]);
    expect(plan.producers).toEqual([]);
  });

  test.each([
    {
      name: 'port',
      source: `Lamp('small-lamp').port('circuit', 'red');`,
      message: 'Unknown Entity connector',
      code: 'RT2031',
    },
    {
      name: 'bind',
      source: `Lamp('small-lamp').bind('circuit', 'red', new Network(), 'input');`,
      message: 'Unknown Entity connector',
      code: 'RT2031',
    },
    {
      name: 'call projection',
      source: `Lamp('small-lamp')(new Network());`,
      message: 'has no callable projection',
      code: 'RT2027',
    },
  ])('does not grant fallback Lamp $name authority', async ({ source, message, code }) => {
    const { prototypes } = await loadPrototypeDatabase(builtinPrototypeDatabase);
    const provisioned = new EntityProvisioningService().provision(
      prototypes,
      conservativeEntityProvisioningPolicy,
    );
    const compilation = compileSourceProgram(
      { path: 'lamp-fallback-authority.factorio.ts', text: source },
      {
        prototypes,
        trustedEntityReplayContext: provisioned.trustedEntityReplayContext,
        entityPrototypeResolver: provisioned.entityPrototypeResolver,
      },
    );

    expect(compilation.plan).toBeUndefined();
    expect(compilation.pipelineDiagnostics).toEqual([
      expect.objectContaining({ code, message: expect.stringContaining(message) }),
    ]);
  });

  test('resolves Roboport through short, canonical, and provider-record forms', async () => {
    const { prototypes } = await loadPrototypeDatabase(builtinPrototypeDatabase);
    const provisioned = new EntityProvisioningService().provision(
      prototypes,
      conservativeEntityProvisioningPolicy,
    );
    const compilation = compileSourceProgram(
      {
        path: 'roboport-prototype-forms.factorio.ts',
        text: `const short = Roboport('roboport');
const canonical = Roboport('entity:roboport');
const record = Roboport(prototypes.entity['roboport']);`,
      },
      {
        prototypes,
        trustedEntityReplayContext: provisioned.trustedEntityReplayContext,
        entityPrototypeResolver: provisioned.entityPrototypeResolver,
      },
    );

    expect(compilation.pipelineDiagnostics).toEqual([]);
    const plan = compilation.plan;
    if (plan === undefined || plan.version !== 3)
      throw new Error('Expected a Roboport Entity plan.');
    expect(plan.entities).toHaveLength(3);
    expect(plan.entities.map(({ profile }) => profile.prototypeKey)).toEqual([
      'entity:roboport',
      'entity:roboport',
      'entity:roboport',
    ]);
  });

  test('preserves Roboport schema configuration and one physical Entity', async () => {
    const { prototypes } = await loadPrototypeDatabase(builtinPrototypeDatabase);
    const provisioned = new EntityProvisioningService().provision(
      prototypes,
      conservativeEntityProvisioningPolicy,
    );
    const text = `let order = '';
function selectPrototype() { order += 'p'; return 'roboport'; }
function selectConfiguration() { order += 'c'; return {
  control_behavior: {
    read_items_mode: false,
    read_robot_stats: false,
    output_networks: { red: false, green: true },
    roboport_count_output_signal: Signal('virtual', 'signal-A'),
    available_logistic_output_signal: { name: 'signal-B' },
  },
  request_filters: {
    request_from_buffers: false,
    trash_not_requested: false,
    sections: [{
      active: false,
      index: 0,
      multiplier: 0,
      filters: [{ name: 'iron-plate', count: 0, index: 0, quality: 'normal', request_from: 'planet', type: 'item' }],
    }],
  },
}; }
const facade = Roboport(selectPrototype(), selectConfiguration()).at(4, 5, 8);
const aliases = [facade];
if (order !== 'pc' || !Object.is(aliases[0], facade)) throw new Error('Roboport evaluation or identity changed');
const generic = Entity('roboport', selectConfiguration()).at(4, 5, 8);`;
    const compilation = compileSourceProgram(
      { path: 'roboport-configuration.factorio.ts', text },
      {
        prototypes,
        trustedEntityReplayContext: provisioned.trustedEntityReplayContext,
        entityPrototypeResolver: provisioned.entityPrototypeResolver,
      },
    );

    expect(compilation.pipelineDiagnostics).toEqual([]);
    const plan = compilation.plan;
    if (plan === undefined || plan.version !== 3)
      throw new Error('Expected a Roboport Entity plan.');
    expect(plan.entities).toHaveLength(2);
    expect(plan.producers).toEqual([]);
    expect(plan.networks).toEqual([]);
    expect(plan.entities[0]?.profile).toEqual(plan.entities[1]?.profile);
    expect(plan.entities[0]?.configuration).toEqual(plan.entities[1]?.configuration);
    expect(plan.entities[0]?.placement).toEqual(plan.entities[1]?.placement);
    expect(plan.entities[0]?.configuration).toEqual({
      mode: 'raw',
      payload: {
        control_behavior: {
          read_items_mode: false,
          read_robot_stats: false,
          output_networks: { red: false, green: true },
          roboport_count_output_signal: { type: 'virtual', name: 'signal-A' },
          available_logistic_output_signal: { name: 'signal-B' },
        },
        request_filters: {
          request_from_buffers: false,
          trash_not_requested: false,
          sections: [
            {
              active: false,
              index: 0,
              multiplier: 0,
              filters: [
                {
                  name: 'iron-plate',
                  count: 0,
                  index: 0,
                  quality: 'normal',
                  request_from: 'planet',
                  type: 'item',
                },
              ],
            },
          ],
        },
      },
    });
    const resolved = compilation.resolvedCircuit;
    if (resolved === undefined) throw new Error('Expected a resolved Roboport circuit.');
    expect(resolved.ir.entities).toHaveLength(2);
    expect(resolved.ir.producers).toEqual([]);
    expect(resolved.ir.entities[0]?.profile).toEqual(resolved.ir.entities[1]?.profile);
    expect(resolved.ir.entities[0]?.configuration).toEqual(resolved.ir.entities[1]?.configuration);
    expect(resolved.ir.entities[0]?.placement).toEqual(resolved.ir.entities[1]?.placement);
    const execution = compilation.execution;
    if (execution === undefined) throw new Error('Expected Roboport execution details.');
    const document = createDebugDocument(execution.debug, execution.circuit.graph);
    expect(
      document.scopes.flatMap((scope) => ('entities' in scope ? scope.entities : [])),
    ).toHaveLength(2);
    const blueprint = generateEntityBlueprintJson(resolved.ir as NativeCircuitIrV3).blueprint;
    expect(blueprint.entities).toHaveLength(2);
    expect({ ...blueprint.entities[0], entity_number: 0 }).toEqual({
      ...blueprint.entities[1],
      entity_number: 0,
    });
  });

  test.each([
    {
      name: 'missing prototype',
      source: `Roboport('missing-roboport');`,
      message: 'Entity prototype is malformed or unavailable',
    },
    {
      name: 'foreign prototype record',
      source: `Roboport({ key: 'entity:roboport', name: 'roboport', type: 'roboport' });`,
      message: 'foreign or not owned by the selected host provider',
    },
  ])('rejects Roboport with a $name', async ({ source, message }) => {
    const { prototypes } = await loadPrototypeDatabase(builtinPrototypeDatabase);
    const provisioned = new EntityProvisioningService().provision(
      prototypes,
      conservativeEntityProvisioningPolicy,
    );
    const compilation = compileSourceProgram(
      { path: 'roboport-invalid-prototype.factorio.ts', text: source },
      {
        prototypes,
        trustedEntityReplayContext: provisioned.trustedEntityReplayContext,
        entityPrototypeResolver: provisioned.entityPrototypeResolver,
      },
    );

    expect(compilation.plan).toBeUndefined();
    expect(compilation.pipelineDiagnostics).toEqual([
      expect.objectContaining({ code: 'RT2027', message: expect.stringContaining(message) }),
    ]);
  });

  test('rejects a non-roboport prototype at the prototype argument span', async () => {
    const { prototypes } = await loadPrototypeDatabase(builtinPrototypeDatabase);
    const provisioned = new EntityProvisioningService().provision(
      prototypes,
      conservativeEntityProvisioningPolicy,
    );
    const text = `Roboport('assembling-machine-3');`;
    const compilation = compileSourceProgram(
      { path: 'roboport-wrong-family.factorio.ts', text },
      {
        prototypes,
        trustedEntityReplayContext: provisioned.trustedEntityReplayContext,
        entityPrototypeResolver: provisioned.entityPrototypeResolver,
      },
    );

    const start = text.indexOf("'assembling-machine-3'");
    expect(compilation.pipelineDiagnostics).toEqual([
      expect.objectContaining({
        code: 'RT2027',
        message: expect.stringContaining('requires provider Entity type "roboport"'),
        span: {
          fileId: 'file:roboport-wrong-family.factorio.ts',
          start,
          end: start + "'assembling-machine-3'".length,
        },
      }),
    ]);
    expect(compilation.pipelineDiagnostics[0]?.message).toContain(
      'actual type "assembling-machine"',
    );
  });

  test('rolls back caught Roboport family and configuration failures before allocation', async () => {
    const { prototypes } = await loadPrototypeDatabase(builtinPrototypeDatabase);
    const provisioned = new EntityProvisioningService().provision(
      prototypes,
      conservativeEntityProvisioningPolicy,
    );
    const compilation = compileSourceProgram(
      {
        path: 'roboport-rollback.factorio.ts',
        text: `let caught = 0;
try { Roboport('assembling-machine-3'); } catch { caught += 1; }
try { Roboport('roboport', { control_behavior: { read_robot_stats: 0 } }); } catch { caught += 1; }
if (caught !== 2) throw new Error('Roboport failures were accepted');
Roboport('roboport', { raw: { request_filters: { sections: [] } } });`,
      },
      {
        prototypes,
        trustedEntityReplayContext: provisioned.trustedEntityReplayContext,
        entityPrototypeResolver: provisioned.entityPrototypeResolver,
      },
    );

    expect(compilation.pipelineDiagnostics).toEqual([]);
    const plan = compilation.plan;
    if (plan === undefined || plan.version !== 3)
      throw new Error('Expected recovered Roboport plan.');
    expect(plan.entities).toHaveLength(1);
    expect(plan.entities[0]?.id).toBe('entity:1');
    expect(plan.networks).toEqual([]);
    expect(plan.producers).toEqual([]);
  });

  test.each([`Roboport();`, `Roboport('roboport', {}, 'extra');`])(
    'validates public Roboport constructor arity at the call span: %s',
    async (text) => {
      const { prototypes } = await loadPrototypeDatabase(builtinPrototypeDatabase);
      const provisioned = new EntityProvisioningService().provision(
        prototypes,
        conservativeEntityProvisioningPolicy,
      );
      const compilation = compileSourceProgram(
        { path: 'roboport-arity.factorio.ts', text },
        {
          prototypes,
          trustedEntityReplayContext: provisioned.trustedEntityReplayContext,
          entityPrototypeResolver: provisioned.entityPrototypeResolver,
        },
      );

      expect(compilation.pipelineDiagnostics).toEqual([
        expect.objectContaining({
          code: 'RT2027',
          message: 'Roboport(prototype, configuration?) requires one or two arguments.',
          span: { fileId: 'file:roboport-arity.factorio.ts', start: 0, end: text.length - 1 },
        }),
      ]);
    },
  );

  test('keeps fallback Roboport connector, callable, and readback authority unavailable', async () => {
    const { prototypes } = await loadPrototypeDatabase(builtinPrototypeDatabase);
    const provisioned = new EntityProvisioningService().provision(
      prototypes,
      conservativeEntityProvisioningPolicy,
    );
    const cases = [
      {
        source: `Roboport('roboport').port('circuit', 'red');`,
        message: 'Unknown Entity connector',
        code: 'RT2031',
      },
      {
        source: `Roboport('roboport').bind('circuit', 'red', new Network(), 'input');`,
        message: 'Unknown Entity connector',
        code: 'RT2031',
      },
      {
        source: `Roboport('roboport')(new Network());`,
        message: 'has no callable projection',
        code: 'RT2027',
      },
      {
        source: `const output = new Network();
output += Roboport('roboport');`,
        message: 'has no callable projection',
        code: 'RT2027',
      },
    ] as const;

    for (const [index, { source, message, code }] of cases.entries()) {
      const compilation = compileSourceProgram(
        { path: `roboport-fallback-authority-${index}.factorio.ts`, text: source },
        {
          prototypes,
          trustedEntityReplayContext: provisioned.trustedEntityReplayContext,
          entityPrototypeResolver: provisioned.entityPrototypeResolver,
        },
      );
      expect(compilation.plan).toBeUndefined();
      expect(compilation.pipelineDiagnostics).toEqual([
        expect.objectContaining({ code, message: expect.stringContaining(message) }),
      ]);
    }
  });

  test('rejects invalid Roboport configuration while accepting raw and preserving envelope rules', async () => {
    const { prototypes } = await loadPrototypeDatabase(builtinPrototypeDatabase);
    const provisioned = new EntityProvisioningService().provision(
      prototypes,
      conservativeEntityProvisioningPolicy,
    );
    const raw = compileSourceProgram(
      {
        path: 'roboport-raw-configuration.factorio.ts',
        text: `Roboport('roboport', { raw: { request_filters: { sections: [] } } });`,
      },
      {
        prototypes,
        trustedEntityReplayContext: provisioned.trustedEntityReplayContext,
        entityPrototypeResolver: provisioned.entityPrototypeResolver,
      },
    );
    expect(raw.pipelineDiagnostics).toEqual([]);
    expect(raw.plan?.version).toBe(3);
    expect(raw.plan?.version === 3 ? raw.plan.entities[0]?.configuration : undefined).toEqual({
      mode: 'raw',
      payload: { request_filters: { sections: [] } },
    });

    for (const [index, source] of [
      `Roboport('roboport', { control_behavior: { read_robot_stats: 0 } });`,
      `Roboport('roboport', { control_behavior: { unsupported: true } });`,
      `Roboport('roboport', { raw: {}, request_filters: {} });`,
    ].entries()) {
      const compilation = compileSourceProgram(
        { path: `roboport-invalid-configuration-${index}.factorio.ts`, text: source },
        {
          prototypes,
          trustedEntityReplayContext: provisioned.trustedEntityReplayContext,
          entityPrototypeResolver: provisioned.entityPrototypeResolver,
        },
      );
      expect(compilation.plan).toBeUndefined();
      expect(compilation.pipelineDiagnostics).toEqual([
        expect.objectContaining({ code: 'RT2027', span: expect.any(Object) }),
      ]);
    }
  });

  test('resolves Constant from short, canonical, and exact provider-owned forms', async () => {
    const { prototypes } = await loadPrototypeDatabase(builtinPrototypeDatabase);
    const provisioned = new EntityProvisioningService().provision(
      prototypes,
      conservativeEntityProvisioningPolicy,
    );
    const compilation = compileSourceProgram(
      {
        path: 'constant-entity-prototype-forms.factorio.ts',
        text: `const short = Constant('constant-combinator');
const canonical = Constant('entity:constant-combinator');
const record = Constant(prototypes.entity['constant-combinator']);`,
      },
      {
        prototypes,
        trustedEntityReplayContext: provisioned.trustedEntityReplayContext,
        entityPrototypeResolver: provisioned.entityPrototypeResolver,
      },
    );

    expect(compilation.pipelineDiagnostics).toEqual([]);
    const plan = compilation.plan;
    if (plan === undefined || plan.version !== 3)
      throw new Error('Expected a Constant Entity plan.');
    expect(plan.entities).toHaveLength(3);
    expect(plan.entities.map(({ profile }) => profile.prototypeKey)).toEqual([
      'entity:constant-combinator',
      'entity:constant-combinator',
      'entity:constant-combinator',
    ]);
  });

  test('evaluates Constant prototype and configuration exactly once in order', async () => {
    const { prototypes } = await loadPrototypeDatabase(builtinPrototypeDatabase);
    const provisioned = new EntityProvisioningService().provision(
      prototypes,
      conservativeEntityProvisioningPolicy,
    );
    const text = `let order = '';
function selectPrototype() { order += 'p'; return 'constant-combinator'; }
function selectConfiguration() { order += 'c'; return { raw: { player_description: 'ordered' } }; }
const entity = Constant(selectPrototype(), selectConfiguration());
if (order !== 'pc') throw new Error('Constant arguments were not evaluated once in order');`;
    const compilation = compileSourceProgram(
      { path: 'constant-entity-argument-order.factorio.ts', text },
      {
        prototypes,
        trustedEntityReplayContext: provisioned.trustedEntityReplayContext,
        entityPrototypeResolver: provisioned.entityPrototypeResolver,
      },
    );

    expect(compilation.pipelineDiagnostics).toEqual([]);
    expect(compilation.plan?.version).toBe(3);
    expect(compilation.plan?.version === 3 ? compilation.plan.entities : undefined).toHaveLength(1);
  });

  test.each([
    {
      name: 'missing prototype',
      source: `Constant('missing-constant');`,
      message: 'Entity prototype is malformed or unavailable',
    },
    {
      name: 'foreign prototype record',
      source: `Constant({ key: 'entity:constant-combinator', name: 'constant-combinator', type: 'constant-combinator' });`,
      message: '$.configuration.key',
    },
  ])('rejects Constant with a $name', async ({ source, message }) => {
    const { prototypes } = await loadPrototypeDatabase(builtinPrototypeDatabase);
    const provisioned = new EntityProvisioningService().provision(
      prototypes,
      conservativeEntityProvisioningPolicy,
    );
    const compilation = compileSourceProgram(
      { path: 'constant-entity-invalid-prototype.factorio.ts', text: source },
      {
        prototypes,
        trustedEntityReplayContext: provisioned.trustedEntityReplayContext,
        entityPrototypeResolver: provisioned.entityPrototypeResolver,
      },
    );

    expect(compilation.plan).toBeUndefined();
    expect(compilation.pipelineDiagnostics).toEqual([
      expect.objectContaining({ code: 'RT2027', message: expect.stringContaining(message) }),
    ]);
  });

  test.each([`Constant();`, `Constant('constant-combinator', {}, {});`])(
    'validates public Constant constructor arity at the call span: %s',
    async (text) => {
      const { prototypes } = await loadPrototypeDatabase(builtinPrototypeDatabase);
      const provisioned = new EntityProvisioningService().provision(
        prototypes,
        conservativeEntityProvisioningPolicy,
      );
      const compilation = compileSourceProgram(
        { path: 'constant-entity-arity.factorio.ts', text },
        {
          prototypes,
          trustedEntityReplayContext: provisioned.trustedEntityReplayContext,
          entityPrototypeResolver: provisioned.entityPrototypeResolver,
        },
      );

      expect(compilation.pipelineDiagnostics).toEqual([
        expect.objectContaining({
          code: 'CL1014',
          message:
            'Constant(configuration) or Constant(prototype, configuration?) requires one or two arguments.',
          span: {
            fileId: 'file:constant-entity-arity.factorio.ts',
            start: 0,
            end: text.length - 1,
          },
        }),
      ]);
    },
  );

  test('rejects a mixed Constant configuration envelope at the configuration argument span', async () => {
    const { prototypes } = await loadPrototypeDatabase(builtinPrototypeDatabase);
    const provisioned = new EntityProvisioningService().provision(
      prototypes,
      conservativeEntityProvisioningPolicy,
    );
    const text = `Constant('constant-combinator', { raw: {}, player_description: 'x' });`;
    const configuration = "{ raw: {}, player_description: 'x' }";
    const compilation = compileSourceProgram(
      { path: 'constant-entity-mixed-envelope.factorio.ts', text },
      {
        prototypes,
        trustedEntityReplayContext: provisioned.trustedEntityReplayContext,
        entityPrototypeResolver: provisioned.entityPrototypeResolver,
      },
    );
    const start = text.indexOf(configuration);

    expect(compilation.plan).toBeUndefined();
    expect(compilation.pipelineDiagnostics).toEqual([
      expect.objectContaining({
        code: 'RT2027',
        message: expect.stringContaining(
          'Entity configuration envelope fields raw, rule, lanes, and condition must use one exact legacy form.',
        ),
        span: {
          fileId: 'file:constant-entity-mixed-envelope.factorio.ts',
          start,
          end: start + configuration.length,
        },
      }),
    ]);
  });

  test('preserves the checked Constant Blueprint shape including ordered sections and filters', async () => {
    const { prototypes } = await loadPrototypeDatabase(builtinPrototypeDatabase);
    const provisioned = new EntityProvisioningService().provision(
      prototypes,
      conservativeEntityProvisioningPolicy,
    );
    const compilation = compileSourceProgram(
      {
        path: 'constant-entity-configuration.factorio.ts',
        text: `const entity = Constant('constant-combinator', {
  player_description: 'reviewed fixture',
  control_behavior: {
    is_on: false,
    sections: {
      trash_not_requested: false,
      sections: [{
        index: 0,
        active: false,
        group: 'first',
        multiplier: 0,
        filters: [
          { index: 0, name: 'iron-plate', type: 'item', count: 0, comparator: '>=', quality: 'normal' },
          { index: 1, name: 'copper-plate', type: 'item', count: 2 },
        ],
      }, {
        index: 1,
        active: true,
        group: 'second',
        multiplier: 1.5,
        filters: [{ index: 0, name: 'signal-A', type: 'virtual', count: 3 }],
      }],
    },
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
    const plan = compilation.plan;
    if (plan === undefined || plan.version !== 3)
      throw new Error('Expected a Constant Entity plan.');
    expect(plan.entities).toHaveLength(1);
    expect(plan.producers).toEqual([]);
    expect(plan.networks).toEqual([]);
    expect(plan.entities[0]?.configuration).toEqual({
      mode: 'raw',
      payload: {
        player_description: 'reviewed fixture',
        control_behavior: {
          is_on: false,
          sections: {
            trash_not_requested: false,
            sections: [
              {
                index: 0,
                active: false,
                group: 'first',
                multiplier: 0,
                filters: [
                  {
                    index: 0,
                    name: 'iron-plate',
                    type: 'item',
                    count: 0,
                    comparator: '>=',
                    quality: 'normal',
                  },
                  { index: 1, name: 'copper-plate', type: 'item', count: 2 },
                ],
              },
              {
                index: 1,
                active: true,
                group: 'second',
                multiplier: 1.5,
                filters: [{ index: 0, name: 'signal-A', type: 'virtual', count: 3 }],
              },
            ],
          },
        },
      },
    });
  });

  test('unifies Constant and CC over two physical constant-combinator Entities', async () => {
    const { prototypes } = await loadPrototypeDatabase(builtinPrototypeDatabase);
    const provisioned = new EntityProvisioningService().provision(
      prototypes,
      conservativeEntityProvisioningPolicy,
    );
    const compilation = compileSourceProgram(
      {
        path: 'constant-entity-and-cc.factorio.ts',
        text: `const A = Signal('virtual', 'signal-A');
const structural = Constant('constant-combinator', { raw: {
  player_description: 'structural',
  control_behavior: { is_on: false, sections: { sections: [] } },
} }).at(4, 5, 8);
const aliases = [structural];
const output = new Network();
output += CC(2 * A);`,
      },
      {
        prototypes,
        trustedEntityReplayContext: provisioned.trustedEntityReplayContext,
        entityPrototypeResolver: provisioned.entityPrototypeResolver,
      },
    );

    expect(compilation.pipelineDiagnostics).toEqual([]);
    const plan = compilation.plan;
    const resolved = compilation.resolvedCircuit;
    const execution = compilation.execution;
    if (
      plan === undefined ||
      plan.version !== 4 ||
      resolved === undefined ||
      execution === undefined
    ) {
      throw new Error('Expected Constant and CC v4 artifacts.');
    }
    expect(plan.entities).toHaveLength(2);
    expect(plan.entities[0]?.profile.prototypeKey).toBe('entity:constant-combinator');
    expect(plan.entities[0]?.placement).toEqual({ x: 4, y: 5, direction: 8 });
    expect(plan.entities[1]?.configuration).toMatchObject({ mode: 'constant' });
    expect(plan.producers).toHaveLength(1);
    expect(plan.producers[0]).toMatchObject({ kind: 'constant' });
    expect(plan.networks).toHaveLength(2);
    expect(resolved.format).toBe('comblang-resolved-entity-v4');
    expect(resolved.ir.entities).toHaveLength(2);
    expect(resolved.ir.producers).toHaveLength(1);
    expect(resolved.ir.producers[0]).toMatchObject({ kind: 'constant' });
    const blueprint = generateEntityComputationBlueprintJson(
      resolved.ir as NativeCircuitIrV4,
    ).blueprint;
    expect(blueprint.entities).toHaveLength(2);
    expect(blueprint.entities.filter(({ name }) => name === 'constant-combinator')).toHaveLength(2);
    const document = createDebugDocument(execution.debug, execution.circuit.graph);
    expect(
      document.scopes.flatMap((scope) => ('entities' in scope ? scope.entities : [])),
    ).toHaveLength(2);
  });

  test.each([
    {
      name: 'non-constant prototype',
      source: `Constant('assembling-machine-3');`,
      message: 'requires provider Entity type "constant-combinator"',
      spanText: "'assembling-machine-3'",
    },
    {
      name: 'wrong nested type',
      source: `Constant('constant-combinator', { control_behavior: { is_on: 0, sections: { sections: [] } } });`,
      message: '$.control_behavior.is_on: expected a boolean',
      spanText: '{ control_behavior: { is_on: 0, sections: { sections: [] } } }',
    },
    {
      name: 'unknown nested field',
      source: `Constant('constant-combinator', { control_behavior: { unsupported: true, sections: { sections: [] } } });`,
      message: '$.control_behavior.unsupported: field is not documented',
      spanText: '{ control_behavior: { unsupported: true, sections: { sections: [] } } }',
    },
  ])(
    'rejects Constant $name with a source-aware diagnostic',
    async ({ source, message, spanText }) => {
      const { prototypes } = await loadPrototypeDatabase(builtinPrototypeDatabase);
      const provisioned = new EntityProvisioningService().provision(
        prototypes,
        conservativeEntityProvisioningPolicy,
      );
      const compilation = compileSourceProgram(
        { path: 'constant-entity-invalid.factorio.ts', text: source },
        {
          prototypes,
          trustedEntityReplayContext: provisioned.trustedEntityReplayContext,
          entityPrototypeResolver: provisioned.entityPrototypeResolver,
        },
      );
      const start = source.indexOf(spanText);
      expect(compilation.plan).toBeUndefined();
      expect(compilation.pipelineDiagnostics).toEqual([
        expect.objectContaining({
          code: 'RT2027',
          message: expect.stringContaining(message),
          span: expect.objectContaining({
            fileId: 'file:constant-entity-invalid.factorio.ts',
            start,
            end: start + spanText.length,
          }),
        }),
      ]);
    },
  );

  test('rolls back caught Constant failures without shifting Entity identity', async () => {
    const { prototypes } = await loadPrototypeDatabase(builtinPrototypeDatabase);
    const provisioned = new EntityProvisioningService().provision(
      prototypes,
      conservativeEntityProvisioningPolicy,
    );
    const compilation = compileSourceProgram(
      {
        path: 'constant-entity-rollback.factorio.ts',
        text: `let caught = 0;
try { Constant('assembling-machine-3'); } catch { caught += 1; }
try { Constant('constant-combinator', { control_behavior: { is_on: 0, sections: { sections: [] } } }); } catch { caught += 1; }
if (caught !== 2) throw new Error('Constant failures were accepted');
Constant('constant-combinator', { raw: { control_behavior: { is_on: false, sections: { sections: [] } } } });`,
      },
      {
        prototypes,
        trustedEntityReplayContext: provisioned.trustedEntityReplayContext,
        entityPrototypeResolver: provisioned.entityPrototypeResolver,
      },
    );
    expect(compilation.pipelineDiagnostics).toEqual([]);
    const plan = compilation.plan;
    if (plan === undefined || plan.version !== 3)
      throw new Error('Expected recovered Constant plan.');
    expect(plan.entities).toHaveLength(1);
    expect(plan.entities[0]?.id).toBe('entity:1');
    expect(plan.networks).toEqual([]);
    expect(plan.producers).toEqual([]);
  });

  test.each([
    {
      name: 'output attachment',
      source: `const output = new Network();
output += Constant('constant-combinator');`,
      message: 'Network += requires a combinator producer',
      code: 'CL1034',
    },
    {
      name: 'call syntax',
      source: `Constant('constant-combinator')(new Network());`,
      message: 'has no callable projection',
      code: 'RT2027',
    },
    {
      name: 'connector projection',
      source: `Constant('constant-combinator').port('circuit', 'red');`,
      message: 'Unknown Entity connector',
      code: 'RT2031',
    },
    {
      name: 'connector binding',
      source: `Constant('constant-combinator').bind('circuit', 'red', new Network(), 'input');`,
      message: 'Unknown Entity connector',
      code: 'RT2031',
    },
  ])(
    'does not grant Constant $name authority under the fallback profile',
    async ({ source, message, code }) => {
      const { prototypes } = await loadPrototypeDatabase(builtinPrototypeDatabase);
      const provisioned = new EntityProvisioningService().provision(
        prototypes,
        conservativeEntityProvisioningPolicy,
      );
      const compilation = compileSourceProgram(
        { path: 'constant-entity-authority.factorio.ts', text: source },
        {
          prototypes,
          trustedEntityReplayContext: provisioned.trustedEntityReplayContext,
          entityPrototypeResolver: provisioned.entityPrototypeResolver,
        },
      );
      expect(compilation.plan).toBeUndefined();
      expect(compilation.pipelineDiagnostics).toEqual([
        expect.objectContaining({ code, message: expect.stringContaining(message) }),
      ]);
    },
  );

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

      const blueprint = generateEntityBlueprintJson(
        execution.circuit.ir as NativeCircuitIrV3,
      ).blueprint;
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

    const blueprint = generateEntityBlueprintJson(
      execution.circuit.ir as NativeCircuitIrV3,
    ).blueprint;
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

  test('carries bounded raw Entity configuration through plan, IR, and blueprint output', () => {
    const host = syntheticEntityHost(syntheticZeroPortEntityProfile);
    const compilation = compileSourceProgram(
      {
        path: 'entity-raw-configuration.factorio.ts',
        text: `const machine = Entity('entity:synthetic-zero-port', {
  raw: {
    recipe: 'iron-gear-wheel',
    quality: 'normal',
    control_behavior: { read_contents: true, enabled: false },
    sections: [{ filters: [{ name: 'iron-plate', count: 0 }], active: false }],
    modded_field: { empty: [], zero: 0, disabled: false },
  },
}).at(10.5, -2, 8);`,
      },
      host,
    );

    expect(compilation.pipelineDiagnostics).toEqual([]);
    const plan = compilation.plan;
    const resolvedCircuit = compilation.resolvedCircuit;
    const execution = compilation.execution;
    if (
      plan === undefined ||
      plan.version !== 3 ||
      resolvedCircuit === undefined ||
      execution === undefined ||
      !('entityObject' in execution)
    ) {
      throw new Error('Expected a raw Entity v3 compilation.');
    }
    const expectedRaw = {
      recipe: 'iron-gear-wheel',
      quality: 'normal',
      control_behavior: { read_contents: true, enabled: false },
      sections: [{ filters: [{ name: 'iron-plate', count: 0 }], active: false }],
      modded_field: { empty: [], zero: 0, disabled: false },
    };
    expect(plan.entities[0]?.configuration).toEqual({ mode: 'raw', payload: expectedRaw });
    expect(structuredClone(plan)).toEqual(plan);
    expect(resolvedCircuit.ir.entities[0]?.configuration).toEqual({
      mode: 'raw',
      payload: expectedRaw,
    });
    expect(structuredClone(resolvedCircuit)).toEqual(resolvedCircuit);
    expect(resolvedCircuit.planFingerprint).toBe(resolvedSourceCircuitPlanFingerprint(plan));

    const blueprint = generateEntityBlueprintJson(
      resolvedCircuit.ir as NativeCircuitIrV3,
    ).blueprint;
    expect(blueprint.entities).toHaveLength(1);
    expect(blueprint.entities[0]).toEqual({
      ...expectedRaw,
      entity_number: 1,
      name: 'synthetic-zero-port',
      position: { x: 10.5, y: -2 },
      direction: 8,
    });

    const collision = structuredClone(resolvedCircuit.ir) as any;
    collision.entities[0].configuration.payload.name = 'spoofed-name';
    expect(() => generateEntityBlueprintJson(collision)).toThrowError(
      expect.objectContaining({ code: 'BP1001', span: expect.any(Object) }),
    );
    const extraConfigurationField = structuredClone(resolvedCircuit.ir) as any;
    extraConfigurationField.entities[0].configuration.extra = true;
    expect(() => generateEntityBlueprintJson(extraConfigurationField)).toThrowError(
      expect.objectContaining({
        code: 'BP1001',
        message: expect.stringContaining('$.configuration.extra'),
        span: expect.any(Object),
      }),
    );
    expect(execution.entityObject(execution.createTestSession(), 1)).toMatchObject({
      adapterId: 'entity-physical-v3',
      connectors: [],
    });
  });

  test('checks a direct Blueprint fragment, detaches Signal handles, and matches raw output', async () => {
    const { prototypes } = await loadPrototypeDatabase(builtinPrototypeDatabase);
    const provisioned = new EntityProvisioningService().provision(
      prototypes,
      conservativeEntityProvisioningPolicy,
    );
    const compilation = compileSourceProgram(
      {
        path: 'entity-checked-configuration.factorio.ts',
        text: `const signal = Signal('virtual', 'signal-A');
const checked = Entity('assembling-machine-3', {
  recipe: 'iron-gear-wheel',
  recipe_quality: 'normal',
  control_behavior: { read_contents: false, working_signal: signal },
}).at(10, 12, 0);
const raw = Entity('assembling-machine-3', { raw: {
  recipe: 'iron-gear-wheel',
  recipe_quality: 'normal',
  control_behavior: { read_contents: false, working_signal: { type: 'virtual', name: 'signal-A' } },
}}).at(10, 12, 0);`,
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
    if (
      plan === undefined ||
      plan.version !== 3 ||
      execution === undefined ||
      !('entityObject' in execution)
    ) {
      throw new Error('Expected checked Blueprint Entity compilation.');
    }
    expect(plan.entities).toHaveLength(2);
    expect(plan.entities[0]?.configuration).toEqual(plan.entities[1]?.configuration);
    expect(plan.entities[0]?.configuration).toEqual({
      mode: 'raw',
      payload: {
        recipe: 'iron-gear-wheel',
        recipe_quality: 'normal',
        control_behavior: {
          read_contents: false,
          working_signal: { type: 'virtual', name: 'signal-A' },
        },
      },
    });
    const blueprint = generateEntityBlueprintJson(
      execution.circuit.ir as NativeCircuitIrV3,
    ).blueprint;
    expect({ ...blueprint.entities[0], entity_number: 0 }).toEqual({
      ...blueprint.entities[1],
      entity_number: 0,
    });
    expect(blueprint.entities[0]).toMatchObject({
      name: 'assembling-machine-3',
      control_behavior: {
        read_contents: false,
        working_signal: { type: 'virtual', name: 'signal-A' },
      },
    });
  });

  test('compiles representative schema families through generic Entity to Blueprint output', async () => {
    const { prototypes } = await loadPrototypeDatabase(builtinPrototypeDatabase);
    const provisioned = new EntityProvisioningService().provision(
      prototypes,
      conservativeEntityProvisioningPolicy,
    );
    const compilation = compileSourceProgram(
      {
        path: 'entity-schema-family-coverage.factorio.ts',
        text: `const logistics = Entity('storage-chest', {
  request_filters: {
    request_from_buffers: false,
    trash_not_requested: false,
    sections: [{
      active: true,
      index: 0,
      group: 'logistics',
      multiplier: 1,
      filters: [{ index: 0, name: 'iron-plate', type: 'item', count: 1, request_from: 'all' }],
    }],
  },
}).at(1, 2, 0);
const belts = Entity('transport-belt', {
  control_behavior: {
    circuit_enabled: true,
    circuit_read_hand_contents: false,
    circuit_contents_read_mode: 'hold',
    connect_to_logistic_network: true,
    input_networks: { red: true, green: false },
    output_networks: { red: false, green: true },
  },
}).at(3, 4, 0);
const trains = Entity('train-stop', {
  station: 'Main station',
  priority: 1,
  manual_trains_limit: 2,
  color: { r: 0.2, g: 0.4, b: 0.6, a: 1 },
  control_behavior: {
    circuit_enabled: true,
    connect_to_logistic_network: false,
    input_networks: { red: true, green: false },
    output_networks: { red: false, green: true },
    read_from_train: true,
    read_trains_count: true,
    set_trains_limit: true,
    train_stopped_signal: { type: 'virtual', name: 'signal-A' },
  },
}).at(5, 6, 0);`,
      },
      {
        prototypes,
        trustedEntityReplayContext: provisioned.trustedEntityReplayContext,
        entityPrototypeResolver: provisioned.entityPrototypeResolver,
      },
    );

    expect(compilation.pipelineDiagnostics).toEqual([]);
    const plan = compilation.plan;
    const resolved = compilation.resolvedCircuit;
    if (plan === undefined || plan.version !== 3 || resolved === undefined) {
      throw new Error('Expected representative schema-family Entity artifacts.');
    }
    expect(plan.entities).toHaveLength(3);
    expect(plan.entities.map(({ id, profile }) => [id, profile.prototypeKey])).toEqual([
      ['entity:1', 'entity:storage-chest'],
      ['entity:2', 'entity:transport-belt'],
      ['entity:3', 'entity:train-stop'],
    ]);
    expect(plan.entities.map(({ placement }) => placement)).toEqual([
      { x: 1, y: 2, direction: 0 },
      { x: 3, y: 4, direction: 0 },
      { x: 5, y: 6, direction: 0 },
    ]);
    expect(plan.entities.map(({ configuration }) => configuration?.mode)).toEqual([
      'raw',
      'raw',
      'raw',
    ]);
    expect(plan.entities[0]?.configuration).toMatchObject({
      mode: 'raw',
      payload: {
        request_filters: {
          sections: [{ filters: [{ index: 0, name: 'iron-plate', type: 'item', count: 1 }] }],
        },
      },
    });
    expect(plan.entities[1]?.configuration).toMatchObject({
      mode: 'raw',
      payload: { control_behavior: { circuit_contents_read_mode: 'hold' } },
    });
    expect(plan.entities[2]?.configuration).toMatchObject({
      mode: 'raw',
      payload: { station: 'Main station', control_behavior: { read_from_train: true } },
    });

    expect(resolved.ir.entities.map(({ id, profile }) => [id, profile.prototypeKey])).toEqual([
      ['entity:1', 'entity:storage-chest'],
      ['entity:2', 'entity:transport-belt'],
      ['entity:3', 'entity:train-stop'],
    ]);
    const blueprint = generateEntityBlueprintJson(resolved.ir as NativeCircuitIrV3).blueprint;
    expect(blueprint.entities).toHaveLength(3);
    expect(blueprint.entities).toMatchObject([
      {
        entity_number: 1,
        name: 'storage-chest',
        position: { x: 1, y: 2 },
        request_filters: {
          request_from_buffers: false,
          trash_not_requested: false,
          sections: [
            {
              active: true,
              index: 0,
              group: 'logistics',
              multiplier: 1,
              filters: [
                { index: 0, name: 'iron-plate', type: 'item', count: 1, request_from: 'all' },
              ],
            },
          ],
        },
      },
      {
        entity_number: 2,
        name: 'transport-belt',
        position: { x: 3, y: 4 },
        direction: 0,
        control_behavior: {
          circuit_enabled: true,
          circuit_contents_read_mode: 'hold',
          input_networks: { red: true, green: false },
          output_networks: { red: false, green: true },
        },
      },
      {
        entity_number: 3,
        name: 'train-stop',
        position: { x: 5, y: 6 },
        station: 'Main station',
        priority: 1,
        manual_trains_limit: 2,
        color: { r: 0.2, g: 0.4, b: 0.6, a: 1 },
        control_behavior: {
          read_from_train: true,
          read_trains_count: true,
          set_trains_limit: true,
          train_stopped_signal: { type: 'virtual', name: 'signal-A' },
        },
      },
    ]);
  });

  test('accepts a provider-known common-only Blueprint Entity with an empty fragment', async () => {
    const { prototypes } = await loadPrototypeDatabase(builtinPrototypeDatabase);
    const provisioned = new EntityProvisioningService().provision(
      prototypes,
      conservativeEntityProvisioningPolicy,
    );
    const compilation = compileSourceProgram(
      { path: 'entity-common-only-configuration.factorio.ts', text: `Entity('beacon', {});` },
      {
        prototypes,
        trustedEntityReplayContext: provisioned.trustedEntityReplayContext,
        entityPrototypeResolver: provisioned.entityPrototypeResolver,
      },
    );

    expect(compilation.pipelineDiagnostics).toEqual([]);
    const plan = compilation.plan;
    if (plan === undefined || plan.version !== 3) {
      throw new Error('Expected common-only Blueprint Entity compilation.');
    }
    expect(plan.entities).toHaveLength(1);
    expect(plan.entities[0]?.configuration).toEqual({ mode: 'raw', payload: {} });
  });

  test('preserves checked arrays, dictionaries, zero, false, and empty values in one Entity', async () => {
    const { prototypes } = await loadPrototypeDatabase(builtinPrototypeDatabase);
    const provisioned = new EntityProvisioningService().provision(
      prototypes,
      conservativeEntityProvisioningPolicy,
    );
    const compilation = compileSourceProgram(
      {
        path: 'entity-checked-containers.factorio.ts',
        text: `const chest = Entity('steel-chest', {
  filters: [],
  tags: { count: 0, active: false, empty: [], label: 'kept' },
  control_behavior: { read_contents: false },
}).at(0, 0);`,
      },
      {
        prototypes,
        trustedEntityReplayContext: provisioned.trustedEntityReplayContext,
        entityPrototypeResolver: provisioned.entityPrototypeResolver,
      },
    );

    expect(compilation.pipelineDiagnostics).toEqual([]);
    const plan = compilation.plan;
    if (plan === undefined || plan.version !== 3) {
      throw new Error('Expected checked container Entity compilation.');
    }
    expect(plan.entities[0]?.configuration).toEqual({
      mode: 'raw',
      payload: {
        filters: [],
        tags: { count: 0, active: false, empty: [], label: 'kept' },
        control_behavior: { read_contents: false },
      },
    });
  });

  test('detaches Signal handles through an actual catalog nested array and accepts plain SignalID data', async () => {
    const { prototypes } = await loadPrototypeDatabase(builtinPrototypeDatabase);
    const provisioned = new EntityProvisioningService().provision(
      prototypes,
      conservativeEntityProvisioningPolicy,
    );
    const compilation = compileSourceProgram(
      {
        path: 'entity-checked-nested-signals.factorio.ts',
        text: `const signal = Signal('virtual', 'signal-A');
const panel = Entity('display-panel', {
  control_behavior: {
    parameters: [{
      condition: { first_signal: signal },
      icon: { name: 'signal-B' },
      text: 'signal status',
    }, {
      condition: { second_signal: { type: 'virtual', name: 'signal-C' } },
      icon: { type: 'virtual', name: 'signal-D' },
      text: 'explicit signal status',
    }],
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
    const plan = compilation.plan;
    if (plan === undefined || plan.version !== 3) {
      throw new Error('Expected checked nested Signal Blueprint Entity compilation.');
    }
    expect(plan.entities[0]?.configuration).toEqual({
      mode: 'raw',
      payload: {
        control_behavior: {
          parameters: [
            {
              condition: { first_signal: { type: 'virtual', name: 'signal-A' } },
              icon: { name: 'signal-B' },
              text: 'signal status',
            },
            {
              condition: { second_signal: { type: 'virtual', name: 'signal-C' } },
              icon: { type: 'virtual', name: 'signal-D' },
              text: 'explicit signal status',
            },
          ],
        },
      },
    });
  });

  test('isolates a checked fragment from caller mutation after construction', async () => {
    const { prototypes } = await loadPrototypeDatabase(builtinPrototypeDatabase);
    const provisioned = new EntityProvisioningService().provision(
      prototypes,
      conservativeEntityProvisioningPolicy,
    );
    const compilation = compileSourceProgram(
      {
        path: 'entity-checked-mutation.factorio.ts',
        text: `const config = {
  recipe: 'iron-gear-wheel',
  control_behavior: { read_contents: false },
};
const entity = Entity('assembling-machine-3', config);
config.recipe = 'copper-cable';
config.control_behavior.read_contents = true;`,
      },
      {
        prototypes,
        trustedEntityReplayContext: provisioned.trustedEntityReplayContext,
        entityPrototypeResolver: provisioned.entityPrototypeResolver,
      },
    );

    expect(compilation.pipelineDiagnostics).toEqual([]);
    const plan = compilation.plan;
    if (plan === undefined || plan.version !== 3) {
      throw new Error('Expected mutation-isolated checked Entity compilation.');
    }
    expect(plan.entities[0]?.configuration).toEqual({
      mode: 'raw',
      payload: {
        recipe: 'iron-gear-wheel',
        control_behavior: { read_contents: false },
      },
    });
  });

  test.each([
    {
      name: 'unknown field',
      source: `Entity('assembling-machine-3', { unsupported: true });`,
      message: '$.unsupported: field is not documented for this Blueprint schema.',
    },
    {
      name: 'wrong scalar',
      source: `Entity('assembling-machine-3', { recipe: 3 });`,
      message: '$.recipe: expected a string.',
    },
    {
      name: 'invalid SignalID type',
      source: `Entity('assembling-machine-3', { control_behavior: { working_signal: { type: 'unsupported', name: 'signal-A' } } });`,
      message: '$.control_behavior.working_signal.type: expected the literal "asteroid-chunk".',
    },
  ])(
    'rejects invalid checked Blueprint configuration before allocation: $name',
    async ({ source, message }) => {
      const { prototypes } = await loadPrototypeDatabase(builtinPrototypeDatabase);
      const provisioned = new EntityProvisioningService().provision(
        prototypes,
        conservativeEntityProvisioningPolicy,
      );
      const compilation = compileSourceProgram(
        { path: 'entity-checked-configuration-invalid.factorio.ts', text: source },
        {
          prototypes,
          trustedEntityReplayContext: provisioned.trustedEntityReplayContext,
          entityPrototypeResolver: provisioned.entityPrototypeResolver,
        },
      );

      expect(compilation.plan).toBeUndefined();
      expect(compilation.pipelineDiagnostics).toEqual([
        expect.objectContaining({ code: 'RT2027', message: expect.stringContaining(message) }),
      ]);
      const diagnostic = compilation.pipelineDiagnostics[0];
      const configurationStart = source.indexOf('{', source.indexOf('Entity'));
      const configurationEnd = source.lastIndexOf('}') + 1;
      expect(diagnostic?.span).toEqual({
        fileId: 'file:entity-checked-configuration-invalid.factorio.ts',
        start: configurationStart,
        end: configurationEnd,
      });
    },
  );

  test('does not allocate an Entity when a checked fragment is caught before a later valid Entity', async () => {
    const { prototypes } = await loadPrototypeDatabase(builtinPrototypeDatabase);
    const provisioned = new EntityProvisioningService().provision(
      prototypes,
      conservativeEntityProvisioningPolicy,
    );
    const compilation = compileSourceProgram(
      {
        path: 'entity-checked-configuration-caught.factorio.ts',
        text: `let caught = false;
try { Entity('assembling-machine-3', { recipe: 3 }); } catch { caught = true; }
if (!caught) throw new Error('checked configuration was accepted');
Entity('assembling-machine-3', {});`,
      },
      {
        prototypes,
        trustedEntityReplayContext: provisioned.trustedEntityReplayContext,
        entityPrototypeResolver: provisioned.entityPrototypeResolver,
      },
    );

    expect(compilation.pipelineDiagnostics).toEqual([]);
    const plan = compilation.plan;
    if (plan === undefined || plan.version !== 3) {
      throw new Error('Expected caught checked Blueprint Entity compilation.');
    }
    expect(plan.entities).toHaveLength(1);
    expect(plan.entities[0]?.id).toBe('entity:1');
  });

  test.each([
    {
      name: 'unknown checked field',
      source: `Entity('entity:synthetic-zero-port', { not_a_field: true });`,
      message: '$.not_a_field: field is not documented for this Blueprint schema.',
    },
    {
      name: 'mixed raw and typed fields',
      source: `Entity('entity:synthetic-zero-port', { raw: {}, rule: 'ignored' });`,
      message:
        'Entity configuration envelope fields raw, rule, lanes, and condition must use one exact legacy form.',
    },
    {
      name: 'accessor',
      source: `const raw = {};
Object.defineProperty(raw, 'recipe', { enumerable: true, get() { throw new Error('accessor evaluated'); } });
Entity('entity:synthetic-zero-port', { raw });`,
      message: '$.raw.recipe: accessors are not allowed in raw JSON.',
    },
    {
      name: 'symbol',
      source: `const raw = {};
raw[Symbol('extra')] = true;
Entity('entity:synthetic-zero-port', { raw });`,
      message: '$.raw[Symbol(extra)]: symbol keys are not allowed.',
    },
    {
      name: 'array',
      source: `Entity('entity:synthetic-zero-port', { raw: [] });`,
      message: '$.raw: raw Entity configuration must be a JSON object.',
    },
    {
      name: 'scalar',
      source: `Entity('entity:synthetic-zero-port', { raw: 1 });`,
      message: '$.raw: raw Entity configuration must be a JSON object.',
    },
    {
      name: 'cycle',
      source: `const raw = {};
raw.self = raw;
Entity('entity:synthetic-zero-port', { raw });`,
      message: '$.raw.self: cycles are not allowed.',
    },
    {
      name: 'byte limit',
      source: `const raw = { value: 'x'.repeat(262200) };
Entity('entity:synthetic-zero-port', { raw });`,
      message: 'raw JSON exceeds the byte limit of 262144.',
    },
    {
      name: 'compiler-owned field',
      source: `Entity('entity:synthetic-zero-port', { raw: { name: 'spoofed-name' } });`,
      message: '$.raw.name: compiler-owned BlueprintEntity fields must stay separate.',
    },
  ])('rejects malformed public raw Entity configuration: $name', ({ source, message }) => {
    const host = syntheticEntityHost(syntheticZeroPortEntityProfile);
    const compilation = compileSourceProgram(
      { path: 'entity-raw-configuration-invalid.factorio.ts', text: source },
      host,
    );

    expect(compilation.plan).toBeUndefined();
    expect(compilation.pipelineDiagnostics).toEqual([
      expect.objectContaining({
        code: 'RT2027',
        message: expect.stringContaining(message),
        span: expect.any(Object),
      }),
    ]);
  });

  test.each([
    {
      name: 'extra field',
      source: `const entity = Entity('entity:synthetic-shared-two-color', { rule: 'shared-circuit-condition', lanes: ['shared-red'], condition: NativeCondition(Signal('virtual', 'signal-A'), '>', 0), extra: true });`,
      message:
        'Entity configuration envelope fields raw, rule, lanes, and condition must use one exact legacy form.',
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

  test('rolls back a caught provider prototype-type mismatch before the next Entity allocation', () => {
    const mismatchedProfile: EntityProfile = {
      ...syntheticSharedTwoColorEntityProfile,
      prototypeType: 'furnace',
    };
    const trustedEntityReplayContext = createTrustedEntityReplayContext({
      database: syntheticZeroPortEntityProfile.ref.database,
      source: 'synthetic',
      evidenceIdentity: 'comblang-synthetic-evidence-v1',
      policyIdentity: 'comblang-entity-policy-v1',
      profiles: [mismatchedProfile, syntheticZeroPortEntityProfile],
    });
    const entityPrototypeResolver: EntityPrototypeResolver = {
      database: trustedEntityReplayContext.database,
      getEntity(nameOrKey) {
        const name = nameOrKey.replace('entity:', '');
        return {
          key: nameOrKey as EntityPrototype['key'],
          name,
          type: 'container',
        };
      },
    };
    const compilation = compileSourceProgram(
      {
        path: 'entity-prototype-type-caught.factorio.ts',
        text: `let caught = false;
try { Entity('entity:synthetic-shared-two-color'); } catch { caught = true; }
if (!caught) throw new Error('prototype type mismatch was accepted');
const entity = Entity('entity:synthetic-zero-port');`,
      },
      { trustedEntityReplayContext, entityPrototypeResolver },
    );

    expect(compilation.pipelineDiagnostics).toEqual([]);
    const plan = compilation.plan;
    if (plan === undefined || plan.version !== 3) throw new Error('Expected an Entity v3 plan.');
    expect(plan.entities).toHaveLength(1);
    expect(plan.entities[0]).toMatchObject({
      ordinal: 1,
      profile: syntheticZeroPortEntityProfile.ref,
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

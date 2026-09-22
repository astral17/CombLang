import { describe, expect, test } from 'vitest';
import {
  generatePrototypeAsset,
  loadPrototypeDatabase,
  loadPrototypeInputJson,
  syntheticPrototypeDatabase,
  type EntityPrototype,
} from '@comblang/prototypes';
import { syntheticZeroPortEntityProfile } from '@comblang/compiler/entity-fixtures';
import type { EntityProfile } from '@comblang/compiler/entity';
import { generateBlueprintJson } from '@comblang/compiler/blueprint-json';
import {
  createTrustedEntityReplayContext,
  entityReplayContextTransport,
} from '@comblang/compiler/entity-replay-context';
import {
  conservativeEntityProvisioningPolicy,
  EntityProvisioningService,
} from '@comblang/runtime/entity-provisioning';

import { CompilerWorkerRuntime, handleCompilerWorkerRequest } from './compiler-worker-request.js';
import type { CompilerWorkerProgressStage, CompilerWorkerRequest } from './worker-protocol.js';

const file = {
  path: 'main.factorio.ts',
  text: `if (prototypes.item['iron-plate'].stackSize !== 100) throw new Error('wrong profile');
const output = CC(prototypes.item['iron-plate'].stackSize * Signal('iron-plate'));`,
};

const rawMetadata = JSON.stringify({
  factorioVersion: '2.1.17',
  expansions: ['space-age'],
  mods: [
    { name: 'base', version: '2.1.17' },
    { name: 'space-age', version: '2.1.17' },
  ],
});

const rawSource = JSON.stringify({
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
  lamp: {
    'fixture-lamp': {
      type: 'lamp',
      name: 'fixture-lamp',
      flags: ['placeable-player', 'player-creation'],
    },
  },
  roboport: {
    'fixture-roboport': {
      type: 'roboport',
      name: 'fixture-roboport',
      flags: ['placeable-player', 'player-creation'],
    },
  },
  'constant-combinator': {
    'constant-combinator': {
      type: 'constant-combinator',
      name: 'constant-combinator',
      flags: ['placeable-player', 'player-creation'],
    },
    'fixture-constant': {
      type: 'constant-combinator',
      name: 'fixture-constant',
      flags: ['placeable-player', 'player-creation'],
    },
  },
  'selector-combinator': {
    'fixture-selector': {
      type: 'selector-combinator',
      name: 'fixture-selector',
      flags: ['placeable-player', 'player-creation'],
    },
  },
  'arithmetic-combinator': {
    'arithmetic-combinator': {
      type: 'arithmetic-combinator',
      name: 'arithmetic-combinator',
      flags: ['placeable-player', 'player-creation'],
    },
  },
  'decider-combinator': {
    'decider-combinator': {
      type: 'decider-combinator',
      name: 'decider-combinator',
      flags: ['placeable-player', 'player-creation'],
    },
  },
  'logistic-container': {
    'fixture-logistics': {
      type: 'logistic-container',
      name: 'fixture-logistics',
      flags: ['placeable-player', 'player-creation'],
    },
  },
});

function exactDeciderHostContext() {
  const profile: EntityProfile = {
    ...structuredClone(syntheticZeroPortEntityProfile),
    ref: {
      ...syntheticZeroPortEntityProfile.ref,
      prototypeKey: 'entity:decider-combinator',
      profileId: 'profile:worker-decider-v6' as EntityProfile['ref']['profileId'],
    },
    prototypeType: 'decider-combinator',
  };
  const trustedEntityReplayContext = createTrustedEntityReplayContext({
    database: profile.ref.database,
    source: 'synthetic',
    evidenceIdentity: 'worker-decider-v6-evidence',
    policyIdentity: 'worker-decider-v6-policy',
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
    entityReplayContext: entityReplayContextTransport(trustedEntityReplayContext),
    entityPrototypeResolver: {
      database: profile.ref.database,
      getEntity(nameOrKey: string) {
        return nameOrKey === prototype.key || nameOrKey === prototype.name ? prototype : undefined;
      },
    },
  };
}

function exactSelectorHostContext() {
  const profile: EntityProfile = {
    ...structuredClone(syntheticZeroPortEntityProfile),
    ref: {
      ...syntheticZeroPortEntityProfile.ref,
      prototypeKey: 'entity:selector-combinator',
      profileId: 'profile:worker-selector-v7' as EntityProfile['ref']['profileId'],
    },
    prototypeType: 'selector-combinator',
  };
  const trustedEntityReplayContext = createTrustedEntityReplayContext({
    database: profile.ref.database,
    source: 'synthetic',
    evidenceIdentity: 'worker-selector-v7-evidence',
    policyIdentity: 'worker-selector-v7-policy',
    profiles: [profile],
  });
  const prototype: EntityPrototype = {
    key: 'entity:selector-combinator',
    name: 'selector-combinator',
    type: 'selector-combinator',
    tileWidth: 1,
    tileHeight: 2,
  };
  return {
    trustedEntityReplayContext,
    entityReplayContext: entityReplayContextTransport(trustedEntityReplayContext),
    entityPrototypeResolver: {
      database: profile.ref.database,
      getEntity(nameOrKey: string) {
        return nameOrKey === prototype.key || nameOrKey === prototype.name ? prototype : undefined;
      },
    },
  };
}

describe('browser compiler Worker prototype profile', () => {
  test('compiles the generated lookup fixture through the Worker boundary', async () => {
    const response = await handleCompilerWorkerRequest({
      kind: 'parse',
      revision: 10,
      file: {
        path: 'worker-generated-lookup.factorio.ts',
        text: `const KEY = Signal('virtual', 'signal-key');
const VALUE = Signal('virtual', 'signal-value');
const source = new Network();
function Lookup(input: Readonly<Network>): Network {
  const keys = [10, 20, 30];
  let member = input[KEY] === keys[0];
  for (const key of keys.slice(1)) member = member || input[KEY] === key;
  return IF(member, [100 * VALUE, 103 * VALUE]);
}
const result = Lookup(source);`,
      },
    });

    expect(response.result.pipelineDiagnostics).toEqual([]);
    expect(response.result.plan?.producers.filter(({ kind }) => kind === 'decider')).toHaveLength(
      1,
    );
    expect(response.result.resolvedCircuit?.ir.producers).toHaveLength(1);
    expect(response.result.resolvedCircuit?.ir.producers[0]).toMatchObject({
      kind: 'decider',
      config: {
        outputs: [
          {
            signal: {
              kind: 'signal',
              signal: { type: 'virtual', name: 'signal-value' },
            },
            value: 100,
          },
          {
            signal: {
              kind: 'signal',
              signal: { type: 'virtual', name: 'signal-value' },
            },
            value: 103,
          },
        ],
      },
    });
    expect(response.result).not.toHaveProperty('execution');
    expect(structuredClone(response)).toEqual(response);
  });

  test('compiles NetworkSignal source through the Worker request boundary', async () => {
    const response = await handleCompilerWorkerRequest({
      kind: 'parse',
      revision: 11,
      file: {
        path: 'worker-network-signal.factorio.ts',
        text: `const A = Signal('virtual', 'signal-A');
function Scale(value: NetworkSignal): Network {
  const output = new Network();
  output += value.network + 1;
  return output;
}
const input = new Network();
const output = Scale(input[A]);`,
      },
    });

    expect(response.result.compilerDiagnostics).toEqual([]);
    expect(response.result.plan?.capabilityUses).toMatchObject([
      { capability: 'readonly', parameter: 'value', network: 'input' },
    ]);
    expect(response.result.plan?.producers).toMatchObject([
      { kind: 'arithmetic', left: { kind: 'each', network: 'input' } },
    ]);
  });

  test('reports ordered cloneable progress for ordinary source compilation', async () => {
    const stages: CompilerWorkerProgressStage[] = [];
    const response = await handleCompilerWorkerRequest(
      {
        kind: 'parse',
        revision: 12,
        file: { path: 'main.factorio.ts', text: 'const output = new Network();' },
      },
      (stage) => stages.push(stage),
    );

    expect(response.kind).toBe('parsed');
    expect(stages).toEqual(['receive', 'parse', 'semantic', 'transform', 'execute', 'lower']);
  });

  test('validates and applies a cloneable diagnostic policy inside the Worker', async () => {
    const response = await handleCompilerWorkerRequest({
      kind: 'parse',
      revision: 120,
      file: { path: 'policy.factorio.ts', text: 'const input = new Network(); input + 1;' },
      diagnosticPolicy: {
        levels: { error: true, warning: true, note: true, hint: false },
        rules: { 'producer.unused-output': { enabled: false } },
        maxInstanceDetails: 3,
      },
    });
    expect(response.result.pipelineDiagnostics).toEqual([]);
    expect(response.result.plan).toBeDefined();
  });

  test('rejects a malformed diagnostic policy before source execution', async () => {
    const response = await handleCompilerWorkerRequest({
      kind: 'parse',
      revision: 121,
      file: { path: 'policy.factorio.ts', text: "throw new Error('source executed');" },
      diagnosticPolicy: { levels: { error: false } } as never,
    });
    expect(response.result.plan).toBeUndefined();
    expect(response.result.compilerDiagnostics).toEqual([
      expect.objectContaining({ code: 'WP1004', severity: 'error' }),
    ]);
    expect(response.result.compilerDiagnostics[0]?.message).toContain('levels.error');
    expect(response.result.compilerDiagnostics[0]?.message).not.toContain('source executed');
  });

  test('constructs the provider from cloneable JSON inside the request handler', async () => {
    const source = JSON.stringify(syntheticPrototypeDatabase());
    const { prototypes } = await loadPrototypeDatabase(syntheticPrototypeDatabase());
    const request: CompilerWorkerRequest = structuredClone({
      kind: 'parse',
      revision: 7,
      file,
      prototypeProfile: { source, expectedIdentity: prototypes.identity },
    });
    const response = await handleCompilerWorkerRequest(request);
    expect(structuredClone(response)).toMatchObject({
      kind: 'parsed',
      revision: 7,
      prototypeEnvironment: {
        identity: prototypes.identity,
        factorioVersion: '2.1.16',
        capabilities: prototypes.capabilities,
      },
      result: {
        compilerDiagnostics: [{ code: 'CL2001', severity: 'warning' }],
        plan: { producers: [{ kind: 'constant', outputs: [{ value: 100 }] }] },
      },
    });
    expect(request).not.toHaveProperty('prototypes');
  });

  test('normalizes raw input in the Worker and reports warnings without source-side parsing', async () => {
    const response = await handleCompilerWorkerRequest({
      kind: 'parse',
      revision: 8,
      file,
      prototypeProfile: { source: rawSource, factorioDumpMetadata: rawMetadata },
    });
    expect(response.prototypeEnvironment).toMatchObject({
      format: 'factorio-data-raw',
      factorioVersion: '2.1.17',
      warnings: [expect.objectContaining({ code: 'PD2002' })],
    });
    expect(response.result.compilerDiagnostics).toEqual([
      expect.objectContaining({ code: 'CL2001', severity: 'warning' }),
    ]);
  });

  test('validates a generated asset in the Worker and reuses its warm identity', async () => {
    const generated = await generatePrototypeAsset(rawSource, rawMetadata);
    const runtime = new CompilerWorkerRuntime();
    const first = await runtime.handle({
      kind: 'parse',
      revision: 13,
      file,
      prototypeProfile: {
        source: generated.databaseJson,
        assetManifest: generated.manifestJson,
        expectedIdentity: generated.manifest.databaseIdentity,
      },
    });

    expect(first.prototypeEnvironment).toMatchObject({
      identity: generated.manifest.databaseIdentity,
      format: 'normalized',
      warnings: [],
    });
    expect(first.result.compilerDiagnostics).toEqual([
      expect.objectContaining({ code: 'CL2001', severity: 'warning' }),
    ]);

    const warm = await runtime.handle({
      kind: 'parse',
      revision: 14,
      file,
      prototypeProfile: { identity: generated.manifest.databaseIdentity },
    });
    expect(warm.prototypeEnvironment?.identity).toBe(generated.manifest.databaseIdentity);
    expect(warm.result.compilerDiagnostics).toEqual([
      expect.objectContaining({ code: 'CL2001', severity: 'warning' }),
    ]);
  });

  test('preserves raw Entity configuration through imported Worker and warm identity requests', async () => {
    const runtime = new CompilerWorkerRuntime();
    const source = {
      path: 'worker-raw-entity.factorio.ts',
      text: `const machine = Entity('footprint-less', {
  raw: {
    recipe: 'iron-gear-wheel',
    control_behavior: { read_contents: true, enabled: false },
    sections: [{ filters: [{ name: 'iron-plate', count: 0 }], active: false }],
    modded_field: { empty: [], zero: 0, disabled: false },
  },
}).at(4, 5, 8);`,
    };
    const first = await runtime.handle({
      kind: 'parse',
      revision: 15,
      file: source,
      prototypeProfile: { source: rawSource, factorioDumpMetadata: rawMetadata },
    });

    expect(first.result.compilerDiagnostics).toEqual([]);
    const firstCircuit = first.result.resolvedCircuit;
    if (firstCircuit?.format !== 'comblang-resolved-circuit') {
      throw new Error('Expected a Worker canonical resolved circuit.');
    }
    expect(firstCircuit.ir.entities[0]?.configuration).toEqual({
      mode: 'raw',
      payload: {
        recipe: 'iron-gear-wheel',
        control_behavior: { read_contents: true, enabled: false },
        sections: [{ filters: [{ name: 'iron-plate', count: 0 }], active: false }],
        modded_field: { empty: [], zero: 0, disabled: false },
      },
    });
    expect(generateBlueprintJson(firstCircuit.ir).blueprint.entities[0]).toMatchObject({
      recipe: 'iron-gear-wheel',
      control_behavior: { read_contents: true, enabled: false },
      sections: [{ filters: [{ name: 'iron-plate', count: 0 }], active: false }],
      modded_field: { empty: [], zero: 0, disabled: false },
      entity_number: 1,
      name: 'footprint-less',
      position: { x: 4, y: 5 },
      direction: 8,
    });
    expect(JSON.stringify(first.result)).not.toMatch(/profiles|resolver|prototypeProvider/);
    expect(structuredClone(first)).toEqual(first);

    const warm = await runtime.handle({
      kind: 'parse',
      revision: 16,
      file: source,
      prototypeProfile: { identity: first.prototypeEnvironment!.identity },
    });
    expect(warm.result.compilerDiagnostics).toEqual([]);
    expect(warm.result.resolvedCircuit?.ir.entities[0]?.configuration).toEqual(
      firstCircuit.ir.entities[0]?.configuration,
    );
    expect(structuredClone(warm)).toEqual(warm);
  });

  test('transports a linked exact Constant as profile-free v4 data', async () => {
    const response = await new CompilerWorkerRuntime().handle({
      kind: 'parse',
      revision: 18,
      file: {
        path: 'worker-exact-constant.factorio.ts',
        text: `const A = Signal('virtual', 'signal-A');
 const exact = Constant({ isOn: false, sections: [{ active: true, group: 'backup', multiplier: 1.5, filters: [[A, 5]] }] }).at(4, 5);
const output = new Network();
output += exact;`,
      },
      prototypeProfile: { source: rawSource, factorioDumpMetadata: rawMetadata },
    });

    expect(response.result.compilerDiagnostics).toEqual([]);
    expect(response.result.plan).toMatchObject({
      entities: [
        {
          configuration: {
            mode: 'constant',
            value: {
              isOn: false,
              sections: [
                { active: true, group: 'backup', multiplier: 1.5, filters: [{ value: 5 }] },
              ],
            },
          },
        },
      ],
    });
    expect(response.result.resolvedCircuit?.format).toBe('comblang-resolved-circuit');
    if (response.result.resolvedCircuit?.format === 'comblang-resolved-circuit') {
      expect(response.result.resolvedCircuit.ir.entities).toHaveLength(1);
      expect(response.result.resolvedCircuit.ir.entities[0]?.configuration).toMatchObject({
        mode: 'constant',
        value: {
          sections: [{ active: true, group: 'backup', multiplier: 1.5, filters: [{ value: 5 }] }],
        },
      });
      expect(response.result.resolvedCircuit.ir.producers[0]).toMatchObject({
        config: { configuration: { sections: [{ group: 'backup', multiplier: 1.5 }] } },
      });
    }
    expect(JSON.stringify(response.result)).not.toMatch(
      /profiles|resolver|prototypeProvider|trustedEntityReplayContext/,
    );
    expect(response.result).not.toHaveProperty('execution');
    expect(structuredClone(response)).toEqual(response);
  });

  test('transports a linked exact Arithmetic as profile-free v5 data', async () => {
    const response = await new CompilerWorkerRuntime().handle({
      kind: 'parse',
      revision: 20,
      file: {
        path: 'worker-exact-arithmetic.factorio.ts',
        text: `const A = Signal('virtual', 'signal-A');
const input = new Network();
const exact: ArithmeticCombinator = Arithmetic({ left: input[A], operation: 'multiply', right: 2, output: A }).at(4, 5);
const output = new Network();
output += exact;`,
      },
      prototypeProfile: { source: rawSource, factorioDumpMetadata: rawMetadata },
    });

    expect(response.result.compilerDiagnostics).toEqual([]);
    expect(response.result.plan).toMatchObject({
      producers: [{ kind: 'arithmetic', entityId: expect.any(String) }],
      entities: [{ configuration: { mode: 'arithmetic', operation: 'multiply' } }],
    });
    expect(response.result.resolvedCircuit?.format).toBe('comblang-resolved-circuit');
    expect(JSON.stringify(response.result)).not.toMatch(
      /profiles|resolver|prototypeProvider|trustedEntityReplayContext/,
    );
    expect(response.result).not.toHaveProperty('execution');
    expect(structuredClone(response)).toEqual(response);
  });

  test('transports a linked exact Decider with row origins as profile-free v6 data', async () => {
    const host = exactDeciderHostContext();
    const runtime = new CompilerWorkerRuntime({
      resolveEntityReplayContext: () => host,
    });
    const response = await runtime.handle({
      kind: 'parse',
      revision: 24,
      file: {
        path: 'worker-exact-decider.factorio.ts',
        text: `const A = Signal('virtual', 'signal-A');
const input = new Network();
const exact: DeciderCombinator = Decider({ condition: input[A] > 0, outputs: [input[A]], elseOutputs: [1 * A] });
const output = new Network();
output += exact;`,
      },
      entityReplayContext: host.entityReplayContext,
    });

    expect(response.result.compilerDiagnostics).toEqual([]);
    expect(response.result.plan).toMatchObject({
      producers: [{ kind: 'decider', entityId: expect.any(String) }],
      entities: [
        {
          configuration: { mode: 'decider' },
        },
      ],
    });
    expect(response.result.resolvedCircuit?.ir.entities[0]).toMatchObject({
      prototypeName: 'decider-combinator',
    });
    expect(response.result.resolvedCircuit?.format).toBe('comblang-resolved-circuit');
    const producer = response.result.resolvedCircuit?.ir.producers[0];
    expect(producer).toMatchObject({ kind: 'decider', outputOrigins: [{ branch: 'normal' }] });
    expect(JSON.stringify(response.result)).not.toMatch(
      /profiles|resolver|prototypeProvider|trustedEntityReplayContext/,
    );
    expect(response.result).not.toHaveProperty('execution');
    expect(structuredClone(response)).toEqual(response);
  });

  test('transports a linked exact Selector as profile-free v7 data', async () => {
    const host = exactSelectorHostContext();
    const runtime = new CompilerWorkerRuntime({
      resolveEntityReplayContext: () => host,
    });
    const response = await runtime.handle({
      kind: 'parse',
      revision: 25,
      file: {
        path: 'worker-exact-selector.factorio.ts',
        text: `const A = Signal('virtual', 'signal-A');
const input = new Network();
const exact: SelectorCombinator = Selector({ input, operation: 'count', output: A });
const output = new Network();
output += exact;`,
      },
      entityReplayContext: host.entityReplayContext,
    });

    expect(response.result.compilerDiagnostics).toEqual([]);
    expect(response.result.plan).toMatchObject({
      producers: [{ kind: 'selector', entityId: expect.any(String) }],
      entities: [{ configuration: { mode: 'selector', operation: 'count' } }],
    });
    expect(response.result.resolvedCircuit).toMatchObject({
      format: 'comblang-resolved-circuit',
      ir: { entities: [{ prototypeName: 'selector-combinator' }] },
    });
    expect(JSON.stringify(response.result)).not.toMatch(
      /profiles|resolver|prototypeProvider|trustedEntityReplayContext|prototypeType/,
    );
    expect(response.result).not.toHaveProperty('execution');
    expect(structuredClone(response)).toEqual(response);
  });

  test('accepts a schema-checked Entity fragment and detaches a source Signal in the Worker', async () => {
    const runtime = new CompilerWorkerRuntime();
    const response = await runtime.handle({
      kind: 'parse',
      revision: 17,
      file: {
        path: 'worker-checked-entity.factorio.ts',
        text: `const signal = Signal('virtual', 'signal-A');
const machine = Entity('footprint-less', {
  recipe: 'iron-gear-wheel',
  control_behavior: { read_contents: false, working_signal: signal },
}).at(4, 5, 8);`,
      },
      prototypeProfile: { source: rawSource, factorioDumpMetadata: rawMetadata },
    });

    expect(response.result.compilerDiagnostics).toEqual([]);
    expect(response.result.resolvedCircuit?.ir.entities[0]?.configuration).toEqual({
      mode: 'raw',
      payload: {
        recipe: 'iron-gear-wheel',
        control_behavior: {
          read_contents: false,
          working_signal: { type: 'virtual', name: 'signal-A' },
        },
      },
    });
    expect(structuredClone(response)).toEqual(response);
  });

  test('constructs and detaches a Lamp facade in the Worker', async () => {
    const runtime = new CompilerWorkerRuntime();
    const response = await runtime.handle({
      kind: 'parse',
      revision: 18,
      file: {
        path: 'worker-lamp.factorio.ts',
        text: `const lamp = Lamp('fixture-lamp', { always_on: false }).at(4, 5, 8);`,
      },
      prototypeProfile: { source: rawSource, factorioDumpMetadata: rawMetadata },
    });

    expect(response.result.compilerDiagnostics).toEqual([]);
    expect(response.result.resolvedCircuit?.ir.entities).toEqual([
      expect.objectContaining({
        profile: expect.objectContaining({ prototypeKey: 'entity:fixture-lamp' }),
        placement: { x: 4, y: 5, direction: 8 },
        configuration: { mode: 'raw', payload: { always_on: false } },
      }),
    ]);
    expect(structuredClone(response)).toEqual(response);
  });

  test('constructs and detaches a Roboport facade in the Worker', async () => {
    const runtime = new CompilerWorkerRuntime();
    const response = await runtime.handle({
      kind: 'parse',
      revision: 19,
      file: {
        path: 'worker-roboport.factorio.ts',
        text: `const roboport = Roboport('fixture-roboport', { raw: { request_filters: { sections: [] } } }).at(4, 5, 8);`,
      },
      prototypeProfile: { source: rawSource, factorioDumpMetadata: rawMetadata },
    });

    expect(response.result.compilerDiagnostics).toEqual([]);
    expect(response.result.resolvedCircuit?.ir.entities).toEqual([
      expect.objectContaining({
        profile: expect.objectContaining({ prototypeKey: 'entity:fixture-roboport' }),
        placement: { x: 4, y: 5, direction: 8 },
        configuration: { mode: 'raw', payload: { request_filters: { sections: [] } } },
      }),
    ]);
    expect(structuredClone(response)).toEqual(response);
  });

  test('constructs and detaches a checked Constant Entity facade in the Worker', async () => {
    const runtime = new CompilerWorkerRuntime();
    const response = await runtime.handle({
      kind: 'parse',
      revision: 21,
      file: {
        path: 'worker-constant-entity.factorio.ts',
        text: `const constant = Constant('fixture-constant', { player_description: 'worker fixture', control_behavior: { is_on: false, sections: { sections: [] } } }).at(4, 5, 8);`,
      },
      prototypeProfile: { source: rawSource, factorioDumpMetadata: rawMetadata },
    });

    expect(response.result.compilerDiagnostics).toEqual([]);
    expect(response.result.resolvedCircuit?.ir.entities).toEqual([
      expect.objectContaining({
        profile: expect.objectContaining({ prototypeKey: 'entity:fixture-constant' }),
        placement: { x: 4, y: 5, direction: 8 },
        configuration: {
          mode: 'raw',
          payload: {
            player_description: 'worker fixture',
            control_behavior: { is_on: false, sections: { sections: [] } },
          },
        },
      }),
    ]);
    expect(structuredClone(response)).toEqual(response);
  });

  test('constructs and detaches a checked Selector facade in the Worker', async () => {
    const runtime = new CompilerWorkerRuntime();
    const response = await runtime.handle({
      kind: 'parse',
      revision: 23,
      file: {
        path: 'worker-selector-entity.factorio.ts',
        text: `const selector = Selector('fixture-selector', { control_behavior: { operation: 'select', select_max: false, index_constant: 0 } }).at(4, 5, 8);`,
      },
      prototypeProfile: { source: rawSource, factorioDumpMetadata: rawMetadata },
    });

    expect(response.result.compilerDiagnostics).toEqual([]);
    expect(response.result.resolvedCircuit?.ir.entities).toEqual([
      expect.objectContaining({
        profile: expect.objectContaining({ prototypeKey: 'entity:fixture-selector' }),
        placement: { x: 4, y: 5, direction: 8 },
        configuration: {
          mode: 'raw',
          payload: {
            control_behavior: { operation: 'select', select_max: false, index_constant: 0 },
          },
        },
      }),
    ]);
    expect(structuredClone(response)).toEqual(response);
  });

  test('constructs and detaches a checked logistics Entity in the Worker', async () => {
    const runtime = new CompilerWorkerRuntime();
    const response = await runtime.handle({
      kind: 'parse',
      revision: 22,
      file: {
        path: 'worker-logistics-entity.factorio.ts',
        text: `const chest = Entity('fixture-logistics', {
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
}).at(4, 5, 8);`,
      },
      prototypeProfile: { source: rawSource, factorioDumpMetadata: rawMetadata },
    });

    expect(response.result.compilerDiagnostics).toEqual([]);
    expect(response.result.resolvedCircuit?.ir.entities).toEqual([
      expect.objectContaining({
        profile: expect.objectContaining({ prototypeKey: 'entity:fixture-logistics' }),
        placement: { x: 4, y: 5, direction: 8 },
        configuration: {
          mode: 'raw',
          payload: {
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
        },
      }),
    ]);
    expect(structuredClone(response)).toEqual(response);
  });

  test('provisions built-in Entity profiles only after the Worker loads the provider', async () => {
    const generated = await generatePrototypeAsset(rawSource, rawMetadata);
    const runtime = new CompilerWorkerRuntime();
    const first = await runtime.handle({
      kind: 'parse',
      revision: 20,
      file: {
        path: 'builtin-entity.factorio.ts',
        text: `const short = Entity('footprint-less', { raw: { recipe: 'iron-gear-wheel' } });
const canonical = Entity('entity:footprint-less');
short.at(1, 2);`,
      },
      prototypeProfile: {
        kind: 'builtin',
        source: generated.databaseJson,
        assetManifest: generated.manifestJson,
        expectedIdentity: generated.manifest.databaseIdentity,
      },
    });

    expect(first.result.compilerDiagnostics).toEqual([]);
    expect(first.result.plan).toMatchObject({
      entities: [
        {
          profile: {
            prototypeKey: 'entity:footprint-less',
            database: { identity: generated.manifest.databaseIdentity },
          },
          placement: { x: 1, y: 2 },
          configuration: { mode: 'raw', payload: { recipe: 'iron-gear-wheel' } },
        },
        { profile: { prototypeKey: 'entity:footprint-less' } },
      ],
    });
    expect(
      first.result.plan && 'entities' in first.result.plan ? first.result.plan.entities : [],
    ).toHaveLength(2);
    expect(first.result).not.toHaveProperty('execution');
    expect(JSON.stringify(first.result)).not.toMatch(/profiles|resolver|prototypeProvider/);
    expect(structuredClone(first)).toEqual(first);

    const ordinary = await runtime.handle({
      kind: 'parse',
      revision: 21,
      file: { path: 'builtin-ordinary.factorio.ts', text: 'const output = new Network();' },
      prototypeProfile: { kind: 'builtin', identity: generated.manifest.databaseIdentity },
    });
    expect(ordinary.result.compilerDiagnostics).toEqual([]);
    expect(ordinary.result.plan).toMatchObject({ entities: [] });
    expect(ordinary.result.plan).not.toHaveProperty('version');
    expect(ordinary.result.resolvedCircuit?.format).toBe('comblang-resolved-circuit');
  });

  test('provisions a selected provider when routing kind is omitted, including warm identity use', async () => {
    const generated = await generatePrototypeAsset(rawSource, rawMetadata);
    const runtime = new CompilerWorkerRuntime();
    const first = await runtime.handle({
      kind: 'parse',
      revision: 27,
      file: {
        path: 'kindless-entity.factorio.ts',
        text: `const entity = Entity('footprint-less').at(2, 3);`,
      },
      prototypeProfile: {
        source: generated.databaseJson,
        assetManifest: generated.manifestJson,
        expectedIdentity: generated.manifest.databaseIdentity,
      },
    });
    expect(first.result.compilerDiagnostics).toEqual([]);
    expect(first.result.plan).toMatchObject({
      entities: [{ profile: { prototypeKey: 'entity:footprint-less' } }],
    });

    const warm = await runtime.handle({
      kind: 'parse',
      revision: 28,
      file: {
        path: 'kindless-warm-entity.factorio.ts',
        text: `const entity = Entity('footprint-less');`,
      },
      prototypeProfile: { identity: generated.manifest.databaseIdentity },
    });
    expect(warm.result.compilerDiagnostics).toEqual([]);
    expect(warm.result.plan).toMatchObject({
      entities: [{ profile: { prototypeKey: 'entity:footprint-less' } }],
    });
  });

  test('preserves a matching reviewed context instead of replacing it with fallback profiles', async () => {
    const loaded = await loadPrototypeDatabase(syntheticPrototypeDatabase());
    const reviewed = {
      ...structuredClone(syntheticZeroPortEntityProfile),
      ref: {
        ...syntheticZeroPortEntityProfile.ref,
        prototypeKey: 'entity:assembling-machine-3' as const,
        database: {
          schemaVersion: loaded.prototypes.schemaVersion,
          identity: loaded.prototypes.identity,
        },
      },
    };
    const trusted = createTrustedEntityReplayContext({
      database: reviewed.ref.database,
      source: 'provider',
      evidenceIdentity: 'reviewed-provider-evidence-v1',
      policyIdentity: 'reviewed-provider-policy-v1',
      profiles: [reviewed],
    });
    const runtime = new CompilerWorkerRuntime({
      resolveEntityReplayContext: () => ({
        trustedEntityReplayContext: trusted,
        entityPrototypeResolver: {
          database: reviewed.ref.database,
          getEntity: (nameOrKey) => loaded.prototypes.getEntity(nameOrKey),
        },
      }),
    });
    const response = await runtime.handle({
      kind: 'parse',
      revision: 29,
      file: {
        path: 'reviewed-provider-entity.factorio.ts',
        text: `const entity = Entity('assembling-machine-3');`,
      },
      prototypeProfile: {
        kind: 'custom',
        source: JSON.stringify(syntheticPrototypeDatabase()),
        expectedIdentity: loaded.prototypes.identity,
      },
      entityReplayContext: entityReplayContextTransport(trusted),
    });

    expect(response.result.compilerDiagnostics).toEqual([]);
    expect(response.result.plan).toMatchObject({
      entities: [{ profile: reviewed.ref }],
    });
    expect(response.result.entityReplayContext).toEqual(entityReplayContextTransport(trusted));
  });

  test('rejects a reviewed context whose database does not match the selected provider', async () => {
    const loaded = await loadPrototypeDatabase(syntheticPrototypeDatabase());
    const mismatched = createTrustedEntityReplayContext({
      database: { schemaVersion: loaded.prototypes.schemaVersion, identity: 'database-other' },
      source: 'provider',
      evidenceIdentity: 'mismatched-evidence-v1',
      policyIdentity: 'mismatched-policy-v1',
      profiles: [],
    });
    const response = await new CompilerWorkerRuntime({
      resolveEntityReplayContext: () => ({ trustedEntityReplayContext: mismatched }),
    }).handle({
      kind: 'parse',
      revision: 30,
      file: { path: 'mismatched-provider.factorio.ts', text: `throw new Error('executed');` },
      prototypeProfile: {
        source: JSON.stringify(syntheticPrototypeDatabase()),
        expectedIdentity: loaded.prototypes.identity,
      },
      entityReplayContext: entityReplayContextTransport(mismatched),
    });

    expect(response.result.plan).toBeUndefined();
    expect(response.result.compilerDiagnostics).toEqual([
      expect.objectContaining({ code: 'ER1001', severity: 'error' }),
    ]);
    expect(response.result.compilerDiagnostics[0]?.message).not.toContain('executed');
  });

  test('does not construct a non-blueprintable transient Entity', async () => {
    const database = structuredClone(syntheticPrototypeDatabase()) as {
      capabilities: { entityCircuitCapabilities: boolean };
      entities: Array<Record<string, unknown>>;
    };
    database.capabilities.entityCircuitCapabilities = false;
    database.entities.push({
      key: 'entity:grenade',
      name: 'grenade',
      type: 'projectile',
      blueprintEligible: false,
    });
    const response = await new CompilerWorkerRuntime().handle({
      kind: 'parse',
      revision: 31,
      file: {
        path: 'transient-entity.factorio.ts',
        text: `const entity = Entity('grenade');
throw new Error('source executed');`,
      },
      prototypeProfile: { source: JSON.stringify(database) },
    });

    expect(response.result.plan).toBeUndefined();
    expect(response.result.compilerDiagnostics).toEqual([
      expect.objectContaining({ code: 'RT2027', severity: 'error' }),
    ]);
    expect(response.result.compilerDiagnostics[0]?.message).not.toContain('source executed');
  });

  test('does not let a spoofed built-in pin grant Entity authority', async () => {
    const generated = await generatePrototypeAsset(rawSource, rawMetadata);
    const response = await new CompilerWorkerRuntime().handle({
      kind: 'parse',
      revision: 22,
      file: {
        path: 'builtin-spoofed-pin.factorio.ts',
        text: `throw new Error('source executed');`,
      },
      prototypeProfile: {
        kind: 'builtin',
        source: generated.databaseJson,
        assetManifest: generated.manifestJson,
        expectedIdentity: 'comblang-prototypes-v1-sha256:' + '0'.repeat(64),
      },
    });

    expect(response.prototypeEnvironment).toBeUndefined();
    expect(response.result.plan).toBeUndefined();
    expect(response.result.compilerDiagnostics).toEqual([
      expect.objectContaining({ code: 'WP1001', severity: 'error' }),
    ]);
    expect(response.result.compilerDiagnostics[0]?.message).not.toContain('source executed');
  });

  test('provisions an imported raw provider without inheriting built-in Entity facts', async () => {
    const runtime = new CompilerWorkerRuntime();
    const imported = await runtime.handle({
      kind: 'parse',
      revision: 23,
      file: {
        path: 'imported-entity.factorio.ts',
        text: `const entity = Entity('footprint-less').at(3, 4);`,
      },
      prototypeProfile: {
        kind: 'custom',
        source: rawSource,
        factorioDumpMetadata: rawMetadata,
      },
    });

    expect(imported.result.compilerDiagnostics).toEqual([]);
    expect(imported.result.plan).toMatchObject({
      entities: [{ profile: { prototypeKey: 'entity:footprint-less' } }],
    });

    const inherited = await runtime.handle({
      kind: 'parse',
      revision: 24,
      file: {
        path: 'imported-no-inheritance.factorio.ts',
        text: `const entity = Entity('assembling-machine-3');
throw new Error('source executed');`,
      },
      prototypeProfile: { kind: 'custom', identity: imported.prototypeEnvironment!.identity },
    });
    expect(inherited.result.plan).toBeUndefined();
    expect(inherited.result.compilerDiagnostics).toEqual([
      expect.objectContaining({ code: 'RT2027', severity: 'error' }),
    ]);
    expect(inherited.result.compilerDiagnostics[0]?.message).not.toContain('source executed');
  });

  test('retains imported prototype types for generic and family Entity paths without transporting them', async () => {
    const loaded = await loadPrototypeInputJson(rawSource, {
      factorioDumpMetadata: rawMetadata,
    });
    const provisioned = new EntityProvisioningService().provision(
      loaded.prototypes,
      conservativeEntityProvisioningPolicy,
    );
    expect(
      provisioned.profiles.find(({ ref }) => ref.prototypeKey === 'entity:footprint-less'),
    ).toMatchObject({ prototypeType: 'assembling-machine' });
    expect(
      provisioned.profiles.find(({ ref }) => ref.prototypeKey === 'entity:fixture-lamp'),
    ).toMatchObject({ prototypeType: 'lamp' });

    const response = await new CompilerWorkerRuntime().handle({
      kind: 'parse',
      revision: 32,
      file: {
        path: 'imported-family-entities.factorio.ts',
        text: `const machine = Entity('footprint-less');
const lamp = Lamp('fixture-lamp');`,
      },
      prototypeProfile: {
        kind: 'custom',
        source: rawSource,
        factorioDumpMetadata: rawMetadata,
      },
    });

    expect(response.result.compilerDiagnostics).toEqual([]);
    const plan = response.result.plan;
    if (plan === undefined) throw new Error('Expected a canonical Entity plan.');
    expect(plan.entities).toHaveLength(2);
    expect(JSON.stringify(response.result.resolvedCircuit)).not.toContain('prototypeType');
  });

  test('keeps imported provider caches isolated across Worker runtimes and identities', async () => {
    const first = new CompilerWorkerRuntime();
    const second = new CompilerWorkerRuntime();
    const firstLoaded = await first.handle({
      kind: 'parse',
      revision: 25,
      file,
      prototypeProfile: { kind: 'custom', source: rawSource, factorioDumpMetadata: rawMetadata },
    });
    const identity = firstLoaded.prototypeEnvironment!.identity;
    const miss = await second.handle({
      kind: 'parse',
      revision: 26,
      file,
      prototypeProfile: { kind: 'custom', identity },
    });
    expect(miss.prototypeEnvironment).toBeUndefined();
    expect(miss.result.compilerDiagnostics).toEqual([
      expect.objectContaining({ code: 'WP1002', severity: 'error' }),
    ]);
  });

  test('reports generated asset integrity failures through the profile diagnostic boundary', async () => {
    const generated = await generatePrototypeAsset(rawSource, rawMetadata);
    const manifest = JSON.parse(generated.manifestJson) as { outputSha256: string };
    manifest.outputSha256 = 'sha256:' + '0'.repeat(64);
    const response = await handleCompilerWorkerRequest({
      kind: 'parse',
      revision: 15,
      file: { path: 'main.factorio.ts', text: `throw new Error('source executed');` },
      prototypeProfile: {
        source: generated.databaseJson,
        assetManifest: JSON.stringify(manifest),
      },
    });

    expect(response.prototypeEnvironment).toBeUndefined();
    expect(response.result.plan).toBeUndefined();
    expect(response.result.compilerDiagnostics).toEqual([
      expect.objectContaining({ code: 'PA1003', severity: 'error' }),
    ]);
    expect(response.result.compilerDiagnostics[0]?.message).not.toContain('source executed');
  });

  test('rejects ambiguous raw-metadata and generated-manifest profile inputs', async () => {
    const generated = await generatePrototypeAsset(rawSource, rawMetadata);
    const response = await handleCompilerWorkerRequest({
      kind: 'parse',
      revision: 16,
      file: { path: 'main.factorio.ts', text: `throw new Error('source executed');` },
      prototypeProfile: {
        source: generated.databaseJson,
        factorioDumpMetadata: rawMetadata,
        assetManifest: generated.manifestJson,
      },
    });

    expect(response.prototypeEnvironment).toBeUndefined();
    expect(response.result.plan).toBeUndefined();
    expect(response.result.compilerDiagnostics).toEqual([
      expect.objectContaining({ code: 'WP1001', severity: 'error' }),
    ]);
    expect(response.result.compilerDiagnostics[0]?.message).toContain('cannot combine');
    expect(response.result.compilerDiagnostics[0]?.message).not.toContain('source executed');
  });

  test.each([
    { profile: { source: '{' }, code: 'PT1006' },
    { profile: { source: rawSource }, code: 'PI1002' },
    { profile: { source: JSON.stringify({ schemaVersion: 99 }) }, code: 'PT1000' },
    {
      profile: { source: JSON.stringify(syntheticPrototypeDatabase()), expectedIdentity: 'wrong' },
      code: 'WP1001',
    },
  ])(
    'returns $code and never executes source for an invalid profile',
    async ({ profile, code }) => {
      const response = await handleCompilerWorkerRequest({
        kind: 'parse',
        revision: 1,
        file: { path: 'main.factorio.ts', text: `throw new Error('source executed');` },
        prototypeProfile: profile,
      });
      expect(response.prototypeEnvironment).toBeUndefined();
      expect(response.result.plan).toBeUndefined();
      expect(response.result.compilerDiagnostics).toEqual([
        expect.objectContaining({ code, severity: 'error' }),
      ]);
      expect(response.result.compilerDiagnostics[0]?.message).not.toContain('source executed');
    },
  );

  test('does not reuse a profile in a later unprofiled request', async () => {
    const source = JSON.stringify(syntheticPrototypeDatabase());
    expect(
      (
        await handleCompilerWorkerRequest({
          kind: 'parse',
          revision: 1,
          file,
          prototypeProfile: { source },
        })
      ).result.compilerDiagnostics,
    ).toEqual([expect.objectContaining({ code: 'CL2001', severity: 'warning' })]);
    expect(
      (
        await handleCompilerWorkerRequest({
          kind: 'parse',
          revision: 2,
          file,
        })
      ).result.compilerDiagnostics,
    ).toEqual([expect.objectContaining({ code: 'EX1004' })]);
  });

  test('reuses only an explicitly selected identity in one Worker and reports cache misses', async () => {
    const runtime = new CompilerWorkerRuntime();
    const first = await runtime.handle({
      kind: 'parse',
      revision: 1,
      file,
      prototypeProfile: { source: JSON.stringify(syntheticPrototypeDatabase()) },
    });
    const identity = first.prototypeEnvironment!.identity;
    expect(
      (
        await runtime.handle({
          kind: 'parse',
          revision: 2,
          file,
          prototypeProfile: structuredClone({ identity }),
        })
      ).result.compilerDiagnostics,
    ).toEqual([expect.objectContaining({ code: 'CL2001', severity: 'warning' })]);
    const missing = await new CompilerWorkerRuntime().handle({
      kind: 'parse',
      revision: 3,
      file,
      prototypeProfile: { identity },
    });
    expect(missing.result.compilerDiagnostics).toEqual([
      expect.objectContaining({
        code: 'WP1002',
        message: expect.stringContaining('send its database JSON again'),
      }),
    ]);
    expect(missing.prototypeEnvironment).toBeUndefined();
  });

  test('round-trips the minimum v3 context and invalidates its cache identity', async () => {
    const trusted = createTrustedEntityReplayContext({
      database: syntheticZeroPortEntityProfile.ref.database,
      source: 'synthetic',
      evidenceIdentity: 'comblang-synthetic-evidence-v1',
      policyIdentity: 'comblang-entity-policy-v1',
      profiles: [syntheticZeroPortEntityProfile],
    });
    const entityReplayContext = entityReplayContextTransport(trusted);
    const response = await handleCompilerWorkerRequest(
      structuredClone({
        kind: 'parse',
        revision: 9,
        file: { path: 'main.factorio.ts', text: 'const output = new Network();' },
        entityReplayContext,
      }),
    );

    expect(structuredClone(response)).toMatchObject({
      kind: 'parsed',
      revision: 9,
      result: {
        entityReplayContext,
        entityReplayIdentity: expect.stringContaining('comblang-synthetic-evidence-v1'),
      },
    });
    expect(response.result).not.toHaveProperty('provider');
    expect(response.result).not.toHaveProperty('entityRegistry');
    expect(
      await handleCompilerWorkerRequest({
        kind: 'parse',
        revision: 10,
        file: { path: 'main.factorio.ts', text: 'const output = new Network();' },
        entityReplayContext: { ...entityReplayContext, evidenceIdentity: 'other-evidence' },
      }),
    ).toMatchObject({
      result: {
        entityReplayIdentity: expect.not.stringContaining('comblang-synthetic-evidence-v1'),
      },
    });
  });

  test('resolves a host-owned trusted context after the transport boundary and compiles Entity source', async () => {
    const trusted = createTrustedEntityReplayContext({
      database: syntheticZeroPortEntityProfile.ref.database,
      source: 'synthetic',
      evidenceIdentity: 'comblang-synthetic-evidence-v1',
      policyIdentity: 'comblang-entity-policy-v1',
      profiles: [syntheticZeroPortEntityProfile],
    });
    const prototype = {
      key: syntheticZeroPortEntityProfile.ref.prototypeKey,
      name: 'synthetic-zero-port',
      type: 'container',
    } as EntityPrototype;
    const runtime = new CompilerWorkerRuntime({
      resolveEntityReplayContext(transport) {
        return transport.profileSetIdentity === trusted.profileSetIdentity
          ? {
              trustedEntityReplayContext: trusted,
              entityPrototypeResolver: {
                database: trusted.database,
                getEntity(nameOrKey: string) {
                  return nameOrKey === prototype.key || nameOrKey === prototype.name
                    ? prototype
                    : undefined;
                },
              },
            }
          : undefined;
      },
    });
    const response = await runtime.handle({
      kind: 'parse',
      revision: 17,
      file: {
        path: 'worker-entity.factorio.ts',
        text: `const entity = Entity('entity:synthetic-zero-port');`,
      },
      entityReplayContext: entityReplayContextTransport(trusted),
    });

    expect(response.result.compilerDiagnostics).toEqual([]);
    expect(response.result.plan).toMatchObject({
      entities: [{ profile: syntheticZeroPortEntityProfile.ref }],
    });
    expect(response.result.resolvedCircuit).toMatchObject({
      format: 'comblang-resolved-circuit',
      ir: {
        format: 'comblang-ncir',
        entities: [expect.objectContaining({ profile: syntheticZeroPortEntityProfile.ref })],
      },
    });
    expect(JSON.stringify(response.result.resolvedCircuit)).not.toMatch(
      /profiles|function|resolver|prototypeProvider|trustedEntityReplayContext/,
    );
    expect(response.result).not.toHaveProperty('execution');
    expect(structuredClone(response)).toEqual(response);
  });

  test('keeps a cloneable Entity transport powerless without a Worker host resolver', async () => {
    const trusted = createTrustedEntityReplayContext({
      database: syntheticZeroPortEntityProfile.ref.database,
      source: 'synthetic',
      evidenceIdentity: 'comblang-synthetic-evidence-v1',
      policyIdentity: 'comblang-entity-policy-v1',
      profiles: [syntheticZeroPortEntityProfile],
    });
    const response = await new CompilerWorkerRuntime().handle({
      kind: 'parse',
      revision: 19,
      file: {
        path: 'worker-entity-without-host.factorio.ts',
        text: `const entity = Entity('entity:synthetic-zero-port');`,
      },
      entityReplayContext: entityReplayContextTransport(trusted),
    });

    expect(response.result.plan).toBeUndefined();
    expect(response.result.resolvedCircuit).toBeUndefined();
    expect(response.result.compilerDiagnostics).toEqual([
      expect.objectContaining({ code: 'RT2027', severity: 'error' }),
    ]);
  });

  test('rejects a host resolver returning a different trusted identity before source execution', async () => {
    const trusted = createTrustedEntityReplayContext({
      database: syntheticZeroPortEntityProfile.ref.database,
      source: 'synthetic',
      evidenceIdentity: 'comblang-synthetic-evidence-v1',
      policyIdentity: 'comblang-entity-policy-v1',
      profiles: [syntheticZeroPortEntityProfile],
    });
    const other = createTrustedEntityReplayContext({
      database: syntheticZeroPortEntityProfile.ref.database,
      source: 'synthetic',
      evidenceIdentity: 'other-evidence',
      policyIdentity: 'comblang-entity-policy-v1',
      profiles: [syntheticZeroPortEntityProfile],
    });
    const runtime = new CompilerWorkerRuntime({
      resolveEntityReplayContext: () => ({ trustedEntityReplayContext: other }),
    });
    const response = await runtime.handle({
      kind: 'parse',
      revision: 18,
      file: { path: 'worker-entity-mismatch.factorio.ts', text: `throw new Error('executed');` },
      entityReplayContext: entityReplayContextTransport(trusted),
    });

    expect(response.result.plan).toBeUndefined();
    expect(response.result.compilerDiagnostics).toEqual([
      expect.objectContaining({ code: 'ER1001', severity: 'error' }),
    ]);
    expect(response.result.compilerDiagnostics[0]?.message).not.toContain('executed');
  });

  test('rejects an unbound provider replay context before Worker source execution', async () => {
    const loaded = await loadPrototypeDatabase(syntheticPrototypeDatabase());
    const profile = {
      ...structuredClone(syntheticZeroPortEntityProfile),
      ref: {
        ...syntheticZeroPortEntityProfile.ref,
        database: {
          schemaVersion: loaded.database.schemaVersion,
          identity: loaded.prototypes.identity,
        },
      },
    };
    const trusted = createTrustedEntityReplayContext({
      database: profile.ref.database,
      source: 'provider',
      evidenceIdentity: 'provider-evidence-v1',
      policyIdentity: 'provider-policy-v1',
      profiles: [profile],
    });
    const response = await handleCompilerWorkerRequest({
      kind: 'parse',
      revision: 10,
      file: { path: 'main.factorio.ts', text: `throw new Error('source executed');` },
      prototypeProfile: { source: JSON.stringify(syntheticPrototypeDatabase()) },
      entityReplayContext: entityReplayContextTransport(trusted),
    });

    expect(response.result.compilerDiagnostics[0]).toMatchObject({
      code: 'ER1001',
      severity: 'error',
    });
    expect(response.result.compilerDiagnostics[0]?.message).not.toContain('source executed');
  });

  test('rejects a non-cloneable or wrong-version v3 context before source execution', async () => {
    const response = await handleCompilerWorkerRequest({
      kind: 'parse',
      revision: 11,
      file: { path: 'main.factorio.ts', text: `throw new Error('source executed');` },
      entityReplayContext: {
        protocolVersion: 2,
        source: 'synthetic',
        database: { schemaVersion: 1, identity: 'db' },
        profileSetIdentity: 'profile-set' as never,
        evidenceIdentity: 'evidence',
        policyIdentity: 'policy',
      } as never,
    });
    expect(response.result.plan).toBeUndefined();
    expect(response.result.compilerDiagnostics[0]).toMatchObject({
      code: 'ER1000',
      severity: 'error',
      message: expect.stringContaining('protocolVersion'),
    });
    expect(response.result.compilerDiagnostics[0]?.message).not.toContain('source executed');
  });
});

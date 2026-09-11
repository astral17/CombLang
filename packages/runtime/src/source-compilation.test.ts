import {
  loadPrototypeDatabase,
  syntheticPrototypeDatabase,
  type EntityPrototype,
} from '@comblang/prototypes';
import { sourceFileId, sourceSpan, type Diagnostic } from '@comblang/shared';
import type { EntityProfile } from '@comblang/compiler/entity';
import {
  syntheticSharedTwoColorEntityProfile,
  syntheticZeroPortEntityProfile,
} from '@comblang/compiler/entity-fixtures';
import {
  createTrustedEntityReplayContext,
  entityReplayContextTransport,
} from '@comblang/compiler/entity-replay-context';
import { describe, expect, test } from 'vitest';

import type { EntityPrototypeResolver } from './entity-registry.js';

import {
  compileSourceProgram,
  sourceCompilationArtifact,
  type SourceCompilationStage,
} from './source-compilation.js';

function syntheticEntityHost(profile: EntityProfile) {
  const prototype = {
    key: profile.ref.prototypeKey as EntityPrototype['key'],
    name: profile.ref.prototypeKey.slice('entity:'.length),
    type: 'container',
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
      message: 'Entity(prototype) requires exactly one argument.',
    },
    {
      method: 'constructor',
      source: `Entity('entity:synthetic-shared-two-color', 'extra');`,
      message: 'Entity(prototype) requires exactly one argument.',
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
    expect(structuredClone(artifact)).toEqual(artifact);
    expect(compilation).not.toHaveProperty('entityRegistry');
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

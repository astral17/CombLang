import { describe, expect, test, vi } from 'vitest';
import { signal } from '@comblang/factorio';
import { sourceFileId, sourceSpan } from '@comblang/shared';
import { generateBlueprintJson } from '@comblang/compiler/blueprint-json';
import {
  syntheticZeroPortEntityProfile as zero,
  syntheticSharedTwoColorEntityProfile as shared,
  syntheticAmbiguousMultiConnectorEntityProfile as ambiguous,
} from '@comblang/compiler/entity-fixtures';
import {
  createTrustedEntityReplayContext,
  entityReplayContextRef,
} from '@comblang/compiler/entity-replay-context';
import type {
  EntityBehaviorKey,
  EntityLaneKey,
  EntityPlanRecord,
  EntityProfile,
} from '@comblang/compiler/entity';
import type { DirectElaborationPlan } from '@comblang/compiler/direct-plan-schema';
import { elaborateDirectPlan, tryElaborateDirectPlan } from './direct-plan.js';
import { projectEntityObjectConnectors } from './entity-object-adapter.js';
import { createDebugDocument } from './debug-document.js';
import { DslRuntime } from './elaboration.js';
import { lowerEntityRecords } from './entity-lowering.js';
import { canonicalDirectPlan } from './canonical-circuit.js';

const source = sourceSpan(sourceFileId('physical.ts'), 1, 10);
const contextFor = (profiles: readonly EntityProfile[] = [zero, shared]) =>
  createTrustedEntityReplayContext({
    source: 'synthetic',
    database: zero.ref.database,
    profiles,
    evidenceIdentity: 'synthetic',
    policyIdentity: 'preview',
  });
function entity(profile = zero, ordinal = 1): EntityPlanRecord {
  return {
    id: `entity:${ordinal}` as EntityPlanRecord['id'],
    ordinal,
    profile: profile.ref,
    connectorBindings: [],
    provenance: { source, instancePath: [], expansionStack: [], creationRevision: 1 },
  };
}
function binding(color: 'red' | 'green', network: string, direction: 'input' | 'output' = 'input') {
  return {
    endpoint: shared.connectors[0]!.lanes.find((lane) => lane.color === color)!.nativeEndpoint!
      .endpoint,
    network,
    generation: 0,
    direction,
    provenance: { source, instancePath: [], operationOrdinal: color === 'red' ? 1 : 2 },
  };
}
function profileBinding(
  profile: EntityProfile,
  connectorKey: string,
  laneKey: string,
  network: string,
  direction: 'input' | 'output',
) {
  const connector = profile.connectors.find((candidate) => candidate.key === connectorKey);
  const lane = connector?.lanes.find((candidate) => candidate.key === laneKey);
  if (lane?.nativeEndpoint === undefined) throw new Error(`Missing synthetic endpoint ${laneKey}.`);
  return {
    endpoint: lane.nativeEndpoint.endpoint,
    network,
    generation: 0,
    direction,
    provenance: { source, instancePath: [], operationOrdinal: 1 },
  };
}

const feedbackProfile: EntityProfile = {
  ref: {
    ...shared.ref,
    prototypeKey: 'entity:synthetic-feedback',
    profileId: 'profile:synthetic-feedback-v1' as EntityProfile['ref']['profileId'],
  },
  connectors: [
    {
      key: 'feedback' as EntityProfile['connectors'][number]['key'],
      direction: 'bidirectional',
      lanes: [
        {
          key: 'feedback-input-red' as EntityProfile['connectors'][number]['lanes'][number]['key'],
          color: 'red',
          nativeEndpoint: {
            endpoint: {
              connector: 'feedback' as EntityProfile['connectors'][number]['key'],
              lane: 'feedback-input-red' as EntityProfile['connectors'][number]['lanes'][number]['key'],
              color: 'red',
            },
            nativeConnector: 2,
          },
        },
        {
          key: 'feedback-output-red' as EntityProfile['connectors'][number]['lanes'][number]['key'],
          color: 'red',
          nativeEndpoint: {
            endpoint: {
              connector: 'feedback' as EntityProfile['connectors'][number]['key'],
              lane: 'feedback-output-red' as EntityProfile['connectors'][number]['lanes'][number]['key'],
              color: 'red',
            },
            nativeConnector: 1,
          },
        },
      ],
    },
  ],
  features: [],
  configurationRules: [],
  defaultReadProjection: null,
  synthetic: true,
};
function fixture() {
  const context = contextFor();
  const plan: DirectElaborationPlan = {
    format: 'comblang-direct-plan',
    context: entityReplayContextRef(context),
    networks: [
      { name: 'input', fixedColor: 'red', generation: 0, source, instancePath: [] },
      { name: 'green', fixedColor: 'green', generation: 0, source, instancePath: [] },
    ],
    producers: [
      {
        kind: 'constant',
        outputs: [{ signal: signal('virtual', 'signal-A'), value: 2 }],
        destinations: [
          { network: 'input', source, instancePath: [] },
          { network: 'green', source, instancePath: [] },
        ],
        source,
        instancePath: [],
      },
    ],
    entities: [
      entity(),
      {
        ...entity(shared, 2),
        connectorBindings: [binding('red', 'input'), binding('green', 'green')],
        placement: { x: 8, y: 3, direction: 8 },
      },
    ],
  };
  return { plan, context };
}

describe('physical Entity preview vertical slice', () => {
  test('maps names to graph IDs once and connects Entity/combinator lanes', () => {
    const { plan, context } = fixture();
    const execution = elaborateDirectPlan(plan, context);
    const { graph, ir } = execution.circuit;
    expect(graph.entities).toBe(ir.entities);
    expect(graph.entities).toHaveLength(2);
    expect(graph.producers).toHaveLength(1);
    expect(graph.networks).toHaveLength(2);
    expect(execution.entity(2)).toBe(execution.entity(plan.entities[1]!.id));
    expect(
      execution
        .entity(2)
        .connectorBindings.map((b) => [b.endpoint.color, b.network, b.nativeConnector]),
    ).toEqual([
      ['green', execution.network('green').id, 1],
      ['red', execution.network('input').id, 1],
    ]);
    expect(execution.network('input').id).not.toBe('input');
    expect(Object.isFrozen(ir.entities[1]!.connectorBindings[0]!.endpoint)).toBe(true);
    const preview = generateBlueprintJson(ir).blueprint;
    expect(preview.entities).toHaveLength(3);
    expect(preview.entities[0]).toMatchObject({
      entity_number: 1,
      name: 'constant-combinator',
      position: { x: 0.5, y: 0.5 },
    });
    expect(preview.entities[1]).toEqual({
      entity_number: 2,
      name: 'synthetic-zero-port',
      position: { x: 2.5, y: 0.5 },
      direction: 4,
    });
    expect(preview.entities[2]).toEqual({
      entity_number: 3,
      name: 'synthetic-shared-two-color',
      position: { x: 8, y: 3 },
      direction: 8,
    });
    expect(preview.wires).toEqual([
      [1, 1, 3, 1],
      [1, 2, 3, 2],
    ]);
    expect(execution.circuit.createSimulation()).toBeDefined();
  });

  test('projects bound lanes into deterministic connector descriptors', () => {
    const { plan, context } = fixture();
    const execution = elaborateDirectPlan(plan, context);
    const record = execution.entity(2);
    const inputId = execution.network('input').id;
    const greenId = execution.network('green').id;

    expect(projectEntityObjectConnectors(record)).toEqual([
      { name: 'shared', inputNetworks: [greenId, inputId], outputNetworks: [] },
    ]);
    expect(
      projectEntityObjectConnectors({
        ...record,
        connectorBindings: record.connectorBindings.map((binding, index) => ({
          ...binding,
          direction: index === 0 ? ('output' as const) : ('input' as const),
        })),
      }),
    ).toEqual([{ name: 'shared', inputNetworks: [inputId], outputNetworks: [greenId] }]);
    expect(
      projectEntityObjectConnectors({
        ...record,
        connectorBindings: record.connectorBindings.map((binding) => ({
          ...binding,
          network: greenId,
        })),
      }),
    ).toEqual([{ name: 'shared', inputNetworks: [greenId], outputNetworks: [] }]);
    expect(projectEntityObjectConnectors(execution.entity(1))).toEqual([]);
  });

  test('registers one session-local object per physical Entity and preserves provider isolation', () => {
    const { plan, context } = fixture();
    const outputPlan = {
      ...plan,
      producers: [],
      entities: [
        {
          ...plan.entities[1]!,
          connectorBindings: [binding('red', 'input', 'output')],
        },
      ],
    };
    const execution = elaborateDirectPlan(outputPlan, context);
    const first = execution.createTestSession();
    const firstById = execution.entityObject(first, execution.entity(2).id);
    const firstByOrdinal = execution.entityObject(first, 2);
    expect(firstById).toBe(firstByOrdinal);
    expect(firstById).toMatchObject({
      kind: 'test-object',
      adapterId: 'entity-physical-v3',
      instanceId: 'ordinal-2',
      connectors: ['shared'],
    });

    const mock = first.mock(firstById, 'shared').output([[signal('virtual', 'signal-A'), 7]]);
    first.tick();
    expect(first.read(execution.network('input')).get(signal('virtual', 'signal-A'))).toBe(7);

    const second = execution.createTestSession();
    const secondObject = execution.entityObject(second, 2);
    expect(secondObject).not.toBe(firstById);
    const foreign = elaborateDirectPlan(outputPlan, context).createTestSession();
    expect(() => execution.entityObject(foreign, 2)).toThrow(
      'TestSession created by this execution',
    );
    expect(() => second.readValue(execution.network('input'))).not.toThrow();
    second.tick();
    expect(() => second.read(execution.network('input'))).toThrow(/Unknown/);
    expect(() => first.mock(firstById, 'shared')).not.toThrow();
    mock.clear();
    expect(() =>
      execution.entityObject(second, 'entity:missing' as EntityPlanRecord['id']),
    ).toThrow('Unknown physical Entity');
  });

  test('preserves generic bridge semantics for inputs, outputs, providers, traces, and feedback', () => {
    const { plan, context } = fixture();
    const inputExecution = elaborateDirectPlan(
      {
        ...plan,
        producers: [],
        entities: [
          {
            ...entity(shared, 2),
            connectorBindings: [binding('red', 'input'), binding('green', 'green')],
          },
        ],
      },
      context,
    );
    const inputSession = inputExecution.createTestSession();
    const inputObject = inputExecution.entityObject(inputSession, 2);
    inputSession
      .drive(inputExecution.network('input'), [[signal('virtual', 'signal-A'), 2]])
      .drive(inputExecution.network('green'), [[signal('virtual', 'signal-A'), 3]])
      .trace(inputSession.objectInput(inputObject, 'shared'))
      .tick();
    const aggregated = inputSession.readObjectInput(inputObject, 'shared');
    expect(aggregated.kind).toBe('known');
    if (aggregated.kind === 'known')
      expect(aggregated.bus.get(signal('virtual', 'signal-A'))).toBe(5);
    expect(inputSession.traces.toJSON().targets).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'object-input', connector: 'shared' }),
      ]),
    );

    const outputExecution = elaborateDirectPlan(
      {
        ...plan,
        producers: [],
        entities: [
          {
            ...entity(shared, 2),
            connectorBindings: [
              binding('red', 'input', 'output'),
              binding('green', 'green', 'output'),
            ],
          },
        ],
      },
      context,
    );
    const outputSession = outputExecution.createTestSession();
    const outputObject = outputExecution.entityObject(outputSession, 2);
    outputSession.mock(outputObject, 'shared').output([[signal('virtual', 'signal-A'), 4]]);
    outputSession.trace(outputSession.objectOutput(outputObject, 'shared')).tick();
    expect(
      outputSession.read(outputExecution.network('input')).get(signal('virtual', 'signal-A')),
    ).toBe(4);
    expect(
      outputSession.read(outputExecution.network('green')).get(signal('virtual', 'signal-A')),
    ).toBe(4);
    expect(outputSession.traces.toJSON().targets).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'object-output', connector: 'shared' }),
      ]),
    );

    const strictExecution = elaborateDirectPlan(
      {
        ...plan,
        producers: [],
        entities: [
          { ...entity(shared, 2), connectorBindings: [binding('red', 'input', 'output')] },
        ],
      },
      context,
    );
    const strictSession = strictExecution.createTestSession();
    const strictObject = strictExecution.entityObject(strictSession, 2);
    strictSession.tick();
    expect(strictSession.readValue(strictExecution.network('input')).kind).toBe('unknown');
    const mock = strictSession
      .mock(strictObject, 'shared')
      .output([[signal('virtual', 'signal-A'), 8]]);
    strictSession.tick();
    expect(
      strictSession.read(strictExecution.network('input')).get(signal('virtual', 'signal-A')),
    ).toBe(8);
    mock.clear();
    strictSession.tick();
    expect(strictSession.readValue(strictExecution.network('input')).kind).toBe('unknown');

    const feedbackContext = contextFor([zero, shared, feedbackProfile]);
    const feedbackPlan: DirectElaborationPlan = {
      ...plan,
      context: entityReplayContextRef(feedbackContext),
      networks: [{ name: 'loop', fixedColor: 'red', generation: 0, source, instancePath: [] }],
      producers: [],
      entities: [
        {
          ...entity(feedbackProfile, 1),
          connectorBindings: [
            profileBinding(feedbackProfile, 'feedback', 'feedback-input-red', 'loop', 'input'),
            profileBinding(feedbackProfile, 'feedback', 'feedback-output-red', 'loop', 'output'),
          ],
        },
      ],
    };
    const feedbackExecution = elaborateDirectPlan(feedbackPlan, feedbackContext);
    const feedbackSession = feedbackExecution.createTestSession();
    const feedbackObject = feedbackExecution.entityObject(feedbackSession, 1);
    const seenInputs: string[] = [];
    const seenValues: (number | undefined)[] = [];
    const model = feedbackSession.model(
      feedbackObject,
      {
        initialState: 0,
        step: ({ state, input }) => {
          seenInputs.push(input.kind);
          seenValues.push(
            input.kind === 'known' ? input.bus.get(signal('virtual', 'signal-A')) : undefined,
          );
          return { state: state + 1, output: [[signal('virtual', 'signal-A'), state + 1]] };
        },
      },
      'feedback',
    );
    feedbackSession.tick();
    feedbackSession.tick();
    expect(seenInputs).toEqual(['known', 'known']);
    expect(seenValues).toEqual([0, 1]);
    expect(model.state).toBe(2);
    expect(
      feedbackSession.read(feedbackExecution.network('loop')).get(signal('virtual', 'signal-A')),
    ).toBe(2);
    const feedbackInput = feedbackSession.readObjectInput(feedbackObject, 'feedback');
    expect(feedbackInput.kind).toBe('known');
  });

  test('does not synthesize output defaults for input-only or zero-port Entities', () => {
    const { plan, context } = fixture();
    const execution = elaborateDirectPlan(
      {
        ...plan,
        producers: [],
        entities: [
          { ...entity(shared, 2), connectorBindings: [binding('red', 'input')] },
          entity(zero, 3),
        ],
      },
      context,
    );
    const session = execution.createTestSession();
    expect(() => session.objectOutput(execution.entityObject(session, 2), 'shared')).toThrow(
      'has no output Networks',
    );
    expect(execution.entityObject(session, 3).connectors).toEqual([]);
  });

  test('exposes scoped Entity debug entries without changing Producer queries', () => {
    const { plan, context } = fixture();
    const nested = {
      ...entity(zero, 3),
      provenance: {
        ...entity(zero, 3).provenance,
        instancePath: ['DUT nested'],
      },
    };
    const execution = elaborateDirectPlan({ ...plan, entities: [entity(), nested] }, context);
    const root = execution.debug.root;
    expect(root.entities).toHaveLength(1);
    expect(root.entity(1)).toMatchObject({
      kind: 'entity',
      entityId: execution.entity(1).id,
      ordinal: 1,
      globalOrdinal: 1,
      record: execution.entity(1),
    });
    expect(Object.isFrozen(root.entity(1))).toBe(true);
    const child = root.child('DUT nested');
    expect(child.entities).toHaveLength(1);
    expect(child.entity(execution.entity(3).id).globalOrdinal).toBe(3);
    expect(child.entityByGlobalOrdinal(3).entityId).toBe(execution.entity(3).id);
    const document = createDebugDocument(execution.debug, execution.circuit.graph);
    expect(document.version).toBe(2);
    if (document.version !== 2) throw new Error('expected Entity-aware debug document');
    expect(document.scopes[0]?.entities[0]).toMatchObject({
      entityId: execution.entity(1).id,
      record: execution.entity(1),
    });
    expect(JSON.parse(JSON.stringify(document))).toEqual(document);
    const zeroExecution = elaborateDirectPlan({ ...plan, entities: [] }, context);
    const zeroEntityDocument = createDebugDocument(
      zeroExecution.debug,
      zeroExecution.circuit.graph,
    );
    expect(zeroEntityDocument.version).toBe(1);
    if (zeroEntityDocument.version !== 1) throw new Error('expected producer-only debug document');
    expect(zeroEntityDocument.scopes.every((scope) => !('entities' in scope))).toBe(true);
    expect(root.combinators()).toHaveLength(1);
    expect(() => root.entity(2)).toThrowError(expect.objectContaining({ code: 'DBG1001' }));
  });

  test('replays captured Entity debug values without transporting runtime handles', () => {
    const { plan, context } = fixture();
    const captured = {
      ...plan,
      debugInstances: [
        {
          name: 'dut',
          path: [],
          source,
          value: {
            kind: 'object' as const,
            entries: [
              {
                key: 'direct',
                value: { kind: 'entity' as const, entityId: plan.entities[1]!.id },
              },
              {
                key: 'aliases',
                value: {
                  kind: 'array' as const,
                  values: [
                    { kind: 'entity' as const, entityId: plan.entities[1]!.id },
                    { kind: 'entity' as const, entityId: plan.entities[1]!.id },
                  ],
                },
              },
            ],
          },
        },
      ],
    };
    const execution = elaborateDirectPlan(captured, context);
    const value = execution.instance('dut').value as {
      readonly direct: { readonly kind: 'entity'; readonly entityId: EntityPlanRecord['id'] };
      readonly aliases: readonly {
        readonly kind: 'entity';
        readonly entityId: EntityPlanRecord['id'];
      }[];
    };
    expect(value.direct).toBe(execution.debug.root.entity(2));
    expect(value.aliases[0]).toBe(value.aliases[1]);
    expect(value.aliases[0]).toBe(value.direct);
    expect(structuredClone(value.direct)).not.toHaveProperty('handle');

    const orphan = {
      ...captured,
      debugInstances: [
        {
          ...captured.debugInstances[0]!,
          value: { kind: 'entity' as const, entityId: 'entity:orphan' as EntityPlanRecord['id'] },
        },
      ],
    };
    const allocate = vi.spyOn(DslRuntime.prototype, 'network');
    try {
      const result = tryElaborateDirectPlan(orphan, context);
      expect(result.execution).toBeUndefined();
      expect(result.diagnostics[0]).toMatchObject({
        code: 'RT3003',
        message: expect.stringContaining('orphan'),
        span: source,
      });
      expect(allocate).not.toHaveBeenCalled();
    } finally {
      allocate.mockRestore();
    }
    const malformed = {
      ...captured,
      debugInstances: [
        {
          ...captured.debugInstances[0]!,
          value: { kind: 'entity' as const },
        },
      ],
    };
    expect(tryElaborateDirectPlan(malformed, context).diagnostics[0]).toMatchObject({
      code: 'RT3000',
      message: expect.stringContaining('$.debugInstances[0].value.entityId'),
      span: source,
    });
    let deepValue: unknown = {
      kind: 'entity',
      entityId: plan.entities[1]!.id,
    };
    for (let index = 0; index < 130; index += 1) {
      deepValue = { kind: 'array', values: [deepValue] };
    }
    const tooDeep = {
      ...captured,
      debugInstances: [{ ...captured.debugInstances[0]!, value: deepValue }],
    };
    expect(tryElaborateDirectPlan(tooDeep, context).diagnostics[0]).toMatchObject({
      code: 'RT3000',
      message: expect.stringContaining('$.debugInstances[0].value'),
      span: source,
    });
    expect(
      tryElaborateDirectPlan(captured as unknown as Parameters<typeof tryElaborateDirectPlan>[0])
        .diagnostics[0]?.code,
    ).toBe('RT1001');
  });

  test('resolves transfer declarations and public aliases to the survivor', () => {
    const { plan, context } = fixture();
    const transferred = {
      ...plan,
      networks: [
        ...plan.networks,
        { name: 'survivor', fixedColor: 'red' as const, generation: 0, source, instancePath: [] },
      ],
      networkTransfers: [
        { source: 'input', destination: 'survivor', provenance: source, instancePath: [] },
      ],
      networkAliases: [
        { name: 'alias', network: 'survivor', moved: false, source, instancePath: [] },
      ],
    };
    const execution = elaborateDirectPlan(transferred, context);
    expect(execution.circuit.graph.networks).toHaveLength(2);
    expect(
      execution.entity(2).connectorBindings.find((b) => b.endpoint.color === 'red')!.network,
    ).toBe(execution.network('alias').id);
    expect(execution.network('alias')).toBe(execution.network('survivor'));
    expect(
      execution.circuit.graph.networks.find((n) => n.id === execution.network('survivor').id)?.name,
    ).toBe('survivor');
    expect(generateBlueprintJson(execution.circuit.ir).blueprint.wires).toEqual([
      [1, 1, 3, 1],
      [1, 2, 3, 2],
    ]);
  });

  test('rejects invalid replay before runtime Network allocation', () => {
    const { plan, context } = fixture();
    const allocate = vi.spyOn(DslRuntime.prototype, 'network');
    try {
      const result = tryElaborateDirectPlan(
        { ...plan, context: { ...plan.context, evidenceIdentity: 'forged' } },
        context,
      );
      expect(result.execution).toBeUndefined();
      expect(result.diagnostics[0]?.code).toBe('RT3001');
      expect(allocate).not.toHaveBeenCalled();
    } finally {
      allocate.mockRestore();
    }
  });

  test('rejects non-synthetic typed configuration before runtime Network allocation', () => {
    const providerProfile = {
      ...structuredClone(shared),
      synthetic: false,
    };
    const providerContext = createTrustedEntityReplayContext({
      source: 'provider',
      database: providerProfile.ref.database,
      profiles: [providerProfile],
      evidenceIdentity: 'provider-evidence-v1',
      policyIdentity: 'provider-policy-v1',
    });
    const { plan } = fixture();
    const configured = {
      ...plan,
      context: entityReplayContextRef(providerContext),
      entities: [
        {
          ...plan.entities[1]!,
          profile: providerProfile.ref,
          configuration: {
            mode: 'typed' as const,
            rule: 'shared-circuit-condition' as EntityBehaviorKey,
            lanes: ['shared-red' as EntityLaneKey],
            condition: {
              kind: 'compare-signal-constant' as const,
              signal: { type: 'virtual' as const, name: 'signal-A' },
              comparator: '>' as const,
              constant: 1,
            },
          },
        },
      ],
    };
    const allocate = vi.spyOn(DslRuntime.prototype, 'network');
    try {
      const result = tryElaborateDirectPlan(configured, providerContext);
      expect(result.execution).toBeUndefined();
      expect(result.diagnostics[0]).toMatchObject({
        code: 'RT3003',
        message: expect.stringContaining('verified positive evidence'),
      });
      expect(allocate).not.toHaveBeenCalled();
    } finally {
      allocate.mockRestore();
    }
  });

  test('rejects missing trusted native endpoints with source provenance', () => {
    const { plan } = fixture();
    const profile = {
      ...shared,
      connectors: shared.connectors.map((c) => ({
        ...c,
        lanes: c.lanes.map(({ nativeEndpoint: _native, ...lane }) => lane),
      })),
    };
    const context = contextFor([zero, profile]);
    const result = tryElaborateDirectPlan(
      { ...plan, context: entityReplayContextRef(context) },
      context,
    );
    expect(result.diagnostics[0]).toMatchObject({
      code: 'RT3010',
      span: source,
      message: expect.stringContaining('native endpoint'),
    });
  });

  test('preflights every deterministic Entity failure before Network allocation', () => {
    const expectPreflightFailure = (
      plan: unknown,
      context: ReturnType<typeof contextFor>,
      code: string,
    ) => {
      const allocate = vi.spyOn(DslRuntime.prototype, 'network');
      try {
        const result = tryElaborateDirectPlan(plan, context);
        expect(result.execution).toBeUndefined();
        expect(result.diagnostics[0]?.code).toBe(code);
        expect(allocate).not.toHaveBeenCalled();
      } finally {
        allocate.mockRestore();
      }
    };

    const { plan } = fixture();
    const missingNative = {
      ...shared,
      connectors: shared.connectors.map((connector) => ({
        ...connector,
        lanes: connector.lanes.map(({ nativeEndpoint: _nativeEndpoint, ...lane }) => lane),
      })),
    };
    const missingNativeContext = contextFor([zero, missingNative]);
    expectPreflightFailure(
      { ...plan, context: entityReplayContextRef(missingNativeContext) },
      missingNativeContext,
      'RT3010',
    );

    const invalidPrototype = {
      ...zero,
      ref: { ...zero.ref, prototypeKey: 'item:invalid' },
    };
    const invalidPrototypeContext = contextFor([invalidPrototype]);
    expectPreflightFailure(
      {
        ...plan,
        context: entityReplayContextRef(invalidPrototypeContext),
        entities: [entity(invalidPrototype)],
      },
      invalidPrototypeContext,
      'RT3010',
    );

    const duplicateId = entity(zero, 2);
    expectPreflightFailure(
      { ...plan, entities: [entity(), { ...duplicateId, id: entity().id }] },
      contextFor(),
      'RT3003',
    );

    expectPreflightFailure(
      { ...plan, entities: [entity(), entity(shared, 1)] },
      contextFor(),
      'RT3003',
    );

    const profileMismatchContext = contextFor([zero]);
    expectPreflightFailure(
      {
        ...plan,
        context: entityReplayContextRef(profileMismatchContext),
        entities: [entity(shared)],
      },
      profileMismatchContext,
      'RT3002',
    );
  });

  test('requires explicit usable endpoints on a profile without a default projection', () => {
    const context = contextFor([ambiguous]);
    const lane = ambiguous.connectors[0]!.lanes[0]!;
    const record = {
      ...entity(ambiguous),
      connectorBindings: [
        {
          ...binding('red', 'input'),
          endpoint: { connector: ambiguous.connectors[0]!.key, lane: lane.key, color: lane.color },
        },
      ],
    };
    const plan = {
      ...fixture().plan,
      context: entityReplayContextRef(context),
      entities: [record],
    };
    expect(tryElaborateDirectPlan(plan, context).diagnostics[0]?.code).toBe('RT3010');
    expect(
      elaborateDirectPlan({ ...plan, entities: [entity(ambiguous)] }, context).circuit.ir.entities,
    ).toHaveLength(1);
  });

  test('emits raw configuration at preview instead of dropping it', () => {
    const { plan, context } = fixture();
    const configured = {
      ...plan,
      entities: [
        {
          ...entity(),
          configuration: {
            mode: 'raw' as const,
            payload: { recipe: 'iron-gear-wheel', control_behavior: { read_contents: true } },
          },
        },
      ],
    };
    const execution = elaborateDirectPlan(configured, context);
    expect(execution.entity(1).configuration).toEqual({
      mode: 'raw',
      payload: { recipe: 'iron-gear-wheel', control_behavior: { read_contents: true } },
    });
    expect(generateBlueprintJson(execution.circuit.ir).blueprint.entities[1]).toMatchObject({
      recipe: 'iron-gear-wheel',
      control_behavior: { read_contents: true },
      entity_number: 2,
      name: 'synthetic-zero-port',
      position: { x: 2.5, y: 0.5 },
      direction: 4,
    });
  });

  test('rejects the removed opaque typed configuration before preview', () => {
    const { plan, context } = fixture();
    const configured = {
      ...plan,
      entities: [
        {
          ...entity(),
          configuration: { mode: 'typed' as const, payload: { legacy: true } } as never,
        },
      ],
    };
    expect(() => elaborateDirectPlan(configured, context)).toThrowError(
      expect.objectContaining({ diagnostic: expect.objectContaining({ code: 'RT3003' }) }),
    );
  });

  test('lowers typed single-condition configuration into readable native blueprint JSON', () => {
    const { plan, context } = fixture();
    const configuration = {
      mode: 'typed' as const,
      rule: 'shared-circuit-condition' as EntityBehaviorKey,
      lanes: ['shared-red' as EntityLaneKey, 'shared-green' as EntityLaneKey],
      condition: {
        kind: 'compare-signal-constant' as const,
        signal: { type: 'item' as const, name: 'iron-plate' },
        comparator: '>=' as const,
        constant: -2,
      },
    } satisfies Extract<NonNullable<EntityPlanRecord['configuration']>, { mode: 'typed' }>;
    const configured = {
      ...plan,
      entities: [
        {
          ...plan.entities[1]!,
          configuration,
        },
      ],
    };
    const execution = elaborateDirectPlan(configured, context);
    configuration.lanes.reverse();
    configuration.condition.signal.name = 'signal-mutated-after-elaboration';

    const physical = execution.entity(2);
    const physicalConfiguration = physical.configuration;
    if (physicalConfiguration?.mode !== 'typed' || 'payload' in physicalConfiguration)
      throw new Error('expected resolved typed physical configuration');
    expect(physicalConfiguration).toMatchObject({
      mode: 'typed',
      rule: 'shared-circuit-condition',
      feature: 'read',
      nativeField: 'control_behavior.circuit_condition',
      connector: 'shared',
      lanes: ['shared-green', 'shared-red'],
      laneMask: { red: true, green: true },
      condition: {
        signal: { name: 'iron-plate' },
        comparator: '>=',
        constant: -2,
      },
    });
    expect(Object.isFrozen(physical.configuration)).toBe(true);
    expect(execution.circuit.ir.producers).toHaveLength(1);
    expect(execution.circuit.ir.networks).toHaveLength(2);
    expect(execution.circuit.ir.entities).toHaveLength(1);
    expect(execution.debug.root.entities).toHaveLength(1);
    expect(execution.debug.root.entity(1).record).toBe(physical);

    const session = execution.createTestSession();
    const objectById = execution.entityObject(session, physical.id);
    const objectByOrdinal = execution.entityObject(session, physical.ordinal);
    expect(objectById).toBe(objectByOrdinal);
    expect(objectById).toMatchObject({
      adapterId: 'entity-physical-v3',
      instanceId: 'ordinal-2',
      connectors: ['shared'],
    });

    const previewEntity = generateBlueprintJson(execution.circuit.ir).blueprint.entities[1]!;
    expect(previewEntity).toMatchObject({
      entity_number: 2,
      name: 'synthetic-shared-two-color',
      control_behavior: {
        circuit_condition: {
          first_signal: { name: 'iron-plate' },
          first_signal_networks: { red: true, green: true },
          comparator: '≥',
          constant: -2,
        },
      },
    });

    const unsupported = {
      ...physical,
      configuration: {
        ...physicalConfiguration,
        nativeField: 'control_behavior.unsupported' as never,
      },
    };
    expect(() =>
      generateBlueprintJson({ ...execution.circuit.ir, entities: [unsupported] }),
    ).toThrowError(expect.objectContaining({ code: 'BP1001', span: source }));

    const corruptions: readonly unknown[] = [
      {
        ...physicalConfiguration,
        condition: {
          ...physicalConfiguration.condition,
          signal: { type: 'virtual', name: 'signal-each' },
        },
      },
      {
        ...physicalConfiguration,
        condition: { ...physicalConfiguration.condition, constant: 1.5 },
      },
      {
        ...physicalConfiguration,
        condition: { ...physicalConfiguration.condition, constant: 2_147_483_648 },
      },
      { ...physicalConfiguration, laneMask: { red: 'yes', green: false } },
      { ...physicalConfiguration, futureField: true },
    ];
    for (const configurationCandidate of corruptions) {
      const corrupted = { ...physical, configuration: configurationCandidate as never };
      expect(() =>
        generateBlueprintJson({ ...execution.circuit.ir, entities: [corrupted] }),
      ).toThrowError(expect.objectContaining({ code: 'BP1001', span: source }));
    }
  });

  test('keeps producer-only graph, IR, and blueprint identical', () => {
    const { plan, context } = fixture();
    const previous = elaborateDirectPlan({ ...plan, entities: [] });
    const current = elaborateDirectPlan(canonicalDirectPlan({ ...plan, entities: [] }));
    expect(Object.hasOwn(current.circuit.graph, 'version')).toBe(false);
    expect(Object.hasOwn(current.circuit.ir, 'version')).toBe(false);
    expect(current.circuit.graph.entities).toEqual([]);
    expect(current.circuit.ir.entities).toEqual([]);
    expect(generateBlueprintJson(current.circuit.ir)).toEqual(
      generateBlueprintJson(previous.circuit.ir),
    );
  });

  test('retains the complete producer execution surface alongside Entity lookup', () => {
    const { plan, context } = fixture();
    const producer = plan.producers[0]!;
    const capabilityUses = [
      {
        network: 'input',
        capability: 'readonly' as const,
        parameter: 'input',
        fixedColor: 'red' as const,
        provenance: source,
        instancePath: [] as const,
      },
    ];
    const debugPlan = {
      ...plan,
      capabilityUses,
      producers: [{ ...producer, bindingName: 'constant', debugCaptureIds: ['constant-capture'] }],
      debugInstances: [
        {
          name: 'dut',
          path: [],
          source,
          value: { kind: 'producer' as const, captureId: 'constant-capture' },
        },
      ],
    };
    const execution = elaborateDirectPlan(debugPlan, context);

    expect(execution.capabilityUses).toEqual(capabilityUses);
    expect(execution.instances).toHaveLength(1);
    expect(execution.instance('dut')).toBe(execution.instance(1));
    expect(execution.instance('dut').value).toMatchObject({ kind: 'producer' });
    const structure = execution.structure();
    expect(structure.toHaveProducerCounts({ constant: 1 })).toBe(structure);
    expect(structure.toHaveProducer('constant', { producerKind: 'constant' })).toBe(structure);
    expect(structure.toHaveNetwork('input')).toBe(structure);
    const input = execution.network('input');
    expect(input.id).toBe(execution.circuit.graph.networks[0]?.id);
    const session = execution.createTestSession();
    session.drive(input, [[signal('virtual', 'signal-A'), 5]]).tick();
    expect(session.read(input).get(signal('virtual', 'signal-A'))).toBe(7);
    expect(execution.entity(1).prototypeName).toBe('synthetic-zero-port');
  });

  test('lowerer rejects unknown names, duplicate Entities, and foreign profile context', () => {
    const { plan, context } = fixture();
    expect(() => lowerEntityRecords([plan.entities[1]!], context, () => undefined)).toThrow(
      /Unknown Entity Network/,
    );
    expect(() => lowerEntityRecords([entity(), entity()], context, () => undefined)).toThrow(
      /Duplicate physical/,
    );
    expect(() =>
      lowerEntityRecords([entity(shared)], contextFor([zero]), () => undefined),
    ).toThrow();
    const badKey = { ...zero, ref: { ...zero.ref, prototypeKey: 'item:invalid' } };
    expect(() =>
      lowerEntityRecords([entity(badKey)], contextFor([badKey]), () => undefined),
    ).toThrow(/canonical entity/);
  });

  test('encodes native connector ordinal two as red 3 and green 4', () => {
    const profile = {
      ...shared,
      connectors: shared.connectors.map((c) => ({
        ...c,
        lanes: c.lanes.map((lane) => ({
          ...lane,
          nativeEndpoint: { ...lane.nativeEndpoint!, nativeConnector: 2 },
        })),
      })),
    };
    const context = contextFor([zero, profile]);
    const { plan } = fixture();
    const execution = elaborateDirectPlan(
      { ...plan, context: entityReplayContextRef(context) },
      context,
    );
    expect(generateBlueprintJson(execution.circuit.ir).blueprint.wires).toEqual([
      [1, 1, 3, 3],
      [1, 2, 3, 4],
    ]);
  });

  test('automatic placement skips occupied producer and explicit Entity positions', () => {
    const { plan, context } = fixture();
    const execution = elaborateDirectPlan(
      {
        ...plan,
        entities: [
          entity(),
          { ...entity(zero, 2), placement: { x: 2.5, y: 0.5 } },
          entity(zero, 3),
        ],
      },
      context,
    );
    const preview = generateBlueprintJson(execution.circuit.ir).blueprint;
    expect(preview.entities.map((e) => e.position)).toEqual([
      { x: 0.5, y: 0.5 },
      { x: 4.5, y: 0.5 },
      { x: 2.5, y: 0.5 },
      { x: 6.5, y: 0.5 },
    ]);
    expect(preview.entities.map((e) => e.entity_number)).toEqual([1, 2, 3, 4]);
  });

  test('detaches physical records and guards corrupt native metadata at preview', () => {
    const { plan, context } = fixture();
    const execution = elaborateDirectPlan(plan, context);
    expect(Object.isFrozen(plan.entities[0])).toBe(false);
    expect(execution.entity(1)).not.toBe(plan.entities[0]);
    const ir = execution.circuit.ir;
    const wired = execution.entity(2);
    for (const nativeConnector of [0, -1, 1.5, Number.MAX_SAFE_INTEGER]) {
      const corrupt = {
        ...wired,
        connectorBindings: wired.connectorBindings.map((b) => ({
          ...b,
          network: execution.network(b.endpoint.color === 'red' ? 'input' : 'green').id,
          nativeConnector,
        })),
      };
      expect(() => generateBlueprintJson({ ...ir, entities: [corrupt] })).toThrow(
        /connector ordinal/,
      );
    }
    expect(() => generateBlueprintJson({ ...ir, entities: [wired, wired] })).toThrow(
      /Duplicate physical/,
    );
  });
});

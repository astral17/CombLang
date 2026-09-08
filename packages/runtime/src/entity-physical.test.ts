import { describe, expect, test, vi } from 'vitest';
import { signal } from '@comblang/factorio';
import { sourceFileId, sourceSpan } from '@comblang/shared';
import {
  generateBlueprintJson,
  generateEntityBlueprintJson,
} from '@comblang/compiler/blueprint-json';
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
  DirectElaborationPlanV3,
  EntityPlanRecord,
  EntityProfile,
} from '@comblang/compiler/entity';
import {
  elaborateDirectPlan,
  elaborateEntityDirectPlan,
  tryElaborateEntityDirectPlan,
} from './direct-plan.js';
import { DslRuntime } from './elaboration.js';
import { lowerEntityRecords } from './entity-lowering.js';

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
function binding(color: 'red' | 'green', network: string) {
  return {
    endpoint: shared.connectors[0]!.lanes.find((lane) => lane.color === color)!.nativeEndpoint!
      .endpoint,
    network,
    generation: 0,
    direction: 'input' as const,
    provenance: { source, instancePath: [], operationOrdinal: color === 'red' ? 1 : 2 },
  };
}
function fixture() {
  const context = contextFor();
  const plan: DirectElaborationPlanV3 = {
    format: 'comblang-direct-plan',
    version: 3,
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
    const execution = elaborateEntityDirectPlan(plan, context);
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
    const preview = generateEntityBlueprintJson(ir).blueprint;
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
    const execution = elaborateEntityDirectPlan(transferred, context);
    expect(execution.circuit.graph.networks).toHaveLength(2);
    expect(
      execution.entity(2).connectorBindings.find((b) => b.endpoint.color === 'red')!.network,
    ).toBe(execution.network('alias').id);
    expect(execution.network('alias')).toBe(execution.network('survivor'));
    expect(
      execution.circuit.graph.networks.find((n) => n.id === execution.network('survivor').id)?.name,
    ).toBe('survivor');
    expect(generateEntityBlueprintJson(execution.circuit.ir).blueprint.wires).toEqual([
      [1, 1, 3, 1],
      [1, 2, 3, 2],
    ]);
  });

  test('rejects invalid replay before runtime Network allocation', () => {
    const { plan, context } = fixture();
    const allocate = vi.spyOn(DslRuntime.prototype, 'network');
    try {
      const result = tryElaborateEntityDirectPlan(
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
    const result = tryElaborateEntityDirectPlan(
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
        const result = tryElaborateEntityDirectPlan(plan, context);
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
    expect(tryElaborateEntityDirectPlan(plan, context).diagnostics[0]?.code).toBe('RT3010');
    expect(
      elaborateEntityDirectPlan({ ...plan, entities: [entity(ambiguous)] }, context).circuit.ir
        .entities,
    ).toHaveLength(1);
  });

  test.each(['raw', 'typed'] as const)(
    'rejects %s configuration at preview instead of dropping it',
    (mode) => {
      const { plan, context } = fixture();
      const configured = {
        ...plan,
        entities: [{ ...entity(), configuration: { mode, payload: {} } }],
      };
      const execution = elaborateEntityDirectPlan(configured, context);
      expect(execution.entity(1).configuration).toEqual({ mode, payload: {} });
      expect(() => generateEntityBlueprintJson(execution.circuit.ir)).toThrow(
        /configuration.*unsupported/,
      );
    },
  );

  test('keeps producer-only v2 graph, IR, and blueprint identical', () => {
    const { plan, context } = fixture();
    const v2 = {
      format: 'comblang-direct-plan' as const,
      version: 2 as const,
      networks: plan.networks.map(({ generation: _g, ...n }) => n),
      producers: plan.producers,
    };
    const previous = elaborateDirectPlan(v2);
    const current = elaborateEntityDirectPlan({ ...plan, entities: [] }, context);
    const { entities: _entities, context: _context, ...graph } = current.circuit.graph;
    const { entities: _irEntities, context: _irContext, ...ir } = current.circuit.ir;
    expect({ ...graph, version: 2 }).toEqual(previous.circuit.graph);
    expect({ ...ir, version: 2 }).toEqual(previous.circuit.ir);
    expect(generateEntityBlueprintJson(current.circuit.ir)).toEqual(
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
    const execution = elaborateEntityDirectPlan(debugPlan, context);

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
    const execution = elaborateEntityDirectPlan(
      { ...plan, context: entityReplayContextRef(context) },
      context,
    );
    expect(generateEntityBlueprintJson(execution.circuit.ir).blueprint.wires).toEqual([
      [1, 1, 3, 3],
      [1, 2, 3, 4],
    ]);
  });

  test('automatic placement skips occupied producer and explicit Entity positions', () => {
    const { plan, context } = fixture();
    const execution = elaborateEntityDirectPlan(
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
    const preview = generateEntityBlueprintJson(execution.circuit.ir).blueprint;
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
    const execution = elaborateEntityDirectPlan(plan, context);
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
      expect(() => generateEntityBlueprintJson({ ...ir, entities: [corrupt] })).toThrow(
        /connector ordinal/,
      );
    }
    expect(() => generateEntityBlueprintJson({ ...ir, entities: [wired, wired] })).toThrow(
      /Duplicate physical/,
    );
  });
});

import { describe, expect, test } from 'vitest';
import { signal } from '@comblang/factorio';
import { sourceFileId, sourceSpan } from '@comblang/shared';
import { generateEntityComputationBlueprintJson } from '@comblang/compiler/blueprint-json';
import type { EntityProfile } from '@comblang/compiler/entity';
import {
  createTrustedEntityReplayContext,
  entityReplayContextRef,
} from '@comblang/compiler/entity-replay-context';
import {
  syntheticSharedTwoColorEntityProfile,
  syntheticZeroPortEntityProfile,
} from '@comblang/compiler/entity-fixtures';
import { elaborateEntityV4DirectPlan, tryElaborateEntityV4DirectPlan } from './entity-v4.js';
import { validateEntityV4DirectPlan } from './entity-v4-validation.js';
import { hydrateResolvedEntityV4Circuit } from './resolved-entity-v4.js';
import { RuntimeDiagnosticError } from './elaboration.js';

const source = sourceSpan(sourceFileId('entity-v4-execution.ts'), 0, 1);

function fixture() {
  const profile: EntityProfile = {
    ...structuredClone(syntheticZeroPortEntityProfile),
    ref: {
      ...syntheticZeroPortEntityProfile.ref,
      prototypeKey: 'entity:fixture-constant',
      profileId: 'profile:fixture-constant-v1' as EntityProfile['ref']['profileId'],
    },
    prototypeType: 'constant-combinator',
  };
  const context = createTrustedEntityReplayContext({
    database: profile.ref.database,
    source: 'synthetic',
    evidenceIdentity: 'v4-execution-evidence',
    policyIdentity: 'v4-execution-policy',
    profiles: [profile, syntheticSharedTwoColorEntityProfile],
  });
  const plan = {
    format: 'comblang-direct-plan' as const,
    version: 4 as const,
    context: entityReplayContextRef(context),
    networks: [
      { name: 'out', fixedColor: 'red' as const, generation: 0, source, instancePath: [] },
    ],
    producers: [
      {
        kind: 'constant' as const,
        entityId: 'entity:1',
        outputs: [{ signal: signal('virtual', 'signal-A'), value: 7 }],
        destinations: [{ network: 'out', source, instancePath: ['Constant'] }],
        source,
        instancePath: ['Constant'],
      },
    ],
    entities: [
      {
        id: 'entity:1',
        profile: profile.ref,
        configuration: {
          mode: 'constant' as const,
          value: {
            isOn: true,
            sections: [
              {
                active: true,
                multiplier: 1,
                filters: [{ signal: signal('virtual', 'signal-A'), value: 7 }],
              },
            ],
          },
        },
        connectorBindings: [],
        placement: { x: 10, y: 20 },
        provenance: { source, instancePath: ['Entity:1'], expansionStack: [], creationRevision: 1 },
        ordinal: 1,
      },
    ],
  };
  return { context, plan };
}

describe('Entity v4 computation execution', () => {
  test('projects topology once and restores one linked Entity view', () => {
    const { context, plan } = fixture();
    const result = tryElaborateEntityV4DirectPlan(plan, context);

    expect(result.diagnostics).toEqual([]);
    expect(result.execution?.circuit.graph.version).toBe(4);
    expect(result.execution?.circuit.ir.version).toBe(4);
    expect(result.execution?.circuit.ir.producers).toHaveLength(1);
    expect(result.execution?.circuit.ir.entities).toHaveLength(1);
    expect(result.execution?.circuit.ir.producers[0]).toMatchObject({ entityId: 'entity:1' });
    expect(result.execution?.entity('entity:1' as never)).toMatchObject({
      id: 'entity:1',
      prototypeName: 'fixture-constant',
      placement: { x: 10, y: 20 },
      configuration: { mode: 'constant' },
    });
  });

  test('exports one native Constant object for the linked Entity', () => {
    const { context, plan } = fixture();
    const result = tryElaborateEntityV4DirectPlan(plan, context);
    const blueprint = generateEntityComputationBlueprintJson(result.execution!.circuit.ir);
    expect(blueprint.blueprint.entities).toHaveLength(1);
    expect(blueprint.blueprint.entities[0]).toMatchObject({
      entity_number: 1,
      name: 'fixture-constant',
      position: { x: 10, y: 20 },
      control_behavior: {
        is_on: true,
        sections: {
          sections: [{ filters: [{ name: 'signal-A', type: 'virtual', count: 7 }] }],
        },
      },
    });
  });

  test('preserves unlinked producers, structural Entities, aliases, and Entity placement', () => {
    const { context, plan } = fixture();
    const mixed = {
      ...structuredClone(plan),
      networkAliases: [{ name: 'alias', network: 'out', moved: false, source, instancePath: [] }],
      producers: [
        ...structuredClone(plan.producers),
        {
          kind: 'constant',
          outputs: [{ signal: signal('virtual', 'signal-B'), value: 2 }],
          destinations: [{ network: 'out', source, instancePath: ['Unlinked'] }],
          source,
          instancePath: ['Unlinked'],
        },
      ],
      entities: [
        ...structuredClone(plan.entities),
        {
          id: 'entity:2',
          profile: plan.entities[0]!.profile,
          connectorBindings: [],
          placement: { x: 30, y: 40 },
          provenance: {
            source,
            instancePath: ['Entity:2'],
            expansionStack: [],
            creationRevision: 1,
          },
          ordinal: 2,
        },
      ],
    };
    const result = tryElaborateEntityV4DirectPlan(mixed, context);
    expect(result.diagnostics).toEqual([]);
    const blueprint = generateEntityComputationBlueprintJson(result.execution!.circuit.ir);
    expect(blueprint.blueprint.entities).toHaveLength(3);
    expect(
      blueprint.blueprint.entities.filter((entity) => entity.entity_number === 1),
    ).toHaveLength(1);
    expect(blueprint.blueprint.entities.find((entity) => entity.entity_number === 1)).toMatchObject(
      {
        name: 'fixture-constant',
        position: { x: 10, y: 20 },
      },
    );
    expect(result.execution!.network('alias')).toBe(result.execution!.network('out'));
  });

  test('preserves raw, resolved typed, and opaque v3 configurations around a linked Constant', () => {
    const { context, plan } = fixture();
    const mixed = structuredClone(plan) as unknown as {
      entities: Array<Record<string, unknown>>;
      [key: string]: unknown;
    };
    mixed.entities.push(
      {
        id: 'entity:raw',
        profile: syntheticSharedTwoColorEntityProfile.ref,
        configuration: { mode: 'raw', payload: { player_description: 'survives' } },
        connectorBindings: [],
        placement: { x: 30, y: 40 },
        provenance: {
          source,
          instancePath: ['Entity:raw'],
          expansionStack: [],
          creationRevision: 2,
        },
        ordinal: 2,
      },
      {
        id: 'entity:typed',
        profile: syntheticSharedTwoColorEntityProfile.ref,
        configuration: {
          mode: 'typed',
          rule: 'shared-circuit-condition',
          lanes: ['shared-red'],
          condition: {
            kind: 'compare-signal-constant',
            signal: { type: 'virtual', name: 'signal-B' },
            comparator: '>=',
            constant: 2,
          },
        },
        connectorBindings: [],
        placement: { x: 50, y: 60 },
        provenance: {
          source,
          instancePath: ['Entity:typed'],
          expansionStack: [],
          creationRevision: 3,
        },
        ordinal: 3,
      },
      {
        id: 'entity:opaque',
        profile: syntheticSharedTwoColorEntityProfile.ref,
        configuration: { mode: 'typed', payload: { legacy: true } },
        connectorBindings: [],
        placement: { x: 70, y: 80 },
        provenance: {
          source,
          instancePath: ['Entity:opaque'],
          expansionStack: [],
          creationRevision: 4,
        },
        ordinal: 4,
      },
    );
    const before = structuredClone(mixed);
    const inputRawPayload = (
      mixed.entities[1]!.configuration as { readonly payload: { player_description: string } }
    ).payload;

    const validation = validateEntityV4DirectPlan(mixed, context);
    const result = tryElaborateEntityV4DirectPlan(mixed, context);
    expect(validation.diagnostics).toEqual([]);
    expect(result.diagnostics).toEqual([]);
    expect(mixed).toEqual(before);
    expect(Object.isFrozen(inputRawPayload)).toBe(false);
    inputRawPayload.player_description = 'caller-owned';

    const execution = result.execution!;
    expect(execution.entity('entity:raw' as never).configuration).toEqual({
      mode: 'raw',
      payload: { player_description: 'survives' },
    });
    expect(execution.entity('entity:typed' as never).configuration).toMatchObject({
      mode: 'typed',
      feature: 'read',
      nativeField: 'control_behavior.circuit_condition',
    });
    expect(execution.entity('entity:opaque' as never).configuration).toEqual({
      mode: 'typed',
      payload: { legacy: true },
    });
    expect(result.resolvedCircuit?.ir.entities.map((entity) => entity.configuration)).toMatchObject(
      [
        { mode: 'constant' },
        { mode: 'raw', payload: { player_description: 'survives' } },
        { mode: 'typed', feature: 'read' },
        { mode: 'typed', payload: { legacy: true } },
      ],
    );
    expect(Object.isFrozen(validation.value?.plan.entities[1]?.configuration)).toBe(true);
    expect(Object.isFrozen(execution.circuit.ir.entities[1]?.configuration)).toBe(true);
    expect(
      hydrateResolvedEntityV4Circuit(result.resolvedCircuit).ir.entities[2]?.configuration,
    ).toMatchObject({
      mode: 'typed',
      feature: 'read',
    });

    expect(() => generateEntityComputationBlueprintJson(execution.circuit.ir)).toThrow(
      'Raw/typed Entity configuration preview lowering is unsupported.',
    );
    const blueprintPlan = { ...before, entities: before.entities.slice(0, 3) };
    const blueprintResult = tryElaborateEntityV4DirectPlan(blueprintPlan, context);
    const blueprint = generateEntityComputationBlueprintJson(blueprintResult.execution!.circuit.ir);
    expect(blueprint.blueprint.entities).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ player_description: 'survives' }),
        expect.objectContaining({ control_behavior: expect.any(Object) }),
      ]),
    );
  });

  test('throws the first structured v4 diagnostic with its source span', () => {
    const { context, plan } = fixture();
    const invalid = {
      ...plan,
      producers: [
        {
          ...plan.producers[0],
          outputs: [{ signal: signal('virtual', 'signal-B'), value: 1 }],
        },
      ],
    };
    try {
      elaborateEntityV4DirectPlan(invalid, context);
      expect.fail('expected v4 elaboration to fail');
    } catch (error) {
      expect(error).toBeInstanceOf(RuntimeDiagnosticError);
      expect((error as RuntimeDiagnosticError).diagnostic).toMatchObject({
        code: 'RT4003',
        span: source,
      });
    }
  });
});

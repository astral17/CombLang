import { describe, expect, test } from 'vitest';

import {
  createTrustedEntityReplayContext,
  syntheticZeroPortEntityProfile,
} from '@comblang/compiler';
import type {
  EntityPhysicalConfiguration,
  EntityPhysicalRecord,
  EntityId,
  EntityProfile,
} from '@comblang/compiler/entity';
import type {
  CircuitProducerNode,
  ConstantProducerConfig,
  DeciderProducerConfig,
  NativeCircuitIr,
} from '@comblang/compiler/ir';
import type { EntityPrototype } from '@comblang/prototypes';
import {
  canonicalizeConstantConfiguration,
  constantConfigurationLimits,
  Signal,
} from '@comblang/factorio';
import type { NetworkId, ProducerId, SourceFileId } from '@comblang/shared';

import { BlueprintParameterError } from '../../compiler/src/blueprint-parameters.js';
import { lowerNativeBlueprintConfig } from '../../compiler/src/blueprint-native-config.js';
import {
  collectOccupiedAutomaticNumberValues,
  selectAutomaticNumberDefaults,
} from './source-automatic-number-defaults.js';
import { compileSourceProgram, listSourceCompilationParameters } from './source-compilation.js';
import type { EntityPrototypeResolver } from './entity-registry.js';

const network = 'network:auto-number-test' as NetworkId;
const provenance = { instancePath: [], expansionStack: [] } as const;
const source = { fileId: 'automatic-number-test.ts' as SourceFileId, start: 2, end: 18 };
const A = Signal('virtual', 'signal-A');
const B = Signal('item', 'iron-plate', 'normal');

function producerProvenance(start: number) {
  return { ...provenance, source: { ...source, start, end: start + 4 } };
}

function arithmetic(id: string, left: number, right: number): CircuitProducerNode {
  return {
    id: id as ProducerId,
    kind: 'arithmetic',
    config: {
      left: { kind: 'constant', value: left },
      operation: 'add',
      right: { kind: 'constant', value: right },
      output: { kind: 'signal', signal: A },
    },
    destinations: [],
    provenance: producerProvenance(10),
  };
}

function constant(id: string, config: ConstantProducerConfig): CircuitProducerNode {
  return {
    id: id as ProducerId,
    kind: 'constant',
    config,
    destinations: [],
    provenance: producerProvenance(20),
  };
}

function decider(id: string, config: DeciderProducerConfig): CircuitProducerNode {
  return {
    id: id as ProducerId,
    kind: 'decider',
    config,
    destinations: [],
    provenance: producerProvenance(30),
  };
}

function circuit(
  producers: readonly CircuitProducerNode[],
  entities: readonly EntityPhysicalRecord[] = [],
): NativeCircuitIr {
  return {
    format: 'comblang-ncir',
    networks: [{ id: network, color: 'red', provenance }],
    producers,
    entities,
  };
}

function physicalEntity(
  id: string,
  configuration: EntityPhysicalConfiguration | undefined,
  overrides: Record<string, unknown> = {},
): EntityPhysicalRecord {
  return {
    id: id as EntityId,
    ordinal: 1,
    prototypeName: 'constant-combinator',
    profile: {
      prototypeKey: 'entity:constant-combinator',
      database: { schemaVersion: 1, identity: 'test' },
      profileId: 'profile:auto-number-test',
    },
    provenance: producerProvenance(40),
    placement: { x: 1.5, y: -2.5, direction: 4 },
    connectorBindings: [],
    ...(configuration === undefined ? {} : { configuration }),
    ...overrides,
  } as unknown as EntityPhysicalRecord;
}

function expectCoverageFailure(ir: NativeCircuitIr, path: string) {
  let error: unknown;
  try {
    collectOccupiedAutomaticNumberValues(ir);
  } catch (caught) {
    error = caught;
  }
  expect(error).toBeInstanceOf(BlueprintParameterError);
  expect(error).toMatchObject({
    code: 'CP1002',
    path,
    span: expect.objectContaining({ fileId: source.fileId }),
  });
}

describe('automatic numeric default allocator', () => {
  test('chooses positive values in ascending order before the negative fallback', () => {
    expect(selectAutomaticNumberDefaults([], 5)).toEqual([1, 2, 3, 4, 5]);
    expect(selectAutomaticNumberDefaults([1, 3, 2, -1, -3], 5)).toEqual([4, 5, 6, 7, 8]);
    expect(selectAutomaticNumberDefaults([1, 2, 3, 4, 5, 6], 3)).toEqual([7, 8, 9]);
  });

  test('skips reserved gaps and normalizes zero without mutating reservations', () => {
    const reserved = Object.freeze([0, -0, 1, 3, -1, -3, 2_147_483_647, -2_147_483_648]);
    const snapshot = [...reserved];
    expect(selectAutomaticNumberDefaults(reserved, 5)).toEqual([2, 4, 5, 6, 7]);
    expect(reserved).toEqual(snapshot);
    expect(Object.isFrozen(selectAutomaticNumberDefaults(reserved, 2))).toBe(true);
  });

  test('is independent of duplicate and input ordering and of earlier calls', () => {
    const first = selectAutomaticNumberDefaults([9, 1, 4, 4, 7], 6);
    expect(selectAutomaticNumberDefaults([7, 4, 1, 9, 7], 6)).toEqual(first);
    expect(selectAutomaticNumberDefaults([], 1)).toEqual([1]);
    expect(selectAutomaticNumberDefaults([9, 1, 4, 4, 7], 6)).toEqual(first);
  });

  test('validates requests and reservations before handling a zero request', () => {
    expect(selectAutomaticNumberDefaults([], 0)).toEqual([]);
    expect(Object.isFrozen(selectAutomaticNumberDefaults([], 0))).toBe(true);
    for (const count of [
      -1,
      0.5,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.MAX_SAFE_INTEGER + 1,
    ]) {
      expect(() => selectAutomaticNumberDefaults([], count)).toThrow(RangeError);
    }
    expect(() => selectAutomaticNumberDefaults([Number.NaN], 0)).toThrow(TypeError);
    expect(() => selectAutomaticNumberDefaults([2_147_483_648], 0)).toThrow(RangeError);
    expect(() =>
      selectAutomaticNumberDefaults([], constantConfigurationLimits.maxNodes + 1),
    ).toThrow(/output budget/i);
  });

  test('rejects exhausted output budgets atomically and remains usable afterward', () => {
    expect(() =>
      selectAutomaticNumberDefaults([], constantConfigurationLimits.maxNodes + 1),
    ).toThrow(RangeError);
    expect(selectAutomaticNumberDefaults([1], 2)).toEqual([2, 3]);
  });
});

describe('typed numeric configuration occupancy census', () => {
  test('enumerates only supported numeric roles in producer and config order', () => {
    const exactConfiguration = canonicalizeConstantConfiguration({
      isOn: false,
      sections: [
        {
          active: false,
          group: 'backup',
          multiplier: -0,
          filters: [{ signal: A, value: 14 }],
        },
        {
          active: false,
          multiplier: 2.5,
          filters: [{ signal: B, value: 15 }],
        },
        {
          active: true,
          multiplier: -2_147_483_648,
          filters: [{ signal: A, value: 16 }],
        },
        {
          active: true,
          multiplier: 2_147_483_648,
          filters: [{ signal: B, value: 17 }],
        },
      ],
    });
    const tree: DeciderProducerConfig['condition'] = {
      kind: 'or',
      conditions: [
        {
          kind: 'compare',
          left: { kind: 'signal', signal: A, refKind: 'single', network },
          comparator: '>',
          right: { kind: 'constant', value: 18 },
        },
        {
          kind: 'and',
          conditions: [
            {
              kind: 'compare',
              left: { kind: 'wildcard', value: 'each', refKind: 'single', network },
              comparator: '<=',
              right: { kind: 'constant', value: 19 },
            },
          ],
        },
      ],
    };
    const ir = circuit([
      arithmetic('producer:arithmetic', 11, -12),
      constant('producer:legacy-constant', {
        outputs: [
          { signal: A, value: 13 },
          { signal: B, value: 13 },
        ],
      }),
      constant('producer:exact-constant', { configuration: exactConfiguration }),
      decider('producer:decider', {
        condition: tree,
        outputs: [
          { mode: 'constant', signal: { kind: 'signal', signal: A }, value: 13 },
          { mode: 'copy', signal: { kind: 'signal', signal: B } },
        ],
        elseOutputs: [
          { mode: 'constant', signal: { kind: 'signal', signal: A }, value: 21 },
          { mode: 'constant', signal: { kind: 'wildcard', value: 'each' }, value: 22 },
        ],
      }),
      {
        id: 'producer:selector-number' as ProducerId,
        kind: 'selector',
        config: {
          operation: 'select',
          input: { refKind: 'single', network },
          selectMax: true,
          index: 23,
        },
        destinations: [],
        provenance: producerProvenance(50),
      },
      {
        id: 'producer:selector-signal' as ProducerId,
        kind: 'selector',
        config: {
          operation: 'select',
          input: { refKind: 'single', network },
          selectMax: false,
          index: A,
        },
        destinations: [],
        provenance: producerProvenance(60),
      },
      {
        id: 'producer:selector-count' as ProducerId,
        kind: 'selector',
        config: { operation: 'count', input: { refKind: 'single', network }, output: B },
        destinations: [],
        provenance: producerProvenance(70),
      },
    ]);

    const result = collectOccupiedAutomaticNumberValues(ir);
    expect(result.map(({ value }) => value)).toEqual([
      11, -12, 1, 13, 13, 0, 14, 15, -2_147_483_648, 16, 17, 18, 19, 13, 21, 22, 23,
    ]);
    expect(result.map(({ path }) => path)).toEqual([
      '$.producers[0].config.left.value',
      '$.producers[0].config.right.value',
      '$.producers[1].config',
      '$.producers[1].config.outputs[0].value',
      '$.producers[1].config.outputs[1].value',
      '$.producers[2].config.configuration.sections[0].multiplier',
      '$.producers[2].config.configuration.sections[0].filters[0].value',
      '$.producers[2].config.configuration.sections[1].filters[0].value',
      '$.producers[2].config.configuration.sections[2].multiplier',
      '$.producers[2].config.configuration.sections[2].filters[0].value',
      '$.producers[2].config.configuration.sections[3].filters[0].value',
      '$.producers[3].config.condition.conditions[0].right.value',
      '$.producers[3].config.condition.conditions[1].conditions[0].right.value',
      '$.producers[3].config.outputs[0].value',
      '$.producers[3].config.elseOutputs[0].value',
      '$.producers[3].config.elseOutputs[1].value',
      '$.producers[4].config.index',
    ]);
    expect(result.every(({ source: span }) => span !== undefined)).toBe(true);
    expect(Object.isFrozen(result)).toBe(true);
    expect(result.every(Object.isFrozen)).toBe(true);
  });

  test('preserves repeated occurrences and reads inactive/grouped Constant sections', () => {
    const configuration = canonicalizeConstantConfiguration({
      isOn: false,
      sections: [
        {
          active: false,
          group: 'reserve',
          multiplier: 4,
          filters: [
            { signal: A, value: 31 },
            { signal: B, value: 31 },
          ],
        },
      ],
    });
    const result = collectOccupiedAutomaticNumberValues(
      circuit([constant('producer:constant', { configuration })]),
    );
    expect(result.map(({ value }) => value)).toEqual([4, 31, 31]);
  });

  test('rejects unlinked, unknown-mode, raw, typed and family-mismatched physical Entities with source', () => {
    const producer: CircuitProducerNode = {
      ...arithmetic('producer:linked', 5, 6),
      entityId: 'entity:linked' as EntityId,
    };
    const matching = physicalEntity(
      'entity:linked',
      {
        mode: 'arithmetic',
        left: { kind: 'constant', value: 5 },
        operation: 'add',
        right: { kind: 'constant', value: 6 },
        output: { kind: 'signal', signal: A },
      },
      {
        prototypeName: 'arithmetic-combinator',
        profile: {
          prototypeKey: 'entity:arithmetic-combinator',
          database: { schemaVersion: 1, identity: 'test' },
          profileId: 'profile:arithmetic-test',
        },
      },
    );
    expect(
      collectOccupiedAutomaticNumberValues(circuit([producer], [matching])).map(
        ({ value }) => value,
      ),
    ).toEqual([5, 6]);

    for (const configuration of [
      undefined,
      { mode: 'raw', payload: {} },
      {
        mode: 'typed',
        rule: 'rule:test',
        feature: 'feature:test',
        nativeField: 'control_behavior.circuit_condition',
        connector: 'connector:test',
        lanes: ['lane:test'],
        laneMask: { red: true, green: false },
        condition: { kind: 'compare-signal-constant', signal: A, comparator: '>', constant: 0 },
      },
      {
        mode: 'constant',
        value: canonicalizeConstantConfiguration({ isOn: true, sections: [] }),
      },
      { mode: 'unsupported-family' },
    ] as const) {
      expectCoverageFailure(
        circuit(
          [producer],
          [
            physicalEntity(
              'entity:linked',
              configuration as EntityPhysicalConfiguration | undefined,
            ),
          ],
        ),
        '$.entities[0].configuration',
      );
    }

    expectCoverageFailure(
      circuit(
        [arithmetic('producer:unlinked', 5, 6)],
        [
          physicalEntity('entity:unlinked', {
            mode: 'arithmetic',
            left: { kind: 'constant', value: 5 },
            operation: 'add',
            right: { kind: 'constant', value: 6 },
            output: { kind: 'signal', signal: A },
          }),
        ],
      ),
      '$.entities[0]',
    );
    expectCoverageFailure(
      circuit(
        [
          { ...producer, entityId: 'entity:linked' as EntityId },
          {
            ...producer,
            id: 'producer:second-link' as ProducerId,
            entityId: 'entity:linked' as EntityId,
          },
        ],
        [
          physicalEntity('entity:linked', {
            mode: 'arithmetic',
            left: { kind: 'constant', value: 5 },
            operation: 'add',
            right: { kind: 'constant', value: 6 },
            output: { kind: 'signal', signal: A },
          }),
        ],
      ),
      '$.entities[0]',
    );
    expectCoverageFailure(
      circuit([{ ...producer, entityId: 'entity:missing' as EntityId }]),
      '$.producers[0].entityId',
    );
    const invalid = circuit(
      [arithmetic('producer:retry', 12, 13)],
      [
        physicalEntity('entity:unlinked-retry', {
          mode: 'arithmetic',
          left: { kind: 'constant', value: 12 },
          operation: 'add',
          right: { kind: 'constant', value: 13 },
          output: { kind: 'signal', signal: A },
        }),
      ],
    );
    const beforeFailure = structuredClone(invalid);
    expectCoverageFailure(invalid, '$.entities[0]');
    expect(invalid).toEqual(beforeFailure);
    expect(
      collectOccupiedAutomaticNumberValues(
        circuit([arithmetic('producer:retry-valid', 12, 13)]),
      ).map(({ value }) => value),
    ).toEqual([12, 13]);
  });

  test('requires linked Constant fields to match the producer configuration used by projection', () => {
    const expected = canonicalizeConstantConfiguration({
      isOn: true,
      sections: [{ active: true, multiplier: 1, filters: [{ signal: A, value: 5 }] }],
    });
    const independent = canonicalizeConstantConfiguration({
      isOn: true,
      sections: [{ active: true, multiplier: 1, filters: [{ signal: A, value: 99 }] }],
    });
    const producer = {
      ...constant('producer:constant', { configuration: expected }),
      entityId: 'entity:constant' as EntityId,
    };
    expectCoverageFailure(
      circuit(
        [producer],
        [physicalEntity('entity:constant', { mode: 'constant', value: independent })],
      ),
      '$.entities[0].configuration',
    );

    const legacyProducer = {
      ...constant('producer:legacy-linked', { outputs: [{ signal: A, value: 5 }] }),
      entityId: 'entity:legacy-linked' as EntityId,
    };
    const legacyPhysicalConfiguration = canonicalizeConstantConfiguration({
      isOn: true,
      sections: [{ active: true, multiplier: 1, filters: [{ signal: A, value: 5 }] }],
    });
    const accepted = collectOccupiedAutomaticNumberValues(
      circuit(
        [legacyProducer],
        [
          physicalEntity('entity:legacy-linked', {
            mode: 'constant',
            value: legacyPhysicalConfiguration,
          }),
        ],
      ),
    );
    expect(accepted.map(({ value }) => value)).toEqual([1, 5]);
  });

  test('reserves the native section multiplier generated for legacy Constant rows', () => {
    for (const outputs of [[], [{ signal: A, value: 7 }]]) {
      const ir = circuit([constant('producer:legacy-section', { outputs })]);
      const native = lowerNativeBlueprintConfig(ir, 1024).combinators[0]!.entity;
      expect(native.control_behavior).toMatchObject({
        sections: { sections: [{ multiplier: 1 }] },
      });
      const occupied = collectOccupiedAutomaticNumberValues(ir);
      expect(occupied[0]).toMatchObject({ value: 1, path: '$.producers[0].config' });
      expect(
        selectAutomaticNumberDefaults(
          occupied.map(({ value }) => value),
          1,
        ),
      ).toEqual([2]);
    }
  });

  test('does not cap existing producer census size by the allocation output budget', () => {
    const producers = Array.from({ length: constantConfigurationLimits.maxNodes + 1 }, (_, index) =>
      arithmetic(`producer:${index}`, index, -index),
    );
    expect(collectOccupiedAutomaticNumberValues(circuit(producers))).toHaveLength(
      (constantConfigurationLimits.maxNodes + 1) * 2,
    );
  });

  test('does not reserve placement, prototype, profile, connector, mask or source metadata numbers', () => {
    const producer: CircuitProducerNode = {
      ...arithmetic('producer:physical', 8, 9),
      entityId: 'entity:physical' as EntityId,
    };
    const entity = physicalEntity(
      'entity:physical',
      {
        mode: 'arithmetic',
        left: { kind: 'constant', value: 8 },
        operation: 'add',
        right: { kind: 'constant', value: 9 },
        output: { kind: 'signal', signal: A },
      },
      {
        prototypeName: 'arithmetic-combinator',
        profile: {
          prototypeKey: 'entity:arithmetic-combinator',
          database: { schemaVersion: 2_000_000_000, identity: 'profile-100' },
          profileId: 'profile:200',
        },
        connectorBindings: [
          { network, nativeConnector: 77, endpoint: { color: 'red' }, provenance },
        ],
        laneMask: { red: 4, green: 5 },
      },
    );
    expect(
      collectOccupiedAutomaticNumberValues(circuit([producer], [entity])).map(({ value }) => value),
    ).toEqual([8, 9]);
  });
});

function parameterHost() {
  const families = [
    'constant-combinator',
    'arithmetic-combinator',
    'decider-combinator',
    'selector-combinator',
  ] as const;
  const profiles = families.map((family, index) => ({
    ...structuredClone(syntheticZeroPortEntityProfile),
    ref: {
      ...syntheticZeroPortEntityProfile.ref,
      prototypeKey: `entity:${family}` as EntityProfile['ref']['prototypeKey'],
      profileId: `profile:auto-number-${index}` as EntityProfile['ref']['profileId'],
    },
    prototypeType: family,
  }));
  const trustedEntityReplayContext = createTrustedEntityReplayContext({
    database: profiles[0]!.ref.database,
    source: 'synthetic',
    evidenceIdentity: 'source-auto-number-test-evidence',
    policyIdentity: 'source-auto-number-test-policy',
    profiles,
  });
  const prototypes = families.map((family) => ({
    key: `entity:${family}` as EntityPrototype['key'],
    name: family,
    type: family,
    tileWidth: 1,
    tileHeight: 1,
  })) as EntityPrototype[];
  const entityPrototypeResolver: EntityPrototypeResolver = {
    database: trustedEntityReplayContext.database,
    getEntity(nameOrKey) {
      return prototypes.find(({ key, name }) => key === nameOrKey || name === nameOrKey);
    },
  };
  return { trustedEntityReplayContext, entityPrototypeResolver };
}

function compile(sourceText: string) {
  const compilation = compileSourceProgram(
    { path: 'source-automatic-number-defaults.factorio.ts', text: sourceText },
    parameterHost(),
  );
  expect(compilation.pipelineDiagnostics).toEqual([]);
  expect(compilation.resolvedCircuit).toBeDefined();
  return compilation;
}

function compositionSource(parameterFirst: boolean): string {
  const parameterDeclaration = "const root = Param.number('Root', 7, { variable: 'r' });";
  const literalConstant =
    'output += Constant({ sections: [{ filters: [{ signal: B, value: 23 }] }] });';
  return `const A = Signal('virtual', 'signal-A');
const B = Signal('item', 'iron-plate', 'normal');
const input = new Network();
const output = new Network();
${parameterFirst ? `${parameterDeclaration}\n${literalConstant}` : `${literalConstant}\n${parameterDeclaration}`}
output += Constant({ sections: [{ filters: [{ signal: A, value: root ** 2 }] }] });
output += Arithmetic({ left: root, operation: 'add', right: 23, output: A });
output += Decider({ condition: input[A] > 23, outputs: [2 * A] });
output += Selector({ input, operation: 'select', index: 23 });`;
}

describe('automatic numeric default foundations on compiled circuits', () => {
  test('composes caller reservations with typed census independently of source declaration order', () => {
    const compilations = [compile(compositionSource(false)), compile(compositionSource(true))];
    const selections = compilations.map((compilation) => {
      const resolved = compilation.resolvedCircuit!;
      const planBefore = structuredClone(compilation.plan);
      const circuitBefore = structuredClone(resolved.ir);
      const declarations = listSourceCompilationParameters(compilation);
      const explicitReservations = declarations
        .filter(({ kind }) => kind === 'number')
        .map(({ defaultValue }) => defaultValue as number);
      const derivedNativeOriginals = [49]; // root ** 2 at the declared default
      const occurrences = collectOccupiedAutomaticNumberValues(resolved.ir);
      expect(occurrences.filter(({ value }) => value === 23)).toHaveLength(4);
      expect(occurrences.some(({ value }) => value === 49)).toBe(true);
      expect(collectOccupiedAutomaticNumberValues(resolved.ir)).toEqual(occurrences);

      const reservations = [
        ...explicitReservations,
        ...derivedNativeOriginals,
        ...occurrences.map(({ value }) => value),
      ];
      const selected = selectAutomaticNumberDefaults(reservations, 4);
      expect(Object.isFrozen(selected)).toBe(true);
      expect(() => selectAutomaticNumberDefaults([Number.NaN], 1)).toThrow(TypeError);
      expect(selectAutomaticNumberDefaults(reservations, 4)).toEqual(selected);
      expect(compilation.plan).toEqual(planBefore);
      expect(resolved.ir).toEqual(circuitBefore);
      return selected;
    });
    expect(selections[0]).toEqual(selections[1]);
    expect(selections[0]).toEqual([3, 4, 5, 6]);
  });
});

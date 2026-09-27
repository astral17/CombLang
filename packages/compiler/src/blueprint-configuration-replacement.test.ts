import { canonicalizeConstantConfiguration, signal } from '@comblang/factorio';
import { sourceFileId, sourceSpan, type NetworkId, type ProducerId } from '@comblang/shared';
import { describe, expect, test } from 'vitest';

import { generateBlueprintJson } from './blueprint-json.js';
import type { EntityProfile } from './entity.js';
import {
  createTrustedEntityReplayContext,
  entityReplayContextRef,
} from './entity-replay-context.js';
import type { NativeCircuitIr } from './ir.js';
import { createBlueprintParameterSession } from './blueprint-parameters.js';
import { createBlueprintNumericExpression } from './blueprint-numeric-expression.js';
import { createBlueprintConfigurationSet } from './blueprint-configuration-set.js';
import { createConstantConfigurationTemplate } from './constant-configuration-template.js';
import { createArithmeticConfigurationTemplate } from './arithmetic-configuration-template.js';
import { createSelectorConfigurationTemplate } from './selector-configuration-template.js';
import { createDeciderConfigurationTemplate } from './decider-configuration-template.js';
import { replaceBlueprintConfigurationSetInNativeCircuitIr } from './blueprint-configuration-binding.js';
import type {
  ArithmeticProducerConfig,
  CircuitProducerNode,
  DeciderProducerConfig,
  SelectorProducerConfig,
} from './ir.js';
import type { DeciderOutputOrigin } from './direct-plan-schema.js';
import type { EntityId, EntityPhysicalRecord } from './entity.js';
import { syntheticZeroPortEntityProfile } from './entity-fixtures.js';

const network = 'network:output' as NetworkId;
const firstProducer = 'producer:first' as ProducerId;
const secondProducer = 'producer:second' as ProducerId;
const provenance = { instancePath: [], expansionStack: [] } as const;
const targetSignal = signal('virtual', 'signal-A');

function constantCircuit(ids: readonly ProducerId[] = [firstProducer]): NativeCircuitIr {
  return {
    format: 'comblang-ncir',
    networks: [{ id: network, color: 'red', provenance }],
    entities: [],
    producers: ids.map((id) => ({
      id,
      kind: 'constant' as const,
      config: {
        configuration: canonicalizeConstantConfiguration({
          sections: [{ filters: [{ signal: targetSignal, value: 1 }] }],
        }),
      },
      destinations: [network],
      provenance,
    })),
  };
}

function oneEntrySet() {
  const session = createBlueprintParameterSession();
  const amount = session.number('amount', { defaultValue: 2 });
  const template = createConstantConfigurationTemplate(session, {
    sections: [{ filters: [{ signal: targetSignal, value: amount }] }],
  });
  const set = createBlueprintConfigurationSet(session, [
    { key: 'source', kind: 'constant', template },
  ]);
  return { amount, set, session };
}

describe('concrete NCIR configuration-set replacement', () => {
  test('validates assignments as exact bounded data and copies the successful input', () => {
    const { amount, set } = oneEntrySet();
    const circuit = constantCircuit();
    const assignments = [{ key: 'source', producerId: firstProducer }];

    const replaced = replaceBlueprintConfigurationSetInNativeCircuitIr(set, circuit, assignments, [
      { parameter: amount, value: 9 },
    ]);
    assignments[0]!.key = 'changed';

    expect(replaced).not.toBe(circuit);
    expect(replaced.producers).not.toBe(circuit.producers);
    expect(replaced.producers[0]).not.toBe(circuit.producers[0]);
    expect(replaced.producers[0]?.config).toMatchObject({
      configuration: { sections: [{ filters: [{ value: 9 }] }] },
    });
    expect(circuit.producers[0]?.config).toMatchObject({
      configuration: { sections: [{ filters: [{ value: 1 }] }] },
    });
    expect(assignments[0]?.key).toBe('changed');
    expect(JSON.stringify(replaced)).not.toContain('amount');
    expect(JSON.stringify(replaced)).not.toContain('source');
    expect(Object.isFrozen(replaced)).toBe(true);
    expect(Object.isFrozen(replaced.producers)).toBe(true);
    expect(Object.isFrozen(replaced.producers[0])).toBe(true);
    expect(Object.isFrozen(replaced.producers[0]?.config)).toBe(true);
    expect(Object.hasOwn(replaced, 'context')).toBe(false);
  });

  test('rejects holes, accessors, unknown fields, duplicates, missing and unknown targets', () => {
    const { set } = oneEntrySet();
    const circuit = constantCircuit([firstProducer, secondProducer]);
    const expectInvalid = (
      assignments: unknown,
      expected: Record<string, unknown>,
      targetCircuit = circuit,
    ) => {
      expect(() =>
        replaceBlueprintConfigurationSetInNativeCircuitIr(set, targetCircuit, assignments),
      ).toThrowError(expect.objectContaining(expected));
    };

    expectInvalid([{ key: 'source', producerId: firstProducer, extra: true }], {
      code: 'CP1000',
      path: '$.assignments[0].extra',
    });
    expectInvalid([{ key: 'source' }], {
      code: 'CP1000',
      path: '$.assignments[0].producerId',
    });
    expectInvalid([{ producerId: firstProducer }], {
      code: 'CP1000',
      path: '$.assignments[0].key',
    });
    expectInvalid(new Array(1), { code: 'CP1000', path: '$.assignments[0]' });
    const accessor = { key: 'source' } as Record<string, unknown>;
    let getterCalls = 0;
    Object.defineProperty(accessor, 'producerId', {
      enumerable: true,
      get() {
        getterCalls += 1;
        return firstProducer;
      },
    });
    expectInvalid([accessor], { code: 'CP1000', path: '$.assignments[0].producerId' });
    expect(getterCalls).toBe(0);

    expectInvalid(
      [
        { key: 'source', producerId: firstProducer },
        { key: 'source', producerId: secondProducer },
      ],
      { code: 'CP1001', path: '$.assignments[1].key' },
    );
    const secondSession = createBlueprintParameterSession();
    const secondAmount = secondSession.number('second amount', { defaultValue: 1 });
    const secondTemplate = createConstantConfigurationTemplate(secondSession, {
      sections: [{ filters: [{ signal: targetSignal, value: secondAmount }] }],
    });
    const twoEntrySet = createBlueprintConfigurationSet(secondSession, [
      {
        key: 'source',
        kind: 'constant',
        template: createConstantConfigurationTemplate(secondSession, {
          sections: [{ filters: [{ signal: targetSignal, value: secondAmount }] }],
        }),
      },
      { key: 'another-key', kind: 'constant', template: secondTemplate },
    ]);
    expect(() =>
      replaceBlueprintConfigurationSetInNativeCircuitIr(twoEntrySet, circuit, [
        { key: 'source', producerId: firstProducer },
        { key: 'another-key', producerId: firstProducer },
      ]),
    ).toThrowError(
      expect.objectContaining({ code: 'CP1001', path: '$.assignments[1].producerId' }),
    );
    expectInvalid([], { code: 'CP1001', path: '$.assignments' });
    expectInvalid([{ key: 'unknown', producerId: firstProducer }], {
      code: 'CP1001',
      path: '$.assignments[0].key',
    });
    expectInvalid([{ key: 'source', producerId: 'producer:missing' }], {
      code: 'CP1001',
      path: '$.assignments[0].producerId',
    });
    expectInvalid([{ key: 'x'.repeat(129), producerId: firstProducer }], {
      code: 'CP1000',
      path: '$.assignments[0].key',
    });
    expectInvalid([{ key: 'source', producerId: 'p'.repeat(129) }], {
      code: 'CP1000',
      path: '$.assignments[0].producerId',
    });
    const mismatchCircuit: NativeCircuitIr = {
      ...circuit,
      producers: [
        ...circuit.producers,
        {
          id: 'producer:arithmetic' as ProducerId,
          kind: 'arithmetic',
          config: {
            left: { kind: 'constant', value: 1 },
            operation: 'add',
            right: { kind: 'constant', value: 1 },
            output: { kind: 'each' },
          },
          destinations: [network],
          provenance,
        },
      ],
    };
    expectInvalid(
      [{ key: 'source', producerId: 'producer:arithmetic' }],
      { code: 'CP1001', path: '$.assignments[0].producerId' },
      mismatchCircuit,
    );
    expect(() =>
      replaceBlueprintConfigurationSetInNativeCircuitIr(
        set,
        constantCircuit([firstProducer, firstProducer]),
        [{ key: 'source', producerId: firstProducer }],
      ),
    ).toThrowError(expect.objectContaining({ code: 'CP1001', path: '$.ir.producers' }));
  });

  test('allows only template slots to change and rejects legacy Constant conversion', () => {
    const session = createBlueprintParameterSession();
    const amount = session.number('amount', { defaultValue: 2 });
    const template = createConstantConfigurationTemplate(session, {
      sections: [{ filters: [{ signal: targetSignal, value: amount }] }],
    });
    const set = createBlueprintConfigurationSet(session, [
      { key: 'source', kind: 'constant', template },
    ]);
    const wrongStaticSignal = constantCircuit();
    const wrongStaticProducer = {
      id: firstProducer,
      kind: 'constant',
      config: {
        configuration: canonicalizeConstantConfiguration({
          sections: [{ filters: [{ signal: signal('virtual', 'signal-B'), value: 1 }] }],
        }),
      },
      destinations: [network],
      provenance,
    } satisfies CircuitProducerNode;
    expect(() =>
      replaceBlueprintConfigurationSetInNativeCircuitIr(
        set,
        { ...wrongStaticSignal, producers: [wrongStaticProducer] },
        [{ key: 'source', producerId: firstProducer }],
      ),
    ).toThrowError(expect.objectContaining({ code: 'CP1001' }));

    const legacy = {
      ...constantCircuit(),
      producers: [
        {
          id: firstProducer,
          kind: 'constant',
          config: { outputs: [{ signal: targetSignal, value: 1 }] },
          destinations: [network],
          provenance,
        },
      ],
    } as unknown as NativeCircuitIr;
    expect(() =>
      replaceBlueprintConfigurationSetInNativeCircuitIr(set, legacy, [
        { key: 'source', producerId: firstProducer },
      ]),
    ).toThrowError(/legacy Constant output rows/);
  });

  test('keeps the linked Entity association and updates its matching physical config', () => {
    const session = createBlueprintParameterSession();
    const amount = session.number('entity amount', { defaultValue: 5 });
    const multiplier = session.number('entity multiplier', { defaultValue: 0.5 });
    const multiplierExpression = createBlueprintNumericExpression(session, {
      kind: 'binary',
      operator: 'add',
      left: { kind: 'parameter', parameter: multiplier },
      right: { kind: 'literal', value: 0.25 },
    });
    const template = createConstantConfigurationTemplate(session, {
      sections: [
        { multiplier: multiplierExpression, filters: [{ signal: targetSignal, value: amount }] },
      ],
    });
    const set = createBlueprintConfigurationSet(session, [
      { key: 'source', kind: 'constant', template },
    ]);
    const entityId = 'entity:constant' as EntityId;
    const entitySource = sourceSpan(sourceFileId('linked-entity.test.ts'), 0, 1);
    const profile: EntityProfile = {
      ...syntheticZeroPortEntityProfile,
      prototypeType: 'constant-combinator',
      ref: {
        ...syntheticZeroPortEntityProfile.ref,
        prototypeKey: 'entity:constant-combinator',
      },
    };
    const trustedContext = createTrustedEntityReplayContext({
      database: profile.ref.database,
      source: 'synthetic',
      evidenceIdentity: 'blueprint-replacement-test-evidence',
      policyIdentity: 'blueprint-replacement-test-policy',
      profiles: [profile],
    });
    const originalConfiguration = canonicalizeConstantConfiguration({
      sections: [{ filters: [{ signal: targetSignal, value: 1 }] }],
    });
    const producer = {
      id: firstProducer,
      kind: 'constant',
      config: { configuration: originalConfiguration },
      destinations: [network],
      provenance,
      entityId,
    } satisfies CircuitProducerNode;
    const entity: EntityPhysicalRecord = {
      id: entityId,
      profile: profile.ref,
      provenance: {
        source: entitySource,
        instancePath: ['entity'],
        expansionStack: [],
        creationRevision: 1,
      },
      ordinal: 1,
      prototypeName: 'constant-combinator',
      configuration: {
        mode: 'constant',
        value: originalConfiguration,
      },
      connectorBindings: [],
    };
    const circuit: NativeCircuitIr = {
      ...constantCircuit(),
      context: entityReplayContextRef(trustedContext),
      producers: [producer],
      entities: [entity],
    };
    const replaced = replaceBlueprintConfigurationSetInNativeCircuitIr(
      set,
      circuit,
      [{ key: 'source', producerId: firstProducer }],
      [
        { parameter: amount, value: 11 },
        { parameter: multiplier, value: 2.25 },
      ],
    );
    expect(replaced.producers[0]?.entityId).toBe(entityId);
    expect(replaced.entities[0]?.id).toBe(entityId);
    expect(replaced.entities[0]?.configuration).toEqual({
      mode: 'constant',
      value: canonicalizeConstantConfiguration({
        sections: [{ multiplier: 2.5, filters: [{ signal: targetSignal, value: 11 }] }],
      }),
    });
    const expectedConfiguration = canonicalizeConstantConfiguration({
      sections: [{ multiplier: 2.5, filters: [{ signal: targetSignal, value: 11 }] }],
    });
    const expectedCircuit: NativeCircuitIr = {
      ...circuit,
      producers: [{ ...producer, config: { configuration: expectedConfiguration } }],
      entities: [{ ...entity, configuration: { mode: 'constant', value: expectedConfiguration } }],
    };
    expect(generateBlueprintJson(replaced)).toEqual(generateBlueprintJson(expectedCircuit));
    expect(entity.configuration?.mode).toBe('constant');
    expect(
      entity.configuration?.mode === 'constant'
        ? entity.configuration.value.sections[0]?.filters[0]?.value
        : null,
    ).toBe(1);
    expect(JSON.stringify(replaced)).not.toContain('entity multiplier');
    expect(JSON.stringify(replaced)).not.toContain('entity amount');
    const replacedBeforeFailure = JSON.stringify(replaced);
    const circuitBeforeFailure = JSON.stringify(circuit);
    expect(() =>
      replaceBlueprintConfigurationSetInNativeCircuitIr(
        set,
        circuit,
        [{ key: 'source', producerId: firstProducer }],
        [
          { parameter: amount, value: 12 },
          { parameter: multiplier, value: Infinity },
        ],
      ),
    ).toThrowError(expect.objectContaining({ code: 'CP1000' }));
    expect(JSON.stringify(replaced)).toBe(replacedBeforeFailure);
    expect(JSON.stringify(circuit)).toBe(circuitBeforeFailure);

    const duplicateLink: CircuitProducerNode = {
      ...producer,
      id: secondProducer,
    };
    expect(() =>
      replaceBlueprintConfigurationSetInNativeCircuitIr(
        set,
        { ...circuit, producers: [producer, duplicateLink] },
        [{ key: 'source', producerId: firstProducer }],
        [
          { parameter: amount, value: 12 },
          { parameter: multiplier, value: 3 },
        ],
      ),
    ).toThrowError(expect.objectContaining({ code: 'CP1001', path: '$.ir.producers[1].entityId' }));
  });

  test('validates all concrete NCIR data before a selected replacement can repair it', () => {
    const { amount, set } = oneEntrySet();
    const assignment = [{ key: 'source', producerId: firstProducer }];
    const expectInvalidCircuit = (circuit: NativeCircuitIr, path: string) => {
      expect(() =>
        replaceBlueprintConfigurationSetInNativeCircuitIr(set, circuit, assignment, [
          { parameter: amount, value: 7 },
        ]),
      ).toThrowError(expect.objectContaining({ code: 'CP1001', path }));
    };

    const valid = constantCircuit();
    const danglingDestination: NativeCircuitIr = {
      ...valid,
      producers: valid.producers.map((producer) => ({
        ...producer,
        destinations: ['network:missing' as NetworkId],
      })),
    };
    expectInvalidCircuit(danglingDestination, '$.ir.producers[0].destinations[0]');

    const twoProducers = constantCircuit([firstProducer, secondProducer]);
    const invalidUnrelatedProducer = {
      ...twoProducers,
      producers: twoProducers.producers.map((producer, index) =>
        index === 1 ? { ...producer, kind: 'unknown' } : producer,
      ),
    } as unknown as NativeCircuitIr;
    expectInvalidCircuit(invalidUnrelatedProducer, '$.ir.producers[1].kind');

    const malformedParameterSlot = {
      ...valid,
      producers: valid.producers.map((producer) => ({
        ...producer,
        config: {
          configuration: {
            isOn: true,
            sections: [{ filters: [{ signal: targetSignal, value: 0.5 }] }],
          },
        },
      })),
    } as unknown as NativeCircuitIr;
    expectInvalidCircuit(
      malformedParameterSlot,
      '$.ir.producers[0].config.configuration.sections[0].filters[0].value',
    );

    const entityId = 'entity:baseline' as EntityId;
    const profile: EntityProfile = {
      ...syntheticZeroPortEntityProfile,
      prototypeType: 'constant-combinator',
      ref: {
        ...syntheticZeroPortEntityProfile.ref,
        prototypeKey: 'entity:constant-combinator',
      },
    };
    const trustedContext = createTrustedEntityReplayContext({
      database: profile.ref.database,
      source: 'synthetic',
      evidenceIdentity: 'blueprint-replacement-invalid-baseline-evidence',
      policyIdentity: 'blueprint-replacement-invalid-baseline-policy',
      profiles: [profile],
    });
    const matchingConfiguration = canonicalizeConstantConfiguration({
      sections: [{ filters: [{ signal: targetSignal, value: 1 }] }],
    });
    const linkedProducer: CircuitProducerNode = {
      id: firstProducer,
      kind: 'constant',
      config: { configuration: matchingConfiguration },
      destinations: [network],
      provenance,
      entityId,
    };
    const linkedEntity: EntityPhysicalRecord = {
      id: entityId,
      profile: profile.ref,
      provenance: {
        source: sourceSpan(sourceFileId('invalid-linked-entity.test.ts'), 0, 1),
        instancePath: ['entity'],
        expansionStack: [],
        creationRevision: 1,
      },
      ordinal: 1,
      prototypeName: 'constant-combinator',
      configuration: {
        mode: 'constant',
        value: canonicalizeConstantConfiguration({
          sections: [{ filters: [{ signal: targetSignal, value: 2 }] }],
        }),
      },
      connectorBindings: [],
    };
    const mismatchedLinkedEntity: NativeCircuitIr = {
      ...valid,
      context: entityReplayContextRef(trustedContext),
      producers: [linkedProducer],
      entities: [linkedEntity],
    };
    expectInvalidCircuit(mismatchedLinkedEntity, '$.ir.entities[0].configuration');
  });

  test('replaces Arithmetic values without changing fixed references or graph metadata', () => {
    const input = 'network:arithmetic-input' as NetworkId;
    const output = 'network:arithmetic-output' as NetworkId;
    const unrelated = 'producer:unrelated' as ProducerId;
    const session = createBlueprintParameterSession();
    const amount = session.number('amount', { defaultValue: 9 });
    const template = createArithmeticConfigurationTemplate(session, {
      left: { kind: 'constant', value: amount },
      operation: 'add',
      right: { kind: 'constant', value: 5 },
      output: { kind: 'signal', signal: targetSignal },
    });
    const set = createBlueprintConfigurationSet(session, [
      { key: 'sum', kind: 'arithmetic', template },
    ]);
    const arithmetic: ArithmeticProducerConfig = {
      left: { kind: 'constant', value: 3 },
      operation: 'add',
      right: { kind: 'constant', value: 5 },
      output: { kind: 'signal', signal: targetSignal },
    };
    const fixedProvenance = { instancePath: ['fixture'], expansionStack: ['macro'] } as const;
    const arithmeticProducer = {
      id: firstProducer,
      kind: 'arithmetic',
      config: arithmetic,
      destinations: [output],
      provenance: fixedProvenance,
      placement: { x: 4, y: 7, direction: 2 },
    } satisfies CircuitProducerNode;
    const unrelatedProducer = {
      id: unrelated,
      kind: 'constant',
      config: { configuration: canonicalizeConstantConfiguration({ sections: [] }) },
      destinations: [input],
      provenance,
    } satisfies CircuitProducerNode;
    const circuit: NativeCircuitIr = {
      format: 'comblang-ncir',
      networks: [
        { id: input, color: 'red', provenance },
        { id: output, color: 'green', provenance },
      ],
      entities: [],
      producers: [arithmeticProducer, unrelatedProducer],
    };
    const replaced = replaceBlueprintConfigurationSetInNativeCircuitIr(set, circuit, [
      { key: 'sum', producerId: firstProducer },
    ]);
    expect(replaced.producers[0]?.config).toEqual({
      ...arithmetic,
      left: { kind: 'constant', value: 9 },
    });
    expect(replaced.producers[0]?.destinations).toEqual(circuit.producers[0]?.destinations);
    expect(replaced.producers[0]?.provenance).toEqual(fixedProvenance);
    expect(replaced.producers[0]?.placement).toEqual({ x: 4, y: 7, direction: 2 });
    expect(replaced.producers[1]).toEqual(circuit.producers[1]);
    expect(replaced.producers[1]).not.toBe(circuit.producers[1]);

    const changedStaticValue: NativeCircuitIr = {
      ...circuit,
      producers: [
        { ...arithmeticProducer, config: { ...arithmetic, right: { kind: 'constant', value: 6 } } },
        unrelatedProducer,
      ],
    };
    expect(() =>
      replaceBlueprintConfigurationSetInNativeCircuitIr(set, changedStaticValue, [
        { key: 'sum', producerId: firstProducer },
      ]),
    ).toThrowError(expect.objectContaining({ code: 'CP1001' }));
  });

  test('preserves Decider branch rows and output-origin associations', () => {
    const input = 'network:decider-input' as NetworkId;
    const output = 'network:decider-output' as NetworkId;
    const session = createBlueprintParameterSession();
    const conditionSignal = session.signal('condition', { defaultValue: targetSignal });
    const threshold = session.number('threshold', { defaultValue: 4 });
    const outputSignal = session.signal('output', { defaultValue: signal('virtual', 'signal-B') });
    const elseValue = session.number('else value', { defaultValue: 6 });
    const template = createDeciderConfigurationTemplate(session, {
      condition: {
        kind: 'compare',
        left: { kind: 'signal', signal: conditionSignal, refKind: 'single', network: input },
        comparator: '>=',
        right: { kind: 'constant', value: threshold },
      },
      outputs: [
        {
          mode: 'copy',
          signal: { kind: 'signal', signal: outputSignal },
          input: { refKind: 'single', network: output },
        },
        { mode: 'constant', signal: { kind: 'wildcard', value: 'anything' }, value: 2 },
      ],
      elseOutputs: [
        { mode: 'constant', signal: { kind: 'signal', signal: outputSignal }, value: elseValue },
      ],
    });
    const set = createBlueprintConfigurationSet(session, [
      { key: 'decision', kind: 'decider', template },
    ]);
    const original: DeciderProducerConfig = {
      condition: {
        kind: 'compare',
        left: { kind: 'signal', signal: targetSignal, refKind: 'single', network: input },
        comparator: '>=',
        right: { kind: 'constant', value: 1 },
      },
      outputs: [
        {
          mode: 'copy',
          signal: { kind: 'signal', signal: signal('virtual', 'signal-B') },
          input: { refKind: 'single', network: output },
        },
        { mode: 'constant', signal: { kind: 'wildcard', value: 'anything' }, value: 2 },
      ],
      elseOutputs: [
        {
          mode: 'constant',
          signal: { kind: 'signal', signal: signal('virtual', 'signal-B') },
          value: 3,
        },
      ],
    };
    const source = sourceSpan(sourceFileId('replacement.test.ts'), 0, 1);
    const normalOrigins = [0, 1].map((ordinal) => ({
      branch: 'normal' as const,
      ordinal,
      source,
      instancePath: ['normal'],
      syntaxIntent: 'exact' as const,
    })) satisfies DeciderOutputOrigin[];
    const elseOrigins = [
      {
        branch: 'else' as const,
        ordinal: 0,
        source,
        instancePath: ['else'],
        syntaxIntent: 'explicit-constant' as const,
      },
    ] satisfies DeciderOutputOrigin[];
    const deciderProducer = {
      id: firstProducer,
      kind: 'decider',
      config: original,
      outputOrigins: normalOrigins,
      elseOutputOrigins: elseOrigins,
      destinations: [output],
      provenance,
    } satisfies CircuitProducerNode;
    const circuit: NativeCircuitIr = {
      format: 'comblang-ncir',
      networks: [
        { id: input, color: 'red', provenance },
        { id: output, color: 'green', provenance },
      ],
      entities: [],
      producers: [deciderProducer],
    };
    const replaced = replaceBlueprintConfigurationSetInNativeCircuitIr(
      set,
      circuit,
      [{ key: 'decision', producerId: firstProducer }],
      [
        { parameter: conditionSignal, value: signal('virtual', 'signal-C') },
        { parameter: threshold, value: 8 },
        { parameter: outputSignal, value: signal('virtual', 'signal-D') },
        { parameter: elseValue, value: 10 },
      ],
    );
    const changed = replaced.producers[0];
    expect(changed?.kind).toBe('decider');
    if (changed?.kind !== 'decider') throw new Error('expected Decider producer');
    expect(changed.config.outputs).toHaveLength(2);
    expect(changed.config.elseOutputs).toHaveLength(1);
    expect(changed.outputOrigins).toEqual(normalOrigins);
    expect(changed.elseOutputOrigins).toEqual(elseOrigins);
    const concrete: DeciderProducerConfig = {
      condition: {
        kind: 'compare',
        left: {
          kind: 'signal',
          signal: signal('virtual', 'signal-C'),
          refKind: 'single',
          network: input,
        },
        comparator: '>=',
        right: { kind: 'constant', value: 8 },
      },
      outputs: [
        {
          mode: 'copy',
          signal: { kind: 'signal', signal: signal('virtual', 'signal-D') },
          input: { refKind: 'single', network: output },
        },
        { mode: 'constant', signal: { kind: 'wildcard', value: 'anything' }, value: 2 },
      ],
      elseOutputs: [
        {
          mode: 'constant',
          signal: { kind: 'signal', signal: signal('virtual', 'signal-D') },
          value: 10,
        },
      ],
    };
    expect(generateBlueprintJson(replaced)).toEqual(
      generateBlueprintJson({ ...circuit, producers: [{ ...deciderProducer, config: concrete }] }),
    );
    const missingElse: DeciderProducerConfig = {
      condition: original.condition,
      outputs: original.outputs,
    };
    expect(() =>
      replaceBlueprintConfigurationSetInNativeCircuitIr(
        set,
        { ...circuit, producers: [{ ...deciderProducer, config: missingElse }] },
        [{ key: 'decision', producerId: firstProducer }],
      ),
    ).toThrowError(expect.objectContaining({ code: 'CP1001' }));
  });

  test('replaces Selector index while keeping its fixed input pair', () => {
    const redInput = 'network:selector-red' as NetworkId;
    const greenInput = 'network:selector-green' as NetworkId;
    const output = 'network:selector-output' as NetworkId;
    const session = createBlueprintParameterSession();
    const index = session.number('index', { defaultValue: 0 });
    const template = createSelectorConfigurationTemplate(session, {
      operation: 'select',
      input: { refKind: 'pair', networks: [redInput, greenInput] },
      selectMax: false,
      index,
    });
    const set = createBlueprintConfigurationSet(session, [
      { key: 'selector', kind: 'selector', template },
    ]);
    const selectorConfig: SelectorProducerConfig = {
      operation: 'select',
      input: { refKind: 'pair', networks: [redInput, greenInput] },
      selectMax: false,
      index: 0,
    };
    const selectorProducer = {
      id: firstProducer,
      kind: 'selector',
      config: selectorConfig,
      destinations: [output],
      provenance,
    } satisfies CircuitProducerNode;
    const circuit: NativeCircuitIr = {
      format: 'comblang-ncir',
      networks: [
        { id: redInput, color: 'red', provenance },
        { id: greenInput, color: 'green', provenance },
        { id: output, color: 'green', provenance },
      ],
      entities: [],
      producers: [selectorProducer],
    };
    const replaced = replaceBlueprintConfigurationSetInNativeCircuitIr(
      set,
      circuit,
      [{ key: 'selector', producerId: firstProducer }],
      [{ parameter: index, value: 2 }],
    );
    expect(
      replaced.producers[0]?.kind === 'selector' &&
        replaced.producers[0].config.operation === 'select'
        ? replaced.producers[0].config.index
        : null,
    ).toBe(2);
    expect(generateBlueprintJson(replaced)).toEqual(
      generateBlueprintJson({
        ...circuit,
        producers: [{ ...selectorProducer, config: { ...selectorConfig, index: 2 } }],
      }),
    );
    const changedReference: NativeCircuitIr = {
      ...circuit,
      producers: [
        {
          ...selectorProducer,
          config: {
            ...selectorConfig,
            input: { refKind: 'single', network: redInput },
          },
        },
      ],
    };
    expect(() =>
      replaceBlueprintConfigurationSetInNativeCircuitIr(set, changedReference, [
        { key: 'selector', producerId: firstProducer },
      ]),
    ).toThrowError(expect.objectContaining({ code: 'CP1001' }));

    const countOutput = session.signal('count output', {
      defaultValue: signal('virtual', 'signal-count'),
    });
    const countTemplate = createSelectorConfigurationTemplate(session, {
      operation: 'count',
      input: { refKind: 'pair', networks: [redInput, greenInput] },
      output: countOutput,
    });
    const countSet = createBlueprintConfigurationSet(session, [
      { key: 'count', kind: 'selector', template: countTemplate },
    ]);
    const countConfig: SelectorProducerConfig = {
      operation: 'count',
      input: { refKind: 'pair', networks: [redInput, greenInput] },
      output: signal('virtual', 'signal-count'),
    };
    const countCircuit: NativeCircuitIr = {
      ...circuit,
      producers: [{ ...selectorProducer, config: countConfig }],
    };
    const countReplaced = replaceBlueprintConfigurationSetInNativeCircuitIr(
      countSet,
      countCircuit,
      [{ key: 'count', producerId: firstProducer }],
      [{ parameter: countOutput, value: signal('virtual', 'signal-total') }],
    );
    expect(generateBlueprintJson(countReplaced)).toEqual(
      generateBlueprintJson({
        ...countCircuit,
        producers: [
          {
            ...selectorProducer,
            config: { ...countConfig, output: signal('virtual', 'signal-total') },
          },
        ],
      }),
    );
  });
});

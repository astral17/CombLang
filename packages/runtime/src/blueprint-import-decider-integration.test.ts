import { classifyBlueprintDocument } from '@comblang/blueprint/classification';
import { parseLosslessJson } from '@comblang/blueprint/document';
import { analyzeBlueprintImport } from '@comblang/blueprint/import-analysis';
import { generateCanonicalBlueprintSource } from '@comblang/compiler/blueprint-import-source-assembly';
import { verifyCanonicalBlueprintSourceRoundTrip } from '@comblang/compiler/blueprint-import-source-verification';
import { syntheticZeroPortEntityProfile } from '@comblang/compiler/entity-fixtures';
import { createTrustedEntityReplayContext } from '@comblang/compiler/entity-replay-context';
import type { EntityProfile, EntityProfileId } from '@comblang/compiler/entity';
import type {
  DeciderProducerConfig,
  LogicalDeciderCondition,
  NativeCircuitIr,
} from '@comblang/compiler/ir';
import type { ResolvedCircuit } from '@comblang/compiler/resolved-circuit';
import type { EntityPrototype } from '@comblang/prototypes';

import { analyzeCanonicalBlueprintImport } from '../../compiler/src/blueprint-import-canonical-families.js';
import type { EntityPrototypeResolver } from './entity-registry.js';
import { compileSourceProgram } from './source-compilation.js';

import { beforeAll, describe, expect, test } from 'vitest';

const families = [
  ['constant-combinator', 'constant-combinator'],
  ['arithmetic-combinator', 'arithmetic-combinator'],
  ['decider-combinator', 'decider-combinator'],
] as const;

const profiles: readonly EntityProfile[] = families.map(([name, prototypeType], index) => ({
  ...syntheticZeroPortEntityProfile,
  prototypeType,
  ref: {
    ...syntheticZeroPortEntityProfile.ref,
    prototypeKey: `entity:${name}`,
    profileId: `profile:blueprint-import-decider-integration-${index}` as EntityProfileId,
  },
}));

const trustedEntityReplayContext = createTrustedEntityReplayContext({
  database: profiles[0]!.ref.database,
  source: 'synthetic',
  evidenceIdentity: 'blueprint-import-decider-integration-evidence',
  policyIdentity: 'blueprint-import-decider-integration-policy',
  profiles,
});

const prototypes: EntityPrototype[] = families.map(([name, type]) => ({
  key: `entity:${name}`,
  name,
  type,
  tileWidth: 1,
  tileHeight: 1,
}));

const entityPrototypeResolver: EntityPrototypeResolver = {
  database: trustedEntityReplayContext.database,
  getEntity(nameOrKey) {
    return prototypes.find(({ key, name }) => nameOrKey === key || nameOrKey === name);
  },
};

function constantBehavior(signal = 'signal-A') {
  return {
    is_on: true,
    sections: {
      sections: [
        {
          index: 1,
          active: true,
          multiplier: 1,
          filters: [
            {
              index: 1,
              name: signal,
              type: 'virtual',
              quality: 'normal',
              comparator: '=',
              count: 3,
            },
          ],
        },
      ],
    },
  };
}

function arithmeticBehavior() {
  return {
    arithmetic_conditions: {
      first_signal: { type: 'virtual', name: 'signal-A' },
      first_signal_networks: { red: true, green: false },
      operation: '+',
      second_constant: 2,
      output_signal: { type: 'virtual', name: 'signal-B' },
    },
  };
}

function deciderBehavior() {
  return {
    decider_conditions: {
      conditions: [
        {
          first_signal: { type: 'virtual', name: 'signal-each' },
          first_signal_networks: { red: true, green: true },
          comparator: '>',
          constant: 0,
          compare_type: 'and',
        },
        {
          first_signal: { type: 'virtual', name: 'signal-A', quality: 'rare' },
          first_signal_networks: { red: true, green: false },
          comparator: '≥',
          second_signal: { type: 'virtual', name: 'signal-B', quality: 'uncommon' },
          second_signal_networks: { red: false, green: true },
          compare_type: 'or',
        },
      ],
      outputs: [
        {
          signal: { type: 'virtual', name: 'signal-each' },
          copy_count_from_input: true,
          networks: { red: true, green: false },
        },
        {
          signal: { type: 'virtual', name: 'signal-C' },
          copy_count_from_input: false,
          constant: 3,
        },
      ],
      else_outputs: [
        {
          signal: { type: 'virtual', name: 'signal-D' },
          copy_count_from_input: true,
          networks: { red: false, green: true },
        },
        {
          signal: { type: 'virtual', name: 'signal-E' },
          copy_count_from_input: false,
          constant: 5,
        },
      ],
    },
  };
}

function outputlessDeciderBehavior() {
  return {
    decider_conditions: {
      conditions: [
        {
          first_signal: { type: 'virtual', name: 'signal-A' },
          first_signal_networks: { red: false, green: true },
          comparator: '>',
          constant: 0,
          compare_type: 'and',
        },
      ],
      outputs: [
        {
          signal: { type: 'virtual', name: 'signal-B' },
          copy_count_from_input: false,
          constant: 1,
        },
      ],
    },
  };
}

const inputDocument = JSON.stringify({
  blueprint: {
    entities: [
      {
        entity_number: 1,
        name: 'constant-combinator',
        position: { x: 0, y: 0 },
        direction: 4,
        control_behavior: constantBehavior(),
      },
      {
        entity_number: 2,
        name: 'arithmetic-combinator',
        position: { x: 3, y: 1 },
        direction: 8,
        control_behavior: arithmeticBehavior(),
      },
      {
        entity_number: 10,
        name: 'decider-combinator',
        position: { x: 7, y: 2 },
        direction: 12,
        control_behavior: deciderBehavior(),
      },
      {
        entity_number: 11,
        name: 'decider-combinator',
        position: { x: 12, y: 3 },
        direction: 0,
        control_behavior: outputlessDeciderBehavior(),
      },
    ],
    wires: [
      [1, 1, 2, 1],
      [2, 3, 10, 1],
      [10, 3, 1, 1],
      [1, 2, 10, 2],
      [10, 4, 1, 2],
    ],
  },
});

function compileFixture(source = inputDocument) {
  const analysis = analyzeBlueprintImport(classifyBlueprintDocument(parseLosslessJson(source)));
  const selections = (analysis.entities ?? []).map(({ entityNumber, name }) => ({
    entityNumber,
    profile: profiles.find(({ prototypeType }) => prototypeType === name)!.ref,
  }));
  const assembled = generateCanonicalBlueprintSource(
    analysis,
    selections,
    trustedEntityReplayContext,
    { path: 'decider-import-integration.factorio.ts' },
  );
  if (assembled.state !== 'complete') {
    throw new Error(`Expected Decider source assembly: ${JSON.stringify(assembled.diagnostics)}`);
  }
  const compilation = compileSourceProgram(assembled.source, {
    trustedEntityReplayContext,
    entityPrototypeResolver,
  });
  const compiled = {
    source: assembled.source,
    ...(compilation.plan === undefined ? {} : { plan: compilation.plan }),
    ...(compilation.resolvedCircuit === undefined
      ? {}
      : { resolvedCircuit: compilation.resolvedCircuit }),
    diagnostics: compilation.pipelineDiagnostics,
  };
  return { analysis, selections, assembled, compilation, compiled };
}

function withResolvedCircuit(
  fixture: ReturnType<typeof compileFixture>,
  transform: (ir: NativeCircuitIr) => NativeCircuitIr,
) {
  const resolvedCircuit = fixture.compiled.resolvedCircuit;
  if (resolvedCircuit === undefined) throw new Error('Expected a resolved circuit.');
  return {
    ...fixture.compiled,
    resolvedCircuit: { ...resolvedCircuit, ir: transform(resolvedCircuit.ir) } as ResolvedCircuit,
  };
}

function verify(
  fixture: ReturnType<typeof compileFixture>,
  compiled = fixture.compiled,
  assembled = fixture.assembled,
) {
  return verifyCanonicalBlueprintSourceRoundTrip(
    assembled,
    compiled,
    fixture.selections,
    trustedEntityReplayContext,
  );
}

function mutateDeciderConfiguration(
  ir: NativeCircuitIr,
  mutate: (configuration: DeciderProducerConfig) => DeciderProducerConfig,
): NativeCircuitIr {
  const producer = ir.producers.find(
    (candidate) =>
      candidate.kind === 'decider' &&
      candidate.entityId !== undefined &&
      candidate.config.outputs.length === 2,
  );
  if (producer?.kind !== 'decider') throw new Error('Expected a linked Decider producer.');
  return {
    ...ir,
    producers: ir.producers.map((candidate) =>
      candidate.id === producer.id ? { ...producer, config: mutate(producer.config) } : candidate,
    ),
  };
}

function mutateLinkedDeciderPhysicalConfiguration(
  ir: NativeCircuitIr,
  mutate: (configuration: DeciderProducerConfig) => DeciderProducerConfig,
): NativeCircuitIr {
  const producer = ir.producers.find(
    (candidate) =>
      candidate.kind === 'decider' &&
      candidate.entityId !== undefined &&
      candidate.config.outputs.length === 2,
  );
  if (producer?.kind !== 'decider' || producer.entityId === undefined) {
    throw new Error('Expected a linked Decider producer.');
  }
  return {
    ...ir,
    entities: ir.entities.map((entity) =>
      entity.id === producer.entityId && entity.configuration?.mode === 'decider'
        ? {
            ...entity,
            configuration: { mode: 'decider', ...mutate(entity.configuration) },
          }
        : entity,
    ),
  };
}

function firstCondition(
  condition: LogicalDeciderCondition,
): Extract<LogicalDeciderCondition, { kind: 'compare' }> {
  if (condition.kind === 'compare') return condition;
  const child = condition.conditions[0];
  if (child === undefined) throw new Error('Expected a condition row.');
  return firstCondition(child);
}

describe('compiler-side canonical Decider import integration', () => {
  let fixture: ReturnType<typeof compileFixture>;

  beforeAll(() => {
    fixture = compileFixture();
  });

  test('assembles, compiles, associates, and verifies mixed physical Deciders', () => {
    expect(
      fixture.compilation.pipelineDiagnostics.filter(({ severity }) => severity === 'error'),
    ).toEqual([]);
    const resolved = fixture.compilation.resolvedCircuit;
    if (resolved === undefined) throw new Error('Expected ordinary compilation output.');
    const result = verify(fixture);
    expect(result.state, JSON.stringify(result.diagnostics)).toBe('verified');
    expect(result.entities.map(({ entityNumber }) => entityNumber)).toEqual([1, 2, 10, 11]);
    expect(result.networks).toHaveLength(fixture.assembled.correspondence.networks.length);
    const bridge = analyzeCanonicalBlueprintImport(
      fixture.analysis,
      fixture.selections,
      trustedEntityReplayContext,
    );
    if (bridge.state !== 'complete') throw new Error('Expected canonical bridge output.');
    for (const imported of bridge.networks) {
      const verified = result.networks.find(({ network }) => network === imported.network);
      const compiledNetwork = resolved.ir.networks.find(
        ({ id }) => id === verified?.compiledNetwork,
      );
      expect(compiledNetwork).toMatchObject({
        color: imported.component.color,
        fixedColor: imported.component.color,
      });
    }
    expect(resolved.ir.producers.map(({ kind }) => kind).sort()).toEqual([
      'arithmetic',
      'constant',
      'decider',
      'decider',
    ]);
    expect(fixture.assembled.correspondence.entities.map(({ family }) => family)).toEqual([
      'constant',
      'arithmetic',
      'decider',
      'decider',
    ]);

    const deciderProducer = resolved.ir.producers.find(
      (producer) => producer.kind === 'decider' && producer.entityId !== undefined,
    );
    expect(deciderProducer?.kind).toBe('decider');
    if (deciderProducer?.kind !== 'decider') throw new Error('Expected Decider producer.');
    expect(deciderProducer.config.condition.kind).toBe('or');
    expect(deciderProducer.config.outputs).toHaveLength(2);
    expect(deciderProducer.config.elseOutputs).toHaveLength(2);
    expect(deciderProducer.config.outputs[0]).toMatchObject({
      mode: 'copy',
      signal: { kind: 'wildcard', value: 'each' },
    });
    expect(deciderProducer.config.outputs[1]).toMatchObject({ mode: 'constant', value: 3 });

    const deciderEntities = resolved.ir.producers.filter((producer) => producer.kind === 'decider');
    for (const producer of deciderEntities) {
      if (producer.kind !== 'decider' || producer.entityId === undefined) {
        throw new Error('Every imported Decider must have a linked physical Entity.');
      }
      const physical = resolved.ir.entities.find(({ id }) => id === producer.entityId);
      expect(physical).toMatchObject({
        prototypeName: 'decider-combinator',
        configuration: { mode: 'decider', ...producer.config },
      });
      expect(physical?.placement).toBeDefined();
    }
    const outputless = fixture.assembled.correspondence.entities.find(
      ({ entityNumber }) => entityNumber === 11,
    );
    expect(outputless?.attachmentSpans).toEqual([]);
    const outputlessProducer = deciderEntities.find((producer) => {
      if (producer.kind !== 'decider' || producer.entityId === undefined) return false;
      const physical = resolved.ir.entities.find(({ id }) => id === producer.entityId);
      return physical?.placement?.x === 12;
    });
    expect(outputlessProducer?.kind).toBe('decider');
    if (outputlessProducer?.kind !== 'decider')
      throw new Error('Expected configured outputless Decider.');
    expect(firstCondition(outputlessProducer.config.condition).left).toMatchObject({
      kind: 'signal',
      refKind: 'single',
    });
  });

  test('verifier rejects Decider condition, row, signal-quality, and input-mask tampering', () => {
    const resolved = fixture.compilation.resolvedCircuit!;
    const cases: readonly [string, (config: DeciderProducerConfig) => DeciderProducerConfig][] = [
      [
        'comparator',
        (config) => {
          const replace = (condition: LogicalDeciderCondition): LogicalDeciderCondition => {
            if (condition.kind === 'compare') return { ...condition, comparator: '<' };
            return { ...condition, conditions: condition.conditions.map(replace) };
          };
          return { ...config, condition: replace(config.condition) };
        },
      ],
      [
        'right constant',
        (config) => {
          const replace = (condition: LogicalDeciderCondition): LogicalDeciderCondition => {
            if (condition.kind === 'compare') {
              return condition.right.kind === 'constant'
                ? { ...condition, right: { ...condition.right, value: 7 } }
                : condition;
            }
            return { ...condition, conditions: condition.conditions.map(replace) };
          };
          return { ...config, condition: replace(config.condition) };
        },
      ],
      ['ordered output rows', (config) => ({ ...config, outputs: [...config.outputs].reverse() })],
      [
        'ordered else-output rows',
        (config) => ({ ...config, elseOutputs: [...(config.elseOutputs ?? [])].reverse() }),
      ],
      [
        'else-output row count',
        (config) => ({ ...config, elseOutputs: (config.elseOutputs ?? []).slice(0, 1) }),
      ],
      [
        'output Signal quality',
        (config) => ({
          ...config,
          outputs: config.outputs.map((row, index) =>
            index === 1 && row.signal.kind === 'signal'
              ? {
                  ...row,
                  signal: { ...row.signal, signal: { ...row.signal.signal, quality: 'rare' } },
                }
              : row,
          ),
        }),
      ],
      [
        'input masks',
        (config) => {
          const trim = (condition: LogicalDeciderCondition): LogicalDeciderCondition => {
            if (condition.kind === 'compare') {
              if (condition.left.refKind === 'pair') {
                return {
                  ...condition,
                  left: {
                    kind: condition.left.kind,
                    ...(condition.left.kind === 'signal'
                      ? { signal: condition.left.signal }
                      : { value: condition.left.value }),
                    refKind: 'single',
                    network: condition.left.networks[0],
                  },
                } as LogicalDeciderCondition;
              }
              return condition;
            }
            return { ...condition, conditions: condition.conditions.map(trim) };
          };
          return { ...config, condition: trim(config.condition) };
        },
      ],
    ];
    for (const [label, mutate] of cases) {
      const compiled = withResolvedCircuit(fixture, (ir) => mutateDeciderConfiguration(ir, mutate));
      const result = verify(fixture, compiled);
      expect(result.state, label).toBe('blocked');
      expect(result.entities, label).toEqual([]);
      expect(result.networks, label).toEqual([]);
      expect(
        result.diagnostics.some(
          (diagnostic) => 'severity' in diagnostic && diagnostic.severity === 'error',
        ) ||
          result.diagnostics.some(
            (diagnostic) => diagnostic.category === 'source-verification-mismatch',
          ),
      ).toBe(true);
    }
    void resolved;
  });

  test('verifier blocks absent and undefined Decider copy-input and else-output state', () => {
    const mutateCopyInput = (config: DeciderProducerConfig, asUndefined: boolean) => ({
      ...config,
      outputs: config.outputs.map((row, index) => {
        if (index !== 0 || row.mode !== 'copy') return row;
        const changed = { ...row };
        if (asUndefined) {
          Object.defineProperty(changed, 'input', {
            value: undefined,
            enumerable: true,
            configurable: true,
          });
        } else {
          Reflect.deleteProperty(changed, 'input');
        }
        return changed;
      }),
    });
    const mutateElseOutputs = (config: DeciderProducerConfig, asUndefined: boolean) => {
      const changed = { ...config };
      if (asUndefined) {
        Object.defineProperty(changed, 'elseOutputs', {
          value: undefined,
          enumerable: true,
          configurable: true,
        });
      } else {
        Reflect.deleteProperty(changed, 'elseOutputs');
      }
      return changed;
    };
    const cases: readonly [string, (ir: NativeCircuitIr) => NativeCircuitIr][] = [
      [
        'producer copy input absent',
        (ir) => mutateDeciderConfiguration(ir, (config) => mutateCopyInput(config, false)),
      ],
      [
        'producer copy input undefined',
        (ir) => mutateDeciderConfiguration(ir, (config) => mutateCopyInput(config, true)),
      ],
      [
        'producer else branch absent',
        (ir) => mutateDeciderConfiguration(ir, (config) => mutateElseOutputs(config, false)),
      ],
      [
        'producer else branch undefined',
        (ir) => mutateDeciderConfiguration(ir, (config) => mutateElseOutputs(config, true)),
      ],
      [
        'linked physical copy input undefined',
        (ir) =>
          mutateLinkedDeciderPhysicalConfiguration(ir, (config) => mutateCopyInput(config, true)),
      ],
      [
        'linked physical else branch undefined',
        (ir) =>
          mutateLinkedDeciderPhysicalConfiguration(ir, (config) => mutateElseOutputs(config, true)),
      ],
    ];

    for (const [label, transform] of cases) {
      const result = verify(fixture, withResolvedCircuit(fixture, transform));
      expect(result.state, label).toBe('blocked');
      expect(result.entities, label).toEqual([]);
      expect(result.networks, label).toEqual([]);
    }
  });

  test('verifier rejects linked Decider configuration, prototype, placement, and endpoint tampering', () => {
    const baseline = fixture.compilation.resolvedCircuit!;
    const deciderProducer = baseline.ir.producers.find((producer) => producer.kind === 'decider');
    if (
      deciderProducer?.kind !== 'decider' ||
      deciderProducer.entityId === undefined ||
      deciderProducer.config.outputs.length !== 2
    ) {
      throw new Error('Expected linked Decider producer.');
    }
    const physical = baseline.ir.entities.find(({ id }) => id === deciderProducer.entityId)!;

    const transforms: readonly [string, (ir: NativeCircuitIr) => NativeCircuitIr][] = [
      [
        'physical configuration',
        (ir) => ({
          ...ir,
          entities: ir.entities.map((entity) =>
            entity.id === physical.id && entity.configuration?.mode === 'decider'
              ? {
                  ...entity,
                  configuration: { ...entity.configuration, outputs: [] },
                }
              : entity,
          ),
        }),
      ],
      [
        'prototype',
        (ir) => ({
          ...ir,
          entities: ir.entities.map((entity) =>
            entity.id === physical.id
              ? { ...entity, prototypeName: 'arithmetic-combinator' }
              : entity,
          ),
        }),
      ],
      [
        'placement',
        (ir) => ({
          ...ir,
          entities: ir.entities.map((entity) =>
            entity.id === physical.id && entity.placement !== undefined
              ? { ...entity, placement: { ...entity.placement, x: entity.placement.x + 1 } }
              : entity,
          ),
        }),
      ],
      [
        'color-separated endpoint partition',
        (ir) => {
          const bridge = analyzeCanonicalBlueprintImport(
            fixture.analysis,
            fixture.selections,
            trustedEntityReplayContext,
          );
          if (bridge.state !== 'complete') throw new Error('Expected the imported bridge.');
          const importedMainDecider = bridge.entities.find(
            (entity) => entity.entityNumber === 10 && entity.family === 'decider',
          );
          if (
            importedMainDecider?.family !== 'decider' ||
            importedMainDecider.outputNetworks.green === undefined
          ) {
            throw new Error('Expected the main Decider green output Network.');
          }
          const correspondence = fixture.assembled.correspondence.networks.find(
            ({ network }) => network === importedMainDecider.outputNetworks.green,
          );
          const compiledNetwork = ir.networks.find(({ name }) => name === correspondence?.name);
          if (compiledNetwork === undefined)
            throw new Error('Expected the compiled green output Network.');
          const outputlessCorrespondence = fixture.assembled.correspondence.entities.find(
            ({ entityNumber }) => entityNumber === 11,
          );
          if (outputlessCorrespondence === undefined)
            throw new Error('Expected outputless Decider correspondence.');
          const outputlessProducer = ir.producers.find(
            (producer) =>
              producer.kind === 'decider' &&
              producer.provenance.source?.start === outputlessCorrespondence.constructionSpan.start,
          );
          if (outputlessProducer?.kind !== 'decider')
            throw new Error('Expected outputless Decider producer.');
          return {
            ...ir,
            producers: ir.producers.map((producer) =>
              producer.id === outputlessProducer.id && producer.kind === 'decider'
                ? { ...producer, destinations: [...producer.destinations, compiledNetwork.id] }
                : producer,
            ),
          };
        },
      ],
    ];
    for (const [label, transform] of transforms) {
      const result = verify(fixture, withResolvedCircuit(fixture, transform));
      expect(result.state, label).toBe('blocked');
      expect(result.entities, label).toEqual([]);
      expect(result.networks, label).toEqual([]);
      if (label === 'color-separated endpoint partition') {
        expect(result.diagnostics).toContainEqual(
          expect.objectContaining({
            category: 'source-verification-mismatch',
            path: '$.nativeProjection.networks',
          }),
        );
      }
    }
  });

  test('refuses source-unrepresentable Decider output without returning partial artifacts', () => {
    const raw = JSON.parse(inputDocument) as {
      blueprint: { entities: Record<string, unknown>[]; wires: unknown[] };
    };
    const target = raw.blueprint.entities.find(({ entity_number }) => entity_number === 10)!;
    target.control_behavior = {
      decider_conditions: {
        conditions: deciderBehavior().decider_conditions.conditions,
        outputs: [{ signal: { name: 'signal-A' }, copy_count_from_input: true }],
      },
    };
    const analysis = analyzeBlueprintImport(
      classifyBlueprintDocument(parseLosslessJson(JSON.stringify(raw))),
    );
    const selections = (analysis.entities ?? []).map(({ entityNumber, name }) => ({
      entityNumber,
      profile: profiles.find(({ prototypeType }) => prototypeType === name)!.ref,
    }));
    const result = generateCanonicalBlueprintSource(
      analysis,
      selections,
      trustedEntityReplayContext,
      { path: 'unrepresentable-decider.factorio.ts' },
    );
    expect(result.state).toBe('blocked');
    expect(result.source).toBeUndefined();
    expect(result.correspondence).toBeUndefined();
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        category: 'unsupported-source-configuration',
        path: '$.blueprint.entities[2].control_behavior.decider_conditions.outputs[0]',
      }),
    );
  });

  test('rejects a stale source snapshot before creating any associations', () => {
    const stale = {
      ...fixture.assembled,
      source: { ...fixture.assembled.source, text: `${fixture.assembled.source.text}// stale` },
    };
    const result = verify(fixture, fixture.compiled, stale);
    expect(result.state).toBe('blocked');
    expect(result.entities).toEqual([]);
    expect(result.networks).toEqual([]);
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({ category: 'source-verification-mismatch', path: '$.source.text' }),
    );
  });

  test('rejects stale constructor correspondence before creating associations', () => {
    const stale = {
      ...fixture.assembled,
      correspondence: {
        ...fixture.assembled.correspondence,
        entities: fixture.assembled.correspondence.entities.map((entity) =>
          entity.entityNumber === 10 ? { ...entity, family: 'arithmetic' as const } : entity,
        ),
      },
    };
    const result = verify(fixture, fixture.compiled, stale);
    expect(result.state).toBe('blocked');
    expect(result.entities).toEqual([]);
    expect(result.networks).toEqual([]);
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        category: 'source-verification-mismatch',
        path: '$.blueprint.entities[2]',
      }),
    );
  });
});

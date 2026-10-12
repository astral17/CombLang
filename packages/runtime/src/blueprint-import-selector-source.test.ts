import { parseLosslessJson } from '@comblang/blueprint/document';
import { generateBlueprintJson } from '@comblang/compiler/blueprint-json';
import { syntheticZeroPortEntityProfile } from '@comblang/compiler/entity-fixtures';
import { createTrustedEntityReplayContext } from '@comblang/compiler/entity-replay-context';
import type { EntityProfile } from '@comblang/compiler/entity';
import { printBlueprintSelectorExpression } from '@comblang/compiler/blueprint-import-source';
import type { LogicalNetworkRef, SelectorProducerConfig } from '@comblang/compiler/ir';
import type { EntityPrototype } from '@comblang/prototypes';
import type { NetworkId } from '@comblang/shared';
import { describe, expect, test } from 'vitest';

import { decodeBlueprintSelectorControlBehavior } from '../../compiler/src/blueprint-import-selector.js';
import type { EntityPrototypeResolver } from './entity-registry.js';
import { compileSourceProgram } from './source-compilation.js';

const sourceRed = 'network:source-selector-red' as NetworkId;
const sourceGreen = 'network:source-selector-green' as NetworkId;
const compiledRed = 'network:1' as NetworkId;
const compiledGreen = 'network:2' as NetworkId;

function trustedSelectorEnvironment() {
  const profile: EntityProfile = {
    ...structuredClone(syntheticZeroPortEntityProfile),
    ref: {
      ...syntheticZeroPortEntityProfile.ref,
      prototypeKey: 'entity:selector-combinator',
      profileId: 'profile:blueprint-import-selector-source' as EntityProfile['ref']['profileId'],
    },
    prototypeType: 'selector-combinator',
  };
  const context = createTrustedEntityReplayContext({
    database: profile.ref.database,
    source: 'synthetic',
    evidenceIdentity: 'blueprint-import-selector-source-evidence',
    policyIdentity: 'blueprint-import-selector-source-policy',
    profiles: [profile],
  });
  const prototype: EntityPrototype = {
    key: 'entity:selector-combinator',
    name: 'selector-combinator',
    type: 'selector-combinator',
    tileWidth: 1,
    tileHeight: 1,
  };
  const entityPrototypeResolver: EntityPrototypeResolver = {
    database: context.database,
    getEntity(nameOrKey) {
      return nameOrKey === prototype.key || nameOrKey === prototype.name ? prototype : undefined;
    },
  };
  return { trustedEntityReplayContext: context, entityPrototypeResolver };
}

function remapNetwork(network: NetworkId): NetworkId {
  if (network === sourceRed) return compiledRed;
  if (network === sourceGreen) return compiledGreen;
  throw new Error(`Unexpected Selector input Network ${network}.`);
}

function remapConfiguration(configuration: SelectorProducerConfig): SelectorProducerConfig {
  const input: LogicalNetworkRef =
    configuration.input.refKind === 'single'
      ? { refKind: 'single', network: remapNetwork(configuration.input.network) }
      : {
          refKind: 'pair',
          networks: [
            remapNetwork(configuration.input.networks[0]),
            remapNetwork(configuration.input.networks[1]),
          ],
        };
  return { ...configuration, input };
}

const roundTripCases: readonly {
  readonly label: string;
  readonly behavior: Record<string, unknown>;
  readonly input: LogicalNetworkRef;
}[] = [
  {
    label: 'Select numeric index on one input',
    behavior: { operation: 'select', select_max: false, index_constant: -2_147_483_648 },
    input: { refKind: 'single', network: sourceRed },
  },
  {
    label: 'Select quality-bearing Signal index on a reversed input pair',
    behavior: {
      operation: 'select',
      select_max: true,
      index_signal: { type: 'virtual', name: 'signal-index', quality: 'rare' },
    },
    input: { refKind: 'pair', networks: [sourceGreen, sourceRed] },
  },
  {
    label: 'Count with explicitly present normal quality',
    behavior: {
      operation: 'count',
      count_signal: { name: 'iron-plate', quality: 'normal' },
    },
    input: { refKind: 'single', network: sourceGreen },
  },
  {
    label: 'Count over a two-Network input',
    behavior: {
      operation: 'count',
      count_signal: { type: 'fluid', name: 'water', quality: 'uncommon' },
    },
    input: { refKind: 'pair', networks: [sourceRed, sourceGreen] },
  },
];

describe('blueprint Selector import source expressions', () => {
  test.each(roundTripCases)(
    'decodes, prints, compiles, and emits $label through the canonical source pipeline',
    ({ behavior, input }) => {
      const decoded = decodeBlueprintSelectorControlBehavior(
        parseLosslessJson(JSON.stringify(behavior)),
        input,
      );
      expect(decoded.state).toBe('complete');
      if (decoded.state !== 'complete') throw new Error(decoded.diagnostics[0]?.message);

      const expression = printBlueprintSelectorExpression(decoded.configuration, [
        sourceRed,
        sourceGreen,
      ]);
      const source = `const import_network_1 = new Network<R>();
const import_network_2 = new Network<G>();
const output = new Network();
output += ${expression};`;
      const compilation = compileSourceProgram(
        { path: 'blueprint-import-selector-source.factorio.ts', text: source },
        trustedSelectorEnvironment(),
      );
      expect(compilation.compilerDiagnostics).toEqual([]);
      expect(compilation.pipelineDiagnostics).toEqual([]);
      const resolved = compilation.resolvedCircuit;
      if (resolved === undefined) {
        throw new Error('Expected canonical Selector source compilation to resolve.');
      }
      expect(resolved.ir.producers.map(({ kind }) => kind)).toEqual(['selector']);
      const producer = resolved.ir.producers[0];
      if (producer?.kind !== 'selector') throw new Error('Expected one Selector producer.');
      expect(producer.config).toEqual(remapConfiguration(decoded.configuration));
      expect(producer.destinations).toHaveLength(1);

      const colors = new Map(resolved.ir.networks.map(({ id, color }) => [id, color]));
      expect(colors.get(compiledRed)).toBe('red');
      expect(colors.get(compiledGreen)).toBe('green');
      const inputIds =
        producer.config.input.refKind === 'single'
          ? [producer.config.input.network]
          : [...producer.config.input.networks];
      expect(inputIds).toEqual(
        decoded.configuration.input.refKind === 'single'
          ? [remapNetwork(decoded.configuration.input.network)]
          : decoded.configuration.input.networks.map(remapNetwork),
      );

      expect(producer.entityId).toBeDefined();
      const linkedEntity = resolved.ir.entities.find(({ id }) => id === producer.entityId);
      expect(linkedEntity?.configuration?.mode).toBe('selector');
      expect(linkedEntity?.configuration).toEqual({ mode: 'selector', ...producer.config });

      const entities = generateBlueprintJson(resolved.ir).blueprint.entities;
      expect(entities).toHaveLength(1);
      expect(entities[0]?.name).toBe('selector-combinator');
      expect(entities[0]?.control_behavior).toEqual(behavior);
    },
  );

  test('retains the decoded negative-zero witness but refuses source normalization', () => {
    const decoded = decodeBlueprintSelectorControlBehavior(
      parseLosslessJson('{"operation":"select","select_max":false,"index_constant":-0}'),
      { refKind: 'single', network: sourceRed },
    );
    expect(decoded.state).toBe('complete');
    if (decoded.state !== 'complete' || decoded.configuration.operation !== 'select') return;
    expect(Object.is(decoded.configuration.index, -0)).toBe(true);
    expect(() =>
      printBlueprintSelectorExpression(decoded.configuration, [sourceRed, sourceGreen]),
    ).toThrow(TypeError);
  });
});

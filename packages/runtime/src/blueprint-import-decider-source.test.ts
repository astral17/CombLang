import {
  createTrustedEntityReplayContext,
  generateBlueprintJson,
  syntheticZeroPortEntityProfile,
} from '@comblang/compiler';
import type { EntityProfile } from '@comblang/compiler/entity';
import { parseLosslessJson } from '@comblang/blueprint/document';
import type { EntityPrototype } from '@comblang/prototypes';
import type { NetworkId } from '@comblang/shared';
import { describe, expect, test } from 'vitest';

import { decodeBlueprintDeciderControlBehavior } from '../../compiler/src/blueprint-import-decider.js';
import { printBlueprintDeciderExpression } from '../../compiler/src/blueprint-import-source.js';
import type { DeciderProducerConfig } from '../../compiler/src/ir.js';
import { compileSourceProgram } from './source-compilation.js';
import type { EntityPrototypeResolver } from './entity-registry.js';

const sourceRed = 'network:source-decider-red' as NetworkId;
const sourceGreen = 'network:source-decider-green' as NetworkId;
const compiledRed = 'network:1' as NetworkId;
const compiledGreen = 'network:2' as NetworkId;

type NativeMask = { red: boolean; green: boolean };
type NativeRow = Record<string, unknown>;
interface NativeBehavior {
  readonly decider_conditions: {
    readonly conditions: readonly NativeRow[];
    readonly outputs: readonly NativeRow[];
    readonly else_outputs?: readonly NativeRow[];
  };
}

function trustedDeciderEnvironment() {
  const profile: EntityProfile = {
    ...structuredClone(syntheticZeroPortEntityProfile),
    ref: {
      ...syntheticZeroPortEntityProfile.ref,
      prototypeKey: 'entity:decider-combinator',
      profileId: 'profile:blueprint-import-decider-source' as EntityProfile['ref']['profileId'],
    },
    prototypeType: 'decider-combinator',
  };
  const context = createTrustedEntityReplayContext({
    database: profile.ref.database,
    source: 'synthetic',
    evidenceIdentity: 'blueprint-import-decider-source-evidence',
    policyIdentity: 'blueprint-import-decider-source-policy',
    profiles: [profile],
  });
  const prototype: EntityPrototype = {
    key: 'entity:decider-combinator',
    name: 'decider-combinator',
    type: 'decider-combinator',
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

function remappedMask(
  mask: NativeMask,
  colors: ReadonlyMap<NetworkId, 'red' | 'green'>,
): NativeMask {
  const result: NativeMask = { red: false, green: false };
  if (mask.red) {
    const color = colors.get(compiledRed);
    if (color === undefined) throw new Error('Compiled red source Network has no color.');
    result[color] = true;
  }
  if (mask.green) {
    const color = colors.get(compiledGreen);
    if (color === undefined) throw new Error('Compiled green source Network has no color.');
    result[color] = true;
  }
  return result;
}

function remapBehaviorMasks(
  behavior: NativeBehavior,
  colors: ReadonlyMap<NetworkId, 'red' | 'green'>,
) {
  const remapRows = (rows: readonly NativeRow[]): NativeRow[] =>
    rows.map((row) => ({
      ...row,
      ...(row.first_signal_networks === undefined
        ? {}
        : { first_signal_networks: remappedMask(row.first_signal_networks as NativeMask, colors) }),
      ...(row.second_signal_networks === undefined
        ? {}
        : {
            second_signal_networks: remappedMask(row.second_signal_networks as NativeMask, colors),
          }),
      ...(row.networks === undefined
        ? {}
        : { networks: remappedMask(row.networks as NativeMask, colors) }),
    }));
  return {
    conditions: remapRows(behavior.decider_conditions.conditions),
    outputs: remapRows(behavior.decider_conditions.outputs),
    ...(behavior.decider_conditions.else_outputs === undefined
      ? {}
      : { else_outputs: remapRows(behavior.decider_conditions.else_outputs) }),
  };
}

function remapNetworkIds(value: unknown): unknown {
  if (value === sourceRed) return compiledRed;
  if (value === sourceGreen) return compiledGreen;
  if (Array.isArray(value)) return value.map(remapNetworkIds);
  if (typeof value !== 'object' || value === null) return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, child]) => [key, remapNetworkIds(child)]),
  );
}

const fixtures: readonly { readonly label: string; readonly behavior: NativeBehavior }[] = [
  {
    label: 'ordered Each OR-of-AND conditions and both output branches',
    behavior: {
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
            second_signal: { type: 'fluid', name: 'water', quality: 'uncommon' },
            second_signal_networks: { red: false, green: true },
            compare_type: 'and',
          },
          {
            first_signal: { type: 'virtual', name: 'signal-B' },
            first_signal_networks: { red: false, green: true },
            comparator: '≠',
            constant: -1,
            compare_type: 'or',
          },
        ],
        outputs: [
          {
            signal: { type: 'virtual', name: 'signal-each' },
            copy_count_from_input: true,
            networks: { red: true, green: true },
          },
          {
            signal: { type: 'fluid', name: 'water', quality: 'rare' },
            copy_count_from_input: true,
            networks: { red: false, green: true },
          },
          {
            signal: { name: 'iron-plate', quality: 'uncommon' },
            copy_count_from_input: false,
            constant: -3,
          },
          {
            signal: { type: 'virtual', name: 'signal-each' },
            copy_count_from_input: false,
            constant: 2,
          },
        ],
        else_outputs: [
          {
            signal: { type: 'virtual', name: 'signal-output', quality: 'legendary' },
            copy_count_from_input: true,
            networks: { red: true, green: false },
          },
          {
            signal: { type: 'virtual', name: 'signal-output', quality: 'legendary' },
            copy_count_from_input: false,
            constant: 4,
          },
        ],
      },
    },
  },
  {
    label: 'Anything comparison and wildcard outputs',
    behavior: {
      decider_conditions: {
        conditions: [
          {
            first_signal: { type: 'virtual', name: 'signal-anything' },
            first_signal_networks: { red: true, green: true },
            comparator: '≤',
            constant: 7,
            compare_type: 'and',
          },
        ],
        outputs: [
          {
            signal: { type: 'virtual', name: 'signal-anything' },
            copy_count_from_input: true,
            networks: { red: true, green: true },
          },
          {
            signal: { name: 'copper-plate' },
            copy_count_from_input: false,
            constant: 1,
          },
        ],
        else_outputs: [
          {
            signal: { type: 'virtual', name: 'signal-everything' },
            copy_count_from_input: true,
            networks: { red: false, green: true },
          },
        ],
      },
    },
  },
  {
    label: 'Everything comparison and output',
    behavior: {
      decider_conditions: {
        conditions: [
          {
            first_signal: { type: 'virtual', name: 'signal-everything' },
            first_signal_networks: { red: true, green: true },
            comparator: '<',
            constant: 5,
            compare_type: 'and',
          },
        ],
        outputs: [
          {
            signal: { type: 'virtual', name: 'signal-everything' },
            copy_count_from_input: true,
            networks: { red: true, green: true },
          },
          {
            signal: { type: 'virtual', name: 'signal-output' },
            copy_count_from_input: false,
            constant: 0,
          },
        ],
      },
    },
  },
];

describe('blueprint Decider import source expressions', () => {
  test.each(fixtures)(
    'round-trips $label through canonical source compilation and emitter',
    ({ behavior }) => {
      const decoded = decodeBlueprintDeciderControlBehavior(
        parseLosslessJson(JSON.stringify(behavior)),
        { red: sourceRed, green: sourceGreen },
      );
      expect(decoded.state).toBe('complete');
      if (decoded.state !== 'complete') throw new Error(decoded.diagnostics[0]?.message);

      const expression = printBlueprintDeciderExpression(decoded.configuration, [
        sourceRed,
        sourceGreen,
      ]);
      const source = `const import_network_1 = new Network<R>();
const import_network_2 = new Network<G>();
const output = new Network();
output += ${expression};`;
      const compilation = compileSourceProgram(
        { path: 'blueprint-import-decider-source.factorio.ts', text: source },
        trustedDeciderEnvironment(),
      );
      expect(compilation.pipelineDiagnostics).toEqual([]);
      const resolved = compilation.resolvedCircuit;
      if (resolved === undefined)
        throw new Error('Expected canonical source compilation to resolve.');
      expect(resolved.ir.producers.map(({ kind }) => kind)).toEqual(['decider']);
      const producer = resolved.ir.producers[0];
      if (producer?.kind !== 'decider') throw new Error('Expected one emitted Decider producer.');
      expect(producer.config).toEqual(remapNetworkIds(decoded.configuration));

      const colors = new Map(resolved.ir.networks.map(({ id, color }) => [id, color]));
      expect(colors.get(compiledRed)).toBe('red');
      expect(colors.get(compiledGreen)).toBe('green');
      const entities = generateBlueprintJson(resolved.ir).blueprint.entities;
      expect(entities).toHaveLength(1);
      expect(entities[0]?.name).toBe('decider-combinator');
      const controlBehavior = entities[0]?.control_behavior as {
        decider_conditions: {
          conditions: readonly NativeRow[];
          outputs: readonly NativeRow[];
          else_outputs?: readonly NativeRow[];
        };
      };
      expect(controlBehavior.decider_conditions).toEqual(remapBehaviorMasks(behavior, colors));
    },
  );
});

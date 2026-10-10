import { Signal } from '@comblang/factorio';
import { generateBlueprintJson } from '@comblang/compiler/blueprint-json';
import {
  createTrustedEntityReplayContext,
  type TrustedEntityReplayContext,
} from '@comblang/compiler/entity-replay-context';
import { syntheticZeroPortEntityProfile } from '@comblang/compiler/entity-fixtures';
import type { EntityProfile } from '@comblang/compiler/entity';
import {
  printBlueprintArithmeticExpression,
  printBlueprintConstantExpression,
} from '@comblang/compiler/blueprint-import-source';
import type { ArithmeticProducerConfig } from '@comblang/compiler/ir';
import type { EntityPrototype } from '@comblang/prototypes';
import type { NetworkId } from '@comblang/shared';
import { describe, expect, test } from 'vitest';

import type { ConstantConfiguration } from '@comblang/factorio';
import type { EntityPrototypeResolver } from './entity-registry.js';
import { compileSourceProgram } from './source-compilation.js';

function trustedCanonicalHost(): {
  readonly trustedEntityReplayContext: TrustedEntityReplayContext;
  readonly entityPrototypeResolver: EntityPrototypeResolver;
} {
  const families = [
    ['constant-combinator', 'constant-combinator'],
    ['arithmetic-combinator', 'arithmetic-combinator'],
  ] as const;
  const profiles = families.map(([name, prototypeType], index) => ({
    ...syntheticZeroPortEntityProfile,
    prototypeType,
    ref: {
      ...syntheticZeroPortEntityProfile.ref,
      prototypeKey: `entity:${name}` as EntityProfile['ref']['prototypeKey'],
      profileId: `profile:blueprint-import-source-${index}` as EntityProfile['ref']['profileId'],
    },
  }));
  const prototypes = families.map(([name, type]) => ({
    key: `entity:${name}`,
    name,
    type,
  })) as EntityPrototype[];
  const trustedEntityReplayContext = createTrustedEntityReplayContext({
    database: profiles[0]!.ref.database,
    source: 'synthetic',
    evidenceIdentity: 'blueprint-import-source-test-evidence',
    policyIdentity: 'blueprint-import-source-test-policy',
    profiles,
  });
  const entityPrototypeResolver: EntityPrototypeResolver = {
    database: profiles[0]!.ref.database,
    getEntity(nameOrKey) {
      return prototypes.find(({ key, name }) => nameOrKey === key || nameOrKey === name);
    },
  };
  return { trustedEntityReplayContext, entityPrototypeResolver };
}

const red = 'network:source-import-red' as NetworkId;
const green = 'network:source-import-green' as NetworkId;

function compiledNetwork(network: NetworkId): NetworkId {
  if (network === red) return 'network:1' as NetworkId;
  if (network === green) return 'network:2' as NetworkId;
  throw new Error(`Unexpected source Network ID ${network}.`);
}

function compiledOperand(
  operand: ArithmeticProducerConfig['left'],
): ArithmeticProducerConfig['left'] {
  if (operand.kind === 'constant') return operand;
  if (operand.refKind === 'single') {
    return { ...operand, network: compiledNetwork(operand.network) };
  }
  return {
    ...operand,
    networks: [compiledNetwork(operand.networks[0]), compiledNetwork(operand.networks[1])],
  };
}

describe('blueprint import source expression compilation', () => {
  test('compiles literal Constant and Arithmetic expressions into one producer each', () => {
    const constantConfiguration: ConstantConfiguration = {
      isOn: false,
      sections: [
        {
          active: true,
          group: 'imported "group"',
          multiplier: 0.5,
          filters: [{ signal: Signal('fluid', 'water', 'uncommon'), value: 0 }],
        },
      ],
    };
    const constantExpression = printBlueprintConstantExpression(constantConfiguration);
    const arithmeticConfigurations: ArithmeticProducerConfig[] = [
      {
        left: { kind: 'constant', value: -2_147_483_648 },
        operation: 'add',
        right: { kind: 'constant', value: 2_147_483_647 },
        output: { kind: 'signal', signal: Signal('virtual', 'signal-result', 'legendary') },
      },
      {
        left: {
          kind: 'signal',
          signal: Signal('virtual', 'signal-A', 'rare'),
          refKind: 'single',
          network: red,
        },
        operation: 'bit-xor',
        right: {
          kind: 'signal',
          signal: Signal('fluid', 'water', 'uncommon'),
          refKind: 'single',
          network: green,
        },
        output: { kind: 'signal', signal: Signal('virtual', 'signal-output') },
      },
      {
        left: { kind: 'each', refKind: 'single', network: red },
        operation: 'add',
        right: { kind: 'constant', value: 2 },
        output: { kind: 'each' },
      },
      {
        left: { kind: 'each', refKind: 'pair', networks: [red, green] },
        operation: 'multiply',
        right: { kind: 'constant', value: 3 },
        output: { kind: 'each' },
      },
    ];
    const arithmeticExpressions = arithmeticConfigurations.map((configuration) =>
      printBlueprintArithmeticExpression(configuration, [red, green]),
    );
    const text = `const import_network_1 = new Network();
const import_network_2 = new Network();
const output = new Network();
output += ${constantExpression};
${arithmeticExpressions.map((expression) => `output += ${expression};`).join('\n')}`;

    const compilation = compileSourceProgram(
      { path: 'blueprint-import-expressions.factorio.ts', text },
      trustedCanonicalHost(),
    );

    expect(compilation.pipelineDiagnostics).toEqual([]);
    const resolved = compilation.resolvedCircuit;
    if (resolved === undefined) throw new Error('Expected ordinary source compilation to resolve.');
    expect(resolved.ir.producers.map(({ kind }) => kind)).toEqual([
      'constant',
      'arithmetic',
      'arithmetic',
      'arithmetic',
      'arithmetic',
    ]);
    expect(resolved.ir.producers[0]).toMatchObject({
      kind: 'constant',
      config: { configuration: constantConfiguration },
    });
    expect(resolved.ir.producers.slice(1).map(({ config }) => config)).toEqual(
      arithmeticConfigurations.map((configuration) => ({
        ...configuration,
        left: compiledOperand(configuration.left),
        right: compiledOperand(configuration.right),
      })),
    );

    const entities = generateBlueprintJson(resolved.ir).blueprint.entities;
    expect(entities.map(({ name }) => name)).toEqual([
      'constant-combinator',
      'arithmetic-combinator',
      'arithmetic-combinator',
      'arithmetic-combinator',
      'arithmetic-combinator',
    ]);
    const constantBehavior = entities[0]?.control_behavior as {
      is_on: boolean;
      sections: {
        sections: readonly { group?: string; multiplier: number; filters: readonly unknown[] }[];
      };
    };
    expect(constantBehavior).toMatchObject({
      is_on: false,
      sections: { sections: [{ group: 'imported "group"', multiplier: 0.5 }] },
    });
    expect(constantBehavior.sections.sections[0]?.filters).toHaveLength(1);

    const constantOnlyArithmetic = entities[1]?.control_behavior as {
      arithmetic_conditions: Record<string, unknown>;
    };
    expect(constantOnlyArithmetic.arithmetic_conditions).toMatchObject({
      first_constant: -2_147_483_648,
      operation: '+',
      second_constant: 2_147_483_647,
      output_signal: { type: 'virtual', name: 'signal-result', quality: 'legendary' },
    });

    const separatedInputs = entities[2]?.control_behavior as {
      arithmetic_conditions: Record<string, unknown>;
    };
    const conditions = separatedInputs.arithmetic_conditions;
    expect(conditions).toMatchObject({
      first_signal: { type: 'virtual', name: 'signal-A', quality: 'rare' },
      second_signal: { type: 'fluid', name: 'water', quality: 'uncommon' },
    });
    const firstMask = conditions.first_signal_networks as { red: boolean; green: boolean };
    const secondMask = conditions.second_signal_networks as { red: boolean; green: boolean };
    expect([firstMask.red, firstMask.green].filter(Boolean)).toHaveLength(1);
    expect([secondMask.red, secondMask.green].filter(Boolean)).toHaveLength(1);
    expect(firstMask).not.toEqual(secondMask);

    const eachEntities = entities
      .slice(3)
      .map(
        (entity) => entity.control_behavior as { arithmetic_conditions: Record<string, unknown> },
      );
    expect(eachEntities).toHaveLength(2);
    expect(eachEntities.map(({ arithmetic_conditions }) => arithmetic_conditions)).toEqual([
      expect.objectContaining({
        first_signal: { type: 'virtual', name: 'signal-each' },
        output_signal: { type: 'virtual', name: 'signal-each' },
      }),
      expect.objectContaining({
        first_signal: { type: 'virtual', name: 'signal-each' },
        output_signal: { type: 'virtual', name: 'signal-each' },
      }),
    ]);
  });
});

import { generateBlueprintJson } from '@comblang/compiler/blueprint-json';
import { signal, SparseBus } from '@comblang/factorio';
import { describe, expect, test } from 'vitest';

import { compileSourceProgram } from './source-compilation.js';
import { hydrateResolvedCircuit } from './resolved-circuit.js';

const lookupSource = {
  path: 'generated-lookup.factorio.ts',
  text: `const KEY = Signal("virtual", "signal-key");
const VALUE = Signal("virtual", "signal-value");
const source = new Network();
function Lookup(input: Readonly<Network>): Network {
  const keys = [10, 20, 30];
  let member = input[KEY] === keys[0];
  for (const key of keys.slice(1)) member = member || input[KEY] === key;
  return IF(member, [100 * VALUE, 103 * VALUE]);
}
const result = Lookup(source);`,
} as const;

const lookupContract = {
  inputSignal: signal('virtual', 'signal-key'),
  outputSignal: signal('virtual', 'signal-value'),
  keys: [10, 20, 30],
  outputRows: [100, 103],
  presentKey: 20,
  presentValue: 203,
  missingKey: 99,
  missingValue: 0,
  physicalDeviceCount: 1,
  modelLatencyTicks: 1,
} as const;

describe('generated lookup fixture', () => {
  test('compiles ordinary helper-loop lookup into an explicit Decider inventory', () => {
    const compilation = compileSourceProgram(lookupSource);

    expect(compilation.pipelineDiagnostics).toEqual([]);
    if (compilation.plan === undefined || compilation.resolvedCircuit === undefined) {
      throw new Error('Expected the generated lookup fixture to compile.');
    }

    const canonicalProducerCount = compilation.resolvedCircuit.ir.producers.length;
    const deciders = compilation.plan.producers.filter((producer) => producer.kind === 'decider');
    expect(deciders).toHaveLength(canonicalProducerCount);
    expect(compilation.plan.networks).toHaveLength(canonicalProducerCount + 1);
    expect(generateBlueprintJson(compilation.resolvedCircuit.ir).blueprint.entities).toHaveLength(
      canonicalProducerCount,
    );
    expect(canonicalProducerCount).toBe(lookupContract.physicalDeviceCount);

    expect(lookupContract).toMatchObject({
      inputSignal: { type: 'virtual', name: 'signal-key' },
      outputSignal: { type: 'virtual', name: 'signal-value' },
      presentValue: 203,
      missingValue: 0,
      modelLatencyTicks: 1,
    });
    expect(lookupContract.keys).toEqual([10, 20, 30]);
    expect(lookupContract.outputRows).toEqual([100, 103]);
  });

  test('keeps the synthetic model, ordered rows, and blueprint in agreement', () => {
    // Synthetic fixture: this proves CombLang structure and deterministic model behavior,
    // not native Factorio equivalence.
    const compilation = compileSourceProgram(lookupSource);

    expect(compilation.pipelineDiagnostics).toEqual([]);
    if (
      compilation.plan === undefined ||
      compilation.resolvedCircuit === undefined ||
      compilation.execution === undefined
    ) {
      throw new Error('Expected the generated lookup fixture to lower and execute.');
    }

    const { execution } = compilation;
    const input = execution.network('source');
    const output = execution.network(compilation.plan.networks[1]!.name);
    const readLookup = (key: number): number => {
      const session = execution.createTestSession();
      session.drive(input, [[lookupContract.inputSignal, key]]).tick();
      expect(session.read(output).get(lookupContract.outputSignal)).toBe(0);
      session.tick();
      return session.read(output).get(lookupContract.outputSignal);
    };

    expect(readLookup(10)).toBe(lookupContract.presentValue);
    expect(readLookup(20)).toBe(lookupContract.presentValue);
    expect(readLookup(30)).toBe(lookupContract.presentValue);
    expect(readLookup(lookupContract.missingKey)).toBe(lookupContract.missingValue);

    const producers = compilation.resolvedCircuit.ir.producers;
    expect(producers).toHaveLength(lookupContract.physicalDeviceCount);
    const decider = producers[0];
    expect(decider?.kind).toBe('decider');
    if (decider?.kind !== 'decider') throw new Error('Expected one generated Decider.');
    expect(
      decider.config.outputs.map((output) =>
        output.mode === 'constant' ? output.value : undefined,
      ),
    ).toEqual(lookupContract.outputRows);

    const entities = generateBlueprintJson(compilation.resolvedCircuit.ir).blueprint.entities;
    expect(entities).toHaveLength(lookupContract.physicalDeviceCount);
    const conditions = entities[0]?.control_behavior as {
      decider_conditions: { outputs: Array<Record<string, unknown>> };
    };
    expect(conditions.decider_conditions.outputs).toEqual([
      {
        signal: { type: 'virtual', name: 'signal-value' },
        copy_count_from_input: false,
        constant: 100,
      },
      {
        signal: { type: 'virtual', name: 'signal-value' },
        copy_count_from_input: false,
        constant: 103,
      },
    ]);
  });

  test('hydrates the profile-free resolved fixture with the same one-tick model', () => {
    const compilation = compileSourceProgram(lookupSource);
    if (
      compilation.execution === undefined ||
      compilation.plan === undefined ||
      compilation.resolvedCircuit === undefined
    ) {
      throw new Error('Expected a resolved generated lookup fixture.');
    }

    const hydrated = hydrateResolvedCircuit(compilation.resolvedCircuit);
    const source = compilation.execution.network('source');
    const output = compilation.execution.network(compilation.plan.networks[1]!.name);
    const simulation = hydrated.createSimulation([
      {
        network: hydrated.network(source.id),
        values: new SparseBus([[lookupContract.inputSignal, lookupContract.presentKey]]),
      },
    ]);

    expect(simulation.step().read(output.id).get(lookupContract.outputSignal)).toBe(
      lookupContract.presentValue,
    );
  });
});

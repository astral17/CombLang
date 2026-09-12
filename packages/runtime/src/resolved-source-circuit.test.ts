import { signal, SparseBus } from '@comblang/factorio';
import type { NetworkId, SourceSpan } from '@comblang/shared';
import { describe, expect, test } from 'vitest';

import { hydrateResolvedSourceCircuit } from './resolved-source-circuit.js';

const inputId = 'network:input' as NetworkId;
const outputId = 'network:output' as NetworkId;
const A = signal('virtual', 'signal-A');
const B = signal('virtual', 'signal-B');
const source: SourceSpan = {
  fileId: 'file:resolved-runtime.ts' as SourceSpan['fileId'],
  start: 0,
  end: 1,
};

const context = {
  database: { schemaVersion: 1, identity: 'database:synthetic' },
  profileSetIdentity: 'profiles:synthetic',
  evidenceIdentity: 'evidence:synthetic',
  policyIdentity: 'policy:synthetic',
};

const networks = [
  {
    id: inputId,
    name: 'input',
    fixedColor: 'red' as const,
    color: 'red' as const,
    provenance: { source, instancePath: [], expansionStack: [] },
  },
  {
    id: outputId,
    name: 'output',
    fixedColor: 'red' as const,
    color: 'red' as const,
    provenance: { source, instancePath: [], expansionStack: [] },
  },
];

function producerBase(id: string, kind: string, config: unknown, destinations = [outputId]) {
  return {
    id,
    kind,
    config,
    destinations,
    provenance: { source, instancePath: [], expansionStack: [] },
  };
}

function artifact(producers: readonly unknown[] = [], entities: readonly unknown[] = []): unknown {
  return {
    format: 'comblang-resolved-source-circuit',
    version: 1,
    planFingerprint: 'v1-0000000000000000',
    ir: {
      format: 'comblang-ncir',
      version: 3,
      context,
      networks,
      producers,
      entities,
    },
  };
}

function physicalEntity() {
  return {
    id: 'entity:1',
    profile: {
      prototypeKey: 'entity:synthetic-zero-port',
      database: context.database,
      profileId: 'profile:synthetic-zero-port-v1',
    },
    prototypeName: 'synthetic-zero-port',
    connectorBindings: [],
    placement: { x: 2.5, y: -1, direction: 8 },
    provenance: {
      source,
      instancePath: [],
      expansionStack: [],
      creationRevision: 1,
    },
    ordinal: 1,
  };
}

describe('resolved source circuit runtime', () => {
  test('hydrates constant, arithmetic, and decider producers with existing semantics', () => {
    const constant = hydrateResolvedSourceCircuit(
      artifact([
        producerBase('producer:constant', 'constant', { outputs: [{ signal: A, value: 7 }] }),
      ]),
    );
    expect(constant.createSimulation().step().read(outputId).get(A)).toBe(7);

    const arithmetic = hydrateResolvedSourceCircuit(
      artifact([
        producerBase('producer:arithmetic', 'arithmetic', {
          left: { kind: 'signal', signal: A, refKind: 'single', network: inputId },
          operation: 'add',
          right: { kind: 'constant', value: 1 },
          output: { kind: 'signal', signal: B },
        }),
      ]),
    );
    const input = arithmetic.network(inputId);
    expect(
      arithmetic
        .createSimulation([{ network: input, values: new SparseBus([[A, 41]]) }])
        .step()
        .read(outputId)
        .get(B),
    ).toBe(42);

    const decider = hydrateResolvedSourceCircuit(
      artifact([
        producerBase('producer:decider', 'decider', {
          condition: {
            kind: 'compare',
            left: { kind: 'signal', signal: A, refKind: 'single', network: inputId },
            comparator: '>',
            right: { kind: 'constant', value: 3 },
          },
          outputs: [
            {
              mode: 'constant',
              signal: { kind: 'signal', signal: B },
              value: 9,
            },
          ],
        }),
      ]),
    );
    expect(
      decider
        .createSimulation([{ network: decider.network(inputId), values: new SparseBus([[A, 5]]) }])
        .step()
        .read(outputId)
        .get(B),
    ).toBe(9);
  });

  test('provides stable Network lookup, fresh simulations, and rejects unknown initial Networks', () => {
    const preview = hydrateResolvedSourceCircuit(
      artifact([
        producerBase('producer:arithmetic', 'arithmetic', {
          left: { kind: 'signal', signal: A, refKind: 'single', network: inputId },
          operation: 'add',
          right: { kind: 'constant', value: 1 },
          output: { kind: 'signal', signal: B },
        }),
      ]),
    );
    const input = preview.network(inputId);
    expect(preview.network(inputId)).toBe(input);
    expect(preview.networks).toEqual([input, preview.network(outputId)]);

    const initialized = preview
      .createSimulation([{ network: input, values: new SparseBus([[A, 41]]) }])
      .step();
    expect(initialized.tick).toBe(1);
    expect(initialized.read(outputId).get(B)).toBe(42);
    expect(preview.createSimulation().step().read(outputId).get(B)).toBe(1);

    expect(() => preview.network('network:missing' as NetworkId)).toThrow(/Unknown Network/);
    expect(() =>
      preview.createSimulation([
        {
          network: { kind: 'network', id: inputId },
          values: new SparseBus(),
        },
      ]),
    ).toThrow(/Foreign or invalid resolved Network/);

    const secondHydration = hydrateResolvedSourceCircuit(artifact());
    expect(() =>
      preview.createSimulation([
        { network: secondHydration.network(inputId), values: new SparseBus() },
      ]),
    ).toThrow(/Foreign or invalid resolved Network/);
  });

  test('keeps physical Entities inert and out of simulation device construction', () => {
    const withoutEntity = hydrateResolvedSourceCircuit(
      artifact([
        producerBase('producer:constant', 'constant', { outputs: [{ signal: A, value: 7 }] }),
      ]),
    );
    const withEntity = hydrateResolvedSourceCircuit(
      artifact(
        [producerBase('producer:constant', 'constant', { outputs: [{ signal: A, value: 7 }] })],
        [physicalEntity()],
      ),
    );

    const emptyTick = withoutEntity.createSimulation().step();
    const entityTick = withEntity.createSimulation().step();
    expect(entityTick.tick).toBe(emptyTick.tick);
    expect(entityTick.read(outputId)).toEqual(emptyTick.read(outputId));
  });
});

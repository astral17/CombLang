import { readFileSync } from 'node:fs';
import { describe, expect, test, vi } from 'vitest';
import * as circuitMetrics from '@comblang/compiler/circuit-graph-metrics';
import { compileSourceProgram } from '@comblang/runtime/source-compilation';
import {
  createTrustedEntityReplayContext,
  syntheticZeroPortEntityProfile,
} from '@comblang/compiler';
import type { EntityProfile } from '@comblang/compiler/entity';
import type { EntityPrototype } from '@comblang/prototypes';
import { createSourceCircuitArtifact } from './source-circuit-artifact.js';
import * as sourceDemo from './source-demo.js';

function compileWithHost(text: string, family = 'selector-combinator') {
  const profile: EntityProfile = {
    ...structuredClone(syntheticZeroPortEntityProfile),
    ref: {
      ...syntheticZeroPortEntityProfile.ref,
      prototypeKey: `entity:${family}` as EntityProfile['ref']['prototypeKey'],
      profileId: 'profile:summary-family' as EntityProfile['ref']['profileId'],
    },
    prototypeType: family,
  };
  const context = createTrustedEntityReplayContext({
    database: profile.ref.database,
    source: 'synthetic',
    evidenceIdentity: 'summary-evidence',
    policyIdentity: 'summary-policy',
    profiles: [profile],
  });
  return compileSourceProgram(
    { path: 'summary.factorio.ts', text },
    {
      trustedEntityReplayContext: context,
      entityPrototypeResolver: {
        database: context.database,
        getEntity: (key: string): EntityPrototype | undefined =>
          key === profile.ref.prototypeKey
            ? {
                key: profile.ref.prototypeKey as EntityPrototype['key'],
                name: family,
                type: family,
                tileWidth: 1,
                tileHeight: 1,
              }
            : undefined,
      },
    },
  );
}

function artifact(text: string) {
  const compilation = compileWithHost(text);
  expect(compilation.pipelineDiagnostics.filter(({ severity }) => severity === 'error')).toEqual(
    [],
  );
  if (!compilation.plan || !compilation.resolvedCircuit)
    throw new Error('Expected canonical source pair.');
  return createSourceCircuitArtifact(compilation.plan, compilation.resolvedCircuit);
}

const selector = `const A = Signal('virtual', 'signal-A');
const input = new Network();
const output = new Network();
output += Selector({ input, operation: 'count', output: A });`;

describe('general source circuit summary', () => {
  test.each([
    ['Selector-first', selector, 1, ['input', 'output']],
    ['empty', '', 0, []],
    [
      'independent branches',
      `const left = new Network<R>();
const right = new Network<G>();
const first: Network = left + 1;
const second: Network = right + 2;`,
      2,
      ['left', 'right', 'first', 'second'],
    ],
  ] as const)('summarizes %s without guessing a demo scenario', (_name, text, count, names) => {
    const result = artifact(text);
    const summary = sourceDemo.sourceCircuitSummary(result);
    expect(summary.combinators).toBe(count);
    expect(summary.attachments).toBe(count);
    expect(summary.graphMetrics).toMatchObject({
      depth: count === 0 ? 0 : 1,
      feedback: false,
      unknownLatency: false,
    });
    expect(summary.colors.map(({ name }) => name).sort()).toEqual([...names].sort());
    if (_name === 'independent branches') {
      expect(summary.colors).toEqual(
        expect.arrayContaining([
          { name: 'left', color: 'red' },
          { name: 'right', color: 'green' },
        ]),
      );
    }
    expect(summary).not.toHaveProperty('inputNetwork');
    expect(summary).not.toHaveProperty('outputNetwork');
    expect(summary).not.toHaveProperty('timeline');
  });

  test('does not create a simulation, project a blueprint or mutate canonical artifacts', () => {
    const result = artifact(selector);
    const before = JSON.stringify({ plan: result.plan, resolvedCircuit: result.resolvedCircuit });
    const wrapped = {
      ...result,
      execution: {
        ...result.execution,
        circuit: {
          ...result.execution.circuit,
          createSimulation() {
            throw new Error('Summary must not simulate.');
          },
        },
      },
      get blueprint(): never {
        throw new Error('Summary must not project.');
      },
    };
    expect(sourceDemo.sourceCircuitSummary(wrapped)).toMatchObject({
      combinators: 1,
      attachments: 1,
      stages: 1,
      graphMetrics: { depth: 1, unknownLatency: false, feedback: false },
    });
    expect(JSON.stringify({ plan: result.plan, resolvedCircuit: result.resolvedCircuit })).toBe(
      before,
    );
  });

  test('retains unknown latency from the shared graph metrics boundary', () => {
    const result = artifact(selector);
    const unknown = circuitMetrics.analyzeCircuitGraph(
      result.execution.circuit.ir,
      () => undefined,
    );
    const spy = vi.spyOn(circuitMetrics, 'analyzeCircuitGraph').mockReturnValue(unknown);
    try {
      expect(sourceDemo.sourceCircuitSummary(result)).toMatchObject({
        stages: 0,
        graphMetrics: unknown,
      });
      expect(spy).toHaveBeenCalledExactlyOnceWith(result.execution.circuit.ir);
      expect(unknown.unknownLatency).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });

  test('retains the existing source rejection of a constant boolean Decider condition', () => {
    const text = `const A = Signal('virtual', 'signal-A');
const output = new Network();
output += Decider({ condition: true, outputs: [1 * A] });`;
    const compilation = compileWithHost(text, 'decider-combinator');
    expect(compilation.pipelineDiagnostics).toEqual([
      expect.objectContaining({
        code: 'RT2027',
        message: 'Decider configuration condition must be a circuit Condition.',
        span: expect.objectContaining({ start: text.indexOf('{ condition') }),
      }),
    ]);
    expect(compilation.resolvedCircuit).toBeUndefined();
  });

  test('retains source-facing transfer survivors and fixed colors', () => {
    const result = artifact(`const input = new Network<R>();
const output = new Network<G>();
output += input + 1;
const middle = new Network();
middle.take(input);
const survivingInput = new Network();
survivingInput.take(middle);
const survivingOutput = new Network();
survivingOutput.take(output);`);
    expect(sourceDemo.sourceCircuitSummary(result).colors).toEqual([
      { name: 'survivingInput', color: 'red' },
      { name: 'survivingOutput', color: 'green' },
    ]);
  });

  test('allows feedback and an empty source in the live zero-start controller', () => {
    for (const text of [
      selector,
      '',
      'const loop = new Network(); loop += loop + 1;',
      'const left = new Network(); const right = new Network(); const first: Network = left + 1; const second: Network = right + 2;',
    ]) {
      const result = artifact(text);
      const summary = sourceDemo.sourceCircuitSummary(result);
      const controller = new sourceDemo.SourceSimulationController(result);
      expect(controller.currentTick).toBe(0);
      expect(controller.timeline[0]!.networks.every(({ signals }) => signals.length === 0)).toBe(
        true,
      );
      controller.stepFrom(0);
      expect(controller.currentTick).toBe(1);
      if (text.includes('loop')) expect(summary.graphMetrics.feedback).toBe(true);
    }
  });

  test('wires production preview to summary and its single live controller, not legacy demo inference', () => {
    const main = readFileSync(new URL('./main.ts', import.meta.url), 'utf8');
    expect(main).not.toContain('runSourceCircuitDemo');
    expect(main).not.toContain('currentDemo.outputNetwork');
    expect(main).not.toContain('demo.inputNetwork');
    expect(main.match(/new SourceSimulationController\(/g)).toHaveLength(1);
    expect(main).toContain('...sourceCircuitSummary(artifact), timeline: controller.timeline');
    expect(main).toContain('`T${selectedSimulationTick} selected`');
    expect(main).toContain('networks.some(({ id }) => id === previousStateNetwork)');
  });
});

import { SparseBus, signal } from '@comblang/factorio';
import type { DeviceId } from '@comblang/shared';
import { describe, expect, test } from 'vitest';

import { compileSourceProgram } from './source-compilation.js';

const A = signal('virtual', 'signal-A');

function compileCircuit(body: string) {
  const compilation = compileSourceProgram({
    path: 'external-input.factorio.ts',
    text: `const A = Signal('virtual', 'signal-A');
const input = new Network();
const output = new Network();
${body}`,
  });
  expect(compilation.pipelineDiagnostics).toEqual([]);
  if (compilation.execution === undefined) throw new Error('Expected an executed circuit.');
  const execution = compilation.execution;
  return { execution, input: execution.network('input'), output: execution.network('output') };
}

// These are internal model contracts, not evidence of native game behavior.
describe('executed-source external input boundaries', () => {
  test.each([
    {
      name: 'arithmetic',
      body: 'output += input[A] * 2;',
      trace: [
        [5, 0],
        [5, 10],
        [7, 10],
        [7, 14],
        [0, 14],
        [0, 0],
      ],
    },
    {
      name: 'decider',
      body: 'output += when(input[A] > 2).then(input[A]);',
      trace: [
        [5, 0],
        [5, 5],
        [7, 5],
        [7, 7],
        [0, 7],
        [0, 0],
      ],
    },
    {
      name: 'feedback',
      body: 'output += input[A] + output[A];',
      trace: [
        [5, 0],
        [5, 5],
        [7, 10],
        [7, 17],
        [0, 24],
        [0, 24],
      ],
    },
    {
      name: 'Constant aggregation',
      body: 'input += CC(3 * A); output += input[A] * 2;',
      trace: [
        [8, 0],
        [8, 16],
        [10, 16],
        [10, 20],
        [3, 20],
        [3, 6],
      ],
    },
    {
      name: 'two-stage pipeline',
      body: 'output += (input[A] * 2) + 1;',
      trace: [
        [5, 0],
        [5, 0],
        [7, 11],
        [7, 11],
        [0, 15],
        [0, 15],
      ],
    },
  ])('matches persistent broadcasts through drive/change/clear: $name', ({ body, trace }) => {
    const { execution, input, output } = compileCircuit(body);
    const simulation = execution.circuit.createSimulation();
    const session = execution.createTestSession();
    let external = new SparseBus([[A, 5]]);

    // Both paths contribute at T+1; neither pre-seeds the T=0 input snapshot.
    simulation.addDevice({
      id: 'external-input:broadcaster' as DeviceId,
      evaluate: () => [{ networkId: input.id, values: external }],
    });
    session.drive(input, [[A, 5]]);
    expect(session.read(input).size).toBe(0);
    expect(session.read(output).size).toBe(0);

    for (let tick = 1; tick <= trace.length; tick++) {
      if (tick === 3) {
        external = new SparseBus([[A, 7]]);
        session.drive(input, [[A, 7]]);
      } else if (tick === 5) {
        external = new SparseBus();
        session.clear(input);
      }

      const snapshot = simulation.step();
      session.tick();
      expect(session.currentTick).toBe(tick);
      for (const network of [input, output]) {
        expect(session.read(network).toJSON(), `network ${network.id}, tick ${tick}`).toEqual(
          snapshot.read(network.id).toJSON(),
        );
      }
      // Pin counts independently: agreement alone could hide a shared timing bug.
      expect([session.read(input).get(A), session.read(output).get(A)], `tick ${tick}`).toEqual(
        trace[tick - 1],
      );
    }
  });

  test('distinguishes a T=0 initial snapshot from a persistent external drive', () => {
    const { execution, input, output } = compileCircuit('output += input[A] * 2;');
    const initialSimulation = execution.circuit.createSimulation([
      { network: input, values: new SparseBus([[A, 5]]) },
    ]);
    const session = execution.createTestSession();
    session.drive(input, [[A, 5]]);
    const trace = [];

    for (let tick = 1; tick <= 3; tick++) {
      const snapshot = initialSimulation.step();
      session.tick();
      trace.push({
        initialInput: snapshot.read(input.id).get(A),
        initialOutput: snapshot.read(output.id).get(A),
        drivenInput: session.read(input).get(A),
        drivenOutput: session.read(output).get(A),
      });
    }

    expect(trace).toEqual([
      { initialInput: 0, initialOutput: 10, drivenInput: 5, drivenOutput: 0 },
      { initialInput: 0, initialOutput: 0, drivenInput: 5, drivenOutput: 10 },
      { initialInput: 0, initialOutput: 0, drivenInput: 5, drivenOutput: 10 },
    ]);
  });
});

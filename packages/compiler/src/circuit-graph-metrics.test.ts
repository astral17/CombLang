import type { NetworkId, ProducerId } from '@comblang/shared';
import { describe, expect, test } from 'vitest';

import { analyzeCircuitGraph } from './circuit-graph-metrics.js';
import type { CircuitProducerNode, NativeCircuitIr } from './ir.js';

const provenance = { instancePath: [], expansionStack: [] } as const;
const A = { type: 'virtual', name: 'signal-A' } as const;
const network = (name: string) => name as NetworkId;
const producerId = (name: string) => name as ProducerId;

function arithmetic(id: string, input: string, destination: string): CircuitProducerNode {
  return {
    id: producerId(id),
    kind: 'arithmetic',
    config: {
      left: { kind: 'signal', signal: A, refKind: 'single', network: network(input) },
      operation: 'add',
      right: { kind: 'constant', value: 0 },
      output: { kind: 'signal', signal: A },
    },
    destinations: [network(destination)],
    provenance,
  };
}

function circuit(producers: readonly CircuitProducerNode[]): NativeCircuitIr {
  return { format: 'comblang-ncir', version: 2, networks: [], producers };
}

describe('resolved NCIR graph metrics', () => {
  test('keeps the longest DAG branch independent of producer order', () => {
    const chain = [
      arithmetic('p3', 'n2', 'n3'),
      arithmetic('unrelated', 'input', 'other'),
      arithmetic('p1', 'input', 'n1'),
      arithmetic('p2', 'n1', 'n2'),
    ];

    expect(analyzeCircuitGraph(circuit(chain))).toEqual({
      depth: 3,
      feedback: false,
      feedbackComponents: [],
      unknownLatency: false,
    });
    expect(analyzeCircuitGraph(circuit(chain.toReversed())).depth).toBe(3);
  });

  test('uses every driver and pair member in a diamond dependency', () => {
    const joined: CircuitProducerNode = {
      id: producerId('joined'),
      kind: 'arithmetic',
      config: {
        left: {
          kind: 'each',
          refKind: 'pair',
          networks: [network('left'), network('right')],
        },
        operation: 'add',
        right: { kind: 'constant', value: 0 },
        output: { kind: 'each' },
      },
      destinations: [network('output')],
      provenance,
    };
    const metrics = analyzeCircuitGraph(
      circuit([
        arithmetic('left-driver-a', 'input', 'left'),
        arithmetic('left-driver-b', 'input', 'left'),
        arithmetic('right-driver', 'input', 'right'),
        joined,
      ]),
    );

    expect(metrics).toMatchObject({ depth: 2, feedback: false, unknownLatency: false });
  });

  test('includes else-only Decider inputs', () => {
    const decider: CircuitProducerNode = {
      id: producerId('decider'),
      kind: 'decider',
      config: {
        condition: {
          kind: 'compare',
          left: {
            kind: 'signal',
            signal: A,
            refKind: 'single',
            network: network('condition'),
          },
          comparator: '>',
          right: { kind: 'constant', value: 0 },
        },
        outputs: [],
        elseOutputs: [
          {
            mode: 'copy',
            signal: { kind: 'signal', signal: A },
            input: { refKind: 'single', network: network('else-input') },
          },
        ],
      },
      destinations: [network('output')],
      provenance,
    };
    expect(
      analyzeCircuitGraph(circuit([arithmetic('else-driver', 'input', 'else-input'), decider]))
        .depth,
    ).toBe(2);
  });

  test('includes both Selector input Networks in graph dependencies', () => {
    const selector: CircuitProducerNode = {
      id: producerId('selector'),
      kind: 'selector',
      config: {
        operation: 'count',
        input: { refKind: 'pair', networks: [network('left'), network('right')] },
        output: A,
      },
      destinations: [network('output')],
      provenance,
    };

    expect(
      analyzeCircuitGraph(
        circuit([
          arithmetic('left-driver', 'input', 'left'),
          arithmetic('right-driver', 'input', 'right'),
          selector,
        ]),
      ),
    ).toMatchObject({ depth: 2, feedback: false, unknownLatency: false });
  });

  test('condenses feedback and reports it separately from structural depth', () => {
    const metrics = analyzeCircuitGraph(
      circuit([
        arithmetic('second', 'first-output', 'second-output'),
        arithmetic('first', 'second-output', 'first-output'),
        arithmetic('downstream', 'second-output', 'result'),
      ]),
    );

    expect(metrics).toEqual({
      depth: 2,
      feedback: true,
      feedbackComponents: [[producerId('first'), producerId('second')]],
      unknownLatency: false,
    });
    expect(
      analyzeCircuitGraph(circuit([arithmetic('self', 'loop', 'loop')])).feedbackComponents,
    ).toEqual([[producerId('self')]]);
  });

  test('propagates unknown latency without confusing it with feedback', () => {
    const metrics = analyzeCircuitGraph(
      circuit([arithmetic('known', 'input', 'middle'), arithmetic('unknown', 'middle', 'output')]),
      (producer) => (producer.id === producerId('unknown') ? undefined : 1),
    );

    expect(metrics).toEqual({
      feedback: false,
      feedbackComponents: [],
      unknownLatency: true,
    });
  });

  test('rejects an invalid declared device latency', () => {
    expect(() =>
      analyzeCircuitGraph(circuit([arithmetic('bad', 'input', 'output')]), () => -1),
    ).toThrow('Producer latency must be a non-negative safe integer or undefined.');
  });
});

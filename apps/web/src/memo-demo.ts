import { signal, SparseBus } from '@comblang/factorio';
import { DslRuntime } from '@comblang/runtime';

export interface MemoCellDemo {
  readonly combinators: number;
  readonly attachments: number;
  readonly colors: readonly { readonly name: string; readonly color: 'red' | 'green' }[];
  readonly waveform: readonly {
    readonly tick: number;
    readonly input: number;
    readonly output: number;
  }[];
}

export function runMemoCellDemo(): MemoCellDemo {
  const runtime = new DslRuntime();
  const input = runtime.network({ name: 'input' });
  const out = runtime.network({ name: 'out' });
  const mem = runtime.network({ name: 'mem' });

  const delay = runtime.arithmetic({
    left: { kind: 'each', refKind: 'single', network: input },
    operation: 'add',
    right: { kind: 'constant', value: 0 },
    output: { kind: 'each' },
  });
  runtime.attach(delay, out, mem);

  const hold = runtime.decider({
    condition: {
      kind: 'and',
      conditions: [
        {
          kind: 'compare',
          left: { kind: 'wildcard', value: 'each', refKind: 'single', network: input },
          comparator: '=',
          right: { kind: 'constant', value: 0 },
        },
        {
          kind: 'compare',
          left: { kind: 'wildcard', value: 'each', refKind: 'single', network: mem },
          comparator: '!=',
          right: { kind: 'constant', value: 0 },
        },
      ],
    },
    outputs: [
      {
        signal: { kind: 'wildcard', value: 'each' },
        input: { refKind: 'single', network: mem },
        copyCountFromInput: true,
      },
    ],
  });
  runtime.attach(hold, out, mem);

  const circuit = runtime.elaborate();
  const A = signal('virtual', 'signal-A');
  const simulation = circuit.createSimulation([
    { network: input, values: new SparseBus([[A, 42]]) },
  ]);
  const waveform = [{ tick: 0, input: 42, output: simulation.snapshot.read(out.id).get(A) }];
  for (let tick = 1; tick <= 3; tick += 1) {
    const snapshot = simulation.step();
    waveform.push({
      tick,
      input: snapshot.read(input.id).get(A),
      output: snapshot.read(out.id).get(A),
    });
  }

  return {
    combinators: circuit.graph.producers.length,
    attachments: circuit.graph.attachments.length,
    colors: circuit.ir.networks.map((network) => ({
      name: network.name ?? network.id,
      color: network.color,
    })),
    waveform,
  };
}

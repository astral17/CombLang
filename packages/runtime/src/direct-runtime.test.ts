import { signal, SparseBus } from '@comblang/factorio';
import { sourceFileId, sourceSpan } from '@comblang/shared';
import { describe, expect, test } from 'vitest';

import { DslRuntime, RuntimeDiagnosticError, type NetworkHandle } from './elaboration.js';

const A = signal('virtual', 'signal-A');

function captureRuntimeDiagnostic(action: () => void): RuntimeDiagnosticError {
  try {
    action();
  } catch (error) {
    if (error instanceof RuntimeDiagnosticError) return error;
    throw error;
  }
  throw new Error('Expected a RuntimeDiagnosticError.');
}

function buildMemoCell(runtime: DslRuntime, input: NetworkHandle) {
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
        mode: 'copy',
        signal: { kind: 'wildcard', value: 'each' },
        input: { refKind: 'single', network: mem },
      },
    ],
  });
  runtime.attach(hold, out, mem);

  return { out, mem };
}

describe('direct elaboration runtime', () => {
  test('builds and simulates the two-combinator MemoCell', () => {
    const runtime = new DslRuntime();
    const input = runtime.network({ name: 'input' });
    const { out, mem } = buildMemoCell(runtime, input);
    const circuit = runtime.elaborate();

    expect(circuit.graph.producers).toHaveLength(2);
    expect(circuit.graph.attachments).toHaveLength(4);
    const colors = new Map(circuit.ir.networks.map((network) => [network.id, network.color]));
    expect(colors.get(input.id)).toBe(colors.get(out.id));
    expect(colors.get(input.id)).not.toBe(colors.get(mem.id));

    const simulation = circuit.createSimulation([
      { network: input, values: new SparseBus([[A, 42]]) },
    ]);
    expect(simulation.step().read(out.id).get(A)).toBe(42);
    expect(simulation.step().read(out.id).get(A)).toBe(42);
    expect(simulation.step().read(out.id).get(A)).toBe(42);
  });

  test('rejects an impossible fixed-color attachment', () => {
    const runtime = new DslRuntime();
    const input = runtime.network();
    const file = sourceFileId('color-conflict.factorio.ts');
    const first = runtime.network({ color: 'red', source: sourceSpan(file, 10, 20) });
    const secondSource = sourceSpan(file, 30, 40);
    const second = runtime.network({ color: 'red', source: secondSource });
    const producer = runtime.arithmetic({
      left: { kind: 'each', refKind: 'single', network: input },
      operation: 'add',
      right: { kind: 'constant', value: 0 },
      output: { kind: 'each' },
    });
    runtime.attach(producer, first, second);

    const error = captureRuntimeDiagnostic(() => runtime.elaborate());
    expect(error.message).toMatch(/color conflict/i);
    expect(error.diagnostic).toMatchObject({
      code: 'RT2010',
      severity: 'error',
      span: secondSource,
    });
  });

  test('rejects handles from another runtime session', () => {
    const first = new DslRuntime();
    const second = new DslRuntime();
    const foreign = first.network();

    const error = captureRuntimeDiagnostic(() =>
      second.arithmetic({
        left: { kind: 'each', refKind: 'single', network: foreign },
        operation: 'add',
        right: { kind: 'constant', value: 0 },
        output: { kind: 'each' },
      }),
    );
    expect(error.diagnostic).toMatchObject({
      code: 'RT2001',
      severity: 'error',
      message: 'Foreign or invalid network handle.',
    });
  });

  test('requires every producer to be attached exactly once', () => {
    const runtime = new DslRuntime();
    const input = runtime.network();
    const output = runtime.network();
    const producerSource = sourceSpan(sourceFileId('unattached.factorio.ts'), 10, 20);
    const producer = runtime.arithmetic(
      {
        left: { kind: 'each', refKind: 'single', network: input },
        operation: 'add',
        right: { kind: 'constant', value: 0 },
        output: { kind: 'each' },
      },
      { source: producerSource },
    );

    expect(captureRuntimeDiagnostic(() => runtime.elaborate()).diagnostic).toMatchObject({
      code: 'RT2007',
      severity: 'error',
      span: producerSource,
    });
    runtime.attach(producer, output);
    expect(
      captureRuntimeDiagnostic(() => runtime.attach(producer, output)).diagnostic,
    ).toMatchObject({
      code: 'RT2006',
      severity: 'error',
      span: producerSource,
    });
  });

  test('records an attachment source independently from its producer', () => {
    const runtime = new DslRuntime();
    const input = runtime.network();
    const output = runtime.network();
    const file = sourceFileId('attachment.factorio.ts');
    const producerSource = sourceSpan(file, 10, 20);
    const attachmentSource = sourceSpan(file, 30, 40);
    const producer = runtime.arithmetic(
      {
        left: { kind: 'each', refKind: 'single', network: input },
        operation: 'multiply',
        right: { kind: 'constant', value: 2 },
        output: { kind: 'each' },
      },
      { source: producerSource },
    );

    runtime.attach(producer, { network: output, source: attachmentSource });
    const circuit = runtime.elaborate();

    expect(circuit.graph.producers[0]?.provenance.source).toEqual(producerSource);
    expect(circuit.graph.attachments[0]?.provenance.source).toEqual(attachmentSource);
  });

  test('points an invalid condition group back to its producer source', () => {
    const runtime = new DslRuntime();
    const source = sourceSpan(sourceFileId('condition.factorio.ts'), 50, 70);

    const error = captureRuntimeDiagnostic(() =>
      runtime.decider(
        {
          condition: { kind: 'and', conditions: [] },
          outputs: [{ mode: 'copy', signal: { kind: 'wildcard', value: 'each' } }],
        },
        { source },
      ),
    );

    expect(error.diagnostic).toEqual({
      code: 'RT2008',
      severity: 'error',
      message: 'A and group cannot be empty.',
      span: source,
    });
  });

  test('copies and freezes explicit provenance stacks', () => {
    const runtime = new DslRuntime();
    const instancePath = ['Outer:result'];
    const expansionStack = ['macro:double'];
    const input = runtime.network();
    const output = runtime.network({ name: 'output', instancePath });
    const producer = runtime.arithmetic(
      {
        left: { kind: 'each', refKind: 'single', network: input },
        operation: 'multiply',
        right: { kind: 'constant', value: 2 },
        output: { kind: 'each' },
      },
      { instancePath, expansionStack },
    );
    runtime.attach(producer, { network: output, instancePath, expansionStack });
    instancePath.push('mutated');
    expansionStack.push('mutated');

    const circuit = runtime.elaborate();
    expect(circuit.graph.networks[1]?.provenance.instancePath).toEqual(['Outer:result']);
    expect(circuit.graph.producers[0]?.provenance).toMatchObject({
      instancePath: ['Outer:result'],
      expansionStack: ['macro:double'],
    });
    expect(circuit.graph.attachments[0]?.provenance).toMatchObject({
      instancePath: ['Outer:result'],
      expansionStack: ['macro:double'],
    });
    expect(Object.isFrozen(circuit.graph.producers[0]?.provenance.instancePath)).toBe(true);
  });
});

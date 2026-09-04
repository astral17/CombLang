import { signal } from '@comblang/factorio';
import type { NetworkId, SourceFileId } from '@comblang/shared';
import { describe, expect, test, vi } from 'vitest';

import { ElaborationExecutionError } from './elaboration-errors.js';
import type { ProducerValue } from './elaboration-values.js';
import { bindProducerOutputSignal } from './producer-output-policy.js';

const network = 'network:1' as NetworkId;
const creation = { fileId: 'file:producer.ts' as SourceFileId, start: 1, end: 10 };
const binding = { fileId: creation.fileId, start: 20, end: 30 };
const A = signal('virtual', 'signal-A');
const B = signal('virtual', 'signal-B');

describe('Producer output binding policy', () => {
  test('rebinds an arithmetic output without changing physical identity', () => {
    const identity = {};
    const value: ProducerValue = {
      kind: 'producer',
      identity,
      producer: {
        kind: 'arithmetic',
        left: { kind: 'each', refKind: 'single', network },
        operation: 'add',
        right: { kind: 'constant', value: 1 },
        output: { kind: 'each' },
        source: creation,
        instancePath: [],
      },
    };
    const brand = vi.fn((producer: ProducerValue) => producer);

    const bound = bindProducerOutputSignal(value, A, binding, brand);

    expect(bound.identity).toBe(identity);
    expect(bound.producer).toMatchObject({ output: { kind: 'signal', signal: A } });
    expect(brand).toHaveBeenCalledOnce();
  });

  test('retains the selected input when Each decider output becomes a concrete Signal', () => {
    const value: ProducerValue = {
      kind: 'producer',
      identity: {},
      producer: {
        kind: 'decider',
        condition: {
          kind: 'compare-signal',
          signal: A,
          comparator: '>',
          constant: 0,
          refKind: 'single',
          network,
        },
        output: { kind: 'each', refKind: 'single', network },
        source: creation,
        instancePath: [],
      },
    };

    const bound = bindProducerOutputSignal(value, B, binding, (producer) => producer);

    expect(bound.producer).toMatchObject({
      output: { kind: 'signal', signal: B, refKind: 'single', network },
    });
  });

  test('reports a source-aware conflict without creating a wrapper', () => {
    const value: ProducerValue = {
      kind: 'producer',
      identity: {},
      producer: {
        kind: 'decider',
        condition: {
          kind: 'compare-signal',
          signal: A,
          comparator: '>',
          constant: 0,
          refKind: 'single',
          network,
        },
        output: { kind: 'signal', signal: A, refKind: 'single', network },
        source: creation,
        instancePath: [],
      },
    };
    const brand = vi.fn((producer: ProducerValue) => producer);

    expect(() => bindProducerOutputSignal(value, B, binding, brand)).toThrowError(
      expect.objectContaining<Partial<ElaborationExecutionError>>({
        code: 'RT2023',
        span: binding,
        related: [{ message: 'Physical producer was created here.', span: creation }],
      }),
    );
    expect(brand).not.toHaveBeenCalled();
  });
});

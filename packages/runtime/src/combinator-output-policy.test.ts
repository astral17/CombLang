import { signal } from '@comblang/factorio';
import type { NetworkId, SourceFileId } from '@comblang/shared';
import { describe, expect, test } from 'vitest';

import { ElaborationExecutionError } from './elaboration-errors.js';
import type { CombinatorDescriptor } from './elaboration-values.js';
import { bindCombinatorOutputSignal } from './combinator-output-policy.js';

const network = 'network:1' as NetworkId;
const creation = { fileId: 'file:combinator.ts' as SourceFileId, start: 1, end: 10 };
const binding = { fileId: creation.fileId, start: 20, end: 30 };
const A = signal('virtual', 'signal-A');
const B = signal('virtual', 'signal-B');

describe('Combinator output binding policy', () => {
  test('rebinds an arithmetic output descriptor', () => {
    const value: CombinatorDescriptor = {
      kind: 'arithmetic',
      left: { kind: 'each', refKind: 'single', network },
      operation: 'add',
      right: { kind: 'constant', value: 1 },
      output: { kind: 'each' },
      source: creation,
      instancePath: [],
    };

    const bound = bindCombinatorOutputSignal(value, A, binding);

    expect(bound).toMatchObject({ output: { kind: 'signal', signal: A } });
  });

  test('retains the selected input when Each decider output becomes a concrete Signal', () => {
    const value: CombinatorDescriptor = {
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
    };

    const bound = bindCombinatorOutputSignal(value, B, binding);

    expect(bound).toMatchObject({
      output: { kind: 'signal', signal: B, refKind: 'single', network },
    });
  });

  test('reports a source-aware conflict without mutating the descriptor', () => {
    const value: CombinatorDescriptor = {
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
    };

    expect(() => bindCombinatorOutputSignal(value, B, binding)).toThrowError(
      expect.objectContaining<Partial<ElaborationExecutionError>>({
        code: 'RT2023',
        span: binding,
        related: [{ message: 'Physical combinator was created here.', span: creation }],
      }),
    );
    expect(value.output).toMatchObject({ signal: A });
  });
});

import { describe, expect, test } from 'vitest';

import { materializeCapturedPlan } from './source-configuration-materialization.js';

describe('captured Decider producer materialization', () => {
  test('still rejects a producer with neither branch and a true-branch cardinality mismatch', () => {
    const captureId = 'producer:test';
    const producerId = 'physical:test';
    const source = { fileId: 'materialize-decider-test.ts', start: 0, end: 1 };
    const planned = {
      kind: 'decider',
      debugCaptureIds: [captureId],
      condition: {},
      output: { kind: 'signal-constant', signal: { type: 'virtual', name: 'signal-A' }, value: 1 },
      outputs: [],
      destinations: [],
      source,
      instancePath: [],
    };
    const attempt = (outputs: readonly unknown[]) =>
      materializeCapturedPlan(
        {
          format: 'comblang-direct-plan',
          networks: [],
          producers: [planned],
          entities: [],
        } as never,
        [
          {
            captureId,
            planIndex: 0,
            producerId,
            producerIndex: 0,
            kind: 'decider',
            configuration: {
              key: captureId,
              kind: 'decider',
              config: { condition: {}, outputs },
            },
          } as never,
        ],
        {
          format: 'comblang-ncir',
          networks: [],
          producers: [{ id: producerId, kind: 'decider' }],
          entities: [],
        } as never,
      );

    expect(() => attempt([])).toThrow(
      'Captured configuration no longer matches its Direct Plan producer.',
    );
    expect(() => attempt([{}])).toThrow(
      'Captured configuration no longer matches its Direct Plan producer.',
    );
  });
});

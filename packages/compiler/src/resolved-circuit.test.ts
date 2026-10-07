import { describe, expect, test } from 'vitest';

import { parseResolvedCircuit } from './resolved-circuit.js';

function resolvedCircuit(name: string) {
  return {
    format: 'comblang-resolved-circuit',
    planFingerprint: 'plan-fnv1a64:0000000000000000',
    ir: {
      format: 'comblang-ncir',
      networks: [
        {
          id: 'network:1',
          color: 'red',
          provenance: { instancePath: [], expansionStack: [] },
        },
      ],
      producers: [
        {
          id: 'producer:1',
          kind: 'constant',
          config: {
            outputs: [{ signal: { type: 'virtual', name, quality: 'legendary' }, value: 2 }],
          },
          destinations: ['network:1'],
          provenance: { instancePath: [], expansionStack: [] },
        },
      ],
      entities: [],
    },
  };
}

describe('resolved-circuit concrete Signal boundary', () => {
  test.each(['signal-each', 'signal-anything', 'signal-everything'])(
    'rejects virtual wildcard-domain Signal %s regardless of quality',
    (name) => {
      expect(() => parseResolvedCircuit(resolvedCircuit(name))).toThrow(
        expect.objectContaining({
          path: '$.ir.producers[0].config.outputs[0].signal',
          message: expect.stringContaining('wildcard domain'),
        }),
      );
    },
  );

  test('accepts an ordinary virtual Signal with a quality', () => {
    const parsed = parseResolvedCircuit(resolvedCircuit('signal-custom'));
    expect(parsed.ir.producers[0]).toMatchObject({
      kind: 'constant',
      config: {
        outputs: [{ signal: { type: 'virtual', name: 'signal-custom', quality: 'legendary' } }],
      },
    });
  });
});

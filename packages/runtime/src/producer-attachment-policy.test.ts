import type { SourceFileId } from '@comblang/shared';
import { describe, expect, test, vi } from 'vitest';

import type { NetworkValue, ProducerValue } from './elaboration-values.js';
import { validateProducerAttachment } from './producer-attachment-policy.js';

const fileId = 'file:attachment.ts' as SourceFileId;
const source = { fileId, start: 50, end: 60 };
const creation = { fileId, start: 1, end: 10 };

function network(name: string, start: number): NetworkValue {
  return {
    kind: 'network',
    name,
    declaration: { fileId, start, end: start + 1 },
    capability: 'owned',
    generation: 0,
  };
}

const producer: ProducerValue = {
  kind: 'producer',
  identity: {},
  producer: {
    kind: 'constant',
    outputs: [],
    source: creation,
    instancePath: [],
  },
};

describe('Producer attachment policy', () => {
  test.each([
    { name: 'no destinations', networks: [], previousAttachment: undefined, code: 'RT2003' },
    {
      name: 'the same destination twice',
      networks: [network('a', 11), network('a', 11)],
      previousAttachment: undefined,
      code: 'RT2004',
    },
    {
      name: 'more than two destinations',
      networks: [network('a', 11), network('b', 21), network('c', 31)],
      previousAttachment: undefined,
      code: 'RT2005',
    },
    {
      name: 'an already attached Producer',
      networks: [network('a', 11)],
      previousAttachment: { fileId, start: 40, end: 45 },
      code: 'RT2006',
    },
  ])('rejects $name before capability mutation', ({ networks, previousAttachment, code }) => {
    const assertWritable = vi.fn();

    expect(() =>
      validateProducerAttachment(networks, producer, source, {
        previousAttachment,
        assertWritable,
      }),
    ).toThrowError(expect.objectContaining({ code, span: source }));
    expect(assertWritable).not.toHaveBeenCalled();
  });

  test('checks every destination capability after structural validation', () => {
    const networks = [network('a', 11), network('b', 21)];
    const assertWritable = vi.fn();

    validateProducerAttachment(networks, producer, source, {
      previousAttachment: undefined,
      assertWritable,
    });

    expect(assertWritable.mock.calls).toEqual([[networks[0]], [networks[1]]]);
  });
});

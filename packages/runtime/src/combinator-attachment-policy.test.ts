import type { SourceFileId } from '@comblang/shared';
import { describe, expect, test, vi } from 'vitest';

import type { NetworkValue } from './elaboration-values.js';
import { validateCombinatorAttachment } from './combinator-attachment-policy.js';

const fileId = 'file:combinator-attachment.ts' as SourceFileId;
const source = { fileId, start: 50, end: 60 };

function network(name: string, start: number): NetworkValue {
  return {
    kind: 'network',
    name,
    declaration: { fileId, start, end: start + 1 },
    capability: 'owned',
    generation: 0,
  };
}

describe('Combinator attachment policy', () => {
  test.each([
    { name: 'no destinations', networks: [], code: 'RT2003' },
    {
      name: 'the same destination twice',
      networks: [network('a', 11), network('a', 11)],
      code: 'RT2004',
    },
    {
      name: 'more than two destinations',
      networks: [network('a', 11), network('b', 21), network('c', 31)],
      code: 'RT2005',
    },
  ])('rejects $name before capability mutation', ({ networks, code }) => {
    const assertWritable = vi.fn();

    expect(() =>
      validateCombinatorAttachment(networks, source, {
        assertWritable,
      }),
    ).toThrowError(expect.objectContaining({ code, span: source }));
    expect(assertWritable).not.toHaveBeenCalled();
  });

  test('checks every destination capability after structural validation', () => {
    const networks = [network('a', 11), network('b', 21)];
    const assertWritable = vi.fn();

    validateCombinatorAttachment(networks, source, {
      assertWritable,
    });

    expect(assertWritable.mock.calls).toEqual([[networks[0]], [networks[1]]]);
  });
});

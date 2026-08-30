import { SparseBus, signal } from '@comblang/factorio';
import type { DeviceId } from '@comblang/shared';
import { describe, expect, it } from 'vitest';

import { aggregateBusValues, knownBus, throughDevice, unknownBus } from './bus-value.js';

const A = signal('virtual', 'signal-A');

describe('whole-bus value lattice', () => {
  it('aggregates known buses on the concrete SparseBus path', () => {
    const value = aggregateBusValues([
      knownBus(new SparseBus([[A, 2]])),
      knownBus(new SparseBus([[A, 3]])),
    ]);
    expect(value.kind).toBe('known');
    if (value.kind === 'known') expect(value.bus.get(A)).toBe(5);
  });

  it('lets any Unknown contribution dominate and canonicalizes its origins', () => {
    const value = aggregateBusValues([
      unknownBus([{ id: 'z', description: 'Z' }]),
      knownBus(new SparseBus([[A, 3]])),
      unknownBus([
        { id: 'a', description: 'A' },
        { id: 'z', description: 'duplicate Z' },
      ]),
    ]);
    expect(value).toEqual({
      kind: 'unknown',
      origins: [
        { id: 'a', description: 'A', path: [] },
        { id: 'z', description: 'Z', path: [] },
      ],
    });
  });

  it('records a deterministic downstream dependency path', () => {
    const value = throughDevice(
      throughDevice(
        unknownBus([{ id: 'object:1', description: 'unmodeled chest' }]),
        'device:first' as DeviceId,
      ),
      'device:second' as DeviceId,
    );
    expect(value).toEqual({
      kind: 'unknown',
      origins: [
        {
          id: 'object:1',
          description: 'unmodeled chest',
          path: ['device:first', 'device:second'],
        },
      ],
    });
  });
});

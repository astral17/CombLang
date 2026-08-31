import type { NetworkId } from '@comblang/shared';
import { describe, expect, it } from 'vitest';

import type { CircuitTimelineSample } from './source-demo.js';
import { buildDetailTimeline, buildOverviewTimeline } from './timeline-view.js';

const timeline: CircuitTimelineSample[] = [
  {
    tick: 0,
    networks: [
      {
        id: 'network:1' as NetworkId,
        name: 'input',
        color: 'red',
        signals: [
          { signal: { type: 'virtual', name: 'signal-A' }, value: 1 },
          { signal: { type: 'virtual', name: 'signal-B' }, value: 2 },
          { signal: { type: 'item', name: 'iron-plate' }, value: 3 },
          { signal: { type: 'fluid', name: 'water' }, value: 4 },
        ],
      },
    ],
  },
  {
    tick: 1,
    networks: [
      {
        id: 'network:1' as NetworkId,
        name: 'input',
        color: 'red',
        signals: [{ signal: { type: 'virtual', name: 'signal-A' }, value: 9 }],
      },
    ],
  },
];

describe('timeline table models', () => {
  it('limits overview cells and reports hidden signals', () => {
    expect(buildOverviewTimeline(timeline).rows[0]?.cells[0]).toEqual({
      lines: ['virtual/signal-A: 1', 'virtual/signal-B: 2', 'item/iron-plate: 3'],
      hidden: 1,
    });
  });

  it('turns one selected Network into signal columns with zero-filled ticks', () => {
    const detail = buildDetailTimeline(timeline, 'network:1');
    expect(detail?.signals.map(({ name }) => name)).toEqual([
      'water',
      'iron-plate',
      'signal-A',
      'signal-B',
    ]);
    expect(detail?.rows).toEqual([
      { tick: 0, values: [4, 3, 1, 2] },
      { tick: 1, values: [0, 0, 9, 0] },
    ]);
  });
});

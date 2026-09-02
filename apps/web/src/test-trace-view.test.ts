import { signal } from '@comblang/factorio';
import type { NetworkId } from '@comblang/shared';
import {
  networkTraceTarget,
  signalTraceTarget,
  TraceReader,
  type TraceDocument,
} from '@comblang/simulator';
import { describe, expect, test } from 'vitest';

import { buildTestTraceTable, traceTargetLabel } from './test-trace-view.js';

const id = 'network:test' as NetworkId;
const A = signal('virtual', 'signal-A');
const rare = signal('virtual', 'signal-A', 'rare');
const target = networkTraceTarget(id);
const names = { [id]: 'output' };

function trace(): TraceReader {
  return new TraceReader({
    format: 'comblang-trace',
    version: 1,
    endTick: 50,
    targets: [target],
    events: [
      { kind: 'known', tick: 0, target: target.id, reset: true, changes: [] },
      {
        kind: 'known',
        tick: 1,
        target: target.id,
        reset: false,
        changes: [
          { signal: A, value: 3 },
          { signal: rare, value: 8 },
          { signal: signal('virtual', 'signal-B'), value: 2 },
          { signal: signal('virtual', 'signal-C'), value: 4 },
        ],
      },
      {
        kind: 'unknown',
        tick: 2,
        target: target.id,
        origins: [{ id: 'probe', description: 'Unmodeled chest', path: [] }],
      },
      { kind: 'known', tick: 3, target: target.id, reset: true, changes: [] },
    ],
  });
}

describe('test trace table adapter', () => {
  test('shows compact buses, overflow, Unknown causes and quality identities', () => {
    const table = buildTestTraceTable(trace(), 0, 4, undefined, names);
    expect(table.columns).toEqual([{ label: 'Network · output', targetId: target.id }]);
    expect(table.rows[0]?.cells[0]?.lines).toEqual(['0']);
    expect(table.rows[1]?.cells[0]).toMatchObject({
      hidden: 1,
      lines: ['virtual/signal-A: 3', 'virtual/signal-A@rare: 8', 'virtual/signal-B: 2'],
    });
    expect(table.rows[2]?.cells[0]).toMatchObject({
      lines: ['Unknown'],
      origins: [{ description: 'Unmodeled chest' }],
    });
    expect(table.rows[3]?.cells[0]?.lines).toEqual(['0']);
  });

  test('switches one target to signal columns without interpreting Unknown as zero', () => {
    const table = buildTestTraceTable(trace(), 0, 4, target.id);
    expect(table.columns.map(({ label }) => label)).toEqual([
      'virtual/signal-A',
      'virtual/signal-A@rare',
      'virtual/signal-B',
      'virtual/signal-C',
    ]);
    expect(table.rows[0]?.cells.every(({ lines }) => lines[0] === '0')).toBe(true);
    expect(table.rows[1]?.cells.map(({ lines }) => lines[0])).toEqual(['3', '8', '2', '4']);
    expect(table.rows[2]?.cells.every(({ origins }) => origins?.[0]?.id === 'probe')).toBe(true);
    expect(table.rows[3]?.cells.every(({ lines }) => lines[0] === '0')).toBe(true);
  });

  test('retains a selected signal column even when it never has a nonzero value', () => {
    const selected = signalTraceTarget(id, rare);
    const reader = new TraceReader({
      format: 'comblang-trace',
      version: 1,
      endTick: 2,
      targets: [selected],
      events: [
        {
          kind: 'known',
          tick: 0,
          target: selected.id,
          reset: true,
          changes: [{ signal: rare, value: 0 }],
        },
      ],
    });
    const table = buildTestTraceTable(reader, 0, 3, selected.id);
    expect(table.columns).toEqual([{ label: 'virtual/signal-A@rare' }]);
    expect(table.rows).toHaveLength(3);
    expect(traceTargetLabel(selected, names)).toBe('Signal · output · virtual/signal-A@rare');
  });

  test('shows an Unknown-only target as state, not as an empty signal list', () => {
    const table = buildTestTraceTable(trace(), 2, 1, target.id);
    expect(table.columns).toEqual([{ label: 'State' }]);
    expect(table.rows[0]?.cells[0]?.origins).toHaveLength(1);
  });

  test('labels object input and output as distinct observations', () => {
    const metadata = {
      id: 'object',
      objectId: 'device' as never,
      adapterId: 'chest',
      instanceId: 'one',
      connector: 'circuit',
    };
    expect(traceTargetLabel({ ...metadata, kind: 'object-input' })).toBe(
      'Object input · chest/one:circuit',
    );
    expect(traceTargetLabel({ ...metadata, kind: 'object-output' })).toBe(
      'Object output · chest/one:circuit',
    );
  });

  test('bounds pages, supports stable tails and rejects invalid selections', () => {
    expect(buildTestTraceTable(trace(), 48, 32).rows.map(({ tick }) => tick)).toEqual([48, 49, 50]);
    expect(() => buildTestTraceTable(trace(), 0, 257)).toThrow(RangeError);
    expect(() => buildTestTraceTable(trace(), 51, 1)).toThrow(RangeError);
    expect(() => buildTestTraceTable(trace(), 0, 1, 'missing')).toThrow('Unknown trace target');
    const empty: TraceDocument = {
      format: 'comblang-trace',
      version: 1,
      endTick: 3,
      targets: [],
      events: [],
    };
    expect(buildTestTraceTable(new TraceReader(empty), 0, 2)).toEqual({
      columns: [],
      rows: [
        { tick: 0, cells: [] },
        { tick: 1, cells: [] },
      ],
    });
  });
});

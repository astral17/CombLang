import { signal, SparseBus } from '@comblang/factorio';
import type { NetworkId } from '@comblang/shared';
import { describe, expect, test } from 'vitest';

import type { BusValue } from './bus-value.js';
import type { CircuitObjectAdapter } from './object-adapter.js';
import { TestSession } from './test-session.js';
import { TraceReader } from './trace-reader.js';
import { networkTraceTarget, type TraceDocument, type TraceEvent } from './trace.js';
import { ValueSimulationKernel } from './value-kernel.js';

const network = 'network:replay' as NetworkId;
const A = signal('virtual', 'signal-A');
const legendaryA = signal('virtual', 'signal-A', 'legendary');
const target = networkTraceTarget(network);

function known(value: BusValue): SparseBus {
  expect(value.kind).toBe('known');
  if (value.kind !== 'known') throw new Error('Expected known bus.');
  return value.bus;
}

function sample(events: readonly TraceEvent[], endTick = 10): TraceDocument {
  return { format: 'comblang-trace', version: 1, endTick, targets: [target], events };
}

const initial: TraceEvent = { kind: 'known', tick: 0, target: target.id, reset: true, changes: [] };

describe('trace replay', () => {
  test('reconstructs quality-aware sparse deltas and the unchanged final ticks', () => {
    const session = new TestSession(new ValueSimulationKernel());
    session.trace(network, session.signal(network, legendaryA));
    session
      .drive(network, [
        [A, 2],
        [legendaryA, 5],
      ])
      .tick(2);
    session.clear(network).tick(8);
    const document = JSON.parse(JSON.stringify(session.traces.toJSON())) as TraceDocument;
    expect(document.endTick).toBe(10);
    expect(document.events.at(-1)?.tick).toBe(3);
    const reader = new TraceReader(document);
    expect(reader.hasExplicitEndTick).toBe(true);
    const selected = reader.targets.find(({ kind }) => kind === 'signal')!;
    expect(known(reader.read(target.id, 2)).entries()).toEqual([
      [A, 2],
      [legendaryA, 5],
    ]);
    expect(known(reader.read(selected.id, 2)).get(legendaryA)).toBe(5);
    expect(known(reader.read(selected.id, 2)).get(A)).toBe(0);
    expect(known(reader.read(target.id, 10)).entries()).toEqual([]);
    const rows = [...reader.snapshots({ fromTick: 8, toTick: 10, targets: [selected.id] })];
    expect(rows.map(({ tick }) => tick)).toEqual([8, 9, 10]);
    expect(
      rows.every(
        ({ values }) => values.length === 1 && known(values[0]!.value).get(legendaryA) === 0,
      ),
    ).toBe(true);
  });

  test('retains Unknown origin paths and object contribution metadata across resets', () => {
    const adapter: CircuitObjectAdapter<{ id: string }, 'circuit'> = {
      id: 'trace-probe',
      instanceId: (instance) => instance.id,
      connectors: () => [{ name: 'circuit', inputNetworks: [network], outputNetworks: [network] }],
    };
    const session = new TestSession(new ValueSimulationKernel());
    const object = session.adaptObject(adapter, { id: 'one' });
    session.trace(network, session.objectInput(object), session.objectOutput(object));
    session.tick();
    const mock = session.mock(object).output([[legendaryA, 7]]);
    session.drive(network, [[A, 3]]).tick();
    mock.clear();
    session.tick(2);
    const reader = new TraceReader(session.traces.toJSON());
    const output = reader.targets.find(({ kind }) => kind === 'object-output')!;
    expect(output).toMatchObject({
      adapterId: 'trace-probe',
      instanceId: 'one',
      connector: 'circuit',
    });
    expect(reader.read(output.id, 1)).toMatchObject({
      kind: 'unknown',
      origins: [{ path: [object.id] }],
    });
    expect(known(reader.read(output.id, 2)).entries()).toEqual([[legendaryA, 7]]);
    expect(known(reader.read(target.id, 2)).entries()).toEqual([
      [A, 3],
      [legendaryA, 7],
    ]);
    expect(reader.read(output.id, 4)).toEqual(reader.read(output.id, 1));
  });

  test('does not retain mutable input or expose shared mutable replay buses', () => {
    const document = JSON.parse(
      JSON.stringify(
        sample([
          { ...initial, changes: [{ signal: A, value: 5 }] },
          {
            kind: 'known',
            tick: 2,
            target: target.id,
            reset: false,
            changes: [{ signal: A, value: 8 }],
          },
        ]),
      ),
    ) as TraceDocument;
    const reader = new TraceReader(document);
    (document.events as unknown[]).length = 0;
    known(reader.read(target.id, 0)).set(A, 100);
    const iterator = reader.snapshots({ fromTick: 0, toTick: 2 });
    const first = iterator.next().value!;
    known(first.values[0]!.value).set(A, 200);
    expect(known(iterator.next().value!.values[0]!.value).get(A)).toBe(5);
    expect(known(iterator.next().value!.values[0]!.value).get(A)).toBe(8);
    expect(known(reader.read(target.id, 0)).get(A)).toBe(5);
  });

  test('reads legacy v1 documents with an explicitly inferred horizon', () => {
    const { endTick: _endTick, ...legacy } = sample([
      initial,
      {
        kind: 'known',
        tick: 3,
        target: target.id,
        reset: false,
        changes: [{ signal: A, value: 1 }],
      },
    ]);
    const reader = new TraceReader(legacy);
    expect(reader.endTick).toBe(3);
    expect(reader.hasExplicitEndTick).toBe(false);
    expect(() => reader.read(target.id, 4)).toThrow(RangeError);
  });

  test('retains the horizon even without targets and iterates large sparse windows lazily', () => {
    const session = new TestSession(new ValueSimulationKernel());
    session.tick(5);
    expect(session.traces.toJSON()).toMatchObject({ endTick: 5, targets: [], events: [] });
    const empty = new TraceReader(session.traces.toJSON());
    expect([...empty.snapshots({ fromTick: 4 })]).toEqual([
      { tick: 4, values: [] },
      { tick: 5, values: [] },
    ]);
    const long = new TraceReader(sample([initial], 1_000_000_000));
    expect([...long.snapshots({ fromTick: 999_999_998 })].map(({ tick }) => tick)).toEqual([
      999_999_998, 999_999_999, 1_000_000_000,
    ]);
  });

  test.each([
    { label: 'missing tick zero', events: [] },
    { label: 'duplicate tick', events: [initial, initial] },
    { label: 'missing reset', events: [{ ...initial, reset: false }] },
    { label: 'fractional tick', events: [initial, { ...initial, tick: 1.5 }] },
    { label: 'foreign target', events: [{ ...initial, target: 'missing' }] },
    {
      label: 'out of int32',
      events: [{ ...initial, changes: [{ signal: A, value: 2147483648 }] }],
    },
    {
      label: 'duplicate signal',
      events: [
        {
          ...initial,
          changes: [
            { signal: A, value: 1 },
            { signal: A, value: 2 },
          ],
        },
      ],
    },
    {
      label: 'unknown without origins',
      events: [{ kind: 'unknown', tick: 0, target: target.id, origins: [] }],
    },
    {
      label: 'no reset after Unknown',
      events: [
        initial,
        {
          kind: 'unknown',
          tick: 1,
          target: target.id,
          origins: [{ id: 'x', description: 'x', path: [] }],
        },
        { ...initial, tick: 2, reset: false },
      ],
    },
  ])('rejects malformed replay: $label', ({ events }) => {
    expect(() => new TraceReader(sample(events as TraceEvent[]))).toThrow();
  });

  test('rejects duplicate targets, truncated horizons, and invalid query windows', () => {
    expect(() => new TraceReader({ ...sample([initial]), targets: [target, target] })).toThrow(
      'duplicate target',
    );
    expect(() => new TraceReader(sample([initial, { ...initial, tick: 2 }], 1))).toThrow('endTick');
    const reader = new TraceReader(sample([initial]));
    expect(() => reader.read('missing', 0)).toThrow('Unknown trace target');
    expect(() => reader.read(target.id, -1)).toThrow(RangeError);
    expect(() => [...reader.snapshots({ fromTick: 4, toTick: 2 })]).toThrow(RangeError);
    expect(() => [...reader.snapshots({ targets: ['missing'] })]).toThrow('Unknown trace target');
  });

  test('orders serialized events and rejects changes outside a selected quality', () => {
    const reader = new TraceReader(
      sample([
        { ...initial, tick: 5, reset: false, changes: [{ signal: A, value: 2 }] },
        initial,
        { ...initial, tick: 2, reset: false, changes: [{ signal: A, value: 1 }] },
      ]),
    );
    expect(known(reader.read(target.id, 3)).get(A)).toBe(1);
    expect(known(reader.read(target.id, 5)).get(A)).toBe(2);
    expect(
      () =>
        new TraceReader({
          ...sample([{ ...initial, changes: [{ signal: A, value: 1 }] }]),
          targets: [{ id: target.id, kind: 'signal', networkId: network, signal: legendaryA }],
        }),
    ).toThrow('different signal');
  });
});

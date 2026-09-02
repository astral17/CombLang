import { signalKey } from '@comblang/factorio';
import {
  TraceReader,
  type BusValue,
  type TraceTarget,
  type UnknownOrigin,
} from '@comblang/simulator';

import { signalLabel } from './timeline-view.js';

export interface TestTraceCell {
  readonly lines: readonly string[];
  readonly hidden: number;
  readonly origins?: readonly UnknownOrigin[];
}

export interface TestTraceTable {
  readonly columns: readonly { readonly label: string; readonly targetId?: string }[];
  readonly rows: readonly { readonly tick: number; readonly cells: readonly TestTraceCell[] }[];
}

export function traceTargetLabel(
  target: TraceTarget,
  names: Readonly<Record<string, string>> = {},
): string {
  if (target.kind === 'network') return `Network · ${names[target.networkId] ?? target.networkId}`;
  if (target.kind === 'signal')
    return `Signal · ${names[target.networkId] ?? target.networkId} · ${signalLabel(target.signal)}`;
  return `${target.kind === 'object-input' ? 'Object input' : 'Object output'} · ${target.adapterId}/${target.instanceId}:${target.connector}`;
}

function cell(value: BusValue): TestTraceCell {
  if (value.kind === 'unknown') return { lines: ['Unknown'], hidden: 0, origins: value.origins };
  const entries = value.bus.entries();
  return {
    lines:
      entries.length === 0
        ? ['0']
        : entries.slice(0, 3).map(([signal, count]) => `${signalLabel(signal)}: ${count}`),
    hidden: Math.max(0, entries.length - 3),
  };
}

/** Adapts only a bounded requested window; Unknown is never presented as zero. */
export function buildTestTraceTable(
  reader: TraceReader,
  fromTick: number,
  count: number,
  targetId?: string,
  names: Readonly<Record<string, string>> = {},
): TestTraceTable {
  if (!Number.isSafeInteger(count) || count < 1 || count > 256)
    throw new RangeError('Trace window must contain 1..256 ticks.');
  const selected =
    targetId === undefined ? undefined : reader.targets.find(({ id }) => id === targetId);
  const snapshots = [
    ...reader.snapshots({
      fromTick,
      toTick: Math.min(reader.endTick, fromTick + count - 1),
      ...(targetId === undefined ? {} : { targets: [targetId] }),
    }),
  ];
  if (selected === undefined)
    return {
      columns: reader.targets.map((target) => ({
        label: traceTargetLabel(target, names),
        targetId: target.id,
      })),
      rows: snapshots.map(({ tick, values }) => ({
        tick,
        cells: values.map(({ value }) => cell(value)),
      })),
    };
  const signals = new Map<string, Extract<TraceTarget, { kind: 'signal' }>['signal']>();
  if (selected.kind === 'signal') signals.set(signalKey(selected.signal), selected.signal);
  for (const row of snapshots) {
    const value = row.values[0]!.value;
    if (value.kind === 'known')
      for (const [signal] of value.bus.entries()) signals.set(signalKey(signal), signal);
  }
  const ordered = [...signals].sort(([a], [b]) => a.localeCompare(b)).map(([, signal]) => signal);
  return {
    columns:
      ordered.length === 0
        ? [{ label: 'State' }]
        : ordered.map((signal) => ({ label: signalLabel(signal) })),
    rows: snapshots.map(({ tick, values }) => {
      const value = values[0]!.value;
      return {
        tick,
        cells:
          ordered.length === 0
            ? [cell(value)]
            : ordered.map((signal) =>
                value.kind === 'unknown'
                  ? cell(value)
                  : { lines: [String(value.bus.get(signal))], hidden: 0 },
              ),
      };
    }),
  };
}

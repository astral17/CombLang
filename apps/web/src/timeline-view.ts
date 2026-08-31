import { signalKey } from '@comblang/factorio';

import type { CircuitTimelineSample, NetworkTimelineSample } from './source-demo.js';

export interface OverviewCell {
  readonly lines: readonly string[];
  readonly hidden: number;
}

export interface OverviewRow {
  readonly tick: number;
  readonly cells: readonly OverviewCell[];
}

export interface OverviewTimeline {
  readonly networks: readonly Pick<NetworkTimelineSample, 'id' | 'name' | 'color'>[];
  readonly rows: readonly OverviewRow[];
}

export interface DetailTimeline {
  readonly network: Pick<NetworkTimelineSample, 'id' | 'name' | 'color'>;
  readonly signals: readonly NetworkTimelineSample['signals'][number]['signal'][];
  readonly rows: readonly { readonly tick: number; readonly values: readonly number[] }[];
}

export function signalLabel(signal: NetworkTimelineSample['signals'][number]['signal']): string {
  return `${signal.type}/${signal.name}${signal.quality === undefined ? '' : `@${signal.quality}`}`;
}

export function buildOverviewTimeline(
  timeline: readonly CircuitTimelineSample[],
  lineLimit = 3,
): OverviewTimeline {
  const networks = (timeline[0]?.networks ?? []).map(({ id, name, color }) => ({
    id,
    name,
    color,
  }));
  return {
    networks,
    rows: timeline.map((sample) => ({
      tick: sample.tick,
      cells: networks.map(({ id }) => {
        const signals = sample.networks.find((network) => network.id === id)?.signals ?? [];
        return {
          lines: signals
            .slice(0, lineLimit)
            .map(({ signal, value }) => `${signalLabel(signal)}: ${value}`),
          hidden: Math.max(0, signals.length - lineLimit),
        };
      }),
    })),
  };
}

export function buildDetailTimeline(
  timeline: readonly CircuitTimelineSample[],
  networkId: string,
): DetailTimeline | undefined {
  const network = timeline[0]?.networks.find(({ id }) => id === networkId);
  if (network === undefined) return undefined;
  const signals = new Map<string, NetworkTimelineSample['signals'][number]['signal']>();
  for (const sample of timeline) {
    for (const entry of sample.networks.find(({ id }) => id === network.id)?.signals ?? []) {
      signals.set(signalKey(entry.signal), entry.signal);
    }
  }
  const orderedSignals = [...signals]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([, signal]) => signal);
  return {
    network: { id: network.id, name: network.name, color: network.color },
    signals: orderedSignals,
    rows: timeline.map((sample) => {
      const entries = sample.networks.find(({ id }) => id === network.id)?.signals ?? [];
      const values = new Map(entries.map(({ signal, value }) => [signalKey(signal), value]));
      return {
        tick: sample.tick,
        values: orderedSignals.map((signal) => values.get(signalKey(signal)) ?? 0),
      };
    }),
  };
}

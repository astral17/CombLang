import {
  aggregateBuses,
  compareSignalIds,
  int32,
  type SignalId,
  SparseBus,
} from '@comblang/factorio';

import type { CircuitInput } from './circuit-input.js';

export type SelectorIndex = number | SignalId;

export interface SelectorSelectConfig {
  readonly operation: 'select';
  readonly selectMax?: boolean;
  readonly index?: SelectorIndex;
}

export interface SelectorCountConfig {
  readonly operation: 'count';
  readonly output: SignalId;
}

export type SelectorCombinatorConfig = SelectorSelectConfig | SelectorCountConfig;

interface SelectorRow {
  readonly signal: SignalId;
  readonly value: number;
}

function combinedInput(input: CircuitInput): SparseBus {
  return aggregateBuses([input.red, input.green]);
}

function compareRows(left: SelectorRow, right: SelectorRow, selectMax: boolean): number {
  const valueOrder = selectMax ? right.value - left.value : left.value - right.value;
  return valueOrder === 0 ? compareSignalIds(left.signal, right.signal) : valueOrder;
}

function selectIndex(config: SelectorSelectConfig, input: SparseBus): number {
  const rawIndex =
    config.index === undefined
      ? 0
      : typeof config.index === 'number'
        ? config.index
        : input.get(config.index);
  return int32(rawIndex);
}

function evaluateSelect(config: SelectorSelectConfig, input: SparseBus): SparseBus {
  const rows = input
    .entries()
    .map(([signal, value]) => ({ signal, value }))
    .sort((left, right) => compareRows(left, right, config.selectMax ?? true));
  const index = selectIndex(config, input);
  if (index < 0 || index >= rows.length) return new SparseBus();
  const selected = rows[index];
  return selected === undefined
    ? new SparseBus()
    : new SparseBus([[selected.signal, selected.value]]);
}

export function evaluateSelector(config: SelectorCombinatorConfig, input: CircuitInput): SparseBus {
  const combined = combinedInput(input);
  if (config.operation === 'count') {
    return new SparseBus([[config.output, combined.size]]);
  }
  return evaluateSelect(config, combined);
}

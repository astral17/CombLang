import {
  aggregateBuses,
  readsGreen,
  readsRed,
  type CircuitNetworkSelection,
  SparseBus,
} from '@comblang/factorio';

export interface CircuitInput {
  readonly red: SparseBus;
  readonly green: SparseBus;
}

export function emptyCircuitInput(): CircuitInput {
  return { red: new SparseBus(), green: new SparseBus() };
}

export function singleWireInput(values: SparseBus, color: 'red' | 'green' = 'red'): CircuitInput {
  return color === 'red'
    ? { red: values, green: new SparseBus() }
    : { red: new SparseBus(), green: values };
}

export function selectCircuitInput(
  input: CircuitInput,
  selection?: CircuitNetworkSelection,
): SparseBus {
  const selected: SparseBus[] = [];
  if (readsRed(selection)) selected.push(input.red);
  if (readsGreen(selection)) selected.push(input.green);
  return aggregateBuses(selected);
}

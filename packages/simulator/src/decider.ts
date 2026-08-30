import {
  compareSignalIds,
  int32,
  sameSignal,
  signalKey,
  type CircuitNetworkSelection,
  type CircuitValue,
  type SignalId,
  SparseBus,
} from '@comblang/factorio';

import { selectCircuitInput, type CircuitInput } from './circuit-input.js';

export type Comparator = '>' | '<' | '=' | '>=' | '<=' | '!=';
export type Quantifier = 'each' | 'anything' | 'everything';

export type ScalarOperand =
  | { readonly kind: 'constant'; readonly value: CircuitValue }
  | {
      readonly kind: 'signal';
      readonly signal: SignalId;
      readonly networks?: CircuitNetworkSelection;
    };

export type ConditionLeft =
  | Extract<ScalarOperand, { kind: 'signal' }>
  | {
      readonly kind: 'wildcard';
      readonly value: Quantifier;
      readonly networks?: CircuitNetworkSelection;
    };

export type DeciderCondition =
  | {
      readonly kind: 'compare';
      readonly left: ConditionLeft;
      readonly comparator: Comparator;
      readonly right: ScalarOperand;
    }
  | { readonly kind: 'and'; readonly conditions: readonly DeciderCondition[] }
  | { readonly kind: 'or'; readonly conditions: readonly DeciderCondition[] };

export type DeciderOutputSignal =
  | { readonly kind: 'signal'; readonly signal: SignalId }
  | { readonly kind: 'wildcard'; readonly value: Quantifier };

export type DeciderOutput =
  | {
      readonly mode: 'copy';
      readonly signal: DeciderOutputSignal;
      readonly networks?: CircuitNetworkSelection;
    }
  | {
      readonly mode: 'constant';
      readonly signal: DeciderOutputSignal;
      readonly value: CircuitValue;
      readonly networks?: CircuitNetworkSelection;
    };

export interface DeciderCombinatorConfig {
  readonly condition: DeciderCondition;
  readonly outputs: readonly DeciderOutput[];
  readonly elseOutputs?: readonly DeciderOutput[];
  readonly compareSignals?: (left: SignalId, right: SignalId) => number;
}

function compare(left: CircuitValue, comparator: Comparator, right: CircuitValue): boolean {
  switch (comparator) {
    case '>':
      return left > right;
    case '<':
      return left < right;
    case '=':
      return left === right;
    case '>=':
      return left >= right;
    case '<=':
      return left <= right;
    case '!=':
      return left !== right;
  }
}

function scalarValue(operand: ScalarOperand, input: CircuitInput): CircuitValue {
  return operand.kind === 'constant'
    ? int32(operand.value)
    : selectCircuitInput(input, operand.networks).get(operand.signal);
}

function hasEach(condition: DeciderCondition): boolean {
  if (condition.kind === 'and' || condition.kind === 'or') {
    return condition.conditions.some(hasEach);
  }
  return condition.left.kind === 'wildcard' && condition.left.value === 'each';
}

function quantifierCandidates(
  condition: Extract<DeciderCondition, { kind: 'compare' }>,
  input: CircuitInput,
) {
  const left = condition.left;
  if (left.kind !== 'wildcard') {
    throw new Error('Quantifier candidates require a wildcard condition.');
  }
  return selectCircuitInput(input, left.networks)
    .entries()
    .filter(([candidate]) => {
      return condition.right.kind !== 'signal' || !sameSignal(candidate, condition.right.signal);
    });
}

function evaluateCondition(
  condition: DeciderCondition,
  input: CircuitInput,
  eachSignal?: SignalId,
): boolean {
  if (condition.kind === 'and' || condition.kind === 'or') {
    if (condition.conditions.length === 0) {
      throw new Error(`A decider ${condition.kind.toUpperCase()} group cannot be empty.`);
    }
    return condition.kind === 'and'
      ? condition.conditions.every((child) => evaluateCondition(child, input, eachSignal))
      : condition.conditions.some((child) => evaluateCondition(child, input, eachSignal));
  }

  const right = scalarValue(condition.right, input);
  if (condition.left.kind === 'signal') {
    return compare(
      selectCircuitInput(input, condition.left.networks).get(condition.left.signal),
      condition.comparator,
      right,
    );
  }

  if (condition.left.value === 'each') {
    if (eachSignal === undefined) {
      throw new Error('An Each decider condition requires a current signal.');
    }
    return compare(
      selectCircuitInput(input, condition.left.networks).get(eachSignal),
      condition.comparator,
      right,
    );
  }

  const results = quantifierCandidates(condition, input).map(([, value]) =>
    compare(value, condition.comparator, right),
  );
  return condition.left.value === 'anything' ? results.some(Boolean) : results.every(Boolean);
}

function outputValue(output: DeciderOutput, inputValue: CircuitValue): CircuitValue {
  return output.mode === 'constant' ? int32(output.value) : inputValue;
}

function emitOutputs(
  destination: SparseBus,
  outputs: readonly DeciderOutput[],
  input: CircuitInput,
  activeCandidates: readonly SignalId[] | undefined,
  compareSignals: (left: SignalId, right: SignalId) => number,
): void {
  const eachMode = activeCandidates !== undefined;
  for (const output of outputs) {
    const outputInput = selectCircuitInput(input, output.networks);
    if (output.signal.kind === 'signal') {
      if (eachMode) {
        for (const candidate of activeCandidates) {
          destination.add(output.signal.signal, outputValue(output, outputInput.get(candidate)));
        }
      } else {
        destination.add(
          output.signal.signal,
          outputValue(output, outputInput.get(output.signal.signal)),
        );
      }
      continue;
    }

    const wildcard = output.signal.value;
    if (wildcard === 'everything') {
      if (eachMode) {
        throw new Error('Decider output Everything is invalid when a condition uses Each.');
      }
      for (const [candidate, value] of outputInput.entries()) {
        destination.add(candidate, outputValue(output, value));
      }
      continue;
    }

    const candidates = eachMode
      ? [...activeCandidates].filter((candidate) => outputInput.get(candidate) !== 0)
      : outputInput.entries().map(([candidate]) => candidate);
    candidates.sort(compareSignals);

    if (wildcard === 'anything') {
      const selected = candidates[0];
      if (selected !== undefined) {
        destination.add(selected, outputValue(output, outputInput.get(selected)));
      }
      continue;
    }

    if (!eachMode) {
      throw new Error('Decider output Each requires an Each condition.');
    }
    for (const candidate of activeCandidates) {
      destination.add(candidate, outputValue(output, outputInput.get(candidate)));
    }
  }
}

function collectEachCandidates(
  condition: DeciderCondition,
  input: CircuitInput,
  candidates: Map<string, SignalId>,
): void {
  if (condition.kind === 'and' || condition.kind === 'or') {
    for (const child of condition.conditions) collectEachCandidates(child, input, candidates);
    return;
  }
  if (condition.left.kind !== 'wildcard' || condition.left.value !== 'each') return;
  for (const [candidate] of selectCircuitInput(input, condition.left.networks).entries()) {
    candidates.set(signalKey(candidate), candidate);
  }
}

export function evaluateDecider(config: DeciderCombinatorConfig, input: CircuitInput): SparseBus {
  const result = new SparseBus();
  const compareSignals = config.compareSignals ?? compareSignalIds;

  if (!hasEach(config.condition)) {
    const outputs = evaluateCondition(config.condition, input)
      ? config.outputs
      : (config.elseOutputs ?? []);
    emitOutputs(result, outputs, input, undefined, compareSignals);
    return result;
  }

  const candidateMap = new Map<string, SignalId>();
  collectEachCandidates(config.condition, input, candidateMap);
  const passed: SignalId[] = [];
  const failed: SignalId[] = [];
  for (const candidate of candidateMap.values()) {
    (evaluateCondition(config.condition, input, candidate) ? passed : failed).push(candidate);
  }
  emitOutputs(result, config.outputs, input, passed, compareSignals);
  emitOutputs(result, config.elseOutputs ?? [], input, failed, compareSignals);
  return result;
}

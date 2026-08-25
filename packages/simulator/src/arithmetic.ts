import {
  addInt32,
  compareSignalIds,
  divideInt32,
  int32,
  moduloInt32,
  multiplyInt32,
  powerInt32,
  type CircuitNetworkSelection,
  type CircuitValue,
  type SignalId,
  SparseBus,
  subtractInt32,
} from '@comblang/factorio';

import { selectCircuitInput, type CircuitInput } from './circuit-input.js';

export type ArithmeticOperation =
  | 'add'
  | 'subtract'
  | 'multiply'
  | 'divide'
  | 'modulo'
  | 'power'
  | 'left-shift'
  | 'right-shift'
  | 'bit-and'
  | 'bit-or'
  | 'bit-xor';

export type ArithmeticOperand =
  | { readonly kind: 'constant'; readonly value: CircuitValue }
  | {
      readonly kind: 'signal';
      readonly signal: SignalId;
      readonly networks?: CircuitNetworkSelection;
    }
  | { readonly kind: 'each'; readonly networks?: CircuitNetworkSelection };

export type ArithmeticOutput =
  { readonly kind: 'signal'; readonly signal: SignalId } | { readonly kind: 'each' };

export interface ArithmeticCombinatorConfig {
  readonly left: ArithmeticOperand;
  readonly operation: ArithmeticOperation;
  readonly right: ArithmeticOperand;
  readonly output: ArithmeticOutput;
}

export function evaluateArithmeticOperation(
  operation: ArithmeticOperation,
  left: CircuitValue,
  right: CircuitValue,
): CircuitValue {
  switch (operation) {
    case 'add':
      return addInt32(left, right);
    case 'subtract':
      return subtractInt32(left, right);
    case 'multiply':
      return multiplyInt32(left, right);
    case 'divide':
      return divideInt32(left, right);
    case 'modulo':
      return moduloInt32(left, right);
    case 'power':
      return powerInt32(left, right);
    case 'left-shift':
      return left << right;
    case 'right-shift':
      return left >> right;
    case 'bit-and':
      return left & right;
    case 'bit-or':
      return left | right;
    case 'bit-xor':
      return left ^ right;
  }
}

function operandValue(
  operand: ArithmeticOperand,
  input: CircuitInput,
  eachSignal?: SignalId,
): CircuitValue {
  switch (operand.kind) {
    case 'constant':
      return int32(operand.value);
    case 'signal':
      return selectCircuitInput(input, operand.networks).get(operand.signal);
    case 'each':
      if (eachSignal === undefined) {
        throw new Error('An Each arithmetic operand requires a current signal.');
      }
      return selectCircuitInput(input, operand.networks).get(eachSignal);
  }
}

export function evaluateArithmetic(
  config: ArithmeticCombinatorConfig,
  input: CircuitInput,
): SparseBus {
  const eachCount = Number(config.left.kind === 'each') + Number(config.right.kind === 'each');
  if (config.output.kind === 'each' && eachCount === 0) {
    throw new Error('Arithmetic output Each requires at least one Each input operand.');
  }

  const output = new SparseBus();
  if (eachCount === 0) {
    if (config.output.kind !== 'signal') {
      throw new Error('A scalar arithmetic operation requires a concrete output signal.');
    }
    output.set(
      config.output.signal,
      evaluateArithmeticOperation(
        config.operation,
        operandValue(config.left, input),
        operandValue(config.right, input),
      ),
    );
    return output;
  }

  const candidates = [config.left, config.right]
    .filter(
      (operand): operand is Extract<ArithmeticOperand, { kind: 'each' }> => operand.kind === 'each',
    )
    .flatMap((operand) =>
      selectCircuitInput(input, operand.networks)
        .entries()
        .map(([signal]) => signal),
    )
    .filter(
      (signal, index, signals) =>
        signals.findIndex((candidate) => compareSignalIds(candidate, signal) === 0) === index,
    )
    .sort(compareSignalIds);
  for (const candidate of candidates) {
    const result = evaluateArithmeticOperation(
      config.operation,
      operandValue(config.left, input, candidate),
      operandValue(config.right, input, candidate),
    );
    if (config.output.kind === 'each') {
      output.set(candidate, result);
    } else {
      output.add(config.output.signal, result);
    }
  }
  return output;
}

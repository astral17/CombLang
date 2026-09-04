import type {
  PlanArithmeticOperand,
  PlanComparator,
  PlanDeciderCondition,
  PlanNetworkRef,
} from '@comblang/compiler/direct-plan-schema';
import type { ArithmeticOperation } from '@comblang/compiler/ir';
import { circuitConstant, type SignalId } from '@comblang/factorio';
import type { SourceSpan } from '@comblang/shared';

import type {
  DslValue,
  NetworkValue,
  PairValue,
  RuntimeObjectValue,
  SelectedValue,
  WildcardTokenValue,
} from './elaboration-values.js';

export interface ElaborationOperatorDispatchContext<Source> {
  isCircuitDslValue(value: unknown): value is DslValue;
  /** Nominal source-level Signal handle. */
  isSignal(value: unknown): value is SignalId;
  /** Structural Signal ID already admitted into a selected/IR value. */
  isSignalId(value: unknown): value is SignalId;
  isSelected(value: unknown): value is SelectedValue;
  isNetwork(value: unknown): value is NetworkValue;
  isPair(value: unknown): value is PairValue;
  isWildcardToken(value: unknown): value is WildcardTokenValue;
  recordDslCall(): void;
  assertReadable(value: unknown, source: Source): void;
  planNetworkRef(value: NetworkValue | PairValue | SelectedValue): PlanNetworkRef;
  arithmeticOperand(value: DslValue, source: Source): PlanArithmeticOperand;
  producerMetadata(source: Source): {
    readonly source: SourceSpan;
    readonly instancePath: readonly string[];
  };
  brand<T extends RuntimeObjectValue>(value: T): T;
}

export interface ElaborationOperatorPolicy {
  arithmetic(operator: string): ArithmeticOperation | undefined;
  comparator(operator: string): PlanComparator | undefined;
  reverseComparator(comparator: PlanComparator): PlanComparator;
  invertCondition(condition: PlanDeciderCondition): PlanDeciderCondition;
  evaluateJavaScriptBinary(operator: string, left: unknown, right: unknown): unknown;
  evaluateJavaScriptComparison(operator: string, left: unknown, right: unknown): boolean;
  dispatchBinary<Source>(
    operator: string,
    left: unknown,
    right: unknown,
    source: Source,
    context: ElaborationOperatorDispatchContext<Source>,
  ): unknown;
  dispatchComparison<Source>(
    operator: string,
    left: unknown,
    right: unknown,
    source: Source,
    context: ElaborationOperatorDispatchContext<Source>,
  ): unknown;
}

const comparators: Readonly<Record<string, PlanComparator>> = {
  '>': '>',
  '<': '<',
  '>=': '>=',
  '<=': '<=',
  '==': '=',
  '===': '=',
  '!=': '!=',
  '!==': '!=',
};

const arithmeticOperations: Readonly<Record<string, ArithmeticOperation>> = {
  '+': 'add',
  '-': 'subtract',
  '*': 'multiply',
  '/': 'divide',
  '%': 'modulo',
  '**': 'power',
  '<<': 'left-shift',
  '>>': 'right-shift',
  '&': 'bit-and',
  '|': 'bit-or',
  '^': 'bit-xor',
};

const reverseComparators: Readonly<Record<PlanComparator, PlanComparator>> = {
  '>': '<',
  '<': '>',
  '>=': '<=',
  '<=': '>=',
  '=': '=',
  '!=': '!=',
};

const invertedComparators: Readonly<Record<PlanComparator, PlanComparator>> = {
  '>': '<=',
  '<': '>=',
  '>=': '<',
  '<=': '>',
  '=': '!=',
  '!=': '=',
};

function invertCondition(condition: PlanDeciderCondition): PlanDeciderCondition {
  if (condition.kind === 'and' || condition.kind === 'or') {
    return {
      kind: condition.kind === 'and' ? 'or' : 'and',
      conditions: condition.conditions.map(invertCondition),
    };
  }
  return { ...condition, comparator: invertedComparators[condition.comparator] };
}

function evaluateJavaScriptBinary(operator: string, left: unknown, right: unknown): unknown {
  switch (operator) {
    case '+':
      return (left as number) + (right as number);
    case '-':
      return (left as number) - (right as number);
    case '*':
      return (left as number) * (right as number);
    case '/':
      return (left as number) / (right as number);
    case '%':
      return (left as number) % (right as number);
    case '**':
      return (left as number) ** (right as number);
    case '<<':
      return (left as number) << (right as number);
    case '>>':
      return (left as number) >> (right as number);
    case '&':
      return (left as number) & (right as number);
    case '|':
      return (left as number) | (right as number);
    case '^':
      return (left as number) ^ (right as number);
    default:
      throw new Error(`Unsupported compile-time operator: ${operator}.`);
  }
}

function evaluateJavaScriptComparison(operator: string, left: unknown, right: unknown): boolean {
  switch (operator) {
    case '>':
      return (left as number) > (right as number);
    case '<':
      return (left as number) < (right as number);
    case '>=':
      return (left as number) >= (right as number);
    case '<=':
      return (left as number) <= (right as number);
    case '==':
      return left == right;
    case '===':
      return left === right;
    case '!=':
      return left != right;
    case '!==':
      return left !== right;
    default:
      throw new Error(`Unsupported compile-time comparator: ${operator}.`);
  }
}

function dispatchComparison<Source>(
  operator: string,
  left: unknown,
  right: unknown,
  source: Source,
  context: ElaborationOperatorDispatchContext<Source>,
): unknown {
  const comparator = comparators[operator];
  if (comparator === undefined) throw new Error(`Unsupported comparator: ${operator}.`);
  if (!context.isCircuitDslValue(left) && !context.isCircuitDslValue(right)) {
    return evaluateJavaScriptComparison(operator, left, right);
  }
  context.recordDslCall();
  context.assertReadable(left, source);
  context.assertReadable(right, source);
  if (context.isSelected(left) && context.isSelected(right)) {
    if (!context.isSignalId(left.selection) || !context.isSignalId(right.selection)) {
      throw new Error('Signal-to-signal comparison requires concrete Signal selections.');
    }
    return context.brand({
      kind: 'condition',
      condition: {
        kind: 'compare-signals',
        left: { ...context.planNetworkRef(left), signal: left.selection },
        comparator,
        right: { ...context.planNetworkRef(right), signal: right.selection },
      },
    });
  }
  const selected = context.isSelected(left) ? left : context.isSelected(right) ? right : undefined;
  const selectedConstant =
    typeof left === 'number' ? left : typeof right === 'number' ? right : undefined;
  if (selected !== undefined && selectedConstant !== undefined) {
    const normalized = context.isSelected(left) ? comparator : reverseComparators[comparator];
    return context.brand({
      kind: 'condition',
      condition: context.isSignalId(selected.selection)
        ? {
            kind: 'compare-signal',
            ...context.planNetworkRef(selected),
            signal: selected.selection,
            comparator: normalized,
            constant: circuitConstant(selectedConstant),
          }
        : selected.selection === 'each'
          ? {
              kind: 'compare-each',
              ...context.planNetworkRef(selected),
              comparator: normalized,
              constant: circuitConstant(selectedConstant),
            }
          : {
              kind: 'compare-wildcard',
              ...context.planNetworkRef(selected),
              wildcard: selected.selection,
              comparator: normalized,
              constant: circuitConstant(selectedConstant),
            },
    });
  }
  const network =
    context.isNetwork(left) || context.isPair(left)
      ? left
      : context.isNetwork(right) || context.isPair(right)
        ? right
        : undefined;
  const constant = typeof left === 'number' ? left : typeof right === 'number' ? right : undefined;
  if (network === undefined || constant === undefined) {
    throw new Error('The executable comparison slice requires Network/pair(a, b) vs number.');
  }
  const normalized =
    context.isNetwork(left) || context.isPair(left) ? comparator : reverseComparators[comparator];
  return context.brand({
    kind: 'condition',
    condition: {
      kind: 'compare-each',
      ...context.planNetworkRef(network),
      comparator: normalized,
      constant: circuitConstant(constant),
    },
  });
}

function dispatchBinary<Source>(
  operator: string,
  left: unknown,
  right: unknown,
  source: Source,
  context: ElaborationOperatorDispatchContext<Source>,
): unknown {
  if (!context.isCircuitDslValue(left) && !context.isCircuitDslValue(right)) {
    return evaluateJavaScriptBinary(operator, left, right);
  }
  context.recordDslCall();
  context.assertReadable(left, source);
  context.assertReadable(right, source);
  const signal = context.isSignal(left) ? left : context.isSignal(right) ? right : undefined;
  const signalCount =
    typeof left === 'number' ? left : typeof right === 'number' ? right : undefined;
  if (
    signal !== undefined ||
    (signalCount !== undefined && (context.isSignal(left) || context.isSignal(right)))
  ) {
    if (operator !== '*' || signal === undefined || signalCount === undefined) {
      throw new Error('A typed Signal value must use numericCount * Signal.');
    }
    return context.brand({
      kind: 'signal-value',
      signal,
      value: circuitConstant(signalCount),
    });
  }
  const wildcard = context.isWildcardToken(left)
    ? left
    : context.isWildcardToken(right)
      ? right
      : undefined;
  const wildcardCount =
    typeof left === 'number' ? left : typeof right === 'number' ? right : undefined;
  if (wildcard !== undefined) {
    if (operator !== '*' || wildcardCount === undefined) {
      throw new Error('A wildcard constant output must use numericCount * WILDCARD.');
    }
    return context.brand({
      kind: 'wildcard-count',
      wildcard: wildcard.value,
      value: circuitConstant(wildcardCount),
    });
  }
  const operation = arithmeticOperations[operator];
  if (operation === undefined) throw new Error(`Unsupported arithmetic operator: ${operator}.`);
  const concreteOutput =
    context.isSelected(left) && context.isSignalId(left.selection)
      ? left.selection
      : context.isSelected(right) && context.isSignalId(right.selection)
        ? right.selection
        : undefined;
  return context.brand({
    kind: 'producer',
    identity: {},
    producer: {
      kind: 'arithmetic',
      left: context.arithmeticOperand(left as DslValue, source),
      operation,
      right: context.arithmeticOperand(right as DslValue, source),
      output:
        concreteOutput === undefined
          ? { kind: 'each' }
          : { kind: 'signal', signal: concreteOutput },
      ...context.producerMetadata(source),
    },
  });
}

export const elaborationOperatorPolicy: ElaborationOperatorPolicy = Object.freeze({
  arithmetic: (operator: string) => arithmeticOperations[operator],
  comparator: (operator: string) => comparators[operator],
  reverseComparator: (comparator: PlanComparator) => reverseComparators[comparator],
  invertCondition,
  evaluateJavaScriptBinary,
  evaluateJavaScriptComparison,
  dispatchBinary,
  dispatchComparison,
});

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
  CombinatorDescriptor,
  CombinatorValue,
  ConditionValue,
  DslValue,
  NetworkValue,
  PairValue,
  RuntimeObjectValue,
  SectionValue,
  SelectedValue,
  WildcardName,
  WildcardTokenValue,
} from './elaboration-values.js';

export interface ElaborationOperatorDispatchContext<Source> {
  isCircuitDslValue(value: unknown): value is DslValue;
  /** Nominal source-level Signal handle. */
  isSignal(value: unknown): value is SignalId;
  /** Structural Signal ID already admitted into a selected/IR value. */
  isSignalId(value: unknown): value is SignalId;
  isSelected(value: unknown): value is SelectedValue;
  selectedSelection(value: SelectedValue): SignalId | WildcardName;
  isNetwork(value: unknown): value is NetworkValue;
  networkFacet(value: unknown): NetworkValue | undefined;
  readableNetworkFacet(value: unknown, source: Source): NetworkValue | undefined;
  isPair(value: unknown): value is PairValue;
  isSection(value: unknown): value is SectionValue;
  isWildcardToken(value: unknown): value is WildcardTokenValue;
  recordDslCall(): void;
  assertReadable(value: unknown, source: Source): void;
  planNetworkRef(value: NetworkValue | PairValue | SelectedValue): PlanNetworkRef;
  arithmeticOperand(value: DslValue, source: Source): PlanArithmeticOperand;
  producerMetadata(source: Source): {
    readonly source: SourceSpan;
    readonly instancePath: readonly string[];
  };
  createCombinator(descriptor: CombinatorDescriptor, source: Source): CombinatorValue;
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
  prepareConstantComparisonHead<Source>(
    operator: string,
    left: unknown,
    right: unknown,
    source: Source,
    context: ElaborationOperatorDispatchContext<Source>,
  ): DeciderConstantComparisonHead;
  constantComparisonCondition<Source>(
    head: DeciderConstantComparisonHead,
    constant: number,
    context: ElaborationOperatorDispatchContext<Source>,
  ): ConditionValue;
}

export type DeciderConstantComparisonHead =
  | ({
      readonly kind: 'compare-signal';
      readonly signal: SignalId;
      readonly comparator: PlanComparator;
    } & PlanNetworkRef)
  | ({
      readonly kind: 'compare-each';
      readonly comparator: PlanComparator;
    } & PlanNetworkRef)
  | ({
      readonly kind: 'compare-wildcard';
      readonly wildcard: 'anything' | 'everything';
      readonly comparator: PlanComparator;
    } & PlanNetworkRef);

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

type ComparisonPreparation =
  | { readonly kind: 'native'; readonly value: boolean }
  | { readonly kind: 'circuit'; readonly comparator: PlanComparator };

function prepareComparison<Source>(
  operator: string,
  left: unknown,
  right: unknown,
  source: Source,
  context: ElaborationOperatorDispatchContext<Source>,
): ComparisonPreparation {
  const comparator = comparators[operator];
  if (comparator === undefined) throw new Error(`Unsupported comparator: ${operator}.`);
  if (!context.isCircuitDslValue(left) && !context.isCircuitDslValue(right)) {
    return { kind: 'native', value: evaluateJavaScriptComparison(operator, left, right) };
  }
  if (context.isSection(left) || context.isSection(right)) {
    context.recordDslCall();
    throw new Error('Section values cannot be compared.');
  }
  if (
    (operator === '==' || operator === '===' || operator === '!=' || operator === '!==') &&
    (left === null || left === undefined) !== (right === null || right === undefined)
  ) {
    return { kind: 'native', value: evaluateJavaScriptComparison(operator, left, right) };
  }
  context.recordDslCall();
  context.assertReadable(left, source);
  context.assertReadable(right, source);
  return { kind: 'circuit', comparator };
}

function normalizeConstantComparisonHead<Source>(
  comparator: PlanComparator,
  left: unknown,
  right: unknown,
  source: Source,
  context: ElaborationOperatorDispatchContext<Source>,
): DeciderConstantComparisonHead | undefined {
  const selected = context.isSelected(left) ? left : context.isSelected(right) ? right : undefined;
  if (selected !== undefined) {
    const selection = context.selectedSelection(selected);
    const normalized = context.isSelected(left) ? comparator : reverseComparators[comparator];
    const reference = context.planNetworkRef(selected);
    if (context.isSignalId(selection)) {
      return { kind: 'compare-signal', ...reference, signal: selection, comparator: normalized };
    }
    if (selection === 'each') {
      return { kind: 'compare-each', ...reference, comparator: normalized };
    }
    return {
      kind: 'compare-wildcard',
      ...reference,
      wildcard: selection,
      comparator: normalized,
    };
  }

  const leftNetwork = context.readableNetworkFacet(left, source);
  const rightNetwork = context.readableNetworkFacet(right, source);
  const network =
    leftNetwork ??
    (context.isPair(left) ? left : undefined) ??
    rightNetwork ??
    (context.isPair(right) ? right : undefined);
  if (network === undefined) return undefined;
  const networkIsLeft = leftNetwork !== undefined || context.isPair(left);
  return {
    kind: 'compare-each',
    ...context.planNetworkRef(network),
    comparator: networkIsLeft ? comparator : reverseComparators[comparator],
  };
}

function constantComparisonCondition<Source>(
  head: DeciderConstantComparisonHead,
  value: number,
  context: ElaborationOperatorDispatchContext<Source>,
): ConditionValue {
  const constant = circuitConstant(value);
  if (head.kind === 'compare-signal') {
    return context.brand({ kind: 'condition', condition: { ...head, constant } });
  }
  if (head.kind === 'compare-each') {
    return context.brand({ kind: 'condition', condition: { ...head, constant } });
  }
  return context.brand({ kind: 'condition', condition: { ...head, constant } });
}

function prepareConstantComparisonHead<Source>(
  operator: string,
  left: unknown,
  right: unknown,
  source: Source,
  context: ElaborationOperatorDispatchContext<Source>,
): DeciderConstantComparisonHead {
  if (!context.isCircuitDslValue(left)) {
    throw new Error(
      'A source numeric value is supported only as the right constant of a Decider condition.',
    );
  }
  const prepared = prepareComparison(operator, left, right, source, context);
  if (prepared.kind !== 'circuit') {
    throw new Error(
      'A source numeric value is supported only as the right constant of a Decider condition.',
    );
  }
  const head = normalizeConstantComparisonHead(prepared.comparator, left, right, source, context);
  if (head === undefined) {
    throw new Error('The executable comparison slice requires Network/pair(a, b) vs number.');
  }
  return head;
}

function dispatchComparison<Source>(
  operator: string,
  left: unknown,
  right: unknown,
  source: Source,
  context: ElaborationOperatorDispatchContext<Source>,
): unknown {
  const prepared = prepareComparison(operator, left, right, source, context);
  if (prepared.kind === 'native') return prepared.value;
  const comparator = prepared.comparator;
  if (context.isSelected(left) && context.isSelected(right)) {
    const leftSelection = context.selectedSelection(left);
    const rightSelection = context.selectedSelection(right);
    if (context.isSignalId(leftSelection) && context.isSignalId(rightSelection)) {
      return context.brand({
        kind: 'condition',
        condition: {
          kind: 'compare-signals',
          left: { ...context.planNetworkRef(left), signal: leftSelection },
          comparator,
          right: { ...context.planNetworkRef(right), signal: rightSelection },
        },
      });
    }
    const wildcard = !context.isSignalId(leftSelection)
      ? {
          value: left,
          selection: leftSelection,
          concrete: right,
          signal: rightSelection,
          comparator,
        }
      : !context.isSignalId(rightSelection)
        ? {
            value: right,
            selection: rightSelection,
            concrete: left,
            signal: leftSelection,
            comparator: reverseComparators[comparator],
          }
        : undefined;
    if (
      wildcard !== undefined &&
      context.isSignalId(wildcard.signal) &&
      (wildcard.selection === 'each' ||
        wildcard.selection === 'anything' ||
        wildcard.selection === 'everything')
    ) {
      return context.brand({
        kind: 'condition',
        condition: {
          kind: 'compare-wildcard-signal',
          left: {
            ...context.planNetworkRef(wildcard.value),
            wildcard: wildcard.selection,
          },
          comparator: wildcard.comparator,
          right: {
            ...context.planNetworkRef(wildcard.concrete),
            signal: wildcard.signal,
          },
        },
      });
    }
    throw new Error(
      'A wildcard-to-signal comparison requires one wildcard and one concrete Signal selection.',
    );
  }
  const constant = typeof left === 'number' ? left : right;
  if (typeof constant !== 'number') {
    throw new Error('The executable comparison slice requires Network/pair(a, b) vs number.');
  }
  const head = normalizeConstantComparisonHead(comparator, left, right, source, context);
  if (head === undefined) {
    throw new Error('The executable comparison slice requires Network/pair(a, b) vs number.');
  }
  return constantComparisonCondition(head, constant, context);
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
  if (context.isSection(left) || context.isSection(right)) {
    context.recordDslCall();
    if (operator !== '*' || typeof left !== 'number' || !context.isSection(right)) {
      throw new Error('Only finite number * Section is supported for Section values.');
    }
    if (!Number.isFinite(left)) {
      throw new Error('Section multipliers must be finite numbers.');
    }
    if (right.scaled) {
      throw new Error('A Section value cannot be scaled more than once.');
    }
    const metadata = context.producerMetadata(source);
    return context.brand(
      Object.freeze({
        kind: 'section',
        section: Object.freeze({ ...right.section, multiplier: left }),
        scaled: true,
        source: metadata.source,
      }),
    );
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
  let concreteOutput: SignalId | undefined;
  if (context.isSelected(left)) {
    const selection = context.selectedSelection(left);
    if (context.isSignalId(selection)) concreteOutput = selection;
  }
  if (concreteOutput === undefined && context.isSelected(right)) {
    const selection = context.selectedSelection(right);
    if (context.isSignalId(selection)) concreteOutput = selection;
  }
  return context.createCombinator(
    {
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
    source,
  );
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
  prepareConstantComparisonHead,
  constantComparisonCondition,
});

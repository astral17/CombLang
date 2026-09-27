import { constantConfigurationLimits } from '@comblang/factorio';
import type { SourceSpan } from '@comblang/shared';

import {
  assertBlueprintParameterFromSession,
  assertBlueprintParameterSession,
  assertBlueprintParameterSessionOpen,
  BlueprintParameterError,
  canonicalBlueprintParameterHandle,
  inspectBlueprintParameterHandle,
  type BlueprintNumberParameterHandle,
  type BlueprintParameterRegistration,
  type BlueprintParameterSession,
} from './blueprint-parameters.js';
import {
  assertBlueprintParameterNumberValue,
  readBlueprintParameterBindings,
  type BlueprintParameterBinding,
} from './blueprint-parameter-validation.js';

const numericExpressionBrand: unique symbol = Symbol('blueprint-numeric-expression');
const textEncoder = new TextEncoder();

interface NumericExpressionNodeBase {
  readonly [numericExpressionBrand]: true;
}

export interface BlueprintNumericLiteralExpression extends NumericExpressionNodeBase {
  readonly kind: 'literal';
  readonly value: number;
}

export interface BlueprintNumericParameterExpression extends NumericExpressionNodeBase {
  readonly kind: 'parameter';
  readonly parameter: BlueprintNumberParameterHandle;
}

export interface BlueprintNumericNegateExpression extends NumericExpressionNodeBase {
  readonly kind: 'negate';
  readonly operand: BlueprintNumericExpression;
}

export type BlueprintNumericBinaryOperator = 'add' | 'subtract' | 'multiply';

export interface BlueprintNumericBinaryExpression extends NumericExpressionNodeBase {
  readonly kind: 'binary';
  readonly operator: BlueprintNumericBinaryOperator;
  readonly left: BlueprintNumericExpression;
  readonly right: BlueprintNumericExpression;
}

export type BlueprintNumericExpression =
  | BlueprintNumericLiteralExpression
  | BlueprintNumericParameterExpression
  | BlueprintNumericNegateExpression
  | BlueprintNumericBinaryExpression;

type NumericExpressionNode =
  | { readonly kind: 'literal'; readonly value: number }
  | { readonly kind: 'parameter'; readonly parameter: BlueprintNumberParameterHandle }
  | { readonly kind: 'negate'; readonly operand: BlueprintNumericExpression }
  | {
      readonly kind: 'binary';
      readonly operator: BlueprintNumericBinaryOperator;
      readonly left: BlueprintNumericExpression;
      readonly right: BlueprintNumericExpression;
    };

interface RegisteredNumericExpression {
  readonly session: BlueprintParameterSession;
  readonly node: BlueprintNumericExpression;
  readonly height: number;
  readonly source?: SourceSpan;
}

interface BuildState {
  readonly session: BlueprintParameterSession;
  readonly active: WeakSet<object>;
  readonly normalized: WeakMap<object, BlueprintNumericExpression>;
  readonly heights: WeakMap<object, number>;
  readonly sources: WeakMap<object, SourceSpan>;
  readonly staged: RegisteredNumericExpression[];
  nodes: number;
  bytes: number;
}

interface EvaluationValue {
  readonly value: number;
  readonly source?: SourceSpan;
}

const registeredExpressions = new WeakMap<object, RegisteredNumericExpression>();

function fail(
  code: 'CP1000' | 'CP1001' | 'CP1002',
  path: string,
  message: string,
  span?: SourceSpan,
): never {
  throw new BlueprintParameterError(code, path, message, span);
}

function isObject(value: unknown): value is object {
  return typeof value === 'object' && value !== null;
}

function expressionNode<T extends object>(node: T): BlueprintNumericExpression {
  Object.defineProperty(node, numericExpressionBrand, { value: true });
  return Object.freeze(node) as unknown as BlueprintNumericExpression;
}

function nodeByteCost(
  node: NumericExpressionNode,
  registration?: BlueprintParameterRegistration,
): number {
  let local: unknown;
  switch (node.kind) {
    case 'literal':
      local = { kind: node.kind, value: Object.is(node.value, -0) ? '-0' : node.value };
      break;
    case 'parameter':
      local = { kind: node.kind, parameter: registration ?? null };
      break;
    case 'negate':
      local = { kind: node.kind, operand: null };
      break;
    case 'binary':
      local = { kind: node.kind, operator: node.operator, left: null, right: null };
      break;
  }
  return textEncoder.encode(JSON.stringify(local)).byteLength;
}

function chargeNode(
  state: BuildState,
  node: NumericExpressionNode,
  path: string,
  registration?: BlueprintParameterRegistration,
): void {
  state.nodes += 1;
  if (state.nodes > constantConfigurationLimits.maxNodes) {
    fail(
      'CP1000',
      path,
      `expression exceeds the node limit of ${constantConfigurationLimits.maxNodes}.`,
    );
  }
  state.bytes += nodeByteCost(node, registration);
  if (state.bytes > constantConfigurationLimits.maxBytes) {
    fail(
      'CP1000',
      path,
      `expression exceeds the byte limit of ${constantConfigurationLimits.maxBytes}.`,
      registration?.source,
    );
  }
}

function readPlainRecord(value: unknown, path: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    fail('CP1000', path, 'expected a plain numeric expression record.');
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    fail('CP1000', path, 'expected a plain numeric expression record.');
  }
  const record = Object.create(null) as Record<string, unknown>;
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string')
      fail('CP1000', path, 'expression nodes cannot have symbol fields.');
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !('value' in descriptor)) {
      fail('CP1000', `${path}.${key}`, 'expression fields must be data properties.');
    }
    if (!descriptor.enumerable) {
      fail('CP1000', `${path}.${key}`, 'expression fields must be enumerable.');
    }
    record[key] = descriptor.value;
  }
  return record;
}

function assertExactKeys(
  record: Record<string, unknown>,
  keys: readonly string[],
  path: string,
): void {
  const allowed = new Set(keys);
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) fail('CP1000', `${path}.${key}`, 'unknown expression field.');
  }
  for (const key of keys) {
    if (!Object.hasOwn(record, key))
      fail('CP1000', `${path}.${key}`, 'required expression field is missing.');
  }
}

function brandAndStage(
  state: BuildState,
  node: NumericExpressionNode,
  source?: SourceSpan,
): BlueprintNumericExpression {
  const expression = expressionNode(node);
  const height =
    node.kind === 'negate'
      ? 1 + (state.heights.get(node.operand) ?? 0)
      : node.kind === 'binary'
        ? 1 + Math.max(state.heights.get(node.left) ?? 0, state.heights.get(node.right) ?? 0)
        : 0;
  state.staged.push({
    session: state.session,
    node: expression,
    height,
    ...(source ? { source } : {}),
  });
  state.heights.set(expression, height);
  if (source !== undefined) state.sources.set(expression, source);
  return expression;
}

function visitRegisteredExpression(
  value: object,
  registered: RegisteredNumericExpression,
  state: BuildState,
  path: string,
  depth: number,
): BlueprintNumericExpression {
  if (registered.session !== state.session) {
    fail(
      'CP1001',
      path,
      'numeric expression belongs to a different parameter session.',
      registered.source,
    );
  }
  if (state.active.has(value))
    fail('CP1000', path, 'cyclic numeric expression graph is not supported.');
  const normalized = state.normalized.get(value);
  const height = registered.height;
  if (depth + height > constantConfigurationLimits.maxDepth) {
    fail(
      'CP1000',
      path,
      `expression exceeds the depth limit of ${constantConfigurationLimits.maxDepth}.`,
      registered.source,
    );
  }
  if (normalized !== undefined) return normalized;

  state.active.add(value);
  chargeNode(
    state,
    registered.node,
    path,
    registered.node.kind === 'parameter'
      ? inspectBlueprintParameterHandle(registered.node.parameter, `${path}.parameter`)
      : undefined,
  );
  if (registered.node.kind === 'negate') {
    visit(registered.node.operand, `${path}.operand`, depth + 1, state);
  } else if (registered.node.kind === 'binary') {
    visit(registered.node.left, `${path}.left`, depth + 1, state);
    visit(registered.node.right, `${path}.right`, depth + 1, state);
  }
  state.active.delete(value);
  state.normalized.set(value, registered.node);
  state.heights.set(value, registered.height);
  if (registered.source !== undefined) state.sources.set(value, registered.source);
  return registered.node;
}

function visit(
  value: unknown,
  path: string,
  depth: number,
  state: BuildState,
): BlueprintNumericExpression {
  if (depth > constantConfigurationLimits.maxDepth) {
    fail(
      'CP1000',
      path,
      `expression exceeds the depth limit of ${constantConfigurationLimits.maxDepth}.`,
    );
  }
  if (!isObject(value) || Array.isArray(value)) {
    fail('CP1000', path, 'expected a plain numeric expression record.');
  }
  if (state.active.has(value))
    fail('CP1000', path, 'cyclic numeric expression graph is not supported.');
  const normalized = state.normalized.get(value);
  if (normalized !== undefined) {
    const height = state.heights.get(normalized) ?? 0;
    if (depth + height > constantConfigurationLimits.maxDepth) {
      fail(
        'CP1000',
        path,
        `expression exceeds the depth limit of ${constantConfigurationLimits.maxDepth}.`,
      );
    }
    return normalized;
  }
  const registered = registeredExpressions.get(value);
  if (registered !== undefined) {
    return visitRegisteredExpression(value, registered, state, path, depth);
  }

  const record = readPlainRecord(value, path);
  if (!Object.hasOwn(record, 'kind') || typeof record.kind !== 'string') {
    fail('CP1000', `${path}.kind`, 'expected a numeric expression node kind.');
  }
  state.active.add(value);
  let expression: BlueprintNumericExpression;
  if (record.kind === 'literal') {
    assertExactKeys(record, ['kind', 'value'], path);
    if (typeof record.value !== 'number' || !Number.isFinite(record.value)) {
      fail('CP1000', `${path}.value`, 'numeric literals must be finite numbers.');
    }
    const node = { kind: 'literal' as const, value: record.value };
    chargeNode(state, node, path);
    expression = brandAndStage(state, node);
  } else if (record.kind === 'parameter') {
    assertExactKeys(record, ['kind', 'parameter'], path);
    const registration = assertBlueprintParameterFromSession(
      state.session,
      record.parameter,
      `${path}.parameter`,
    );
    if (registration.kind !== 'number') {
      fail(
        'CP1001',
        `${path}.parameter`,
        'numeric expressions can reference only number parameters.',
        registration.source,
      );
    }
    const parameter = canonicalBlueprintParameterHandle(record.parameter);
    if (parameter === undefined || parameter.kind !== 'number') {
      fail(
        'CP1001',
        `${path}.parameter`,
        'value is not a registered number parameter handle.',
        registration.source,
      );
    }
    const node = { kind: 'parameter' as const, parameter };
    chargeNode(state, node, path, registration);
    expression = brandAndStage(state, node, registration.source);
  } else if (record.kind === 'negate') {
    assertExactKeys(record, ['kind', 'operand'], path);
    const operand = visit(record.operand, `${path}.operand`, depth + 1, state);
    const node = { kind: 'negate' as const, operand };
    chargeNode(state, node, path);
    expression = brandAndStage(state, node, state.sources.get(operand));
  } else if (record.kind === 'binary') {
    assertExactKeys(record, ['kind', 'operator', 'left', 'right'], path);
    if (
      record.operator !== 'add' &&
      record.operator !== 'subtract' &&
      record.operator !== 'multiply'
    ) {
      fail('CP1000', `${path}.operator`, 'expected add, subtract, or multiply.');
    }
    const left = visit(record.left, `${path}.left`, depth + 1, state);
    const right = visit(record.right, `${path}.right`, depth + 1, state);
    const operator = record.operator as BlueprintNumericBinaryOperator;
    const node = {
      kind: 'binary' as const,
      operator,
      left,
      right,
    };
    chargeNode(state, node, path);
    expression = brandAndStage(state, node, state.sources.get(left) ?? state.sources.get(right));
  } else {
    fail('CP1000', `${path}.kind`, 'unsupported numeric expression node kind.');
  }
  state.active.delete(value);
  state.normalized.set(value, expression);
  return expression;
}

/** Validates and freezes one bounded numeric-expression DAG for its owning session. */
export function createBlueprintNumericExpression(
  session: BlueprintParameterSession,
  value: unknown,
): BlueprintNumericExpression {
  assertBlueprintParameterSessionOpen(session, '$.session');
  const state: BuildState = {
    session,
    active: new WeakSet(),
    normalized: new WeakMap(),
    heights: new WeakMap(),
    sources: new WeakMap(),
    staged: [],
    nodes: 0,
    bytes: 0,
  };
  const expression = visit(value, '$', 0, state);
  for (const registration of state.staged) {
    registeredExpressions.set(registration.node, registration);
  }
  return expression;
}

/** Evaluates a registered expression against one session's defaults and bindings. */
export function evaluateBlueprintNumericExpression(
  session: BlueprintParameterSession,
  expression: BlueprintNumericExpression,
  bindingsValue: readonly BlueprintParameterBinding[] = [],
): number {
  assertBlueprintParameterSession(session, '$.session');
  if (!isObject(expression)) {
    fail('CP1001', '$.expression', 'value is not a registered numeric expression.');
  }
  const rootRegistration = registeredExpressions.get(expression);
  if (rootRegistration === undefined) {
    fail('CP1001', '$.expression', 'value is not a registered numeric expression.');
  }
  if (rootRegistration.session !== session) {
    fail(
      'CP1001',
      '$.expression',
      'numeric expression belongs to a different parameter session.',
      rootRegistration.source,
    );
  }

  const parsedBindings = readBlueprintParameterBindings(session, bindingsValue);
  const bindingByHandle = new Map<object, (typeof parsedBindings)[number]>();
  for (const binding of parsedBindings) {
    if (binding.registration.kind !== 'number') {
      fail(
        'CP1001',
        '$.bindings',
        'numeric expressions accept bindings only for number parameters.',
        binding.registration.source,
      );
    }
    bindingByHandle.set(binding.parameter, binding);
  }

  const usedBindings = new Set<object>();
  const memo = new Map<object, EvaluationValue>();
  const evaluate = (nodeValue: BlueprintNumericExpression, path: string): EvaluationValue => {
    const node = nodeValue as object;
    const cached = memo.get(node);
    if (cached !== undefined) return cached;
    const registered = registeredExpressions.get(node);
    if (registered === undefined) {
      fail('CP1001', path, 'expression contains an unregistered numeric node.');
    }
    if (registered.session !== session) {
      fail(
        'CP1001',
        path,
        'expression node belongs to a different parameter session.',
        registered.source,
      );
    }

    let result: EvaluationValue;
    switch (registered.node.kind) {
      case 'literal':
        result = { value: registered.node.value };
        break;
      case 'parameter': {
        const parameter = registered.node.parameter;
        const declaration = inspectBlueprintParameterHandle(parameter, `${path}.parameter`);
        if (declaration.kind !== 'number') {
          fail(
            'CP1001',
            `${path}.parameter`,
            'numeric expression references must be number parameters.',
            declaration.source,
          );
        }
        const binding = bindingByHandle.get(parameter);
        let value: number;
        if (binding !== undefined) {
          usedBindings.add(parameter);
          value = assertBlueprintParameterNumberValue(
            binding.value,
            `${path}.value`,
            'finite',
            declaration.source,
          );
        } else if (typeof declaration.defaultValue === 'number') {
          value = assertBlueprintParameterNumberValue(
            declaration.defaultValue,
            `${path}.defaultValue`,
            'finite',
            declaration.source,
          );
        } else {
          fail(
            'CP1002',
            `${path}.parameter`,
            `parameter "${declaration.label}" has no binding or default.`,
            declaration.source,
          );
        }
        result = { value, ...(declaration.source ? { source: declaration.source } : {}) };
        break;
      }
      case 'negate': {
        const operand = evaluate(registered.node.operand, `${path}.operand`);
        const value = assertBlueprintParameterNumberValue(
          -operand.value,
          `${path}.value`,
          'finite',
          operand.source,
        );
        result = { value, ...(operand.source ? { source: operand.source } : {}) };
        break;
      }
      case 'binary': {
        const left = evaluate(registered.node.left, `${path}.left`);
        const right = evaluate(registered.node.right, `${path}.right`);
        const source = left.source ?? right.source;
        const unvalidated =
          registered.node.operator === 'add'
            ? left.value + right.value
            : registered.node.operator === 'subtract'
              ? left.value - right.value
              : left.value * right.value;
        const value = assertBlueprintParameterNumberValue(
          unvalidated,
          `${path}.value`,
          'finite',
          source,
        );
        result = { value, ...(source ? { source } : {}) };
        break;
      }
    }
    memo.set(node, result);
    return result;
  };

  const result = evaluate(rootRegistration.node, '$');
  for (const binding of parsedBindings) {
    if (!usedBindings.has(binding.parameter)) {
      fail(
        'CP1001',
        '$.bindings',
        `parameter "${binding.registration.label}" is not used by this expression.`,
        binding.registration.source,
      );
    }
  }
  return result.value;
}

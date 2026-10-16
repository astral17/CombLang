import type { SignalId } from '@comblang/factorio';
import type { ArithmeticProducerConfig, LogicalArithmeticOperand } from '../../compiler/src/ir.js';
import { bindArithmeticConfigurationTemplate } from '../../compiler/src/arithmetic-configuration-binding.js';
import {
  createArithmeticConfigurationTemplate,
  type ArithmeticConfigurationTemplate,
} from '../../compiler/src/arithmetic-configuration-template.js';
import {
  BlueprintParameterError,
  type BlueprintNumberParameterHandle,
  type BlueprintParameterSession,
  type BlueprintSignalParameterHandle,
} from '../../compiler/src/blueprint-parameters.js';
import { lookupBlueprintParameterSlot } from '../../compiler/src/blueprint-parameter-validation.js';
import type { ArithmeticOperation } from '../../compiler/src/ir.js';
import type { PlanArithmeticOperand } from '../../compiler/src/direct-plan-schema.js';
import type { BlueprintNumericExpression } from '../../compiler/src/blueprint-numeric-expression.js';
import { findSourceNumericExpressionView as findExpressionView } from './source-numeric-expressions.js';
import type { BlueprintParameterBinding } from '../../compiler/src/blueprint-parameter-validation.js';

type RawSpan = { readonly start: number; readonly end: number };
type NumericSource = BlueprintNumberParameterHandle | BlueprintNumericExpression;

export interface ArithmeticConfigurationSourceContext {
  /** Existing recorder policy for literal and circuit operands. */
  normalizeCircuitOperand(value: unknown, source: RawSpan): PlanArithmeticOperand;
  isSignal(value: unknown): value is SignalId;
  snapshotSignal(value: SignalId): SignalId;
  isEachOutput(value: unknown): boolean;
}

export class ArithmeticConfigurationSourceError extends TypeError {
  constructor(
    readonly path: string,
    message: string,
    options?: ErrorOptions,
  ) {
    super(`${path}: ${message}`, options);
    this.name = 'ArithmeticConfigurationSourceError';
  }
}

export type PreparedArithmeticConfigurationSource =
  | {
      readonly template: ArithmeticConfigurationTemplate;
      readonly hasParameterSlots: boolean;
    }
  | {
      readonly configuration: ArithmeticProducerConfig;
      readonly hasParameterSlots: false;
    };

const operationSet = new Set<ArithmeticOperation>([
  'add',
  'subtract',
  'multiply',
  'divide',
  'modulo',
  'power',
  'left-shift',
  'right-shift',
  'bit-and',
  'bit-or',
  'bit-xor',
]);

function fail(path: string, message: string, cause?: unknown): never {
  throw new ArithmeticConfigurationSourceError(
    path,
    message,
    cause === undefined ? undefined : { cause },
  );
}

/** Reads only own data descriptors and snapshots the exact source fields once. */
function readConfiguration(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    fail('$', 'Arithmetic configuration must be a plain data record.');
  }
  try {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      fail('$', 'Arithmetic configuration must be a plain data record.');
    }
    const keys = Reflect.ownKeys(value);
    if (keys.length > 4) {
      fail(
        '$',
        'Arithmetic configuration must contain exactly left, operation, right, and output fields.',
      );
    }
    const record = Object.create(null) as Record<string, unknown>;
    const allowed = new Set(['left', 'operation', 'right', 'output']);
    for (const key of keys) {
      if (typeof key !== 'string' || !allowed.has(key)) {
        fail(
          '$',
          'Arithmetic configuration must contain exactly left, operation, right, and output fields.',
        );
      }
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined || !('value' in descriptor)) {
        fail(`$.${key}`, 'accessors are not supported.');
      }
      if (!descriptor.enumerable) fail(`$.${key}`, 'non-enumerable fields are not supported.');
      record[key] = descriptor.value;
    }
    for (const key of allowed) {
      if (!Object.hasOwn(record, key)) fail(`$.${key}`, 'missing required field.');
    }
    return record;
  } catch (error) {
    if (error instanceof ArithmeticConfigurationSourceError) throw error;
    fail('$', 'could not inspect Arithmetic configuration data.', error);
  }
}

function sourceErrorPath(error: unknown, fallback: string): string {
  if (!(error instanceof BlueprintParameterError)) return fallback;
  const field = /^\$\.(left|right|output|operation)(?:\.|\[|$)/.exec(error.path)?.[1];
  return field === undefined ? fallback : `$.${field}`;
}

function adaptParameterError(error: unknown, fallback: string): never {
  if (error instanceof ArithmeticConfigurationSourceError) throw error;
  if (error instanceof BlueprintParameterError) {
    const path = sourceErrorPath(error, fallback);
    const detail = error.message.startsWith(`${error.path}: `)
      ? error.message.slice(error.path.length + 2)
      : error.message;
    const sourceDetail =
      detail === 'Arithmetic literal values must be safe integers.'
        ? 'Arithmetic number values must be safe integers before int32 normalization.'
        : detail;
    fail(path, sourceDetail, error);
  }
  fail(
    fallback,
    error instanceof Error ? error.message : 'invalid Arithmetic configuration.',
    error,
  );
}

function templateOperand(operand: PlanArithmeticOperand): unknown {
  return operand.kind === 'signal' ? { ...operand } : operand;
}

function normalizeCircuitOperand(
  value: unknown,
  field: 'left' | 'right',
  context: ArithmeticConfigurationSourceContext,
  source: RawSpan,
): PlanArithmeticOperand {
  try {
    const operand = context.normalizeCircuitOperand(value, source);
    return operand.kind === 'signal'
      ? { ...operand, signal: context.snapshotSignal(operand.signal) }
      : operand;
  } catch (error) {
    if (error instanceof ArithmeticConfigurationSourceError) throw error;
    if (error instanceof Error && error.name === 'ElaborationExecutionError') throw error;
    fail(
      `$.${field}`,
      error instanceof Error ? error.message : 'invalid Arithmetic operand.',
      error,
    );
  }
}

function normalizeNumberSource(
  value: unknown,
  field: 'left' | 'right',
  session: BlueprintParameterSession | undefined,
): NumericSource | undefined {
  if (session === undefined) return undefined;
  const expressionView = findExpressionView(value);
  if (expressionView !== undefined) {
    if (expressionView.session !== session) {
      fail(`$.${field}`, 'source numeric expression belongs to a different parameter session.');
    }
    return expressionView.expression;
  }
  try {
    const slot = lookupBlueprintParameterSlot(value, 'number', session, `$.${field}`);
    return slot?.handle as BlueprintNumberParameterHandle | undefined;
  } catch (error) {
    adaptParameterError(error, `$.${field}`);
  }
}

/** Authenticates symbolic source slots and snapshots literals without evaluating defaults. */
export function prepareArithmeticConfigurationSource(
  value: unknown,
  context: ArithmeticConfigurationSourceContext,
  session: BlueprintParameterSession | undefined,
  source: RawSpan,
): PreparedArithmeticConfigurationSource {
  const record = readConfiguration(value);
  const operation = record.operation;
  if (typeof operation !== 'string' || !operationSet.has(operation as ArithmeticOperation)) {
    fail('$.operation', 'Arithmetic configuration operation is not supported.');
  }

  let hasParameterSlots = false;
  const normalizeOperand = (field: 'left' | 'right'): unknown => {
    const original = record[field];
    const symbolic = normalizeNumberSource(original, field, session);
    if (symbolic !== undefined) {
      hasParameterSlots = true;
      return { kind: 'constant', value: symbolic };
    }
    const concrete = normalizeCircuitOperand(original, field, context, source);
    return templateOperand(concrete);
  };

  const left = normalizeOperand('left');
  const right = normalizeOperand('right');
  let output: ArithmeticConfigurationTemplate['output'];
  const outputValue = record.output;
  if (session !== undefined) {
    try {
      const slot = lookupBlueprintParameterSlot(outputValue, 'signal', session, '$.output');
      if (slot !== undefined) {
        hasParameterSlots = true;
        output = { kind: 'signal', signal: slot.handle as BlueprintSignalParameterHandle };
      } else if (context.isSignal(outputValue)) {
        output = { kind: 'signal', signal: context.snapshotSignal(outputValue) };
      } else if (context.isEachOutput(outputValue)) {
        output = { kind: 'each' };
      } else {
        fail('$.output', 'Arithmetic configuration output must be a concrete Signal or Each/EACH.');
      }
    } catch (error) {
      adaptParameterError(error, '$.output');
    }
  } else if (context.isSignal(outputValue)) {
    output = { kind: 'signal', signal: context.snapshotSignal(outputValue) };
  } else if (context.isEachOutput(outputValue)) {
    output = { kind: 'each' };
  } else {
    fail('$.output', 'Arithmetic configuration output must be a concrete Signal or Each/EACH.');
  }

  if (session === undefined) {
    const config: ArithmeticProducerConfig = {
      left: left as LogicalArithmeticOperand,
      operation: operation as ArithmeticOperation,
      right: right as LogicalArithmeticOperand,
      output: output as ArithmeticProducerConfig['output'],
    };
    return Object.freeze({ configuration: config, hasParameterSlots: false });
  }

  let template: ArithmeticConfigurationTemplate;
  try {
    template = createArithmeticConfigurationTemplate(session, {
      left,
      operation,
      right,
      output,
    });
  } catch (error) {
    adaptParameterError(error, '$');
  }
  return Object.freeze({ template, hasParameterSlots });
}

/** Materializes at the owning source-call boundary; preparation itself never reads defaults. */
export function bindPreparedArithmeticConfigurationSource(
  prepared: PreparedArithmeticConfigurationSource,
  bindings: readonly BlueprintParameterBinding[] = [],
): ArithmeticProducerConfig {
  if ('configuration' in prepared) return prepared.configuration;
  try {
    return bindArithmeticConfigurationTemplate(prepared.template, bindings);
  } catch (error) {
    adaptParameterError(error, '$');
  }
}

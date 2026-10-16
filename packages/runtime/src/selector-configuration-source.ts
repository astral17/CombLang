import { circuitConstant, type SignalId } from '@comblang/factorio';
import type { BlueprintParameterBinding } from '../../compiler/src/blueprint-parameter-validation.js';
import {
  BlueprintParameterError,
  findBlueprintParameterHandle,
  type BlueprintNumberParameterHandle,
  type BlueprintParameterSession,
  type BlueprintSignalParameterHandle,
} from '../../compiler/src/blueprint-parameters.js';
import { isBlueprintParameterShaped } from '../../compiler/src/blueprint-parameter-validation.js';
import { bindSelectorConfigurationTemplate } from '../../compiler/src/selector-configuration-binding.js';
import {
  createSelectorConfigurationTemplate,
  type SelectorConfigurationTemplate,
} from '../../compiler/src/selector-configuration-template.js';
import type { SelectorProducerConfig } from '../../compiler/src/ir.js';
import { findSourceNumericExpressionView } from './source-numeric-expressions.js';

type RawSpan = { readonly start: number; readonly end: number };
type PreparedIndex =
  | number
  | SignalId
  | BlueprintNumberParameterHandle
  | BlueprintSignalParameterHandle
  | NonNullable<ReturnType<typeof findSourceNumericExpressionView>>['expression'];

export interface SelectorConfigurationSourceContext {
  /** Existing recorder ownership/readability policy for the concrete input. */
  normalizeInput(value: unknown, source: RawSpan): SelectorConfigurationTemplate['input'];
  isSignal(value: unknown): value is SignalId;
  snapshotSignal(value: SignalId): SignalId;
}

export class SelectorConfigurationSourceError extends TypeError {
  constructor(
    readonly path: string,
    readonly configurationShape: boolean,
    message: string,
    options?: ErrorOptions,
  ) {
    super(`${path}: ${message}`, options);
    this.name = 'SelectorConfigurationSourceError';
  }
}

export type PreparedSelectorConfigurationSource =
  | {
      readonly template: SelectorConfigurationTemplate;
      readonly hasParameterSlots: boolean;
    }
  | {
      readonly configuration: SelectorProducerConfig;
      readonly hasParameterSlots: false;
    };

function fail(path: string, message: string, cause?: unknown, configurationShape = false): never {
  throw new SelectorConfigurationSourceError(
    path,
    configurationShape,
    message,
    cause === undefined ? undefined : { cause },
  );
}

/** Reads a plain source record from own data descriptors without invoking getters. */
function readConfiguration(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object') {
    fail('$', 'Selector configuration must be a plain data record.', undefined, true);
  }
  try {
    if (Array.isArray(value)) {
      fail('$', 'Selector configuration must be a plain data record.', undefined, true);
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      fail('$', 'Selector configuration must be a plain data record.', undefined, true);
    }
    const keys = Reflect.ownKeys(value);
    const record = Object.create(null) as Record<string, unknown>;
    for (const key of keys) {
      if (typeof key !== 'string') {
        fail('$', 'Selector configuration fields must be string keys.', undefined, true);
      }
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined || !('value' in descriptor)) {
        fail(`$.${key}`, 'accessors are not supported.', undefined, true);
      }
      if (!descriptor.enumerable) {
        fail(`$.${key}`, 'non-enumerable fields are not supported.', undefined, true);
      }
      record[key] = descriptor.value;
    }
    return record;
  } catch (error) {
    if (error instanceof SelectorConfigurationSourceError) throw error;
    fail('$', 'could not inspect Selector configuration data.', error, true);
  }
}

function sourceErrorPath(error: unknown, fallback: string): string {
  if (!(error instanceof BlueprintParameterError)) return fallback;
  const field = /^\$\.(input|operation|selectMax|index|output)(?:\.|\[|$)/.exec(error.path)?.[1];
  return field === undefined ? fallback : `$.${field}`;
}

function adaptParameterError(error: unknown, fallback: string): never {
  if (error instanceof SelectorConfigurationSourceError) throw error;
  if (error instanceof BlueprintParameterError) {
    const path = sourceErrorPath(error, fallback);
    const detail = error.message.startsWith(`${error.path}: `)
      ? error.message.slice(error.path.length + 2)
      : error.message;
    fail(path, detail, error);
  }
  fail(fallback, error instanceof Error ? error.message : 'invalid Selector configuration.', error);
}

function symbolicIndex(
  value: unknown,
  field: 'index' | 'output',
  session: BlueprintParameterSession | undefined,
): { readonly value: PreparedIndex; readonly symbolic: boolean } {
  const expressionView = findSourceNumericExpressionView(value);
  if (expressionView !== undefined) {
    if (session === undefined) {
      fail(`$.${field}`, 'Selector numeric expressions require an owning parameter session.');
    }
    if (expressionView.session !== session) {
      fail(`$.${field}`, 'source numeric expression belongs to a different parameter session.');
    }
    return { value: expressionView.expression, symbolic: true };
  }
  let symbolic: boolean;
  try {
    symbolic =
      findBlueprintParameterHandle(value) !== undefined || isBlueprintParameterShaped(value);
  } catch (error) {
    fail(`$.${field}`, 'could not inspect Selector parameter slot.', error);
  }
  if (symbolic && session === undefined) {
    fail(`$.${field}`, 'Selector parameter slots require an owning parameter session.');
  }
  return { value: value as PreparedIndex, symbolic };
}

/** Authenticates source slots and snapshots concrete Selector fields without evaluating defaults. */
export function prepareSelectorConfigurationSource(
  value: unknown,
  context: SelectorConfigurationSourceContext,
  session: BlueprintParameterSession | undefined,
  source: RawSpan,
  fieldSources?: Readonly<Record<string, RawSpan>>,
): PreparedSelectorConfigurationSource {
  const record = readConfiguration(value);
  if (!Object.hasOwn(record, 'operation')) fail('$.operation', 'missing required field.');
  const operation = record.operation;
  if (operation !== 'select' && operation !== 'count') {
    fail('$.operation', 'Selector configuration operation must be "select" or "count".');
  }
  const allowed =
    operation === 'select'
      ? new Set(['input', 'operation', 'selectMax', 'index'])
      : new Set(['input', 'operation', 'output']);
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) {
      fail(
        '$',
        'Selector configuration fields are operation-specific: select requires input and may use selectMax/index; count requires input/output.',
      );
    }
  }
  if (!Object.hasOwn(record, 'input')) fail('$.input', 'missing required field.');

  const input = context.normalizeInput(record.input, fieldSources?.input ?? source);
  let hasParameterSlots = false;
  if (operation === 'select') {
    const selectMax = record.selectMax === undefined ? true : record.selectMax;
    if (typeof selectMax !== 'boolean') {
      fail('$.selectMax', 'Selector configuration selectMax must be a concrete boolean.');
    }
    const indexValue = record.index === undefined ? 0 : record.index;
    let index:
      | number
      | SignalId
      | BlueprintNumberParameterHandle
      | BlueprintSignalParameterHandle
      | NonNullable<ReturnType<typeof findSourceNumericExpressionView>>['expression'];
    if (session !== undefined) {
      const expressionView = findSourceNumericExpressionView(indexValue);
      if (expressionView === undefined && context.isSignal(indexValue)) {
        index = context.snapshotSignal(indexValue);
      } else {
        const prepared = symbolicIndex(indexValue, 'index', session);
        if (prepared.symbolic) {
          hasParameterSlots = true;
          index = prepared.value;
        } else if (typeof indexValue === 'number') {
          index = indexValue;
        } else {
          fail('$.index', 'Selector configuration index must be a safe integer or a Signal.');
        }
      }
      try {
        const template = createSelectorConfigurationTemplate(session, {
          operation,
          input,
          selectMax,
          index,
        });
        return Object.freeze({ template, hasParameterSlots });
      } catch (error) {
        adaptParameterError(error, '$.index');
      }
    }
    if (typeof indexValue === 'number') {
      try {
        index = circuitConstant(indexValue);
      } catch (error) {
        fail('$.index', 'Selector configuration index must be a safe integer or a Signal.', error);
      }
    } else if (context.isSignal(indexValue)) {
      index = context.snapshotSignal(indexValue);
    } else {
      fail('$.index', 'Selector configuration index must be a safe integer or a Signal.');
    }
    return Object.freeze({
      configuration: Object.freeze({ operation, input, selectMax, index }),
      hasParameterSlots: false,
    });
  }

  if (!Object.hasOwn(record, 'output')) fail('$.output', 'missing required field.');
  const outputValue = record.output;
  if (session !== undefined) {
    let output: SignalId | BlueprintSignalParameterHandle;
    if (
      findSourceNumericExpressionView(outputValue) === undefined &&
      context.isSignal(outputValue)
    ) {
      output = context.snapshotSignal(outputValue);
    } else {
      const prepared = symbolicIndex(outputValue, 'output', session);
      if (prepared.symbolic) {
        hasParameterSlots = true;
        output = prepared.value as BlueprintSignalParameterHandle;
      } else {
        fail('$.output', 'Selector count configuration output must be a Signal.');
      }
    }
    try {
      const template = createSelectorConfigurationTemplate(session, {
        operation,
        input,
        output,
      });
      return Object.freeze({ template, hasParameterSlots });
    } catch (error) {
      adaptParameterError(error, '$.output');
    }
  }
  if (!context.isSignal(outputValue)) {
    fail('$.output', 'Selector count configuration output must be a Signal.');
  }
  return Object.freeze({
    configuration: Object.freeze({
      operation,
      input,
      output: context.snapshotSignal(outputValue),
    }),
    hasParameterSlots: false,
  });
}

/** Materializes a prepared template only at the owning exact-constructor boundary. */
export function bindPreparedSelectorConfigurationSource(
  prepared: PreparedSelectorConfigurationSource,
  bindings: readonly BlueprintParameterBinding[] = [],
): SelectorProducerConfig {
  if ('configuration' in prepared) return prepared.configuration;
  try {
    return bindSelectorConfigurationTemplate(prepared.template, bindings);
  } catch (error) {
    adaptParameterError(error, '$');
  }
}

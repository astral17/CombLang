import {
  constantConfigurationLimits,
  Signal,
  signalTypes,
  type SignalId,
  type SignalType,
} from '@comblang/factorio';
import {
  LosslessJsonNumber,
  LosslessJsonObject,
  type LosslessJsonValue,
} from '@comblang/blueprint/document';
import type { NetworkId } from '@comblang/shared';

import type { LogicalNetworkRef, SelectorIndex, SelectorProducerConfig } from './ir.js';

export interface DecodeBlueprintSelectorControlBehaviorOptions {
  readonly path?: string;
  readonly signal?: AbortSignal;
}

export interface BlueprintSelectorImportDiagnostic {
  readonly category: 'unsupported-selector-configuration';
  readonly message: string;
  readonly path: string;
}

export type BlueprintSelectorImportResult =
  | {
      readonly state: 'complete';
      readonly configuration: SelectorProducerConfig;
      readonly diagnostics: readonly [];
    }
  | {
      readonly state: 'blocked';
      readonly configuration: undefined;
      readonly diagnostics: readonly [BlueprintSelectorImportDiagnostic];
    };

interface ResolvedOptions {
  readonly path: string;
  readonly signal: AbortSignal | undefined;
}

interface StringByteBudget {
  bytes: number;
}

const identifierKeyPattern = /^[A-Za-z_$][\w$]*(?![\s\S])/;
const virtualWildcards = new Set(['signal-each', 'signal-anything', 'signal-everything']);
const rootFields = ['operation', 'select_max', 'index_constant', 'index_signal', 'count_signal'];

function resolveOptions(
  options: DecodeBlueprintSelectorControlBehaviorOptions | undefined,
): ResolvedOptions {
  if (options === undefined) return { path: '$', signal: undefined };
  if (
    typeof options !== 'object' ||
    options === null ||
    Array.isArray(options) ||
    (Object.getPrototypeOf(options) !== Object.prototype && Object.getPrototypeOf(options) !== null)
  ) {
    throw new TypeError('Blueprint Selector decoder options must be a plain object.');
  }

  let path = '$';
  let signal: AbortSignal | undefined;
  for (const key of Reflect.ownKeys(options)) {
    if (typeof key !== 'string' || (key !== 'path' && key !== 'signal')) {
      throw new TypeError(`Unknown blueprint Selector decoder option: ${String(key)}.`);
    }
    const descriptor = Object.getOwnPropertyDescriptor(options, key);
    if (descriptor === undefined || !('value' in descriptor)) {
      throw new TypeError(`Blueprint Selector decoder option ${key} must be a data property.`);
    }
    if (key === 'path') {
      if (descriptor.value !== undefined && typeof descriptor.value !== 'string') {
        throw new TypeError('Blueprint Selector decoder path must be a string.');
      }
      if (typeof descriptor.value === 'string') path = descriptor.value;
    } else if (descriptor.value !== undefined) {
      const candidate: unknown = descriptor.value;
      if (
        typeof candidate !== 'object' ||
        candidate === null ||
        typeof (candidate as AbortSignal).aborted !== 'boolean'
      ) {
        throw new TypeError('Blueprint Selector decoder signal must be an AbortSignal.');
      }
      signal = candidate as AbortSignal;
    }
  }
  return { path, signal };
}

function checkAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  const error = new Error('Blueprint Selector decoding was cancelled.');
  error.name = 'AbortError';
  throw error;
}

function assertPlainObject(
  value: unknown,
  label: string,
): asserts value is Record<PropertyKey, unknown> {
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)
  ) {
    throw new TypeError(`Blueprint Selector ${label} must be a plain object.`);
  }
}

function exactDataProperties(
  value: Record<PropertyKey, unknown>,
  expected: readonly string[],
  label: string,
): Map<string, unknown> {
  const keys = Reflect.ownKeys(value);
  if (
    keys.length !== expected.length ||
    keys.some((key) => typeof key !== 'string' || !expected.includes(key))
  ) {
    throw new TypeError(`Blueprint Selector ${label} has unknown or missing own properties.`);
  }
  const result = new Map<string, unknown>();
  for (const key of expected) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !('value' in descriptor)) {
      throw new TypeError(`Blueprint Selector ${label} property ${key} must be a data property.`);
    }
    result.set(key, descriptor.value);
  }
  return result;
}

function networkId(value: unknown, label: string): NetworkId {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(`Blueprint Selector ${label} must be a non-empty Network ID.`);
  }
  return value as NetworkId;
}

function resolveInput(
  input: LogicalNetworkRef,
  signal: AbortSignal | undefined,
): LogicalNetworkRef {
  checkAborted(signal);
  assertPlainObject(input, 'input reference');
  const kindDescriptor = Object.getOwnPropertyDescriptor(input, 'refKind');
  if (kindDescriptor === undefined || !('value' in kindDescriptor)) {
    throw new TypeError('Blueprint Selector input reference refKind must be a data property.');
  }

  if (kindDescriptor.value === 'single') {
    const fields = exactDataProperties(input, ['refKind', 'network'], 'single input reference');
    const network = networkId(fields.get('network'), 'input network');
    return Object.freeze({ refKind: 'single', network });
  }

  if (kindDescriptor.value !== 'pair') {
    throw new TypeError('Blueprint Selector input reference must be single or pair.');
  }
  const fields = exactDataProperties(input, ['refKind', 'networks'], 'pair input reference');
  const tuple = fields.get('networks');
  if (
    !Array.isArray(tuple) ||
    Object.getPrototypeOf(tuple) !== Array.prototype ||
    tuple.length !== 2
  ) {
    throw new TypeError('Blueprint Selector pair input must contain exactly two Network IDs.');
  }
  const tupleKeys = Reflect.ownKeys(tuple);
  if (
    tupleKeys.length !== 3 ||
    !tupleKeys.includes('0') ||
    !tupleKeys.includes('1') ||
    !tupleKeys.includes('length')
  ) {
    throw new TypeError('Blueprint Selector pair input must be a dense two-element data tuple.');
  }
  const firstDescriptor = Object.getOwnPropertyDescriptor(tuple, '0');
  const secondDescriptor = Object.getOwnPropertyDescriptor(tuple, '1');
  if (
    firstDescriptor === undefined ||
    !('value' in firstDescriptor) ||
    secondDescriptor === undefined ||
    !('value' in secondDescriptor)
  ) {
    throw new TypeError('Blueprint Selector pair input elements must be data properties.');
  }
  checkAborted(signal);
  const first = networkId(firstDescriptor.value, 'first input network');
  const second = networkId(secondDescriptor.value, 'second input network');
  if (first === second) {
    throw new TypeError('Blueprint Selector pair input Network IDs must be distinct.');
  }
  return Object.freeze({ refKind: 'pair', networks: Object.freeze([first, second] as const) });
}

function diagnostic(message: string, path: string): BlueprintSelectorImportDiagnostic {
  return Object.freeze({ category: 'unsupported-selector-configuration', message, path });
}

function blocked(message: string, path: string): BlueprintSelectorImportResult {
  const diagnostics: readonly [BlueprintSelectorImportDiagnostic] = Object.freeze([
    diagnostic(message, path),
  ]);
  return Object.freeze({ state: 'blocked', configuration: undefined, diagnostics });
}

function complete(configuration: SelectorProducerConfig): BlueprintSelectorImportResult {
  const diagnostics: readonly [] = Object.freeze([]);
  return Object.freeze({ state: 'complete', configuration, diagnostics });
}

function isObjectNode(value: LosslessJsonValue | undefined): value is LosslessJsonObject {
  return (
    value instanceof LosslessJsonObject &&
    Object.getPrototypeOf(value) === LosslessJsonObject.prototype
  );
}

function pathForKey(path: string, key: string): string {
  return identifierKeyPattern.test(key) ? `${path}.${key}` : `${path}[${JSON.stringify(key)}]`;
}

function unknownField(
  value: LosslessJsonObject,
  allowed: readonly string[],
  path: string,
  signal: AbortSignal | undefined,
): BlueprintSelectorImportDiagnostic | undefined {
  for (const [key] of value.entries) {
    checkAborted(signal);
    if (!allowed.includes(key))
      return diagnostic(`Unsupported field ${key}.`, pathForKey(path, key));
  }
  return undefined;
}

function has(value: LosslessJsonObject, key: string): boolean {
  return value.get(key) !== undefined;
}

function exactInt32(value: LosslessJsonValue | undefined): number | undefined {
  if (!(value instanceof LosslessJsonNumber)) return undefined;
  const number = value.toNumberIfExact();
  return number !== undefined &&
    Number.isInteger(number) &&
    number >= -2_147_483_648 &&
    number <= 2_147_483_647
    ? number
    : undefined;
}

function jsonStringByteLength(
  value: string,
  stopAfter: number,
  signal: AbortSignal | undefined,
): number {
  let bytes = 2;
  if (bytes > stopAfter) return bytes;
  for (let index = 0; index < value.length; index += 1) {
    if (index % 1024 === 0) checkAborted(signal);
    const unit = value.charCodeAt(index);
    if (unit === 0x22 || unit === 0x5c) bytes += 2;
    else if (unit < 0x20) {
      bytes +=
        unit === 0x08 || unit === 0x09 || unit === 0x0a || unit === 0x0c || unit === 0x0d ? 2 : 6;
    } else if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        index += 1;
      } else bytes += 6;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) bytes += 6;
    else if (unit <= 0x7f) bytes += 1;
    else if (unit <= 0x7ff) bytes += 2;
    else bytes += 3;
    if (bytes > stopAfter) return bytes;
  }
  return bytes;
}

function addBudgetString(
  value: string,
  budget: StringByteBudget,
  signal: AbortSignal | undefined,
): void {
  checkAborted(signal);
  const remaining = constantConfigurationLimits.maxBytes - budget.bytes;
  const bytes = jsonStringByteLength(value, remaining, signal);
  if (bytes > remaining) {
    throw new RangeError(
      `Selector configuration exceeds the byte limit of ${constantConfigurationLimits.maxBytes}.`,
    );
  }
  budget.bytes += bytes;
}

function signalValue(
  value: LosslessJsonValue | undefined,
  path: string,
  budget: StringByteBudget,
  abortSignal: AbortSignal | undefined,
): SignalId | BlueprintSelectorImportResult {
  if (!isObjectNode(value)) return blocked('Expected a concrete signal object.', path);
  const unknown = unknownField(value, ['name', 'type', 'quality'], path, abortSignal);
  if (unknown !== undefined) return blocked(unknown.message, unknown.path);

  const namePath = `${path}.name`;
  const nameValue = value.get('name');
  if (nameValue === undefined) return blocked('Required signal name is missing.', namePath);
  if (typeof nameValue !== 'string' || nameValue.length === 0) {
    return blocked('Expected a non-empty signal name.', namePath);
  }
  if (nameValue.includes('\u0000')) return blocked('Signal name contains NUL.', namePath);

  const typePath = `${path}.type`;
  const typeValue = value.get('type');
  let type: SignalType = 'item';
  if (typeValue !== undefined) {
    if (typeof typeValue !== 'string' || !signalTypes.includes(typeValue as SignalType)) {
      return blocked('Expected a supported Signal type.', typePath);
    }
    type = typeValue as SignalType;
  }

  const qualityPath = `${path}.quality`;
  const qualityValue = value.get('quality');
  if (
    qualityValue !== undefined &&
    (typeof qualityValue !== 'string' || qualityValue.length === 0)
  ) {
    return blocked('Expected a non-empty signal quality.', qualityPath);
  }
  if (typeof qualityValue === 'string' && qualityValue.includes('\u0000')) {
    return blocked('Signal quality contains NUL.', qualityPath);
  }
  if (type === 'virtual' && virtualWildcards.has(nameValue)) {
    return blocked(
      'Selector index and count signals must be concrete, not virtual wildcards.',
      namePath,
    );
  }

  addBudgetString(type, budget, abortSignal);
  addBudgetString(nameValue, budget, abortSignal);
  if (qualityValue !== undefined) addBudgetString(qualityValue, budget, abortSignal);
  try {
    return qualityValue === undefined
      ? Signal(type, nameValue)
      : Signal(type, nameValue, qualityValue);
  } catch (error) {
    if (!(error instanceof TypeError)) throw error;
    return blocked(error.message, namePath);
  }
}

function serializedByteLength(configuration: SelectorProducerConfig): number {
  return new TextEncoder().encode(JSON.stringify(configuration)).byteLength;
}

/** Decodes only explicit Select and Count control_behavior emitted by the current native exporter. */
export function decodeBlueprintSelectorControlBehavior(
  value: LosslessJsonValue | undefined,
  input: LogicalNetworkRef,
  options?: DecodeBlueprintSelectorControlBehaviorOptions,
): BlueprintSelectorImportResult {
  const resolved = resolveOptions(options);
  checkAborted(resolved.signal);
  const budget: StringByteBudget = { bytes: 0 };
  const resolvedInput = resolveInput(input, resolved.signal);
  addBudgetString(resolvedInput.refKind, budget, resolved.signal);
  if (resolvedInput.refKind === 'single') {
    addBudgetString(resolvedInput.network, budget, resolved.signal);
  } else {
    addBudgetString(resolvedInput.networks[0], budget, resolved.signal);
    addBudgetString(resolvedInput.networks[1], budget, resolved.signal);
  }
  checkAborted(resolved.signal);

  if (!isObjectNode(value)) return blocked('Expected a control_behavior object.', resolved.path);
  const rootUnknown = unknownField(value, rootFields, resolved.path, resolved.signal);
  if (rootUnknown !== undefined) return blocked(rootUnknown.message, rootUnknown.path);

  const operationPath = `${resolved.path}.operation`;
  const operationValue = value.get('operation');
  if (operationValue === undefined) return blocked('Required operation is missing.', operationPath);
  if (operationValue !== 'select' && operationValue !== 'count') {
    return blocked('Expected the explicit Select or Count operation.', operationPath);
  }
  addBudgetString(operationValue, budget, resolved.signal);

  if (operationValue === 'select') {
    if (has(value, 'count_signal')) {
      return blocked('Count fields are unsupported for Select.', `${resolved.path}.count_signal`);
    }
    const selectMaxPath = `${resolved.path}.select_max`;
    const selectMaxValue = value.get('select_max');
    if (selectMaxValue === undefined) {
      return blocked('Required select_max boolean is missing.', selectMaxPath);
    }
    if (typeof selectMaxValue !== 'boolean') return blocked('Expected a boolean.', selectMaxPath);

    const hasConstant = has(value, 'index_constant');
    const hasSignal = has(value, 'index_signal');
    if (!hasConstant && !hasSignal) {
      return blocked(
        'Exactly one Select index field is required.',
        `${resolved.path}.index_constant`,
      );
    }
    if (hasConstant && hasSignal) {
      return blocked(
        'Select cannot specify both index_constant and index_signal.',
        `${resolved.path}.index_signal`,
      );
    }

    let index: SelectorIndex;
    if (hasConstant) {
      const indexPath = `${resolved.path}.index_constant`;
      const decoded = exactInt32(value.get('index_constant'));
      if (decoded === undefined) return blocked('Expected an exact signed int32 index.', indexPath);
      index = decoded;
    } else {
      const indexPath = `${resolved.path}.index_signal`;
      const decoded = signalValue(value.get('index_signal'), indexPath, budget, resolved.signal);
      if ('state' in decoded) return decoded;
      index = decoded;
    }

    const configuration: SelectorProducerConfig = Object.freeze({
      operation: 'select',
      input: resolvedInput,
      selectMax: selectMaxValue,
      index,
    });
    checkAborted(resolved.signal);
    if (serializedByteLength(configuration) > constantConfigurationLimits.maxBytes) {
      throw new RangeError(
        `Selector configuration exceeds the byte limit of ${constantConfigurationLimits.maxBytes}.`,
      );
    }
    return complete(configuration);
  }

  for (const field of ['select_max', 'index_constant', 'index_signal'] as const) {
    if (has(value, field)) {
      return blocked(
        `Select field ${field} is unsupported for Count.`,
        `${resolved.path}.${field}`,
      );
    }
  }
  const outputPath = `${resolved.path}.count_signal`;
  const output = signalValue(value.get('count_signal'), outputPath, budget, resolved.signal);
  if ('state' in output) return output;
  const configuration: SelectorProducerConfig = Object.freeze({
    operation: 'count',
    input: resolvedInput,
    output,
  });
  checkAborted(resolved.signal);
  if (serializedByteLength(configuration) > constantConfigurationLimits.maxBytes) {
    throw new RangeError(
      `Selector configuration exceeds the byte limit of ${constantConfigurationLimits.maxBytes}.`,
    );
  }
  return complete(configuration);
}

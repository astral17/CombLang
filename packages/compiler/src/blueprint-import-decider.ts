import {
  constantConfigurationLimits,
  Signal,
  signalTypes,
  type SignalType,
} from '@comblang/factorio';
import {
  LosslessJsonArray,
  LosslessJsonNumber,
  LosslessJsonObject,
  type LosslessJsonValue,
} from '@comblang/blueprint/document';
import type { NetworkId } from '@comblang/shared';

import type {
  Comparator,
  DeciderProducerConfig,
  LogicalConditionLeft,
  LogicalDeciderCondition,
  LogicalDeciderOutput,
  LogicalDeciderOutputSignal,
  LogicalNetworkRef,
  LogicalScalarOperand,
  Quantifier,
} from './ir.js';

export interface DecodeBlueprintDeciderControlBehaviorOptions {
  readonly path?: string;
  readonly signal?: AbortSignal;
}

export interface BlueprintDeciderImportDiagnostic {
  readonly category: 'unsupported-decider-configuration';
  readonly message: string;
  readonly path: string;
}

export type BlueprintDeciderImportResult =
  | {
      readonly state: 'complete';
      readonly configuration: DeciderProducerConfig;
      readonly diagnostics: readonly [];
    }
  | {
      readonly state: 'blocked';
      readonly configuration: undefined;
      readonly diagnostics: readonly [BlueprintDeciderImportDiagnostic];
    };

export interface BlueprintDeciderInputNetworks {
  readonly red?: NetworkId;
  readonly green?: NetworkId;
}

interface ResolvedOptions {
  readonly path: string;
  readonly signal: AbortSignal | undefined;
}

interface ResolvedNetworks {
  readonly red?: NetworkId;
  readonly green?: NetworkId;
}

interface StringByteBudget {
  bytes: number;
}

type DecodedSignal =
  | { readonly kind: 'signal'; readonly signal: ReturnType<typeof Signal> }
  | { readonly kind: 'wildcard'; readonly value: Quantifier };

const maxConditionRows = 1024;
const maxOutputRows = 1024;

const comparatorFromNative: Readonly<Record<string, Comparator>> = Object.freeze({
  '>': '>',
  '<': '<',
  '=': '=',
  '≥': '>=',
  '≤': '<=',
  '≠': '!=',
});

const quantifierFromWildcard: Readonly<Record<string, Quantifier>> = Object.freeze({
  'signal-each': 'each',
  'signal-anything': 'anything',
  'signal-everything': 'everything',
});

function resolveOptions(
  options: DecodeBlueprintDeciderControlBehaviorOptions | undefined,
): ResolvedOptions {
  if (options === undefined) return { path: '$', signal: undefined };
  if (
    typeof options !== 'object' ||
    options === null ||
    Array.isArray(options) ||
    (Object.getPrototypeOf(options) !== Object.prototype && Object.getPrototypeOf(options) !== null)
  ) {
    throw new TypeError('Blueprint Decider decoder options must be a plain object.');
  }
  let path = '$';
  let signal: AbortSignal | undefined;
  for (const key of Reflect.ownKeys(options)) {
    if (typeof key !== 'string' || (key !== 'path' && key !== 'signal')) {
      throw new TypeError(`Unknown blueprint Decider decoder option: ${String(key)}.`);
    }
    const descriptor = Object.getOwnPropertyDescriptor(options, key);
    if (descriptor === undefined || !('value' in descriptor)) {
      throw new TypeError(`Blueprint Decider decoder option ${key} must be a data property.`);
    }
    if (key === 'path') {
      if (descriptor.value !== undefined && typeof descriptor.value !== 'string') {
        throw new TypeError('Blueprint Decider decoder path must be a string.');
      }
      if (typeof descriptor.value === 'string') path = descriptor.value;
    } else if (descriptor.value !== undefined) {
      const candidate: unknown = descriptor.value;
      if (
        typeof candidate !== 'object' ||
        candidate === null ||
        typeof (candidate as AbortSignal).aborted !== 'boolean'
      ) {
        throw new TypeError('Blueprint Decider decoder signal must be an AbortSignal.');
      }
      signal = candidate as AbortSignal;
    }
  }
  return { path, signal };
}

function checkAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  const error = new Error('Blueprint Decider decoding was cancelled.');
  error.name = 'AbortError';
  throw error;
}

function resolveNetworks(
  inputNetworks: BlueprintDeciderInputNetworks,
  signal: AbortSignal | undefined,
): ResolvedNetworks {
  if (
    typeof inputNetworks !== 'object' ||
    inputNetworks === null ||
    Array.isArray(inputNetworks) ||
    (Object.getPrototypeOf(inputNetworks) !== Object.prototype &&
      Object.getPrototypeOf(inputNetworks) !== null)
  ) {
    throw new TypeError('Blueprint Decider input networks must be a plain object.');
  }
  const networks: { red?: NetworkId; green?: NetworkId } = {};
  for (const key of Reflect.ownKeys(inputNetworks)) {
    checkAborted(signal);
    if (typeof key !== 'string' || (key !== 'red' && key !== 'green')) {
      throw new TypeError(`Unknown blueprint Decider input network: ${String(key)}.`);
    }
    const descriptor = Object.getOwnPropertyDescriptor(inputNetworks, key);
    if (descriptor === undefined || !('value' in descriptor)) {
      throw new TypeError(`Blueprint Decider input network ${key} must be a data property.`);
    }
    if (typeof descriptor.value !== 'string' || descriptor.value.length === 0) {
      throw new TypeError(`Blueprint Decider input network ${key} must be a non-empty ID.`);
    }
    networks[key] = descriptor.value as NetworkId;
  }
  if (
    networks.red !== undefined &&
    networks.green !== undefined &&
    networks.red === networks.green
  ) {
    throw new TypeError('Blueprint Decider red and green input Network IDs must be distinct.');
  }
  return networks;
}

function diagnostic(message: string, path: string): BlueprintDeciderImportDiagnostic {
  return Object.freeze({ category: 'unsupported-decider-configuration', message, path });
}

function blocked(message: string, path: string): BlueprintDeciderImportResult {
  const diagnostics: readonly [BlueprintDeciderImportDiagnostic] = Object.freeze([
    diagnostic(message, path),
  ]);
  return Object.freeze({ state: 'blocked', configuration: undefined, diagnostics });
}

function complete(configuration: DeciderProducerConfig): BlueprintDeciderImportResult {
  const diagnostics: readonly [] = Object.freeze([]);
  return Object.freeze({ state: 'complete', configuration, diagnostics });
}

function isObjectNode(value: LosslessJsonValue | undefined): value is LosslessJsonObject {
  return (
    value instanceof LosslessJsonObject &&
    Object.getPrototypeOf(value) === LosslessJsonObject.prototype
  );
}

function isArrayNode(value: LosslessJsonValue | undefined): value is LosslessJsonArray {
  return (
    value instanceof LosslessJsonArray &&
    Object.getPrototypeOf(value) === LosslessJsonArray.prototype
  );
}

const identifierKeyPattern = /^[A-Za-z_$][\w$]*(?![\s\S])/;

function pathForKey(path: string, key: string): string {
  return identifierKeyPattern.test(key) ? `${path}.${key}` : `${path}[${JSON.stringify(key)}]`;
}

function unknownField(
  value: LosslessJsonObject,
  allowed: readonly string[],
  path: string,
  signal: AbortSignal | undefined,
): BlueprintDeciderImportDiagnostic | undefined {
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
  const remaining = constantConfigurationLimits.maxBytes - budget.bytes;
  const bytes = jsonStringByteLength(value, remaining, signal);
  if (bytes > remaining) {
    throw new RangeError(
      `Decider configuration exceeds the byte limit of ${constantConfigurationLimits.maxBytes}.`,
    );
  }
  budget.bytes += bytes;
}

function decodedSignal(
  value: LosslessJsonValue | undefined,
  path: string,
  budget: StringByteBudget,
  signal: AbortSignal | undefined,
  allowWildcard: boolean,
): DecodedSignal | BlueprintDeciderImportResult {
  if (!isObjectNode(value)) return blocked('Expected a signal object.', path);
  const unknown = unknownField(value, ['name', 'type', 'quality'], path, signal);
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

  if (type === 'virtual' && Object.hasOwn(quantifierFromWildcard, nameValue)) {
    if (qualityValue !== undefined) {
      return blocked('A wildcard signal cannot have a quality.', qualityPath);
    }
    if (!allowWildcard) {
      return blocked('A comparison right operand must be a concrete signal.', namePath);
    }
    const quantifier = quantifierFromWildcard[nameValue]!;
    addBudgetString('wildcard', budget, signal);
    addBudgetString(quantifier, budget, signal);
    return Object.freeze({ kind: 'wildcard', value: quantifier });
  }

  addBudgetString('signal', budget, signal);
  addBudgetString(type, budget, signal);
  addBudgetString(nameValue, budget, signal);
  if (qualityValue !== undefined) addBudgetString(qualityValue, budget, signal);
  checkAborted(signal);
  try {
    return Object.freeze({
      kind: 'signal',
      signal: Signal(type, nameValue, qualityValue),
    });
  } catch (error) {
    if (!(error instanceof TypeError)) throw error;
    return blocked(error.message, namePath);
  }
}

function selectedNetworks(
  value: LosslessJsonValue | undefined,
  path: string,
  hostNetworks: ResolvedNetworks,
  budget: StringByteBudget,
  signal: AbortSignal | undefined,
): LogicalNetworkRef | BlueprintDeciderImportResult {
  if (!isObjectNode(value)) return blocked('Expected an input network mask object.', path);
  const unknown = unknownField(value, ['red', 'green'], path, signal);
  if (unknown !== undefined) return blocked(unknown.message, unknown.path);

  const redPath = `${path}.red`;
  const greenPath = `${path}.green`;
  const redValue = value.get('red');
  const greenValue = value.get('green');
  if (redValue === undefined) return blocked('Required red selection is missing.', redPath);
  if (typeof redValue !== 'boolean') return blocked('Expected a boolean.', redPath);
  if (greenValue === undefined) return blocked('Required green selection is missing.', greenPath);
  if (typeof greenValue !== 'boolean') return blocked('Expected a boolean.', greenPath);
  if (!redValue && !greenValue) return blocked('At least one input color must be selected.', path);
  if (redValue && hostNetworks.red === undefined) {
    return blocked('Selected red input Network is unavailable.', redPath);
  }
  if (greenValue && hostNetworks.green === undefined) {
    return blocked('Selected green input Network is unavailable.', greenPath);
  }

  if (redValue && greenValue) {
    const redNetwork = hostNetworks.red!;
    const greenNetwork = hostNetworks.green!;
    addBudgetString(redNetwork, budget, signal);
    addBudgetString(greenNetwork, budget, signal);
    return Object.freeze({
      refKind: 'pair',
      networks: Object.freeze([redNetwork, greenNetwork] as const),
    });
  }
  addBudgetString('single', budget, signal);
  const network = redValue ? hostNetworks.red! : hostNetworks.green!;
  addBudgetString(network, budget, signal);
  return Object.freeze({ refKind: 'single', network });
}

function leftOperand(
  row: LosslessJsonObject,
  path: string,
  hostNetworks: ResolvedNetworks,
  budget: StringByteBudget,
  signal: AbortSignal | undefined,
): LogicalConditionLeft | BlueprintDeciderImportResult {
  const signalPath = `${path}.first_signal`;
  const networksPath = `${path}.first_signal_networks`;
  const decoded = decodedSignal(row.get('first_signal'), signalPath, budget, signal, true);
  if ('state' in decoded) return decoded;
  const reference = selectedNetworks(
    row.get('first_signal_networks'),
    networksPath,
    hostNetworks,
    budget,
    signal,
  );
  if ('state' in reference) return reference;
  return Object.freeze({ ...decoded, ...reference }) as LogicalConditionLeft;
}

function rightOperand(
  row: LosslessJsonObject,
  path: string,
  hostNetworks: ResolvedNetworks,
  budget: StringByteBudget,
  signal: AbortSignal | undefined,
): LogicalScalarOperand | BlueprintDeciderImportResult {
  const constantPresent = has(row, 'constant');
  const signalPresent = has(row, 'second_signal');
  const networksPresent = has(row, 'second_signal_networks');
  const constantPath = `${path}.constant`;
  const signalPath = `${path}.second_signal`;
  const networksPath = `${path}.second_signal_networks`;

  if (constantPresent && signalPresent) {
    return blocked(
      'A comparison right operand cannot specify both constant and signal forms.',
      signalPath,
    );
  }
  if (!constantPresent && !signalPresent) {
    return blocked('A comparison right operand is required.', constantPath);
  }
  if (constantPresent) {
    if (networksPresent) {
      return blocked('A constant right operand cannot have an input network mask.', networksPath);
    }
    const value = exactInt32(row.get('constant'));
    if (value === undefined)
      return blocked('Expected an exact signed int32 constant.', constantPath);
    return Object.freeze({ kind: 'constant', value });
  }
  if (!networksPresent) {
    return blocked('A right signal requires an explicit network mask.', networksPath);
  }
  const decoded = decodedSignal(row.get('second_signal'), signalPath, budget, signal, false);
  if ('state' in decoded) return decoded;
  const reference = selectedNetworks(
    row.get('second_signal_networks'),
    networksPath,
    hostNetworks,
    budget,
    signal,
  );
  if ('state' in reference) return reference;
  return Object.freeze({ ...decoded, ...reference }) as Extract<
    LogicalScalarOperand,
    { kind: 'signal' }
  >;
}

function comparison(
  row: LosslessJsonObject,
  path: string,
  hostNetworks: ResolvedNetworks,
  budget: StringByteBudget,
  signal: AbortSignal | undefined,
): Extract<LogicalDeciderCondition, { kind: 'compare' }> | BlueprintDeciderImportResult {
  const comparatorPath = `${path}.comparator`;
  const comparatorValue = row.get('comparator');
  if (comparatorValue === undefined)
    return blocked('Required comparator is missing.', comparatorPath);
  if (
    typeof comparatorValue !== 'string' ||
    !Object.hasOwn(comparatorFromNative, comparatorValue)
  ) {
    return blocked('Expected an exact supported Decider comparator.', comparatorPath);
  }
  const left = leftOperand(row, path, hostNetworks, budget, signal);
  if ('state' in left) return left;
  checkAborted(signal);
  const right = rightOperand(row, path, hostNetworks, budget, signal);
  if ('state' in right) return right;
  return Object.freeze({
    kind: 'compare',
    left,
    comparator: comparatorFromNative[comparatorValue]!,
    right,
  });
}

function outputSignal(
  value: LosslessJsonValue | undefined,
  path: string,
  budget: StringByteBudget,
  signal: AbortSignal | undefined,
): LogicalDeciderOutputSignal | BlueprintDeciderImportResult {
  const decoded = decodedSignal(value, path, budget, signal, true);
  if ('state' in decoded) return decoded;
  return decoded.kind === 'wildcard'
    ? Object.freeze({ kind: 'wildcard', value: decoded.value })
    : Object.freeze({ kind: 'signal', signal: decoded.signal });
}

function outputEntry(
  value: LosslessJsonValue | undefined,
  path: string,
  hostNetworks: ResolvedNetworks,
  budget: StringByteBudget,
  signal: AbortSignal | undefined,
): LogicalDeciderOutput | BlueprintDeciderImportResult {
  if (!isObjectNode(value)) return blocked('Expected an output object.', path);
  const unknown = unknownField(
    value,
    ['signal', 'copy_count_from_input', 'networks', 'constant'],
    path,
    signal,
  );
  if (unknown !== undefined) return blocked(unknown.message, unknown.path);

  const signalPath = `${path}.signal`;
  const decodedSignalValue = outputSignal(value.get('signal'), signalPath, budget, signal);
  if ('state' in decodedSignalValue) return decodedSignalValue;

  const copyPath = `${path}.copy_count_from_input`;
  const copyValue = value.get('copy_count_from_input');
  if (copyValue === undefined)
    return blocked('Required copy_count_from_input flag is missing.', copyPath);
  if (typeof copyValue !== 'boolean') return blocked('Expected a boolean.', copyPath);

  let input: LogicalNetworkRef | undefined;
  if (has(value, 'networks')) {
    const reference = selectedNetworks(
      value.get('networks'),
      `${path}.networks`,
      hostNetworks,
      budget,
      signal,
    );
    if ('state' in reference) return reference;
    input = reference;
  }

  const constantPath = `${path}.constant`;
  const constantPresent = has(value, 'constant');
  if (copyValue) {
    if (constantPresent) {
      return blocked('A copied-count output cannot specify a constant.', constantPath);
    }
    return Object.freeze({
      mode: 'copy',
      signal: decodedSignalValue,
      ...(input === undefined ? {} : { input }),
    });
  }
  if (!constantPresent)
    return blocked('A constant output requires an explicit constant.', constantPath);
  const constant = exactInt32(value.get('constant'));
  if (constant === undefined)
    return blocked('Expected an exact signed int32 constant.', constantPath);
  return Object.freeze({
    mode: 'constant',
    signal: decodedSignalValue,
    value: constant,
    ...(input === undefined ? {} : { input }),
  });
}

function groupNode(
  group: readonly Extract<LogicalDeciderCondition, { kind: 'compare' }>[],
): LogicalDeciderCondition {
  if (group.length === 1) return group[0]!;
  return Object.freeze({ kind: 'and', conditions: Object.freeze([...group]) });
}

function serializedByteLength(configuration: DeciderProducerConfig): number {
  return new TextEncoder().encode(JSON.stringify(configuration)).byteLength;
}

/**
 * Decodes only the explicit Decider control_behavior shape emitted by the current native
 * configuration exporter. This is structural configuration recovery, not game-default
 * inference, topology validation, semantic Decider evaluation, or native Factorio validation.
 */
export function decodeBlueprintDeciderControlBehavior(
  value: LosslessJsonValue | undefined,
  inputNetworks: BlueprintDeciderInputNetworks,
  options?: DecodeBlueprintDeciderControlBehaviorOptions,
): BlueprintDeciderImportResult {
  const resolved = resolveOptions(options);
  checkAborted(resolved.signal);
  const hostNetworks = resolveNetworks(inputNetworks, resolved.signal);
  checkAborted(resolved.signal);

  if (!isObjectNode(value)) return blocked('Expected a control_behavior object.', resolved.path);
  const rootUnknown = unknownField(value, ['decider_conditions'], resolved.path, resolved.signal);
  if (rootUnknown !== undefined) return blocked(rootUnknown.message, rootUnknown.path);

  const deciderPath = `${resolved.path}.decider_conditions`;
  const decider = value.get('decider_conditions');
  if (!isObjectNode(decider)) {
    return blocked('Required decider_conditions object is missing.', deciderPath);
  }
  const deciderUnknown = unknownField(
    decider,
    ['conditions', 'outputs', 'else_outputs'],
    deciderPath,
    resolved.signal,
  );
  if (deciderUnknown !== undefined) return blocked(deciderUnknown.message, deciderUnknown.path);

  const conditionsPath = `${deciderPath}.conditions`;
  const conditionsValue = decider.get('conditions');
  if (!isArrayNode(conditionsValue)) {
    return blocked('Required conditions array is missing.', conditionsPath);
  }
  if (conditionsValue.items.length === 0) {
    return blocked('At least one Decider condition row is required.', conditionsPath);
  }
  if (conditionsValue.items.length > maxConditionRows) {
    return blocked(
      `Decider conditions exceed the ${maxConditionRows}-row host limit.`,
      conditionsPath,
    );
  }

  const outputsPath = `${deciderPath}.outputs`;
  const outputsValue = decider.get('outputs');
  if (!isArrayNode(outputsValue)) return blocked('Required outputs array is missing.', outputsPath);

  const elseOutputsPresent = has(decider, 'else_outputs');
  const elseOutputsPath = `${deciderPath}.else_outputs`;
  const elseOutputsValue = elseOutputsPresent ? decider.get('else_outputs') : undefined;
  if (elseOutputsPresent && !isArrayNode(elseOutputsValue)) {
    return blocked('Expected an else_outputs array.', elseOutputsPath);
  }
  const elseOutputCount = isArrayNode(elseOutputsValue) ? elseOutputsValue.items.length : 0;
  if (outputsValue.items.length + elseOutputCount > maxOutputRows) {
    return blocked(
      `Combined Decider outputs exceed the ${maxOutputRows}-row host limit.`,
      outputsValue.items.length > maxOutputRows ? outputsPath : elseOutputsPath,
    );
  }

  const budget: StringByteBudget = { bytes: 0 };
  const groups: Array<Array<Extract<LogicalDeciderCondition, { kind: 'compare' }>>> = [[]];
  for (let index = 0; index < conditionsValue.items.length; index += 1) {
    checkAborted(resolved.signal);
    const rowPath = `${conditionsPath}[${index}]`;
    const rowValue = conditionsValue.items[index];
    if (!isObjectNode(rowValue)) return blocked('Expected a Decider condition object.', rowPath);
    const rowUnknown = unknownField(
      rowValue,
      [
        'first_signal',
        'first_signal_networks',
        'comparator',
        'second_signal',
        'second_signal_networks',
        'constant',
        'compare_type',
      ],
      rowPath,
      resolved.signal,
    );
    if (rowUnknown !== undefined) return blocked(rowUnknown.message, rowUnknown.path);

    const compareTypePath = `${rowPath}.compare_type`;
    const compareType = rowValue.get('compare_type');
    if (compareType !== 'and' && compareType !== 'or') {
      return blocked('Expected an explicit and/or comparison connector.', compareTypePath);
    }
    if (index === 0 && compareType !== 'and') {
      return blocked('The first Decider condition row must use and.', compareTypePath);
    }
    if (compareType === 'or' && index > 0) groups.push([]);
    checkAborted(resolved.signal);
    const decoded = comparison(rowValue, rowPath, hostNetworks, budget, resolved.signal);
    if ('state' in decoded) return decoded;
    groups[groups.length - 1]!.push(decoded);
  }

  const conditionGroups = groups.map(groupNode);
  const condition: LogicalDeciderCondition =
    conditionGroups.length === 1
      ? conditionGroups[0]!
      : Object.freeze({ kind: 'or', conditions: Object.freeze(conditionGroups) });

  const outputs: LogicalDeciderOutput[] = [];
  for (let index = 0; index < outputsValue.items.length; index += 1) {
    checkAborted(resolved.signal);
    const output = outputEntry(
      outputsValue.items[index],
      `${outputsPath}[${index}]`,
      hostNetworks,
      budget,
      resolved.signal,
    );
    if ('state' in output) return output;
    outputs.push(output);
  }

  const elseOutputs: LogicalDeciderOutput[] = [];
  if (isArrayNode(elseOutputsValue)) {
    for (let index = 0; index < elseOutputsValue.items.length; index += 1) {
      checkAborted(resolved.signal);
      const output = outputEntry(
        elseOutputsValue.items[index],
        `${elseOutputsPath}[${index}]`,
        hostNetworks,
        budget,
        resolved.signal,
      );
      if ('state' in output) return output;
      elseOutputs.push(output);
    }
  }

  checkAborted(resolved.signal);
  const configuration: DeciderProducerConfig = Object.freeze({
    condition,
    outputs: Object.freeze(outputs),
    ...(elseOutputsPresent ? { elseOutputs: Object.freeze(elseOutputs) } : {}),
  });
  if (serializedByteLength(configuration) > constantConfigurationLimits.maxBytes) {
    throw new RangeError(
      `Decider configuration exceeds the byte limit of ${constantConfigurationLimits.maxBytes}.`,
    );
  }
  checkAborted(resolved.signal);
  return complete(configuration);
}

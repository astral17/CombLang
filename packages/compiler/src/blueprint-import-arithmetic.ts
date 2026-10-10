import {
  constantConfigurationLimits,
  Signal,
  signalTypes,
  type SignalType,
} from '@comblang/factorio';
import {
  LosslessJsonNumber,
  LosslessJsonObject,
  type LosslessJsonValue,
} from '@comblang/blueprint/document';
import type { NetworkId } from '@comblang/shared';

import type {
  ArithmeticOperation,
  ArithmeticProducerConfig,
  LogicalArithmeticOperand,
  LogicalArithmeticOutput,
  LogicalNetworkRef,
} from './ir.js';

export interface DecodeBlueprintArithmeticControlBehaviorOptions {
  readonly path?: string;
  readonly signal?: AbortSignal;
}

export interface BlueprintArithmeticImportDiagnostic {
  readonly category: 'unsupported-arithmetic-configuration';
  readonly message: string;
  readonly path: string;
}

export type BlueprintArithmeticImportResult =
  | {
      readonly state: 'complete';
      readonly configuration: ArithmeticProducerConfig;
      readonly diagnostics: readonly [];
    }
  | {
      readonly state: 'blocked';
      readonly configuration: undefined;
      readonly diagnostics: readonly [BlueprintArithmeticImportDiagnostic];
    };

export interface BlueprintArithmeticInputNetworks {
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
  | { readonly kind: 'each' };

const operationFromNative: Readonly<Record<string, ArithmeticOperation>> = Object.freeze({
  '+': 'add',
  '-': 'subtract',
  '*': 'multiply',
  '/': 'divide',
  '%': 'modulo',
  '^': 'power',
  '<<': 'left-shift',
  '>>': 'right-shift',
  AND: 'bit-and',
  OR: 'bit-or',
  XOR: 'bit-xor',
});

function resolveOptions(
  options: DecodeBlueprintArithmeticControlBehaviorOptions | undefined,
): ResolvedOptions {
  if (options === undefined) return { path: '$', signal: undefined };
  if (
    typeof options !== 'object' ||
    options === null ||
    Array.isArray(options) ||
    (Object.getPrototypeOf(options) !== Object.prototype && Object.getPrototypeOf(options) !== null)
  ) {
    throw new TypeError('Blueprint Arithmetic decoder options must be a plain object.');
  }
  let path = '$';
  let signal: AbortSignal | undefined;
  for (const key of Reflect.ownKeys(options)) {
    if (typeof key !== 'string' || (key !== 'path' && key !== 'signal')) {
      throw new TypeError(`Unknown blueprint Arithmetic decoder option: ${String(key)}.`);
    }
    const descriptor = Object.getOwnPropertyDescriptor(options, key);
    if (descriptor === undefined || !('value' in descriptor)) {
      throw new TypeError(`Blueprint Arithmetic decoder option ${key} must be a data property.`);
    }
    if (key === 'path') {
      if (descriptor.value !== undefined && typeof descriptor.value !== 'string') {
        throw new TypeError('Blueprint Arithmetic decoder path must be a string.');
      }
      if (typeof descriptor.value === 'string') path = descriptor.value;
    } else if (descriptor.value !== undefined) {
      const candidate: unknown = descriptor.value;
      if (
        typeof candidate !== 'object' ||
        candidate === null ||
        typeof (candidate as AbortSignal).aborted !== 'boolean'
      ) {
        throw new TypeError('Blueprint Arithmetic decoder signal must be an AbortSignal.');
      }
      signal = candidate as AbortSignal;
    }
  }
  return { path, signal };
}

function checkAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  const error = new Error('Blueprint Arithmetic decoding was cancelled.');
  error.name = 'AbortError';
  throw error;
}

function resolveNetworks(
  inputNetworks: BlueprintArithmeticInputNetworks,
  signal: AbortSignal | undefined,
): ResolvedNetworks {
  if (
    typeof inputNetworks !== 'object' ||
    inputNetworks === null ||
    Array.isArray(inputNetworks) ||
    (Object.getPrototypeOf(inputNetworks) !== Object.prototype &&
      Object.getPrototypeOf(inputNetworks) !== null)
  ) {
    throw new TypeError('Blueprint Arithmetic input networks must be a plain object.');
  }
  const networks: { red?: NetworkId; green?: NetworkId } = {};
  for (const key of Reflect.ownKeys(inputNetworks)) {
    checkAborted(signal);
    if (typeof key !== 'string' || (key !== 'red' && key !== 'green')) {
      throw new TypeError(`Unknown blueprint Arithmetic input network: ${String(key)}.`);
    }
    const descriptor = Object.getOwnPropertyDescriptor(inputNetworks, key);
    if (descriptor === undefined || !('value' in descriptor)) {
      throw new TypeError(`Blueprint Arithmetic input network ${key} must be a data property.`);
    }
    if (typeof descriptor.value !== 'string' || descriptor.value.length === 0) {
      throw new TypeError(`Blueprint Arithmetic input network ${key} must be a non-empty ID.`);
    }
    networks[key] = descriptor.value as NetworkId;
  }
  if (
    networks.red !== undefined &&
    networks.green !== undefined &&
    networks.red === networks.green
  ) {
    throw new TypeError('Blueprint Arithmetic red and green input Network IDs must be distinct.');
  }
  return networks;
}

function diagnostic(message: string, path: string): BlueprintArithmeticImportDiagnostic {
  return Object.freeze({ category: 'unsupported-arithmetic-configuration', message, path });
}

function blocked(message: string, path: string): BlueprintArithmeticImportResult {
  const diagnostics: readonly [BlueprintArithmeticImportDiagnostic] = Object.freeze([
    diagnostic(message, path),
  ]);
  return Object.freeze({ state: 'blocked', configuration: undefined, diagnostics });
}

function complete(configuration: ArithmeticProducerConfig): BlueprintArithmeticImportResult {
  const diagnostics: readonly [] = Object.freeze([]);
  return Object.freeze({ state: 'complete', configuration, diagnostics });
}

function isObjectNode(value: LosslessJsonValue | undefined): value is LosslessJsonObject {
  return (
    value instanceof LosslessJsonObject &&
    Object.getPrototypeOf(value) === LosslessJsonObject.prototype
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
): BlueprintArithmeticImportDiagnostic | undefined {
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

function jsonStringByteLength(value: string, stopAfter: number): number {
  let bytes = 2;
  if (bytes > stopAfter) return bytes;
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit === 0x22 || unit === 0x5c) bytes += 2;
    else if (unit < 0x20)
      bytes +=
        unit === 0x08 || unit === 0x09 || unit === 0x0a || unit === 0x0c || unit === 0x0d ? 2 : 6;
    else if (unit >= 0xd800 && unit <= 0xdbff) {
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

function addBudgetString(value: string, budget: StringByteBudget): void {
  const remaining = constantConfigurationLimits.maxBytes - budget.bytes;
  const bytes = jsonStringByteLength(value, remaining);
  if (bytes > remaining) {
    throw new RangeError(
      `Arithmetic configuration exceeds the byte limit of ${constantConfigurationLimits.maxBytes}.`,
    );
  }
  budget.bytes += bytes;
}

function signalValue(
  value: LosslessJsonValue | undefined,
  path: string,
  budget: StringByteBudget,
  abortSignal: AbortSignal | undefined,
): DecodedSignal | BlueprintArithmeticImportResult {
  if (!isObjectNode(value)) return blocked('Expected a signal object.', path);
  const unknown = unknownField(value, ['name', 'type', 'quality'], path, abortSignal);
  if (unknown !== undefined) {
    const diagnostics: readonly [BlueprintArithmeticImportDiagnostic] = Object.freeze([unknown]);
    return Object.freeze({ state: 'blocked', configuration: undefined, diagnostics });
  }
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

  if (type === 'virtual' && nameValue === 'signal-each') {
    if (qualityValue !== undefined) {
      return blocked('A wildcard Each signal cannot have a quality.', qualityPath);
    }
    addBudgetString('each', budget);
    return { kind: 'each' };
  }
  if (
    type === 'virtual' &&
    (nameValue === 'signal-anything' || nameValue === 'signal-everything')
  ) {
    return blocked('Only the virtual Each wildcard is supported.', namePath);
  }

  addBudgetString('signal', budget);
  addBudgetString(type, budget);
  addBudgetString(nameValue, budget);
  if (qualityValue !== undefined) addBudgetString(qualityValue, budget);
  try {
    return { kind: 'signal', signal: Signal(type, nameValue, qualityValue) };
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
): LogicalNetworkRef | BlueprintArithmeticImportResult {
  if (!isObjectNode(value)) return blocked('Expected an input network mask object.', path);
  const unknown = unknownField(value, ['red', 'green'], path, signal);
  if (unknown !== undefined) {
    const diagnostics: readonly [BlueprintArithmeticImportDiagnostic] = Object.freeze([unknown]);
    return Object.freeze({ state: 'blocked', configuration: undefined, diagnostics });
  }
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
    const red = hostNetworks.red!;
    const green = hostNetworks.green!;
    addBudgetString(red, budget);
    addBudgetString(green, budget);
    return Object.freeze({ refKind: 'pair', networks: Object.freeze([red, green] as const) });
  }
  addBudgetString('single', budget);
  const network = redValue ? hostNetworks.red! : hostNetworks.green!;
  addBudgetString(network, budget);
  return Object.freeze({ refKind: 'single', network });
}

function operandValue(
  conditions: LosslessJsonObject,
  side: 'first' | 'second',
  conditionsPath: string,
  hostNetworks: ResolvedNetworks,
  budget: StringByteBudget,
  signal: AbortSignal | undefined,
): LogicalArithmeticOperand | BlueprintArithmeticImportResult {
  const constantKey = `${side}_constant`;
  const signalKey = `${side}_signal`;
  const networksKey = `${side}_signal_networks`;
  const constantPresent = has(conditions, constantKey);
  const signalPresent = has(conditions, signalKey);
  const networksPresent = has(conditions, networksKey);
  const constantPath = `${conditionsPath}.${constantKey}`;
  const signalPath = `${conditionsPath}.${signalKey}`;
  const networksPath = `${conditionsPath}.${networksKey}`;

  if (constantPresent && signalPresent) {
    return blocked('An operand cannot specify both constant and signal forms.', signalPath);
  }
  if (!constantPresent && !signalPresent) {
    return blocked('Required operand form is missing.', constantPath);
  }
  if (constantPresent) {
    if (networksPresent) {
      return blocked('A constant operand cannot have an input network mask.', networksPath);
    }
    const value = exactInt32(conditions.get(constantKey));
    if (value === undefined)
      return blocked('Expected an exact signed int32 constant.', constantPath);
    return Object.freeze({ kind: 'constant', value });
  }

  if (!networksPresent) return blocked('Required signal network mask is missing.', networksPath);
  const decoded = signalValue(conditions.get(signalKey), signalPath, budget, signal);
  if ('state' in decoded) return decoded;
  const reference = selectedNetworks(
    conditions.get(networksKey),
    networksPath,
    hostNetworks,
    budget,
    signal,
  );
  if ('state' in reference) return reference;
  return Object.freeze({ ...decoded, ...reference }) as LogicalArithmeticOperand;
}

function outputValue(
  value: LosslessJsonValue | undefined,
  path: string,
  budget: StringByteBudget,
  signal: AbortSignal | undefined,
): LogicalArithmeticOutput | BlueprintArithmeticImportResult {
  const decoded = signalValue(value, path, budget, signal);
  if ('state' in decoded) return decoded;
  if (decoded.kind === 'each') return Object.freeze({ kind: 'each' });
  return Object.freeze({ kind: 'signal', signal: decoded.signal });
}

function serializedByteLength(configuration: ArithmeticProducerConfig): number {
  return new TextEncoder().encode(JSON.stringify(configuration)).byteLength;
}

/** Decodes only the current exporter's explicit Arithmetic control_behavior form. */
export function decodeBlueprintArithmeticControlBehavior(
  value: LosslessJsonValue | undefined,
  inputNetworks: BlueprintArithmeticInputNetworks,
  options?: DecodeBlueprintArithmeticControlBehaviorOptions,
): BlueprintArithmeticImportResult {
  const resolved = resolveOptions(options);
  checkAborted(resolved.signal);
  const hostNetworks = resolveNetworks(inputNetworks, resolved.signal);
  checkAborted(resolved.signal);

  if (!isObjectNode(value)) return blocked('Expected a control_behavior object.', resolved.path);
  const rootUnknown = unknownField(
    value,
    ['arithmetic_conditions'],
    resolved.path,
    resolved.signal,
  );
  if (rootUnknown !== undefined) {
    const diagnostics: readonly [BlueprintArithmeticImportDiagnostic] = Object.freeze([
      rootUnknown,
    ]);
    return Object.freeze({ state: 'blocked', configuration: undefined, diagnostics });
  }
  const conditionsPath = `${resolved.path}.arithmetic_conditions`;
  const conditions = value.get('arithmetic_conditions');
  if (!isObjectNode(conditions)) {
    return blocked('Required arithmetic_conditions object is missing.', conditionsPath);
  }
  const conditionsUnknown = unknownField(
    conditions,
    [
      'operation',
      'first_constant',
      'first_signal',
      'first_signal_networks',
      'second_constant',
      'second_signal',
      'second_signal_networks',
      'output_signal',
    ],
    conditionsPath,
    resolved.signal,
  );
  if (conditionsUnknown !== undefined) {
    const diagnostics: readonly [BlueprintArithmeticImportDiagnostic] = Object.freeze([
      conditionsUnknown,
    ]);
    return Object.freeze({ state: 'blocked', configuration: undefined, diagnostics });
  }

  const operationPath = `${conditionsPath}.operation`;
  const operationValue = conditions.get('operation');
  if (operationValue === undefined) return blocked('Required operation is missing.', operationPath);
  if (typeof operationValue !== 'string' || !Object.hasOwn(operationFromNative, operationValue)) {
    return blocked('Expected a supported explicit Arithmetic operation.', operationPath);
  }
  const operation = operationFromNative[operationValue]!;
  const budget: StringByteBudget = { bytes: 0 };
  addBudgetString(operation, budget);

  const left = operandValue(
    conditions,
    'first',
    conditionsPath,
    hostNetworks,
    budget,
    resolved.signal,
  );
  if ('state' in left) return left;
  checkAborted(resolved.signal);
  const right = operandValue(
    conditions,
    'second',
    conditionsPath,
    hostNetworks,
    budget,
    resolved.signal,
  );
  if ('state' in right) return right;
  const outputPath = `${conditionsPath}.output_signal`;
  const outputValueNode = conditions.get('output_signal');
  if (outputValueNode === undefined)
    return blocked('Required output_signal is missing.', outputPath);
  const output = outputValue(outputValueNode, outputPath, budget, resolved.signal);
  if ('state' in output) return output;

  const configuration: ArithmeticProducerConfig = Object.freeze({ left, operation, right, output });
  if (serializedByteLength(configuration) > constantConfigurationLimits.maxBytes) {
    throw new RangeError(
      `Arithmetic configuration exceeds the byte limit of ${constantConfigurationLimits.maxBytes}.`,
    );
  }
  return complete(configuration);
}

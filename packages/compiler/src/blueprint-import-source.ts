import {
  canonicalizeConstantConfiguration,
  constantConfigurationLimits,
  Signal,
  signalTypes,
  type ConstantConfiguration,
  type SignalId,
  type SignalType,
} from '@comblang/factorio';
import type { NetworkId } from '@comblang/shared';

import type {
  ArithmeticOperation,
  ArithmeticProducerConfig,
  LogicalArithmeticOperand,
  LogicalNetworkRef,
} from './ir.js';

const arithmeticOperations: ReadonlySet<string> = new Set([
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
const utf8Encoder = new TextEncoder();

class BoundedSourceBuilder {
  readonly #parts: string[] = [];
  #bytes = 0;

  append(value: string): void {
    const bytes = utf8Encoder.encode(value).byteLength;
    if (bytes > constantConfigurationLimits.maxBytes - this.#bytes) {
      throw new RangeError(
        `Generated source expression exceeds the byte limit of ${constantConfigurationLimits.maxBytes}.`,
      );
    }
    this.#parts.push(value);
    this.#bytes += bytes;
  }

  appendString(value: string): void {
    if (value.length > constantConfigurationLimits.maxBytes - this.#bytes) {
      throw new RangeError(
        `Generated source expression exceeds the byte limit of ${constantConfigurationLimits.maxBytes}.`,
      );
    }
    this.append(JSON.stringify(value));
  }

  finish(): string {
    return this.#parts.join('');
  }
}

function appendNumber(builder: BoundedSourceBuilder, value: number): void {
  if (!Number.isFinite(value)) throw new TypeError('Expected a finite numeric literal.');
  builder.append(Object.is(value, -0) ? '-0' : String(value));
}

function appendSignal(builder: BoundedSourceBuilder, value: SignalId): void {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError('Expected a concrete Signal ID.');
  }
  if (typeof value.type !== 'string' || !signalTypes.includes(value.type as SignalType)) {
    throw new TypeError('Expected a supported Signal type.');
  }
  if (typeof value.name !== 'string') throw new TypeError('Expected a Signal name string.');
  if (value.quality !== undefined && typeof value.quality !== 'string') {
    throw new TypeError('Expected a Signal quality string.');
  }

  const checked =
    value.quality === undefined
      ? Signal(value.type as SignalType, value.name)
      : Signal(value.type as SignalType, value.name, value.quality);
  builder.append('Signal(');
  builder.appendString(checked.type);
  builder.append(',');
  builder.appendString(checked.name);
  if (checked.quality !== undefined) {
    builder.append(',');
    builder.appendString(checked.quality);
  }
  builder.append(')');
}

function dataProperty(value: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor !== undefined && 'value' in descriptor ? descriptor.value : undefined;
}

function arrayDataProperty(value: readonly unknown[], index: number): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
  return descriptor !== undefined && 'value' in descriptor ? descriptor.value : undefined;
}

function preflightConstantConfiguration(value: unknown): void {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return;

  let nodes = 2; // The canonical root and its sections array.
  let stringUnits = 0;
  const addString = (candidate: unknown): void => {
    if (typeof candidate !== 'string') return;
    stringUnits += candidate.length;
    if (stringUnits > constantConfigurationLimits.maxBytes) {
      throw new RangeError(
        `Constant configuration input exceeds the byte limit of ${constantConfigurationLimits.maxBytes}.`,
      );
    }
  };

  const sections = dataProperty(value, 'sections');
  if (!Array.isArray(sections) || Object.getPrototypeOf(sections) !== Array.prototype) return;
  nodes += sections.length * 2;
  if (nodes > constantConfigurationLimits.maxNodes) {
    throw new RangeError(
      `Constant configuration input exceeds the node limit of ${constantConfigurationLimits.maxNodes}.`,
    );
  }
  for (let sectionIndex = 0; sectionIndex < sections.length; sectionIndex += 1) {
    const section = arrayDataProperty(sections, sectionIndex);
    if (typeof section !== 'object' || section === null || Array.isArray(section)) continue;
    addString(dataProperty(section, 'group'));
    const filters = dataProperty(section, 'filters');
    if (!Array.isArray(filters) || Object.getPrototypeOf(filters) !== Array.prototype) continue;
    nodes += filters.length * 2;
    if (nodes > constantConfigurationLimits.maxNodes) {
      throw new RangeError(
        `Constant configuration input exceeds the node limit of ${constantConfigurationLimits.maxNodes}.`,
      );
    }
    for (let filterIndex = 0; filterIndex < filters.length; filterIndex += 1) {
      const filter = arrayDataProperty(filters, filterIndex);
      if (typeof filter !== 'object' || filter === null || Array.isArray(filter)) continue;
      const signal = dataProperty(filter, 'signal');
      if (typeof signal !== 'object' || signal === null || Array.isArray(signal)) continue;
      addString(dataProperty(signal, 'type'));
      addString(dataProperty(signal, 'name'));
      addString(dataProperty(signal, 'quality'));
    }
  }
}

function appendConstantConfiguration(
  builder: BoundedSourceBuilder,
  configuration: ConstantConfiguration,
): void {
  builder.append('Constant({isOn:');
  builder.append(configuration.isOn ? 'true' : 'false');
  builder.append(',sections:[');
  configuration.sections.forEach((section, sectionIndex) => {
    if (sectionIndex !== 0) builder.append(',');
    builder.append('{active:');
    builder.append(section.active ? 'true' : 'false');
    if (section.group !== undefined) {
      builder.append(',group:');
      builder.appendString(section.group);
    }
    builder.append(',multiplier:');
    appendNumber(builder, section.multiplier);
    builder.append(',filters:[');
    section.filters.forEach((filter, filterIndex) => {
      if (filterIndex !== 0) builder.append(',');
      builder.append('{signal:');
      appendSignal(builder, filter.signal);
      builder.append(',value:');
      appendNumber(builder, filter.value);
      builder.append('}');
    });
    builder.append(']}');
  });
  builder.append(']})');
}

/** Prints one bounded, literal DSL Constant constructor expression. */
export function printBlueprintConstantExpression(configuration: ConstantConfiguration): string {
  preflightConstantConfiguration(configuration);
  const canonical = canonicalizeConstantConfiguration(configuration);
  const builder = new BoundedSourceBuilder();
  appendConstantConfiguration(builder, canonical);
  return builder.finish();
}

function networkIdentifier(network: NetworkId, networks: ReadonlyMap<string, string>): string {
  if (typeof network !== 'string' || network.length === 0) {
    throw new TypeError('Arithmetic network references must be non-empty IDs.');
  }
  const identifier = networks.get(network);
  if (identifier === undefined) {
    throw new TypeError(`Arithmetic network reference is missing from networkOrder.`);
  }
  return identifier;
}

function validateNetworkOrder(networkOrder: readonly NetworkId[]): ReadonlyMap<string, string> {
  if (!Array.isArray(networkOrder) || Object.getPrototypeOf(networkOrder) !== Array.prototype) {
    throw new TypeError('networkOrder must be an array of Network IDs.');
  }
  if (networkOrder.length > constantConfigurationLimits.maxNodes) {
    throw new RangeError(
      `networkOrder exceeds the node limit of ${constantConfigurationLimits.maxNodes}.`,
    );
  }
  const identifiers = new Map<string, string>();
  for (let index = 0; index < networkOrder.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(networkOrder, String(index));
    if (descriptor === undefined || !('value' in descriptor)) {
      throw new TypeError('networkOrder entries must be plain data values.');
    }
    const network: unknown = descriptor.value;
    if (typeof network !== 'string' || network.length === 0) {
      throw new TypeError('networkOrder entries must be non-empty string IDs.');
    }
    if (identifiers.has(network)) throw new TypeError('networkOrder IDs must be unique.');
    identifiers.set(network, `import_network_${index + 1}`);
  }
  return identifiers;
}

function appendNetworkReference(
  builder: BoundedSourceBuilder,
  reference: LogicalNetworkRef,
  networks: ReadonlyMap<string, string>,
): void {
  if (reference.refKind === 'single') {
    builder.append(networkIdentifier(reference.network, networks));
    return;
  }
  if (
    reference.refKind !== 'pair' ||
    !Array.isArray(reference.networks) ||
    reference.networks.length !== 2
  ) {
    throw new TypeError('Arithmetic pair references must contain exactly two Network IDs.');
  }
  builder.append('pair(');
  builder.append(networkIdentifier(reference.networks[0], networks));
  builder.append(',');
  builder.append(networkIdentifier(reference.networks[1], networks));
  builder.append(')');
}

function appendOperand(
  builder: BoundedSourceBuilder,
  operand: LogicalArithmeticOperand,
  networks: ReadonlyMap<string, string>,
): void {
  if (typeof operand !== 'object' || operand === null) {
    throw new TypeError('Arithmetic operands must be records.');
  }
  if (operand.kind === 'constant') {
    if (
      typeof operand.value !== 'number' ||
      !Number.isInteger(operand.value) ||
      operand.value < -2_147_483_648 ||
      operand.value > 2_147_483_647
    ) {
      throw new TypeError('Arithmetic constants must be signed int32 integers.');
    }
    appendNumber(builder, operand.value);
    return;
  }
  if (operand.kind !== 'signal' && operand.kind !== 'each') {
    throw new TypeError('Unsupported Arithmetic operand kind.');
  }
  if (operand.kind === 'each') builder.append('Each(');
  appendNetworkReference(builder, operand, networks);
  if (operand.kind === 'each') {
    builder.append(')');
    return;
  }
  builder.append('[');
  appendSignal(builder, operand.signal);
  builder.append(']');
}

function appendArithmeticOutput(
  builder: BoundedSourceBuilder,
  config: ArithmeticProducerConfig,
): void {
  if (typeof config.output !== 'object' || config.output === null) {
    throw new TypeError('Arithmetic output must be a record.');
  }
  if (config.output.kind === 'each') {
    builder.append('EACH');
    return;
  }
  if (config.output.kind !== 'signal') throw new TypeError('Unsupported Arithmetic output kind.');
  appendSignal(builder, config.output.signal);
}

function validateArithmeticConfiguration(configuration: ArithmeticProducerConfig): void {
  if (typeof configuration !== 'object' || configuration === null) {
    throw new TypeError('Arithmetic configuration must be a record.');
  }
  if (
    typeof configuration.operation !== 'string' ||
    !arithmeticOperations.has(configuration.operation)
  ) {
    throw new TypeError('Unsupported Arithmetic operation.');
  }
}

function printArithmeticExpression(
  configuration: ArithmeticProducerConfig,
  networks: ReadonlyMap<string, string>,
): string {
  validateArithmeticConfiguration(configuration);
  const builder = new BoundedSourceBuilder();
  builder.append('Arithmetic({left:');
  appendOperand(builder, configuration.left, networks);
  builder.append(',operation:');
  builder.appendString(configuration.operation as ArithmeticOperation);
  builder.append(',right:');
  appendOperand(builder, configuration.right, networks);
  builder.append(',output:');
  appendArithmeticOutput(builder, configuration);
  builder.append('})');
  return builder.finish();
}

/** Prepares one private positional network map for repeated bounded Arithmetic printing. */
export function createBlueprintArithmeticExpressionPrinter(
  networkOrder: readonly NetworkId[],
): (configuration: ArithmeticProducerConfig) => string {
  const networks = validateNetworkOrder(networkOrder);
  return (configuration) => printArithmeticExpression(configuration, networks);
}

/** Prints one bounded, literal DSL Arithmetic constructor expression. */
export function printBlueprintArithmeticExpression(
  configuration: ArithmeticProducerConfig,
  networkOrder: readonly NetworkId[],
): string {
  // Preserve validation order for the standalone API while using the same renderer.
  validateArithmeticConfiguration(configuration);
  return createBlueprintArithmeticExpressionPrinter(networkOrder)(configuration);
}

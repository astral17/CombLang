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
  Comparator,
  DeciderProducerConfig,
  LogicalArithmeticOperand,
  LogicalNetworkRef,
  Quantifier,
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
const deciderComparators: Readonly<Record<Comparator, string>> = Object.freeze({
  '>': '>',
  '<': '<',
  '=': '==',
  '>=': '>=',
  '<=': '<=',
  '!=': '!=',
});
const deciderQuantifiers: ReadonlySet<string> = new Set(['each', 'anything', 'everything']);
const maxDeciderOutputRows = 1024;
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
    throw new TypeError('Network references must be non-empty IDs.');
  }
  const identifier = networks.get(network);
  if (identifier === undefined) {
    throw new TypeError('Network reference is missing from networkOrder.');
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
  const refKind = dataProperty(reference, 'refKind');
  if (refKind === 'single') {
    builder.append(networkIdentifier(dataProperty(reference, 'network') as NetworkId, networks));
    return;
  }
  const pairValue = dataProperty(reference, 'networks');
  if (
    refKind !== 'pair' ||
    !Array.isArray(pairValue) ||
    Object.getPrototypeOf(pairValue) !== Array.prototype ||
    pairValue.length !== 2
  ) {
    throw new TypeError('Pair references must contain exactly two Network IDs.');
  }
  const pair = pairValue;
  builder.append('pair(');
  builder.append(networkIdentifier(arrayDataProperty(pair, 0) as NetworkId, networks));
  builder.append(',');
  builder.append(networkIdentifier(arrayDataProperty(pair, 1) as NetworkId, networks));
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

function readDataRecord(value: unknown, label: string): Record<string, unknown> {
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)
  ) {
    throw new TypeError(`${label} must be a plain data record.`);
  }
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string') throw new TypeError(`${label} has an unsupported key.`);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !('value' in descriptor)) {
      throw new TypeError(`${label} properties must be data properties.`);
    }
  }
  return value as Record<string, unknown>;
}

function assertRecordKeys(
  record: Record<string, unknown>,
  label: string,
  allowed: readonly string[],
  required: readonly string[],
): void {
  for (const key of Reflect.ownKeys(record)) {
    if (typeof key !== 'string' || !allowed.includes(key)) {
      throw new TypeError(`${label} has an unsupported field ${String(key)}.`);
    }
  }
  for (const key of required) {
    if (!Object.hasOwn(record, key)) throw new TypeError(`${label} is missing ${key}.`);
  }
}

function readDataArray(value: unknown, label: string): readonly unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    throw new TypeError(`${label} must be a plain array.`);
  }
  return value;
}

function readArrayEntry(values: readonly unknown[], index: number, label: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(values, String(index));
  if (descriptor === undefined || !('value' in descriptor)) {
    throw new TypeError(`${label} entries must be dense data values.`);
  }
  return descriptor.value;
}

function readNetworkReference(record: Record<string, unknown>, label: string): LogicalNetworkRef {
  const refKind = dataProperty(record, 'refKind');
  if (refKind === 'single') {
    if (!Object.hasOwn(record, 'network') || Object.hasOwn(record, 'networks')) {
      throw new TypeError(`${label} must contain exactly one Network ID.`);
    }
    const network = dataProperty(record, 'network');
    if (typeof network !== 'string' || network.length === 0) {
      throw new TypeError(`${label} Network ID must be a non-empty string.`);
    }
    return { refKind: 'single', network: network as NetworkId };
  }
  if (refKind === 'pair') {
    if (!Object.hasOwn(record, 'networks') || Object.hasOwn(record, 'network')) {
      throw new TypeError(`${label} must contain a Network pair.`);
    }
    const pair = readDataArray(dataProperty(record, 'networks'), `${label} pair`);
    if (pair.length !== 2) {
      throw new TypeError(`${label} pair must contain exactly two Network IDs.`);
    }
    const first = readArrayEntry(pair, 0, `${label} pair`);
    const second = readArrayEntry(pair, 1, `${label} pair`);
    if (
      typeof first !== 'string' ||
      first.length === 0 ||
      typeof second !== 'string' ||
      second.length === 0
    ) {
      throw new TypeError(`${label} pair entries must be non-empty Network IDs.`);
    }
    return {
      refKind: 'pair',
      networks: [first as NetworkId, second as NetworkId],
    };
  }
  throw new TypeError(`${label} has an unsupported Network reference kind.`);
}

function readSignalId(value: unknown, label: string): SignalId {
  const record = readDataRecord(value, label);
  assertRecordKeys(record, label, ['type', 'name', 'quality'], ['type', 'name']);
  if (
    typeof dataProperty(record, 'type') !== 'string' ||
    !signalTypes.includes(dataProperty(record, 'type') as SignalType) ||
    typeof dataProperty(record, 'name') !== 'string'
  ) {
    throw new TypeError(`${label} must contain a supported Signal type and name.`);
  }
  if (Object.hasOwn(record, 'quality') && typeof dataProperty(record, 'quality') !== 'string') {
    throw new TypeError(`${label} quality must be a string when present.`);
  }
  return record as unknown as SignalId;
}

function appendDeciderInt32(builder: BoundedSourceBuilder, value: unknown, label: string): void {
  if (
    typeof value !== 'number' ||
    !Number.isInteger(value) ||
    value < -2_147_483_648 ||
    value > 2_147_483_647 ||
    Object.is(value, -0)
  ) {
    throw new TypeError(`${label} must be a signed int32 other than negative zero.`);
  }
  appendNumber(builder, value);
}

function appendDeciderConditionLeft(
  builder: BoundedSourceBuilder,
  value: unknown,
  networks: ReadonlyMap<string, string>,
): void {
  const record = readDataRecord(value, 'Decider condition left operand');
  const kind = dataProperty(record, 'kind');
  if (kind === 'signal') {
    assertRecordKeys(
      record,
      'Decider condition signal',
      ['kind', 'signal', 'refKind', 'network', 'networks'],
      ['kind', 'signal', 'refKind'],
    );
    const reference = readNetworkReference(record, 'Decider condition signal');
    appendNetworkReference(builder, reference, networks);
    builder.append('[');
    appendSignal(builder, readSignalId(dataProperty(record, 'signal'), 'Decider condition Signal'));
    builder.append(']');
    return;
  }
  if (kind === 'wildcard') {
    assertRecordKeys(
      record,
      'Decider condition wildcard',
      ['kind', 'value', 'refKind', 'network', 'networks'],
      ['kind', 'value', 'refKind'],
    );
    const quantifier = dataProperty(record, 'value');
    if (typeof quantifier !== 'string' || !deciderQuantifiers.has(quantifier)) {
      throw new TypeError('Decider condition wildcard has an unsupported quantifier.');
    }
    const reference = readNetworkReference(record, 'Decider condition wildcard');
    builder.append(
      quantifier === 'each' ? 'Each(' : quantifier === 'anything' ? 'Anything(' : 'Everything(',
    );
    appendNetworkReference(builder, reference, networks);
    builder.append(')');
    return;
  }
  throw new TypeError('Decider condition left operand must be a signal or wildcard.');
}

function appendDeciderConditionRight(
  builder: BoundedSourceBuilder,
  value: unknown,
  networks: ReadonlyMap<string, string>,
): void {
  const record = readDataRecord(value, 'Decider condition right operand');
  const kind = dataProperty(record, 'kind');
  if (kind === 'constant') {
    assertRecordKeys(record, 'Decider condition constant', ['kind', 'value'], ['kind', 'value']);
    appendDeciderInt32(builder, dataProperty(record, 'value'), 'Decider condition constant');
    return;
  }
  if (kind === 'signal') {
    assertRecordKeys(
      record,
      'Decider condition Signal',
      ['kind', 'signal', 'refKind', 'network', 'networks'],
      ['kind', 'signal', 'refKind'],
    );
    const reference = readNetworkReference(record, 'Decider condition Signal');
    appendNetworkReference(builder, reference, networks);
    builder.append('[');
    appendSignal(builder, readSignalId(dataProperty(record, 'signal'), 'Decider condition Signal'));
    builder.append(']');
    return;
  }
  throw new TypeError('Decider condition right operand must be a signal or signed int32.');
}

interface DeciderConditionTraversal {
  nodes: number;
  readonly ancestors: Set<object>;
}

function appendDeciderCondition(
  builder: BoundedSourceBuilder,
  value: unknown,
  networks: ReadonlyMap<string, string>,
  traversal: DeciderConditionTraversal,
  depth = 1,
): void {
  if (depth > constantConfigurationLimits.maxDepth) {
    throw new RangeError(
      `Decider condition exceeds the depth limit of ${constantConfigurationLimits.maxDepth}.`,
    );
  }
  const record = readDataRecord(value, 'Decider condition');
  if (traversal.ancestors.has(record)) throw new TypeError('Decider conditions cannot be cyclic.');
  traversal.nodes += 1;
  if (traversal.nodes > constantConfigurationLimits.maxNodes) {
    throw new RangeError(
      `Decider condition exceeds the node limit of ${constantConfigurationLimits.maxNodes}.`,
    );
  }
  traversal.ancestors.add(record);
  try {
    const kind = dataProperty(record, 'kind');
    if (kind === 'compare') {
      assertRecordKeys(
        record,
        'Decider comparison',
        ['kind', 'left', 'comparator', 'right'],
        ['kind', 'left', 'comparator', 'right'],
      );
      const comparator = dataProperty(record, 'comparator');
      if (typeof comparator !== 'string' || !Object.hasOwn(deciderComparators, comparator)) {
        throw new TypeError('Decider comparison has an unsupported comparator.');
      }
      builder.append('(');
      appendDeciderConditionLeft(builder, dataProperty(record, 'left'), networks);
      builder.append(' ');
      builder.append(deciderComparators[comparator as Comparator]);
      builder.append(' ');
      appendDeciderConditionRight(builder, dataProperty(record, 'right'), networks);
      builder.append(')');
      return;
    }
    if (kind !== 'and' && kind !== 'or') {
      throw new TypeError('Unsupported Decider condition kind.');
    }
    assertRecordKeys(
      record,
      'Decider condition group',
      ['kind', 'conditions'],
      ['kind', 'conditions'],
    );
    const conditions = readDataArray(
      dataProperty(record, 'conditions'),
      'Decider condition group children',
    );
    if (conditions.length === 0) throw new TypeError('Decider condition groups cannot be empty.');
    if (conditions.length > constantConfigurationLimits.maxNodes - traversal.nodes) {
      throw new RangeError(
        `Decider condition exceeds the node limit of ${constantConfigurationLimits.maxNodes}.`,
      );
    }
    builder.append('(');
    for (let index = 0; index < conditions.length; index += 1) {
      if (index !== 0) builder.append(kind === 'and' ? ' && ' : ' || ');
      appendDeciderCondition(
        builder,
        readArrayEntry(conditions, index, 'Decider condition group'),
        networks,
        traversal,
        depth + 1,
      );
    }
    builder.append(')');
  } finally {
    traversal.ancestors.delete(record);
  }
}

type DeciderOutputLiteral =
  | { readonly kind: 'signal'; readonly signal: SignalId }
  | { readonly kind: 'wildcard'; readonly value: Quantifier };

function readDeciderOutputSignal(value: unknown): DeciderOutputLiteral {
  const record = readDataRecord(value, 'Decider output Signal');
  const kind = dataProperty(record, 'kind');
  if (kind === 'signal') {
    assertRecordKeys(record, 'Decider output Signal', ['kind', 'signal'], ['kind', 'signal']);
    return {
      kind: 'signal',
      signal: readSignalId(dataProperty(record, 'signal'), 'Decider output Signal'),
    };
  }
  if (kind === 'wildcard') {
    assertRecordKeys(record, 'Decider output wildcard', ['kind', 'value'], ['kind', 'value']);
    const quantifier = dataProperty(record, 'value');
    if (typeof quantifier !== 'string' || !deciderQuantifiers.has(quantifier)) {
      throw new TypeError('Decider output wildcard has an unsupported quantifier.');
    }
    return { kind: 'wildcard', value: quantifier as Quantifier };
  }
  throw new TypeError('Decider output Signal must be concrete or a wildcard.');
}

function appendDeciderSelection(
  builder: BoundedSourceBuilder,
  reference: LogicalNetworkRef,
  signal: DeciderOutputLiteral,
  networks: ReadonlyMap<string, string>,
): void {
  if (signal.kind === 'signal') {
    appendNetworkReference(builder, reference, networks);
    builder.append('[');
    appendSignal(builder, signal.signal);
    builder.append(']');
    return;
  }
  builder.append(
    signal.value === 'each' ? 'Each(' : signal.value === 'anything' ? 'Anything(' : 'Everything(',
  );
  appendNetworkReference(builder, reference, networks);
  builder.append(')');
}

function appendDeciderOutput(
  builder: BoundedSourceBuilder,
  value: unknown,
  networks: ReadonlyMap<string, string>,
): void {
  const record = readDataRecord(value, 'Decider output row');
  const mode = dataProperty(record, 'mode');
  if (mode === 'copy') {
    assertRecordKeys(
      record,
      'Decider copy output',
      ['mode', 'signal', 'input'],
      ['mode', 'signal', 'input'],
    );
    const signal = readDeciderOutputSignal(dataProperty(record, 'signal'));
    const input = readDataRecord(dataProperty(record, 'input'), 'Decider copy output input');
    assertRecordKeys(
      input,
      'Decider copy output input',
      ['refKind', 'network', 'networks'],
      ['refKind'],
    );
    const reference = readNetworkReference(input, 'Decider copy output input');
    appendDeciderSelection(builder, reference, signal, networks);
    return;
  }
  if (mode === 'constant') {
    assertRecordKeys(
      record,
      'Decider constant output',
      ['mode', 'signal', 'value'],
      ['mode', 'signal', 'value'],
    );
    const signal = readDeciderOutputSignal(dataProperty(record, 'signal'));
    if (signal.kind === 'wildcard' && signal.value !== 'each') {
      throw new TypeError('Only EACH supports a constant-count Decider output.');
    }
    builder.append('(');
    appendDeciderInt32(builder, dataProperty(record, 'value'), 'Decider output count');
    builder.append(' * ');
    if (signal.kind === 'signal') appendSignal(builder, signal.signal);
    else builder.append('EACH');
    builder.append(')');
    return;
  }
  throw new TypeError('Decider output mode must be copy or constant.');
}

function appendDeciderOutputRows(
  builder: BoundedSourceBuilder,
  values: readonly unknown[],
  networks: ReadonlyMap<string, string>,
): void {
  builder.append('[');
  for (let index = 0; index < values.length; index += 1) {
    if (index !== 0) builder.append(',');
    appendDeciderOutput(builder, readArrayEntry(values, index, 'Decider output rows'), networks);
  }
  builder.append(']');
}

function printDeciderExpression(
  configuration: DeciderProducerConfig,
  networks: ReadonlyMap<string, string>,
): string {
  const record = readDataRecord(configuration, 'Decider configuration');
  assertRecordKeys(
    record,
    'Decider configuration',
    ['condition', 'outputs', 'elseOutputs'],
    ['condition', 'outputs'],
  );
  const outputs = readDataArray(dataProperty(record, 'outputs'), 'Decider outputs');
  const hasElseOutputs = Object.hasOwn(record, 'elseOutputs');
  const elseOutputs = hasElseOutputs
    ? readDataArray(dataProperty(record, 'elseOutputs'), 'Decider elseOutputs')
    : undefined;
  const totalRows = outputs.length + (elseOutputs?.length ?? 0);
  if (totalRows > maxDeciderOutputRows) {
    throw new RangeError(`Decider outputs exceed the row limit of ${maxDeciderOutputRows}.`);
  }
  if (totalRows === 0)
    throw new TypeError('Decider configuration requires at least one output row.');
  if (hasElseOutputs && elseOutputs?.length === 0) {
    throw new TypeError(
      'An explicitly present empty Decider elseOutputs branch cannot round-trip.',
    );
  }

  const builder = new BoundedSourceBuilder();
  builder.append('Decider({condition:');
  appendDeciderCondition(builder, dataProperty(record, 'condition'), networks, {
    nodes: 0,
    ancestors: new Set(),
  });
  builder.append(',outputs:');
  appendDeciderOutputRows(builder, outputs, networks);
  if (elseOutputs !== undefined) {
    builder.append(',elseOutputs:');
    appendDeciderOutputRows(builder, elseOutputs, networks);
  }
  builder.append('})');
  return builder.finish();
}

/** Prepares one private positional network map for repeated bounded Decider printing. */
export function createBlueprintDeciderExpressionPrinter(
  networkOrder: readonly NetworkId[],
): (configuration: DeciderProducerConfig) => string {
  const networks = validateNetworkOrder(networkOrder);
  return (configuration) => printDeciderExpression(configuration, networks);
}

/** Prints one bounded, literal DSL Decider constructor expression. */
export function printBlueprintDeciderExpression(
  configuration: DeciderProducerConfig,
  networkOrder: readonly NetworkId[],
): string {
  return createBlueprintDeciderExpressionPrinter(networkOrder)(configuration);
}

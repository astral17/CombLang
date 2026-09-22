import type {
  EntityPlanConnectorBinding,
  EntityConnectorKey,
  EntityId,
  EntityLaneEndpoint,
  EntityLaneKey,
  EntityPlanDebugInstance,
  EntityPlanDebugValue,
  EntityProfileRef,
  EntityPlanConfiguration,
  EntityPlanRecord,
} from '@comblang/compiler/entity';
import type { DirectPlanNetwork } from '@comblang/compiler/direct-plan-schema';
import {
  entityReplayContextRef,
  resolveEntityReplayContext,
  resolveEntityReplayProfile,
  type TrustedEntityReplayContext,
} from '@comblang/compiler/entity-replay-context';
import {
  canonicalizeEntityConfiguration,
  EntityConfigurationError,
} from '@comblang/compiler/entity-configuration';
import type { EntityPlacement } from '@comblang/compiler/ir';
import type { Diagnostic, SourceSpan } from '@comblang/shared';

import type { DirectElaborationPlan } from '@comblang/compiler/direct-plan-schema';
import type { DirectPlanProducer } from '@comblang/compiler/direct-plan-schema';
import { canonicalizeConstantConfiguration, ConstantConfigurationError } from '@comblang/factorio';
import { validateDirectPlanEnvelope } from './direct-plan-validation.js';
import {
  CanonicalEntityAssociationError,
  validateCanonicalEntityAssociations,
} from './canonical-entity-associations.js';

type DataRecord = Record<string, unknown>;

interface NetworkDeclaration {
  readonly path: string;
  readonly fixedColor?: 'red' | 'green';
  readonly generation: number;
  readonly consumedAt?: SourceSpan;
}

type EntityPlanNetwork = DirectPlanNetwork & { readonly generation: number };

export class EntityPlanValidationError extends Error {
  readonly code: string;
  readonly path: string;
  readonly detail: string;
  readonly span: SourceSpan | undefined;

  constructor(code: string, path: string, message: string, span?: SourceSpan) {
    super(`${path}: ${message}`);
    this.name = 'EntityPlanValidationError';
    this.code = code;
    this.path = path;
    this.detail = message;
    this.span = span;
  }
}

export interface ValidatedEntityPlan {
  readonly plan: DirectElaborationPlan;
  readonly context: TrustedEntityReplayContext;
}

export interface EntityPlanValidationResult {
  readonly value?: ValidatedEntityPlan;
  readonly diagnostics: readonly Diagnostic[];
}

function invalid(code: string, path: string, message: string, span?: SourceSpan): never {
  throw new EntityPlanValidationError(code, path, message, span);
}

function dataRecord(value: unknown, path: string): DataRecord {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    invalid('RT3000', path, 'expected a plain data record.');
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    invalid('RT3000', path, 'expected a plain object or null-prototype record.');
  }
  const output = Object.create(null) as DataRecord;
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string')
      invalid('RT3000', `${path}[${String(key)}]`, 'symbol keys are not allowed.');
    const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
    if (!('value' in descriptor)) invalid('RT3000', `${path}.${key}`, 'accessors are not allowed.');
    output[key] = descriptor.value;
  }
  return output;
}

function dataArray(value: unknown, path: string): readonly unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    invalid('RT3000', path, 'expected a plain array.');
  }
  const lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length');
  if (lengthDescriptor === undefined || !('value' in lengthDescriptor)) {
    invalid('RT3000', `${path}.length`, 'array length must be data-only.');
  }
  const length = lengthDescriptor.value;
  if (typeof length !== 'number' || !Number.isSafeInteger(length) || length < 0) {
    invalid('RT3000', `${path}.length`, 'array length must be a non-negative safe integer.');
  }
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string')
      invalid('RT3000', `${path}[${String(key)}]`, 'symbol keys are not allowed.');
    if (key === 'length') continue;
    if (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= length) {
      invalid('RT3000', `${path}.${key}`, 'unknown array field.');
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
    if (!('value' in descriptor))
      invalid('RT3000', `${path}[${key}]`, 'accessors are not allowed.');
  }
  const output: unknown[] = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (descriptor === undefined)
      invalid('RT3000', `${path}[${index}]`, 'array holes are not allowed.');
    if (!('value' in descriptor))
      invalid('RT3000', `${path}[${index}]`, 'accessors are not allowed.');
    output.push(descriptor.value);
  }
  return output;
}

function exactKeys(record: DataRecord, allowed: readonly string[], path: string): void {
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(record)) {
    if (!allowedSet.has(key)) invalid('RT3000', `${path}.${key}`, 'unknown Entity plan field.');
  }
}

function text(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.length === 0)
    invalid('RT3000', path, 'expected a non-empty string.');
  return value;
}

function positive(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    invalid('RT3000', path, 'expected a positive safe integer.');
  }
  return value;
}

function nonNegative(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    invalid('RT3000', path, 'expected a non-negative safe integer.');
  }
  return value;
}

function finite(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    invalid('RT3000', path, 'expected a finite number.');
  }
  return value;
}

function stringArray(value: unknown, path: string): readonly string[] {
  return Object.freeze(
    dataArray(value, path).map((entry, index) => text(entry, `${path}[${index}]`)),
  );
}

function parseSource(value: unknown, path: string): SourceSpan {
  const record = dataRecord(value, path);
  exactKeys(record, ['fileId', 'start', 'end'], path);
  const start = finite(record.start, `${path}.start`);
  const end = finite(record.end, `${path}.end`);
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start) {
    invalid('RT3000', path, 'source span must use a valid half-open range.');
  }
  return Object.freeze({
    fileId: text(record.fileId, `${path}.fileId`) as SourceSpan['fileId'],
    start,
    end,
  });
}

function parsePlacement(value: unknown, path: string): EntityPlacement {
  const record = dataRecord(value, path);
  exactKeys(record, ['x', 'y', 'direction'], path);
  if (!('x' in record) || !('y' in record)) invalid('RT3000', path, 'placement requires x and y.');
  return Object.freeze({
    x: finite(record.x, `${path}.x`),
    y: finite(record.y, `${path}.y`),
    ...('direction' in record ? { direction: finite(record.direction, `${path}.direction`) } : {}),
  });
}

function parseContextReference(
  value: unknown,
  path: string,
): ReturnType<typeof entityReplayContextRef> {
  const record = dataRecord(value, path);
  exactKeys(record, ['database', 'evidenceIdentity', 'policyIdentity', 'profileSetIdentity'], path);
  const database = dataRecord(record.database, `${path}.database`);
  exactKeys(database, ['schemaVersion', 'identity'], `${path}.database`);
  return Object.freeze({
    database: Object.freeze({
      schemaVersion: positive(database.schemaVersion, `${path}.database.schemaVersion`),
      identity: text(database.identity, `${path}.database.identity`),
    }),
    evidenceIdentity: text(record.evidenceIdentity, `${path}.evidenceIdentity`),
    policyIdentity: text(record.policyIdentity, `${path}.policyIdentity`),
    profileSetIdentity: text(record.profileSetIdentity, `${path}.profileSetIdentity`) as ReturnType<
      typeof entityReplayContextRef
    >['profileSetIdentity'],
  });
}

function parseProfileRef(
  value: unknown,
  path: string,
  context: TrustedEntityReplayContext,
): {
  readonly ref: EntityProfileRef;
  readonly profile: ReturnType<typeof resolveEntityReplayProfile>;
} {
  const record = dataRecord(value, path);
  exactKeys(record, ['prototypeKey', 'database', 'profileId'], path);
  const database = dataRecord(record.database, `${path}.database`);
  exactKeys(database, ['schemaVersion', 'identity'], `${path}.database`);
  const ref: EntityProfileRef = Object.freeze({
    prototypeKey: text(record.prototypeKey, `${path}.prototypeKey`),
    database: Object.freeze({
      schemaVersion: positive(database.schemaVersion, `${path}.database.schemaVersion`),
      identity: text(database.identity, `${path}.database.identity`),
    }),
    profileId: text(record.profileId, `${path}.profileId`) as EntityProfileRef['profileId'],
  });
  let profile: ReturnType<typeof resolveEntityReplayProfile>;
  try {
    profile = resolveEntityReplayProfile(ref, context);
  } catch (error) {
    const errorPath =
      error instanceof Error && 'path' in error && typeof error.path === 'string'
        ? error.path === '$'
          ? path
          : `${path}${error.path.slice(1)}`
        : path;
    invalid(
      error instanceof Error && 'code' in error && error.code === 'ER1001' ? 'RT3001' : 'RT3002',
      errorPath,
      error instanceof Error ? error.message : 'profile is unavailable.',
    );
  }
  return { ref, profile };
}

function parseEndpoint(value: unknown, path: string): EntityLaneEndpoint {
  const record = dataRecord(value, path);
  exactKeys(record, ['connector', 'lane', 'color'], path);
  const color = record.color;
  if (color !== 'red' && color !== 'green')
    invalid('RT3000', `${path}.color`, 'expected red or green.');
  return {
    connector: text(record.connector, `${path}.connector`) as EntityConnectorKey,
    lane: text(record.lane, `${path}.lane`) as EntityLaneKey,
    color,
  };
}

function parseBindingProvenance(
  value: unknown,
  path: string,
): EntityPlanConnectorBinding['provenance'] {
  const record = dataRecord(value, path);
  exactKeys(record, ['source', 'instancePath', 'operationOrdinal'], path);
  return Object.freeze({
    source: parseSource(record.source, `${path}.source`),
    instancePath: stringArray(record.instancePath, `${path}.instancePath`),
    operationOrdinal: positive(record.operationOrdinal, `${path}.operationOrdinal`),
  });
}

function parseNetwork(value: unknown, path: string): EntityPlanNetwork {
  const record = dataRecord(value, path);
  exactKeys(
    record,
    ['name', 'fixedColor', 'generation', 'consumedAt', 'source', 'instancePath'],
    path,
  );
  const fixedColor = record.fixedColor;
  if (fixedColor !== undefined && fixedColor !== 'red' && fixedColor !== 'green') {
    invalid('RT3000', `${path}.fixedColor`, 'expected red or green.');
  }
  if (!('generation' in record)) invalid('RT3000', `${path}.generation`, 'field is required.');
  const source = parseSource(record.source, `${path}.source`);
  const instancePath = stringArray(record.instancePath, `${path}.instancePath`);
  const consumedAt =
    'consumedAt' in record ? parseSource(record.consumedAt, `${path}.consumedAt`) : undefined;
  return Object.freeze({
    name: text(record.name, `${path}.name`),
    ...(fixedColor === undefined ? {} : { fixedColor }),
    generation: nonNegative(record.generation, `${path}.generation`),
    ...(consumedAt === undefined ? {} : { consumedAt }),
    source,
    instancePath,
  });
}

function parseNetworks(value: unknown, path: string): readonly EntityPlanNetwork[] {
  return Object.freeze(
    dataArray(value, path).map((entry, index) => parseNetwork(entry, `${path}[${index}]`)),
  );
}

function parseBindings(
  value: unknown,
  path: string,
  networkNames: ReadonlySet<string>,
  networkDeclarations: ReadonlyMap<string, NetworkDeclaration>,
  profile: ReturnType<typeof resolveEntityReplayProfile>,
): readonly EntityPlanConnectorBinding[] {
  const bindings = dataArray(value, path).map((entry, index) => {
    const bindingPath = `${path}[${index}]`;
    const record = dataRecord(entry, bindingPath);
    exactKeys(
      record,
      ['endpoint', 'network', 'generation', 'direction', 'provenance'],
      bindingPath,
    );
    const endpoint = parseEndpoint(record.endpoint, `${bindingPath}.endpoint`);
    const connector = profile.connectors.find(({ key }) => key === endpoint.connector);
    if (connector === undefined)
      invalid('RT3002', `${bindingPath}.endpoint.connector`, 'unknown connector key.');
    const lane = connector.lanes.find(({ key }) => key === endpoint.lane);
    if (lane === undefined || lane.color !== endpoint.color) {
      invalid(
        'RT3002',
        `${bindingPath}.endpoint.lane`,
        'endpoint does not match the trusted profile.',
      );
    }
    if (record.direction !== 'input' && record.direction !== 'output') {
      invalid('RT3000', `${bindingPath}.direction`, 'expected input or output.');
    }
    if (
      (record.direction === 'input' && connector.direction === 'output') ||
      (record.direction === 'output' && connector.direction === 'input')
    ) {
      invalid(
        'RT3002',
        `${bindingPath}.direction`,
        'direction does not match the trusted profile.',
      );
    }
    const provenance = parseBindingProvenance(record.provenance, `${bindingPath}.provenance`);
    const network =
      'network' in record ? text(record.network, `${bindingPath}.network`) : undefined;
    const generation = nonNegative(record.generation, `${bindingPath}.generation`);
    if (network !== undefined && !networkNames.has(network)) {
      invalid('RT3002', `${bindingPath}.network`, 'connector references an unknown Network.');
    }
    if (network !== undefined) {
      const declaration = networkDeclarations.get(network);
      if (declaration?.fixedColor !== endpoint.color) {
        invalid(
          'RT3002',
          `${declaration?.path ?? `${bindingPath}.network`}.fixedColor`,
          `Network descriptor must declare fixedColor ${endpoint.color} for this endpoint.`,
        );
      }
      if (declaration?.consumedAt !== undefined) {
        invalid(
          'RT3002',
          `${bindingPath}.network`,
          'connector references a consumed Network generation.',
        );
      }
      const expectedGeneration = declaration?.generation ?? 0;
      if (generation !== expectedGeneration) {
        invalid(
          'RT3002',
          `${bindingPath}.generation`,
          `Network generation ${generation} is stale; expected ${expectedGeneration}.`,
        );
      }
    } else if (generation !== 0) {
      invalid('RT3002', `${bindingPath}.generation`, 'an unbound connector must use generation 0.');
    }
    return Object.freeze({
      endpoint,
      ...(network === undefined ? {} : { network }),
      generation,
      direction: record.direction,
      provenance,
    });
  });
  const endpointKeys = bindings.map(
    ({ endpoint }) => `${endpoint.connector}/${endpoint.lane}/${endpoint.color}`,
  );
  if (new Set(endpointKeys).size !== endpointKeys.length) {
    invalid('RT3003', path, 'connector endpoint is repeated.');
  }
  return Object.freeze(
    [...bindings].sort((left, right) => {
      const leftKey = `${left.endpoint.connector}/${left.endpoint.lane}`;
      const rightKey = `${right.endpoint.connector}/${right.endpoint.lane}`;
      return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
    }),
  );
}

function runtimeSignalHandleRecord(value: unknown, path: string): DataRecord | undefined {
  if (value === null || typeof value !== 'object' || !Object.isFrozen(value)) return undefined;
  const keys = Reflect.ownKeys(value);
  if (!keys.includes(Symbol.toPrimitive)) return undefined;
  if (
    keys.some(
      (key) =>
        (typeof key === 'symbol' && key !== Symbol.toPrimitive) ||
        (typeof key === 'string' && !['type', 'name', 'quality'].includes(key)),
    )
  )
    return undefined;
  const primitive = Object.getOwnPropertyDescriptor(value, Symbol.toPrimitive);
  if (primitive === undefined || !('value' in primitive) || typeof primitive.value !== 'function')
    invalid('RT3000', `${path}[Symbol.toPrimitive]`, 'Signal handles must be data-only.');
  const record = Object.create(null) as DataRecord;
  for (const key of ['type', 'name', 'quality']) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor !== undefined) {
      if (!('value' in descriptor))
        invalid('RT3000', `${path}.${key}`, 'accessors are not allowed.');
      record[key] = descriptor.value;
    }
  }
  return record;
}

function planSignalShape(value: unknown, path: string): void {
  const record = runtimeSignalHandleRecord(value, path) ?? dataRecord(value, path);
  exactKeys(record, ['type', 'name', 'quality'], path);
}

function planNetworkRefShape(
  value: unknown,
  path: string,
  additionalKeys: readonly string[] = [],
): void {
  const record = dataRecord(value, path);
  if (record.refKind === 'single') {
    exactKeys(record, ['refKind', 'network', ...additionalKeys], path);
    return;
  }
  if (record.refKind === 'pair') {
    exactKeys(record, ['refKind', 'networks', ...additionalKeys], path);
    dataArray(record.networks, `${path}.networks`);
    return;
  }
  invalid('RT3003', `${path}.refKind`, 'unknown Network reference tag.');
}

function planArithmeticOperandShape(value: unknown, path: string): void {
  const record = dataRecord(value, path);
  if (record.kind === 'constant') {
    exactKeys(record, ['kind', 'value'], path);
    return;
  }
  if (record.kind === 'signal') {
    exactKeys(record, ['kind', 'signal', 'refKind', 'network', 'networks'], path);
    planSignalShape(record.signal, `${path}.signal`);
    planNetworkRefShape(record, path, ['kind', 'signal']);
    return;
  }
  if (record.kind === 'each') {
    exactKeys(record, ['kind', 'refKind', 'network', 'networks'], path);
    planNetworkRefShape(record, path, ['kind']);
    return;
  }
  invalid('RT3003', `${path}.kind`, 'unknown arithmetic operand tag.');
}

function planArithmeticOutputShape(value: unknown, path: string): void {
  const record = dataRecord(value, path);
  if (record.kind === 'each') {
    exactKeys(record, ['kind'], path);
    return;
  }
  if (record.kind === 'signal') {
    exactKeys(record, ['kind', 'signal'], path);
    planSignalShape(record.signal, `${path}.signal`);
    return;
  }
  invalid('RT3003', `${path}.kind`, 'unknown arithmetic output tag.');
}

function planConditionShape(value: unknown, path: string, depth = 0): void {
  if (depth > 128) invalid('RT3003', path, 'condition nesting exceeds the 128 level limit.');
  const record = dataRecord(value, path);
  if (record.kind === 'and' || record.kind === 'or') {
    exactKeys(record, ['kind', 'conditions'], path);
    dataArray(record.conditions, `${path}.conditions`).forEach((entry, index) =>
      planConditionShape(entry, `${path}.conditions[${index}]`, depth + 1),
    );
    return;
  }
  if (record.kind === 'compare-each') {
    exactKeys(record, ['kind', 'comparator', 'constant', 'refKind', 'network', 'networks'], path);
    planNetworkRefShape(record, path, ['kind', 'comparator', 'constant']);
    return;
  }
  if (record.kind === 'compare-signal') {
    exactKeys(
      record,
      ['kind', 'signal', 'comparator', 'constant', 'refKind', 'network', 'networks'],
      path,
    );
    planSignalShape(record.signal, `${path}.signal`);
    planNetworkRefShape(record, path, ['kind', 'signal', 'comparator', 'constant']);
    return;
  }
  if (record.kind === 'compare-wildcard') {
    exactKeys(
      record,
      ['kind', 'wildcard', 'comparator', 'constant', 'refKind', 'network', 'networks'],
      path,
    );
    planNetworkRefShape(record, path, ['kind', 'wildcard', 'comparator', 'constant']);
    return;
  }
  if (record.kind === 'compare-signals') {
    exactKeys(record, ['kind', 'left', 'comparator', 'right'], path);
    for (const side of ['left', 'right'] as const) {
      const operandPath = `${path}.${side}`;
      const operand = dataRecord(record[side], operandPath);
      exactKeys(operand, ['signal', 'refKind', 'network', 'networks'], operandPath);
      planSignalShape(operand.signal, `${operandPath}.signal`);
      planNetworkRefShape(operand, operandPath, ['signal']);
    }
    return;
  }
  if (record.kind === 'compare-wildcard-signal') {
    exactKeys(record, ['kind', 'left', 'comparator', 'right'], path);
    const leftPath = `${path}.left`;
    const left = dataRecord(record.left, leftPath);
    exactKeys(left, ['wildcard', 'refKind', 'network', 'networks'], leftPath);
    if (!['each', 'anything', 'everything'].includes(left.wildcard as string))
      invalid('RT3003', `${leftPath}.wildcard`, 'unknown Decider wildcard.');
    planNetworkRefShape(left, leftPath, ['wildcard']);
    const rightPath = `${path}.right`;
    const right = dataRecord(record.right, rightPath);
    exactKeys(right, ['signal', 'refKind', 'network', 'networks'], rightPath);
    planSignalShape(right.signal, `${rightPath}.signal`);
    planNetworkRefShape(right, rightPath, ['signal']);
    return;
  }
  invalid('RT3003', `${path}.kind`, 'unknown Decider condition tag.');
}

function planDeciderOutputShape(value: unknown, path: string): void {
  const record = dataRecord(value, path);
  if (record.kind === 'each-constant') {
    exactKeys(record, ['kind', 'value'], path);
    return;
  }
  if (record.kind === 'signal-constant') {
    exactKeys(record, ['kind', 'signal', 'value'], path);
    planSignalShape(record.signal, `${path}.signal`);
    return;
  }
  if (record.kind === 'each') {
    exactKeys(record, ['kind', 'refKind', 'network', 'networks'], path);
    planNetworkRefShape(record, path, ['kind']);
    return;
  }
  if (record.kind === 'signal') {
    exactKeys(record, ['kind', 'signal', 'refKind', 'network', 'networks'], path);
    planSignalShape(record.signal, `${path}.signal`);
    planNetworkRefShape(record, path, ['kind', 'signal']);
    return;
  }
  if (record.kind === 'wildcard') {
    exactKeys(record, ['kind', 'wildcard', 'refKind', 'network', 'networks'], path);
    planNetworkRefShape(record, path, ['kind', 'wildcard']);
    return;
  }
  invalid('RT3003', `${path}.kind`, 'unknown Decider output tag.');
}

function planConfigurationShape(value: unknown, path: string): DataRecord {
  const record = dataRecord(value, path);
  if (record.mode === 'constant') {
    exactKeys(record, ['mode', 'value'], path);
    return record;
  }
  if (record.mode === 'arithmetic') {
    exactKeys(record, ['mode', 'left', 'operation', 'right', 'output'], path);
    planArithmeticOperandShape(record.left, `${path}.left`);
    planArithmeticOperandShape(record.right, `${path}.right`);
    planArithmeticOutputShape(record.output, `${path}.output`);
    return record;
  }
  if (record.mode === 'decider') {
    exactKeys(record, ['mode', 'condition', 'outputs', 'elseOutputs'], path);
    planConditionShape(record.condition, `${path}.condition`);
    dataArray(record.outputs, `${path}.outputs`).forEach((entry, index) =>
      planDeciderOutputShape(entry, `${path}.outputs[${index}]`),
    );
    if (record.elseOutputs !== undefined) {
      dataArray(record.elseOutputs, `${path}.elseOutputs`).forEach((entry, index) =>
        planDeciderOutputShape(entry, `${path}.elseOutputs[${index}]`),
      );
    }
    return record;
  }
  if (record.mode === 'selector') {
    if (record.operation === 'select') {
      exactKeys(record, ['mode', 'operation', 'input', 'selectMax', 'index'], path);
      planNetworkRefShape(record.input, `${path}.input`);
      if (typeof record.index === 'object' && record.index !== null) {
        planSignalShape(record.index, `${path}.index`);
      }
      return record;
    }
    if (record.operation === 'count') {
      exactKeys(record, ['mode', 'operation', 'input', 'output'], path);
      planNetworkRefShape(record.input, `${path}.input`);
      planSignalShape(record.output, `${path}.output`);
      return record;
    }
    invalid('RT3003', `${path}.operation`, 'unknown Selector operation.');
  }
  return record;
}

function rejectComputationCycles(value: unknown, path: string, seen = new WeakSet<object>()): void {
  if (value === null || typeof value !== 'object') return;
  if (runtimeSignalHandleRecord(value, path) !== undefined) return;
  if (seen.has(value)) invalid('RT3003', path, 'cyclic computation configuration is not allowed.');
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      dataArray(value, path).forEach((entry, index) =>
        rejectComputationCycles(entry, `${path}[${index}]`, seen),
      );
      return;
    }
    const record = dataRecord(value, path);
    for (const [key, child] of Object.entries(record))
      rejectComputationCycles(child, `${path}.${key}`, seen);
  } finally {
    seen.delete(value);
  }
}

function strictComputationConfiguration(
  value: unknown,
  path: string,
  networks: readonly EntityPlanNetwork[],
  source: SourceSpan,
  instancePath: readonly string[],
): EntityPlanConfiguration {
  rejectComputationCycles(value, path);
  const record = planConfigurationShape(value, path);
  if (record.mode === 'constant') {
    try {
      return Object.freeze({
        mode: 'constant',
        value: canonicalizeConstantConfiguration(record.value, undefined, `${path}.value`),
      });
    } catch (error) {
      if (error instanceof EntityConfigurationError) invalid('RT3003', error.path, error.detail);
      if (error instanceof ConstantConfigurationError) invalid('RT3003', error.path, error.detail);
      throw error;
    }
  }

  const { mode: _mode, ...computation } = record;
  const producer = {
    kind: record.mode,
    ...computation,
    source,
    instancePath,
    destinations: [],
    ...(record.mode === 'decider'
      ? {
          output:
            (record.outputs as readonly unknown[])[0] ??
            (record.elseOutputs as readonly unknown[] | undefined)?.[0],
        }
      : {}),
  };
  const validation = validateDirectPlanEnvelope({
    format: 'comblang-direct-plan',
    networks,
    producers: [producer],
    entities: [],
  });
  if (validation.value === undefined) {
    const diagnostic = validation.diagnostics[0];
    invalid(
      'RT3003',
      path,
      diagnostic?.message.replace(/^\$\.producers\[0\]/, path) ??
        'invalid canonical computation configuration.',
    );
  }
  const canonical = validation.value.plan.producers[0] as DirectPlanProducer;
  if (canonical.kind === 'arithmetic') {
    return Object.freeze({
      mode: 'arithmetic',
      left: canonical.left,
      operation: canonical.operation,
      right: canonical.right,
      output: canonical.output,
    });
  }
  if (canonical.kind === 'decider') {
    return Object.freeze({
      mode: 'decider',
      condition: canonical.condition,
      outputs: Object.freeze(canonical.outputs ?? [canonical.output]),
      ...(canonical.elseOutputs === undefined
        ? {}
        : { elseOutputs: Object.freeze(canonical.elseOutputs) }),
    });
  }
  if (canonical.kind === 'selector') {
    return canonical.operation === 'select'
      ? Object.freeze({
          mode: 'selector',
          operation: 'select',
          input: canonical.input,
          selectMax: canonical.selectMax,
          index: canonical.index,
        })
      : Object.freeze({
          mode: 'selector',
          operation: 'count',
          input: canonical.input,
          output: canonical.output,
        });
  }
  return invalid('RT3003', path, 'unsupported computation Entity configuration.');
}

function parseConfiguration(
  value: unknown,
  path: string,
  profile: ReturnType<typeof resolveEntityReplayProfile>,
  networks: readonly EntityPlanNetwork[],
  source: SourceSpan,
  instancePath: readonly string[],
): EntityPlanRecord['configuration'] {
  try {
    const record = dataRecord(value, path);
    if (
      record.mode === 'constant' ||
      record.mode === 'arithmetic' ||
      record.mode === 'decider' ||
      record.mode === 'selector'
    )
      return strictComputationConfiguration(value, path, networks, source, instancePath);
    return canonicalizeEntityConfiguration(value, profile, path);
  } catch (error) {
    if (error instanceof EntityConfigurationError) {
      invalid('RT3003', error.path, error.detail);
    }
    throw error;
  }
}

function parseEntity(
  value: unknown,
  path: string,
  context: TrustedEntityReplayContext,
  networks: readonly EntityPlanNetwork[],
  networkNames: ReadonlySet<string>,
  networkDeclarations: ReadonlyMap<string, NetworkDeclaration>,
): EntityPlanRecord {
  const record = dataRecord(value, path);
  exactKeys(
    record,
    ['id', 'profile', 'configuration', 'connectorBindings', 'placement', 'provenance', 'ordinal'],
    path,
  );
  const profile = parseProfileRef(record.profile, `${path}.profile`, context);
  const provenanceRecord = dataRecord(record.provenance, `${path}.provenance`);
  exactKeys(
    provenanceRecord,
    ['source', 'instancePath', 'expansionStack', 'creationRevision'],
    `${path}.provenance`,
  );
  const provenance = Object.freeze({
    source: parseSource(provenanceRecord.source, `${path}.provenance.source`),
    instancePath: stringArray(provenanceRecord.instancePath, `${path}.provenance.instancePath`),
    expansionStack: stringArray(
      provenanceRecord.expansionStack,
      `${path}.provenance.expansionStack`,
    ),
    creationRevision: positive(
      provenanceRecord.creationRevision,
      `${path}.provenance.creationRevision`,
    ),
  });
  const configuration =
    'configuration' in record
      ? parseConfiguration(
          record.configuration,
          `${path}.configuration`,
          profile.profile,
          networks,
          provenance.source,
          provenance.instancePath,
        )
      : undefined;
  const placement =
    'placement' in record ? parsePlacement(record.placement, `${path}.placement`) : undefined;
  const connectorBindings = parseBindings(
    record.connectorBindings,
    `${path}.connectorBindings`,
    networkNames,
    networkDeclarations,
    profile.profile,
  );
  return Object.freeze({
    id: text(record.id, `${path}.id`) as EntityId,
    profile: profile.ref,
    ...(configuration === undefined ? {} : { configuration }),
    connectorBindings,
    ...(placement === undefined ? {} : { placement }),
    provenance,
    ordinal: positive(record.ordinal, `${path}.ordinal`),
  });
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    if (!Object.isFrozen(value)) Object.freeze(value);
  }
  return value;
}

const maximumEntityDebugDepth = 128;
const maximumEntityDebugNodes = 100_000;

function parseEntityDebugValue(
  value: unknown,
  path: string,
  entityIds: ReadonlySet<string>,
  source: SourceSpan,
  depth = 0,
  budget = { remaining: maximumEntityDebugNodes },
): EntityPlanDebugValue {
  const debugInvalid = (code: string, errorPath: string, message: string): never =>
    invalid(code, errorPath, message, source);
  if (depth > maximumEntityDebugDepth) {
    debugInvalid(
      'RT3000',
      path,
      `debug value nesting exceeds the ${maximumEntityDebugDepth} level limit.`,
    );
  }
  budget.remaining -= 1;
  if (budget.remaining < 0)
    debugInvalid('RT3000', path, 'debug value exceeds the 100000 node limit.');
  const record = dataRecord(value, path);
  const kind = record.kind;
  if (kind === 'network') {
    try {
      exactKeys(record, ['kind', 'network'], path);
    } catch (error) {
      if (error instanceof EntityPlanValidationError && error.span === undefined)
        throw new EntityPlanValidationError(error.code, error.path, error.detail, source);
      throw error;
    }
    return Object.freeze({ kind: 'network', network: text(record.network, `${path}.network`) });
  }
  if (kind === 'producer') {
    try {
      exactKeys(record, ['kind', 'captureId'], path);
    } catch (error) {
      if (error instanceof EntityPlanValidationError && error.span === undefined)
        throw new EntityPlanValidationError(error.code, error.path, error.detail, source);
      throw error;
    }
    return Object.freeze({
      kind: 'producer',
      captureId: text(record.captureId, `${path}.captureId`),
    });
  }
  if (kind === 'undefined') {
    try {
      exactKeys(record, ['kind'], path);
    } catch (error) {
      if (error instanceof EntityPlanValidationError && error.span === undefined)
        throw new EntityPlanValidationError(error.code, error.path, error.detail, source);
      throw error;
    }
    return Object.freeze({ kind: 'undefined' });
  }
  if (kind === 'literal') {
    try {
      exactKeys(record, ['kind', 'value'], path);
    } catch (error) {
      if (error instanceof EntityPlanValidationError && error.span === undefined)
        throw new EntityPlanValidationError(error.code, error.path, error.detail, source);
      throw error;
    }
    const literal = record.value;
    if (
      literal !== null &&
      typeof literal !== 'string' &&
      typeof literal !== 'boolean' &&
      (typeof literal !== 'number' || !Number.isFinite(literal))
    ) {
      debugInvalid('RT3000', `${path}.value`, 'invalid debug literal.');
    }
    return Object.freeze({ kind: 'literal', value: literal as string | number | boolean | null });
  }
  if (kind === 'entity') {
    try {
      exactKeys(record, ['kind', 'entityId'], path);
    } catch (error) {
      if (error instanceof EntityPlanValidationError && error.span === undefined)
        throw new EntityPlanValidationError(error.code, error.path, error.detail, source);
      throw error;
    }
    const entityId = text(record.entityId, `${path}.entityId`);
    if (!entityIds.has(entityId)) {
      debugInvalid('RT3003', `${path}.entityId`, 'unknown or orphan Entity debug reference.');
    }
    return Object.freeze({ kind: 'entity', entityId: entityId as EntityId });
  }
  if (kind === 'array') {
    try {
      exactKeys(record, ['kind', 'values'], path);
    } catch (error) {
      if (error instanceof EntityPlanValidationError && error.span === undefined)
        throw new EntityPlanValidationError(error.code, error.path, error.detail, source);
      throw error;
    }
    const values = dataArray(record.values, `${path}.values`);
    if (values.length > maximumEntityDebugNodes) {
      debugInvalid('RT3000', `${path}.values`, 'debug value exceeds the 100000 node limit.');
    }
    return Object.freeze({
      kind: 'array',
      values: Object.freeze(
        values.map((item, index) =>
          parseEntityDebugValue(
            item,
            `${path}.values[${index}]`,
            entityIds,
            source,
            depth + 1,
            budget,
          ),
        ),
      ),
    });
  }
  if (kind === 'object') {
    try {
      exactKeys(record, ['kind', 'entries'], path);
    } catch (error) {
      if (error instanceof EntityPlanValidationError && error.span === undefined)
        throw new EntityPlanValidationError(error.code, error.path, error.detail, source);
      throw error;
    }
    const entries = dataArray(record.entries, `${path}.entries`);
    if (entries.length > maximumEntityDebugNodes) {
      debugInvalid('RT3000', `${path}.entries`, 'debug value exceeds the 100000 node limit.');
    }
    const keys = new Set<string>();
    return Object.freeze({
      kind: 'object',
      entries: Object.freeze(
        entries.map((entry, index) => {
          const entryPath = `${path}.entries[${index}]`;
          const entryRecord = dataRecord(entry, entryPath);
          try {
            exactKeys(entryRecord, ['key', 'value'], entryPath);
          } catch (error) {
            if (error instanceof EntityPlanValidationError && error.span === undefined)
              throw new EntityPlanValidationError(error.code, error.path, error.detail, source);
            throw error;
          }
          if (typeof entryRecord.key !== 'string') {
            debugInvalid('RT3000', `${entryPath}.key`, 'expected a string debug object key.');
          }
          const key = entryRecord.key as string;
          if (keys.has(key)) {
            debugInvalid('RT3000', `${entryPath}.key`, 'duplicate debug object key.');
          }
          keys.add(key);
          return Object.freeze({
            key,
            value: parseEntityDebugValue(
              entryRecord.value,
              `${entryPath}.value`,
              entityIds,
              source,
              depth + 1,
              budget,
            ),
          });
        }),
      ),
    });
  }
  return debugInvalid('RT3000', `${path}.kind`, 'unknown Entity debug value tag.');
}

function parseEntityDebugInstances(
  value: unknown,
  path: string,
  entityIds: ReadonlySet<string>,
): readonly EntityPlanDebugInstance[] | undefined {
  if (value === undefined) return undefined;
  const instances = dataArray(value, path);
  if (instances.length > maximumEntityDebugNodes) {
    invalid('RT3000', path, 'debug instance list exceeds the 100000 node limit.');
  }
  return Object.freeze(
    instances.map((entry, index) => {
      const instancePath = `${path}[${index}]`;
      const record = dataRecord(entry, instancePath);
      exactKeys(record, ['name', 'path', 'source', 'value'], instancePath);
      const source = parseSource(record.source, `${instancePath}.source`);
      let value: EntityPlanDebugValue;
      try {
        value = parseEntityDebugValue(record.value, `${instancePath}.value`, entityIds, source);
      } catch (error) {
        if (error instanceof EntityPlanValidationError && error.span === undefined) {
          throw new EntityPlanValidationError(error.code, error.path, error.detail, source);
        }
        throw error;
      }
      return Object.freeze({
        name: text(record.name, `${instancePath}.name`),
        path: stringArray(record.path, `${instancePath}.path`),
        source,
        value,
      });
    }),
  );
}

function validateValue(value: unknown, context: TrustedEntityReplayContext): ValidatedEntityPlan {
  const record = dataRecord(value, '$');
  const envelope = validateDirectPlanEnvelope({ ...record, debugInstances: [] });
  if (envelope.value === undefined) {
    const diagnostic = envelope.diagnostics[0];
    invalid(
      diagnostic?.code ?? 'RT1001',
      '$',
      diagnostic?.message ?? 'invalid canonical direct plan envelope.',
    );
  }
  exactKeys(
    record,
    [
      'format',
      'context',
      'networks',
      'networkAliases',
      'networkTransfers',
      'networkPairs',
      'capabilityUses',
      'debugInstances',
      'producers',
      'entities',
      'diagnostics',
    ],
    '$',
  );
  if (record.format !== 'comblang-direct-plan')
    invalid('RT1001', '$.format', 'unsupported direct plan format.');
  const contextReference = parseContextReference(record.context, '$.context');
  try {
    resolveEntityReplayContext(contextReference, context);
  } catch (error) {
    invalid(
      'RT3001',
      '$.context',
      error instanceof Error ? error.message : 'replay context mismatch.',
    );
  }
  const networks = parseNetworks(record.networks, '$.networks');
  const networkNames = new Set(networks.map(({ name }) => name));
  const networkDeclarations = new Map<string, NetworkDeclaration>(
    networks.map(({ name, fixedColor, generation, consumedAt }, index) => [
      name,
      {
        path: `$.networks[${index}]`,
        ...(fixedColor === undefined ? {} : { fixedColor }),
        generation,
        ...(consumedAt === undefined ? {} : { consumedAt }),
      },
    ]),
  );
  const entities = dataArray(record.entities, '$.entities').map((entry, index) =>
    parseEntity(
      entry,
      `$.entities[${index}]`,
      context,
      networks,
      networkNames,
      networkDeclarations,
    ),
  );
  const ids = entities.map(({ id }) => id);
  if (new Set(ids).size !== ids.length)
    invalid('RT3003', '$.entities', 'Entity IDs must be unique.');
  const ordinals = entities.map(({ ordinal }) => ordinal);
  if (new Set(ordinals).size !== ordinals.length)
    invalid('RT3003', '$.entities', 'Entity ordinals must be unique.');
  const entityIds = new Set(ids);
  const debugInstances = parseEntityDebugInstances(
    record.debugInstances,
    '$.debugInstances',
    entityIds,
  );
  const plan = envelope.value.plan;
  const canonical: DirectElaborationPlan = deepFreeze({
    ...plan,
    context: contextReference,
    networks,
    entities: Object.freeze([...entities].sort((left, right) => left.ordinal - right.ordinal)),
    ...(debugInstances === undefined ? {} : { debugInstances }),
  });
  try {
    validateCanonicalEntityAssociations(canonical, context);
  } catch (error) {
    if (error instanceof CanonicalEntityAssociationError) {
      invalid(error.code, error.path, error.detail);
    }
    throw error;
  }
  return { plan: canonical, context };
}

/** Validates canonical Entity semantics and the embedded producer subset before allocation. */
export function validateCanonicalEntityPlanData(
  value: unknown,
  context: TrustedEntityReplayContext,
): EntityPlanValidationResult {
  try {
    return { value: validateValue(value, context), diagnostics: [] };
  } catch (error) {
    if (error instanceof EntityPlanValidationError) {
      return {
        diagnostics: [
          {
            code: error.code,
            severity: 'error',
            message: error.message,
            ...(error.span === undefined ? {} : { span: error.span }),
          },
        ],
      };
    }
    throw error;
  }
}

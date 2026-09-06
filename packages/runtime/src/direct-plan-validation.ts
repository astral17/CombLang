import type {
  DirectElaborationPlan,
  DirectPlanCapabilityUse,
  DirectPlanNetwork,
  DirectPlanNetworkAlias,
} from '@comblang/compiler/direct-plan-schema';
import type { Diagnostic, SourceSpan } from '@comblang/shared';

export interface ValidatedDirectPlanEnvelope {
  readonly plan: DirectElaborationPlan;
  readonly declarations: ReadonlyMap<string, DirectPlanNetwork>;
  readonly aliases: readonly DirectPlanNetworkAlias[];
  readonly capabilityUses: readonly DirectPlanCapabilityUse[];
}

export interface DirectPlanEnvelopeValidationResult {
  readonly value?: ValidatedDirectPlanEnvelope;
  readonly diagnostics: readonly Diagnostic[];
}

function failure(
  code: string,
  message: string,
  span?: SourceSpan,
): DirectPlanEnvelopeValidationResult {
  return {
    diagnostics: [{ code, severity: 'error', message, ...(span === undefined ? {} : { span }) }],
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function descriptorSpan(value: unknown, key: 'source' | 'provenance'): SourceSpan | undefined {
  if (!isRecord(value)) return undefined;
  const valueSpan = value[key];
  if (!isRecord(valueSpan)) return undefined;
  return typeof valueSpan.fileId === 'string' &&
    valueSpan.fileId.length > 0 &&
    Number.isSafeInteger(valueSpan.start) &&
    Number.isSafeInteger(valueSpan.end) &&
    Number(valueSpan.start) >= 0 &&
    Number(valueSpan.end) >= Number(valueSpan.start)
    ? (valueSpan as unknown as SourceSpan)
    : undefined;
}

function isInstancePath(value: unknown): value is readonly string[] {
  return (
    Array.isArray(value) &&
    value.every((segment) => typeof segment === 'string' && segment.length > 0)
  );
}

function payloadFailure(path: string, message: string, span?: SourceSpan) {
  return failure('RT1001', `${path}: ${message}`, span);
}

function exceedsLimit(value: readonly unknown[]): boolean {
  return value.length > 100_000;
}

const signalTypes = new Set([
  'item',
  'fluid',
  'virtual',
  'entity',
  'recipe',
  'space-location',
  'asteroid-chunk',
  'quality',
]);

const arithmeticOperations = new Set([
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

const comparators = new Set(['>', '<', '=', '>=', '<=', '!=']);
const maximumNestedConditionDepth = 128;

function isCircuitValue(value: unknown): value is number {
  return (
    Number.isSafeInteger(value) && Number(value) >= -2_147_483_648 && Number(value) <= 2_147_483_647
  );
}

function isSignalId(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.type === 'string' &&
    signalTypes.has(value.type) &&
    typeof value.name === 'string' &&
    value.name.length > 0 &&
    (value.quality === undefined || (typeof value.quality === 'string' && value.quality.length > 0))
  );
}

function validateNetworkRef(
  value: Record<string, unknown>,
  path: string,
  declarations: ReadonlyMap<string, DirectPlanNetwork>,
  span: SourceSpan,
): DirectPlanEnvelopeValidationResult | undefined {
  if (value.refKind === 'single') {
    if (typeof value.network === 'string' && declarations.has(value.network)) return undefined;
    return failure('RT1003', `${path}: invalid or unknown input Network.`, span);
  }
  if (value.refKind === 'pair') {
    const networks = value.networks;
    if (
      Array.isArray(networks) &&
      networks.length === 2 &&
      networks[0] !== networks[1] &&
      networks.every((network) => typeof network === 'string' && declarations.has(network))
    )
      return undefined;
    return failure('RT1003', `${path}: invalid or unknown input Network pair.`, span);
  }
  return payloadFailure(`${path}.refKind`, 'unknown Network reference tag.', span);
}

function validateArithmeticOperand(
  value: unknown,
  path: string,
  declarations: ReadonlyMap<string, DirectPlanNetwork>,
  span: SourceSpan,
): DirectPlanEnvelopeValidationResult | undefined {
  if (!isRecord(value)) return payloadFailure(path, 'expected an arithmetic operand.', span);
  if (value.kind === 'constant')
    return isCircuitValue(value.value)
      ? undefined
      : payloadFailure(`${path}.value`, 'expected a signed int32 circuit value.', span);
  if (value.kind === 'signal' && !isSignalId(value.signal))
    return payloadFailure(`${path}.signal`, 'expected a valid SignalID.', span);
  if (value.kind !== 'signal' && value.kind !== 'each')
    return payloadFailure(`${path}.kind`, 'unknown arithmetic operand tag.', span);
  return validateNetworkRef(value, path, declarations, span);
}

function validateArithmeticProducer(
  producer: Record<string, unknown>,
  path: string,
  declarations: ReadonlyMap<string, DirectPlanNetwork>,
  span: SourceSpan,
): DirectPlanEnvelopeValidationResult | undefined {
  const left = validateArithmeticOperand(producer.left, `${path}.left`, declarations, span);
  if (left !== undefined) return left;
  if (typeof producer.operation !== 'string' || !arithmeticOperations.has(producer.operation))
    return payloadFailure(`${path}.operation`, 'unknown arithmetic operation.', span);
  const right = validateArithmeticOperand(producer.right, `${path}.right`, declarations, span);
  if (right !== undefined) return right;
  if (!isRecord(producer.output))
    return payloadFailure(`${path}.output`, 'expected an arithmetic output.', span);
  if (producer.output.kind === 'each') return undefined;
  if (producer.output.kind === 'signal' && isSignalId(producer.output.signal)) return undefined;
  return payloadFailure(`${path}.output`, 'invalid arithmetic output.', span);
}

function validateDeciderCondition(
  value: unknown,
  path: string,
  declarations: ReadonlyMap<string, DirectPlanNetwork>,
  span: SourceSpan,
  depth = 0,
  budget = { remaining: 100_000 },
): DirectPlanEnvelopeValidationResult | undefined {
  if (depth > maximumNestedConditionDepth)
    return payloadFailure(
      path,
      `condition nesting exceeds the ${maximumNestedConditionDepth} level limit.`,
      span,
    );
  budget.remaining -= 1;
  if (budget.remaining < 0)
    return payloadFailure(path, 'condition tree exceeds the 100000 node limit.', span);
  if (!isRecord(value)) return payloadFailure(path, 'expected a Decider condition.', span);
  if (value.kind === 'and' || value.kind === 'or') {
    if (!Array.isArray(value.conditions))
      return payloadFailure(`${path}.conditions`, 'expected a condition array.', span);
    if (exceedsLimit(value.conditions))
      return payloadFailure(`${path}.conditions`, 'condition array exceeds the item limit.', span);
    for (const [index, child] of value.conditions.entries()) {
      const invalid = validateDeciderCondition(
        child,
        `${path}.conditions[${index}]`,
        declarations,
        span,
        depth + 1,
        budget,
      );
      if (invalid !== undefined) return invalid;
    }
    return undefined;
  }
  if (typeof value.comparator !== 'string' || !comparators.has(value.comparator))
    return payloadFailure(`${path}.comparator`, 'unknown Decider comparator.', span);
  if (value.kind === 'compare-signals') {
    for (const side of ['left', 'right'] as const) {
      const operand = value[side];
      const operandPath = `${path}.${side}`;
      if (!isRecord(operand))
        return payloadFailure(operandPath, 'expected a signal operand.', span);
      if (!isSignalId(operand.signal))
        return payloadFailure(`${operandPath}.signal`, 'expected a valid SignalID.', span);
      const invalid = validateNetworkRef(operand, operandPath, declarations, span);
      if (invalid !== undefined) return invalid;
    }
    return undefined;
  }
  if (
    value.kind !== 'compare-each' &&
    value.kind !== 'compare-signal' &&
    value.kind !== 'compare-wildcard'
  )
    return payloadFailure(`${path}.kind`, 'unknown Decider condition tag.', span);
  if (!isCircuitValue(value.constant))
    return payloadFailure(`${path}.constant`, 'expected a signed int32 circuit value.', span);
  if (value.kind === 'compare-signal' && !isSignalId(value.signal))
    return payloadFailure(`${path}.signal`, 'expected a valid SignalID.', span);
  if (
    value.kind === 'compare-wildcard' &&
    value.wildcard !== 'anything' &&
    value.wildcard !== 'everything'
  )
    return payloadFailure(`${path}.wildcard`, 'unknown Decider wildcard.', span);
  return validateNetworkRef(value, path, declarations, span);
}

function validateDeciderOutput(
  value: unknown,
  path: string,
  declarations: ReadonlyMap<string, DirectPlanNetwork>,
  span: SourceSpan,
): DirectPlanEnvelopeValidationResult | undefined {
  if (!isRecord(value)) return payloadFailure(path, 'expected a Decider output.', span);
  if (value.kind === 'each-constant')
    return isCircuitValue(value.value)
      ? undefined
      : payloadFailure(`${path}.value`, 'expected a signed int32 circuit value.', span);
  if (value.kind === 'signal-constant') {
    if (!isSignalId(value.signal))
      return payloadFailure(`${path}.signal`, 'expected a valid SignalID.', span);
    return isCircuitValue(value.value)
      ? undefined
      : payloadFailure(`${path}.value`, 'expected a signed int32 circuit value.', span);
  }
  if (value.kind === 'signal' && !isSignalId(value.signal))
    return payloadFailure(`${path}.signal`, 'expected a valid SignalID.', span);
  if (value.kind === 'wildcard' && value.wildcard !== 'anything' && value.wildcard !== 'everything')
    return payloadFailure(`${path}.wildcard`, 'unknown Decider wildcard.', span);
  if (value.kind !== 'each' && value.kind !== 'signal' && value.kind !== 'wildcard')
    return payloadFailure(`${path}.kind`, 'unknown Decider output tag.', span);
  return validateNetworkRef(value, path, declarations, span);
}

function validateDeciderProducer(
  producer: Record<string, unknown>,
  path: string,
  declarations: ReadonlyMap<string, DirectPlanNetwork>,
  span: SourceSpan,
): DirectPlanEnvelopeValidationResult | undefined {
  const condition = validateDeciderCondition(
    producer.condition,
    `${path}.condition`,
    declarations,
    span,
  );
  if (condition !== undefined) return condition;
  const compatibilityOutput = validateDeciderOutput(
    producer.output,
    `${path}.output`,
    declarations,
    span,
  );
  if (compatibilityOutput !== undefined) return compatibilityOutput;
  for (const key of ['outputs', 'elseOutputs'] as const) {
    const outputs = producer[key];
    if (outputs === undefined) continue;
    if (!Array.isArray(outputs) || exceedsLimit(outputs))
      return payloadFailure(`${path}.${key}`, 'expected a bounded output array.', span);
    for (const [index, output] of outputs.entries()) {
      const invalid = validateDeciderOutput(output, `${path}.${key}[${index}]`, declarations, span);
      if (invalid !== undefined) return invalid;
    }
  }
  return undefined;
}

function validateConstantProducer(
  producer: Record<string, unknown>,
  path: string,
  span: SourceSpan,
): DirectPlanEnvelopeValidationResult | undefined {
  if (!Array.isArray(producer.outputs) || exceedsLimit(producer.outputs))
    return payloadFailure(`${path}.outputs`, 'expected a bounded constant output array.', span);
  for (const [index, output] of producer.outputs.entries()) {
    const outputPath = `${path}.outputs[${index}]`;
    if (!isRecord(output)) return payloadFailure(outputPath, 'expected a constant output.', span);
    if (!isSignalId(output.signal))
      return payloadFailure(`${outputPath}.signal`, 'expected a valid SignalID.', span);
    if (!isCircuitValue(output.value))
      return payloadFailure(`${outputPath}.value`, 'expected a signed int32 circuit value.', span);
  }
  return undefined;
}

function validateProducerMetadata(
  producer: Record<string, unknown>,
  path: string,
  span: SourceSpan,
  captureIds: Set<string>,
): DirectPlanEnvelopeValidationResult | undefined {
  if (
    producer.bindingName !== undefined &&
    (typeof producer.bindingName !== 'string' || producer.bindingName.length === 0)
  )
    return payloadFailure(`${path}.bindingName`, 'expected a non-empty string.', span);
  if (producer.debugCaptureIds !== undefined) {
    if (!Array.isArray(producer.debugCaptureIds) || exceedsLimit(producer.debugCaptureIds))
      return payloadFailure(`${path}.debugCaptureIds`, 'expected a bounded string array.', span);
    for (const [index, captureId] of producer.debugCaptureIds.entries()) {
      if (typeof captureId !== 'string' || captureId.length === 0)
        return payloadFailure(
          `${path}.debugCaptureIds[${index}]`,
          'expected a non-empty string.',
          span,
        );
      if (captureIds.has(captureId))
        return payloadFailure(
          `${path}.debugCaptureIds[${index}]`,
          'duplicate Producer debug capture.',
          span,
        );
      captureIds.add(captureId);
    }
  }
  if (producer.placement !== undefined) {
    const placement = producer.placement;
    if (
      !isRecord(placement) ||
      typeof placement.x !== 'number' ||
      !Number.isFinite(placement.x) ||
      typeof placement.y !== 'number' ||
      !Number.isFinite(placement.y) ||
      (placement.direction !== undefined &&
        (!Number.isInteger(placement.direction) ||
          Number(placement.direction) < 0 ||
          Number(placement.direction) > 15))
    )
      return payloadFailure(`${path}.placement`, 'invalid entity placement.', span);
  }
  return undefined;
}

/** Validates the versioned transport envelope before any runtime graph is allocated. */
export function validateDirectPlanEnvelope(plan: unknown): DirectPlanEnvelopeValidationResult {
  if (!isRecord(plan) || plan.format !== 'comblang-direct-plan' || plan.version !== 2)
    return failure('RT1001', 'Unsupported direct elaboration plan format.');
  if (!Array.isArray(plan.networks) || !Array.isArray(plan.producers))
    return failure('RT1001', 'Invalid direct elaboration plan envelope.');
  if (exceedsLimit(plan.networks) || exceedsLimit(plan.producers))
    return payloadFailure('$', 'top-level collection exceeds the 100000 item limit.');

  const declarations = new Map<string, DirectPlanNetwork>();
  for (const candidate of plan.networks) {
    if (
      !isRecord(candidate) ||
      typeof candidate.name !== 'string' ||
      candidate.name.length === 0 ||
      (candidate.fixedColor !== undefined &&
        candidate.fixedColor !== 'red' &&
        candidate.fixedColor !== 'green') ||
      descriptorSpan(candidate, 'source') === undefined ||
      !isInstancePath(candidate.instancePath)
    )
      return failure(
        'RT1001',
        'Invalid Network descriptor in direct plan.',
        descriptorSpan(candidate, 'source'),
      );
    if (declarations.has(candidate.name))
      return failure(
        'RT1002',
        `Duplicate Network in direct plan: ${candidate.name}.`,
        candidate.source as SourceSpan,
      );
    declarations.set(candidate.name, candidate as unknown as DirectPlanNetwork);
  }

  const optionalDescriptorArrays = [
    'networkAliases',
    'networkTransfers',
    'networkPairs',
    'capabilityUses',
    'debugInstances',
    'diagnostics',
  ] as const;
  for (const key of optionalDescriptorArrays)
    if (plan[key] !== undefined && !Array.isArray(plan[key]))
      return failure('RT1001', `Invalid ${key} collection in direct plan.`);

  for (const [index, transfer] of ((plan.networkTransfers ?? []) as unknown[]).entries()) {
    const path = `$.networkTransfers[${index}]`;
    if (!isRecord(transfer)) return payloadFailure(path, 'expected an object.');
    if (
      typeof transfer.destination !== 'string' ||
      !declarations.has(transfer.destination) ||
      typeof transfer.source !== 'string' ||
      !declarations.has(transfer.source) ||
      descriptorSpan(transfer, 'provenance') === undefined ||
      !isInstancePath(transfer.instancePath)
    )
      return payloadFailure(
        path,
        'invalid Network transfer.',
        descriptorSpan(transfer, 'provenance'),
      );
  }

  for (const [index, pair] of ((plan.networkPairs ?? []) as unknown[]).entries()) {
    const path = `$.networkPairs[${index}]`;
    if (!isRecord(pair)) return payloadFailure(path, 'expected an object.');
    const names = pair.networks;
    if (
      !Array.isArray(names) ||
      names.length !== 2 ||
      names[0] === names[1] ||
      names.some((name) => typeof name !== 'string' || !declarations.has(name)) ||
      descriptorSpan(pair, 'provenance') === undefined ||
      !isInstancePath(pair.instancePath)
    )
      return payloadFailure(path, 'invalid Network pair.', descriptorSpan(pair, 'provenance'));
  }

  const captureIds = new Set<string>();
  for (const [index, producer] of plan.producers.entries()) {
    const path = `$.producers[${index}]`;
    if (!isRecord(producer)) return payloadFailure(path, 'expected a Producer object.');
    if (
      producer.kind !== 'arithmetic' &&
      producer.kind !== 'decider' &&
      producer.kind !== 'constant'
    )
      return payloadFailure(
        `${path}.kind`,
        'unknown Producer tag.',
        descriptorSpan(producer, 'source'),
      );
    if (
      descriptorSpan(producer, 'source') === undefined ||
      !isInstancePath(producer.instancePath) ||
      !Array.isArray(producer.destinations)
    )
      return payloadFailure(
        path,
        'invalid Producer provenance or destinations.',
        descriptorSpan(producer, 'source'),
      );
    for (const [destinationIndex, destination] of producer.destinations.entries()) {
      const destinationPath = `${path}.destinations[${destinationIndex}]`;
      if (
        !isRecord(destination) ||
        typeof destination.network !== 'string' ||
        !declarations.has(destination.network) ||
        descriptorSpan(destination, 'source') === undefined ||
        !isInstancePath(destination.instancePath)
      )
        return failure(
          'RT1004',
          `${destinationPath}: invalid attachment destination.`,
          descriptorSpan(destination, 'source'),
        );
    }
    const producerSpan = producer.source as SourceSpan;
    const metadata = validateProducerMetadata(producer, path, producerSpan, captureIds);
    if (metadata !== undefined) return metadata;
    const invalid =
      producer.kind === 'arithmetic'
        ? validateArithmeticProducer(producer, path, declarations, producerSpan)
        : producer.kind === 'decider'
          ? validateDeciderProducer(producer, path, declarations, producerSpan)
          : validateConstantProducer(producer, path, producerSpan);
    if (invalid !== undefined) return invalid;
  }

  const aliases = (plan.networkAliases ?? []) as unknown[];
  for (const alias of aliases) {
    if (
      !isRecord(alias) ||
      typeof alias.name !== 'string' ||
      alias.name.length === 0 ||
      typeof alias.network !== 'string' ||
      !declarations.has(alias.network) ||
      descriptorSpan(alias, 'source') === undefined ||
      !isInstancePath(alias.instancePath) ||
      typeof alias.moved !== 'boolean'
    )
      return failure(
        'RT1001',
        'Invalid Network alias descriptor in direct plan.',
        descriptorSpan(alias, 'source'),
      );
  }

  const capabilityUses = (plan.capabilityUses ?? []) as unknown[];
  for (const use of capabilityUses) {
    if (
      !isRecord(use) ||
      typeof use.network !== 'string' ||
      !declarations.has(use.network) ||
      !['readonly', 'ref', 'move'].includes(String(use.capability)) ||
      typeof use.parameter !== 'string' ||
      use.parameter.length === 0 ||
      (use.fixedColor !== undefined && use.fixedColor !== 'red' && use.fixedColor !== 'green') ||
      descriptorSpan(use, 'provenance') === undefined ||
      !isInstancePath(use.instancePath)
    )
      return failure(
        'RT1001',
        'Invalid capability descriptor in direct plan.',
        descriptorSpan(use, 'provenance'),
      );
  }

  return {
    value: {
      plan: plan as unknown as DirectElaborationPlan,
      declarations,
      aliases: Object.freeze([...(aliases as unknown as DirectPlanNetworkAlias[])]),
      capabilityUses: Object.freeze([...(capabilityUses as unknown as DirectPlanCapabilityUse[])]),
    },
    diagnostics: [],
  };
}
